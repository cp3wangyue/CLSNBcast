import type { Migration } from './types';

/**
 * 画质预设表：把原先硬编码在 `session.types.ts` 的 `QUALITY_PRESETS` 变成可管理的数据。
 *
 * **只建表，不播种** —— 预设内容由 `QualityPresetService` 在首次读取时写入，
 * 与 `quality_config` 同一套路（默认值只有一处定义）。
 *
 * `id` 沿用现有 preset key（`480p_2` / `720p30` / …），因为
 * `servers.allowed_qualities` 与存量 `sessions.quality` 都在引用这些字符串。
 * 因此 `id` 一旦写入就**不可改**：禁用请用 `enabled = 0`，不要删除
 * （删除会让历史会话的档位反查落空）。
 *
 * 自定义画质**不写这张表** —— 它由会话上的 `quality_config` 快照承载，
 * 见 `sessions.quality_config`（Phase 3 后续迁移引入）。
 */
export const qualityPresets: Migration = {
  version: 5,
  name: 'quality-presets',
  up: ({ db }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quality_presets (
        id                TEXT PRIMARY KEY,   -- 沿用现有 preset key
        label             TEXT NOT NULL,
        width             INTEGER NOT NULL,
        height            INTEGER NOT NULL,
        frame_rate        INTEGER NOT NULL,
        -- NULL = 不向 Agora 传递该项，由 SDK 与浏览器自行协商
        bitrate_min       INTEGER,
        bitrate_max       INTEGER,
        -- 'motion'（流畅优先）| 'detail'（画质优先）
        optimization_mode TEXT NOT NULL DEFAULT 'motion',
        -- 'h264' | 'vp8' | 'vp9'
        codec             TEXT NOT NULL DEFAULT 'h264',
        enabled           INTEGER NOT NULL DEFAULT 1,   -- 软删除
        is_builtin        INTEGER NOT NULL DEFAULT 0,   -- 是否初始播种项
        sort_order        INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL DEFAULT 0,
        updated_at        INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_quality_presets_enabled
      ON quality_presets(enabled, sort_order);
    `);

    // 会话上的画质参数快照（自由画质：预设或自定义都落在这里，且不可变）
    const sessionCols = db.prepare('PRAGMA table_info(sessions)').all() as any[];
    if (!sessionCols.some((c) => c.name === 'quality_preset_id')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN quality_preset_id TEXT`);
    }
    if (!sessionCols.some((c) => c.name === 'quality_config')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN quality_config TEXT`);
    }
    if (!sessionCols.some((c) => c.name === 'optimization_mode')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN optimization_mode TEXT`);
    }
    if (!sessionCols.some((c) => c.name === 'codec')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN codec TEXT`);
    }
  },
};
