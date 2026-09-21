import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { getDefaultQualityBitrates, QualityBitrateConfig } from '../session/session.types';

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
}

// ===== Service =====

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly db: Database.Database;

  constructor() {
    const dataDir = join(process.cwd(), 'data');
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

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS global_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS servers (
        server_id              TEXT PRIMARY KEY,  -- guild_id 雪花 ID（不变，用于主键和 URL）
        platform               TEXT NOT NULL DEFAULT 'kook',
        external_id            TEXT NOT NULL DEFAULT '',
        open_id                TEXT NOT NULL DEFAULT '',  -- open_id 公开 ID（用于面板显示）
        guild_name             TEXT NOT NULL DEFAULT '',
        owner_id               TEXT NOT NULL DEFAULT '',
        owner_username         TEXT NOT NULL DEFAULT '',
        password_hash          TEXT NOT NULL DEFAULT '',
        bound                  INTEGER NOT NULL DEFAULT 0,
        status                 TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'kicked'
        agora_app_id           TEXT NOT NULL DEFAULT '',
        agora_app_certificate  TEXT NOT NULL DEFAULT '',
        agora_token_expire_sec INTEGER NOT NULL DEFAULT 3600,
        allowed_qualities      TEXT NOT NULL DEFAULT '["480p_2","720p30","1080p_2","1080p60","1440p30","1440p60","4k30"]',
        trigger_words          TEXT NOT NULL DEFAULT '屏幕共享,共享屏幕',
        idle_timeout_sec       INTEGER NOT NULL DEFAULT 60,
        heartbeat_interval_sec INTEGER NOT NULL DEFAULT 5,
        no_viewer_timeout_sec  INTEGER NOT NULL DEFAULT 180,
        public_domain          TEXT NOT NULL DEFAULT '',
        created_at             INTEGER NOT NULL DEFAULT 0,
        updated_at             INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS server_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id     TEXT NOT NULL,
        event_type    TEXT NOT NULL,  -- 'bot_joined' | 'bot_kicked' | 'bot_left'
        operator_id   TEXT NOT NULL DEFAULT '',
        operator_name TEXT NOT NULL DEFAULT '',
        detail        TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_server_events_server_id ON server_events(server_id);

      -- Migration: add open_id column if missing
      PRAGMA table_info(servers);
    `);

    // Check and add open_id column if it doesn't exist
    const columns = this.db.prepare("PRAGMA table_info(servers)").all() as any[];
    if (!columns.some(c => c.name === 'open_id')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN open_id TEXT NOT NULL DEFAULT ''`);
      this.logger.log('Added open_id column to servers table');
    }
    if (!columns.some(c => c.name === 'status')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
      this.logger.log('Added status column to servers table');
    }
    if (!columns.some(c => c.name === 'allow_low_latency')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN allow_low_latency INTEGER NOT NULL DEFAULT 0`);
      this.logger.log('Added allow_low_latency column to servers table');
    }
    if (!columns.some(c => c.name === 'platform')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN platform TEXT NOT NULL DEFAULT 'kook'`);
      this.logger.log('Added platform column to servers table');
    }
    if (!columns.some(c => c.name === 'external_id')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN external_id TEXT NOT NULL DEFAULT ''`);
      this.logger.log('Added external_id column to servers table');
    }
    this.db.exec(`
      UPDATE servers
      SET platform = 'kook'
      WHERE platform IS NULL OR platform = '';

      UPDATE servers
      SET external_id = server_id
      WHERE external_id IS NULL OR external_id = '';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_platform_external_id
      ON servers(platform, external_id);
    `);

    // Migrate servers table: add rebound_at column if missing
    const serverCols = this.db.prepare("PRAGMA table_info(servers)").all() as any[];
    if (!serverCols.some(c => c.name === 'rebound_at')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN rebound_at INTEGER NOT NULL DEFAULT 0`);
      this.logger.log('Added rebound_at column to servers table');
    }
    if (!serverCols.some(c => c.name === 'bind_token')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN bind_token TEXT NOT NULL DEFAULT ''`);
      this.logger.log('Added bind_token column to servers table');
    }
    if (!serverCols.some(c => c.name === 'bind_token_expires')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN bind_token_expires INTEGER NOT NULL DEFAULT 0`);
      this.logger.log('Added bind_token_expires column to servers table');
    }
    if (!serverCols.some(c => c.name === 'server_secret')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN server_secret TEXT NOT NULL DEFAULT ''`);
      this.logger.log('Added server_secret column to servers table');

      // Auto-generate secrets for existing servers (retrofit legacy shared-secret setup)
      const existing = this.db.prepare("SELECT server_id, server_secret FROM servers WHERE server_secret = ''").all() as any[];
      for (const row of existing) {
        const secret = randomBytes(32).toString('hex');
        this.db.prepare("UPDATE servers SET server_secret = ? WHERE server_id = ?").run(secret, row.server_id);
        this.logger.log(`Generated server_secret for existing server ${row.server_id}`);
      }
    }

    this.db.exec(`

      CREATE TABLE IF NOT EXISTS sessions (
        id                  TEXT PRIMARY KEY,
        token               TEXT NOT NULL UNIQUE,
        channel             TEXT NOT NULL,
        server_id           TEXT NOT NULL DEFAULT '',
        sharer_user_id      TEXT NOT NULL,
        sharer_username     TEXT NOT NULL,
        guild_id            TEXT NOT NULL DEFAULT '',
        target_channel_id   TEXT NOT NULL DEFAULT '',
        status              TEXT NOT NULL DEFAULT 'pending',
        viewer_count        INTEGER NOT NULL DEFAULT 0,
        peak_viewers        INTEGER NOT NULL DEFAULT 0,
        total_viewer_joins  INTEGER NOT NULL DEFAULT 0,
        viewer_duration_ms  INTEGER NOT NULL DEFAULT 0,
        quality             TEXT NOT NULL DEFAULT '1080p_2',
        card_message_id     TEXT,
        manual_created      INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL DEFAULT 0,
        started_at          INTEGER,
        ended_at            INTEGER,
        duration_ms         INTEGER,
        last_heartbeat      INTEGER NOT NULL DEFAULT 0,
        grace_started_at    INTEGER,
        grace_reason        TEXT,
        last_viewer_at      INTEGER,
        publisher_client_id TEXT,
        low_latency         INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
      CREATE INDEX IF NOT EXISTS idx_sessions_server_id ON sessions(server_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

      CREATE TABLE IF NOT EXISTS notices (
        id                TEXT PRIMARY KEY,
        kind              TEXT NOT NULL,
        modal_policy      TEXT,
        title             TEXT NOT NULL DEFAULT '',
        content_format    TEXT NOT NULL DEFAULT 'text',
        content           TEXT NOT NULL DEFAULT '',
        image_url         TEXT NOT NULL DEFAULT '',
        enabled           INTEGER NOT NULL DEFAULT 1,
        sort_order        INTEGER NOT NULL DEFAULT 0,
        repeat_after_sec  INTEGER,
        revision          INTEGER NOT NULL DEFAULT 1,
        created_at        INTEGER NOT NULL DEFAULT 0,
        updated_at        INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS notice_targets (
        notice_id TEXT NOT NULL,
        page      TEXT NOT NULL,
        PRIMARY KEY (notice_id, page),
        FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_notices_enabled_order
      ON notices(enabled, sort_order);

      CREATE INDEX IF NOT EXISTS idx_notice_targets_page
      ON notice_targets(page);

      CREATE TABLE IF NOT EXISTS kook_webhook_events (
        event_key       TEXT PRIMARY KEY,
        event_id        TEXT NOT NULL DEFAULT '',
        sn              INTEGER,
        event_type      TEXT NOT NULL DEFAULT '',
        payload         TEXT NOT NULL,
        payload_hash    TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        locked_at       INTEGER,
        last_error_code TEXT NOT NULL DEFAULT '',
        received_at     INTEGER NOT NULL,
        processed_at    INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_kook_webhook_claim
      ON kook_webhook_events(status, next_attempt_at, received_at);

      CREATE INDEX IF NOT EXISTS idx_kook_webhook_sn
      ON kook_webhook_events(sn, received_at);

      CREATE TABLE IF NOT EXISTS kook_webhook_effects (
        effect_key   TEXT PRIMARY KEY,
        event_key    TEXT NOT NULL UNIQUE,
        status       TEXT NOT NULL DEFAULT 'processing',
        result       TEXT NOT NULL DEFAULT '',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        FOREIGN KEY (event_key) REFERENCES kook_webhook_events(event_key) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_kook_webhook_effect_status
      ON kook_webhook_effects(status, updated_at);
    `);

    // Migrate sessions table: add low_latency column if missing
    const sessCols = this.db.prepare("PRAGMA table_info(sessions)").all() as any[];
    if (!sessCols.some(c => c.name === 'low_latency')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN low_latency INTEGER NOT NULL DEFAULT 0`);
      this.logger.log('Added low_latency column to sessions table');
    }
    if (!sessCols.some(c => c.name === 'viewer_duration_ms')) {
      // 旧记录保留 NULL，计费展示时继续使用旧的峰值人数估算。
      this.db.exec(`ALTER TABLE sessions ADD COLUMN viewer_duration_ms INTEGER`);
      this.logger.log('Added viewer_duration_ms column to sessions table');
    }

    // Seed default global config if empty
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM global_config').get() as any;
    if (row.cnt === 0) {
      const ins = this.db.prepare('INSERT OR IGNORE INTO global_config (key, value) VALUES (?, ?)');
      ins.run('kookBotToken', process.env.KOOK_BOT_TOKEN || '');
      ins.run('publicDomain', 'http://localhost:3520');
      ins.run('triggerWordLabels', JSON.stringify(['屏幕共享', '共享屏幕']));
      this.logger.log('Seeded default global config');
    }
    this.db.prepare(
      "INSERT OR IGNORE INTO global_config (key, value) VALUES ('kookVerifyToken', '')",
    ).run();
    this.db.prepare(
      "INSERT OR IGNORE INTO global_config (key, value) VALUES ('kookEncryptKey', '')",
    ).run();

    // Preserve every existing per-server trigger word when introducing the
    // global label library.
    const labelRow = this.db.prepare("SELECT value FROM global_config WHERE key = 'triggerWordLabels'").get() as any;
    if (!labelRow) {
      const labels = new Set(['屏幕共享', '共享屏幕']);
      const existing = this.db.prepare('SELECT trigger_words FROM servers').all() as any[];
      for (const row of existing) {
        for (const word of this.parseTriggerWords(row.trigger_words)) labels.add(word);
      }
      this.setGlobalConfig('triggerWordLabels', JSON.stringify([...labels]));
      this.logger.log('Created global trigger word label library from existing server settings');
    }

    // Backfill empty kookBotToken from env (for existing databases)
    if (process.env.KOOK_BOT_TOKEN) {
      const current = this.db.prepare("SELECT value FROM global_config WHERE key = 'kookBotToken'").get() as any;
      if (!current || !current.value) {
        this.db.prepare("INSERT OR REPLACE INTO global_config (key, value) VALUES ('kookBotToken', ?)").run(process.env.KOOK_BOT_TOKEN);
        this.logger.log('Backfilled kookBotToken from KOOK_BOT_TOKEN env');
      }
    }

    const sunset = this.db.prepare("SELECT value FROM global_config WHERE key = 'legacyAdminSunsetAt'").get() as any;
    if (!sunset) {
      const configured = Date.parse(process.env.LEGACY_ADMIN_SUNSET_AT || '');
      const sunsetAt = Number.isFinite(configured)
        ? configured
        : Date.now() + 30 * 24 * 60 * 60 * 1000;
      this.setGlobalConfig('legacyAdminSunsetAt', String(sunsetAt));
      this.logger.log(`Created legacy admin sunset time ${new Date(sunsetAt).toISOString()}`);
    }

    const defaultNoticeId = 'view-adaptive-bitrate';
    const defaultNotice = this.db.prepare('SELECT id FROM notices WHERE id = ?').get(defaultNoticeId);
    if (!defaultNotice) {
      const now = Date.now();
      const insertDefaultNotice = this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO notices (
            id, kind, modal_policy, title, content_format, content, image_url,
            enabled, sort_order, repeat_after_sec, revision, created_at, updated_at
          ) VALUES (?, 'banner', NULL, '', 'text', ?, '', 1, 0, ?, 1, ?, ?)
        `).run(
          defaultNoticeId,
          '首次接入时系统将根据网络情况动态调整码率，稍加等待视频会逐步增加清晰度和流畅度。',
          7 * 24 * 60 * 60,
          now,
          now,
        );
        this.db.prepare('INSERT INTO notice_targets (notice_id, page) VALUES (?, ?)').run(defaultNoticeId, 'view');
      });
      insertDefaultNotice();
      this.logger.log('Seeded default adaptive bitrate notice');
    }
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

  private parseTriggerWords(value?: string): string[] {
    return [...new Set((value || '').split(',').map(word => word.trim()).filter(Boolean))];
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
    const legacy = this.parseTriggerWords(value);
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
        let enabled = this.parseTriggerWords(server.trigger_words).filter(word => allowed.has(word));
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
    this.db.prepare('INSERT OR REPLACE INTO global_config (key, value) VALUES (?, ?)').run(key, value);
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
    'agora_app_id', 'agora_app_certificate', 'agora_token_expire_sec',
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
        low_latency
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?
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
    );
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
