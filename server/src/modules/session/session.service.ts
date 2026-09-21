import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomBytes, randomUUID } from 'crypto';
import { DatabaseService, ServerSession, UsageIntervalClosedReason } from '../database/database.service';
import { AgoraService } from '../agora/agora.service';
import { AgoraProviderService } from '../agora/agora-provider.service';
import { UsageLedgerService } from '../usage/usage-ledger.service';
import { QualityConfigService } from '../quality/quality-config.service';
import { EventBusService } from '../events/events.service';
import { SessionStatus, ShareSession, SessionInfo, getQualityInfo } from './session.types';
import { resolveBillingProfile } from '../usage/usage-billing';

/**
 * 会话创建时选不出可用的 Agora Provider。
 *
 * `message` 是面向用户的文案，调用方（KOOK 卡片 / 分享接口）应直接展示。
 */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

interface ViewerPresence {
  connections: number;
  /** 仅在会话 ACTIVE 时记录，用于排除等待和宽限期。 */
  billingStartedAt: number | null;
}

@Injectable()
export class SessionService implements OnModuleInit {
  private readonly logger = new Logger(SessionService.name);
  /** 内存中维护的 lastViewerAt，由 SSE 控制器在观众进出时更新。 */
  private lastViewerMap = new Map<string, number>(); // sessionId → timestamp
  /** 内存中维护的去重加入数，session 结束时持久化。 */
  private joinCountMap = new Map<string, number>(); // sessionId → count
  /** sessionId → viewerId → 连接引用计数和当前计费区间。 */
  private viewerPresenceMap = new Map<string, Map<string, ViewerPresence>>();
  /** 当前进程中已经计入 totalViewerJoins 的 viewerId。 */
  private viewerIdsMap = new Map<string, Set<string>>();

  constructor(
    private readonly db: DatabaseService,
    private readonly agora: AgoraService,
    private readonly providers: AgoraProviderService,
    private readonly bus: EventBusService,
    private readonly ledger: UsageLedgerService,
    private readonly qualityConfig: QualityConfigService,
  ) {}

  async onModuleInit() {
    this.logger.log('SessionService initialized (SQLite backend)');
  }

  /** Convert DB session to in-memory ShareSession format */
  private fromDb(row: ServerSession): ShareSession {
    return {
      id: row.id,
      token: row.token,
      channel: row.channel,
      sharerUserId: row.sharerUserId,
      sharerUsername: row.sharerUsername,
      guildId: row.guildId,
      targetChannelId: row.targetChannelId,
      status: row.status as SessionStatus,
      viewerCount: row.viewerCount,
      peakViewers: row.peakViewers,
      totalViewerJoins: row.totalViewerJoins,
      viewerDurationMs: row.viewerDurationMs,
      quality: row.quality,
      cardMessageId: row.cardMessageId || undefined,
      manualCreated: !!row.manualCreated,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMs: row.durationMs,
      lastHeartbeat: row.lastHeartbeat,
      graceStartedAt: row.graceStartedAt,
      graceReason: row.graceReason as any,
      lastViewerAt: row.lastViewerAt,
      publisherClientId: row.publisherClientId || undefined,
      lowLatency: !!row.lowLatency,
      providerId: row.providerId || '',
      agoraAppId: row.agoraAppId || '',
    };
  }

  private toDb(session: ShareSession, serverId: string): ServerSession {
    return {
      id: session.id,
      token: session.token,
      channel: session.channel,
      serverId,
      sharerUserId: session.sharerUserId,
      sharerUsername: session.sharerUsername,
      guildId: session.guildId,
      targetChannelId: session.targetChannelId,
      status: session.status,
      viewerCount: session.viewerCount,
      peakViewers: session.peakViewers,
      totalViewerJoins: session.totalViewerJoins,
      viewerDurationMs: session.viewerDurationMs,
      quality: session.quality,
      cardMessageId: session.cardMessageId || null,
      manualCreated: session.manualCreated ? 1 : 0,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationMs: session.durationMs,
      lastHeartbeat: session.lastHeartbeat,
      graceStartedAt: session.graceStartedAt,
      graceReason: session.graceReason || null,
      lastViewerAt: session.lastViewerAt,
      publisherClientId: session.publisherClientId || null,
      lowLatency: session.lowLatency ? 1 : 0,
      providerId: session.providerId || '',
      agoraAppId: session.agoraAppId || '',
    };
  }

