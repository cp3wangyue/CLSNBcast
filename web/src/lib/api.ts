import type {
  SessionInfo,
  AgoraTokenResponse,
  AgoraProvider,
  AgoraProviderFormInput,
  UsageDashboard,
  SessionUsageDetail,
  QualityPresetOption,
  QualitySnapshot,
  CustomQualityInput,
  QualityIssue,
  QualityLimits,
  QualityOptimizationMode,
  QualityCodec,
} from '../types';

const SUPER_TOKEN_KEY = 'clsnbcast_super_token';
export type Platform = 'kook' | 'qq' | 'discord';

export function getSuperAdminToken(): string | null {
  return localStorage.getItem(SUPER_TOKEN_KEY);
}

export function clearSuperAdminToken(): void {
  localStorage.removeItem(SUPER_TOKEN_KEY);
}

export function getServerAdminToken(serverId: string): string | null {
  return localStorage.getItem(`clsnbcast_server_${serverId}`);
}

export function setServerAdminToken(serverId: string, token: string): void {
  localStorage.setItem(`clsnbcast_server_${serverId}`, token);
}

export function clearServerAdminToken(serverId: string): void {
  localStorage.removeItem(`clsnbcast_server_${serverId}`);
}

function getSpaceAdminTokenKey(platform: Platform, externalId: string): string {
  return `clsnbcast_space_${platform}_${externalId}`;
}

export function getSpaceAdminToken(platform: Platform, externalId: string): string | null {
  const token = localStorage.getItem(getSpaceAdminTokenKey(platform, externalId));
  if (token) return token;
  if (platform !== 'kook') return null;
  const legacy = getServerAdminToken(externalId);
  if (legacy) {
    localStorage.setItem(getSpaceAdminTokenKey(platform, externalId), legacy);
  }
  return legacy;
}

export function setSpaceAdminToken(platform: Platform, externalId: string, token: string): void {
  localStorage.setItem(getSpaceAdminTokenKey(platform, externalId), token);
}

export function clearSpaceAdminToken(platform: Platform, externalId: string): void {
  localStorage.removeItem(getSpaceAdminTokenKey(platform, externalId));
  if (platform === 'kook') clearServerAdminToken(externalId);
}

export class ApiError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

/** 将后端错误映射为面向用户的友好文案 */
function mapFriendlyMessage(statusCode: number, serverMsg: string): string {
  const msg = (serverMsg || '').toLowerCase();
  if (statusCode === 401) {
    if (msg.includes('ended') || msg.includes('失效') || msg.includes('结束')) {
      return '共享已结束，链接已失效';
    }
    return '链接无效或无权限访问';
  }
  if (statusCode === 403) return '无权限访问';
  if (statusCode === 404) return '资源不存在或链接已失效';
  if (statusCode === 429) return '操作过于频繁，请稍后再试';
  if (statusCode >= 500) return '服务器暂时不可用，请稍后重试';
  return serverMsg || '请求失败，请稍后重试';
}

async function request<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let serverMsg = '';
    let statusCode = res.status;
    try {
      const data = await res.json();
      serverMsg = data?.message || data?.error || '';
      if (typeof data?.statusCode === 'number') statusCode = data.statusCode;
    } catch {
      try {
        serverMsg = await res.text();
      } catch {
        serverMsg = res.statusText;
      }
    }
    throw new ApiError(statusCode, mapFriendlyMessage(statusCode, serverMsg));
  }
  return res.json() as Promise<T>;
}

async function superRequest<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  const token = localStorage.getItem(SUPER_TOKEN_KEY);
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let serverMsg = '';
    try {
      const data = await res.json();
      serverMsg = data?.message || '';
    } catch {
      serverMsg = res.statusText;
    }
    throw new ApiError(res.status, serverMsg);
  }
  return res.json() as Promise<T>;
}

async function serverRequest<T>(
  serverId: string,
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  const token = getServerAdminToken(serverId);
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let serverMsg = '';
    try {
      const data = await res.json();
      serverMsg = data?.message || '';
    } catch {
      serverMsg = res.statusText;
    }
    throw new ApiError(res.status, serverMsg);
  }
  return res.json() as Promise<T>;
}

