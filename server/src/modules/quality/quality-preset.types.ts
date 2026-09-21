export type QualityOptimizationMode = 'motion' | 'detail';
export type QualityCodec = 'h264' | 'vp8' | 'vp9';

/** 画质预设（建在 `quality_presets` 表）。 */
export interface QualityPreset {
  /** 沿用现有 preset key，如 `1080p_2`。写入后不可改。 */
  id: string;
  label: string;
  width: number;
  height: number;
  frameRate: number;
  /** null = 不向 Agora 传递该项 */
  bitrateMin: number | null;
  bitrateMax: number | null;
  optimizationMode: QualityOptimizationMode;
  codec: QualityCodec;
  enabled: boolean;
  isBuiltin: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** 会话上的画质参数**快照**：预设与自定义都用它，写入后不可变。 */
export interface QualitySnapshot {
  /** 'preset' 或 'custom' */
  source: 'preset' | 'custom';
  /** source='preset' 时为预设 id；custom 时为 null */
  presetId: string | null;
  width: number;
  height: number;
  frameRate: number;
  /** null = 不传 */
  bitrateMin: number | null;
  bitrateMax: number | null;
  optimizationMode: QualityOptimizationMode;
  codec: QualityCodec;
  /** 计费档位：由分辨率推导并固化，避免事后改档位规则影响历史账目 */
  tier: string;
}

/** 自定义画质的入参（未经校验）。 */
export interface CustomQualityInput {
  width: number;
  height: number;
  frameRate: number;
  bitrateMin?: number | null;
  bitrateMax?: number | null;
  optimizationMode?: QualityOptimizationMode;
  codec?: QualityCodec;
}

/**
 * 参数校验问题。
 *
 * `severity='reject'` 必须拒绝（400）；
 * `severity='warn'` **只提示不拦截** —— 超出声网建议范围的参数要尊重用户选择。
 */
export interface QualityIssue {
  field: string;
  severity: 'reject' | 'warn';
  code: string;
  message: string;
}
