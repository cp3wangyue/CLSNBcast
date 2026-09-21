import type { Migration } from './types';

/**
 * Agora Provider 池：把原来「每服务器一份明文 Agora 配置」抽象成可多租户、
 * 可加密、可配额、可容灾的 Provider 记录。
 *
 * 同时给 `sessions` 加上 Provider 绑定列：
 * - `provider_id`：会话创建时固定选定的 Provider，**此后不可修改**
 * - `agora_app_id`：签发时使用的 App ID 快照
 *
 * 这两列是「同一 Session 的 publisher 与所有 subscriber 必须使用同一个
 * App ID 与 Channel」这条不变量的物理载体，因此它们**故意不加入
 * `DatabaseService.ALLOWED_SESSION_COLS`**，从 `updateSession` 层面禁止误改。
 * 唯一写入路径是 `DatabaseService.bindSessionProvider()`。
 *
 * 幂等：按 `types.ts` 的约定，`up` 必须可重复执行（存量库可能没有
 * `schema_migrations` 而被整体重跑），所以 ALTER 都带 PRAGMA 探测。
 */
export const agoraProviders: Migration = {
  version: 2,
  name: 'agora-providers',
  up: ({ db, log }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agora_providers (
        id                               TEXT PRIMARY KEY,
        -- 'platform' = 我们自己的全局池；'space' = 某个 KOOK 服务器自带；'user' = 用户 BYOK
        owner_type                       TEXT NOT NULL,
        owner_id                         TEXT NOT NULL DEFAULT '',
        name                             TEXT NOT NULL,
        app_id                           TEXT NOT NULL,
        app_certificate_enc              TEXT NOT NULL DEFAULT '',   -- 密文，绝不存明文
        customer_id                      TEXT,
        customer_secret_enc              TEXT,                       -- 密文
        enabled                          INTEGER NOT NULL DEFAULT 1,
        priority                         INTEGER NOT NULL DEFAULT 100,  -- 越小越优先
        token_expire_sec                 INTEGER NOT NULL DEFAULT 3600,
        health_status                    TEXT NOT NULL DEFAULT 'unknown',
        health_checked_at                INTEGER,
        health_message                   TEXT NOT NULL DEFAULT '',
        -- NULL = 不限量。刻意不写死默认值：不同声网账户/项目的配额完全不同
        monthly_quota_standard_minutes   REAL,
        quota_enforced                   INTEGER NOT NULL DEFAULT 0,
        -- 由用量账本汇总的缓存，供配额判断 O(1) 读取；事实来源是 usage_intervals
        estimated_usage_standard_minutes REAL NOT NULL DEFAULT 0,
        usage_period_key                 TEXT NOT NULL DEFAULT '',
        last_used_at                     INTEGER,
        allowed_preset_ids               TEXT,
        note                             TEXT NOT NULL DEFAULT '',
        created_at                       INTEGER NOT NULL DEFAULT 0,
        updated_at                       INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_agora_providers_owner
      ON agora_providers(owner_type, owner_id);

      CREATE INDEX IF NOT EXISTS idx_agora_providers_select
      ON agora_providers(enabled, priority);
    `);

    const sessionCols = db.prepare('PRAGMA table_info(sessions)').all() as any[];
    if (!sessionCols.some((c) => c.name === 'provider_id')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN provider_id TEXT NOT NULL DEFAULT ''`);
      log('Added provider_id column to sessions table');
    }
    if (!sessionCols.some((c) => c.name === 'agora_app_id')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN agora_app_id TEXT NOT NULL DEFAULT ''`);
      log('Added agora_app_id column to sessions table');
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_provider_id
      ON sessions(provider_id);
    `);
  },
};