  /** Get server config for a session's guild */
  private getServerSessionConfig(guildId: string) {
    const server = this.db.getServer(guildId);
    if (server) {
      return {
        idleTimeoutSec: server.idleTimeoutSec,
        heartbeatIntervalSec: server.heartbeatIntervalSec,
        noViewerTimeoutSec: server.noViewerTimeoutSec,
      };
    }
    // Fallback: hardcoded defaults (server should always exist)
    return { idleTimeoutSec: 60, heartbeatIntervalSec: 5, noViewerTimeoutSec: 180 };
  }

  createSession(params: {
    sharerUserId: string;
    sharerUsername: string;
    guildId: string;
    targetChannelId: string;
    manualCreated?: boolean;
    quality?: string;
    serverId?: string;
    /** 手动指定的 Provider；不传则按「服务器默认 → 用户 BYOK → 平台池」自动解析 */
    providerId?: string;
  }): ShareSession {
    const id = randomUUID();
    const shortId = id.replace(/-/g, '').slice(0, 12);
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const serverId = params.serverId || params.guildId || '';

    // 会话创建时**固定选定**一个 Provider，并记录 App ID 快照。
    // 此后该会话的发布端与所有观众端都必须使用同一个 Provider / App ID / Channel，
    // 中途不允许更换（否则观众会被发到另一个声网项目却毫无提示）。
    const resolution = this.providers.resolveForSession({
      serverId,
      sharerUserId: params.sharerUserId,
      requestedProviderId: params.providerId,
    });
    if (resolution.status === 'failed') {
      this.logger.warn(
        `createSession: no usable Agora provider for server=${serverId || '(unknown)'} ` +
          `sharer=${params.sharerUserId || '(unknown)'}: ${resolution.code}`,
      );
      throw new ProviderUnavailableError(resolution.code, resolution.message);
    }

    const session: ShareSession = {
      id,
      token,
      channel: this.agora.generateChannelName(shortId),
      sharerUserId: params.sharerUserId,
      sharerUsername: params.sharerUsername,
      guildId: params.guildId,
      targetChannelId: params.targetChannelId,
      status: SessionStatus.PENDING,
      viewerCount: 0,
      peakViewers: 0,
      totalViewerJoins: 0,
      viewerDurationMs: 0,
      quality: params.quality || '1080p_2',
      manualCreated: params.manualCreated || false,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      lastHeartbeat: now,
      graceStartedAt: null,
      graceReason: null,
      lastViewerAt: null,
      lowLatency: false,
      providerId: resolution.provider.id,
      agoraAppId: resolution.provider.appId,
    };

    this.db.createSession(this.toDb(session, serverId));
    this.logger.log(
      `createSession: ${session.id} bound to provider ${resolution.provider.id} ` +
        `(${resolution.reason}, appId=${resolution.provider.appId})`,
    );
    return session;
  }

  getByToken(token: string): ShareSession | undefined {
    const row = this.db.getSessionByToken(token);
    if (!row) return undefined;
    return this.fromDb(row);
  }

  getById(id: string): ShareSession | undefined {
    const row = this.db.getSessionById(id);
    if (!row) return undefined;
    return this.fromDb(row);
  }

  /** 检查用户是否有活跃的共享会话（非 ENDED 状态） */
  hasActiveSession(sharerUserId: string): boolean {
    const sessions = this.db.getActiveSessionsByUser(sharerUserId);
    return sessions.length > 0;
  }

  cancelPendingSession(id: string): boolean {
    return this.db.deletePendingSession(id);
  }

  listAll(): ShareSession[] {
    return this.db.getAllSessions().map((s) => this.fromDb(s));
  }

  listByServer(serverId: string): ShareSession[] {
    return this.db.getSessionsByServer(serverId).map((s) => this.fromDb(s));
  }

