import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  DatabaseService,
  ProviderUsageMonthlyRecord,
  UsageIntervalClosedReason,
  UsageIntervalRecord,
  UsageRole,
} from '../database/database.service';
import { resolveBillingProfile } from './usage-billing';
import { DEFAULT_USAGE_TIMEZONE, currentPeriodKey } from './usage-period';

export interface OpenIntervalInput {
  sessionId: string;
  providerId: string;
  serverId?: string;
  role: UsageRole;
  actorId: string;
  /** 结算档位，如 'Full HD 全高清' */
  tier: string;
  lowLatency: boolean;
  /** 默认取当前时间；测试可显式传入 */
  startedAt?: number;
  video?: {
    width?: number | null;
    height?: number | null;
    frameRate?: number | null;
    bitrateMax?: number | null;
  };
  timeZone?: string;
}

export interface CloseIntervalInput {
  sessionId: string;
  role: UsageRole;
  actorId: string;
  reason: UsageIntervalClosedReason;
  endedAt?: number;
}

/**
 * 用量账本。
 *
 * 职责：
 * - 把「谁在哪个 Provider 上、以什么档位、用了多久」记成**区间**；
 * - 提供由区间派生的查询（观众时长、月度汇总）。
 *
 * 不负责判断「此刻是否应该计费」—— 那是会话生命周期的事（Phase 2-2 接线）。
 *
 * ## 为什么是区间而不是累加计数
 * 自由画质引入「会话中途切换档位」后，单一累加值无法表达「前 20 分钟 1080p、
 * 之后 720p」。区间各自快照 `tier` 与 `coefficient`，天然正确，
 * 且日后调整系数不会改写历史账目。
 *
 * ## 口径（与既有行为一致，见 docs/open-questions.md 决策 3）
 * - **观众**：只在会话 ACTIVE 期间开区间；GRACE / PENDING 不计。
 * - **主播**：区间从开始共享一直开到**会话结束**，因此时长等于 `endedAt - startedAt`，
 *   与既有 `durationMs` 一致（**含 GRACE 空档**，刻意不改）。
 *
 * ## 失败策略
 * 本服务的方法会抛错。接线方（Phase 2-2）应把调用包在 try/catch 里并记 error：
 * 账本写入失败不应打断正在进行的共享，但必须被大声报告，而不是静默丢账。
 */
@Injectable()
export class UsageLedgerService implements OnModuleInit {
  private readonly logger = new Logger(UsageLedgerService.name);

  constructor(private readonly db: DatabaseService) {}

  onModuleInit(): void {
    this.recoverDanglingIntervals();
  }

  // ===== 崩溃恢复 =====

  /**
   * 把上次进程遗留的未关闭区间收口。
   *
   * 进程重启后真实结束时间不可知，用**最后一次可信活动**兜底：
   * 优先会话的最后心跳（发布端 SSE 每 4s 刷新），其次区间起点（时长记 0）。
   * 这样不会把宕机期间算成用量。
   */
  recoverDanglingIntervals(now = Date.now()): number {
    const open = this.db.listOpenUsageIntervals();
    if (open.length === 0) return 0;

    for (const interval of open) {
      const session = this.db.getSessionById(interval.sessionId);
      const lastHeartbeat = session?.lastHeartbeat ?? 0;
      const endedAt =
        lastHeartbeat > interval.startedAt ? Math.min(lastHeartbeat, now) : interval.startedAt;
      this.db.closeUsageInterval(interval.id, endedAt, 'crash_recovery');
    }

    this.logger.warn(
      `Recovered ${open.length} dangling usage interval(s) after restart ` +
        '(closed at last known heartbeat)',
    );
    return open.length;
  }

  // ===== 区间开关 =====

  /**
   * 确保某参与者有一个进行中的计费区间；已有则直接复用，返回它的 id。
   *
   * **幂等**，因为「恢复」本身就会重复调用：会话从 GRACE 回到 ACTIVE 时，
   * 观众的计费区间会重新开启，而主播的区间从一开始就一直开着。
   * 用「已有则复用」而不是「重复则报错」，是为了让调用方可以无脑重试，
   * 同时从机制上杜绝重复计费 —— 这比要求每个调用点自己判断更可靠。
   */
  openInterval(input: OpenIntervalInput): number {
    const startedAt = input.startedAt ?? Date.now();

    const existing = this.db.getOpenUsageInterval(input.sessionId, input.role, input.actorId);
    if (existing) {
      this.logger.debug(
        `openInterval: reusing open interval ${existing.id} for ${input.role} ${input.actorId} ` +
          `(session=${input.sessionId})`,
      );
      return existing.id;
    }

    const profile = resolveBillingProfile({
      role: input.role,
      tier: input.tier,
      lowLatency: input.lowLatency,
    });

    const id = this.db.openUsageInterval({
      sessionId: input.sessionId,
      providerId: input.providerId,
      serverId: input.serverId ?? '',
      role: input.role,
      actorId: input.actorId,
      tier: input.tier,
      billingModel: profile.billingModel,
      coefficient: profile.coefficient,
      periodKey: currentPeriodKey(input.timeZone ?? DEFAULT_USAGE_TIMEZONE, new Date(startedAt)),
      startedAt,
      lowLatency: input.lowLatency,
      width: input.video?.width ?? null,
      height: input.video?.height ?? null,
      frameRate: input.video?.frameRate ?? null,
      bitrateMax: input.video?.bitrateMax ?? null,
    });

    this.recordEvent({
      sessionId: input.sessionId,
      providerId: input.providerId,
      serverId: input.serverId ?? '',
      role: input.role,
      actorId: input.actorId,
      eventType: 'join',
      occurredAt: startedAt,
      tier: input.tier,
      lowLatency: input.lowLatency,
      detail: `interval=${id} billingModel=${profile.billingModel} coefficient=${profile.coefficient}`,
    });

    return id;
  }

