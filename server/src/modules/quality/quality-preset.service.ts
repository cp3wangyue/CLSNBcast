import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { QualityConfigService } from './quality-config.service';
import {
  CustomQualityInput,
  QualityCodec,
  QualityOptimizationMode,
  QualityPreset,
  QualitySnapshot,
} from './quality-preset.types';
import { validateCustomQuality } from './quality-validation';

/**
 * 初始播种的画质预设。
 *
 * 内容与原 `session.types.ts` 的 `QUALITY_PRESETS` **逐项一致**，
 * 因此迁移到表之后现有行为不变（`id` 沿用原 key，存量引用不受影响）。
 *
 * ⚠️ 这是「默认预设」的唯一定义处；迁移 005 只建表不播种，正是为了避免第二份副本。
 * 计费档位**不写死在这里** —— 由分辨率经 `quality_config` 的档位规则推导，
 * 见 `resolveSnapshot()`。
 */
export const DEFAULT_QUALITY_PRESETS: Omit<QualityPreset, 'createdAt' | 'updatedAt'>[] = [
  {
    id: '480p_2', label: '480P 30fps', width: 640, height: 480, frameRate: 30,
    bitrateMin: 400, bitrateMax: 1000, optimizationMode: 'motion', codec: 'h264',
    enabled: true, isBuiltin: true, sortOrder: 0,
  },
  {
    id: '720p30', label: '720P 30fps', width: 1280, height: 720, frameRate: 30,
    bitrateMin: 1000, bitrateMax: 3000, optimizationMode: 'motion', codec: 'h264',
    enabled: true, isBuiltin: true, sortOrder: 10,
  },
  {
    id: '1080p_2', label: '1080P 30fps', width: 1920, height: 1080, frameRate: 30,
    bitrateMin: 2000, bitrateMax: null, optimizationMode: 'motion', codec: 'h264',
    enabled: true, isBuiltin: true, sortOrder: 20,
  },
  {
    id: '1080p60', label: '1080P 60fps', width: 1920, height: 1080, frameRate: 60,
    bitrateMin: 2000, bitrateMax: null, optimizationMode: 'motion', codec: 'h264',
    enabled: true, isBuiltin: true, sortOrder: 30,
  },
  {
    id: '1440p30', label: '2K 30fps', width: 2560, height: 1440, frameRate: 30,
    bitrateMin: 2000, bitrateMax: null, optimizationMode: 'motion', codec: 'h264',
    enabled: true, isBuiltin: true, sortOrder: 40,
  },
  {
    id: '1440p60', label: '2K 60fps', width: 2560, height: 1440, frameRate: 60,
    bitrateMin: 2000, bitrateMax: null, optimizationMode: 'motion', codec: 'h264',
    enabled: true, isBuiltin: true, sortOrder: 50,
  },
  {
    id: '4k30', label: '4K 30fps', width: 3840, height: 2160, frameRate: 30,
    bitrateMin: 2000, bitrateMax: null, optimizationMode: 'motion', codec: 'h264',
    enabled: true, isBuiltin: true, sortOrder: 60,
  },
];

export class QualityPresetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'QualityPresetError';
  }
}

/**
 * 画质预设 + 自定义画质。
 *
 * 职责：
 * - 管理 `quality_presets`（播种、CRUD、排序）
 * - 把「预设 id」或「自定义入参」解析成**会话上的不可变快照** `QualitySnapshot`
 *
 * 🔑 快照里的 `tier` 由**分辨率**推导，而不是预设上写死的档位 ——
 * 这样自定义分辨率也能算对钱（Phase 2-3 已铺垫：账本用快照系数结算）。
 */
@Injectable()
export class QualityPresetService implements OnModuleInit {
  private readonly logger = new Logger(QualityPresetService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly qualityConfig: QualityConfigService,
  ) {}

  onModuleInit(): void {
    if (this.db.listQualityPresets().length === 0) {
      this.seedDefaults();
      this.logger.log(`Seeded ${DEFAULT_QUALITY_PRESETS.length} default quality presets`);
    }
  }

  // ===== 读取 =====

