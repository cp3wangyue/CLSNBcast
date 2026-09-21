import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migration-runner';
import { MIGRATIONS } from './migrations';
import { baseline } from './migrations/001-baseline';
import type { Migration } from './migrations/types';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as any[];
  return rows.map((r) => r.name);
}

function indexNames(db: Database.Database): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as any[];
  return rows.map((r) => r.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  return rows.map((c) => c.name);
}

function appliedVersions(db: Database.Database): number[] {
  const rows = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as any[];
  return rows.map((r) => r.version);
}

const stub = (version: number, name = `m${version}`): Migration => ({
  version,
  name,
  up: () => undefined,
});

// 从注册表推导期望值，而不是写死迁移列表 —— 否则每加一个迁移都要改一遍这些断言。
const ALL_APPLIED = MIGRATIONS.map((m) => ({ version: m.version, name: m.name }));
const ALL_VERSIONS = MIGRATIONS.map((m) => m.version);
const MAX_VERSION = Math.max(...ALL_VERSIONS);

// ===== 注册表 =====

describe('MIGRATIONS 注册表', () => {
  it('baseline 已注册为 version 1', () => {
    expect(MIGRATIONS[0]).toBe(baseline);
    expect(baseline.version).toBe(1);
    expect(baseline.name).toBe('baseline');
  });

  it('version 严格升序且唯一', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });
});

// ===== 新库 =====

