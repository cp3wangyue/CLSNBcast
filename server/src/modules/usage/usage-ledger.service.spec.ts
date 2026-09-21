import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService, ServerSession } from '../database/database.service';
import { UsageLedgerService } from './usage-ledger.service';
import { currentPeriodKey } from './usage-period';

const PROVIDER_ID = 'provider-1';
const SERVER_ID = 'guild-1';
const SESSION_ID = 'session-1';

const MS_PER_MINUTE = 60_000;

describe('UsageLedgerService', () => {
  let dir: string;
  let db: DatabaseService;
  let ledger: UsageLedgerService;

  function seedSession(overrides: Partial<ServerSession> = {}) {
    db.createSession({
      id: SESSION_ID,
      token: 'tok-1',
      channel: 'cb_1',
      serverId: SERVER_ID,
      sharerUserId: 'sharer-1',
      sharerUsername: '分享者',
      guildId: SERVER_ID,
      targetChannelId: 'chan-1',
      status: 'active',
      viewerCount: 0,
      peakViewers: 0,
      totalViewerJoins: 0,
      viewerDurationMs: 0,
      quality: '1080p_2',
      cardMessageId: null,
      manualCreated: 0,
      createdAt: 1000,
      startedAt: 1000,
      endedAt: null,
      durationMs: null,
      lastHeartbeat: 1000,
      graceStartedAt: null,
      graceReason: null,
      lastViewerAt: null,
      publisherClientId: null,
      lowLatency: 0,
      providerId: PROVIDER_ID,
      agoraAppId: 'app-id',
      ...overrides,
    });
  }

  function seedProvider() {
    return db.createProvider({
      id: PROVIDER_ID,
      ownerType: 'space',
      ownerId: SERVER_ID,
      name: '测试 Provider',
      appId: 'app-id',
      appCertificateEnc: 'v1:a:b:c',
    });
  }

  function openViewer(actorId: string, startedAt: number, tier = 'Full HD 全高清', lowLatency = false) {
    return ledger.openInterval({
      sessionId: SESSION_ID,
      providerId: PROVIDER_ID,
      serverId: SERVER_ID,
      role: 'viewer',
      actorId,
      tier,
      lowLatency,
      startedAt,
    });
  }

  function openPublisher(startedAt: number, tier = 'Full HD 全高清', lowLatency = false) {
    return ledger.openInterval({
      sessionId: SESSION_ID,
      providerId: PROVIDER_ID,
      serverId: SERVER_ID,
      role: 'publisher',
      actorId: 'sharer-1',
      tier,
      lowLatency,
      startedAt,
    });
  }

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    dir = mkdtempSync(join(tmpdir(), 'clsnbcast-ledger-'));
    process.env.DATA_DIR = dir;
    db = new DatabaseService();
    ledger = new UsageLedgerService(db);
    seedSession();
  });

  afterEach(() => {
    db.onModuleDestroy();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  // ===== 开启区间 =====

  describe('openInterval', () => {
    it('写入区间并快照档位、计费模型、系数与周期键', () => {
      const id = openViewer('viewer-1', 10_000)!;

      const [interval] = ledger.listSessionIntervals(SESSION_ID);
      expect(interval.id).toBe(id);
      expect(interval.role).toBe('viewer');
      expect(interval.actorId).toBe('viewer-1');
      expect(interval.tier).toBe('Full HD 全高清');
      expect(interval.billingModel).toBe('ultra_low_latency');
      expect(interval.coefficient).toBe(4.57);
      expect(interval.startedAt).toBe(10_000);
      expect(interval.endedAt).toBeNull();
      expect(interval.durationMs).toBeNull();
      expect(interval.periodKey).toBe(currentPeriodKey(undefined, new Date(10_000)));
    });

    it('主播区间用互动直播 + 音频系数，且与档位无关', () => {
      openPublisher(10_000, '4K 超高清');
      const [interval] = ledger.listSessionIntervals(SESSION_ID);
      expect(interval.billingModel).toBe('interactive');
      expect(interval.coefficient).toBe(1);
    });

    it('低延迟模式的观众走互动直播系数', () => {
      openViewer('viewer-1', 10_000, 'Full HD 全高清', true);
      const [interval] = ledger.listSessionIntervals(SESSION_ID);
      expect(interval.billingModel).toBe('interactive');
      expect(interval.coefficient).toBe(9);
    });

    it('🔒 同一参与者重复开启被拒绝（否则会重复计费）', () => {
      expect(openViewer('viewer-1', 10_000)).toBeDefined();
      expect(openViewer('viewer-1', 20_000)).toBeUndefined();

      expect(ledger.listSessionIntervals(SESSION_ID)).toHaveLength(1);
    });

    it('不同参与者可以各自开启', () => {
      openViewer('viewer-1', 10_000);
      openViewer('viewer-2', 11_000);
      expect(ledger.listSessionIntervals(SESSION_ID)).toHaveLength(2);
    });

    it('观众与主播可以同时开启', () => {
      openPublisher(10_000);
      openViewer('viewer-1', 10_000);
      expect(ledger.listSessionIntervals(SESSION_ID)).toHaveLength(2);
    });

    it('记录一条 join 审计事件', () => {
      openViewer('viewer-1', 10_000);
      const events = db.listUsageEventsBySession(SESSION_ID);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('join');
      expect(events[0].actorId).toBe('viewer-1');
      expect(events[0].tier).toBe('Full HD 全高清');
    });

    it('记录视频参数（自由画质下用于事后复盘）', () => {
      ledger.openInterval({
        sessionId: SESSION_ID,
        providerId: PROVIDER_ID,
        role: 'viewer',
        actorId: 'viewer-1',
        tier: 'HD 高清',
        lowLatency: false,
        startedAt: 10_000,
        video: { width: 1600, height: 900, frameRate: 45, bitrateMax: 4500 },
      });

      const [interval] = ledger.listSessionIntervals(SESSION_ID);
      expect(interval.width).toBe(1600);
      expect(interval.height).toBe(900);
      expect(interval.frameRate).toBe(45);
      expect(interval.bitrateMax).toBe(4500);
    });
  });

  // ===== 关闭区间 =====

  describe('closeInterval', () => {
    it('结算时长与标准时长（duration × coefficient）', () => {
      openViewer('viewer-1', 10_000);
      expect(ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
        endedAt: 70_000, reason: 'viewer_left',
      })).toBe(1);

      const [interval] = ledger.listSessionIntervals(SESSION_ID);
      expect(interval.endedAt).toBe(70_000);
      expect(interval.durationMs).toBe(60_000);
      // 60s × 4.57 = 274.2s
      expect(interval.standardMs).toBeCloseTo(60_000 * 4.57, 6);
      expect(interval.closedReason).toBe('viewer_left');
    });

    it('重复关闭是无害的 no-op（不会重复结算）', () => {
      openViewer('viewer-1', 10_000);
      ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
        endedAt: 70_000, reason: 'viewer_left',
      });
      expect(ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
        endedAt: 99_000, reason: 'session_end',
      })).toBe(0);

      const [interval] = ledger.listSessionIntervals(SESSION_ID);
      expect(interval.endedAt).toBe(70_000);
      expect(interval.durationMs).toBe(60_000);
    });

    it('没有进行中的区间时返回 0', () => {
      expect(ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'nobody',
        endedAt: 70_000, reason: 'viewer_left',
      })).toBe(0);
    });

    it('结束时间早于开始时间时时长记 0，不产生负用量', () => {
      openViewer('viewer-1', 50_000);
      ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
        endedAt: 10_000, reason: 'viewer_left',
      });

      const [interval] = ledger.listSessionIntervals(SESSION_ID);
      expect(interval.durationMs).toBe(0);
      expect(interval.standardMs).toBe(0);
    });

    it('关闭后记录一条 leave 事件', () => {
      openViewer('viewer-1', 10_000);
      ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
        endedAt: 70_000, reason: 'viewer_left',
      });

      const types = db.listUsageEventsBySession(SESSION_ID).map((e) => e.eventType);
      expect(types).toEqual(['join', 'leave']);
    });

    it('档位切换：关旧区间 + 开新区间，各自保留自己的档位与系数', () => {
      openViewer('viewer-1', 10_000, 'HD 高清', false); // 系数 2
      ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
        endedAt: 40_000, reason: 'tier_change',
      });
      openViewer('viewer-1', 40_000, 'Full HD 全高清', false); // 系数 4.57

      const intervals = ledger.listSessionIntervals(SESSION_ID);
      expect(intervals).toHaveLength(2);
      expect(intervals[0].tier).toBe('HD 高清');
      expect(intervals[0].coefficient).toBe(2);
      expect(intervals[0].closedReason).toBe('tier_change');
      expect(intervals[1].tier).toBe('Full HD 全高清');
      expect(intervals[1].coefficient).toBe(4.57);
      expect(intervals[1].endedAt).toBeNull();
    });
  });

  // ===== 会话结束 =====

  describe('closeSessionIntervals', () => {
    it('一次关闭主播与全部观众的区间', () => {
      openPublisher(10_000);
      openViewer('viewer-1', 10_000);
      openViewer('viewer-2', 20_000);

      expect(ledger.closeSessionIntervals(SESSION_ID, 'session_end', 100_000)).toBe(3);
      expect(ledger.listSessionIntervals(SESSION_ID).every((i) => i.endedAt === 100_000)).toBe(true);
    });

    it('没有未关闭区间时返回 0', () => {
      expect(ledger.closeSessionIntervals(SESSION_ID, 'session_end', 100_000)).toBe(0);
    });

    it('主播区间覆盖 GRACE 空档：时长等于 endedAt - startedAt（保持既有口径）', () => {
      // 主播在 10s 开始共享，30s 停止（进入 GRACE），100s 会话结束。
      // 主播区间中途不关，因此时长含 GRACE —— 与既有 durationMs 一致。
      openPublisher(10_000);
      openViewer('viewer-1', 10_000);
      // 观众在 GRACE 时被关掉
      ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
        endedAt: 30_000, reason: 'grace',
      });
      ledger.closeSessionIntervals(SESSION_ID, 'session_end', 100_000);

      const intervals = ledger.listSessionIntervals(SESSION_ID);
      const publisher = intervals.find((i) => i.role === 'publisher')!;
      const viewer = intervals.find((i) => i.role === 'viewer')!;

      expect(publisher.durationMs).toBe(90_000); // 含 30s~100s 的 GRACE
      expect(viewer.durationMs).toBe(20_000); // 只算 ACTIVE
      expect(viewer.closedReason).toBe('grace');
    });
  });

  // ===== 观众时长派生 =====

  describe('getViewerDurationMs', () => {
    it('已关闭区间 + 进行中区间的实时部分', () => {
      openViewer('viewer-1', 10_000);
      ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
        endedAt: 40_000, reason: 'viewer_left',
      });
      openViewer('viewer-2', 50_000);

      // 已关闭 30s + viewer-2 进行中（now - 50_000）
      expect(ledger.getViewerDurationMs(SESSION_ID, 80_000)).toBe(30_000 + 30_000);
    });

    it('不含主播区间（主播时长另有口径）', () => {
      openPublisher(10_000);
      expect(ledger.getViewerDurationMs(SESSION_ID, 100_000)).toBe(0);
    });

    it('多个观众累计', () => {
      openViewer('viewer-1', 10_000);
      openViewer('viewer-2', 10_000);
      expect(ledger.getViewerDurationMs(SESSION_ID, 40_000)).toBe(30_000 * 2);
    });

    it('没有区间时返回 0', () => {
      expect(ledger.getViewerDurationMs(SESSION_ID, 100_000)).toBe(0);
    });
  });

  // ===== 崩溃恢复 =====

  describe('recoverDanglingIntervals', () => {
    it('用会话最后心跳作为结束时间（不把宕机时间算成用量）', () => {
      db.updateSession(SESSION_ID, { lastHeartbeat: 60_000 });
      openViewer('viewer-1', 10_000);

      expect(ledger.recoverDanglingIntervals(500_000)).toBe(1);

      const [interval] = ledger.listSessionIntervals(SESSION_ID);
      expect(interval.endedAt).toBe(60_000);
      expect(interval.durationMs).toBe(50_000);
      expect(interval.closedReason).toBe('crash_recovery');
    });

    it('心跳早于区间起点时时长记 0', () => {
      db.updateSession(SESSION_ID, { lastHeartbeat: 5_000 });
      openViewer('viewer-1', 10_000);

      ledger.recoverDanglingIntervals(500_000);

      const [interval] = ledger.listSessionIntervals(SESSION_ID);
      expect(interval.endedAt).toBe(10_000);
      expect(interval.durationMs).toBe(0);
    });

    it('心跳晚于「现在」时以现在为上限', () => {
      db.updateSession(SESSION_ID, { lastHeartbeat: 900_000 });
      openViewer('viewer-1', 10_000);

      ledger.recoverDanglingIntervals(500_000);

      const [interval] = ledger.listSessionIntervals(SESSION_ID);
      expect(interval.endedAt).toBe(500_000);
    });

    it('没有悬挂区间时返回 0 且不改动已关闭区间', () => {
      openViewer('viewer-1', 10_000);
      ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
        endedAt: 40_000, reason: 'viewer_left',
      });

      expect(ledger.recoverDanglingIntervals(500_000)).toBe(0);
      expect(ledger.listSessionIntervals(SESSION_ID)[0].endedAt).toBe(40_000);
    });

    it('会话已不存在时仍能收口（回退到区间起点）', () => {
      openViewer('viewer-1', 10_000);
      // 直接删掉会话，模拟「会话记录被清理但区间还在」
      const raw = db as any;
      raw.db.prepare('DELETE FROM sessions WHERE id = ?').run(SESSION_ID);

      expect(ledger.recoverDanglingIntervals(500_000)).toBe(1);
      expect(ledger.listSessionIntervals(SESSION_ID)[0].durationMs).toBe(0);
    });

    it('onModuleInit 会自动执行一次恢复', () => {
      db.updateSession(SESSION_ID, { lastHeartbeat: 60_000 });
      openViewer('viewer-1', 10_000);
      ledger.onModuleInit();
      expect(ledger.listSessionIntervals(SESSION_ID)[0].closedReason).toBe('crash_recovery');
    });
  });

  // ===== 月度汇总 =====

  describe('rebuildMonthlyRollup', () => {
    const periodKey = currentPeriodKey(undefined, new Date(10_000));

    beforeEach(() => {
      seedProvider();
    });

    it('把区间换算成分钟并写入汇总', () => {
      // 主播 60s × 系数 1 = 1 标准分钟
      openPublisher(0);
      ledger.closeInterval({
        sessionId: SESSION_ID, role: 'publisher', actorId: 'sharer-1',
        endedAt: MS_PER_MINUTE, reason: 'session_end',
      });
      // 观众 120s × 系数 4.57 = 9.14 标准分钟
      openViewer('viewer-1', 0);
      ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
        endedAt: 2 * MS_PER_MINUTE, reason: 'viewer_left',
      });

      const [rollup] = ledger.rebuildMonthlyRollup(periodKey);

      expect(rollup.providerId).toBe(PROVIDER_ID);
      expect(rollup.publisherMinutes).toBeCloseTo(1, 6);
      expect(rollup.viewerMinutes).toBeCloseTo(2, 6);
      expect(rollup.standardMinutes).toBeCloseTo(1 + 2 * 4.57, 6);
      expect(rollup.sessionCount).toBe(1);
    });

    it('sessionCount 取角色间最大值而不是相加（同一会话同时有主播与观众）', () => {
      openPublisher(0);
      openViewer('viewer-1', 0);
      ledger.closeSessionIntervals(SESSION_ID, 'session_end', 60_000);

      const [rollup] = ledger.rebuildMonthlyRollup(periodKey);
      expect(rollup.sessionCount).toBe(1);
    });

    it('把标准分钟数同步到 Provider 行，供配额判断读取', () => {
      openViewer('viewer-1', 0);
      ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
        endedAt: MS_PER_MINUTE, reason: 'viewer_left',
      });

      ledger.rebuildMonthlyRollup(periodKey);

      const provider = db.getProvider(PROVIDER_ID)!;
      expect(provider.usagePeriodKey).toBe(periodKey);
      expect(provider.estimatedUsageStandardMinutes).toBeCloseTo(4.57, 6);
      expect(ledger.getMonthlyStandardMinutes(PROVIDER_ID, periodKey)).toBeCloseTo(4.57, 6);
    });

    it('未关闭的区间不计入汇总（避免把进行中的用量提前结算）', () => {
      openViewer('viewer-1', 0);
      expect(ledger.rebuildMonthlyRollup(periodKey)).toEqual([]);
    });

    it('没有区间的周期返回空数组', () => {
      expect(ledger.rebuildMonthlyRollup('2000-01')).toEqual([]);
    });

    it('只汇总指定周期（跨月不会互相污染）', () => {
      openViewer('viewer-1', 0);
      ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
        endedAt: MS_PER_MINUTE, reason: 'viewer_left',
      });

      expect(ledger.rebuildMonthlyRollup(periodKey)).toHaveLength(1);
      expect(ledger.rebuildMonthlyRollup('2000-01')).toEqual([]);
    });

    it('重复汇算是幂等的（upsert 而不是累加）', () => {
      openViewer('viewer-1', 0);
      ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
        endedAt: MS_PER_MINUTE, reason: 'viewer_left',
      });

      ledger.rebuildMonthlyRollup(periodKey);
      const second = ledger.rebuildMonthlyRollup(periodKey);
      expect(second).toHaveLength(1);
      expect(second[0].standardMinutes).toBeCloseTo(4.57, 6);
    });

    it('周期键按配置时区归属（UTC 8/31 17:00 = 上海 9/1 → 9 月）', () => {
      // startedAt 落在 UTC 8/31 17:00
      const startedAt = Date.parse('2026-08-31T17:00:00Z');
      const shanghaiKey = currentPeriodKey('Asia/Shanghai', new Date(startedAt));
      const utcKey = currentPeriodKey('UTC', new Date(startedAt));
      expect(shanghaiKey).toBe('2026-09');
      expect(utcKey).toBe('2026-08');

      openViewer('viewer-1', startedAt);
      ledger.closeInterval({
        sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
        endedAt: startedAt + MS_PER_MINUTE, reason: 'viewer_left',
      });

      // 落库的周期键来自当前时区（默认 Asia/Shanghai）
      expect(ledger.listSessionIntervals(SESSION_ID)[0].periodKey).toBe(shanghaiKey);
      expect(ledger.rebuildMonthlyRollup(shanghaiKey)).toHaveLength(1);
      expect(ledger.rebuildMonthlyRollup(utcKey)).toEqual([]);
    });
  });

  // ===== 系数快照 =====

  it('🔒 系数是结算时快照：事后改档位不影响已结算区间', () => {
    openViewer('viewer-1', 0, 'HD 高清', false);
    ledger.closeInterval({
      sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-1',
      endedAt: MS_PER_MINUTE, reason: 'viewer_left',
    });
    const before = ledger.listSessionIntervals(SESSION_ID)[0];

    // 模拟「同档位后来的会话拿到不同系数」（Phase 2-3 可配系数后会真实发生）
    openViewer('viewer-2', 0, 'Full HD 全高清', false);
    ledger.closeInterval({
      sessionId: SESSION_ID, role: 'viewer', actorId: 'viewer-2',
      endedAt: MS_PER_MINUTE, reason: 'viewer_left',
    });

    const after = ledger.listSessionIntervals(SESSION_ID)[0];
    expect(after.coefficient).toBe(before.coefficient);
    expect(after.standardMs).toBe(before.standardMs);
    expect(after.tier).toBe('HD 高清');
  });
});
