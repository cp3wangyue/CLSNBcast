/**
 * 平台标识与适配层契约。
 *
 * 本模块**不依赖任何具体平台的实现细节**，目的是把散落在各处的 `'kook'`
 * 字面量收敛成一处可枚举的事实来源，并为接入第二个平台提供接缝。
 *
 * 为什么需要它：
 * - `platform` 字段在数据库里是自由文本（`TEXT NOT NULL DEFAULT 'kook'`），
 *   而鉴权、寻址、管理端路由都在按字面量比较它。新增平台时，漏改任何一处
 *   都会造成「路由能进来但鉴权不认」这类半通不通的状态。
 * - 不同平台的接入形态可能差异很大（KOOK 是入站 webhook，而某些平台是
 *   出站长连接）。因此这里刻意**只描述「平台是什么」**，不描述「怎么接」，
 *   避免过早抽象出一个并不通用的接口。
 */

/** 当前代码真正支持的平台。新增平台时必须先在这里登记。 */
export const SUPPORTED_PLATFORMS = ['kook', 'discord'] as const;

export type PlatformId = (typeof SUPPORTED_PLATFORMS)[number];

/**
 * 未标注平台的存量数据的归属。
 *
 * `servers.platform` 是后来迁移加上的列，早于该列存在的行可能为空字符串。
 * 线上数据全部来自 KOOK，所以兜底值必须是 `'kook'`，改成别的会让存量服务器
 * 立刻无法寻址。
 */
export const DEFAULT_PLATFORM: PlatformId = 'kook';

/** 前端/管理端展示用的平台名。未登记的平台回退为原始字符串，避免显示成 undefined。 */
const PLATFORM_LABELS: Record<string, string> = {
  kook: 'KOOK',
  discord: 'Discord',
};

export function isSupportedPlatform(value: string): value is PlatformId {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

/**
 * 归一化平台标识（**读取路径**专用）。
 *
 * 空值、null、非登记值都回退到 `DEFAULT_PLATFORM`——读取路径永远不该因为
 * 一个未知字符串而抛错或返回 `undefined`，否则存量数据会凭空消失。
 *
 * ⚠️ **不要用它做鉴权**。多平台下把未知值静默当成 KOOK，会让一个本应
 * 属于别的平台的凭证被判成 KOOK 并通过 KOOK 的路由校验。
 * 鉴权请使用 `strictPlatform()`。
 */
export function normalizePlatform(value: string | null | undefined): PlatformId {
  if (!value) return DEFAULT_PLATFORM;
  return isSupportedPlatform(value) ? value : DEFAULT_PLATFORM;
}

/**
 * 严格解析平台标识（**鉴权 / 写入路径**专用）。
 *
 * 与 `normalizePlatform` 的区别：非登记值返回 `null` 而不是回退到默认平台。
 * 单平台时代「未知即 KOOK」是无害的；一旦有多个平台，这个假设会变成
 * 越权入口，因此凡涉及「这个凭证/这条记录属于哪个平台」的判断都必须走这里。
 */
export function strictPlatform(value: string | null | undefined): PlatformId | null {
  if (!value) return null;
  return isSupportedPlatform(value) ? value : null;
}

export function platformLabel(platform: string | null | undefined): string {
  const id = normalizePlatform(platform ?? '');
  return PLATFORM_LABELS[id] ?? id;
}
