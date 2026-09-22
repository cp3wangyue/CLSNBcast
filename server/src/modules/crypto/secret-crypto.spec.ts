import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service';
import {
  ENVELOPE_VERSION,
  MASTER_KEY_BYTES,
  SecretCryptoError,
  decryptSecret,
  encryptSecret,
  hasAnyEncryptedValue,
  looksEncrypted,
  parseMasterKey,
} from './secret-crypto';
import { SECRET_ENCRYPTION_KEY_ENV, SecretCryptoService } from './secret-crypto.service';

const KEY = Buffer.alloc(MASTER_KEY_BYTES, 7);
const OTHER_KEY = Buffer.alloc(MASTER_KEY_BYTES, 9);
const HEX_KEY = 'a'.repeat(64);
const B64_KEY = Buffer.alloc(MASTER_KEY_BYTES, 5).toString('base64');

const PLAINTEXT = 'agora-app-certificate-0123456789abcdef';

function partsOf(envelope: string): string[] {
  return envelope.split(':');
}

/** 把某一段的 base64 内容翻掉一个字节，用于篡改测试。 */
function flipByte(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) throw new Error('cannot flip a byte of an empty segment');
  buf[0] = buf[0] ^ 0xff;
  return buf.toString('base64');
}

// ===== parseMasterKey =====

describe('parseMasterKey', () => {
  it('接受 64 个十六进制字符', () => {
    const key = parseMasterKey(HEX_KEY);
    expect(key).toHaveLength(MASTER_KEY_BYTES);
    expect(key.toString('hex')).toBe(HEX_KEY);
  });

  it('接受 32 字节的 base64', () => {
    expect(parseMasterKey(B64_KEY)).toHaveLength(MASTER_KEY_BYTES);
  });

  it('先判 hex 再判 base64（64 个 hex 字符本身也是合法 base64，顺序反了会解出 48 字节）', () => {
    // 64 个 hex 字符若按 base64 解会得到 48 字节，必须走 hex 分支
    expect(parseMasterKey('0'.repeat(64))).toHaveLength(MASTER_KEY_BYTES);
  });

  it('忽略首尾空白', () => {
    expect(parseMasterKey(`  ${HEX_KEY}\n`)).toHaveLength(MASTER_KEY_BYTES);
  });

  it('拒绝空值', () => {
    expect(() => parseMasterKey('')).toThrow(SecretCryptoError);
    expect(() => parseMasterKey('   ')).toThrow(/empty/);
  });

  it('拒绝长度不足的密钥', () => {
    expect(() => parseMasterKey('a'.repeat(32))).toThrow(/exactly 32 bytes/);
    expect(() => parseMasterKey(Buffer.alloc(16, 1).toString('base64'))).toThrow(/exactly 32 bytes/);
  });

  it('拒绝长度超出的密钥', () => {
    expect(() => parseMasterKey('a'.repeat(128))).toThrow(/exactly 32 bytes/);
    expect(() => parseMasterKey(Buffer.alloc(64, 1).toString('base64'))).toThrow(/exactly 32 bytes/);
  });

  it('错误信息不含密钥内容', () => {
    const secretish = 'super-secret-key-material';
    try {
      parseMasterKey(secretish);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain(secretish);
    }
  });
});

// ===== 往返 =====

describe('encryptSecret / decryptSecret 往返', () => {
  it('往返还原普通字符串', () => {
    expect(decryptSecret(KEY, encryptSecret(KEY, PLAINTEXT))).toBe(PLAINTEXT);
  });

  it('往返还原空字符串', () => {
    expect(decryptSecret(KEY, encryptSecret(KEY, ''))).toBe('');
  });

  it('往返还原多字节字符与 emoji', () => {
    const text = '声网证书 🔐 中文 mixed-content ✓';
    expect(decryptSecret(KEY, encryptSecret(KEY, text))).toBe(text);
  });

  it('往返还原长文本（4KB）', () => {
    const long = 'x'.repeat(4096);
    expect(decryptSecret(KEY, encryptSecret(KEY, long))).toBe(long);
  });

  it('同一明文两次加密结果不同（独立随机 IV）', () => {
    const a = encryptSecret(KEY, PLAINTEXT);
    const b = encryptSecret(KEY, PLAINTEXT);
    expect(a).not.toBe(b);
    expect(decryptSecret(KEY, a)).toBe(PLAINTEXT);
    expect(decryptSecret(KEY, b)).toBe(PLAINTEXT);
  });
});

// ===== 信封格式 =====

