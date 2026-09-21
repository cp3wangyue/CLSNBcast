import Database from 'better-sqlite3';
import type { Migration, MigrationContext } from './migrations/types';

export interface AppliedMigration {
  version: number;
  name: string;
}

export interface MigrationRunResult {
  /** 本次新应用的迁移，按 version 升序 */
  applied: AppliedMigration[];
  /** 运行前已记录在 schema_migrations 的迁移数量 */
  alreadyApplied: number;
  /** 运行结束后的 schema 版本（已应用的最大 version；没有任何迁移时为 0） */
  schemaVersion: number;
  /**
   * 记录在 schema_migrations 里、但本构建的注册表中已不存在的 version。
   * 典型场景是代码回滚到旧版本后连到了新库。仅告警，不报错。
   */
  unknownVersions: number[];
}

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );
`;

/** 校验注册表：version 为正整数、唯一，且严格升序。 */
function validateRegistry(migrations: Migration[]): void {
  const seen = new Set<number>();
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(
        `Invalid migration version ${migration.version} (${migration.name}): must be a positive integer`,
      );
    }
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version} (${migration.name})`);
    }
    if (migration.version <= previous) {
      throw new Error(
        `Migrations must be ordered ascending: ${migration.version} (${migration.name}) follows ${previous}`,
      );
    }
    if (!migration.name) {
      throw new Error(`Migration ${migration.version} has an empty name`);
    }
    seen.add(migration.version);
    previous = migration.version;
  }
}

/**
 * 按 version 升序执行尚未应用的迁移。
 *
 * 每个迁移与其 `schema_migrations` 记录在**同一个事务**内提交，因此：
 * - 迁移抛错 → 该迁移的所有改动回滚，且不写入记录，下次启动会重试；
 * - 记录写入失败 → 同样整体回滚。
 *
 * 幂等：已记录的迁移直接跳过。没有 `schema_migrations` 表的存量库会被判定为
 * 「全部未应用」，因此每个迁移的 `up` 都必须是幂等的（见 `types.ts`）。
 */
export function runMigrations(
  db: Database.Database,
  migrations: Migration[],
  log: (message: string) => void = () => undefined,
): MigrationRunResult {
  validateRegistry(migrations);

  db.exec(CREATE_MIGRATIONS_TABLE);

  const recordedRows = db
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all() as { version: number; name: string }[];
  const recorded = new Set(recordedRows.map((row) => row.version));

  const known = new Set(migrations.map((migration) => migration.version));
  const unknownVersions = recordedRows
    .filter((row) => !known.has(row.version))
    .map((row) => row.version);
  for (const version of unknownVersions) {
    log(`Warning: schema_migrations has version ${version}, absent from this build's registry`);
  }

  const applied: AppliedMigration[] = [];
  for (const migration of migrations) {
    if (recorded.has(migration.version)) continue;

    log(`Applying migration ${migration.version}: ${migration.name}`);
    const ctx: MigrationContext = { db, log };
    const runInTransaction = db.transaction(() => {
      migration.up(ctx);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, Date.now());
    });
    runInTransaction();

    applied.push({ version: migration.version, name: migration.name });
  }

  const allVersions = [...recorded, ...applied.map((entry) => entry.version)];
  const schemaVersion = allVersions.length > 0 ? Math.max(...allVersions) : 0;

  return {
    applied,
    alreadyApplied: recorded.size,
    schemaVersion,
    unknownVersions,
  };
}
