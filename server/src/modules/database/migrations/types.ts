import Database from 'better-sqlite3';

/** 迁移执行上下文。迁移只依赖 db 与 log，不依赖 DatabaseService。 */
export interface MigrationContext {
  db: Database.Database;
  /** 输出迁移过程信息；测试里可传入收集器 */
  log: (message: string) => void;
}

/**
 * 一次数据库结构变更。
 *
 * 约定：
 * - `version` 必须唯一、正整数；一旦发布**不可复用、不可修改**。
 *   要改已发布的行为，新增一个 version。
 * - `up` 由运行器包在事务里执行（内部可安全再调用 `db.transaction`，
 *   SQLite 用 savepoint 处理嵌套），因此失败会整体回滚且不写入 schema_migrations。
 * - `up` 必须**可重复执行（幂等）**：存量库首次被接管时没有 schema_migrations 表，
 *   会被判定为「未应用」而重跑一次，靠幂等性保证安全。
 */
export interface Migration {
  version: number;
  name: string;
  up: (ctx: MigrationContext) => void;
}