async function spaceRequest<T>(
  platform: Platform,
  externalId: string,
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  const token = getSpaceAdminToken(platform, externalId);
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let serverMsg = '';
    try {
      const data = await res.json();
      serverMsg = data?.message || '';
    } catch {
      serverMsg = res.statusText;
    }
    throw new ApiError(res.status, serverMsg);
  }
  return res.json() as Promise<T>;
}

function spaceApiBase(platform: Platform, externalId: string): string {
  return `/api/spaces/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}`;
}

export const api = {
  // ===== Share API =====
  getShareInfo(token: string): Promise<SessionInfo> {
    return request('/api/share/info?t=' + encodeURIComponent(token));
  },
  getShareToken(
    token: string,
    role: 'publisher' | 'subscriber',
  ): Promise<AgoraTokenResponse> {
    return request(
      '/api/share/token?t=' + encodeURIComponent(token) + '&role=' + role,
    );
  },

  /** 发布端开始共享（替代原 WebSocket sharing_started）。
   *  `customQuality` 传入时走自定义画质，否则用 `quality`（预设 id）。 */
  startSharing(
    token: string,
    quality?: string,
    clientId?: string,
    lowLatency?: boolean,
    customQuality?: CustomQualityInput,
  ): Promise<{ ok: boolean; message?: string; quality?: QualitySnapshot; warnings?: QualityIssue[] }> {
    return request('/api/share/start?t=' + encodeURIComponent(token), {
      method: 'POST',
      body: JSON.stringify({ quality, clientId, lowLatency, customQuality }),
    });
  },

  /** 共享进行中动态切换编码参数（分辨率 / 帧率 / 码率）。
   *  optimizationMode 与 codec 不支持运行中切换。 */
  updateLiveQuality(
    token: string,
    input: {
      width?: number;
      height?: number;
      frameRate?: number;
      bitrateMin?: number | null;
      bitrateMax?: number | null;
    },
  ): Promise<{ ok: boolean; message?: string; quality?: QualitySnapshot }> {
    return request('/api/share/quality?t=' + encodeURIComponent(token), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  /** 发布端停止共享（替代原 WebSocket sharing_stopped） */
  stopSharing(token: string): Promise<{ ok: boolean }> {
    return request('/api/share/stop?t=' + encodeURIComponent(token), {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  getNotices(page: 'server_admin' | 'share' | 'view'): Promise<any[]> {
    return request('/api/notices?page=' + encodeURIComponent(page));
  },
  getAdminMigration(): Promise<{ legacyAdminSunsetAt: number; canonicalPlatform: string }> {
    return request('/api/meta/admin-migration');
  },

  // ===== Super Admin API =====
  superLogin(password: string): Promise<{ ok: boolean; token?: string; message?: string }> {
    return superRequest('/api/super/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },
  getSuperConfig(): Promise<any> {
    return superRequest('/api/super/config');
  },
  updateSuperConfig(config: any): Promise<{ ok: boolean }> {
    return superRequest('/api/super/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },
  getSuperServers(): Promise<any[]> {
    return superRequest('/api/super/servers');
  },
  getSuperSpaces(platform?: Platform): Promise<any[]> {
    const qs = platform ? `?platform=${encodeURIComponent(platform)}` : '';
    return superRequest('/api/super/spaces' + qs);
  },
  getSuperSpace(platform: Platform, externalId: string): Promise<any> {
    return superRequest(`/api/super/spaces/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}`);
  },
  getSuperSpaceEvents(platform: Platform, externalId: string): Promise<any[]> {
    return superRequest(`/api/super/spaces/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}/events`);
  },
  getSuperSpaceSessions(platform: Platform, externalId: string): Promise<any[]> {
    return superRequest(`/api/super/spaces/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}/sessions`);
  },
  updateSuperSpace(platform: Platform, externalId: string, config: any): Promise<{ ok: boolean }> {
    return superRequest(`/api/super/spaces/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },
  deleteSuperSpace(platform: Platform, externalId: string): Promise<{ ok: boolean }> {
    return superRequest(`/api/super/spaces/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}`, {
      method: 'DELETE',
    });
  },
  getSuperNotices(): Promise<any[]> {
    return superRequest('/api/super/notices');
  },
  createSuperNotice(notice: any): Promise<any> {
    return superRequest('/api/super/notices', {
      method: 'POST',
      body: JSON.stringify(notice),
    });
  },
  updateSuperNotice(id: string, notice: any): Promise<any> {
    return superRequest('/api/super/notices/' + encodeURIComponent(id), {
      method: 'PUT',
      body: JSON.stringify(notice),
    });
  },
  deleteSuperNotice(id: string): Promise<{ ok: boolean }> {
    return superRequest('/api/super/notices/' + encodeURIComponent(id), {
      method: 'DELETE',
    });
  },
  reorderSuperNotices(ids: string[]): Promise<{ ok: boolean }> {
    return superRequest('/api/super/notices/order', {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    });
  },
  republishSuperNotice(id: string): Promise<any> {
    return superRequest('/api/super/notices/' + encodeURIComponent(id) + '/republish', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  getSuperServer(serverId: string): Promise<any> {
    return superRequest('/api/super/servers/' + serverId);
  },
  getSuperServerEvents(serverId: string): Promise<any[]> {
    return superRequest('/api/super/servers/' + serverId + '/events');
  },
  getSuperServerSessions(serverId: string): Promise<any[]> {
    return superRequest('/api/super/servers/' + serverId + '/sessions');
  },
  updateSuperServer(serverId: string, config: any): Promise<{ ok: boolean }> {
    return superRequest('/api/super/servers/' + serverId, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },
  deleteSuperServer(serverId: string): Promise<{ ok: boolean }> {
    return superRequest('/api/super/servers/' + serverId, { method: 'DELETE' });
  },
  getSuperSessions(): Promise<any[]> {
    return superRequest('/api/super/sessions');
  },

  // ===== Server Admin API =====
  getServerStatus(serverId: string, token?: string): Promise<{ exists: boolean; bound?: boolean; guildName?: string; tokenValid?: boolean }> {
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    return serverRequest(serverId, `/api/server/${serverId}/status${qs}`);
  },
  bindServer(serverId: string, password: string, token?: string): Promise<{ ok: boolean; message?: string }> {
    return serverRequest(serverId, `/api/server/${serverId}/bind`, {
      method: 'POST',
      body: JSON.stringify({ password, token }),
    });
  },
  serverAdminLogin(serverId: string, password: string): Promise<{ ok: boolean; token?: string; message?: string }> {
    return serverRequest(serverId, `/api/server/${serverId}/login`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },
  getServerConfig(serverId: string): Promise<any> {
    return serverRequest(serverId, `/api/server/${serverId}/config`);
  },
  updateServerConfig(serverId: string, config: any): Promise<{ ok: boolean }> {
    return serverRequest(serverId, `/api/server/${serverId}/config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },
  getServerSessions(serverId: string): Promise<any[]> {
    return serverRequest(serverId, `/api/server/${serverId}/sessions`);
  },

  // ===== Canonical Platform Space Admin API =====
  getSpaceStatus(
    platform: Platform,
    externalId: string,
    token?: string,
  ): Promise<{ exists: boolean; bound?: boolean; guildName?: string; openId?: string; tokenValid?: boolean }> {
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + `/status${qs}`);
  },
  bindSpace(
    platform: Platform,
    externalId: string,
    password: string,
    token?: string,
  ): Promise<{ ok: boolean; message?: string }> {
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + '/bind', {
      method: 'POST',
      body: JSON.stringify({ password, token }),
    });
  },
  spaceAdminLogin(
    platform: Platform,
    externalId: string,
    password: string,
  ): Promise<{ ok: boolean; token?: string; message?: string }> {
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + '/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },
  getSpaceConfig(platform: Platform, externalId: string): Promise<any> {
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + '/config');
  },
  updateSpaceConfig(platform: Platform, externalId: string, config: any): Promise<{ ok: boolean }> {
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + '/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },
  getSpaceSessions(platform: Platform, externalId: string): Promise<any[]> {
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + '/sessions');
  },

  // ===== Agora Provider（超管）=====
  getSuperProviders(): Promise<AgoraProvider[]> {
    return superRequest('/api/super/providers');
  },
  createSuperProvider(input: AgoraProviderFormInput): Promise<{ ok: boolean; provider: AgoraProvider }> {
    return superRequest('/api/super/providers', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateSuperProvider(
    id: string,
    input: Partial<AgoraProviderFormInput>,
  ): Promise<{ ok: boolean; provider?: AgoraProvider; message?: string }> {
    return superRequest('/api/super/providers/' + encodeURIComponent(id), {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },
  deleteSuperProvider(id: string): Promise<{ ok: boolean; message?: string }> {
    return superRequest('/api/super/providers/' + encodeURIComponent(id), { method: 'DELETE' });
  },

  // ===== Agora Provider（频道主 BYOK）=====
  // 归属由服务端强制绑定到该服务器，前端不传也传不了 ownerType / ownerId
  getSpaceProviders(platform: Platform, externalId: string): Promise<AgoraProvider[]> {
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + '/providers');
  },
  createSpaceProvider(
    platform: Platform,
    externalId: string,
    input: AgoraProviderFormInput,
  ): Promise<{ ok: boolean; provider?: AgoraProvider; message?: string }> {
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + '/providers', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateSpaceProvider(
    platform: Platform,
    externalId: string,
    id: string,
    input: Partial<AgoraProviderFormInput>,
  ): Promise<{ ok: boolean; provider?: AgoraProvider; message?: string }> {
    return spaceRequest(
      platform,
      externalId,
      spaceApiBase(platform, externalId) + '/providers/' + encodeURIComponent(id),
      { method: 'PUT', body: JSON.stringify(input) },
    );
  },
  deleteSpaceProvider(
    platform: Platform,
    externalId: string,
    id: string,
  ): Promise<{ ok: boolean; message?: string }> {
    return spaceRequest(
      platform,
      externalId,
      spaceApiBase(platform, externalId) + '/providers/' + encodeURIComponent(id),
      { method: 'DELETE' },
    );
  },

  // ===== Quality Presets（超管）=====
  getSuperQualities(): Promise<QualityPresetOption[]> {
    return superRequest('/api/super/qualities');
  },
  createSuperQuality(input: {
    id: string; label: string; width: number; height: number; frameRate: number;
    bitrateMin?: number | null; bitrateMax?: number | null;
    optimizationMode?: QualityOptimizationMode; codec?: QualityCodec;
    enabled?: boolean; sortOrder?: number;
  }): Promise<{ ok: boolean; preset?: QualityPresetOption; message?: string }> {
    return superRequest('/api/super/qualities', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateSuperQuality(
    id: string,
    input: Partial<{
      label: string; width: number; height: number; frameRate: number;
      bitrateMin: number | null; bitrateMax: number | null;
      optimizationMode: QualityOptimizationMode; codec: QualityCodec;
      enabled: boolean; sortOrder: number;
    }>,
  ): Promise<{ ok: boolean; preset?: QualityPresetOption; message?: string }> {
    return superRequest('/api/super/qualities/' + encodeURIComponent(id), {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },
  deleteSuperQuality(id: string): Promise<{ ok: boolean; message?: string }> {
    return superRequest('/api/super/qualities/' + encodeURIComponent(id), { method: 'DELETE' });
  },

  // ===== Usage Dashboard（超管）=====
  getSuperUsage(period?: string): Promise<UsageDashboard> {
    const qs = period ? `?period=${encodeURIComponent(period)}` : '';
    return superRequest('/api/super/usage' + qs);
  },
  rebuildSuperUsage(period?: string): Promise<{ ok: boolean; period: string }> {
    const qs = period ? `?period=${encodeURIComponent(period)}` : '';
    return superRequest('/api/super/usage/rebuild' + qs, { method: 'POST' });
  },
  getSuperSessionUsage(sessionId: string): Promise<SessionUsageDetail> {
    return superRequest('/api/super/usage/sessions/' + encodeURIComponent(sessionId));
  },
};
