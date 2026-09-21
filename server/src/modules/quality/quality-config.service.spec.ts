import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseService } from '../database/database.service';
import { QualityConfigService, QualityConfigValidationError } from './quality-config.service';
import { DEFAULT_QUALITY_CONFIG } from './quality-config.types';

describe('QualityConfigService', () => {
  let dir: string;
  let db: DatabaseService;
  let service: QualityConfigService;

  /** 绕过服务直接改库，用于构造「配置损坏」场景。 */
  function rawDb() {
    return new Database(join(dir, 'clsnbcast.db'));
  }

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    dir = mkdtempSync(join(tmpdir(), 'clsnbcast-quality-'));
    process.env.DATA_DIR = dir;
    db = new DatabaseService();
    service = new QualityConfigService(db);
  });

  afterEach(() => {
    db.onModuleDestroy();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  describe('播种与读取', () => {
    it('表为空时 onModuleInit 播种默认配置', () => {
      expect(db.getQualityConfig()).toBeUndefined();
      service.onModuleInit();
      expect(db.getQualityConfig()).toBeDefined();
    });

    it('播种后的内容与默认配置一致', () => {
      service.onModuleInit();
      const config = service.get();

      expect(config.tierRules).toEqual(DEFAULT_QUALITY_CONFIG.tierRules);
      expect(config.audioCoefficients).toEqual(DEFAULT_QUALITY_CONFIG.audioCoefficients);
      expect(config.standardMinutePrice).toBe(0.007);
      expect(config.usageTimezone).toBe('Asia/Shanghai');
    });

    it('重复 onModuleInit 不会覆盖已有配置（管理员改过的值要留住）', () => {
      service.onModuleInit();
      service.update({ standardMinutePrice: 0.012 });
      service.invalidateCache();
      service.onModuleInit();

      expect(service.get().standardMinutePrice).toBe(0.012);
    });

    it('行缺失时回退到默认值（不抛错）', () => {
      const raw = rawDb();
      raw.prepare('DELETE FROM quality_config').run();
      raw.close();
      service.invalidateCache();

      expect(service.get().tierRules).toEqual(DEFAULT_QUALITY_CONFIG.tierRules);
    });

    it('JSON 损坏时回退到默认值并记 warn（不能静默）', () => {
      service.onModuleInit();
      const raw = rawDb();
      raw.prepare('UPDATE quality_config SET tier_rules = ? WHERE id = 1').run('{not json');
      raw.close();
      service.invalidateCache();
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');

      const config = service.get();

      expect(config.tierRules).toEqual(DEFAULT_QUALITY_CONFIG.tierRules);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('缓存生效：第二次读取不再查库', () => {
      service.onModuleInit();
      const first = service.get();
      // 直接改库但不失效缓存
      const raw = rawDb();
      raw.prepare('UPDATE quality_config SET standard_minute_price = 99 WHERE id = 1').run();
      raw.close();

      expect(service.get()).toBe(first);
      expect(service.get().standardMinutePrice).not.toBe(99);
    });

    it('invalidateCache 后重新从库里读', () => {
      service.onModuleInit();
      const raw = rawDb();
      raw.prepare('UPDATE quality_config SET standard_minute_price = 99 WHERE id = 1').run();
      raw.close();

      service.invalidateCache();

      expect(service.get().standardMinutePrice).toBe(99);
    });
  });

  describe('更新与校验', () => {
    beforeEach(() => service.onModuleInit());

    it('更新后立即生效并落库', () => {
      service.update({ standardMinutePrice: 0.02 });
      expect(service.get().standardMinutePrice).toBe(0.02);
      expect(db.getQualityConfig()!.standardMinutePrice).toBe(0.02);
    });

    it('可以只改一部分字段，其余保持不变', () => {
      service.update({ usageTimezone: 'UTC' });
      const config = service.get();
      expect(config.usageTimezone).toBe('UTC');
      expect(config.standardMinutePrice).toBe(DEFAULT_QUALITY_CONFIG.standardMinutePrice);
      expect(config.tierRules).toEqual(DEFAULT_QUALITY_CONFIG.tierRules);
    });

    it('✅ 修正 Full HD 极速直播系数可以通过配置完成（不需要改代码）', () => {
      const fixed = DEFAULT_QUALITY_CONFIG.tierRules.map((rule) =>
        rule.tier === 'Full HD 全高清' ? { ...rule, ultraLowLatency: 4.5 } : rule,
      );
      service.update({ tierRules: fixed });

      const fullHd = service.get().tierRules.find((r) => r.tier === 'Full HD 全高清')!;
      expect(fullHd.ultraLowLatency).toBe(4.5);
    });

    const invalidCases: [string, () => void, string][] = [
      ['档位规则为空', () => service.update({ tierRules: [] }), 'EMPTY_TIER_RULES'],
      [
        '像素上界非递增',
        () => service.update({ tierRules: [
          { tier: 'A', maxPixels: 1000, interactive: 1, ultraLowLatency: 1 },
          { tier: 'B', maxPixels: 500, interactive: 1, ultraLowLatency: 1 },
          { tier: 'C', maxPixels: null, interactive: 1, ultraLowLatency: 1 },
        ] }),
        'TIER_RULES_NOT_ASCENDING',
      ],
      [
        '最后一档有上界（更高的分辨率无处归属）',
        () => service.update({ tierRules: [
          { tier: 'A', maxPixels: 1000, interactive: 1, ultraLowLatency: 1 },
        ] }),
        'MISSING_OPEN_ENDED_TIER',
      ],
      [
        '系数非正数',
        () => service.update({ tierRules: [
          { tier: 'A', maxPixels: null, interactive: 0, ultraLowLatency: 1 },
        ] }),
        'INVALID_COEFFICIENT',
      ],
      [
        '档位名为空',
        () => service.update({ tierRules: [
          { tier: '  ', maxPixels: null, interactive: 1, ultraLowLatency: 1 },
        ] }),
        'EMPTY_TIER_NAME',
      ],
      ['单价非正数', () => service.update({ standardMinutePrice: 0 }), 'INVALID_PRICE'],
      ['单价为负', () => service.update({ standardMinutePrice: -1 }), 'INVALID_PRICE'],
      ['时区为空', () => service.update({ usageTimezone: '' }), 'INVALID_TIMEZONE'],
      ['时区无法识别', () => service.update({ usageTimezone: 'Not/AZone' }), 'INVALID_TIMEZONE'],
      [
        '音频系数非正数',
        () => service.update({ audioCoefficients: { ...DEFAULT_QUALITY_CONFIG.audioCoefficients, broadcaster: 0 } }),
        'INVALID_COEFFICIENT',
      ],
    ];

    for (const [label, run, expectedCode] of invalidCases) {
      it(`拒绝：${label}`, () => {
        try {
          run();
          throw new Error('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(QualityConfigValidationError);
          expect((e as QualityConfigValidationError).code).toBe(expectedCode);
        }
      });
    }

    it('校验失败时不落库、不影响当前生效配置', () => {
      const before = service.get();
      expect(() => service.update({ standardMinutePrice: -1 })).toThrow();

      expect(service.get()).toBe(before);
      expect(db.getQualityConfig()!.standardMinutePrice).toBe(before.standardMinutePrice);
    });
  });

  describe('tierRuleFor', () => {
    beforeEach(() => service.onModuleInit());

    it('按分辨率返回对应档位与系数', () => {
      const fullHd = service.tierRuleFor(1920, 1080);
      expect(fullHd.tier).toBe('Full HD 全高清');
      expect(fullHd.interactive).toBe(9);
      expect(fullHd.ultraLowLatency).toBe(4.5);
    });

    it('自定义分辨率也能落到合理档位', () => {
      expect(service.tierRuleFor(1600, 900).tier).toBe('Full HD 全高清');
      expect(service.tierRuleFor(1024, 768).tier).toBe('HD 高清');
    });

    it('跟随配置变更', () => {
      service.update({ tierRules: [
        { tier: '统一档', maxPixels: null, interactive: 7, ultraLowLatency: 3 },
      ] });
      expect(service.tierRuleFor(3840, 2160).tier).toBe('统一档');
      expect(service.tierRuleFor(640, 480).ultraLowLatency).toBe(3);
    });
  });

  it('getUsageTimezone 跟随配置', () => {
    service.onModuleInit();
    expect(service.getUsageTimezone()).toBe('Asia/Shanghai');
    service.update({ usageTimezone: 'UTC' });
    expect(service.getUsageTimezone()).toBe('UTC');
  });
});
