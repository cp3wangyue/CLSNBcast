import { UsageBillingModel, UsageRole } from '../database/database.service';
import { getAudioCoefficient, getVideoCoefficient } from '../session/session.types';

export interface BillingProfile {
  billingModel: UsageBillingModel;
  coefficient: number;
}

/**
 * 解析某参与者当前适用的计费模型与折算系数。
 *
 * 口径与 `SessionService.toInfo()` 完全一致，否则账本与界面会各说一套：
 * - **主播**不订阅自己的视频流 → 始终按**音频**系数，且属于互动直播
 * - **观众**按**视频**档位系数；低延迟模式走互动直播价，极速直播走极速直播价
 *
 * ⚠️ 系数目前来自 `session.types.ts` 的硬编码表。Phase 2-3 会改为从
 * `quality_config` 读取 —— 届时只替换本函数实现，账本与调用方都不用改。
 */
export function resolveBillingProfile(input: {
  role: UsageRole;
  tier: string;
  lowLatency: boolean;
}): BillingProfile {
  if (input.role === 'publisher') {
    return {
      billingModel: 'interactive',
      coefficient: getAudioCoefficient(input.lowLatency, true),
    };
  }
  return {
    billingModel: input.lowLatency ? 'interactive' : 'ultra_low_latency',
    coefficient: getVideoCoefficient(input.tier, input.lowLatency),
  };
}