  startSharing(token: string, clientId?: string, lowLatency?: boolean): ShareSession | undefined {
    const session = this.getByToken(token);
    if (!session || session.status === SessionStatus.ENDED) {
      this.logger.warn(`startSharing: session not found or ended, token=${token.substring(0, 8)}...`);
      return undefined;
    }

    // 需求1: 一个链接只有第一个点开的人能共享
    if (session.publisherClientId && clientId && session.publisherClientId !== clientId) {
      this.logger.warn(
        `startSharing: rejected, publisher locked to ${session.publisherClientId.substring(0, 8)}..., got ${clientId.substring(0, 8)}...`,
      );
      return undefined;
    }
    if (!session.publisherClientId && clientId) {
      session.publisherClientId = clientId;
    }
    if (lowLatency !== undefined) {
      session.lowLatency = lowLatency;
    }

    const wasGrace = session.status === SessionStatus.GRACE;
    session.status = SessionStatus.ACTIVE;
    session.lastHeartbeat = Date.now();
    session.graceStartedAt = null;
    session.graceReason = null;
    session.lastViewerAt = Date.now();
    if (!session.startedAt) {
      session.startedAt = Date.now();
    }
    this.resumeViewerBilling(session.id, session.lastHeartbeat);
    // 账本：主播区间从首次开始共享一直开到会话结束；观众区间在恢复时重新开启。
    // 两者都是幂等的，因此「GRACE 恢复」重复调用不会切出多余区间。
    this.ensurePublisherInterval(session, session.startedAt);
    this.openAllViewerIntervals(session, session.lastHeartbeat);

    const dbRow = this.db.getSessionByToken(token);
    if (dbRow) {
      this.db.updateSession(dbRow.id, {
        status: session.status,
        lastHeartbeat: session.lastHeartbeat,
        graceStartedAt: null,
        graceReason: null,
        lastViewerAt: session.lastViewerAt,
        startedAt: session.startedAt,
        publisherClientId: session.publisherClientId || null,
        lowLatency: session.lowLatency ? 1 : 0,
      });
    }

    this.logger.log(
      `startSharing: session=${session.id}, wasGrace=${wasGrace}, cardMessageId=${session.cardMessageId || 'none'}, targetChannelId=${session.targetChannelId || 'empty'}, lowLatency=${session.lowLatency}`,
    );

    if (!wasGrace && !session.cardMessageId) {
      this.logger.log(`startSharing: emitting session.started event for ${session.id}`);
      this.bus.emitSessionStarted({
        sessionId: session.id,
        token: session.token,
        sharerUsername: session.sharerUsername,
        targetChannelId: session.targetChannelId,
        guildId: session.guildId,
      });
    } else {
      this.logger.log(`startSharing: skipping card push (wasGrace=${wasGrace}, cardMessageId exists=${!!session.cardMessageId})`);
    }

    // 通知 SSE 控制器推送最新状态给发布端
    this.bus.emitSessionStateChanged({
      sessionId: session.id,
      status: session.status,
      viewerCount: session.viewerCount,
    });

    return session;
  }

  heartbeat(token: string): boolean {
    const session = this.getByToken(token);
    if (!session || session.status === SessionStatus.ENDED) return false;
    session.lastHeartbeat = Date.now();
    if (
      session.status === SessionStatus.GRACE &&
      session.graceReason === 'heartbeat'
    ) {
      session.status = SessionStatus.ACTIVE;
      session.graceStartedAt = null;
      session.graceReason = null;
      this.resumeViewerBilling(session.id, session.lastHeartbeat);
      // 账本：回到 ACTIVE，观众重新进入计费状态
      this.openAllViewerIntervals(session, session.lastHeartbeat);
      this.logger.log('session ' + session.id + ' reconnected within grace');
    }

    const dbRow = this.db.getSessionByToken(token);
    if (dbRow) {
      this.db.updateSession(dbRow.id, {
        lastHeartbeat: session.lastHeartbeat,
        status: session.status,
        graceStartedAt: session.graceStartedAt,
        graceReason: session.graceReason || null,
      });
    }
    return true;
  }

