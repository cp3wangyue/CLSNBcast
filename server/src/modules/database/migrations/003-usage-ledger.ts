import type { Migration } from './types';

/**
 * 用量账本：把「谁在哪个 Provider 上、以什么档位、看了多久」变成可查可对账的数据。
 *
 * 三张表分工：
 * - `usage_events`：追加写的原始事件，用于审计与排查。**不参与计费计算。**
 * - `usage_intervals`：结算区间，**计费事实来源**。每行是一段连续用量，
 *   并快照当时的档位与折算系数，因此日后调整系数不会篡改历史账目。
 * - `provider_usage_monthly`：按 Provider + 月份汇总的缓存，供配额判断 O(1) 读取。
 *
 * 为什么需要「区间」而不只是累加计数：自由画质引入「会话中途切换档位」之后，
 * 单一累加值无法表达「前 20 分钟是 1080p、之后是 720p」。区间天然能表达，
 * 而且与声网官方用量 API 对账时可以直接按 provider + 时间窗口聚合。
 *
 * 全部使用 `CREATE TABLE/INDEX IF NOT EXISTS`，因此天然幂等，
 * 满足 `types.ts` 对 `up` 可重复执行的要求（存量库没有 schema_migrations 时会被整体重跑）。
 */
export const usageLedger: Migration = {
  version: 3,
  name: 'usage-ledger',
  up: ({ db }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        provider_id TEXT NOT NULL DEFAULT '',
        server_id   TEXT NOT NULL DEFAULT '',
        role        TEXT NOT NULL,             -- 'publisher' | 'viewer'
        actor_id    TEXT NOT NULL,             -- publisher: sharerUserId；viewer: viewerId
        event_type  TEXT NOT NULL,             -- 'join'|'leave'|'tier_change'|'session_end'|'crash_recovery'
        occurred_at INTEGER NOT NULL,
        tier        TEXT,
        width       INTEGER,
        height      INTEGER,
        frame_rate  INTEGER,
        bitrate_max INTEGER,
        low_latency INTEGER NOT NULL DEFAULT 0,
        detail      TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_usage_events_session
      ON usage_events(session_id, occurred_at);

      CREATE INDEX IF NOT EXISTS idx_usage_events_provider
      ON usage_events(provider_id, occurred_at);

      CREATE TABLE IF NOT EXISTS usage_intervals (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL,
        provider_id   TEXT NOT NULL,
        server_id     TEXT NOT NULL DEFAULT '',
        role          TEXT NOT NULL,            -- 'publisher' | 'viewer'
        actor_id      TEXT NOT NULL,
        tier          TEXT NOT NULL,            -- 结算时快照，如 'Full HD 全高清'
        width         INTEGER,
        height        INTEGER,
        frame_rate    INTEGER,
        bitrate_max   INTEGER,
        low_latency   INTEGER NOT NULL DEFAULT 0,
        billing_model TEXT NOT NULL,            -- 'interactive' | 'ultra_low_latency'
        coefficient   REAL NOT NULL,            -- 结算时快照的折算系数
        -- 该区间归属的计费周期 'YYYY-MM'，**开启区间时**按配置时区算好并落库。
        -- 存下来而不是查询时现算：汇总与配额判断因此不必做时区区间换算，
        -- 也避免「月首/月末按 UTC 与按 Asia/Shanghai 归属不同」这类边界 bug。
        period_key    TEXT NOT NULL DEFAULT '',
        started_at    INTEGER NOT NULL,
        ended_at      INTEGER,                  -- NULL = 仍在进行（仅进程存活期间）
        duration_ms   INTEGER,
        standard_ms   REAL,                     -- duration_ms × coefficient
        closed_reason TEXT,                     -- 'viewer_left'|'session_end'|'grace'|'tier_change'|'crash_recovery'
        created_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_intervals_provider
      ON usage_intervals(provider_id, started_at);

      CREATE INDEX IF NOT EXISTS idx_usage_intervals_period
      ON usage_intervals(period_key, provider_id);

      CREATE INDEX IF NOT EXISTS idx_usage_intervals_session
      ON usage_intervals(session_id);

      -- 部分索引：崩溃恢复只需扫「未关闭」的少数行
      CREATE INDEX IF NOT EXISTS idx_usage_intervals_open
      ON usage_intervals(ended_at) WHERE ended_at IS NULL;

      CREATE TABLE IF NOT EXISTS provider_usage_monthly (
        provider_id       TEXT NOT NULL,
        period_key        TEXT NOT NULL,        -- 'YYYY-MM'
        standard_minutes  REAL NOT NULL DEFAULT 0,
        publisher_minutes REAL NOT NULL DEFAULT 0,
        viewer_minutes    REAL NOT NULL DEFAULT 0,
        session_count     INTEGER NOT NULL DEFAULT 0,
        updated_at        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (provider_id, period_key)
      );
    `);
  },
};
