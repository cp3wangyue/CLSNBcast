import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service';
import { SecretCryptoService } from './secret-crypto.service';
import { looksEncrypted } from './secret-crypto';

const HEX_KEY = 'a'.repeat(64);

describe('SecretCryptoService — global_config 秘密（Phase 5）', () => {
  let dir: string;
  let db: DatabaseService;
  let crypto: SecretCryptoService;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    dir = mkdtempSync(join(tmpdir(), 'clsnbcast-gsecret-'));
    process.env.DATA_DIR = dir;
    process.env.SECRET_ENCRYPTION_KEY = HEX_KEY;
    db = new DatabaseService();
    crypto = new SecretCryptoService(db);
  });

  afterEach(() => {
    db.onModuleDestroy();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.SECRET_ENCRYPTION_KEY;
  });

  it('写入后库中是密文，读取时能解回原文', () => {
    crypto.setGlobalSecret('kookBotToken', 'bot-token-plain');

    const stored = db.getGlobalConfigValue('kookBotToken');
    expect(looksEncrypted(stored)).toBe(true);
    expect(stored).not.toContain('bot-token-plain');
    expect(crypto.getGlobalSecret('kookBotToken')).toBe('bot-token-plain');
  });

  it('三个 KOOK 秘密都能加密往返', () => {
    for (const name of ['kookBotToken', 'kookVerifyToken', 'kookEncryptKey'] as const) {
      crypto.setGlobalSecret(name, `value-of-${name}`);
      expect(crypto.getGlobalSecret(name)).toBe(`value-of-${name}`);
    }
    expect(looksEncrypted(db.getGlobalConfigValue('kookVerifyToken'))).toBe(true);
    expect(looksEncrypted(db.getGlobalConfigValue('kookEncryptKey'))).toBe(true);
  });

  it('空值时库中存空串，读取返回空串（不抛错）', () => {
    crypto.setGlobalSecret('kookBotToken', '   ');
    expect(db.getGlobalConfigValue('kookBotToken')).toBe('');
    expect(crypto.getGlobalSecret('kookBotToken')).toBe('');
    expect(crypto.getGlobalSecret('kookVerifyToken')).toBe('');
  });

  it('🔑 旧库遗留的明文：读取时自动升级并正确返回（透明迁移）', () => {
    db.setGlobalConfig('kookBotToken', 'legacy-plain-token');

    expect(crypto.getGlobalSecret('kookBotToken')).toBe('legacy-plain-token');
    // 顺带已加密落库
    expect(looksEncrypted(db.getGlobalConfigValue('kookBotToken'))).toBe(true);
  });

  it('encryptLegacyGlobalSecrets 批量加密残留明文', () => {
    db.setGlobalConfig('kookBotToken', 'p1');
    db.setGlobalConfig('kookVerifyToken', 'p2');
    db.setGlobalConfig('kookEncryptKey', 'p3');

    expect(crypto.encryptLegacyGlobalSecrets()).toBe(3);
    expect(looksEncrypted(db.getGlobalConfigValue('kookBotToken'))).toBe(true);
    expect(crypto.getGlobalSecret('kookBotToken')).toBe('p1');
  });

  it('已经是密文的不重复加密（幂等）', () => {
    crypto.setGlobalSecret('kookBotToken', 'once');
    const before = db.getGlobalConfigValue('kookBotToken');
    expect(crypto.encryptLegacyGlobalSecrets()).toBe(0);
    expect(db.getGlobalConfigValue('kookBotToken')).toBe(before);
    expect(crypto.getGlobalSecret('kookBotToken')).toBe('once');
  });

  it('🔒 没有主密钥时：跳过迁移并告警，服务仍可读到明文（存量部署不会起不来）', () => {
    delete process.env.SECRET_ENCRYPTION_KEY;
    const noKey = new SecretCryptoService(db);
    db.setGlobalConfig('kookBotToken', 'still-plain');

    expect(noKey.encryptLegacyGlobalSecrets()).toBe(0);
    expect(noKey.getGlobalSecret('kookBotToken')).toBe('still-plain');
    // 库中保持明文，不会丢失数据
    expect(db.getGlobalConfigValue('kookBotToken')).toBe('still-plain');
  });

  it('🔒 没密钥时写入秘密必须抛错（绝不静默存明文）', () => {
    delete process.env.SECRET_ENCRYPTION_KEY;
    const noKey = new SecretCryptoService(db);

    expect(() => noKey.setGlobalSecret('kookBotToken', 'x')).toThrow();
  });

  it('写入后日志不含明文', () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log');
    crypto.setGlobalSecret('kookBotToken', 'secret-log-check');

    for (const call of logSpy.mock.calls) {
      expect(call.map(String).join(' ')).not.toContain('secret-log-check');
    }
  });
});
