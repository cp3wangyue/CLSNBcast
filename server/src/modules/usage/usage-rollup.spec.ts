import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService, ServerSession } from '../database/database.service';
import { QualityConfigService } from '../quality/quality-config.service';
import { UsageLedgerService } from './usage-ledger.service';
import { UsageRollupScheduler, previousPeriodKey } from './usage-rollup.scheduler';
import { currentPeriodKey } from './usage-period';

const SERVER_ID = 'guild-1';
const PROVIDER_A = 'provider-a';

const MS = 1000;

describe('previousPeriodKey', () => {
  it('同一年内退一格', () => {
    expect(previousPeriodKey('UTC', new Date('2026-09-15T00:00:00Z'))).toBe('2026-08');
  });

  it('1 月退到上一年的 12 月', () => {
    expect(previousPeriodKey('UTC', new Date('2026-01-15T00:00:00Z'))).toBe('2025-12');
  });

  it('月份补零', () => {
    expect(previousPeriodKey('UTC', new Date('2026-10-01T00:00:00Z'))).toBe('2026-09');
  });

  it('与 currentPeriodKey 相邻', () => {
    const now = new Date('2026-07-04T12:00:00Z');
    const tz = 'Asia/Shanghai';
    expect(previousPeriodKey(tz, now)).not.toBe(currentPeriodKey(tz, now));
  });
});

describe('UsageRollupScheduler', () => {
  let dir: string;
  let db: DatabaseService;
  let qualityConfig: QualityConfigService;
  let ledger: UsageLedgerService;
  let scheduler: UsageRollupScheduler;

  function seedSession(id: string, providerId = PROVIDER_A): ServerSession {
    db.createSession({
      id, token: `tok-${id}`, channel: `cb_${id}`, serverId: SERVER_ID,
      sharerUserId: 'u1', sharerUsername: 'u', guildId: SERVER_ID, targetChannelId: 'c1',
      status: 'ended', viewerCount: 0, peakViewers: 0, totalViewerJoins: 0,
      viewerDurationMs: 0, quality: '1080p_2', cardMessageId: null, manualCreated: 0,
      createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1, lastHeartbeat: 1,
      graceStartedAt: null, graceReason: null, lastViewerAt: null,
      publisherClientId: null, lowLatency: 0, providerId, agoraAppId: 'app',
    });
    return db.getSessionById(id)!;
  }

  function seedProvider(id = PROVIDER_A, overrides: Record<string, unknown> = {}) {
    return db.createProvider({
      id,
      ownerType: 'space',
      ownerId: SERVER_ID,
      name: 'p',
      appId: 'a'.repeat(32),
      appCertificateEnc: 'v1:a:b:c',
      ...overrides,
    });
  }

  /** 造一段已关闭的区间，时长与档位可指定。 */
  function seedInterval(
    sessionId: string,
    role: 'publisher' | 'viewer',
    startedAt: number,
    durationMs: number,
    tier = 'Full HD 全高清',
    lowLatency = false,
    providerId = PROVIDER_A,
  ) {
    ledger.openInterval({
      sessionId, providerId, serverId: SERVER_ID, role, actorId: 'actor-1',
      tier, lowLatency, startedAt,
    });
    ledger.closeInterval({
      sessionId, role, actorId: 'actor-1',
      endedAt: startedAt + durationMs, reason: 'session_end',
    });
  }

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    dir = mkdtempSync(join(tmpdir(), 'clsnbcast-rollup-'));
    process.env.DATA_DIR = dir;
    db = new DatabaseService();
    qualityConfig = new QualityConfigService(db);
    qualityConfig.onModuleInit();
    ledger = new UsageLedgerService(db, qualityConfig);
    scheduler = new UsageRollupScheduler(db, ledger, qualityConfig);
    seedProvider();
  });

  afterEach(() => {
    db.onModuleDestroy();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('定时任务把账本汇总写进 provider_usage_monthly', () => {
    seedSession('s1');
    const startedAt = Date.now() - 60 * MS;
    seedInterval('s1', 'viewer', startedAt, 60 * MS);

    scheduler.runOnce();

    const periodKey = ledger.resolvePeriodKey();
    const rollup = db.getProviderUsageMonthly(PROVIDER_A, periodKey);
    expect(rollup).toBeDefined();
    expect(rollup!.standardMinutes).toBeCloseTo(4.5, 6); // 1 分钟 × 4.5
  });

  it('同时重算上一个周期（跨月会话在次月初结算完也能补上）', () => {
    seedSession('s2');
    // 造一段"上上个月"的用量，再手工写进上个月的周期键
    const periodKey = previousPeriodKey(qualityConfig.getUsageTimezone());
    const startedAt = Date.now() - 10 * 60 * MS;
    seedInterval('s2', 'viewer', startedAt, 60 * MS);
    // 把区间挪到上一周期
    const raw = db as any;
    raw.db
      .prepare('UPDATE usage_intervals SET period_key = ? WHERE session_id = ?')
      .run(periodKey, 's2');

    scheduler.runOnce();

    expect(db.getProviderUsageMonthly(PROVIDER_A, periodKey)).toBeDefined();
  });

  it('🔒 汇总失败只记 error，不抛错（不能因为统计问题打断定时任务）', () => {
    vi.spyOn(ledger, 'rebuildMonthlyRollup').mockImplementation(() => {
      throw new Error('boom');
    });
    const errorSpy = vi.spyOn(Logger.prototype, 'error');

    expect(() => scheduler.runOnce()).not.toThrow();
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('usage rollup failed'))).toBe(true);
  });

  it('没有用量时不会产生汇总行（避免一堆 0 行污染看板）', () => {
    scheduler.runOnce();
    expect(db.listProviderUsageMonthly(ledger.resolvePeriodKey())).toEqual([]);
  });
});

