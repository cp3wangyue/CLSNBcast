import { AgoraProviderRecord } from '../database/database.service';
import { DEFAULT_USAGE_TIMEZONE, currentPeriodKey } from '../usage/usage-period';

// 周期计算已移到 usage 域（配额依赖用量口径，而非反过来）。
// 这里重新导出，避免调用方为了拿一个周期键而多一条导入路径。
export { DEFAULT_USAGE_TIMEZONE, currentPeriodKey };

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
