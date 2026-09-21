import type { Migration } from './types';

/**
 * 画质与计费配置表（单行）。
 *
 * **只建表，不播种。** 默认值由 `QualityConfigService` 在首次读取时写入，
 * 这样「默认值」只有一处定义。若在这里播种，服务里还得再留一份兜底默认值，
 * 两者迟早会漂移；而且日后调整默认值会改变一个「已发布迁移」的行为。
 *
 * 单行由 `CHECK (id = 1)` 约束，避免出现第二行导致读取结果不确定。
 */
export const qualityConfig: Migration = {
  version: 4,
  name: 'quality-config',
  up: ({ db }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quality_config (
        id                    INTEGER PRIMARY KEY CHECK (id = 1),
        -- JSON: 分辨率档位规则（档位名、像素上界、互动直播与极速直播系数）
        tier_rules            TEXT NOT NULL,
        -- JSON: 音频折算系数（主播 / 互动直播观众 / 极速直播观众）
        audio_coefficients    TEXT NOT NULL,
        -- 元 / 标准分钟
        standard_minute_price REAL NOT NULL,
        -- 计费周期与配额判断使用的时区
        usage_timezone        TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        -- JSON: 自定义画质的参数边界（Phase 3 消费）
        limits                TEXT NOT NULL,
        updated_at            INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
};