  /** 关闭某参与者的进行中区间。返回关闭数量（0 表示本来就没有）。 */
  closeInterval(input: CloseIntervalInput): number {
    const endedAt = input.endedAt ?? Date.now();
    const closed = this.db.closeOpenUsageIntervalsForActor(
      input.sessionId,
      input.role,
      input.actorId,
      endedAt,
      input.reason,
    );
    if (closed > 0) {
      this.recordEvent({
        sessionId: input.sessionId,
        role: input.role,
        actorId: input.actorId,
        eventType: 'leave',
        occurredAt: endedAt,
        detail: `closed=${closed} reason=${input.reason}`,
      });
    }
    return closed;
  }

  /** 关闭某会话下全部未关闭区间（会话结束时调用，包含主播区间）。 */
  closeSessionIntervals(
    sessionId: string,
    reason: UsageIntervalClosedReason,
    endedAt = Date.now(),
  ): number {
    const closed = this.db.closeOpenUsageIntervalsForSession(sessionId, endedAt, reason);
    if (closed > 0) {
      this.recordEvent({
        sessionId,
        role: 'publisher',
        actorId: '',
        eventType: 'session_end',
        occurredAt: endedAt,
        detail: `closed=${closed} reason=${reason}`,
      });
    }
    return closed;
  }

  /** 写一条审计事件。**不参与计费计算**，因此失败也不应影响业务。 */
  recordEvent(input: Parameters<DatabaseService['insertUsageEvent']>[0]): void {
    this.db.insertUsageEvent(input);
  }

  // ===== 查询 =====

  /**
   * 某会话观众的实际累计观看毫秒数。
   *
   * = 已关闭区间的时长合计 + 进行中区间的「now - startedAt」。
   * 与既有 `sessions.viewer_duration_ms` 语义一致（只算 ACTIVE 期间），
   * 因此 Phase 2-3 可以直接用它替换旧值而保持计费展示不变。
   */
  getViewerDurationMs(sessionId: string, now = Date.now()): number {
    const closed = this.db.sumClosedUsageDurationMs(sessionId, 'viewer');
    let live = 0;
    for (const interval of this.db.listOpenUsageIntervalsBySession(sessionId)) {
      if (interval.role !== 'viewer') continue;
      live += Math.max(0, now - interval.startedAt);
    }
    return closed + live;
  }

  /** 某会话的全部区间，按开始时间升序。 */
  listSessionIntervals(sessionId: string): UsageIntervalRecord[] {
    return this.db.listUsageIntervalsBySession(sessionId);
  }

  // ===== 月度汇总 =====

  /**
   * 按账本重算某周期的 Provider 汇总，并同步到 Provider 行上的配额缓存。
   *
   * 这是 `provider_usage_monthly` 与 `agora_providers.estimated_usage_standard_minutes`
   * 的唯一写入者 —— 事实来源始终是 `usage_intervals`。
   */
  rebuildMonthlyRollup(periodKey: string): ProviderUsageMonthlyRecord[] {
    const aggregated = this.db.aggregateUsageByProvider(periodKey);

    const byProvider = new Map<
      string,
      { standardMs: number; publisherMs: number; viewerMs: number; sessionCount: number }
    >();
    for (const row of aggregated) {
      const current = byProvider.get(row.providerId) ?? {
        standardMs: 0,
        publisherMs: 0,
        viewerMs: 0,
        sessionCount: 0,
      };
      current.standardMs += row.standardMs;
      if (row.role === 'publisher') current.publisherMs += row.durationMs;
      else current.viewerMs += row.durationMs;
      // sessionCount 来自 COUNT(DISTINCT session_id)，按角色各算一次，
      // 因此取两者较大值而不是相加 —— 相加会把「同一会话既有主播又有观众」算成两个会话。
      current.sessionCount = Math.max(current.sessionCount, row.sessionCount);
      byProvider.set(row.providerId, current);
    }

    const MS_PER_MINUTE = 60_000;
    for (const [providerId, agg] of byProvider) {
      const standardMinutes = agg.standardMs / MS_PER_MINUTE;
      this.db.upsertProviderUsageMonthly({
        providerId,
        periodKey,
        standardMinutes,
        publisherMinutes: agg.publisherMs / MS_PER_MINUTE,
        viewerMinutes: agg.viewerMs / MS_PER_MINUTE,
        sessionCount: agg.sessionCount,
      });
      this.syncProviderEstimate(providerId, periodKey, standardMinutes);
    }

    return this.db.listProviderUsageMonthly(periodKey);
  }

  /** 把标准分钟数写回 Provider 行，供配额判断 O(1) 读取。 */
  private syncProviderEstimate(
    providerId: string,
    periodKey: string,
    standardMinutes: number,
  ): void {
    if (!this.db.getProvider(providerId)) return;
    this.db.updateProvider(providerId, {
      estimatedUsageStandardMinutes: standardMinutes,
      usagePeriodKey: periodKey,
    });
  }

  /**
   * 某 Provider 在指定周期的标准分钟数。
   *
   * 直接读汇总缓存；`provider_usage_monthly` 的主键就是 (provider_id, period_key)，
   * 因此这是 O(1) 查询，不需要扫账本。
   */
  getMonthlyStandardMinutes(providerId: string, periodKey: string): number {
    return this.db.getProviderUsageMonthly(providerId, periodKey)?.standardMinutes ?? 0;
  }
}