describe('runMigrations — 新库', () => {
  it('应用全部已注册迁移并逐条记录', () => {
    const db = freshDb();
    const logs: string[] = [];
    const result = runMigrations(db, MIGRATIONS, (m) => logs.push(m));

    expect(result.applied).toEqual(ALL_APPLIED);
    expect(result.alreadyApplied).toBe(0);
    expect(result.schemaVersion).toBe(MAX_VERSION);
    expect(result.unknownVersions).toEqual([]);
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
    expect(logs.some((l) => l.includes('Applying migration 1: baseline'))).toBe(true);
  });

  it('建出全部业务表', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'global_config',
        'servers',
        'server_events',
        'sessions',
        'notices',
        'notice_targets',
        'kook_webhook_events',
        'kook_webhook_effects',
        'agora_providers',
        'schema_migrations',
      ]),
    );
  });

  it('servers 列齐全（含原本靠 ALTER 补的列）', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);
    expect(columnNames(db, 'servers')).toEqual(
      expect.arrayContaining([
        'server_id',
        'platform',
        'external_id',
        'open_id',
        'guild_name',
        'owner_id',
        'owner_username',
        'password_hash',
        'bound',
        'status',
        'agora_app_id',
        'agora_app_certificate',
        'agora_token_expire_sec',
        'allowed_qualities',
        'trigger_words',
        'idle_timeout_sec',
        'heartbeat_interval_sec',
        'no_viewer_timeout_sec',
        'public_domain',
        'allow_low_latency',
        'rebound_at',
        'bind_token',
        'bind_token_expires',
        'server_secret',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('sessions 列齐全', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);
    expect(columnNames(db, 'sessions')).toEqual(
      expect.arrayContaining([
        'id',
        'token',
        'channel',
        'server_id',
        'sharer_user_id',
        'sharer_username',
        'guild_id',
        'target_channel_id',
        'status',
        'viewer_count',
        'peak_viewers',
        'total_viewer_joins',
        'viewer_duration_ms',
        'quality',
        'card_message_id',
        'manual_created',
        'created_at',
        'started_at',
        'ended_at',
        'duration_ms',
        'last_heartbeat',
        'grace_started_at',
        'grace_reason',
        'last_viewer_at',
        'publisher_client_id',
        'low_latency',
        // 迁移 002：Provider 绑定。这两列不在 ALLOWED_SESSION_COLS 里，只能通过
        // bindSessionProvider() 写入一次，用于保证同一 Session 的 App ID 不被中途替换。
        'provider_id',
        'agora_app_id',
      ]),
    );
  });

  it('agora_providers 列齐全（含加密列与可空配额）', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);
    expect(columnNames(db, 'agora_providers')).toEqual(
      expect.arrayContaining([
        'id',
        'owner_type',
        'owner_id',
        'name',
        'app_id',
        'app_certificate_enc',
        'customer_id',
        'customer_secret_enc',
        'enabled',
        'priority',
        'token_expire_sec',
        'health_status',
        'health_checked_at',
        'health_message',
        'monthly_quota_standard_minutes',
        'quota_enforced',
        'estimated_usage_standard_minutes',
        'usage_period_key',
        'last_used_at',
        'allowed_preset_ids',
        'note',
        'created_at',
        'updated_at',
      ]),
    );

    // 配额列必须可空（不写死 10000），且默认就是 NULL
    const info = db.prepare('PRAGMA table_info(agora_providers)').all() as any[];
    const quotaCol = info.find((c) => c.name === 'monthly_quota_standard_minutes');
    expect(quotaCol.notnull).toBe(0);
  });

  it('用量账本三张表都建好，含 period_key 与未关闭区间索引', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);

    expect(tableNames(db)).toEqual(
      expect.arrayContaining(['usage_events', 'usage_intervals', 'provider_usage_monthly']),
    );

    expect(columnNames(db, 'usage_events')).toEqual(
      expect.arrayContaining([
        'id', 'session_id', 'provider_id', 'server_id', 'role', 'actor_id',
        'event_type', 'occurred_at', 'tier', 'width', 'height', 'frame_rate',
        'bitrate_max', 'low_latency', 'detail',
      ]),
    );

    expect(columnNames(db, 'usage_intervals')).toEqual(
      expect.arrayContaining([
        'id', 'session_id', 'provider_id', 'server_id', 'role', 'actor_id', 'tier',
        'width', 'height', 'frame_rate', 'bitrate_max', 'low_latency',
        'billing_model', 'coefficient', 'period_key', 'started_at', 'ended_at',
        'duration_ms', 'standard_ms', 'closed_reason', 'created_at',
      ]),
    );

    expect(columnNames(db, 'provider_usage_monthly')).toEqual(
      expect.arrayContaining([
        'provider_id', 'period_key', 'standard_minutes', 'publisher_minutes',
        'viewer_minutes', 'session_count', 'updated_at',
      ]),
    );

    // period_key 是 NOT NULL：周期归属在开启区间时确定，不允许事后为空
    const intervalCols = db.prepare('PRAGMA table_info(usage_intervals)').all() as any[];
    expect(intervalCols.find((c) => c.name === 'period_key').notnull).toBe(1);
    // ended_at 必须可空：NULL 表示区间仍在进行
    expect(intervalCols.find((c) => c.name === 'ended_at').notnull).toBe(0);

    const indexes = indexNames(db);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_usage_events_session',
        'idx_usage_events_provider',
        'idx_usage_intervals_provider',
        'idx_usage_intervals_period',
        'idx_usage_intervals_session',
        'idx_usage_intervals_open',
      ]),
    );
  });

  it('provider_usage_monthly 以 (provider_id, period_key) 为主键', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);

    const cols = db.prepare('PRAGMA table_info(provider_usage_monthly)').all() as any[];
    const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(pk).toEqual(['provider_id', 'period_key']);
  });

  it('建立全部索引，含唯一索引 idx_servers_platform_external_id', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);
    expect(indexNames(db)).toEqual(
      expect.arrayContaining([
        'idx_sessions_token',
        'idx_sessions_server_id',
        'idx_sessions_status',
        'idx_server_events_server_id',
        'idx_servers_platform_external_id',
        'idx_notices_enabled_order',
        'idx_notice_targets_page',
        'idx_kook_webhook_claim',
        'idx_kook_webhook_sn',
        'idx_kook_webhook_effect_status',
      ]),
    );
    const unique = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_servers_platform_external_id'")
      .get() as any;
    expect(unique).toBeTruthy();
  });

  it('播种默认全局配置与默认公告', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);

    const cfg = new Map(
      (db.prepare('SELECT key, value FROM global_config').all() as any[]).map((r) => [
        r.key,
        r.value,
      ]),
    );
    expect(cfg.get('publicDomain')).toBe('http://localhost:3520');
    expect(JSON.parse(cfg.get('triggerWordLabels')!)).toEqual(['屏幕共享', '共享屏幕']);
    expect(cfg.has('kookVerifyToken')).toBe(true);
    expect(cfg.has('kookEncryptKey')).toBe(true);
    expect(cfg.has('legacyAdminSunsetAt')).toBe(true);

    expect(
      (db.prepare("SELECT COUNT(*) c FROM notices WHERE id='view-adaptive-bitrate'").get() as any).c,
    ).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) c FROM notice_targets WHERE notice_id='view-adaptive-bitrate'").get() as any).c,
    ).toBe(1);
  });
});

