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
  function createActiveSession(clientId = 'client-1'): ShareSession {
    const session = createPendingSession();
    sessions.startSharing(session.token, clientId, false);
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
    ledger = new UsageLedgerService(db);
    sessions = new SessionService(db, agora, providers, bus, ledger);

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
      expect(viewers[0].coefficient).toBe(4.57); // 极速直播 Full HD
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
});
