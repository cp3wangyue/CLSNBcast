/**
 * 计费周期工具。
 *
 * 放在 usage 域而不是 agora 域：配额判断依赖用量口径，反过来则不对。
 * `AgoraProviderService` 的配额评估从 `agora/provider-quota` 导入这里的能力。
 */

/** 默认计费周期时区。Phase 3 起可由管理员通过 `quality_config.usage_timezone` 覆盖。 */
export const DEFAULT_USAGE_TIMEZONE = 'Asia/Shanghai';

/**
 * 计费周期键 `YYYY-MM`。
 *
 * 用 `Intl` 按时区计算，**不能**用 `getMonth()` —— 生产容器通常是 UTC，
 * 直接用本地时间会在月初/月末错一天，导致配额判断与用量归集落到错误周期。
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
