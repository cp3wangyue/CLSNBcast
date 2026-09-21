import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService, QualityConfigRecord } from '../database/database.service';
import {
  DEFAULT_QUALITY_CONFIG,
  QualityConfigValues,
  QualityTierRule,
  tierRuleForPixels,
} from './quality-config.types';

export class QualityConfigValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'QualityConfigValidationError';
  }
}

/**
 * 画质与计费配置。
 *
 * 配置存在 `quality_config` 单行表里，读取时带内存缓存 —— 计费路径（`toInfo()`）
 * 每次会话展示都会读它，不该每次都解析 JSON。
 *
 * **默认值只有一处定义**（`DEFAULT_QUALITY_CONFIG`）：表里没有行时由
 * `onModuleInit` 播种，读取时若行缺失或损坏则回退到同一份默认值。
 * 迁移 004 只建表不播种，正是为了避免默认值出现第二份副本。
 */
@Injectable()
export class QualityConfigService implements OnModuleInit {
  private readonly logger = new Logger(QualityConfigService.name);
  private cache: QualityConfigValues | null = null;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit(): void {
    if (!this.db.getQualityConfig()) {
      this.db.upsertQualityConfig(this.serialize(DEFAULT_QUALITY_CONFIG));
      this.logger.log('Seeded default quality/billing config');
    }
    // 预热缓存，顺带在启动时就把损坏的配置暴露出来（记 warn，不阻断启动）
    this.get();
  }

  /** 当前配置。行缺失或 JSON 损坏时回退到默认值。 */
  get(): QualityConfigValues {
    if (this.cache) return this.cache;

    const row = this.db.getQualityConfig();
    if (!row) {
      this.cache = DEFAULT_QUALITY_CONFIG;
      return this.cache;
    }

    try {
      this.cache = {
        tierRules: this.parseTierRules(row.tierRules),
        audioCoefficients: this.parseAudioCoefficients(row.audioCoefficients),
        standardMinutePrice: this.parsePrice(row.standardMinutePrice),
        usageTimezone: row.usageTimezone || DEFAULT_QUALITY_CONFIG.usageTimezone,
        limits: this.parseLimits(row.limits),
      };
    } catch (error) {
      // 配置坏了就用默认值继续跑，但必须让运维知道 ——
      // 静默用默认值会导致账单与预期不符却查不出原因。
      this.logger.warn(
        `Invalid quality config in database, falling back to defaults: ${(error as Error).message}`,
      );
      this.cache = DEFAULT_QUALITY_CONFIG;
    }
    return this.cache;
  }

  /** 计费周期 / 配额判断使用的时区。 */
  getUsageTimezone(): string {
    return this.get().usageTimezone;
  }

  /** 按分辨率解析计费档位规则。 */
  tierRuleFor(width: number, height: number): QualityTierRule {
    return tierRuleForPixels(this.get().tierRules, width, height);
  }

  /**
   * 覆盖配置（Phase 3 的管理端接口会调用）。
   *
   * 校验后再落库：一个写坏的配置会让所有会话的计费都算错，
   * 因此宁可拒绝写入也不要存下一个半成品。
   */
  update(input: Partial<QualityConfigValues>): QualityConfigValues {
    const current = this.get();
    const next: QualityConfigValues = {
      tierRules: input.tierRules ?? current.tierRules,
      audioCoefficients: input.audioCoefficients ?? current.audioCoefficients,
      standardMinutePrice: input.standardMinutePrice ?? current.standardMinutePrice,
      usageTimezone: input.usageTimezone ?? current.usageTimezone,
      limits: input.limits ?? current.limits,
    };

    this.assertValid(next);
    this.db.upsertQualityConfig(this.serialize(next));
    this.cache = next;
    this.logger.log('Quality/billing config updated');
    return next;
  }

  /** 丢弃缓存，下次读取重新从库里加载（测试用）。 */
  invalidateCache(): void {
    this.cache = null;
  }

  // ===== 校验 =====

