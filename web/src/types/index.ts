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
}

export interface AgoraTokenResponse {
  token: string;
  channel: string;
  uid: number;
  appId: string;
  expireSec: number;
}

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