describe('信封格式', () => {
  it('形如 v1:<iv>:<tag>:<ct>', () => {
    const parts = partsOf(encryptSecret(KEY, PLAINTEXT));
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe(ENVELOPE_VERSION);
    expect(Buffer.from(parts[1], 'base64')).toHaveLength(12); // IV
    expect(Buffer.from(parts[2], 'base64')).toHaveLength(16); // GCM tag
    expect(parts[3]).not.toBe('');
  });

  it('信封中不出现明文', () => {
    const envelope = encryptSecret(KEY, PLAINTEXT);
    expect(envelope).not.toContain(PLAINTEXT);
    expect(Buffer.from(envelope).toString('utf8')).not.toContain(PLAINTEXT);
    // 也不出现明文的 base64 形式
    expect(envelope).not.toContain(Buffer.from(PLAINTEXT).toString('base64'));
  });

  it('空明文的密文正文为空，但仍有认证标签', () => {
    const parts = partsOf(encryptSecret(KEY, ''));
    expect(parts[3]).toBe('');
    expect(Buffer.from(parts[2], 'base64')).toHaveLength(16);
  });
});

// ===== 解密失败路径 =====

describe('decryptSecret 失败路径', () => {
  it('密钥不匹配时抛 DECRYPT_FAILED', () => {
    const envelope = encryptSecret(KEY, PLAINTEXT);
    try {
      decryptSecret(OTHER_KEY, envelope);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SecretCryptoError);
      expect((e as SecretCryptoError).code).toBe('DECRYPT_FAILED');
    }
  });

  it('密文正文被篡改时抛 DECRYPT_FAILED', () => {
    const parts = partsOf(encryptSecret(KEY, PLAINTEXT));
    parts[3] = flipByte(parts[3]);
    expect(() => decryptSecret(KEY, parts.join(':'))).toThrow(/wrong key or corrupted ciphertext/);
  });

  it('认证标签被篡改时抛 DECRYPT_FAILED', () => {
    const parts = partsOf(encryptSecret(KEY, PLAINTEXT));
    parts[2] = flipByte(parts[2]);
    expect(() => decryptSecret(KEY, parts.join(':'))).toThrow(/wrong key or corrupted ciphertext/);
  });

  it('IV 被篡改时抛 DECRYPT_FAILED', () => {
    const parts = partsOf(encryptSecret(KEY, PLAINTEXT));
    parts[1] = flipByte(parts[1]);
    expect(() => decryptSecret(KEY, parts.join(':'))).toThrow(/wrong key or corrupted ciphertext/);
  });

  it('段数不对时抛 MALFORMED_ENVELOPE', () => {
    for (const bad of ['', 'v1', 'v1:a:b', 'v1:a:b:c:d']) {
      try {
        decryptSecret(KEY, bad);
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as SecretCryptoError).code).toBe('MALFORMED_ENVELOPE');
      }
    }
  });

  it('IV / 标签长度不对时抛 MALFORMED_ENVELOPE', () => {
    const parts = partsOf(encryptSecret(KEY, PLAINTEXT));
    const shortIv = [parts[0], Buffer.alloc(4).toString('base64'), parts[2], parts[3]].join(':');
    const shortTag = [parts[0], parts[1], Buffer.alloc(4).toString('base64'), parts[3]].join(':');
    expect(() => decryptSecret(KEY, shortIv)).toThrow(/unexpected format/);
    expect(() => decryptSecret(KEY, shortTag)).toThrow(/unexpected format/);
  });

  it('版本前缀不认识时抛 UNSUPPORTED_VERSION', () => {
    const parts = partsOf(encryptSecret(KEY, PLAINTEXT));
    parts[0] = 'v99';
    try {
      decryptSecret(KEY, parts.join(':'));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as SecretCryptoError).code).toBe('UNSUPPORTED_VERSION');
    }
  });

  it('密钥长度非法时抛 MALFORMED_KEY', () => {
    const shortKey = Buffer.alloc(16, 1);
    expect(() => encryptSecret(shortKey, PLAINTEXT)).toThrow(/32-byte buffer/);
    expect(() => decryptSecret(shortKey, encryptSecret(KEY, PLAINTEXT))).toThrow(/32-byte buffer/);
  });

  it('错误信息不含密钥或明文', () => {
    const envelope = encryptSecret(KEY, PLAINTEXT);
    const probes = [
      () => decryptSecret(OTHER_KEY, envelope),
      () => decryptSecret(KEY, `${envelope}extra`),
      () => decryptSecret(KEY, flipByte(envelope)),
    ];
    for (const probe of probes) {
      try {
        probe();
      } catch (e) {
        const message = (e as Error).message;
        expect(message).not.toContain(PLAINTEXT);
        expect(message).not.toContain(KEY.toString('hex'));
      }
    }
  });
});

// ===== 结构判断 =====

describe('looksEncrypted / hasAnyEncryptedValue', () => {
  it('识别真实信封', () => {
    expect(looksEncrypted(encryptSecret(KEY, PLAINTEXT))).toBe(true);
  });

  it('把空值、明文、段数不对、版本不对都判为 false', () => {
    for (const value of ['', 'plain-app-id', 'v1:a:b', 'v1:a:b:c:d', 'v99:a:b:c']) {
      expect(looksEncrypted(value), `value=${value}`).toBe(false);
    }
    expect(looksEncrypted(null)).toBe(false);
    expect(looksEncrypted(undefined)).toBe(false);
  });

  it('hasAnyEncryptedValue 判断集合中是否存在密文', () => {
    const envelope = encryptSecret(KEY, PLAINTEXT);
    expect(hasAnyEncryptedValue([])).toBe(false);
    expect(hasAnyEncryptedValue(['', null, undefined, 'plain'])).toBe(false);
    expect(hasAnyEncryptedValue(['', null, envelope])).toBe(true);
  });
});