  /** 全部预设（含停用）。 */
  list(): QualityPreset[] {
    return this.db.listQualityPresets();
  }

  /** 仅启用的预设，按 sort_order 升序 —— 分享页画质选择器用这个。 */
  listEnabled(): QualityPreset[] {
    return this.db.listQualityPresets().filter((p) => p.enabled);
  }

  get(id: string): QualityPreset | undefined {
    return this.db.getQualityPreset(id);
  }

  // ===== 解析为快照 =====

  /**
   * 由预设 id 解析出快照。
   *
   * 预设不存在时**返回 undefined 而不是静默回退**：调用方应给出明确错误，
   * 否则用户会以为自己选的是 A 档、实际按 B 档计费。
   */
  resolveFromPreset(id: string): QualitySnapshot | undefined {
    const preset = this.db.getQualityPreset(id);
    if (!preset) return undefined;
    return this.snapshotFrom({
      source: 'preset',
      presetId: preset.id,
      width: preset.width,
      height: preset.height,
      frameRate: preset.frameRate,
      bitrateMin: preset.bitrateMin,
      bitrateMax: preset.bitrateMax,
      optimizationMode: preset.optimizationMode,
      codec: preset.codec,
    });
  }

  /**
   * 由自定义参数解析出快照。
   *
   * ⚠️ 这里**不抛错**：校验结果连同快照一起返回，让调用方决定怎么展示
   * （分享接口会把 reject 级问题作为 400 返回，warn 级只回给前端提示）。
   */
  resolveFromCustom(input: CustomQualityInput): {
    snapshot: QualitySnapshot;
    issues: ReturnType<typeof validateCustomQuality>;
  } {
    const config = this.qualityConfig.get();
    const issues = validateCustomQuality(input, config.limits);
    return {
      snapshot: this.snapshotFrom({
        source: 'custom',
        presetId: null,
        width: input.width,
        height: input.height,
        frameRate: input.frameRate,
        bitrateMin: input.bitrateMin ?? null,
        bitrateMax: input.bitrateMax ?? null,
        optimizationMode: input.optimizationMode ?? 'motion',
        codec: input.codec ?? 'h264',
      }),
      issues,
    };
  }

  /** 补齐 `tier`（由分辨率推导）并冻结为快照。 */
  private snapshotFrom(
    partial: Omit<QualitySnapshot, 'tier'>,
  ): QualitySnapshot {
    return {
      ...partial,
      tier: this.qualityConfig.tierRuleFor(partial.width, partial.height).tier,
    };
  }

  // ===== 写入 =====

  private seedDefaults(): void {
    this.db.transaction(() => {
      for (const preset of DEFAULT_QUALITY_PRESETS) this.db.createQualityPreset(preset);
    });
  }

  /** 新增预设。`id` 只允许 [a-z0-9_]，因为它会出现在配置与历史数据里。 */
  create(input: {
    id: string;
    label: string;
    width: number;
    height: number;
    frameRate: number;
    bitrateMin?: number | null;
    bitrateMax?: number | null;
    optimizationMode?: QualityOptimizationMode;
    codec?: QualityCodec;
    enabled?: boolean;
    sortOrder?: number;
  }): QualityPreset {
    this.assertPresetInput(input);
    return this.db.createQualityPreset({
      id: input.id,
      label: input.label.trim(),
      width: input.width,
      height: input.height,
      frameRate: input.frameRate,
      bitrateMin: input.bitrateMin ?? null,
      bitrateMax: input.bitrateMax ?? null,
      optimizationMode: input.optimizationMode ?? 'motion',
      codec: input.codec ?? 'h264',
      enabled: input.enabled !== false,
      isBuiltin: false,
      sortOrder: input.sortOrder ?? 999,
    });
  }