// ===== 幂等 =====

describe('runMigrations — 幂等', () => {
  it('第二次运行不重复应用', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);
    const second = runMigrations(db, MIGRATIONS);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(MIGRATIONS.length);
    expect(second.schemaVersion).toBe(MAX_VERSION);
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
  });

  it('重复运行不会重复播种公告', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);
    runMigrations(db, MIGRATIONS);
    expect((db.prepare('SELECT COUNT(*) c FROM notices').get() as any).c).toBe(1);
  });
});

// ===== 存量库（无 schema_migrations）=====

describe('runMigrations — 存量库接管', () => {
  it('把旧库当作未应用而重跑 baseline，且不丢数据', () => {
    const db = freshDb();

    // 1. 先建出「旧代码创建的库」
    runMigrations(db, MIGRATIONS);

    // 2. 写入业务数据，模拟真实存量库
    db.prepare(
      `INSERT INTO servers (server_id, platform, external_id, guild_name, created_at, updated_at)
       VALUES ('123', 'kook', '123', '测试服务器', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, token, channel, sharer_user_id, sharer_username, created_at)
       VALUES ('s1', 'tok1', 'cb_abc', 'u1', '用户', 1)`,
    ).run();

    // 3. 删掉版本表，回到「旧代码没有 schema_migrations」的状态
    db.exec('DROP TABLE schema_migrations');

    // 4. 用新框架接管
    const result = runMigrations(db, MIGRATIONS);
    expect(result.applied).toEqual(ALL_APPLIED);
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);

    // 5. 数据仍在
    expect((db.prepare('SELECT guild_name FROM servers WHERE server_id=?').get('123') as any).guild_name).toBe('测试服务器');
    expect((db.prepare('SELECT token FROM sessions WHERE id=?').get('s1') as any).token).toBe('tok1');
    expect(tableNames(db)).toContain('sessions');
  });

  it('旧库中已有的 server_secret 不会被覆盖', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);
    db.prepare(
      `INSERT INTO servers (server_id, platform, external_id, server_secret, created_at, updated_at)
       VALUES ('9', 'kook', '9', 'keep-me', 1, 1)`,
    ).run();
    db.exec('DROP TABLE schema_migrations');

    runMigrations(db, MIGRATIONS);

    expect((db.prepare('SELECT server_secret FROM servers WHERE server_id=?').get('9') as any).server_secret).toBe('keep-me');
  });

  it('旧库中已有的自定义配置不会被重置', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS);
    db.prepare("UPDATE global_config SET value='https://share.example.com' WHERE key='publicDomain'").run();
    db.exec('DROP TABLE schema_migrations');

    runMigrations(db, MIGRATIONS);

    expect((db.prepare("SELECT value FROM global_config WHERE key='publicDomain'").get() as any).value).toBe(
      'https://share.example.com',
    );
  });
});

// ===== 注册表校验 =====