  private assertValid(values: QualityConfigValues): void {
    if (values.tierRules.length === 0) {
      throw new QualityConfigValidationError('EMPTY_TIER_RULES', '至少需要一条档位规则');
    }

    let previousMax = -1;
    for (const rule of values.tierRules) {
      if (!rule.tier?.trim()) {
        throw new QualityConfigValidationError('EMPTY_TIER_NAME', '档位名不能为空');
      }
      if (rule.maxPixels !== null) {
        if (!Number.isFinite(rule.maxPixels) || rule.maxPixels <= 0) {
          throw new QualityConfigValidationError(
            'INVALID_MAX_PIXELS',
            `档位「${rule.tier}」的像素上界必须为正数或留空`,
          );
        }
        if (rule.maxPixels <= previousMax) {
          throw new QualityConfigValidationError(
            'TIER_RULES_NOT_ASCENDING',
            '档位规则的像素上界必须严格递增，否则分辨率会被映射到错误的档位',
          );
        }
        previousMax = rule.maxPixels;
      }
      for (const [name, coefficient] of Object.entries({
        interactive: rule.interactive,
        ultraLowLatency: rule.ultraLowLatency,
      })) {
        if (!Number.isFinite(coefficient) || coefficient <= 0) {
          throw new QualityConfigValidationError(
            'INVALID_COEFFICIENT',
            `档位「${rule.tier}」的 ${name} 折算系数必须为正数`,
          );
        }
      }
    }

    // 最后一档必须无上界，否则超过最高上界的分辨率没有归属
    const last = values.tierRules[values.tierRules.length - 1];
    if (last.maxPixels !== null) {
      throw new QualityConfigValidationError(
        'MISSING_OPEN_ENDED_TIER',
        '最后一个档位的像素上界必须留空，用来兜住更高的分辨率',
      );
    }

    for (const [name, coefficient] of Object.entries(values.audioCoefficients)) {
      if (!Number.isFinite(coefficient) || coefficient <= 0) {
        throw new QualityConfigValidationError(
          'INVALID_COEFFICIENT',
          `音频折算系数 ${name} 必须为正数`,
        );
      }
    }

    if (!Number.isFinite(values.standardMinutePrice) || values.standardMinutePrice <= 0) {
      throw new QualityConfigValidationError('INVALID_PRICE', '标准分钟单价必须为正数');
    }

    if (!values.usageTimezone?.trim()) {
      throw new QualityConfigValidationError('INVALID_TIMEZONE', '计费时区不能为空');
    }
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: values.usageTimezone });
    } catch {
      throw new QualityConfigValidationError(
        'INVALID_TIMEZONE',
        `无法识别的时区：${values.usageTimezone}`,
      );
    }
  }

  // ===== 序列化 =====

  private serialize(values: QualityConfigValues): Omit<QualityConfigRecord, 'updatedAt'> {
    return {
      tierRules: JSON.stringify(values.tierRules),
      audioCoefficients: JSON.stringify(values.audioCoefficients),
      standardMinutePrice: values.standardMinutePrice,
      usageTimezone: values.usageTimezone,
      limits: JSON.stringify(values.limits),
    };
  }

  private parseTierRules(raw: string): QualityTierRule[] {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('tier_rules must be a non-empty array');
    }
    return parsed.map((entry: any) => ({
      tier: String(entry?.tier ?? ''),
      maxPixels: entry?.maxPixels === null || entry?.maxPixels === undefined
        ? null
        : Number(entry.maxPixels),
      interactive: Number(entry?.interactive),
      ultraLowLatency: Number(entry?.ultraLowLatency),
    }));
  }

  private parseAudioCoefficients(raw: string): QualityConfigValues['audioCoefficients'] {
    const parsed = JSON.parse(raw);
    return {
      broadcaster: Number(parsed?.broadcaster),
      interactiveViewer: Number(parsed?.interactiveViewer),
      ultraLowLatencyViewer: Number(parsed?.ultraLowLatencyViewer),
    };
  }

  private parsePrice(raw: number): number {
    return Number(raw);
  }

  private parseLimits(raw: string): QualityConfigValues['limits'] {
    return JSON.parse(raw);
  }
}
