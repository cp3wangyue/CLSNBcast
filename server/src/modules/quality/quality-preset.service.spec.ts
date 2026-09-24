import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service';
import { QualityConfigService } from './quality-config.service';
import { QualityPresetError, QualityPresetService } from './quality-preset.service';

describe('QualityPresetService', () => {
  let dir: string;
  let db: DatabaseService;
  let qualityConfig: QualityConfigService;
  let presets: QualityPresetService;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    dir = mkdtempSync(join(tmpdir(), 'clsnbcast-presets-'));
    process.env.DATA_DIR = dir;
    db = new DatabaseService();
    qualityConfig = new QualityConfigService(db);
    qualityConfig.onModuleInit();
    presets = new QualityPresetService(db, qualityConfig);
  });

  afterEach(() => {
    db.onModuleDestroy();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  describe('播种', () => {
    it('表为空时 onModuleInit 播种 7 个内置预设', () => {
      expect(db.listQualityPresets()).toHaveLength(0);
      presets.onModuleInit();

      const all = db.listQualityPresets();
      expect(all).toHaveLength(7);
      expect(all.every((p) => p.isBuiltin)).toBe(true);
    });

    it('✅ 播种内容与原有硬编码 QUALITY_PRESETS 逐项一致（行为不变）', () => {
      presets.onModuleInit();
      const byId = new Map(db.listQualityPresets().map((p) => [p.id, p]));

      const expected: [string, number, number, number, number | null, number | null][] = [
        ['480p_2', 640, 480, 30, 400, 1000],
        ['720p30', 1280, 720, 30, 1000, 3000],
        ['1080p_2', 1920, 1080, 30, 2000, null],
        ['1080p60', 1920, 1080, 60, 2000, null],
        ['1440p30', 2560, 1440, 30, 2000, null],
        ['1440p60', 2560, 1440, 60, 2000, null],
        ['4k30', 3840, 2160, 30, 2000, null],
      ];
      for (const [id, w, h, fps, min, max] of expected) {
        const preset = byId.get(id)!;
        expect(preset, `missing preset ${id}`).toBeDefined();
        expect(preset.width).toBe(w);
        expect(preset.height).toBe(h);
        expect(preset.frameRate).toBe(fps);
        expect(preset.bitrateMin).toBe(min);
        expect(preset.bitrateMax).toBe(max);
      }
    });

    it('重复 onModuleInit 不会重复播种（管理员改过的值要留住）', () => {
      presets.onModuleInit();
      presets.update('720p30', { label: '改名' });
      presets.onModuleInit();

      expect(presets.get('720p30')!.label).toBe('改名');
      expect(presets.list()).toHaveLength(7);
    });

    it('默认预设全部启用，并按 sort_order 排序', () => {
      presets.onModuleInit();
      expect(presets.listEnabled()).toHaveLength(7);
      const orders = presets.list().map((p) => p.sortOrder);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
    });
  });

  describe('解析为快照', () => {
    beforeEach(() => presets.onModuleInit());

    it('预设 → 快照，并带上由分辨率推导的档位', () => {
      const snapshot = presets.resolveFromPreset('1080p_2')!;

      expect(snapshot.source).toBe('preset');
      expect(snapshot.presetId).toBe('1080p_2');
      expect(snapshot.width).toBe(1920);
      expect(snapshot.tier).toBe('Full HD 全高清');
      expect(snapshot.optimizationMode).toBe('motion');
      expect(snapshot.codec).toBe('h264');
    });

    it('2K 预设推导出 2K 档位', () => {
      expect(presets.resolveFromPreset('1440p30')!.tier).toBe('2K');
    });

    it('480p 预设推导到 SD 档', () => {
      expect(presets.resolveFromPreset('480p_2')!.tier).toBe('SD 标清');
    });

    it('🔑 预设不存在时返回 undefined，而不是静默回退到别的档', () => {
      expect(presets.resolveFromPreset('not-a-real-key')).toBeUndefined();
    });

    it('🔑 自定义参数 → 快照，档位由分辨率推导（自定义画质能算对钱）', () => {
      const { snapshot, issues } = presets.resolveFromCustom({
        width: 1600, height: 900, frameRate: 45,
        bitrateMin: 1500, bitrateMax: 4500,
      });

      expect(hasReject(issues)).toBe(false);
      expect(snapshot.source).toBe('custom');
      expect(snapshot.presetId).toBeNull();
      expect(snapshot.tier).toBe('Full HD 全高清'); // 1600×900 = 1.44M px
      expect(snapshot.frameRate).toBe(45);
    });

    it('自定义参数省略 optimizationMode / codec 时用默认值', () => {
      const { snapshot } = presets.resolveFromCustom({ width: 1280, height: 720, frameRate: 30 });
      expect(snapshot.optimizationMode).toBe('motion');
      expect(snapshot.codec).toBe('h264');
    });

    it('⚠️ 非法自定义参数不抛错，而是连同 issues 一起返回', () => {
      const { issues } = presets.resolveFromCustom({ width: 1921, height: 1080, frameRate: 30 });
      expect(hasReject(issues)).toBe(true);
    });

    it('超建议范围的自定义参数仍返回快照 + warn（不拦截用户输入）', () => {
      const { snapshot, issues } = presets.resolveFromCustom({
        width: 3840, height: 2160, frameRate: 60,
      });

      expect(hasReject(issues)).toBe(false);
      expect(snapshot.tier).toBe('2K+ 超高清');
      expect(issues.some((i) => i.severity === 'warn')).toBe(true);
    });

    it('🔑 档位跟随配置变更（管理员调档位规则后，新快照用新规则）', () => {
      qualityConfig.update({
        tierRules: [{ tier: '统一档', maxPixels: null, interactive: 7, ultraLowLatency: 3 }],
      });

      expect(presets.resolveFromPreset('4k30')!.tier).toBe('统一档');
      expect(presets.resolveFromCustom({ width: 640, height: 480, frameRate: 30 }).snapshot.tier)
        .toBe('统一档');
    });
  });

  describe('CRUD', () => {
    beforeEach(() => presets.onModuleInit());

    it('新增预设，默认非内置', () => {
      const created = presets.create({
        id: 'custom_1', label: '自定义 1440×900', width: 1440, height: 900,
        frameRate: 60, bitrateMin: 3000, bitrateMax: 8000,
      });

      expect(created.id).toBe('custom_1');
      expect(created.isBuiltin).toBe(false);
      expect(created.enabled).toBe(true);
      expect(presets.list()).toHaveLength(8);
    });

    it('新增预设可指定 optimizationMode 与 codec', () => {
      const created = presets.create({
        id: 'detail_1', label: '画质优先', width: 1920, height: 1080, frameRate: 30,
        optimizationMode: 'detail', codec: 'vp9',
      });

      expect(created.optimizationMode).toBe('detail');
      expect(created.codec).toBe('vp9');
    });

    it('更新预设参数', () => {
      presets.update('720p30', { label: '720P 改名', frameRate: 60, bitrateMax: 5000 });

      const updated = presets.get('720p30')!;
      expect(updated.label).toBe('720P 改名');
      expect(updated.frameRate).toBe(60);
      expect(updated.bitrateMax).toBe(5000);
    });

    it('🔒 id 不可改（被 allowed_qualities 与存量会话引用）', () => {
      presets.update('720p30', { id: 'renamed' } as any);
      expect(presets.get('720p30')).toBeDefined();
      expect(presets.get('renamed')).toBeUndefined();
    });

    it('停用预设后不再出现在 listEnabled', () => {
      presets.update('4k30', { enabled: false });

      expect(presets.get('4k30')!.enabled).toBe(false);
      expect(presets.listEnabled().map((p) => p.id)).not.toContain('4k30');
    });

    it('不存在的预设更新返回 undefined', () => {
      expect(presets.update('nope', { label: 'x' })).toBeUndefined();
    });

    it('🔒 内置预设不可删除', () => {
      const result = presets.remove('1080p_2');
      expect(result.ok).toBe(false);
      expect(result.message).toContain('内置预设');
      expect(presets.get('1080p_2')).toBeDefined();
    });

    it('自定义预设可删除', () => {
      presets.create({ id: 'temp_1', label: '临时', width: 800, height: 600, frameRate: 30 });
      expect(presets.remove('temp_1').ok).toBe(true);
      expect(presets.get('temp_1')).toBeUndefined();
    });

    it('🔒 被会话引用的自定义预设不可删除', () => {
      presets.create({ id: 'used_1', label: '被引用', width: 800, height: 600, frameRate: 30 });
      // 通过 createSession 造一条引用该预设的会话（quality_preset_id 是新列）
      const raw = new (require('better-sqlite3'))(join(dir, 'clsnbcast.db'));
      raw.prepare(
        `INSERT INTO sessions (
           id, token, channel, server_id, sharer_user_id, sharer_username,
           guild_id, target_channel_id, status, quality_preset_id
         ) VALUES ('s-ref', 'tok-ref', 'cb_ref', 'g1', 'u1', 'u', 'g1', 'c1', 'ended', 'used_1')`,
      ).run();
      raw.close();

      const result = presets.remove('used_1');
      expect(result.ok).toBe(false);
      expect(result.message).toContain('已被');
      expect(presets.get('used_1')).toBeDefined();
    });

    it('删除不存在的预设返回失败', () => {
      expect(presets.remove('nope').ok).toBe(false);
    });

    const invalidCreate: [string, Record<string, unknown>, string][] = [
      ['id 含大写', { id: 'BAD_ID', label: 'x', width: 800, height: 600, frameRate: 30 }, 'INVALID_ID'],
      ['id 含连字符', { id: 'bad-id', label: 'x', width: 800, height: 600, frameRate: 30 }, 'INVALID_ID'],
      ['label 为空', { id: 'ok_1', label: '  ', width: 800, height: 600, frameRate: 30 }, 'EMPTY_LABEL'],
      ['宽度非整数', { id: 'ok_1', label: 'x', width: 800.5, height: 600, frameRate: 30 }, 'INVALID_NUMBER'],
      ['帧率非正数', { id: 'ok_1', label: 'x', width: 800, height: 600, frameRate: 0 }, 'INVALID_NUMBER'],
      ['宽度为奇数', { id: 'ok_1', label: 'x', width: 801, height: 600, frameRate: 30 }, 'ODD_DIMENSION'],
      ['码率非正数', { id: 'ok_1', label: 'x', width: 800, height: 600, frameRate: 30, bitrateMin: 0 }, 'INVALID_BITRATE'],
      [
        'max 低于 min',
        { id: 'ok_1', label: 'x', width: 800, height: 600, frameRate: 30, bitrateMin: 5000, bitrateMax: 1000 },
        'MAX_BELOW_MIN',
      ],
      [
        'optimizationMode 非法',
        { id: 'ok_1', label: 'x', width: 800, height: 600, frameRate: 30, optimizationMode: 'balanced' },
        'INVALID_MODE',
      ],
      [
        'codec 非法',
        { id: 'ok_1', label: 'x', width: 800, height: 600, frameRate: 30, codec: 'av1' },
        'INVALID_CODEC',
      ],
    ];

    for (const [label, input, expectedCode] of invalidCreate) {
      it(`拒绝创建：${label}`, () => {
        try {
          presets.create(input as any);
          throw new Error('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(QualityPresetError);
          expect((e as QualityPresetError).code).toBe(expectedCode);
        }
      });
    }

    it('校验失败时不落库', () => {
      expect(() => presets.create({
        id: 'bad', label: 'x', width: 801, height: 600, frameRate: 30,
      })).toThrow();
      expect(presets.get('bad')).toBeUndefined();
      expect(presets.list()).toHaveLength(7);
    });
  });
});

function hasReject(issues: { severity: string }[]): boolean {
  return issues.some((i) => i.severity === 'reject');
}