// ===== 服务 =====

describe('SecretCryptoService', () => {
  const originalEnv = process.env[SECRET_ENCRYPTION_KEY_ENV];
  let dir: string;
  let db: DatabaseService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clsnbcast-crypto-'));
    process.env.DATA_DIR = dir;
    db = new DatabaseService();
  });

  afterEach(() => {
    db.onModuleDestroy();
    if (originalEnv === undefined) delete process.env[SECRET_ENCRYPTION_KEY_ENV];
    else process.env[SECRET_ENCRYPTION_KEY_ENV] = originalEnv;
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('未设置环境变量时 isConfigured=false，且加解密都抛错（绝不退化为明文）', () => {
    delete process.env[SECRET_ENCRYPTION_KEY_ENV];
    const service = new SecretCryptoService(db);

    expect(service.isConfigured).toBe(false);
    try {
      service.encrypt(PLAINTEXT);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as SecretCryptoError).code).toBe('NOT_CONFIGURED');
    }
    expect(() => service.decrypt('v1:a:b:c')).toThrow(/not configured/);
  });

  it('设置合法密钥后可用，往返正确', () => {
    process.env[SECRET_ENCRYPTION_KEY_ENV] = HEX_KEY;
    const service = new SecretCryptoService(db);

    expect(service.isConfigured).toBe(true);
    expect(service.decrypt(service.encrypt(PLAINTEXT))).toBe(PLAINTEXT);
  });

  it('密钥格式非法时构造即抛错（启动阶段失败，而不是等到第一次加密）', () => {
    process.env[SECRET_ENCRYPTION_KEY_ENV] = 'too-short';
    expect(() => new SecretCryptoService(db)).toThrow(/exactly 32 bytes/);
  });

  it('两个使用同一密钥的服务实例可以互相解密', () => {
    process.env[SECRET_ENCRYPTION_KEY_ENV] = HEX_KEY;
    const a = new SecretCryptoService(db);
    const b = new SecretCryptoService(db);
    expect(b.decrypt(a.encrypt(PLAINTEXT))).toBe(PLAINTEXT);
  });

  it('两个使用不同密钥的服务实例无法互相解密', () => {
    process.env[SECRET_ENCRYPTION_KEY_ENV] = HEX_KEY;
    const a = new SecretCryptoService(db);
    process.env[SECRET_ENCRYPTION_KEY_ENV] = B64_KEY;
    const b = new SecretCryptoService(db);

    expect(() => b.decrypt(a.encrypt(PLAINTEXT))).toThrow(/wrong key or corrupted/);
  });

  describe('assertUsableForExistingSecrets（启动门禁）', () => {
    it('无密钥 + 无密文 → 放行', () => {
      delete process.env[SECRET_ENCRYPTION_KEY_ENV];
      const service = new SecretCryptoService(db);
      expect(() => service.assertUsableForExistingSecrets(['', null, 'plain-app-id'])).not.toThrow();
    });

    it('无密钥 + 库里有密文 → 抛错并记 error 日志', () => {
      const envelope = encryptSecret(KEY, PLAINTEXT);
      delete process.env[SECRET_ENCRYPTION_KEY_ENV];
      const service = new SecretCryptoService(db);
      const errorSpy = vi.spyOn(Logger.prototype, 'error');

      expect(() => service.assertUsableForExistingSecrets(['plain', envelope])).toThrow(/FATAL/);
      expect(errorSpy).toHaveBeenCalled();
      // 门禁日志同样不得泄露密文或明文
      for (const call of errorSpy.mock.calls) {
        expect(String(call[0])).not.toContain(PLAINTEXT);
        expect(String(call[0])).not.toContain(envelope);
      }
    });

    it('有密钥 + 库里有密文 → 放行', () => {
      const envelope = encryptSecret(KEY, PLAINTEXT);
      process.env[SECRET_ENCRYPTION_KEY_ENV] = HEX_KEY;
      const service = new SecretCryptoService(db);
      expect(() => service.assertUsableForExistingSecrets([envelope])).not.toThrow();
    });
  });

  it('构造与使用过程中不把明文写进日志', () => {
    process.env[SECRET_ENCRYPTION_KEY_ENV] = HEX_KEY;
    const logSpy = vi.spyOn(Logger.prototype, 'log');
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const errorSpy = vi.spyOn(Logger.prototype, 'error');

    const service = new SecretCryptoService(db);
    service.encrypt(PLAINTEXT);
    service.decrypt(service.encrypt(PLAINTEXT));
    service.assertUsableForExistingSecrets([service.encrypt(PLAINTEXT)]);

    for (const spy of [logSpy, warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        const rendered = call.map(String).join(' ');
        expect(rendered).not.toContain(PLAINTEXT);
        expect(rendered).not.toContain(HEX_KEY);
      }
    }
  });
});
