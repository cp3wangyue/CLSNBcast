import { describe, expect, it } from 'vitest';
import { DEFAULT_QUALITY_CONFIG, QualityConfigValues, tierRuleForPixels } from '../quality/quality-config.types';
import { resolveBillingProfile } from './usage-billing';

const config = DEFAULT_QUALITY_CONFIG;

function profile(role: 'publisher' | 'viewer', tier: string, lowLatency: boolean) {
  return resolveBillingProfile({ role, tier, lowLatency, config });
}

describe('resolveBillingProfile', () => {
  it('主播：始终互动直播 + 音频系数，与档位和模式无关', () => {
    for (const lowLatency of [true, false]) {
      for (const tier of ['HD 高清', 'Full HD 全高清', '2K+ 超高清', '不存在']) {
        const result = profile('publisher', tier, lowLatency);
        expect(result.billingModel).toBe('interactive');
        expect(result.coefficient).toBe(1);
      }
    }
  });

  it('观众 + 低延迟模式：互动直播价，按视频档位取系数', () => {
    expect(profile('viewer', 'HD 高清', true)).toEqual({ billingModel: 'interactive', coefficient: 4 });
    expect(profile('viewer', 'Full HD 全高清', true)).toEqual({ billingModel: 'interactive', coefficient: 9 });
    expect(profile('viewer', '2K', true)).toEqual({ billingModel: 'interactive', coefficient: 16 });
    expect(profile('viewer', '2K+ 超高清', true)).toEqual({ billingModel: 'interactive', coefficient: 36 });
  });

  it('观众 + 极速直播：极速直播价（默认模式，覆盖绝大多数会话）', () => {
    expect(profile('viewer', 'HD 高清', false)).toEqual({ billingModel: 'ultra_low_latency', coefficient: 2 });
    expect(profile('viewer', '2K', false)).toEqual({ billingModel: 'ultra_low_latency', coefficient: 8 });
    expect(profile('viewer', '2K+ 超高清', false)).toEqual({ billingModel: 'ultra_low_latency', coefficient: 18 });
  });

  it('✅ Full HD 极速直播系数为 4.5（修正上游写错的 4.57）', () => {
    expect(profile('viewer', 'Full HD 全高清', false).coefficient).toBe(4.5);
    // 顺带确认默认配置里没有残留 4.57
    const fullHd = config.tierRules.find((r) => r.tier === 'Full HD 全高清')!;
    expect(fullHd.ultraLowLatency).toBe(4.5);
    expect(fullHd.ultraLowLatency).not.toBe(4.57);
  });

  it('未知档位回退到最低档系数（与既有 ?? 4 / ?? 2 行为一致），不会算出 0', () => {
    expect(profile('viewer', '未知档位', true).coefficient).toBe(4);
    expect(profile('viewer', '未知档位', false).coefficient).toBe(2);
  });

  it('SD 与 HD 系数相同（官方计费表没有 SD 档）', () => {
    for (const lowLatency of [true, false]) {
      expect(profile('viewer', 'SD 标清', lowLatency)).toEqual(profile('viewer', 'HD 高清', lowLatency));
    }
  });

  it('同一档位下，低延迟模式的系数不低于极速直播', () => {
    for (const tier of ['HD 高清', 'Full HD 全高清', '2K', '2K+ 超高清']) {
      expect(profile('viewer', tier, true).coefficient).toBeGreaterThan(
        profile('viewer', tier, false).coefficient,
      );
    }
  });

  // ===== 可配置性 =====

  it('🔑 系数改为可配后，调价只需改配置而不用改代码', () => {
    const doubled: QualityConfigValues = {
      ...config,
      tierRules: config.tierRules.map((r) => ({
        ...r,
        interactive: r.interactive * 2,
        ultraLowLatency: r.ultraLowLatency * 2,
      })),
    };

    expect(
      resolveBillingProfile({ role: 'viewer', tier: 'Full HD 全高清', lowLatency: false, config: doubled })
        .coefficient,
    ).toBe(9);
  });

  it('音频系数同样可配', () => {
    const custom: QualityConfigValues = {
      ...config,
      audioCoefficients: { ...config.audioCoefficients, broadcaster: 2 },
    };
    expect(
      resolveBillingProfile({ role: 'publisher', tier: 'HD 高清', lowLatency: false, config: custom })
        .coefficient,
    ).toBe(2);
  });

  it('配置里删掉某档位时回退到最低档，而不是抛错', () => {
    const trimmed: QualityConfigValues = {
      ...config,
      tierRules: config.tierRules.filter((r) => r.tier !== 'Full HD 全高清'),
    };
    expect(
      resolveBillingProfile({ role: 'viewer', tier: 'Full HD 全高清', lowLatency: false, config: trimmed })
        .coefficient,
    ).toBe(2);
  });
});

describe('tierRuleForPixels', () => {
  const rules = config.tierRules;

  it('按像素数映射到正确档位（自由画质的关键：不靠 preset key 反查）', () => {
    expect(tierRuleForPixels(rules, 640, 480).tier).toBe('SD 标清');
    expect(tierRuleForPixels(rules, 1280, 720).tier).toBe('HD 高清');
    expect(tierRuleForPixels(rules, 1920, 1080).tier).toBe('Full HD 全高清');
    expect(tierRuleForPixels(rules, 2560, 1440).tier).toBe('2K');
    expect(tierRuleForPixels(rules, 3840, 2160).tier).toBe('2K+ 超高清');
  });

  it('自定义分辨率也能落到合理档位（这是自定义画质能算对钱的前提）', () => {
    expect(tierRuleForPixels(rules, 1600, 900).tier).toBe('Full HD 全高清'); // 1.44M px
    expect(tierRuleForPixels(rules, 1024, 768).tier).toBe('HD 高清'); // 0.79M px
    expect(tierRuleForPixels(rules, 3000, 2000).tier).toBe('2K+ 超高清'); // 6M px
  });

  it('恰好等于上界时归入该档（上界是闭区间）', () => {
    expect(tierRuleForPixels(rules, 1280, 720).tier).toBe('HD 高清'); // 921600 == 上界
    expect(tierRuleForPixels(rules, 1920, 1080).tier).toBe('Full HD 全高清'); // 2073600 == 上界
  });

  it('超过最高档上界时归入无上界的那一档', () => {
    expect(tierRuleForPixels(rules, 7680, 4320).tier).toBe('2K+ 超高清');
  });

  it('规则顺序被打乱也能正确映射（内部按上界排序）', () => {
    const shuffled = [...rules].reverse();
    expect(tierRuleForPixels(shuffled, 1920, 1080).tier).toBe('Full HD 全高清');
    expect(tierRuleForPixels(shuffled, 640, 480).tier).toBe('SD 标清');
  });
});
