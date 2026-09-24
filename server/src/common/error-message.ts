/**
 * 把 catch 到的 unknown 收窄成可展示/可记录的错误文案。
 *
 * catch 变量在 TS 4.4+ 起是 unknown（`useUnknownInCatchVariables`），
 * 标注成 any 既不准确，也绕过了「取属性前先收窄」的检查。统一走这里，
 * 避免每个 catch 里重复写守卫。
 *
 * 只用于**展示与日志**。不要把结果当作控制流的可靠依据 ——
 * 错误信息不是稳定的契约。
 */
export function errorMessage(e: unknown, fallback = '未知错误'): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

/** 判断是否为 AbortController / 超时的中止错误 */
export function isAbortError(e: unknown): boolean {
  return (
    (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) ||
    (!!e && typeof e === 'object' && 'name' in e &&
      ((e as { name?: unknown }).name === 'AbortError' ||
        (e as { name?: unknown }).name === 'TimeoutError'))
  );
}
