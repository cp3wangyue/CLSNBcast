import { UsageBillingModel, UsageRole } from '../database/database.service';
import { QualityConfigValues, QualityTierRule } from '../quality/quality-config.types';

export interface BillingProfile {
  billingModel: UsageBillingModel;
  coefficient: number;
}

/** 档位未命中时的兜底：取最低档的系数（与既有 `?? 4 / ?? 2` 的行为一致）。 */
function lowestTierRule(config: QualityConfigValues): QualityTierRule | undefined {
  return [...config.tierRules].sort(
    (a, b) => (a.maxPixels ?? Number.POSITIVE_INFINITY) - (b.maxPixels ?? Number.POSITIVE_INFINITY),
  )[0];
}

/**
 * 解析某参与者当前适用的计费模型与折算系数。
 *
 * 口径与 `SessionService.toInfo()` 完全一致，否则账本与界面会各说一套：
 * - **主播**不订阅自己的视频流 → 始终按**音频**系数，且属于互动直播
 * - **观众**按**视频**档位系数；低延迟模式走互动直播价，极速直播走极速直播价
 *
 * 系数来自可配置的 `quality_config`（Phase 2-3 之前是 `session.types.ts` 里的硬编码表），
 * 因此声网调价、或系数写错时，**改数据即可，不需要发版**。
 *
 * 注意 `audioCoefficients.interactiveViewer` / `ultraLowLatencyViewer` 目前未被使用：
 * 当前产品形态下观众总是订阅视频，因此按视频档位系数计费。
 * 这两个值是为「纯音频观看」预留的，保留在配置里以免日后又要改表结构。
 */
export function resolveBillingProfile(input: {
  role: UsageRole;
  tier: string;
  lowLatency: boolean;
  config: QualityConfigValues;
}): BillingProfile {
  const { config } = input;

  if (input.role === 'publisher') {
    return {
      billingModel: 'interactive',
      coefficient: config.audioCoefficients.broadcaster,
    };
  }

  const rule = config.tierRules.find((entry) => entry.tier === input.tier);
  const fallback = lowestTierRule(config);

  if (input.lowLatency) {
    return {
      billingModel: 'interactive',
      coefficient: rule?.interactive ?? fallback?.interactive ?? 1,
    };
  }
  return {
    billingModel: 'ultra_low_latency',
    coefficient: rule?.ultraLowLatency ?? fallback?.ultraLowLatency ?? 1,
  };
}