  /**
   * 更新预设。
   *
   * `id` **不可改**（`servers.allowed_qualities` 与存量会话都在引用它），
   * 因此刻意不在可更新字段里。
   */
  update(
    id: string,
    input: {
      label?: string;
      width?: number;
      height?: number;
      frameRate?: number;
      bitrateMin?: number | null;
      bitrateMax?: number | null;
      optimizationMode?: QualityOptimizationMode;
      codec?: QualityCodec;
      enabled?: boolean;
      sortOrder?: number;
    },
  ): QualityPreset | undefined {
    const existing = this.db.getQualityPreset(id);
    if (!existing) return undefined;

    const merged = { ...existing, ...input };
    this.assertPresetInput({
      ...merged,
      // id 不参与修改，这里只是为了满足入参类型
      id,
      label: merged.label,
    });

    this.db.updateQualityPreset(id, {
      label: input.label?.trim(),
      width: input.width,
      height: input.height,
      frameRate: input.frameRate,
      bitrateMin: input.bitrateMin,
      bitrateMax: input.bitrateMax,
      optimizationMode: input.optimizationMode,
      codec: input.codec,
      enabled: input.enabled,
      sortOrder: input.sortOrder,
    });
    return this.db.getQualityPreset(id);
  }

  /**
   * 删除预设。
   *
   * ⚠️ 只允许删除**非内置**且**未被会话引用**的预设。
   * 内置预设删掉会让默认画质选择消失；被引用的删掉会让历史账目查不到档位。
   * 要停用内置预设请用 `update({ enabled: false })`。
   */
  remove(id: string): { ok: boolean; message?: string } {
    const preset = this.db.getQualityPreset(id);
    if (!preset) return { ok: false, message: '画质预设不存在' };
    if (preset.isBuiltin) {
      return { ok: false, message: '内置预设不可删除，如需停用请改为「停用」' };
    }
    const bound = this.db.countSessionsByQualityPreset(id);
    if (bound > 0) {
      return {
        ok: false,
        message: `该预设已被 ${bound} 个会话引用，不能删除。如需停用请改为「停用」。`,
      };
    }
    return { ok: this.db.deleteQualityPreset(id) };
  }

  private assertPresetInput(input: {
    id?: string;
    label?: string;
    width?: number;
    height?: number;
    frameRate?: number;
    bitrateMin?: number | null;
    bitrateMax?: number | null;
    optimizationMode?: QualityOptimizationMode;
    codec?: QualityCodec;
  }): void {
    if (input.id !== undefined && !/^[a-z0-9_]+$/.test(input.id)) {
      throw new QualityPresetError('INVALID_ID', '画质 ID 只能包含小写字母、数字和下划线');
    }
    if (input.label !== undefined && !input.label.trim()) {
      throw new QualityPresetError('EMPTY_LABEL', '画质名称不能为空');
    }
    for (const field of ['width', 'height', 'frameRate'] as const) {
      const value = input[field];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value <= 0) {
        throw new QualityPresetError('INVALID_NUMBER', `${field} 必须为正整数`);
      }
    }
    if (input.width !== undefined && input.width % 2 !== 0) {
      throw new QualityPresetError('ODD_DIMENSION', '宽度必须为偶数');
    }
    if (input.height !== undefined && input.height % 2 !== 0) {
      throw new QualityPresetError('ODD_DIMENSION', '高度必须为偶数');
    }
    for (const field of ['bitrateMin', 'bitrateMax'] as const) {
      const value = input[field];
      if (value === undefined || value === null) continue;
      if (!Number.isFinite(value) || value <= 0) {
        throw new QualityPresetError('INVALID_BITRATE', `${field} 必须为正数或留空`);
      }
    }
    if (
      input.bitrateMin !== undefined && input.bitrateMax !== undefined &&
      input.bitrateMin !== null && input.bitrateMax !== null &&
      input.bitrateMax < input.bitrateMin
    ) {
      throw new QualityPresetError('MAX_BELOW_MIN', '最高码率不能低于最低码率');
    }
    if (input.optimizationMode && !['motion', 'detail'].includes(input.optimizationMode)) {
      throw new QualityPresetError('INVALID_MODE', 'optimizationMode 只能是 motion 或 detail');
    }
    if (input.codec && !['h264', 'vp8', 'vp9'].includes(input.codec)) {
      throw new QualityPresetError('INVALID_CODEC', 'codec 只能是 h264 / vp8 / vp9');
    }
  }
}
