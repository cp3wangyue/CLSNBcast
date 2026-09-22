export type SessionStatus = 'pending' | 'active' | 'grace' | 'ended';

export interface SessionInfo {
  id: string;
  channel: string;
  sharerUsername: string;
  status: SessionStatus;
  viewerCount: number;
  peakViewers: number;
  totalViewerJoins: number;
  /** 所有观众在实际共享期间的累计在线毫秒；null 表示旧记录 */
  viewerDurationMs: number | null;
  quality: string;
  shareLink: string;
  viewLink: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  billingMinutes: number;
  billingDetail: string;
  /** 标准时长（分钟） */
  standardMinutes: number;
  /** 预估费用（元） */
  estimatedCost: number;
  allowedQualities?: string[];
  qualityBitrates?: Record<string, {
    bitrateMin?: number;
    bitrateMax?: number;
  }>;
  publisherClientId?: string;
  idleRemainingSec?: number;
  noViewerRemainingSec?: number;
  /** true=低延迟模式(rtc/互动直播)，false=极速直播(默认) */
  lowLatency?: boolean;
  /** 服务器是否允许开启低延迟模式 */
  allowLowLatency?: boolean;
  /** 服务端下发的画质预设（自由画质；替代前端硬编码档位表） */
  qualityPresets?: QualityPresetOption[];
  /** 自定义画质的参数边界，供前端做同样的两档校验 */
  qualityLimits?: QualityLimits;
}

export interface AgoraTokenResponse {
  token: string;
  channel: string;
  uid: number;
  appId: string;
  expireSec: number;
}

// ===== Usage Dashboard =====

export interface UsageDashboardRow {
  providerId: string;
  name: string;
  ownerType: string;
  ownerId: string;
  enabled: boolean;
  healthStatus: string;
  periodKey: string;
  standardMinutes: number;
  publisherMinutes: number;
  viewerMinutes: number;
  sessionCount: number;
  /** null = 不限量 */
  quotaMinutes: number | null;
  quotaEnforced: boolean;
  quotaExceeded: boolean;
  /** 配额未启用或不限量时为 null */
  quotaUsageRatio: number | null;
  lastUsedAt: number | null;
}

export interface UsageDashboard {
  period: string;
  timezone: string;
  rows: UsageDashboardRow[];
}

/** 分页/下钻用的会话账本明细。 */
export interface SessionUsageDetail {
  intervals: UsageInterval[];
  events: UsageEvent[];
}

export interface UsageIntervalRecorded {
  id: number;
  sessionId: string;
  providerId: string;
  serverId: string;
  role: 'publisher' | 'viewer';
  actorId: string;
  tier: string;
  billingModel: 'interactive' | 'ultra_low_latency';
  coefficient: number;
  periodKey: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  standardMs: number | null;
  closedReason: string | null;
}

// 前端使用的字段名与后端一致（下划线列已在服务端映射为驼峰）
export type UsageInterval = UsageIntervalRecorded;

export interface UsageEventRecorded {
  id: number;
  sessionId: string;
  providerId: string;
  serverId: string;
  role: 'publisher' | 'viewer';
  actorId: string;
  eventType: string;
  occurredAt: number;
  tier: string | null;
  lowLatency: number;
  detail: string;
}

export type UsageEvent = UsageEventRecorded;

// ===== Agora Provider =====

export type AgoraProviderOwnerType = 'platform' | 'space' | 'user';
export type AgoraProviderHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

/**
 * 管理端可见的 Provider 视图。
 *
 * ⚠️ 后端**只**返回 `hasAppCertificate` / `hasCustomerSecret` 布尔值，
 * 明文证书与 Customer Secret 没有任何读回接口。表单里留空即表示「保持不变」。
 */
export interface AgoraProvider {
  id: string;
  ownerType: AgoraProviderOwnerType;
  ownerId: string;
  name: string;
  appId: string;
  hasAppCertificate: boolean;
  customerId: string | null;
  hasCustomerSecret: boolean;
  enabled: boolean;
  priority: number;
  tokenExpireSec: number;
  healthStatus: AgoraProviderHealthStatus;
  healthCheckedAt: number | null;
  healthMessage: string;
  /** null = 不限量 */
  monthlyQuotaStandardMinutes: number | null;
  quotaEnforced: boolean;
  estimatedUsageStandardMinutes: number;
  usagePeriodKey: string;
  lastUsedAt: number | null;
  allowedPresetIds: string[] | null;
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** 新建 / 更新 Provider 的表单载荷。秘密字段留空表示不修改。 */
export interface AgoraProviderFormInput {
  ownerType?: AgoraProviderOwnerType;
  ownerId?: string;
  name: string;
  appId: string;
  appCertificate?: string;
  customerId?: string | null;
  customerSecret?: string;
  enabled?: boolean;
  priority?: number;
  tokenExpireSec?: number;
  monthlyQuotaStandardMinutes?: number | null;
  quotaEnforced?: boolean;
  note?: string;
}

// ===== Quality（自由画质）=====

/** Agora `VideoEncoderConfiguration` 的字段子集（Web SDK 可用的就这六个）。 */
export interface VideoEncoderConfiguration {
  width?: number;
  height?: number;
  frameRate?: number;
  /** Kbps */
  bitrateMin?: number;
  /** Kbps */
  bitrateMax?: number;
  scaleResolutionDownBy?: number;
}

export type QualityOptimizationMode = 'motion' | 'detail';
export type QualityCodec = 'h264' | 'vp8' | 'vp9';

/**
 * 服务端下发的画质预设。
 *
 * 用它替代原先前端硬编码的 `QUALITY_OPTIONS` —— 那份副本必须与后端
 * `QUALITY_PRESETS` 手工保持同步，是长期的双份真相来源。
 */
export interface QualityPresetOption {
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
  sortOrder: number;
  /** 服务端按分辨率推导的计费档位（展示用） */
  tier?: string;
}

/** 生效的画质参数快照。 */
export interface QualitySnapshot {
  source: 'preset' | 'custom';
  presetId: string | null;
  width: number;
  height: number;
  frameRate: number;
  bitrateMin: number | null;
  bitrateMax: number | null;
  optimizationMode: QualityOptimizationMode;
  codec: QualityCodec;
  tier: string;
}

/** 自定义画质入参。 */
export interface CustomQualityInput {
  width: number;
  height: number;
  frameRate: number;
  bitrateMin?: number | null;
  bitrateMax?: number | null;
  optimizationMode?: QualityOptimizationMode;
  codec?: QualityCodec;
}

/** 参数校验提示。`reject` 必须修正；`warn` 只是风险提示，不拦截。 */
export interface QualityIssue {
  field: string;
  severity: 'reject' | 'warn';
  code: string;
  message: string;
}

/** 自定义画质的参数边界，由服务端下发（前端用它做同样的两档校验）。 */
export interface QualityLimits {
  width: { min: number; max: number; step: number };
  height: { min: number; max: number; step: number };
  frameRate: { min: number; max: number; recommendedMin: number; recommendedMax: number };
  bitrate: { min: number; max: number; recommendedMin: number; recommendedMax: number };
  maxPixels: number;
}
