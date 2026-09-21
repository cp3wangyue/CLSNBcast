import { describe, expect, it } from 'vitest';
import { AgoraProviderRecord } from '../database/database.service';
import { DEFAULT_USAGE_TIMEZONE, currentPeriodKey, evaluateQuota } from './provider-quota';

function provider(overrides: Partial<AgoraProviderRecord> = {}): AgoraProviderRecord {
  return {
    id: 'p1',
    ownerType: 'platform',
    ownerId: '',
    name: 'p',
    appId: 'app',
    appCertificateEnc: 'v1:x:y:z',
    customerId: null,
    customerSecretEnc: null,
    enabled: 1,
    priority: 100,
    tokenExpireSec: 3600,
    healthStatus: 'unknown',
    healthCheckedAt: null,
    healthMessage: '',
    monthlyQuotaStandardMinutes: null,
    quotaEnforced: 0,
    estimatedUsageStandardMinutes: 0,
    usagePeriodKey: '',
    lastUsedAt: null,
    allowedPresetIds: null,
    note: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('currentPeriodKey', () => {
  it('按 Asia/Shanghai 计算，跨月边界正确', () => {
    // UTC 8/31 17:00 == 上海 9/1 01:00 → 属于 9 月
    expect(currentPeriodKey('Asia/Shanghai', new Date('2026-08-31T17:00:00Z'))).toBe('2026-09');
    // UTC 8/31 15:00 == 上海 8/31 23:00 → 仍属于 8 月
    expect(currentPeriodKey('Asia/Shanghai', new Date('2026-08-31T15:00:00Z'))).toBe('2026-08');
  });

  it('用 Intl 而不是本地时间（容器通常是 UTC，本地 getMonth 会算错周期）', () => {
    const at = new Date('2026-08-31T17:00:00Z');
    expect(currentPeriodKey('UTC', at)).toBe('2026-08');
    expect(currentPeriodKey('Asia/Shanghai', at)).toBe('2026-09');
  });

  it('跨年边界正确', () => {
    // UTC 12/31 16:00 == 上海 1/1 00:00 → 属于次年 1 月
    expect(currentPeriodKey('Asia/Shanghai', new Date('2026-12-31T16:00:00Z'))).toBe('2027-01');
  });

  it('月份补零', () => {
    expect(currentPeriodKey('UTC', new Date('2026-01-15T00:00:00Z'))).toBe('2026-01');
  });

  it('时区名非法时退回 UTC 而不是抛错', () => {
    expect(currentPeriodKey('Not/AZone', new Date('2026-08-31T17:00:00Z'))).toBe('2026-08');
  });

  it('默认时区是 Asia/Shanghai', () => {
    expect(DEFAULT_USAGE_TIMEZONE).toBe('Asia/Shanghai');
  });
});

describe('evaluateQuota', () => {
  const now = new Date('2026-09-15T00:00:00Z');
  const currentKey = currentPeriodKey('Asia/Shanghai', now); // 2026-09

  it('未配置配额 → 不限量、不拦截', () => {
    const state = evaluateQuota(provider({ monthlyQuotaStandardMinutes: null }), undefined, now);
    expect(state.unlimited).toBe(true);
    expect(state.enforced).toBe(false);
    expect(state.exceeded).toBe(false);
  });

  it('配了配额但未开启强制 → 不拦截', () => {
    const state = evaluateQuota(
      provider({
        monthlyQuotaStandardMinutes: 1000,
        quotaEnforced: 0,
        estimatedUsageStandardMinutes: 99999,
        usagePeriodKey: currentKey,
      }),
      undefined,
      now,
    );
    expect(state.enforced).toBe(false);
    expect(state.exceeded).toBe(false);
  });

  it('已用低于配额 → 不拦截', () => {
    const state = evaluateQuota(
      provider({
        monthlyQuotaStandardMinutes: 1000,
        quotaEnforced: 1,
        estimatedUsageStandardMinutes: 999,
        usagePeriodKey: currentKey,
      }),
      undefined,
      now,
    );
    expect(state.usedMinutes).toBe(999);
    expect(state.exceeded).toBe(false);
  });

  it('已用恰好等于配额 → 拦截（达到即停止分配新会话）', () => {
    const state = evaluateQuota(
      provider({
        monthlyQuotaStandardMinutes: 1000,
        quotaEnforced: 1,
        estimatedUsageStandardMinutes: 1000,
        usagePeriodKey: currentKey,
      }),
      undefined,
      now,
    );
    expect(state.exceeded).toBe(true);
  });

  it('已用超过配额 → 拦截', () => {
    const state = evaluateQuota(
      provider({
        monthlyQuotaStandardMinutes: 1000,
        quotaEnforced: 1,
        estimatedUsageStandardMinutes: 1500,
        usagePeriodKey: currentKey,
      }),
      undefined,
      now,
    );
    expect(state.exceeded).toBe(true);
  });

  it('估算值属于上一周期时按 0 处理（否则跑满过的 Provider 会永久被拦截）', () => {
    const state = evaluateQuota(
      provider({
        monthlyQuotaStandardMinutes: 1000,
        quotaEnforced: 1,
        estimatedUsageStandardMinutes: 5000,
        usagePeriodKey: '2026-08',
      }),
      undefined,
      now,
    );
    expect(state.estimateIsCurrent).toBe(false);
    expect(state.usedMinutes).toBe(0);
    expect(state.exceeded).toBe(false);
  });

  it('周期键为空（从未汇总过）时按 0 处理', () => {
    const state = evaluateQuota(
      provider({
        monthlyQuotaStandardMinutes: 1000,
        quotaEnforced: 1,
        estimatedUsageStandardMinutes: 5000,
        usagePeriodKey: '',
      }),
      undefined,
      now,
    );
    expect(state.estimateIsCurrent).toBe(false);
    expect(state.usedMinutes).toBe(0);
    expect(state.exceeded).toBe(false);
  });

  it('周期键匹配时采用估算值', () => {
    const state = evaluateQuota(
      provider({
        monthlyQuotaStandardMinutes: 1000,
        quotaEnforced: 1,
        estimatedUsageStandardMinutes: 250,
        usagePeriodKey: currentKey,
      }),
      undefined,
      now,
    );
    expect(state.estimateIsCurrent).toBe(true);
    expect(state.usedMinutes).toBe(250);
  });

  it('自定义时区生效', () => {
    // UTC 9/30 17:00 == 上海 10/1 01:00，但在 UTC 下仍是 9 月
    const at = new Date('2026-09-30T17:00:00Z');
    const p = provider({
      monthlyQuotaStandardMinutes: 1000,
      quotaEnforced: 1,
      estimatedUsageStandardMinutes: 2000,
      usagePeriodKey: '2026-09',
    });

    // 上海视角：已经是 10 月，9 月的估算值过期 → 不拦截
    expect(evaluateQuota(p, 'Asia/Shanghai', at).exceeded).toBe(false);
    // UTC 视角：仍是 9 月，估算值有效 → 拦截
    expect(evaluateQuota(p, 'UTC', at).exceeded).toBe(true);
  });
});
