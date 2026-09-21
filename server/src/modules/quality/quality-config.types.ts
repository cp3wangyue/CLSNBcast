/**
 * 画质与计费配置的类型与默认值。
 *
 * 这些值原本硬编码在 `session.types.ts` 里。改为可配置的目的有三个：
 * 1. **声网会调价**，改价不该需要发版；
 * 2. 不同账户/项目的计费模型可能不同（见 docs/open-questions.md 第 4 节）；
 * 3. 已确认上游的 Full HD 极速直播系数写错了（4.57，官方为 4.5）——
 *    配置化之后这类修正是**改数据**，不是改代码。
 */

export interface QualityTierRule {
  tier: string;
  /** 该档位的集合分辨率上界（像素数）；`null` = 无上界（最高档） */
  maxPixels: number | null;
  /** 互动直播折算系数（主播与互动直播观众相同） */
  interactive: number;
  /** 极速直播观众折算系数 */
  ultraLowLatency: number;
}

export interface AudioCoefficients {
  /** 主播始终按互动直播音频系数计费 */
  broadcaster: number;
  /** 互动直播观众（低延迟模式） */
  interactiveViewer: number;
  /** 极速直播观众（默认模式） */
  ultraLowLatencyViewer: number;
}

/**
 * 自定义画质的参数边界。
 *
 * `recommended*` 来自声网官方建议（码率 100–5000 Kbps），
 * **只用于风险提示，不强制修改用户输入**。
 *
 * ⚠️ Phase 3 才会消费这些值；现在一并落库是为了避免为「给同一张表加一列」
 * 再写一个迁移。
 */
export interface QualityLimits {
  width: { min: number; max: number; step: number };
  height: { min: number; max: number; step: number };
  frameRate: { min: number; max: number; recommendedMin: number; recommendedMax: number };
  bitrate: { min: number; max: number; recommendedMin: number; recommendedMax: number };
  maxPixels: number;
}

export interface QualityConfigValues {
  tierRules: QualityTierRule[];
  audioCoefficients: AudioCoefficients;
  /** 元 / 标准分钟 */
  standardMinutePrice: number;
  /** 计费周期与配额判断使用的时区 */
  usageTimezone: string;
  limits: QualityLimits;
}

/**
 * 默认配置。
 *
 * 档位边界来自声网官方计费文档（HD ≤ 921,600；Full HD ≤ 2,073,600；
 * 2K ≤ 3,686,400；2K+ 更大）。官方表里**没有 SD 档**，SD 归入 HD，
 * 因此两条规则的系数相同，保留 SD 只是为了让 640×480 有一个可读的档位名。
 *
 * `ultraLowLatency` 的 Full HD 取 **4.5**（官方值）—— 上游的 4.57 是错的。
 * 2K / 2K+ 的 8 / 18 是从公开文档无法完全收敛的值，属**待定**：
 * 先用这两个值上线，拿到真实账单后通过管理面板校准
 * （见 docs/open-questions.md 第 4 节）。
 */
export const DEFAULT_QUALITY_CONFIG: QualityConfigValues = {
  tierRules: [
    { tier: 'SD 标清', maxPixels: 640 * 480, interactive: 4, ultraLowLatency: 2 },
    { tier: 'HD 高清', maxPixels: 1280 * 720, interactive: 4, ultraLowLatency: 2 },
    { tier: 'Full HD 全高清', maxPixels: 1920 * 1080, interactive: 9, ultraLowLatency: 4.5 },
    { tier: '2K', maxPixels: 2560 * 1440, interactive: 16, ultraLowLatency: 8 },
    { tier: '2K+ 超高清', maxPixels: null, interactive: 36, ultraLowLatency: 18 },
  ],
  audioCoefficients: {
    broadcaster: 1,
    interactiveViewer: 1,
    ultraLowLatencyViewer: 0.57,
  },
  standardMinutePrice: 0.007,
  usageTimezone: 'Asia/Shanghai',
  limits: {
    width: { min: 16, max: 4096, step: 2 },
    height: { min: 16, max: 2160, step: 2 },
    frameRate: { min: 1, max: 120, recommendedMin: 5, recommendedMax: 60 },
    bitrate: { min: 1, max: 30000, recommendedMin: 100, recommendedMax: 5000 },
    maxPixels: 3840 * 2160,
  },
};

/**
 * 按像素数把分辨率映射到计费档位。
 *
 * 规则按 `maxPixels` 升序排列，返回第一个「上界 ≥ 像素数」的规则；
 * `maxPixels` 为 `null` 的规则视为无上界（最高档）。
 *
 * 用**像素数**而不是 preset key 判定，这样自定义分辨率也能得到正确档位 ——
 * 这是自由画质带来的关键正确性问题：靠 preset key 反查会在自定义参数下
 * 静默回落到 1080p 档，直接算错钱。
 */
export function tierRuleForPixels(
  rules: QualityTierRule[],
  width: number,
  height: number,
): QualityTierRule {
  const pixels = Math.max(0, Math.floor(width) * Math.floor(height));
  const sorted = [...rules].sort(
    (a, b) => (a.maxPixels ?? Number.POSITIVE_INFINITY) - (b.maxPixels ?? Number.POSITIVE_INFINITY),
  );
  for (const rule of sorted) {
    if (rule.maxPixels === null || pixels <= rule.maxPixels) return rule;
  }
  // 理论上不可达（最后一档 maxPixels 为 null），兜底返回最高档
  return sorted[sorted.length - 1];
}