  /**
   * 停止共享：进入「恢复宽限期」而非立即结束。
   */
  stopSharing(token: string): ShareSession | undefined {
    const session = this.getByToken(token);
    if (!session || session.status === SessionStatus.ENDED) return undefined;
    const now = Date.now();
    // 观众停止计费（账本区间同时关闭）；**主播区间保持开着**，
    // 因为主播时长口径含 GRACE 空档（见 docs/open-questions.md 决策 3）
    this.pauseViewerBilling(session.id, now, 'grace');
    session.status = SessionStatus.GRACE;
    session.graceReason = 'stopped';
    session.graceStartedAt = now;
    session.lastHeartbeat = now;

    const dbRow = this.db.getSessionByToken(token);
    if (dbRow) {
      this.db.updateSession(dbRow.id, {
        status: session.status,
        graceReason: session.graceReason,
        graceStartedAt: session.graceStartedAt,
        lastHeartbeat: session.lastHeartbeat,
      });
    }

    const cfg = this.getServerSessionConfig(session.guildId);
    this.logger.log(
      `stopSharing: session=${session.id} entered 'stopped' grace, idle timeout ${cfg.idleTimeoutSec}s`,
    );

    // 通知 SSE 控制器推送最新状态给发布端
    this.bus.emitSessionStateChanged({
      sessionId: session.id,
      status: session.status,
      viewerCount: session.viewerCount,
    });

    return session;
  }

  /** SSE 观众连接。相同 viewerId 的重连或并发连接只计一个观众。 */
  viewerConnected(sessionId: string, viewerId: string): void {
    const session = this.getById(sessionId);
    if (!session || session.status === SessionStatus.ENDED) return;
    const now = Date.now();
    let viewers = this.viewerPresenceMap.get(sessionId);
    if (!viewers) {
      viewers = new Map();
      this.viewerPresenceMap.set(sessionId, viewers);
    }
    const existing = viewers.get(viewerId);
    let isNewViewer = false;
    if (existing) {
      existing.connections += 1;
    } else {
      viewers.set(viewerId, {
        connections: 1,
        billingStartedAt: session.status === SessionStatus.ACTIVE ? now : null,
      });
      isNewViewer = true;
    }
    const presence = viewers.get(viewerId)!;
    if (presence.billingStartedAt !== null) {
      // 账本：观众进入计费状态
      this.openViewerInterval(session, viewerId, now);
    }
    this.syncViewerMetrics(session, viewers.size, isNewViewer ? viewerId : undefined);
  }

  /** SSE 观众断开；最后一条同 viewerId 连接断开时结算本次在线区间。 */
  viewerDisconnected(sessionId: string, viewerId: string): void {
    const viewers = this.viewerPresenceMap.get(sessionId);
    const presence = viewers?.get(viewerId);
    if (!viewers || !presence) return;
    presence.connections -= 1;
    if (presence.connections <= 0) {
      // 停止计费：在场状态与账本区间一次完成
      this.stopViewerBilling(sessionId, viewerId, presence, Date.now(), 'viewer_left');
      viewers.delete(viewerId);
    }
    if (viewers.size === 0) this.viewerPresenceMap.delete(sessionId);
    const session = this.getById(sessionId);
    if (session && session.status !== SessionStatus.ENDED) {
      this.syncViewerMetrics(session, viewers.size);
    }
  }

  private syncViewerMetrics(session: ShareSession, viewerCount: number, joinedViewerId?: string): void {
    // 更新峰值
    if (viewerCount > session.peakViewers) {
      session.peakViewers = viewerCount;
    }

    // 持久化到 DB
    this.db.updateSession(session.id, {
      viewerCount,
      peakViewers: session.peakViewers,
    });

    // 更新 lastViewerMap（用于 watchdog 的 no_viewer_timeout 检测）
    if (viewerCount > 0) {
      this.lastViewerMap.delete(session.id);
    } else if (!this.lastViewerMap.has(session.id)) {
      this.lastViewerMap.set(session.id, Date.now());
    }

    // viewerId 去重后记录加入数（用于 endSession 时持久化）
    if (joinedViewerId) {
      let ids = this.viewerIdsMap.get(session.id);
      if (!ids) {
        ids = new Set();
        this.viewerIdsMap.set(session.id, ids);
      }
      if (!ids.has(joinedViewerId)) {
        ids.add(joinedViewerId);
        this.recordViewerJoin(session.id, session.totalViewerJoins);
      }
    }

    // 通过 EventBus 推送状态变更，SSE 控制器监听此事件推给所有客户端
    this.bus.emitSessionStateChanged({
      sessionId: session.id,
      status: session.status,
      viewerCount,
    });
  }

