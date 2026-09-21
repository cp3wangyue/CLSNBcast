import { AgoraProviderRecord } from '../database/database.service';

/** 默认计费周期时区。Phase 3 起可由管理员通过 `quality_config.usage_timezone` 覆盖。 */
export const DEFAULT_USAGE_TIMEZONE = 'Asia/Shanghai';

/**
 * 计费周期键 `YYYY-MM`。
 *
 * 用 `Intl` 按时区计算，**不能**用 `getMonth()` —— 生产容器通常是 UTC，
 * 直接用本地时间会在月初/月末错一天，导致配额判断用错周期。
 */
export function currentPeriodKey(
  timeZone: string = DEFAULT_USAGE_TIMEZONE,
  now: Date = new Date(),
): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(now);
    const year = parts.find((p) => p.type === 'year')?.value;
    const month = parts.find((p) => p.type === 'month')?.value;
    if (year && month) return `${year}-${month}`;
  } catch {
    // 时区名非法（例如管理员填错）时退回 UTC，至少保证周期键仍可用
  }
  return now.toISOString().slice(0, 7);
}

export interface QuotaState {
  /** 未配置配额（`monthlyQuotaStandardMinutes === null`） */
  unlimited: boolean;
  /** 是否真的会拦截（配额已配置且开启了强制） */
  enforced: boolean;
  quotaMinutes: number | null;
  /** 本次判断采用的已用量（分钟） */
  usedMinutes: number;
  /** 是否已达到或超过配额 */
  exceeded: boolean;
  /**
   * 缓存的估算值是否属于当前周期。
   * `false` 表示跨月后尚未由汇总任务重算，此时按 0 处理。
   */
  estimateIsCurrent: boolean;
}

/**
 * 评估 Provider 的月度配额状态。
 *
 * `estimated_usage_standard_minutes` 只是账本汇总的**缓存**，所以跨月后必须视为 0，
 * 否则一个上个月已经跑满的 Provider 会永久被判定为超配额，再也分配不到会话。
 * 真正的重算由 Phase 2 的汇总任务负责。
 */
export function evaluateQuota(
  provider: AgoraProviderRecord,
  timeZone: string = DEFAULT_USAGE_TIMEZONE,
  now: Date = new Date(),
): QuotaState {
  const quotaMinutes = provider.monthlyQuotaStandardMinutes;
  const estimateIsCurrent = provider.usagePeriodKey === currentPeriodKey(timeZone, now);
  const usedMinutes = estimateIsCurrent ? provider.estimatedUsageStandardMinutes : 0;

  const unlimited = quotaMinutes === null || quotaMinutes === undefined;
  const enforced = provider.quotaEnforced === 1 && !unlimited;
  const exceeded = enforced && usedMinutes >= (quotaMinutes as number);

  return { unlimited, enforced, quotaMinutes, usedMinutes, exceeded, estimateIsCurrent };
}