describe('runMigrations — 注册表校验', () => {
  it('拒绝重复 version', () => {
    expect(() => runMigrations(freshDb(), [stub(1), stub(1)])).toThrow(/Duplicate migration version 1/);
  });

  it('拒绝非升序', () => {
    expect(() => runMigrations(freshDb(), [stub(2), stub(1)])).toThrow(/ordered ascending/);
  });

  it('拒绝非正整数 version', () => {
    expect(() => runMigrations(freshDb(), [stub(0)])).toThrow(/positive integer/);
    expect(() => runMigrations(freshDb(), [stub(1.5)])).toThrow(/positive integer/);
    expect(() => runMigrations(freshDb(), [stub(-1)])).toThrow(/positive integer/);
  });

  it('拒绝空 name', () => {
    expect(() => runMigrations(freshDb(), [stub(1, '')])).toThrow(/empty name/);
  });

  it('注册表非法时不创建 schema_migrations（先校验后建表）', () => {
    const db = freshDb();
    expect(() => runMigrations(db, [stub(1), stub(1)])).toThrow();
    expect(tableNames(db)).not.toContain('schema_migrations');
  });
});

// ===== 失败回滚 =====

describe('runMigrations — 失败回滚', () => {
  it('迁移抛错时回滚改动且不写入记录', () => {
    const db = freshDb();
    const failing: Migration = {
      version: 1,
      name: 'boom',
      up: ({ db: inner }) => {
        inner.exec('CREATE TABLE partial_work (id INTEGER PRIMARY KEY)');
        throw new Error('migration failed');
      },
    };

    expect(() => runMigrations(db, [failing])).toThrow('migration failed');
    expect(tableNames(db)).not.toContain('partial_work');
    expect(appliedVersions(db)).toEqual([]);
  });

  it('修复后可重试（失败未留记录，重跑会再次执行）', () => {
    const db = freshDb();
    let shouldFail = true;
    const flaky: Migration = {
      version: 1,
      name: 'flaky',
      up: ({ db: inner }) => {
        if (shouldFail) throw new Error('first attempt fails');
        inner.exec('CREATE TABLE eventual (id INTEGER PRIMARY KEY)');
      },
    };

    expect(() => runMigrations(db, [flaky])).toThrow('first attempt fails');

    shouldFail = false;
    const result = runMigrations(db, [flaky]);
    expect(result.applied).toEqual([{ version: 1, name: 'flaky' }]);
    expect(tableNames(db)).toContain('eventual');
  });

  it('已应用的迁移不会被执行第二次', () => {
    const db = freshDb();
    let calls = 0;
    const once: Migration = {
      version: 1,
      name: 'once',
      up: () => {
        calls += 1;
      },
    };

    runMigrations(db, [once]);
    runMigrations(db, [once]);
    expect(calls).toBe(1);
  });
});

// ===== 降级场景 =====

describe('runMigrations — 降级场景', () => {
  it('记录中存在注册表没有的 version 时只告警不报错', () => {
    const db = freshDb();
    runMigrations(db, [stub(1), stub(2)]);

    const logs: string[] = [];
    const result = runMigrations(db, [stub(1)], (m) => logs.push(m));

    expect(result.unknownVersions).toEqual([2]);
    expect(result.schemaVersion).toBe(2);
    expect(logs.some((l) => l.includes('version 2'))).toBe(true);
  });
});

// ===== 多迁移顺序 =====

describe('runMigrations — 多迁移顺序', () => {
  it('按 version 升序执行并逐条记录', () => {
    const db = freshDb();
    const order: number[] = [];
    const migrations: Migration[] = [1, 2, 3].map((v) => ({
      version: v,
      name: `m${v}`,
      up: () => {
        order.push(v);
      },
    }));

    const result = runMigrations(db, migrations);

    expect(order).toEqual([1, 2, 3]);
    expect(result.applied.map((a) => a.version)).toEqual([1, 2, 3]);
    expect(result.schemaVersion).toBe(3);
    expect(appliedVersions(db)).toEqual([1, 2, 3]);
  });

  it('部分已应用时只跑剩余的', () => {
    const db = freshDb();
    runMigrations(db, [stub(1)]);

    const order: number[] = [];
    const rest: Migration[] = [1, 2, 3].map((v) => ({
      version: v,
      name: `m${v}`,
      up: () => {
        order.push(v);
      },
    }));
    const result = runMigrations(db, rest);

    expect(order).toEqual([2, 3]);
    expect(result.alreadyApplied).toBe(1);
    expect(result.applied.map((a) => a.version)).toEqual([2, 3]);
  });
});
