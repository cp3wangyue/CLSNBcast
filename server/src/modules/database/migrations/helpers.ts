import Database from 'better-sqlite3';

/** 写入或覆盖一条 global_config。 */
export function setGlobalConfig(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO global_config (key, value) VALUES (?, ?)').run(key, value);
}

/** 逗号分隔的触发词 → 去重后的数组。 */
export function parseTriggerWords(value?: string): string[] {
  return [...new Set((value || '').split(',').map((word) => word.trim()).filter(Boolean))];
}
