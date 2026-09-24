import { randomBytes } from 'crypto';
import { parseTriggerWords, setGlobalConfig } from './helpers';
import type { Migration } from './types';

/**
 * 基线迁移：把本仓库原有的手写幂等迁移逻辑（原 `DatabaseService.migrate()`）
 * 原样搬入版本化框架，作为 version 1。
 *
 * 必须保持原有的**幂等语义**（`CREATE TABLE IF NOT EXISTS` / `PRAGMA table_info`
 * 列探测 / `INSERT OR IGNORE`），因为：
 * - 新库会跑它一次；
 * - 已存在的存量库（由旧代码创建、没有 `schema_migrations` 表）会被判定为
 *   「未应用」而重跑一次，靠幂等性保证安全。
 *
 * ⚠️ 本文件内容与原有行为必须逐字等价，不要顺手重构或调整语句顺序。
 */
export const baseline: Migration = {
  version: 1,
  name: 'baseline',
  up: ({ db, log }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS global_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS servers (
        server_id              TEXT PRIMARY KEY,  -- guild_id 雪花 ID（不变，用于主键和 URL）
        -- 平台标识。SQL 默认值是历史契约，不可更改（改了会让新库与存量库结构分叉）；
        -- 平台取值的**事实来源**是 modules/platform/platform.types.ts 的 SUPPORTED_PLATFORMS。
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
    const columns = db.prepare('PRAGMA table_info(servers)').all() as any[];
    if (!columns.some((c) => c.name === 'open_id')) {
      db.exec(`ALTER TABLE servers ADD COLUMN open_id TEXT NOT NULL DEFAULT ''`);
      log('Added open_id column to servers table');
    }
    if (!columns.some((c) => c.name === 'status')) {
      db.exec(`ALTER TABLE servers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
      log('Added status column to servers table');
    }
    if (!columns.some((c) => c.name === 'allow_low_latency')) {
      db.exec(`ALTER TABLE servers ADD COLUMN allow_low_latency INTEGER NOT NULL DEFAULT 0`);
      log('Added allow_low_latency column to servers table');
    }
    if (!columns.some((c) => c.name === 'platform')) {
      db.exec(`ALTER TABLE servers ADD COLUMN platform TEXT NOT NULL DEFAULT 'kook'`);
      log('Added platform column to servers table');
    }
    if (!columns.some((c) => c.name === 'external_id')) {
      db.exec(`ALTER TABLE servers ADD COLUMN external_id TEXT NOT NULL DEFAULT ''`);
      log('Added external_id column to servers table');
    }
    db.exec(`
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
    const serverCols = db.prepare('PRAGMA table_info(servers)').all() as any[];
    if (!serverCols.some((c) => c.name === 'rebound_at')) {
      db.exec(`ALTER TABLE servers ADD COLUMN rebound_at INTEGER NOT NULL DEFAULT 0`);
      log('Added rebound_at column to servers table');
    }
    if (!serverCols.some((c) => c.name === 'bind_token')) {
      db.exec(`ALTER TABLE servers ADD COLUMN bind_token TEXT NOT NULL DEFAULT ''`);
      log('Added bind_token column to servers table');
    }
    if (!serverCols.some((c) => c.name === 'bind_token_expires')) {
      db.exec(`ALTER TABLE servers ADD COLUMN bind_token_expires INTEGER NOT NULL DEFAULT 0`);
      log('Added bind_token_expires column to servers table');
    }
    if (!serverCols.some((c) => c.name === 'server_secret')) {
      db.exec(`ALTER TABLE servers ADD COLUMN server_secret TEXT NOT NULL DEFAULT ''`);
      log('Added server_secret column to servers table');

      // Auto-generate secrets for existing servers (retrofit legacy shared-secret setup)
      const existing = db.prepare("SELECT server_id, server_secret FROM servers WHERE server_secret = ''").all() as any[];
      for (const row of existing) {
        const secret = randomBytes(32).toString('hex');
        db.prepare('UPDATE servers SET server_secret = ? WHERE server_id = ?').run(secret, row.server_id);
        log(`Generated server_secret for existing server ${row.server_id}`);
      }
    }

    db.exec(`

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
    const sessCols = db.prepare('PRAGMA table_info(sessions)').all() as any[];
    if (!sessCols.some((c) => c.name === 'low_latency')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN low_latency INTEGER NOT NULL DEFAULT 0`);
      log('Added low_latency column to sessions table');
    }
    if (!sessCols.some((c) => c.name === 'viewer_duration_ms')) {
      // 旧记录保留 NULL，计费展示时继续使用旧的峰值人数估算。
      db.exec(`ALTER TABLE sessions ADD COLUMN viewer_duration_ms INTEGER`);
      log('Added viewer_duration_ms column to sessions table');
    }

    // Seed default global config if empty
    const row = db.prepare('SELECT COUNT(*) as cnt FROM global_config').get() as any;
    if (row.cnt === 0) {
      const ins = db.prepare('INSERT OR IGNORE INTO global_config (key, value) VALUES (?, ?)');
      ins.run('kookBotToken', process.env.KOOK_BOT_TOKEN || '');
      ins.run('publicDomain', 'http://localhost:3520');
      ins.run('triggerWordLabels', JSON.stringify(['屏幕共享', '共享屏幕']));
      log('Seeded default global config');
    }
    db.prepare(
      "INSERT OR IGNORE INTO global_config (key, value) VALUES ('kookVerifyToken', '')",
    ).run();
    db.prepare(
      "INSERT OR IGNORE INTO global_config (key, value) VALUES ('kookEncryptKey', '')",
    ).run();

    // Preserve every existing per-server trigger word when introducing the
    // global label library.
    const labelRow = db.prepare("SELECT value FROM global_config WHERE key = 'triggerWordLabels'").get() as any;
    if (!labelRow) {
      const labels = new Set(['屏幕共享', '共享屏幕']);
      const existing = db.prepare('SELECT trigger_words FROM servers').all() as any[];
      for (const row of existing) {
        for (const word of parseTriggerWords(row.trigger_words)) labels.add(word);
      }
      setGlobalConfig(db, 'triggerWordLabels', JSON.stringify([...labels]));
      log('Created global trigger word label library from existing server settings');
    }

    // Backfill empty kookBotToken from env (for existing databases)
    if (process.env.KOOK_BOT_TOKEN) {
      const current = db.prepare("SELECT value FROM global_config WHERE key = 'kookBotToken'").get() as any;
      if (!current || !current.value) {
        db.prepare("INSERT OR REPLACE INTO global_config (key, value) VALUES ('kookBotToken', ?)").run(process.env.KOOK_BOT_TOKEN);
        log('Backfilled kookBotToken from KOOK_BOT_TOKEN env');
      }
    }

    const sunset = db.prepare("SELECT value FROM global_config WHERE key = 'legacyAdminSunsetAt'").get() as any;
    if (!sunset) {
      const configured = Date.parse(process.env.LEGACY_ADMIN_SUNSET_AT || '');
      const sunsetAt = Number.isFinite(configured)
        ? configured
        : Date.now() + 30 * 24 * 60 * 60 * 1000;
      setGlobalConfig(db, 'legacyAdminSunsetAt', String(sunsetAt));
      log(`Created legacy admin sunset time ${new Date(sunsetAt).toISOString()}`);
    }

    const defaultNoticeId = 'view-adaptive-bitrate';
    const defaultNotice = db.prepare('SELECT id FROM notices WHERE id = ?').get(defaultNoticeId);
    if (!defaultNotice) {
      const now = Date.now();
      const insertDefaultNotice = db.transaction(() => {
        db.prepare(`
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
        db.prepare('INSERT INTO notice_targets (notice_id, page) VALUES (?, ?)').run(defaultNoticeId, 'view');
      });
      insertDefaultNotice();
      log('Seeded default adaptive bitrate notice');
    }
  },
};
