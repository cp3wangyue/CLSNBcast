import { describe, expect, it } from 'vitest';
import {
  QUALITY_PRESETS,
  STANDARD_MINUTE_PRICE,
  getAudioCoefficient,
  getDefaultQualityBitrates,
  getQualityInfo,
  getVideoCoefficient,
} from './session.types';

describe('getQualityInfo', () => {
  it('按 key 返回对应档位', () => {
    const q = getQualityInfo('720p30');
    expect(q.key).toBe('720p30');
    expect(q.width).toBe(1280);
    expect(q.height).toBe(720);
    expect(q.tier).toBe('HD 高清');
  });

  it('未知 key 回退到 1080p_2（getQualityInfo 的既有行为）', () => {
    expect(getQualityInfo('not-a-real-key').key).toBe('1080p_2');
    expect(getQualityInfo('').key).toBe('1080p_2');
  });

  it('每个预设字段完整且数值合理', () => {
    for (const q of QUALITY_PRESETS) {
      expect(q.key).toBeTruthy();
      expect(q.label).toBeTruthy();
      expect(q.tier).toBeTruthy();
      expect(q.width).toBeGreaterThan(0);
      expect(q.height).toBeGreaterThan(0);
      expect(q.frameRate).toBeGreaterThan(0);
      expect(q.resolution).toBe(q.width * q.height);
    }
  });

  it('预设 key 唯一（key 是 sessions.quality 与 allowed_qualities 的引用目标）', () => {
    const keys = QUALITY_PRESETS.map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('getAudioCoefficient', () => {
  it('主播始终按互动直播音频系数 1，与直播模式无关', () => {
    expect(getAudioCoefficient(true, true)).toBe(1);
    expect(getAudioCoefficient(false, true)).toBe(1);
  });

  it('观众按模式区分：低延迟 1，极速直播 0.57', () => {
    expect(getAudioCoefficient(true, false)).toBe(1);
    expect(getAudioCoefficient(false, false)).toBe(0.57);
  });
});

describe('getVideoCoefficient', () => {
  it('低延迟模式走互动直播系数表', () => {
    expect(getVideoCoefficient('SD 标清', true)).toBe(4);
    expect(getVideoCoefficient('HD 高清', true)).toBe(4);
    expect(getVideoCoefficient('Full HD 全高清', true)).toBe(9);
    expect(getVideoCoefficient('2K', true)).toBe(16);
    expect(getVideoCoefficient('2K+ 超高清', true)).toBe(36);
  });

  it('极速直播模式走极速直播系数表（锁定当前行为）', () => {
    // ⚠️ Full HD 的 4.57 是上游现值，官方文档为 4.5。
    // Phase 2 会修正为 4.5，届时本断言需同步更新。
    // 依据见 docs/open-questions.md 第 4 节。
    expect(getVideoCoefficient('SD 标清', false)).toBe(2);
    expect(getVideoCoefficient('HD 高清', false)).toBe(2);
    expect(getVideoCoefficient('Full HD 全高清', false)).toBe(4.57);
    expect(getVideoCoefficient('2K', false)).toBe(8);
    expect(getVideoCoefficient('2K+ 超高清', false)).toBe(18);
  });

  it('未知档位回退：低延迟 4，极速直播 2', () => {
    expect(getVideoCoefficient('不存在的档位', true)).toBe(4);
    expect(getVideoCoefficient('不存在的档位', false)).toBe(2);
  });

  it('SD 与 HD 共用同一系数（官方计费表没有 SD 档，SD 归入 HD）', () => {
    for (const lowLatency of [true, false]) {
      expect(getVideoCoefficient('SD 标清', lowLatency)).toBe(
        getVideoCoefficient('HD 高清', lowLatency),
      );
    }
  });
});

describe('getDefaultQualityBitrates', () => {
  it('为每个预设生成条目', () => {
    const bitrates = getDefaultQualityBitrates();
    expect(Object.keys(bitrates).sort()).toEqual(QUALITY_PRESETS.map((q) => q.key).sort());
  });

  it('只包含预设显式声明的码率字段（未声明的不写入 undefined）', () => {
    const bitrates = getDefaultQualityBitrates();
    // 1080p_2 只声明了 bitrateMin
    expect(bitrates['1080p_2']).toEqual({ bitrateMin: 2000 });
    expect('bitrateMax' in bitrates['1080p_2']).toBe(false);
    // 720p30 两个都声明
    expect(bitrates['720p30']).toEqual({ bitrateMin: 1000, bitrateMax: 3000 });
  });

  it('声明了码率的档位满足 min <= max', () => {
    for (const [key, value] of Object.entries(getDefaultQualityBitrates())) {
      if (value.bitrateMin !== undefined && value.bitrateMax !== undefined) {
        expect(value.bitrateMax, `${key} 的 bitrateMax 不应低于 bitrateMin`).toBeGreaterThanOrEqual(
          value.bitrateMin,
        );
      }
    }
  });
});

describe('STANDARD_MINUTE_PRICE', () => {
  it('当前为 0.007 元/标准分钟（待定项，调整需同步 docs/open-questions.md）', () => {
    expect(STANDARD_MINUTE_PRICE).toBe(0.007);
  });
});