  /**
   * 停止某观众的计费：更新在场状态 + 关闭账本区间。
   *
   * 时长**不再在这里累加** —— `usage_intervals` 是唯一的事实来源，
   * 数值由账本派生（见 `getViewerDurationMs`）。这里只负责状态机
   * （谁当前在计费）与账本区间的开合，避免两套口径各算一份。
   */
  private stopViewerBilling(
    sessionId: string,
    viewerId: string,
    presence: ViewerPresence,
    now: number,
    reason: UsageIntervalClosedReason,
  ): void {
    if (presence.billingStartedAt === null) return;
    presence.billingStartedAt = null;
    this.closeViewerInterval(sessionId, viewerId, now, reason);
  }

  private pauseViewerBilling(
    sessionId: string,
    now = Date.now(),
    reason: UsageIntervalClosedReason = 'grace',
  ): void {
    const viewers = this.viewerPresenceMap.get(sessionId);
    if (!viewers) return;
    for (const [viewerId, presence] of viewers) {
      this.stopViewerBilling(sessionId, viewerId, presence, now, reason);
    }
  }

  private resumeViewerBilling(sessionId: string, now = Date.now()): void {
    const viewers = this.viewerPresenceMap.get(sessionId);
    if (!viewers) return;
    for (const presence of viewers.values()) {
      if (presence.billingStartedAt === null) presence.billingStartedAt = now;
    }
  }

  // ===== 用量账本（旁路写入）=====
  //
  // ⚠️ 只在**真实的计费状态转换**处写入：观众加入 / 离开、进入 / 退出 GRACE、会话结束。
  // 账本区间一旦被「每次落盘」这种高频路径触碰，就会被切成大量碎片，
  // 因此落盘（checkpointViewerDurations）只读账本、不改状态机。

