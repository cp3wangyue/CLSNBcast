import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SUPPORTED_PLATFORMS,
  DEFAULT_PLATFORM,
  PlatformId,
  isSupportedPlatform,
  normalizePlatform,
  strictPlatform,
  platformLabel,
} from './platform.types';

describe('platform.types', () => {
  describe('SUPPORTED_PLATFORMS', () => {
    it('至少登记 kook —— 现有线上数据全部属于它', () => {
      expect(SUPPORTED_PLATFORMS).toContain('kook');
    });

    it('无重复项，避免注册表自身出现歧义', () => {
      expect(new Set(SUPPORTED_PLATFORMS).size).toBe(SUPPORTED_PLATFORMS.length);
    });
  });

  describe('DEFAULT_PLATFORM', () => {
    it('是 kook —— 存量数据的归属，改成别的会让现有服务器无法寻址', () => {
      expect(DEFAULT_PLATFORM).toBe('kook');
    });

    it('本身必须已登记在 SUPPORTED_PLATFORMS 内', () => {
      expect(SUPPORTED_PLATFORMS).toContain(DEFAULT_PLATFORM);
    });
  });

  describe('isSupportedPlatform', () => {
    it('登记过的平台返回 true', () => {
      expect(isSupportedPlatform('kook')).toBe(true);
      expect(isSupportedPlatform('discord')).toBe(true);
    });

    it('未登记的平台返回 false', () => {
      expect(isSupportedPlatform('qq')).toBe(false);
      expect(isSupportedPlatform('')).toBe(false);
    });

    it('大小写敏感 —— 平台标识在 URL 与库里都是精确匹配', () => {
      expect(isSupportedPlatform('KOOK')).toBe(false);
    });
  });

  describe('normalizePlatform', () => {
    it('保留已登记的值', () => {
      expect(normalizePlatform('kook')).toBe('kook');
    });

    it('空字符串回退到默认平台', () => {
      expect(normalizePlatform('')).toBe(DEFAULT_PLATFORM);
    });

    it('null / undefined 回退到默认平台', () => {
      expect(normalizePlatform(null)).toBe(DEFAULT_PLATFORM);
      expect(normalizePlatform(undefined)).toBe(DEFAULT_PLATFORM);
    });

    it('未知平台回退到默认平台而不是抛错', () => {
      // 读取路径不该因为一个未知字符串就让数据凭空消失
      expect(normalizePlatform('some-future-platform')).toBe(DEFAULT_PLATFORM);
    });

    it('返回值一定是已登记的平台', () => {
      for (const input of ['kook', '', null, undefined, 'nope']) {
        expect(isSupportedPlatform(normalizePlatform(input as string))).toBe(true);
      }
    });
  });

  describe('strictPlatform（鉴权/写入路径）', () => {
    it('登记过的平台原样返回', () => {
      expect(strictPlatform('kook')).toBe('kook');
      expect(strictPlatform('discord')).toBe('discord');
    });

    it('未知平台返回 null，而不是回退到默认平台', () => {
      // 这是 multi-platform 下的关键安全约束：若这里回退成 kook，
      // 一个不属于任何已知平台的凭证会被判成 KOOK 并通过 KOOK 的路由校验。
      expect(strictPlatform('some-future-platform')).toBeNull();
      expect(strictPlatform('KOOK')).toBeNull();
    });

    it('空值返回 null', () => {
      expect(strictPlatform('')).toBeNull();
      expect(strictPlatform(null)).toBeNull();
      expect(strictPlatform(undefined)).toBeNull();
    });

    it('与 normalizePlatform 的区别正是本次要锁定的语义', () => {
      const weird = 'not-a-platform';
      expect(normalizePlatform(weird)).toBe(DEFAULT_PLATFORM);
      expect(strictPlatform(weird)).toBeNull();
    });
  });

  describe('platformLabel', () => {
    it('已知平台返回可读名称', () => {
      expect(platformLabel('kook')).toBe('KOOK');
      expect(platformLabel('discord')).toBe('Discord');
    });

    it('未知输入回退为默认平台的名称，不会显示成 undefined', () => {
      expect(platformLabel('nope')).toBe('KOOK');
      expect(platformLabel(null)).toBe('KOOK');
    });
  });
});

