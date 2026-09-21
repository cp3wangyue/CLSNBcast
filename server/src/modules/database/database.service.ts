import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import { join, resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { getDefaultQualityBitrates, QualityBitrateConfig } from '../session/session.types';
import { runMigrations } from './migration-runner';
import { MIGRATIONS } from './migrations';
import { parseTriggerWords, setGlobalConfig } from './migrations/helpers';

// ===== Types =====

export interface GlobalConfig {
  kookBotToken: string;
  kookVerifyToken: string;
  kookEncryptKey: string;
  publicDomain: string;
  triggerWordLabels: string[];
  qualityBitrates: QualityBitrateConfig;
  legacyAdminSunsetAt: number;
}

export interface KookWebhookEventRecord {
  eventKey: string;
  sn: number | null;
  eventType: string;
  payload: string;
  attempts: number;
}

export interface ServerRecord {
  serverId: string;       // 兼容字段：内部 spaceId，现有 KOOK 数据仍等于 guild_id
  platform: string;       // 'kook'，未来可扩展 'qq' | 'discord'
  externalId: string;     // 平台外部 ID；KOOK 为 guild_id 雪花 ID
  openId: string;         // open_id 公开 ID（用于面板显示）
  guildName: string;
  ownerId: string;
  ownerUsername: string;
  passwordHash: string;
  bound: number; // 0 or 1
  status: string; // 'active' | 'kicked'
  agoraAppId: string;
  agoraAppCertificate: string;
  agoraTokenExpireSec: number;
  allowedQualities: string; // JSON array
  triggerWords: string;
  idleTimeoutSec: number;
  heartbeatIntervalSec: number;
  noViewerTimeoutSec: number;
  publicDomain: string;
  allowLowLatency: number; // 0=不允许低延迟模式，1=允许共享者切换
  reboundAt: number;      // 重新绑定时间戳（被踢出后重新绑定时记录，用于过滤旧会话）
  bindToken: string;      // 绑定临时 token
  bindTokenExpires: number; // 绑定 token 过期时间戳
  serverSecret: string;   // 每服务器独立的 HMAC 签名密钥
  createdAt: number;
  updatedAt: number;
}

export type NoticeKind = 'banner' | 'modal';
export type NoticeModalPolicy = 'dismissible' | 'acknowledgement_required';
export type NoticeContentFormat = 'text' | 'html';
export type NoticeTargetPage = 'server_admin' | 'share' | 'view';

export interface NoticeRecord {
  id: string;
  kind: NoticeKind;
  modalPolicy: NoticeModalPolicy | null;
  title: string;
  contentFormat: NoticeContentFormat;
  content: string;
  imageUrl: string;
  enabled: number;
  sortOrder: number;
  repeatAfterSec: number | null;
  revision: number;
  targets: NoticeTargetPage[];
  createdAt: number;
  updatedAt: number;
}

export interface NoticeWriteInput {
  kind: NoticeKind;
  modalPolicy?: NoticeModalPolicy | null;
  title?: string;
  contentFormat: NoticeContentFormat;
  content: string;
  imageUrl?: string;
  enabled: boolean;
  sortOrder: number;
  repeatAfterSec?: number | null;
  targets: NoticeTargetPage[];
}

export interface ServerEvent {
  id: number;
  serverId: string;
  eventType: string; // 'bot_joined' | 'bot_kicked' | 'bot_left'
  operatorId: string;
  operatorName: string;
  detail: string;
  createdAt: number;
}

export interface ServerSession {
  id: string;
  token: string;
  channel: string;
  serverId: string;
  sharerUserId: string;
  sharerUsername: string;
  guildId: string;
  targetChannelId: string;
  status: string;
  viewerCount: number;
  peakViewers: number;
  totalViewerJoins: number;
  /** 所有观众在 ACTIVE 状态下的累计在线毫秒；null 表示旧记录没有该数据 */
  viewerDurationMs: number | null;
  quality: string;
  cardMessageId: string | null;
  manualCreated: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  lastHeartbeat: number;
  graceStartedAt: number | null;
  graceReason: string | null;
  lastViewerAt: number | null;
  publisherClientId: string | null;
  lowLatency: number; // 0=极速直播(默认)，1=低延迟模式(rtc)
  /**
   * 创建时固定选定的 Agora Provider。
   *
   * ⚠️ 与 `agoraAppId` 一起构成「同一 Session 必须使用同一个 App ID」的不变量载体，
   * **刻意不加入 `ALLOWED_SESSION_COLS`**，因此 `updateSession` 无法修改它们。
   * 唯一写入路径是 `bindSessionProvider()`，只在会话创建时调用一次。
   */
  providerId: string;
  /** 创建时的 App ID 快照。签发 Token 前会与 Provider 当前 App ID 比对，不一致就拒绝。 */
  agoraAppId: string;
}

// ===== Agora Provider =====

/** Provider 归属：平台全局池 / 某个 KOOK 服务器自带 / 用户 BYOK。 */
export type AgoraProviderOwnerType = 'platform' | 'space' | 'user';

export type AgoraProviderHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

/**
 * `agora_providers` 表的一行。
 *
 * 注意 `appCertificateEnc` / `customerSecretEnc` 是**密文**：数据层不感知加密，
 * 只负责原样存取。加解密由 `AgoraProviderService` 统一负责，明文只在那一个服务里出现。
 */
export interface AgoraProviderRecord {
  id: string;
  ownerType: AgoraProviderOwnerType;
  ownerId: string;
  name: string;
  appId: string;
  appCertificateEnc: string;
  customerId: string | null;
  customerSecretEnc: string | null;
  enabled: number;
  priority: number;
  tokenExpireSec: number;
  healthStatus: AgoraProviderHealthStatus;
  healthCheckedAt: number | null;
  healthMessage: string;
  /** NULL = 不限量 */
  monthlyQuotaStandardMinutes: number | null;
  quotaEnforced: number;
  estimatedUsageStandardMinutes: number;
  usagePeriodKey: string;
  lastUsedAt: number | null;
  /** JSON 数组字符串；null = 不限制可用画质 */
  allowedPresetIds: string | null;
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** 新建 Provider 的入参（密文字段由上层加密后传入）。 */
export interface AgoraProviderCreateInput {
  id: string;
  ownerType: AgoraProviderOwnerType;
  ownerId?: string;
  name: string;
  appId: string;
  appCertificateEnc: string;
  customerId?: string | null;
  customerSecretEnc?: string | null;
  enabled?: boolean;
  priority?: number;
  tokenExpireSec?: number;
  monthlyQuotaStandardMinutes?: number | null;
  quotaEnforced?: boolean;
  allowedPresetIds?: string[] | null;
  note?: string;
}

// ===== Service =====

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly db: Database.Database;

  constructor() {
    // 数据目录可用 DATA_DIR 覆盖：测试用临时目录隔离，部署时也可把数据放到挂载卷的任意位置。
    const dataDir = process.env.DATA_DIR
      ? resolve(process.env.DATA_DIR)
      : join(process.cwd(), 'data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = join(dataDir, 'clsnbcast.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
    this.logger.log(`SQLite database ready at ${dbPath}`);
  }

  onModuleDestroy() {
    if (this.db) {
      this.db.close();
      this.logger.log('SQLite database closed');
    }
  }

  /**
   * 执行版本化迁移。迁移逻辑与注册表见 ./migrations，运行器见 ./migration-runner。
   * 原有手写幂等迁移已整体搬入 version 1（baseline），行为不变。
   */
  private migrate() {
    const result = runMigrations(this.db, MIGRATIONS, (message) => this.logger.log(message));
    if (result.applied.length > 0) {
      this.logger.log(
        `Applied ${result.applied.length} migration(s): ` +
          result.applied.map((entry) => `${entry.version}:${entry.name}`).join(', '),
      );
    }
    this.logger.log(`Schema version: ${result.schemaVersion}`);
  }

  // ===== Global Config =====

  getGlobalConfig(): GlobalConfig {
    const rows = this.db.prepare('SELECT key, value FROM global_config').all() as any[];
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.key, r.value);
    return {
      kookBotToken: map.get('kookBotToken') || '',
      kookVerifyToken: map.get('kookVerifyToken') || '',
      kookEncryptKey: map.get('kookEncryptKey') || '',
      publicDomain: map.get('publicDomain') || 'http://localhost:3520',
      triggerWordLabels: this.parseTriggerWordLabels(map.get('triggerWordLabels')),
      qualityBitrates: this.parseQualityBitrates(map.get('qualityBitrates')),
      legacyAdminSunsetAt: Number(map.get('legacyAdminSunsetAt')) || 0,
    };
  }

  private parseTriggerWordLabels(value?: string): string[] {
    if (!value) return ['屏幕共享', '共享屏幕'];
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        const labels = [...new Set(parsed.map(String).map(word => word.trim()).filter(Boolean))];
        if (labels.length > 0) return labels;
      }
    } catch {
      // Fall through to legacy comma-separated values.
    }
    const legacy = parseTriggerWords(value);
    return legacy.length > 0 ? legacy : ['屏幕共享', '共享屏幕'];
  }

  setTriggerWordLabels(labels: string[]): void {
    const normalized = [...new Set(labels.map(word => word.trim()).filter(Boolean))];
    const allowed = new Set(normalized);
    const servers = this.db.prepare('SELECT server_id, trigger_words FROM servers').all() as any[];
    const update = this.db.prepare('UPDATE servers SET trigger_words = ?, updated_at = ? WHERE server_id = ?');
    const apply = this.db.transaction(() => {
      this.setGlobalConfig('triggerWordLabels', JSON.stringify(normalized));
      for (const server of servers) {
        let enabled = parseTriggerWords(server.trigger_words).filter(word => allowed.has(word));
        if (enabled.length === 0 && normalized.length > 0) enabled = [normalized[0]];
        update.run(enabled.join(','), Date.now(), server.server_id);
      }
    });
    apply();
  }

  private parseQualityBitrates(value?: string): QualityBitrateConfig {
    if (!value) return getDefaultQualityBitrates();
    try {
      return JSON.parse(value);
    } catch {
      this.logger.warn('Invalid qualityBitrates global config; using defaults');
      return getDefaultQualityBitrates();
    }
  }

  setGlobalConfig(key: string, value: string): void {
    setGlobalConfig(this.db, key, value);
  }

  // ===== Servers =====

  getServer(serverId: string): ServerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM servers WHERE server_id = ?').get(serverId) as any;
    if (!row) return undefined;
    return this.mapServerRow(row);
  }

  listServers(): ServerRecord[] {
    const rows = this.db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all() as any[];
    return rows.map(row => this.mapServerRow(row));
  }

  getSpace(platform: string, externalId: string): ServerRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM servers WHERE platform = ? AND external_id = ?',
    ).get(platform, externalId) as any;
    if (!row) return undefined;
    return this.mapServerRow(row);
  }

  listSpaces(platform?: string): ServerRecord[] {
    const rows = platform
      ? this.db.prepare('SELECT * FROM servers WHERE platform = ? ORDER BY created_at DESC').all(platform) as any[]
      : this.db.prepare('SELECT * FROM servers ORDER BY platform, created_at DESC').all() as any[];
    return rows.map(row => this.mapServerRow(row));
  }

  /**
   * 还持有**明文** Agora 凭证的服务器。
   *
   * 用于两件事：把存量凭证迁入 Provider 池，以及在没有主密钥时告警
   * （无法加密 → 迁移不了，必须让运维知道）。
   */
  listServersWithPlaintextCredentials(): ServerRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM servers WHERE agora_app_id != '' AND agora_app_certificate != ''")
      .all() as any[];
    return rows.map((row) => this.mapServerRow(row));
  }

  /**
   * 清空服务器的明文证书。
   *
   * Token 签发自 Phase 1-3 起改为从 Provider 读取，`servers.agora_app_certificate`
   * 已不再是任何代码的输入，因此现在调用它总是安全的。
   */
  clearServerCertificate(serverId: string): void {
    this.db
      .prepare("UPDATE servers SET agora_app_certificate = '', updated_at = ? WHERE server_id = ?")
      .run(Date.now(), serverId);
  }

  /** 将数据库行（下划线字段名）映射为 ServerSession（驼峰字段名） */
  private mapSessionRow(row: any): ServerSession {
    return {
      id: row.id,
      token: row.token,
      channel: row.channel,
      serverId: row.server_id,
      sharerUserId: row.sharer_user_id,
      sharerUsername: row.sharer_username,
      guildId: row.guild_id,
      targetChannelId: row.target_channel_id,
      status: row.status,
      viewerCount: row.viewer_count,
      peakViewers: row.peak_viewers,
      totalViewerJoins: row.total_viewer_joins,
      viewerDurationMs: row.viewer_duration_ms ?? null,
      quality: row.quality,
      cardMessageId: row.card_message_id,
      manualCreated: row.manual_created,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
      lastHeartbeat: row.last_heartbeat,
      graceStartedAt: row.grace_started_at,
      graceReason: row.grace_reason,
      lastViewerAt: row.last_viewer_at,
      publisherClientId: row.publisher_client_id,
      lowLatency: row.low_latency ?? 0,
      // 旧记录（迁移 002 之前）没有这两列，回退为空串表示「未绑定 Provider」
      providerId: row.provider_id ?? '',
      agoraAppId: row.agora_app_id ?? '',
    };
  }

  /** 将数据库行（下划线字段名）映射为 ServerRecord（驼峰字段名） */
  private mapServerRow(row: any): ServerRecord {
    return {
      serverId: row.server_id,
      platform: row.platform || 'kook',
      externalId: row.external_id || row.server_id,
      openId: row.open_id,
      guildName: row.guild_name,
      ownerId: row.owner_id,
      ownerUsername: row.owner_username,
      passwordHash: row.password_hash,
      bound: row.bound,
      status: row.status || 'active',
      agoraAppId: row.agora_app_id,
      agoraAppCertificate: row.agora_app_certificate,
      agoraTokenExpireSec: row.agora_token_expire_sec,
      allowedQualities: row.allowed_qualities,
      triggerWords: row.trigger_words,
      idleTimeoutSec: row.idle_timeout_sec,
      heartbeatIntervalSec: row.heartbeat_interval_sec,
      noViewerTimeoutSec: row.no_viewer_timeout_sec,
      publicDomain: row.public_domain,
      allowLowLatency: row.allow_low_latency ?? 0,
      reboundAt: row.rebound_at ?? 0,
      bindToken: row.bind_token ?? '',
      bindTokenExpires: row.bind_token_expires ?? 0,
      serverSecret: row.server_secret ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 创建服务器记录
   * @param serverId guild_id 雪花 ID（主键，用于 URL）
   * @param guildName 服务器名称
   * @param ownerId 服务器主 user_id
   * @param ownerUsername 服务器主用户名
   * @param openId open_id 公开 ID（用于面板显示）
   */
  createServer(serverId: string, guildName: string, ownerId: string, ownerUsername: string, openId?: string): ServerRecord {
    const now = Date.now();
    const globalCfg = this.getGlobalConfig();
    
    // 检查是否是重新加入的服务器（之前被踢出）
    const existing = this.getServer(serverId);
    if (existing) {
      if (existing.status === 'kicked') {
        // 重新激活被踢出的服务器
        this.activateServer(serverId);
        // 更新服务器信息
        this.updateServer(serverId, {
          guildName: guildName || existing.guildName,
          ownerId: ownerId || existing.ownerId,
          ownerUsername: ownerUsername || existing.ownerUsername,
          openId: openId || existing.openId,
        });
        this.logger.log(`Reactivated kicked server ${serverId}`);
        return this.getServer(serverId)!;
      }
      // 已存在的活跃服务器，直接返回
      return existing;
    }
    
    const serverSecret = randomBytes(32).toString('hex');
    this.db.prepare(`
      INSERT INTO servers (
        server_id, platform, external_id, open_id, guild_name, owner_id,
        owner_username, bound, status, public_domain, trigger_words,
        server_secret, created_at, updated_at
      )
      VALUES (?, 'kook', ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?, ?)
    `).run(
      serverId,
      serverId,
      openId || '',
      guildName,
      ownerId,
      ownerUsername,
      globalCfg.publicDomain,
      globalCfg.triggerWordLabels.join(','),
      serverSecret,
      now,
      now,
    );
    return this.getServer(serverId)!;
  }

  private readonly ALLOWED_SERVER_COLS = new Set([
    'owner_id', 'owner_username', 'guild_name', 'open_id',
    'password_hash', 'bound', 'status',
    // ⚠️ 刻意排除 agora_app_id / agora_app_certificate / agora_token_expire_sec：
    // 凭证自 Phase 1 起归 `agora_providers` 所有，这三列降级为「只读的历史字段」，
    // 唯一写入者是存量迁移与 clearServerCertificate()（都走直接 SQL）。
    // 留在白名单里会形成一条**明文证书**的写入路径。
    'allowed_qualities', 'trigger_words',
    'idle_timeout_sec', 'heartbeat_interval_sec', 'no_viewer_timeout_sec',
    'public_domain', 'allow_low_latency',
    'rebound_at', 'bind_token', 'bind_token_expires',
    'server_secret',
    'updated_at',
  ]);

  updateServer(serverId: string, fields: Partial<ServerRecord>): void {
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, val] of Object.entries(fields)) {
      if (key === 'serverId') continue;
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (!this.ALLOWED_SERVER_COLS.has(col)) {
        this.logger.warn(`updateServer: rejected unknown column "${col}"`);
        continue;
      }
      sets.push(`${col} = ?`);
      values.push(val);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(Date.now());
    values.push(serverId);
    this.db.prepare(`UPDATE servers SET ${sets.join(', ')} WHERE server_id = ?`).run(...values);
  }

  /** 标记服务器为已踢出，重置绑定状态（不删除记录） */
  kickServer(serverId: string): void {
    this.db.prepare("UPDATE servers SET status = 'kicked', bound = 0, password_hash = '', updated_at = ? WHERE server_id = ?").run(Date.now(), serverId);
    this.logger.log(`Marked server ${serverId} as kicked, reset binding state`);
  }

  /** 恢复服务器为活跃状态（机器人重新加入） */
  activateServer(serverId: string): void {
    this.db.prepare("UPDATE servers SET status = 'active', updated_at = ? WHERE server_id = ?").run(Date.now(), serverId);
    this.logger.log(`Reactivated server ${serverId}`);
  }

  /** 生成绑定临时 token（10 分钟有效） */
  generateBindToken(serverId: string): string {
    const token = randomBytes(32).toString('hex');
    const expires = Date.now() + 10 * 60 * 1000; // 10 分钟
    this.db.prepare("UPDATE servers SET bind_token = ?, bind_token_expires = ?, updated_at = ? WHERE server_id = ?")
      .run(token, expires, Date.now(), serverId);
    this.logger.log(`Generated bind token for server ${serverId}, expires at ${new Date(expires).toISOString()}`);
    return token;
  }

  /** 校验绑定 token 是否有效 */
  validateBindToken(serverId: string, token: string): boolean {
    const server = this.getServer(serverId);
    if (!server) return false;
    if (!server.bindToken || server.bindToken !== token) return false;
    if (server.bindTokenExpires < Date.now()) return false;
    return true;
  }

  /** 清空绑定 token（绑定成功后调用） */
  clearBindToken(serverId: string): void {
    this.db.prepare("UPDATE servers SET bind_token = '', bind_token_expires = 0, updated_at = ? WHERE server_id = ?")
      .run(Date.now(), serverId);
  }

  /** 获取指定服务器本次绑定后的会话列表（reboundAt > 0 时过滤旧会话） */
  getSessionsByServerFiltered(serverId: string, reboundAt: number): ServerSession[] {
    if (reboundAt <= 0) {
      return this.getSessionsByServer(serverId);
    }
    const rows = this.db.prepare('SELECT * FROM sessions WHERE server_id = ? AND created_at >= ? ORDER BY created_at DESC')
      .all(serverId, reboundAt) as any[];
    return rows.map(row => this.mapSessionRow(row));
  }

  /** 彻底删除服务器及其会话（仅超级管理员手动操作） */
  deleteServer(serverId: string): void {
    const remove = this.db.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE server_id = ?').run(serverId);
      this.db.prepare('DELETE FROM server_events WHERE server_id = ?').run(serverId);
      this.db.prepare('DELETE FROM servers WHERE server_id = ?').run(serverId);
    });
    remove();
    this.logger.log(`Deleted server ${serverId} and its sessions/events`);
  }

  // ===== Agora Providers =====

  /** 将数据库行（下划线字段名）映射为 AgoraProviderRecord（驼峰字段名） */
  private mapProviderRow(row: any): AgoraProviderRecord {
    return {
      id: row.id,
      ownerType: row.owner_type,
      ownerId: row.owner_id ?? '',
      name: row.name,
      appId: row.app_id,
      appCertificateEnc: row.app_certificate_enc ?? '',
      customerId: row.customer_id ?? null,
      customerSecretEnc: row.customer_secret_enc ?? null,
      enabled: row.enabled ?? 0,
      priority: row.priority ?? 100,
      tokenExpireSec: row.token_expire_sec ?? 3600,
      healthStatus: row.health_status ?? 'unknown',
      healthCheckedAt: row.health_checked_at ?? null,
      healthMessage: row.health_message ?? '',
      monthlyQuotaStandardMinutes: row.monthly_quota_standard_minutes ?? null,
      quotaEnforced: row.quota_enforced ?? 0,
      estimatedUsageStandardMinutes: row.estimated_usage_standard_minutes ?? 0,
      usagePeriodKey: row.usage_period_key ?? '',
      lastUsedAt: row.last_used_at ?? null,
      allowedPresetIds: row.allowed_preset_ids ?? null,
      note: row.note ?? '',
      createdAt: row.created_at ?? 0,
      updatedAt: row.updated_at ?? 0,
    };
  }

  getProvider(id: string): AgoraProviderRecord | undefined {
    const row = this.db.prepare('SELECT * FROM agora_providers WHERE id = ?').get(id) as any;
    return row ? this.mapProviderRow(row) : undefined;
  }

  listProviders(): AgoraProviderRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM agora_providers ORDER BY priority ASC, created_at ASC')
      .all() as any[];
    return rows.map((row) => this.mapProviderRow(row));
  }

  /** 按归属列出 Provider。`ownerType` 省略时返回全部。 */
  listProvidersByOwner(ownerType?: AgoraProviderOwnerType, ownerId?: string): AgoraProviderRecord[] {
    if (!ownerType) return this.listProviders();
    const rows = ownerId === undefined
      ? (this.db
          .prepare('SELECT * FROM agora_providers WHERE owner_type = ? ORDER BY priority ASC, created_at ASC')
          .all(ownerType) as any[])
      : (this.db
          .prepare(
            'SELECT * FROM agora_providers WHERE owner_type = ? AND owner_id = ? ORDER BY priority ASC, created_at ASC',
          )
          .all(ownerType, ownerId) as any[]);
    return rows.map((row) => this.mapProviderRow(row));
  }

  /** 所有 Provider 的密文字段，供启动门禁检查「库里是否已有密文」。 */
  listProviderCiphertexts(): string[] {
    const rows = this.db
      .prepare(
        `SELECT app_certificate_enc, customer_secret_enc FROM agora_providers`,
      )
      .all() as any[];
    const values: string[] = [];
    for (const row of rows) {
      if (row.app_certificate_enc) values.push(row.app_certificate_enc);
      if (row.customer_secret_enc) values.push(row.customer_secret_enc);
    }
    return values;
  }

  createProvider(input: AgoraProviderCreateInput): AgoraProviderRecord {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO agora_providers (
        id, owner_type, owner_id, name, app_id, app_certificate_enc,
        customer_id, customer_secret_enc, enabled, priority, token_expire_sec,
        health_status, health_checked_at, health_message,
        monthly_quota_standard_minutes, quota_enforced,
        estimated_usage_standard_minutes, usage_period_key, last_used_at,
        allowed_preset_ids, note, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        'unknown', NULL, '',
        ?, ?,
        0, '', NULL,
        ?, ?, ?, ?
      )
    `).run(
      input.id,
      input.ownerType,
      input.ownerId ?? '',
      input.name,
      input.appId,
      input.appCertificateEnc,
      input.customerId ?? null,
      input.customerSecretEnc ?? null,
      input.enabled === false ? 0 : 1,
      input.priority ?? 100,
      input.tokenExpireSec ?? 3600,
      input.monthlyQuotaStandardMinutes ?? null,
      input.quotaEnforced ? 1 : 0,
      input.allowedPresetIds ? JSON.stringify(input.allowedPresetIds) : null,
      input.note ?? '',
      now,
      now,
    );
    return this.getProvider(input.id)!;
  }

  /** 可更新列。`owner_type` / `owner_id` 是身份，不在其中；`id` 由主键保护。 */
  private readonly ALLOWED_PROVIDER_COLS = new Set([
    'name', 'app_id', 'app_certificate_enc',
    'customer_id', 'customer_secret_enc',
    'enabled', 'priority', 'token_expire_sec',
    'health_status', 'health_checked_at', 'health_message',
    'monthly_quota_standard_minutes', 'quota_enforced',
    'estimated_usage_standard_minutes', 'usage_period_key', 'last_used_at',
    'allowed_preset_ids', 'note',
    'updated_at',
  ]);

  updateProvider(id: string, fields: Partial<AgoraProviderRecord>): void {
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, val] of Object.entries(fields)) {
      if (key === 'id') continue;
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (!this.ALLOWED_PROVIDER_COLS.has(col)) {
        this.logger.warn(`updateProvider: rejected unknown column "${col}"`);
        continue;
      }
      sets.push(`${col} = ?`);
      values.push(val);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);
    this.db.prepare(`UPDATE agora_providers SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteProvider(id: string): boolean {
    return this.db.prepare('DELETE FROM agora_providers WHERE id = ?').run(id).changes > 0;
  }

  /** 有多少个会话绑定在这个 Provider 上（删除前的安全检查）。 */
  countSessionsByProvider(providerId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM sessions WHERE provider_id = ?')
      .get(providerId) as any;
    return row?.c ?? 0;
  }

  // ===== Server Events =====

  /** 记录服务器事件 */
  addServerEvent(serverId: string, eventType: string, operatorId?: string, operatorName?: string, detail?: string): void {
    this.db.prepare(`
      INSERT INTO server_events (server_id, event_type, operator_id, operator_name, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(serverId, eventType, operatorId || '', operatorName || '', detail || '', Date.now());
  }

  /** 获取服务器事件列表 */
  getServerEvents(serverId: string): ServerEvent[] {
    const rows = this.db.prepare('SELECT * FROM server_events WHERE server_id = ? ORDER BY created_at DESC').all(serverId) as any[];
    return rows.map(row => ({
      id: row.id,
      serverId: row.server_id,
      eventType: row.event_type,
      operatorId: row.operator_id,
      operatorName: row.operator_name,
      detail: row.detail,
      createdAt: row.created_at,
    }));
  }

  // ===== Sessions =====

  getSessionById(id: string): ServerSession | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return this.mapSessionRow(row);
  }

  getSessionByToken(token: string): ServerSession | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as any;
    if (!row) return undefined;
    return this.mapSessionRow(row);
  }

  getActiveSessionsByUser(sharerUserId: string): ServerSession[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE sharer_user_id = ? AND status != 'ended'"
    ).all(sharerUserId) as any[];
    return rows.map(row => this.mapSessionRow(row));
  }

  getSessionsByServer(serverId: string): ServerSession[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE server_id = ? ORDER BY created_at DESC').all(serverId) as any[];
    return rows.map(row => this.mapSessionRow(row));
  }

  getAllSessions(): ServerSession[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as any[];
    return rows.map(row => this.mapSessionRow(row));
  }

  createSession(session: ServerSession): void {
    this.db.prepare(`
      INSERT INTO sessions (
        id, token, channel, server_id, sharer_user_id, sharer_username,
        guild_id, target_channel_id, status, viewer_count, peak_viewers,
        total_viewer_joins, viewer_duration_ms, quality, card_message_id, manual_created,
        created_at, started_at, ended_at, duration_ms, last_heartbeat,
        grace_started_at, grace_reason, last_viewer_at, publisher_client_id,
        low_latency, provider_id, agora_app_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?
      )
    `).run(
      session.id, session.token, session.channel, session.serverId,
      session.sharerUserId, session.sharerUsername,
      session.guildId, session.targetChannelId, session.status,
      session.viewerCount, session.peakViewers,
      session.totalViewerJoins, session.viewerDurationMs, session.quality, session.cardMessageId,
      session.manualCreated,
      session.createdAt, session.startedAt, session.endedAt,
      session.durationMs, session.lastHeartbeat,
      session.graceStartedAt, session.graceReason,
      session.lastViewerAt, session.publisherClientId,
      session.lowLatency ?? 0,
      session.providerId ?? '', session.agoraAppId ?? '',
    );
  }

  /**
   * 绑定会话的 Provider 与 App ID 快照。**只在会话创建时调用一次。**
   *
   * 这是这两个字段的唯一写入路径：它们不在 `ALLOWED_SESSION_COLS` 里，
   * 所以 `updateSession()` 无法修改，从数据层保证「同一 Session 的 publisher 与
   * 所有 subscriber 始终使用同一个 Provider / App ID / Channel」。
   */
  bindSessionProvider(sessionId: string, providerId: string, agoraAppId: string): void {
    const result = this.db
      .prepare(
        `UPDATE sessions SET provider_id = ?, agora_app_id = ?
         WHERE id = ? AND provider_id = ''`,
      )
      .run(providerId, agoraAppId, sessionId);
    if (result.changes !== 1) {
      // 已经绑定过 → 说明有人试图在活跃会话上换 Provider。明确拒绝而不是静默覆盖。
      this.logger.warn(
        `bindSessionProvider: refused to rebind session ${sessionId} (already bound or not found)`,
      );
    }
  }

  /**
   * 为某服务器尚未绑定 Provider 的历史会话回填绑定。返回受影响行数。
   *
   * 用 `provider_id = ''` 作条件，因此不会覆盖已经绑定的会话。
   */
  backfillSessionsProvider(serverId: string, providerId: string, agoraAppId: string): number {
    return this.db
      .prepare(
        `UPDATE sessions SET provider_id = ?, agora_app_id = ?
         WHERE server_id = ? AND provider_id = ''`,
      )
      .run(providerId, agoraAppId, serverId).changes;
  }

  private readonly ALLOWED_SESSION_COLS = new Set([
    'token', 'channel', 'server_id', 'sharer_user_id', 'sharer_username',
    'guild_id', 'target_channel_id', 'status', 'viewer_count', 'peak_viewers',
    'total_viewer_joins', 'viewer_duration_ms', 'quality', 'card_message_id', 'manual_created',
    'created_at', 'started_at', 'ended_at', 'duration_ms', 'last_heartbeat',
    'grace_started_at', 'grace_reason', 'last_viewer_at', 'publisher_client_id',
    'low_latency',
  ]);

  updateSession(id: string, fields: Partial<ServerSession>): void {
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, val] of Object.entries(fields)) {
      if (key === 'id') continue;
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (!this.ALLOWED_SESSION_COLS.has(col)) {
        this.logger.warn(`updateSession: rejected unknown column "${col}"`);
        continue;
      }
      sets.push(`${col} = ?`);
      values.push(val);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteSession(id: string): boolean {
    const result = this.db.prepare("DELETE FROM sessions WHERE id = ? AND status = 'ended'").run(id);
    return result.changes > 0;
  }

  deletePendingSession(id: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM sessions WHERE id = ? AND status = 'pending' AND card_message_id IS NULL",
    ).run(id);
    return result.changes > 0;
  }

  // ===== KOOK Webhook Inbox =====

  enqueueKookWebhookEvent(input: {
    eventKey: string;
    eventId: string;
    sn: number | null;
    eventType: string;
    payload: string;
    payloadHash: string;
  }): { inserted: boolean; eventKey: string; conflict: boolean } {
    const enqueue = this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT payload_hash FROM kook_webhook_events WHERE event_key = ?',
      ).get(input.eventKey) as any;
      if (existing?.payload_hash === input.payloadHash) {
        return { inserted: false, eventKey: input.eventKey, conflict: false };
      }

      let eventKey = input.eventKey;
      let conflict = false;
      if (existing) {
        conflict = true;
        eventKey = `${input.eventKey}:${input.payloadHash.slice(0, 16)}`;
        const conflictExisting = this.db.prepare(
          'SELECT payload_hash FROM kook_webhook_events WHERE event_key = ?',
        ).get(eventKey) as any;
        if (conflictExisting?.payload_hash === input.payloadHash) {
          return { inserted: false, eventKey, conflict: true };
        }
      }

      const now = Date.now();
      this.db.prepare(`
        INSERT INTO kook_webhook_events (
          event_key, event_id, sn, event_type, payload, payload_hash,
          status, attempts, next_attempt_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      `).run(
        eventKey,
        input.eventId,
        input.sn,
        input.eventType,
        input.payload,
        input.payloadHash,
        now,
        now,
      );
      return { inserted: true, eventKey, conflict };
    });
    return enqueue();
  }

  recoverStaleKookWebhookEvents(staleBefore: number): number {
    return this.db.prepare(`
      UPDATE kook_webhook_events
      SET status = 'pending', locked_at = NULL, next_attempt_at = ?
      WHERE status = 'processing' AND locked_at < ?
    `).run(Date.now(), staleBefore).changes;
  }

  claimKookWebhookEvent(): KookWebhookEventRecord | undefined {
    const claim = this.db.transaction(() => {
      const now = Date.now();
      const row = this.db.prepare(`
        SELECT event_key, sn, event_type, payload, attempts
        FROM kook_webhook_events
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY received_at ASC
        LIMIT 1
      `).get(now) as any;
      if (!row) return undefined;
      const updated = this.db.prepare(`
        UPDATE kook_webhook_events
        SET status = 'processing', attempts = attempts + 1, locked_at = ?
        WHERE event_key = ? AND status = 'pending'
      `).run(now, row.event_key);
      if (updated.changes !== 1) return undefined;
      return {
        eventKey: row.event_key,
        sn: row.sn == null ? null : Number(row.sn),
        eventType: row.event_type || '',
        payload: row.payload,
        attempts: Number(row.attempts) + 1,
      } as KookWebhookEventRecord;
    });
    return claim();
  }

  completeKookWebhookEvent(eventKey: string, status: 'done' | 'ignored'): void {
    this.db.prepare(`
      UPDATE kook_webhook_events
      SET status = ?, processed_at = ?, locked_at = NULL, last_error_code = ''
      WHERE event_key = ?
    `).run(status, Date.now(), eventKey);
  }

  beginKookWebhookBusinessEffect(eventKey: string): 'execute' | 'done' | 'ignored' | 'uncertain' {
    const begin = this.db.transaction(() => {
      const effectKey = `business:${eventKey}`;
      const existing = this.db.prepare(`
        SELECT status, result
        FROM kook_webhook_effects
        WHERE effect_key = ?
      `).get(effectKey) as any;
      const now = Date.now();

      if (!existing) {
        this.db.prepare(`
          INSERT INTO kook_webhook_effects (
            effect_key, event_key, status, result, created_at, updated_at
          ) VALUES (?, ?, 'processing', '', ?, ?)
        `).run(effectKey, eventKey, now, now);
        return 'execute' as const;
      }

      if (existing.status === 'done' || existing.status === 'ignored') {
        this.db.prepare(`
          UPDATE kook_webhook_events
          SET status = ?, processed_at = ?, locked_at = NULL, last_error_code = ''
          WHERE event_key = ?
        `).run(existing.status, now, eventKey);
        return existing.status as 'done' | 'ignored';
      }

      // An existing "processing" effect means the previous process stopped after
      // business execution began. Its external side effects may already exist, so
      // retrying would risk duplicate sessions or KOOK cards.
      this.db.prepare(`
        UPDATE kook_webhook_effects
        SET status = 'uncertain', result = 'crash_window', updated_at = ?
        WHERE effect_key = ?
      `).run(now, effectKey);
      this.db.prepare(`
        UPDATE kook_webhook_events
        SET status = 'uncertain', processed_at = ?, locked_at = NULL,
            last_error_code = 'business_effect_uncertain'
        WHERE event_key = ?
      `).run(now, eventKey);
      return 'uncertain' as const;
    });
    return begin();
  }

  completeKookWebhookBusinessEffect(eventKey: string, status: 'done' | 'ignored'): void {
    const complete = this.db.transaction(() => {
      const now = Date.now();
      this.db.prepare(`
        UPDATE kook_webhook_effects
        SET status = ?, result = ?, updated_at = ?
        WHERE event_key = ? AND status = 'processing'
      `).run(status, status, now, eventKey);
      this.db.prepare(`
        UPDATE kook_webhook_events
        SET status = ?, processed_at = ?, locked_at = NULL, last_error_code = ''
        WHERE event_key = ?
      `).run(status, now, eventKey);
    });
    complete();
  }

  markKookWebhookBusinessEffectUncertain(eventKey: string, errorCode: string): void {
    const mark = this.db.transaction(() => {
      const now = Date.now();
      const safeCode = errorCode.slice(0, 100);
      this.db.prepare(`
        UPDATE kook_webhook_effects
        SET status = 'uncertain', result = ?, updated_at = ?
        WHERE event_key = ?
      `).run(safeCode, now, eventKey);
      this.db.prepare(`
        UPDATE kook_webhook_events
        SET status = 'uncertain', processed_at = ?, locked_at = NULL, last_error_code = ?
        WHERE event_key = ?
      `).run(now, safeCode, eventKey);
    });
    mark();
  }

  retryKookWebhookEvent(eventKey: string, nextAttemptAt: number, errorCode: string): void {
    this.db.prepare(`
      UPDATE kook_webhook_events
      SET status = 'pending', next_attempt_at = ?, locked_at = NULL, last_error_code = ?
      WHERE event_key = ?
    `).run(nextAttemptAt, errorCode.slice(0, 100), eventKey);
  }

  deadKookWebhookEvent(eventKey: string, errorCode: string): void {
    this.db.prepare(`
      UPDATE kook_webhook_events
      SET status = 'dead', processed_at = ?, locked_at = NULL, last_error_code = ?
      WHERE event_key = ?
    `).run(Date.now(), errorCode.slice(0, 100), eventKey);
  }

  getKookWebhookStatus(): {
    pending: number;
    processing: number;
    done: number;
    ignored: number;
    dead: number;
    uncertain: number;
    oldestPendingAt: number | null;
  } {
    const counts = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM kook_webhook_events
      GROUP BY status
    `).all() as any[];
    const map = new Map(counts.map((row) => [String(row.status), Number(row.count)]));
    const oldest = this.db.prepare(`
      SELECT MIN(received_at) AS received_at
      FROM kook_webhook_events
      WHERE status IN ('pending', 'processing')
    `).get() as any;
    return {
      pending: map.get('pending') || 0,
      processing: map.get('processing') || 0,
      done: map.get('done') || 0,
      ignored: map.get('ignored') || 0,
      dead: map.get('dead') || 0,
      uncertain: map.get('uncertain') || 0,
      oldestPendingAt: oldest?.received_at == null ? null : Number(oldest.received_at),
    };
  }

  cleanupKookWebhookEvents(doneBefore: number, deadBefore: number): number {
    return this.db.prepare(`
      DELETE FROM kook_webhook_events
      WHERE (status IN ('done', 'ignored') AND processed_at < ?)
         OR (status IN ('dead', 'uncertain') AND processed_at < ?)
    `).run(doneBefore, deadBefore).changes;
  }

  // ===== Notices =====

  private mapNoticeRow(row: any, targets: NoticeTargetPage[]): NoticeRecord {
    return {
      id: row.id,
      kind: row.kind,
      modalPolicy: row.modal_policy || null,
      title: row.title || '',
      contentFormat: row.content_format,
      content: row.content || '',
      imageUrl: row.image_url || '',
      enabled: row.enabled,
      sortOrder: row.sort_order,
      repeatAfterSec: row.repeat_after_sec ?? null,
      revision: row.revision,
      targets,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getNoticeTargets(ids: string[]): Map<string, NoticeTargetPage[]> {
    const result = new Map<string, NoticeTargetPage[]>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT notice_id, page FROM notice_targets WHERE notice_id IN (${placeholders})`,
    ).all(...ids) as any[];
    for (const row of rows) {
      const pages = result.get(row.notice_id) || [];
      pages.push(row.page as NoticeTargetPage);
      result.set(row.notice_id, pages);
    }
    return result;
  }

  listNotices(page?: NoticeTargetPage, includeDisabled = false): NoticeRecord[] {
    const where: string[] = [];
    const values: any[] = [];
    if (!includeDisabled) where.push('n.enabled = 1');
    if (page) {
      where.push('EXISTS (SELECT 1 FROM notice_targets nt WHERE nt.notice_id = n.id AND nt.page = ?)');
      values.push(page);
    }
    const sql = `
      SELECT n.*
      FROM notices n
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY n.sort_order ASC, n.created_at ASC
    `;
    const rows = this.db.prepare(sql).all(...values) as any[];
    const targets = this.getNoticeTargets(rows.map(row => row.id));
    return rows.map(row => this.mapNoticeRow(row, targets.get(row.id) || []));
  }

  getNotice(id: string): NoticeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM notices WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    const targets = this.getNoticeTargets([id]).get(id) || [];
    return this.mapNoticeRow(row, targets);
  }

  createNotice(id: string, input: NoticeWriteInput): NoticeRecord {
    const now = Date.now();
    const create = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO notices (
          id, kind, modal_policy, title, content_format, content, image_url,
          enabled, sort_order, repeat_after_sec, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id,
        input.kind,
        input.kind === 'modal' ? input.modalPolicy : null,
        input.title || '',
        input.contentFormat,
        input.content,
        input.imageUrl || '',
        input.enabled ? 1 : 0,
        input.sortOrder,
        input.repeatAfterSec ?? null,
        now,
        now,
      );
      const insertTarget = this.db.prepare(
        'INSERT INTO notice_targets (notice_id, page) VALUES (?, ?)',
      );
      for (const page of input.targets) insertTarget.run(id, page);
    });
    create();
    return this.getNotice(id)!;
  }

  updateNotice(id: string, input: NoticeWriteInput, bumpRevision: boolean): NoticeRecord | undefined {
    if (!this.getNotice(id)) return undefined;
    const update = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE notices SET
          kind = ?,
          modal_policy = ?,
          title = ?,
          content_format = ?,
          content = ?,
          image_url = ?,
          enabled = ?,
          sort_order = ?,
          repeat_after_sec = ?,
          revision = revision + ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        input.kind,
        input.kind === 'modal' ? input.modalPolicy : null,
        input.title || '',
        input.contentFormat,
        input.content,
        input.imageUrl || '',
        input.enabled ? 1 : 0,
        input.sortOrder,
        input.repeatAfterSec ?? null,
        bumpRevision ? 1 : 0,
        Date.now(),
        id,
      );
      this.db.prepare('DELETE FROM notice_targets WHERE notice_id = ?').run(id);
      const insertTarget = this.db.prepare(
        'INSERT INTO notice_targets (notice_id, page) VALUES (?, ?)',
      );
      for (const page of input.targets) insertTarget.run(id, page);
    });
    update();
    return this.getNotice(id);
  }

  deleteNotice(id: string): boolean {
    return this.db.prepare('DELETE FROM notices WHERE id = ?').run(id).changes > 0;
  }

  reorderNotices(ids: string[]): void {
    const update = this.db.prepare(
      'UPDATE notices SET sort_order = ?, updated_at = ? WHERE id = ?',
    );
    const reorder = this.db.transaction(() => {
      ids.forEach((id, index) => update.run(index, Date.now(), id));
    });
    reorder();
  }

  republishNotice(id: string): NoticeRecord | undefined {
    const result = this.db.prepare(
      'UPDATE notices SET revision = revision + 1, updated_at = ? WHERE id = ?',
    ).run(Date.now(), id);
    return result.changes > 0 ? this.getNotice(id) : undefined;
  }
}