  /**
   * 账本是**旁路**：写入失败不应打断正在进行的共享，
   * 但必须大声报告，而不是静默丢账。
   */
  private safeLedger(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.logger.error(`usage ledger write failed: ${(error as Error).message}`);
    }
  }

  /**
   * 会话当前档位。
   *
   * Phase 3 会把编码参数快照写进会话，届时改为「优先读快照，回退 preset 反查」，
   * 这样自定义分辨率也能得到正确档位。
   */
  private resolveTier(session: ShareSession): string {
    return getQualityInfo(session.quality).tier;
  }

  private openViewerInterval(session: ShareSession, viewerId: string, at: number): void {
    this.safeLedger(() => this.ledger.openInterval({
      sessionId: session.id,
      providerId: session.providerId,
      // guildId 在本项目里就是 server_id：createSession 用 params.serverId || params.guildId
      serverId: session.guildId,
      role: 'viewer',
      actorId: viewerId,
      tier: this.resolveTier(session),
      lowLatency: session.lowLatency,
      startedAt: at,
    }));
  }

  private closeViewerInterval(
    sessionId: string,
    viewerId: string,
    at: number,
    reason: UsageIntervalClosedReason,
  ): void {
    this.safeLedger(() => this.ledger.closeInterval({
      sessionId,
      role: 'viewer',
      actorId: viewerId,
      endedAt: at,
      reason,
    }));
  }

  /**
   * 为当前在线所有观众开计费区间（回到 ACTIVE）。
   *
   * 只处理**确实处于计费状态**的观众，避免给「等待开始共享」期间加入的人计费。
   * 已在计费中的会被账本幂等复用，因此重复调用是安全的。
   */
  private openAllViewerIntervals(session: ShareSession, at: number): void {
    const viewers = this.viewerPresenceMap.get(session.id);
    if (!viewers) return;
    for (const [viewerId, presence] of viewers) {
      if (presence.billingStartedAt !== null) {
        this.openViewerInterval(session, viewerId, at);
      }
    }
  }

  /**
   * 主播的计费区间：从第一次开始共享一直开到**会话结束**。
   *
   * 因此时长等于 `endedAt - startedAt`，与既有 `durationMs` 一致 ——
   * **含 GRACE 空档**，这是刻意保持的现状（见 docs/open-questions.md 决策 3）。
   * 幂等，因此「GRACE 恢复」再次调用不会切出新区间。
   */
  private ensurePublisherInterval(session: ShareSession, at: number): void {
    this.safeLedger(() => this.ledger.openInterval({
      sessionId: session.id,
      providerId: session.providerId,
      serverId: session.guildId,
      role: 'publisher',
      actorId: session.sharerUserId,
      tier: this.resolveTier(session),
      lowLatency: session.lowLatency,
      startedAt: at,
    }));
  }

  /**
   * 观众累计观看毫秒数。
   *
   * **以账本为准**：已关闭区间之和 + 进行中区间的实时部分。
   * 账本里完全没有该会话的区间时回退到已落盘的 `session.viewerDurationMs` ——
   * 那是账本启用之前创建的历史会话，只有旧值可用。
   *
   * 返回 `null` 表示「历史会话且没有落盘值」，调用方按旧记录估算。
   */
  private getViewerDurationMs(session: ShareSession, now = Date.now()): number | null {
    if (!this.ledger.hasSessionIntervals(session.id)) {
      return session.viewerDurationMs;
    }
    return this.ledger.getViewerDurationMs(session.id, now);
  }

  /**
   * 定期把**账本派生**的观众时长落盘，降低进程异常退出造成的计费误差。
   *
   * 只读账本 + 写缓存列，**不触碰在场状态机**，因此不会切出多余区间。
   */
  @Interval(10_000)
  checkpointViewerDurations(): void {
    for (const sessionId of this.viewerPresenceMap.keys()) {
      const session = this.getById(sessionId);
      if (!session || session.status === SessionStatus.ENDED) continue;
      this.db.updateSession(sessionId, {
        viewerDurationMs: this.ledger.getViewerDurationMs(sessionId),
      });
    }
  }

  setCardMessageId(sessionId: string, messageId: string): void {
    this.db.updateSession(sessionId, { cardMessageId: messageId });
  }

  /** 记录去重加入（仅写内存，session 结束时持久化到 DB） */
  recordViewerJoin(sessionId: string, persistedCount = 0): void {
    const current = this.joinCountMap.get(sessionId) ?? persistedCount;
    this.joinCountMap.set(sessionId, current + 1);
  }

  updateQuality(sessionId: string, quality: string): void {
    this.db.updateSession(sessionId, { quality });
    this.logger.log(`session ${sessionId} quality set to ${quality}`);
  }

  endSession(sessionId: string, reason: string): void {
    const session = this.getById(sessionId);
    if (!session || session.status === SessionStatus.ENDED) return;

    const ageMs = Date.now() - session.createdAt;
    const endedAt = Date.now();
    const durationMs = session.startedAt ? endedAt - session.startedAt : null;
    this.pauseViewerBilling(sessionId, endedAt, 'session_end');
    // 兜底：一次性关闭该会话的全部区间（含主播区间），
    // 因此即使某个观众区间因异常没被单独关掉，这里也会收口。
    this.safeLedger(() => this.ledger.closeSessionIntervals(sessionId, 'session_end', endedAt));
    const viewerDurationMs = this.getViewerDurationMs(session, endedAt);

    // 持久化峰值和累计加入数（从内存 Map 取，不再实时写 DB）
    const totalJoins = this.joinCountMap.get(sessionId) ?? session.totalViewerJoins;
    const peakViewers = session.peakViewers;

    this.db.updateSession(sessionId, {
      status: SessionStatus.ENDED,
      endedAt,
      durationMs,
      totalViewerJoins: totalJoins,
      peakViewers,
      viewerDurationMs,
    });

    // 清理内存 Map（观众时长的账本区间已在上方关闭，无需再单独清理累加值）
    this.lastViewerMap.delete(sessionId);
    this.joinCountMap.delete(sessionId);
    this.viewerPresenceMap.delete(sessionId);
    this.viewerIdsMap.delete(sessionId);

    this.bus.emitSessionEnded({
      sessionId: session.id,
      reason,
      targetChannelId: session.targetChannelId,
      cardMessageId: session.cardMessageId,
    });
    this.logger.warn(
      `session ${session.id} ENDED: reason=${reason}, age=${(ageMs / 1000).toFixed(1)}s, ` +
      `startedAt=${session.startedAt ? 'yes' : 'no'}, ` +
      `duration=${durationMs}ms, peakViewers=${session.peakViewers}`,
    );
  }

  /** 删除已结束的 session 记录 */
  deleteSession(sessionId: string): boolean {
    const ok = this.db.deleteSession(sessionId);
    if (ok) this.logger.log(`session ${sessionId} record deleted`);
    return ok;
  }

  toInfo(session: ShareSession): SessionInfo {
    // 计算实时时长
    let durationMs = session.durationMs;
    if (session.startedAt && session.status !== SessionStatus.ENDED) {
      durationMs = Date.now() - session.startedAt;
    } else if (session.startedAt && session.endedAt) {
      durationMs = session.endedAt - session.startedAt;
    }

    // 档位仍由 preset key 反查（Phase 3 会把编码参数快照写进会话，
    // 届时改为「优先读快照，回退 preset 反查」，自定义分辨率才能算对档位）
    const tier = getQualityInfo(session.quality).tier;
    const durationSec = durationMs ? durationMs / 1000 : 0;

    // 折算系数来自可配置的 `quality_config`：声网调价、或系数写错时改数据即可，
    // 不需要发版。主播与观众的口径差异由 resolveBillingProfile 统一表达。
    const config = this.qualityConfig.get();
    const broadcasterAudioCoeff = resolveBillingProfile({
      role: 'publisher', tier, lowLatency: session.lowLatency, config,
    }).coefficient;
    const viewerVideoCoeff = resolveBillingProfile({
      role: 'viewer', tier, lowLatency: session.lowLatency, config,
    }).coefficient;

    const viewerDurationMs = this.getViewerDurationMs(session);
    const legacyViewerEstimate = viewerDurationMs === null;

    let broadcasterStandardSec: number;
    let viewerStandardSec: number;
    let viewerDurationSec: number;

    if (this.ledger.hasSessionIntervals(session.id)) {
      // 🔑 账本为准：直接用区间**结算时快照**的系数求和，
      // 而不是用「当前档位 × 当前系数」重算 —— 后者在会话中途切换档位
      // （自由画布的自定义画质）或调整配置之后都会算错。
      const standardMs = this.ledger.getStandardMsByRole(session.id);
      broadcasterStandardSec = standardMs.publisher / 1000;
      viewerStandardSec = standardMs.viewer / 1000;
      viewerDurationSec = (viewerDurationMs ?? 0) / 1000;
    } else {
      // 账本启用之前的历史会话：沿用旧的估算口径（按当前档位与峰值人数推算）
      broadcasterStandardSec = durationSec * broadcasterAudioCoeff;
      viewerDurationSec = legacyViewerEstimate
        ? session.peakViewers * durationSec
        : viewerDurationMs / 1000;
      viewerStandardSec = viewerDurationSec * viewerVideoCoeff;
    }

    // 标准时长（分钟），向上取整
    const standardMinutes = durationMs
      ? Math.ceil((broadcasterStandardSec + viewerStandardSec) / 60)
      : 0;

    // 预估费用（单价同样可配，默认 0.007 元/标准分钟）
    const estimatedCost =
      Math.round(standardMinutes * config.standardMinutePrice * 100) / 100;

    const durationMin = durationSec / 60;
    const viewerDurationMin = viewerDurationSec / 60;
    const modeLabel = session.lowLatency ? '互动直播' : '极速直播';
    const billingDetail = durationMs
      ? legacyViewerEstimate
        ? `[旧记录估算] ${durationMin.toFixed(1)}主播分×系数${broadcasterAudioCoeff} + ${session.peakViewers}峰值观众×${durationMin.toFixed(1)}分×${modeLabel}系数${viewerVideoCoeff} = ${standardMinutes} 标准分钟`
        : `${durationMin.toFixed(1)}主播分×系数${broadcasterAudioCoeff} + ${viewerDurationMin.toFixed(1)}累计观众分×${modeLabel}系数${viewerVideoCoeff} = ${standardMinutes} 标准分钟`
      : '-';

    const serverConfig = this.db.getServer(session.guildId);
    const globalCfg = this.db.getGlobalConfig();
    const publicDomain = globalCfg.publicDomain;

    let idleRemainingSec: number | undefined;
    const cfg = this.getServerSessionConfig(session.guildId);
    if (session.status === SessionStatus.PENDING) {
      const elapsed = (Date.now() - session.createdAt) / 1000;
      idleRemainingSec = Math.max(0, Math.ceil(cfg.idleTimeoutSec - elapsed));
    } else if (session.status === SessionStatus.GRACE && session.graceStartedAt) {
      const elapsed = (Date.now() - session.graceStartedAt) / 1000;
      idleRemainingSec = Math.max(0, Math.ceil(cfg.idleTimeoutSec - elapsed));
    }

    let noViewerRemainingSec: number | undefined;
    const memLastViewer = this.lastViewerMap.get(session.id);
    if (
      session.status !== SessionStatus.ENDED &&
      session.viewerCount === 0 &&
      memLastViewer
    ) {
      const elapsed = (Date.now() - memLastViewer) / 1000;
      noViewerRemainingSec = Math.max(0, Math.ceil(cfg.noViewerTimeoutSec - elapsed));
    }

    // 从内存 Map 取实时 totalViewerJoins（不再实时写 DB）
    const liveJoins = this.joinCountMap.get(session.id) ?? session.totalViewerJoins;

    return {
      id: session.id,
      channel: session.channel,
      sharerUsername: session.sharerUsername,
      status: session.status,
      viewerCount: session.viewerCount,
      peakViewers: session.peakViewers,
      totalViewerJoins: liveJoins,
      viewerDurationMs,
      quality: session.quality,
      shareLink: `${publicDomain.replace(/\/+$/, '')}/share?t=${session.token}`,
      viewLink: `${publicDomain.replace(/\/+$/, '')}/view?t=${session.token}`,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationMs,
      billingMinutes: standardMinutes,
      billingDetail,
      standardMinutes,
      estimatedCost,
      publisherClientId: session.publisherClientId,
      idleRemainingSec,
      noViewerRemainingSec,
      lowLatency: session.lowLatency,
      allowLowLatency: !!serverConfig?.allowLowLatency,
    };
  }

  /** Session 最大生命周期（24 小时），防止 watchdog 异常停止时 session 永不过期 */
  private readonly MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

  @Interval(5000)
  async watchdog() {
    const now = Date.now();
    const sessions = this.db.getAllSessions().filter((s) => s.status !== 'ended');

    for (const row of sessions) {
      const session = this.fromDb(row);
      const cfg = this.getServerSessionConfig(session.guildId);

      // 绝对过期：超过最大生命周期强制结束
      if (now - session.createdAt > this.MAX_SESSION_AGE_MS) {
        this.endSession(session.id, 'max_age');
        continue;
      }

      // 无人观看倒计时（从内存 Map 读 lastViewerAt，不再查 DB）
      if (
        session.status !== SessionStatus.ENDED &&
        session.viewerCount === 0 &&
        this.lastViewerMap.has(session.id)
      ) {
        const lastViewerAt = this.lastViewerMap.get(session.id)!;
        if (now - lastViewerAt > cfg.noViewerTimeoutSec * 1000) {
          this.endSession(session.id, 'no_viewer_timeout');
          continue;
        }
      }

      // PENDING 状态：等待开始共享
      if (session.status === SessionStatus.PENDING) {
        if (now - session.createdAt > cfg.idleTimeoutSec * 1000) {
          this.endSession(session.id, 'idle_timeout');
        }
        continue;
      }

      // ACTIVE 状态：心跳丢失 → 进入 GRACE
      if (session.status === SessionStatus.ACTIVE) {
        const elapsed = now - session.lastHeartbeat;
        if (elapsed > cfg.heartbeatIntervalSec * 1000 * 3) {
          // 心跳丢失进入 GRACE：观众停止计费（主播区间继续开着）
          this.pauseViewerBilling(session.id, now, 'grace');
          this.db.updateSession(session.id, {
            status: SessionStatus.GRACE,
            graceReason: 'heartbeat',
            graceStartedAt: now,
          });
          this.logger.warn(
            'session ' + session.id + ' heartbeat lost, entering grace',
          );
          this.bus.emitSessionStateChanged({
            sessionId: session.id,
            status: SessionStatus.GRACE,
            viewerCount: session.viewerCount,
          });
        }
        continue;
      }

      // GRACE 状态：统一使用 idleTimeoutSec
      if (session.status === SessionStatus.GRACE && session.graceStartedAt) {
        if (now - session.graceStartedAt > cfg.idleTimeoutSec * 1000) {
          this.endSession(session.id, 'idle_timeout');
          continue;
        }
      }
    }
  }
}
