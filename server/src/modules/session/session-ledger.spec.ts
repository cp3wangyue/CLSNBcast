import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { AgoraProviderService } from '../agora/agora-provider.service';
import { AgoraService } from '../agora/agora.service';
import { EventBusService } from '../events/events.service';
import { UsageLedgerService } from '../usage/usage-ledger.service';
import { QualityConfigService } from '../quality/quality-config.service';
import { SessionService } from './session.service';
import { ShareSession } from './session.types';

const SERVER_ID = 'guild-1';
const APP_ID = '0123456789abcdef0123456789abcdef';
const CERT = 'fedcba9876543210fedcba9876543210';
const SHARER = 'sharer-1';

/**
 * Phase 2-2：会话生命周期 → 用量账本的接线。
 *
 * 这里驱动**真实的 SessionService**，断言账本区间与既有计费状态机完全同步。
 * 重点是那些容易出错的地方：checkpoint 不能切区间、GRACE 不能重复开主播区间、
 * 等待开始共享期间加入的观众不计费。
 */
describe('SessionService × UsageLedger（2-2 接线）', () => {
  let dir: string;
  let db: DatabaseService;
  let providers: AgoraProviderService;
  let ledger: UsageLedgerService;
  let qualityConfig: QualityConfigService;
  let sessions: SessionService;

  function seedServer() {
    db.createServer(SERVER_ID, '测试服务器', 'owner-1', '服主');
    db.updateServer(SERVER_ID, { bound: 1, status: 'active', triggerWords: '屏幕共享' });
    providers.create({
      ownerType: 'space', ownerId: SERVER_ID, name: 'p', appId: APP_ID, appCertificate: CERT,
    });
  }

  /** 建一个会话但**不**开始共享（PENDING）。 */
  function createPendingSession(): ShareSession {
    return sessions.createSession({
      sharerUserId: SHARER,
      sharerUsername: '分享者',
      guildId: SERVER_ID,
      targetChannelId: 'chan-1',
      serverId: SERVER_ID,
    });
  }

  /** 建会话并开始共享（ACTIVE）。 */
  function createActiveSession(clientId = 'client-1', lowLatency = false): ShareSession {
    const session = createPendingSession();
    sessions.startSharing(session.token, clientId, lowLatency);
    return sessions.getByToken(session.token)!;
  }

  function intervals(sessionId: string) {
    return ledger.listSessionIntervals(sessionId);
  }

  function openViewerCount(sessionId: string): number {
    return intervals(sessionId).filter((i) => i.endedAt === null).length;
  }

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    dir = mkdtempSync(join(tmpdir(), 'clsnbcast-session-ledger-'));
    process.env.DATA_DIR = dir;
    process.env.SECRET_ENCRYPTION_KEY = 'a'.repeat(64);

    db = new DatabaseService();
    providers = new AgoraProviderService(db, new SecretCryptoService());
    const agora = new AgoraService(db, providers);
    const bus = new EventBusService();
    qualityConfig = new QualityConfigService(db);
    qualityConfig.onModuleInit();
    ledger = new UsageLedgerService(db, qualityConfig);
    sessions = new SessionService(db, agora, providers, bus, ledger, qualityConfig);

    seedServer();
  });

  afterEach(() => {
    db.onModuleDestroy();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.SECRET_ENCRYPTION_KEY;
  });

  // ===== 主播 =====

  describe('主播区间', () => {
    it('开始共享时开启主播区间，档位与 Provider 来自会话', () => {
      const session = createActiveSession();

      const publisher = intervals(session.id).filter((i) => i.role === 'publisher');
      expect(publisher).toHaveLength(1);
      expect(publisher[0].actorId).toBe(SHARER);
      expect(publisher[0].providerId).toBe(session.providerId);
      expect(publisher[0].serverId).toBe(SERVER_ID);
      expect(publisher[0].tier).toBe('Full HD 全高清'); // 默认 1080p_2
      expect(publisher[0].coefficient).toBe(1); // 主播按音频
      expect(publisher[0].endedAt).toBeNull();
    });

    it('PENDING 阶段没有主播区间（还没开始推流）', () => {
      const session = createPendingSession();
      expect(intervals(session.id)).toHaveLength(0);
    });

    it('会话结束时关闭，且时长含 GRACE 空档（保持既有口径）', () => {
      const session = createActiveSession();
      const startedAt = intervals(session.id)[0].startedAt;

      // 停止共享 → 进入 GRACE（主播区间不关）
      sessions.stopSharing(session.token);
      expect(intervals(session.id).filter((i) => i.role === 'publisher')[0].endedAt).toBeNull();

      // 会话结束 → 主播区间关闭
      sessions.endSession(session.id, 'manual');
      const publisher = intervals(session.id).find((i) => i.role === 'publisher')!;
      expect(publisher.endedAt).not.toBeNull();
      expect(publisher.closedReason).toBe('session_end');
      // 时长 = 结束 - 开始，中间没有因为 GRACE 被截断
      expect(publisher.durationMs).toBe(publisher.endedAt! - startedAt);
    });

    it('GRACE 恢复不会切出第二个主播区间', () => {
      const session = createActiveSession();
      sessions.stopSharing(session.token);
      sessions.heartbeat(session.token); // GRACE(stopped) 不会因心跳恢复，再显式恢复一次
      sessions.startSharing(session.token, 'client-1', false);

      expect(intervals(session.id).filter((i) => i.role === 'publisher')).toHaveLength(1);
    });
  });

  // ===== 观众 =====

  describe('观众区间', () => {
    it('ACTIVE 期间加入即开始计费', () => {
      const session = createActiveSession();
      sessions.viewerConnected(session.id, 'viewer-1');

      const viewers = intervals(session.id).filter((i) => i.role === 'viewer');
      expect(viewers).toHaveLength(1);
      expect(viewers[0].actorId).toBe('viewer-1');
      expect(viewers[0].endedAt).toBeNull();
      expect(viewers[0].tier).toBe('Full HD 全高清');
      expect(viewers[0].coefficient).toBe(4.5); // 极速直播 Full HD（修正后的官方值）
    });

    it('PENDING 期间加入**不**计费', () => {
      const session = createPendingSession();
      sessions.viewerConnected(session.id, 'viewer-1');

      expect(intervals(session.id).filter((i) => i.role === 'viewer')).toHaveLength(0);
    });

    it('PENDING 加入的观众在开始共享后才开始计费', () => {
      const session = createPendingSession();
      sessions.viewerConnected(session.id, 'viewer-1');
      expect(intervals(session.id).filter((i) => i.role === 'viewer')).toHaveLength(0);

      sessions.startSharing(session.token, 'client-1', false);

      const viewers = intervals(session.id).filter((i) => i.role === 'viewer');
      expect(viewers).toHaveLength(1);
      expect(viewers[0].endedAt).toBeNull();
    });

    it('离开时关闭区间并标记 viewer_left', () => {
      const session = createActiveSession();
      sessions.viewerConnected(session.id, 'viewer-1');
      sessions.viewerDisconnected(session.id, 'viewer-1');

      const viewer = intervals(session.id).find((i) => i.role === 'viewer')!;
      expect(viewer.endedAt).not.toBeNull();
      expect(viewer.closedReason).toBe('viewer_left');
      expect(viewer.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('同一 viewerId 的并发连接只计一条区间', () => {
      const session = createActiveSession();
      sessions.viewerConnected(session.id, 'viewer-1');
      sessions.viewerConnected(session.id, 'viewer-1');
      sessions.viewerConnected(session.id, 'viewer-1');

      expect(intervals(session.id).filter((i) => i.role === 'viewer')).toHaveLength(1);

      // 只有最后一条连接断开才结算
      sessions.viewerDisconnected(session.id, 'viewer-1');
      expect(intervals(session.id).find((i) => i.role === 'viewer')!.endedAt).toBeNull();
      sessions.viewerDisconnected(session.id, 'viewer-1');
      sessions.viewerDisconnected(session.id, 'viewer-1');
      expect(intervals(session.id).find((i) => i.role === 'viewer')!.endedAt).not.toBeNull();
    });

    it('多个观众各自一条区间', () => {
      const session = createActiveSession();
      sessions.viewerConnected(session.id, 'viewer-1');
      sessions.viewerConnected(session.id, 'viewer-2');
      sessions.viewerConnected(session.id, 'viewer-3');

      const viewers = intervals(session.id).filter((i) => i.role === 'viewer');
      expect(viewers).toHaveLength(3);
      expect(viewers.map((v) => v.actorId).sort()).toEqual(['viewer-1', 'viewer-2', 'viewer-3']);
    });
  });

  // ===== GRACE =====

  describe('GRACE 行为', () => {
    it('停止共享时关闭观众区间（grace），主播区间保持开着', () => {
      const session = createActiveSession();
      sessions.viewerConnected(session.id, 'viewer-1');
      sessions.viewerConnected(session.id, 'viewer-2');

      sessions.stopSharing(session.token);

      const all = intervals(session.id);
      const viewers = all.filter((i) => i.role === 'viewer');
      expect(viewers).toHaveLength(2);
      expect(viewers.every((v) => v.closedReason === 'grace')).toBe(true);
      expect(all.find((i) => i.role === 'publisher')!.endedAt).toBeNull();
    });

    it('恢复共享时观众重新开始计费，形成第二段区间', () => {
      const session = createActiveSession();
      sessions.viewerConnected(session.id, 'viewer-1');
      sessions.stopSharing(session.token);
      sessions.startSharing(session.token, 'client-1', false);

      const viewers = intervals(session.id).filter((i) => i.role === 'viewer');
      expect(viewers).toHaveLength(2);
      expect(viewers[0].closedReason).toBe('grace');
      expect(viewers[1].endedAt).toBeNull();
      // 两段区间分别带自己的起点，GRACE 空档不计入观众时长
      expect(viewers[1].startedAt).toBeGreaterThanOrEqual(viewers[0].endedAt!);
    });

    it('GRACE 期间的观众时长为两段区间之和，不含空档', () => {
      const session = createActiveSession();
      sessions.viewerConnected(session.id, 'viewer-1');
      sessions.stopSharing(session.token);
      sessions.startSharing(session.token, 'client-1', false);
      sessions.endSession(session.id, 'manual');

      const total = intervals(session.id)
        .filter((i) => i.role === 'viewer')
        .reduce((sum, i) => sum + (i.durationMs ?? 0), 0);
      expect(total).toBe(ledger.getViewerDurationMs(session.id));
    });
  });

  // ===== checkpoint 不能切区间（关键回归点）=====

  it('🔒 10 秒一次的 checkpoint 落盘不会切出多余区间', () => {
    const session = createActiveSession();
    sessions.viewerConnected(session.id, 'viewer-1');
    const before = intervals(session.id);

    for (let i = 0; i < 10; i++) {
      sessions.checkpointViewerDurations();
    }

    const after = intervals(session.id);
    expect(after).toHaveLength(before.length);
    // 区间本身没有被关闭或重开
    expect(after.find((i) => i.role === 'viewer')!.endedAt).toBeNull();
    expect(after.find((i) => i.role === 'viewer')!.startedAt).toBe(
      before.find((i) => i.role === 'viewer')!.startedAt,
    );
  });

  it('checkpoint 之后仍然会正常结算（区间没被 checkpoint 破坏）', () => {
    const session = createActiveSession();
    sessions.viewerConnected(session.id, 'viewer-1');
    sessions.checkpointViewerDurations();
    sessions.endSession(session.id, 'manual');

    const viewer = intervals(session.id).find((i) => i.role === 'viewer')!;
    expect(viewer.endedAt).not.toBeNull();
    expect(viewer.closedReason).toBe('session_end');
  });

  // ===== 会话结束 =====

  describe('会话结束', () => {
    it('一次性关闭主播与全部观众的区间', () => {
      const session = createActiveSession();
      sessions.viewerConnected(session.id, 'viewer-1');
      sessions.viewerConnected(session.id, 'viewer-2');

      sessions.endSession(session.id, 'manual');

      const all = intervals(session.id);
      expect(all).toHaveLength(3);
      expect(all.every((i) => i.endedAt !== null)).toBe(true);
      expect(all.every((i) => i.closedReason === 'session_end')).toBe(true);
      expect(openViewerCount(session.id)).toBe(0);
    });

    it('没有任何区间时结束会话不会报错', () => {
      const session = createPendingSession();
      expect(() => sessions.endSession(session.id, 'idle_timeout')).not.toThrow();
      expect(intervals(session.id)).toHaveLength(0);
    });
  });

  // ===== 与既有计费展示一致 =====

  it('账本的观众时长与 sessions.viewer_duration_ms 口径一致', () => {
    const session = createActiveSession();
    sessions.viewerConnected(session.id, 'viewer-1');
    sessions.viewerConnected(session.id, 'viewer-2');
    sessions.endSession(session.id, 'manual');

    const row = db.getSessionById(session.id)!;
    // 既有实现：ACTIVE 期间累计（测试里几乎瞬时，两者都应 >= 0 且口径一致）
    expect(row.viewerDurationMs).not.toBeNull();
    expect(ledger.getViewerDurationMs(session.id)).toBe(row.viewerDurationMs!);
  });

  it('账本写入失败不会打断会话流程（旁路保护）', () => {
    const session = createActiveSession();
    // 让账本抛错，模拟磁盘写失败
    vi.spyOn(ledger, 'openInterval').mockImplementation(() => {
      throw new Error('disk full');
    });
    const errorSpy = vi.spyOn(Logger.prototype, 'error');

    expect(() => sessions.viewerConnected(session.id, 'viewer-1')).not.toThrow();
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('usage ledger write failed'))).toBe(true);

    // 会话状态仍然正常推进
    expect(sessions.getById(session.id)!.viewerCount).toBe(1);
  });

  // ===== 计费展示切换到账本（2-3）=====

  describe('计费展示改由账本派生', () => {
    /** 造一段指定时长的观众观看区间（用显式时间戳，不依赖测试真实耗时）。 */
    function seedViewerInterval(
      session: ShareSession,
      durationMs: number,
      tier = 'Full HD 全高清',
      lowLatency = false,
    ) {
      const startedAt = Date.now() - durationMs;
      ledger.openInterval({
        sessionId: session.id,
        providerId: session.providerId,
        serverId: SERVER_ID,
        role: 'viewer',
        actorId: 'viewer-1',
        tier,
        lowLatency,
        startedAt,
      });
      ledger.closeInterval({
        sessionId: session.id,
        role: 'viewer',
        actorId: 'viewer-1',
        endedAt: startedAt + durationMs,
        reason: 'viewer_left',
      });
    }

    it('checkpoint 把账本派生的观众时长落盘', () => {
      const session = createActiveSession();
      sessions.viewerConnected(session.id, 'viewer-1');
      sessions.checkpointViewerDurations();

      const row = db.getSessionById(session.id)!;
      expect(row.viewerDurationMs).toBe(ledger.getViewerDurationMs(session.id));
    });

    it('🔒 历史会话（账本里没有区间但有落盘时长）使用落盘的时长', () => {
      const now = Date.now();
      // 直接造一条「账本启用之前」的会话：有落盘时长，但没有区间
      db.createSession({
        id: 'legacy-1', token: 'legacy-tok', channel: 'cb_legacy', serverId: SERVER_ID,
        sharerUserId: 'u1', sharerUsername: 'u', guildId: SERVER_ID, targetChannelId: 'c1',
        status: 'ended', viewerCount: 0, peakViewers: 2, totalViewerJoins: 2,
        viewerDurationMs: 123_456, quality: '1080p_2', cardMessageId: null, manualCreated: 0,
        createdAt: now - 600_000, startedAt: now - 600_000, endedAt: now,
        durationMs: 600_000, lastHeartbeat: now,
        graceStartedAt: null, graceReason: null, lastViewerAt: null,
        publisherClientId: null, lowLatency: 0, providerId: '', agoraAppId: '',
      });

      const info = sessions.toInfo(sessions.getById('legacy-1')!);

      expect(info.viewerDurationMs).toBe(123_456);
      expect(info.standardMinutes).toBeGreaterThan(0);
    });

    it('🔒 无区间的历史会话走旧估算口径（不误用账本的空结果）', () => {
      const now = Date.now();
      db.createSession({
        id: 'ancient-1', token: 'ancient-tok', channel: 'cb_ancient', serverId: SERVER_ID,
        sharerUserId: 'u1', sharerUsername: 'u', guildId: SERVER_ID, targetChannelId: 'c1',
        status: 'ended', viewerCount: 0, peakViewers: 2, totalViewerJoins: 2,
        viewerDurationMs: 0, quality: '1080p_2', cardMessageId: null, manualCreated: 0,
        createdAt: now - 600_000, startedAt: now - 600_000, endedAt: now,
        durationMs: 600_000, lastHeartbeat: now,
        graceStartedAt: null, graceReason: null, lastViewerAt: null,
        publisherClientId: null, lowLatency: 0, providerId: '', agoraAppId: '',
      });

      const info = sessions.toInfo(sessions.getById('ancient-1')!);

      // 账本里没有区间 → 用旧口径（峰值人数 × 时长 × 当前档位系数）推算，而不是 0
      expect(info.viewerDurationMs).toBe(0);
      expect(info.standardMinutes).toBeGreaterThan(0);
      expect(info.billingDetail).toContain('主播分');
    });

    it('新会话的观众时长来自账本区间', () => {
      const session = createActiveSession();
      seedViewerInterval(session, 600_000); // 10 分钟
      sessions.endSession(session.id, 'manual');

      const info = sessions.toInfo(sessions.getById(session.id)!);
      expect(info.viewerDurationMs).toBe(600_000);
      expect(info.billingDetail).not.toContain('旧记录估算');
    });

    it('🔑 单价来自可配置项：改单价后 estimatedCost 跟着变', () => {
      const session = createEndedSessionWithViewing(3_600_000); // 1 小时观看

      const before = sessions.toInfo(session);
      expect(before.standardMinutes).toBeGreaterThan(200);

      qualityConfig.update({ standardMinutePrice: 0.014 });
      const after = sessions.toInfo(session);

      // 标准时长不变，费用约翻倍（标准时长向上取整，因此只能近似比较）
      expect(after.standardMinutes).toBe(before.standardMinutes);
      expect(after.estimatedCost / before.estimatedCost).toBeCloseTo(2, 1);
    });

    it('🔒 改折算系数不会改写**已结算**的区间（快照语义）', () => {
      const session = createEndedSessionWithViewing(3_600_000); // 1 小时 × 系数 4.5
      const before = sessions.toInfo(session);

      // 把极速直播 Full HD 系数从 4.5 降到 1
      qualityConfig.update({
        tierRules: qualityConfig.get().tierRules.map((rule) =>
          rule.tier === 'Full HD 全高清' ? { ...rule, ultraLowLatency: 1 } : rule,
        ),
      });

      const after = sessions.toInfo(session);
      // 已结算的区间保持原样 —— 否则历史账单会被事后改写
      expect(after.standardMinutes).toBe(before.standardMinutes);
      expect(after.estimatedCost).toBe(before.estimatedCost);

      // 但**新开的**区间会用新系数
      const fresh = createEndedSessionWithViewing(3_600_000, 'client-2');
      const freshInfo = sessions.toInfo(fresh);

      expect(freshInfo.standardMinutes).toBeLessThan(before.standardMinutes);
    });

    /**
     * 造一个**已结束**且有明确观看时长的会话，全部时间戳显式指定。
     *
     * 不能依赖真实耗时：`standardMinutes` 由 `durationMs`(endedAt - startedAt) 开门，
     * 测试跑得太快时它会是 0，导致断言随机失败。
     */
    function createEndedSessionWithViewing(
      viewerMs: number,
      clientId = 'client-1',
      tier = 'Full HD 全高清',
      lowLatency = false,
    ): ShareSession {
      const now = Date.now();
      const startedAt = now - viewerMs;
      const session = createActiveSession(clientId, lowLatency);

      // 用显式时间戳覆盖：会话时间窗 == 观众观看时长
      db.updateSession(session.id, { startedAt });
      seedViewerInterval(session, viewerMs, tier, lowLatency);

      const updated = sessions.getById(session.id)!;
      sessions.endSession(session.id, 'manual');
      return sessions.getById(updated.id)!;
    }

    /**
     * 端到端账目校验：主播与观众的贡献之和应等于手算结果。
     *
     * 注意 `startedAt` 必须在 `startSharing` **之前**写定 ——
     * 主播区间用的是 `session.startedAt`，事后才改它不会回溯修改已开的区间
     * （这是快照语义的一部分，不是缺陷）。
     */
    it('✅ 端到端账目：1 小时 Full HD 极速直播 = 主播 60 + 观众 270 标准分钟', () => {
      const HOUR = 3_600_000;
      const startedAt = Date.now() - HOUR;

      const session = createPendingSession();
      db.updateSession(session.id, { startedAt });
      sessions.startSharing(session.token, 'client-1', false);

      // 观众看满 1 小时
      ledger.openInterval({
        sessionId: session.id,
        providerId: session.providerId,
        serverId: SERVER_ID,
        role: 'viewer',
        actorId: 'v1',
        tier: 'Full HD 全高清',
        lowLatency: false,
        startedAt,
      });
      ledger.closeInterval({
        sessionId: session.id, role: 'viewer', actorId: 'v1',
        endedAt: startedAt + HOUR, reason: 'viewer_left',
      });
      sessions.endSession(session.id, 'manual');

      const info = sessions.toInfo(sessions.getById(session.id)!);

      // 主播 60min × 系数 1 = 60；观众 60min × 系数 4.5 = 270 → 合计 330
      expect(info.standardMinutes).toBeGreaterThanOrEqual(330);
      expect(info.standardMinutes).toBeLessThanOrEqual(331);
      expect(info.billingDetail).toContain('系数4.5');
      expect(info.billingDetail).not.toContain('4.57');
    });

    it('✅ 账单明细显示修正后的 4.5，而不是上游的 4.57', () => {
      const session = createActiveSession();
      seedViewerInterval(session, 600_000);
      sessions.endSession(session.id, 'manual');

      const info = sessions.toInfo(sessions.getById(session.id)!);

      expect(info.billingDetail).toContain('系数4.5');
      expect(info.billingDetail).not.toContain('4.57');
    });

    it('低延迟模式在账单明细里标注为互动直播', () => {
      // 低延迟模式是**会话级**设置，因此会话与区间必须用同一个模式
      const session = createActiveSession('client-1', true);
      seedViewerInterval(session, 600_000, 'Full HD 全高清', true);
      sessions.endSession(session.id, 'manual');

      const info = sessions.toInfo(sessions.getById(session.id)!);
      expect(info.billingDetail).toContain('互动直播');
      expect(info.billingDetail).toContain('系数9');
    });

    it('🔑 标准时长取自区间快照的系数，而不是用当前档位重算', () => {
      const session = createActiveSession();
      seedViewerInterval(session, 3_600_000, 'HD 高清', false); // 1 小时 × 系数 2
      sessions.endSession(session.id, 'manual');

      const info = sessions.toInfo(sessions.getById(session.id)!);
      // 观众部分 = 60 分钟 × 2 = 120 标准分钟
      expect(info.standardMinutes).toBeGreaterThanOrEqual(120);

      // 即便把会话档位改成 Full HD（系数 4.5），已结算的区间也不会被重算
      db.updateSession(session.id, { quality: '1080p_2' });
      const after = sessions.toInfo(sessions.getById(session.id)!);
      expect(after.standardMinutes).toBe(info.standardMinutes);
    });
  });
});
