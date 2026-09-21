import { describe, expect, it } from 'vitest';
import { resolveBillingProfile } from './usage-billing';

describe('resolveBillingProfile', () => {
  it('主播：始终互动直播 + 音频系数，与档位和模式无关', () => {
    for (const lowLatency of [true, false]) {
      for (const tier of ['HD 高清', 'Full HD 全高清', '4K 超高清', '不存在']) {
        const profile = resolveBillingProfile({ role: 'publisher', tier, lowLatency });
        expect(profile.billingModel).toBe('interactive');
        expect(profile.coefficient).toBe(1);
      }
    }
  });

  it('观众 + 低延迟模式：互动直播价，按视频档位取系数', () => {
    expect(resolveBillingProfile({ role: 'viewer', tier: 'HD 高清', lowLatency: true }))
      .toEqual({ billingModel: 'interactive', coefficient: 4 });
    expect(resolveBillingProfile({ role: 'viewer', tier: 'Full HD 全高清', lowLatency: true }))
      .toEqual({ billingModel: 'interactive', coefficient: 9 });
    expect(resolveBillingProfile({ role: 'viewer', tier: '2K', lowLatency: true }))
      .toEqual({ billingModel: 'interactive', coefficient: 16 });
    expect(resolveBillingProfile({ role: 'viewer', tier: '2K+ 超高清', lowLatency: true }))
      .toEqual({ billingModel: 'interactive', coefficient: 36 });
  });

  it('观众 + 极速直播：极速直播价（默认模式，覆盖绝大多数会话）', () => {
    expect(resolveBillingProfile({ role: 'viewer', tier: 'HD 高清', lowLatency: false }))
      .toEqual({ billingModel: 'ultra_low_latency', coefficient: 2 });
    // Full HD 目前锁定上游现值 4.57；官方为 4.5，Phase 2-3 修正时会同步改这里
    expect(resolveBillingProfile({ role: 'viewer', tier: 'Full HD 全高清', lowLatency: false }))
      .toEqual({ billingModel: 'ultra_low_latency', coefficient: 4.57 });
    expect(resolveBillingProfile({ role: 'viewer', tier: '2K', lowLatency: false }))
      .toEqual({ billingModel: 'ultra_low_latency', coefficient: 8 });
    expect(resolveBillingProfile({ role: 'viewer', tier: '2K+ 超高清', lowLatency: false }))
      .toEqual({ billingModel: 'ultra_low_latency', coefficient: 18 });
  });

  it('未知档位回退到既有默认（低延迟 4 / 极速直播 2），不会算出 0', () => {
    expect(resolveBillingProfile({ role: 'viewer', tier: '未知档位', lowLatency: true }).coefficient).toBe(4);
    expect(resolveBillingProfile({ role: 'viewer', tier: '未知档位', lowLatency: false }).coefficient).toBe(2);
  });

  it('SD 与 HD 系数相同（官方计费表没有 SD 档）', () => {
    for (const lowLatency of [true, false]) {
      expect(resolveBillingProfile({ role: 'viewer', tier: 'SD 标清', lowLatency }))
        .toEqual(resolveBillingProfile({ role: 'viewer', tier: 'HD 高清', lowLatency }));
    }
  });

  it('同一档位下，低延迟模式的系数不低于极速直播（互动直播价更贵）', () => {
    for (const tier of ['HD 高清', 'Full HD 全高清', '2K', '2K+ 超高清']) {
      const interactive = resolveBillingProfile({ role: 'viewer', tier, lowLatency: true }).coefficient;
      const ultra = resolveBillingProfile({ role: 'viewer', tier, lowLatency: false }).coefficient;
      expect(interactive).toBeGreaterThan(ultra);
    }
  });
});