describe('getUsageDashboard', () => {
  let dir: string;
  let db: DatabaseService;
  let qualityConfig: QualityConfigService;
  let ledger: UsageLedgerService;

  function seedProviders() {
    db.createProvider({
      id: 'p-unlimited', ownerType: 'platform', name: '不限量池',
      appId: 'a'.repeat(32), appCertificateEnc: 'v1:a:b:c',
    });
    db.createProvider({
      id: 'p-quota', ownerType: 'space', ownerId: SERVER_ID, name: '有限池',
      appId: 'a'.repeat(32), appCertificateEnc: 'v1:a:b:c',
      monthlyQuotaStandardMinutes: 100, quotaEnforced: true,
    });
  }

  function seedInterval(sessionId: string, startedAt: number, durationMs: number, providerId: string) {
    ledger.openInterval({
      sessionId, providerId, serverId: SERVER_ID, role: 'viewer', actorId: 'v1',
      tier: 'Full HD 全高清', lowLatency: false, startedAt,
    });
    ledger.closeInterval({
      sessionId, role: 'viewer', actorId: 'v1',
      endedAt: startedAt + durationMs, reason: 'session_end',
    });
  }

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    dir = mkdtempSync(join(tmpdir(), 'clsnbcast-dashboard-'));
    process.env.DATA_DIR = dir;
    db = new DatabaseService();
    qualityConfig = new QualityConfigService(db);
    qualityConfig.onModuleInit();
    ledger = new UsageLedgerService(db, qualityConfig);
    seedProviders();
  });

  afterEach(() => {
    db.onModuleDestroy();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  function session(id: string, providerId: string) {
    db.createSession({
      id, token: `tok-${id}`, channel: `cb_${id}`, serverId: SERVER_ID,
      sharerUserId: 'u1', sharerUsername: 'u', guildId: SERVER_ID, targetChannelId: 'c1',
      status: 'ended', viewerCount: 0, peakViewers: 0, totalViewerJoins: 0,
      viewerDurationMs: 0, quality: '1080p_2', cardMessageId: null, manualCreated: 0,
      createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1, lastHeartbeat: 1,
      graceStartedAt: null, graceReason: null, lastViewerAt: null,
      publisherClientId: null, lowLatency: 0, providerId, agoraAppId: 'a'.repeat(32),
    });
  }

  it('每个 Provider 一行，未产生用量的按 0 展示', () => {
    const rows = ledger.getUsageDashboard();

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.providerId).sort()).toEqual(['p-quota', 'p-unlimited']);
    expect(rows.every((r) => r.standardMinutes === 0)).toBe(true);
  });

  it('汇总后反映用量与会话数', () => {
    session('s1', 'p-quota');
    const startedAt = Date.now() - 60 * 60 * MS;
    seedInterval('s1', startedAt, 60 * 60 * MS, 'p-quota'); // 1 小时 × 4.5 = 270 标准分钟

    ledger.rebuildMonthlyRollup(ledger.resolvePeriodKey());
    const rows = ledger.getUsageDashboard();
    const quota = rows.find((r) => r.providerId === 'p-quota')!;

    expect(quota.standardMinutes).toBeCloseTo(270, 4);
    expect(quota.viewerMinutes).toBeCloseTo(60, 4);
    expect(quota.sessionCount).toBe(1);
  });

  it('未开启强制的配额：quotaUsageRatio 为 null（不画假的 0% 进度）', () => {
    const unlimited = ledger.getUsageDashboard().find((r) => r.providerId === 'p-unlimited')!;
    expect(unlimited.quotaMinutes).toBeNull();
    expect(unlimited.quotaUsageRatio).toBeNull();
    expect(unlimited.quotaExceeded).toBe(false);
  });

  it('✅ 达到配额后标记 exceeded，且 ratio >= 1', () => {
    session('s2', 'p-quota');
    // 30 小时 × 4.5 = 8100 标准分钟，远超 100 的配额
    const startedAt = Date.now() - 30 * 60 * 60 * MS;
    seedInterval('s2', startedAt, 30 * 60 * 60 * MS, 'p-quota');

    ledger.rebuildMonthlyRollup(ledger.resolvePeriodKey());
    const quota = ledger.getUsageDashboard().find((r) => r.providerId === 'p-quota')!;

    expect(quota.quotaExceeded).toBe(true);
    expect(quota.quotaUsageRatio).toBeGreaterThanOrEqual(1);
  });

  it('未达配额时 exceeded 为 false', () => {
    session('s3', 'p-quota');
    const startedAt = Date.now() - 10 * 60 * MS;
    seedInterval('s3', startedAt, 10 * 60 * MS, 'p-quota'); // 10min × 4.5 = 45 标准分钟

    ledger.rebuildMonthlyRollup(ledger.resolvePeriodKey());
    const quota = ledger.getUsageDashboard().find((r) => r.providerId === 'p-quota')!;

    expect(quota.quotaExceeded).toBe(false);
    expect(quota.quotaUsageRatio).toBeLessThan(1);
  });

  it('可以查询指定周期', () => {
    const rows = ledger.getUsageDashboard('2020-01');
    expect(rows.every((r) => r.periodKey === '2020-01')).toBe(true);
  });

  it('getSessionUsage 返回区间与事件明细（看板下钻）', () => {
    session('s4', 'p-quota');
    const startedAt = Date.now() - 60 * MS;
    seedInterval('s4', startedAt, 60 * MS, 'p-quota');

    const detail = ledger.getSessionUsage('s4');

    expect(detail.intervals.length).toBeGreaterThan(0);
    expect(detail.events.length).toBeGreaterThan(0);
  });
});