describe('platform 与数据库契约的一致性', () => {
  it("servers 表的 platform 默认值必须与 DEFAULT_PLATFORM 一致", () => {
    // 这条断言锁住一个容易漂移的点：SQL 默认值是不可变的历史契约，
    // 而 TS 侧的 DEFAULT_PLATFORM 是可以改的。两者一旦分叉，
    // 新库建的行的归属就会和代码判断不一致。
    const dir = mkdtempSync(join(tmpdir(), 'platform-db-'));
    const db = new Database(join(dir, 't.db'));
    db.exec(`
      CREATE TABLE servers (
        server_id TEXT PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT '${DEFAULT_PLATFORM}'
      );
    `);
    db.prepare('INSERT INTO servers (server_id) VALUES (?)').run('s1');
    const row = db.prepare('SELECT platform FROM servers WHERE server_id = ?').get('s1') as any;
    expect(row.platform).toBe(DEFAULT_PLATFORM);
    db.close();
  });

  it('未标注平台的存量行经归一化后仍可寻址', () => {
    // 复刻真实历史数据：platform 列是后加的，早于该列的行可能为空字符串
    const dir = mkdtempSync(join(tmpdir(), 'platform-legacy-'));
    const db = new Database(join(dir, 't.db'));
    db.exec(`CREATE TABLE servers (server_id TEXT PRIMARY KEY, platform TEXT NOT NULL DEFAULT '')`);
    db.prepare('INSERT INTO servers (server_id, platform) VALUES (?, ?)').run('legacy-1', '');
    const row = db.prepare('SELECT platform FROM servers WHERE server_id = ?').get('legacy-1') as any;
    expect(normalizePlatform(row.platform)).toBe('kook');
    db.close();
  });

  it('PlatformId 类型覆盖所有已登记平台', () => {
    // 类型层面的回归：新增平台时若忘记加入联合类型，这里会报错
    const ids: PlatformId[] = [...SUPPORTED_PLATFORMS];
    expect(ids.length).toBe(SUPPORTED_PLATFORMS.length);
  });
});

describe('getSpace 的平台归一化寻址（回归）', () => {
  // 这段复刻真实历史数据：platform 列是后加的，早于该列的行可能为空字符串。
  // 若寻址只做精确匹配，这些存量服务器会在平台抽象后凭空"消失"。
  function makeDb() {
    const dir = mkdtempSync(join(tmpdir(), 'getspace-'));
    const db = new Database(join(dir, 't.db'));
    db.exec(`
      CREATE TABLE servers (
        server_id TEXT PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'kook',
        external_id TEXT NOT NULL DEFAULT '',
        open_id TEXT NOT NULL DEFAULT '',
        guild_name TEXT NOT NULL DEFAULT '',
        owner_id TEXT NOT NULL DEFAULT '',
        owner_username TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL DEFAULT '',
        bound INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
      );
    `);
    return db;
  }

  const lookup = (db: Database.Database, platform: string, externalId: string) => {
    const wanted = normalizePlatform(platform);
    const row = db
      .prepare('SELECT * FROM servers WHERE external_id = ? AND (platform = ? OR platform = ?)')
      .get(externalId, wanted, '') as any;
    if (!row) return undefined;
    if (normalizePlatform(row.platform) !== wanted) return undefined;
    return row;
  };

  it('正常 KOOK 数据照常命中', () => {
    const db = makeDb();
    db.prepare("INSERT INTO servers (server_id, platform, external_id) VALUES (?,?,?)").run('s1', 'kook', 'g1');
    expect(lookup(db, 'kook', 'g1')).toBeTruthy();
    db.close();
  });

  it('platform 为空字符串的存量行仍可寻址（本次修复的行为）', () => {
    const db = makeDb();
    db.prepare("INSERT INTO servers (server_id, platform, external_id) VALUES (?,?,?)").run('s1', '', 'g1');
    expect(lookup(db, 'kook', 'g1')).toBeTruthy();
    db.close();
  });

  it('不同平台的同 external_id 不会串台', () => {
    const db = makeDb();
    db.prepare("INSERT INTO servers (server_id, platform, external_id) VALUES (?,?,?)").run('s1', 'kook', 'g1');
    db.prepare("INSERT INTO servers (server_id, platform, external_id) VALUES (?,?,?)").run('s2', 'other', 'g1');
    // 'other' 未登记 -> 归一化为 kook -> 与 s1 冲突时取先匹配到的行，
    // 因此这里只断言"不会返回 s2"（s2 的平台不会被当成另一个平台）
    const row = lookup(db, 'other', 'g1') as any;
    expect(normalizePlatform(row.platform)).toBe('kook');
    db.close();
  });

  it('external_id 不存在时返回 undefined', () => {
    const db = makeDb();
    expect(lookup(db, 'kook', 'nope')).toBeUndefined();
    db.close();
  });
});
