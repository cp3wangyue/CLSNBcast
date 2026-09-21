import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * 秘密加密的纯逻辑部分（不依赖 NestJS，便于直接单测）。
 *
 * 方案：**AES-256-GCM**，每条记录独立随机 IV，输出带版本前缀的信封：
 *
 * ```
 * v1:<iv_base64>:<tag_base64>:<ciphertext_base64>
 * ```
 *
 * 为什么用 GCM 而不是 CBC：GCM 自带认证标签，密文被篡改或密钥不匹配时解密会失败，
 * 而不是解出一段垃圾明文。这对「凭证被静默改坏」这类问题很重要。
 *
 * 为什么带版本前缀：将来轮换算法或密钥时，可以在 `decryptSecret` 里保留旧版本分支，
 * 让存量数据无需一次性重写。
 */

/** 主密钥长度：AES-256 要求 32 字节。 */
export const MASTER_KEY_BYTES = 32;

/** 当前信封版本。轮换算法时递增。 */
export const ENVELOPE_VERSION = 'v1';

/** GCM 推荐的 IV 长度。 */
const IV_BYTES = 12;

/** GCM 认证标签长度（最大值）。 */
const TAG_BYTES = 16;

/** 64 个十六进制字符 = 32 字节。 */
const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

export type SecretCryptoErrorCode =
  | 'NOT_CONFIGURED'
  | 'MALFORMED_KEY'
  | 'MALFORMED_ENVELOPE'
  | 'UNSUPPORTED_VERSION'
  | 'DECRYPT_FAILED';

/**
 * 秘密加解密相关的错误。
 *
 * ⚠️ 所有 message 都**不得包含密钥内容或明文**，只能描述问题本身。
 */
export class SecretCryptoError extends Error {
  constructor(
    readonly code: SecretCryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SecretCryptoError';
  }
}

function assertKeyLength(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== MASTER_KEY_BYTES) {
    throw new SecretCryptoError(
      'MALFORMED_KEY',
      `Key must be a ${MASTER_KEY_BYTES}-byte buffer`,
    );
  }
}

/**
 * 解析主密钥：接受 32 字节的 **hex**（64 字符）或 **base64**。
 *
 * 先判 hex 再判 base64 —— 因为 64 个十六进制字符本身也是合法的 base64，
 * 顺序反了会解出 48 字节而误判。
 *
 * 失败时抛错，错误信息**不含密钥内容**。
 */
export function parseMasterKey(raw: string): Buffer {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    throw new SecretCryptoError('MALFORMED_KEY', 'Encryption key is empty');
  }

  let key: Buffer | null = null;
  if (HEX_KEY_PATTERN.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === MASTER_KEY_BYTES) key = decoded;
  }

  if (!key || key.length !== MASTER_KEY_BYTES) {
    throw new SecretCryptoError(
      'MALFORMED_KEY',
      `Encryption key must decode to exactly ${MASTER_KEY_BYTES} bytes ` +
        '(provide 64 hex characters, or base64 encoding of 32 bytes)',
    );
  }
  return key;
}

/**
 * 加密。每次调用使用**独立随机 IV**，因此同一明文两次加密的结果不同。
 *
 * 空字符串是合法明文（会产出只有认证标签、没有密文正文的信封）。
 */
export function encryptSecret(key: Buffer, plaintext: string): string {
  assertKeyLength(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * 解密。
 *
 * 以下情况一律抛 `SecretCryptoError`，且错误信息不含密钥或明文：
 * - 信封格式不对（段数不对、IV/标签长度不对）→ `MALFORMED_ENVELOPE`
 * - 版本前缀不认识 → `UNSUPPORTED_VERSION`
 * - 密钥不匹配或密文/标签被篡改（GCM 认证失败）→ `DECRYPT_FAILED`
 */
export function decryptSecret(key: Buffer, envelope: string): string {
  assertKeyLength(key);

  const parts = (envelope ?? '').split(':');
  if (parts.length !== 4) {
    throw new SecretCryptoError('MALFORMED_ENVELOPE', 'Encrypted value has an unexpected format');
  }

  const [version, ivB64, tagB64, ciphertextB64] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new SecretCryptoError('UNSUPPORTED_VERSION', `Unsupported envelope version: ${version}`);
  }

  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretCryptoError('MALFORMED_ENVELOPE', 'Encrypted value has an unexpected format');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // 不向上抛底层错误：它的信息可能包含密文片段。统一为固定文案。
    throw new SecretCryptoError(
      'DECRYPT_FAILED',
      'Failed to decrypt secret: wrong key or corrupted ciphertext',
    );
  }
}

/**
 * 判断一个值是否**看起来**是加密信封。
 *
 * 只做结构判断，不验证能否解密。用途是区分「明文历史数据」与「已加密数据」，
 * 例如启动门禁与存量数据迁移。
 */
export function looksEncrypted(value: string | null | undefined): boolean {
  if (!value) return false;
  const parts = value.split(':');
  return parts.length === 4 && parts[0] === ENVELOPE_VERSION;
}

/** 给定一组值，判断其中是否存在已加密数据（启动门禁用）。 */
export function hasAnyEncryptedValue(values: Iterable<string | null | undefined>): boolean {
  for (const value of values) {
    if (looksEncrypted(value)) return true;
  }
  return false;
}
