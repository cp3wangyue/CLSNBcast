import { baseline } from './001-baseline';
import { agoraProviders } from './002-agora-providers';
import { usageLedger } from './003-usage-ledger';
import { qualityConfig } from './004-quality-config';
import type { Migration } from './types';

/**
 * 迁移注册表。**必须按 version 升序排列**，运行器会校验。
 *
 * 新增迁移的步骤：
 * 1. 新建 `NNN-<name>.ts`，导出一个 `Migration`（version 取当前最大 +1）
 * 2. 追加到本数组末尾
 *
 * ⚠️ 已发布的迁移**不可修改、version 不可复用**。要改行为就新增一个。
 */
export const MIGRATIONS: Migration[] = [baseline, agoraProviders, usageLedger, qualityConfig];
