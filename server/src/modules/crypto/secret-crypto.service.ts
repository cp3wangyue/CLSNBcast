import { Injectable, Logger } from '@nestjs/common';
import {
  SecretCryptoError,
  decryptSecret,
  encryptSecret,
  hasAnyEncryptedValue,
  looksEncrypted,
  parseMasterKey,
} from './secret-crypto';
import { DatabaseService } from '../database/database.service';

/** 主密钥所在的环境变量名。 */
export const SECRET_ENCRYPTION_KEY_ENV = 'SECRET_ENCRYPTION_KEY';

/**
 * 秘密的服务端加密存储。
 *
 * 目前**没有消费者**（Agora Provider 在 Phase 1 接入）。提前落地是为了：
 * 1. 主密钥格式在启动阶段就校验，而不是等到第一次加密才炸；
 * 2. 后续所有敏感列（App Certificate、Customer Secret）都有唯一入口，
 *    避免各处自己写 crypto 而出现实现漂移。
 *
 * 使用约定：
 * - 只加密**必须回读**的秘密。App ID、Customer ID 不是秘密，明文存储便于查询。
 * - 明文只在**签发 Token 的那一刻**出现在内存里，不写日志、不进 API 响应。
 */
/** `global_config` 中需要加密存储的秘密键（Phase 5）。 */
const GLOBAL_SECRET_KEYS = [
  'kookBotToken',
  'kookVerifyToken',
  'kookEncryptKey',
  // Discord Bot Token 与 KOOK Bot Token 同级：泄露即可冒充机器人，
  // 因此同样加密存储（Discord 的 Public Key 不是秘密，走明文 global_config）
  'discordBotToken',
] as const;

export type GlobalSecretKey = (typeof GLOBAL_SECRET_KEYS)[number];

@Injectable()
export class SecretCryptoService {
  private readonly logger = new Logger(SecretCryptoService.name);
  private readonly key: Buffer | null;

  constructor(private readonly db: DatabaseService) {
    const raw = process.env[SECRET_ENCRYPTION_KEY_ENV];
    if (!raw) {
      this.key = null;
      this.logger.warn(
        `${SECRET_ENCRYPTION_KEY_ENV} is not set: secret encryption is unavailable. ` +
          'Set it before configuring any Agora provider.',
      );
      return;
    }

    // 密钥格式非法时直接抛错，让进程在启动阶段失败。
    // 否则会带着一把「解不开存量数据」的密钥继续运行，问题被推迟到运行时才暴露。
    this.key = parseMasterKey(raw);
    this.logger.log('Secret encryption enabled');
  }

  /**
   * 启动时的存量秘密迁移。
   *
   * 只处理「已经用明文跑着」的存量部署：有密钥就加密，没密钥就跳过并告警。
   * 不抛错 —— 否则老部署升级到这个版本会直接起不来。
   */
  migrateLegacySecrets(): void {
    this.encryptLegacyGlobalSecrets();
  }

  get isConfigured(): boolean {
    return this.key !== null;
  }

  /** 加密。未配置密钥时抛错 —— 绝不静默退化为明文存储。 */
  encrypt(plaintext: string): string {
    return encryptSecret(this.requireKey(), plaintext);
  }

  /** 解密。未配置密钥或解密失败时抛错，错误信息不含密钥与明文。 */
  decrypt(envelope: string): string {
    return decryptSecret(this.requireKey(), envelope);
  }

  /** 启动门禁：库里已有密文、但主密钥缺失或不可用时，让进程直接失败退出。 */
  assertUsableForExistingSecrets(values: Iterable<string | null | undefined>): void {
    if (this.key) return;
    if (!hasAnyEncryptedValue(values)) return;

    const message =
      `FATAL: encrypted data exists in the database but ${SECRET_ENCRYPTION_KEY_ENV} ` +
      'is not set or is unusable. Provide the correct key and restart.';
    this.logger.error(message);
    throw new Error(message);
  }

  // ===== global_config 秘密的透明加解密（Phase 5）=====
  //
  // 明文只在调用方使用它的那一刻出现在内存里；库中一律是密文。
  // 与 Agora Provider 的做法保持一致：数据层只存密文，加解密集中在这里。

  /** 读取并解密一个全局秘密。值为空时返回空串（不报错）。 */
  getGlobalSecret(name: GlobalSecretKey): string {
    const raw = this.db.getGlobalConfigValue(name);
    if (!raw) return '';
    if (!looksEncrypted(raw)) {
      // 旧库遗留的明文：有密钥就地升级，没密钥就按原样返回（避免启动即失败）
      if (this.isConfigured) {
        const encrypted = this.encrypt(raw);
        this.db.setGlobalConfig(name, encrypted);
        this.logger.log(`Encrypted legacy plaintext value of ${name} in global_config`);
      }
      return raw;
    }
    return this.decrypt(raw);
  }

  /**
   * 解密每服务器的 HMAC 签名密钥。
   *
   * 与全局秘密一样支持存量明文：不是信封就按原样返回（没有密钥时也不会起不来）。
   * 明文只在调用方计算 HMAC 的那一刻存在。
   */
  decryptServerSecret(raw: string): string {
    if (!raw) return '';
    if (!looksEncrypted(raw)) return raw;
    return this.decrypt(raw);
  }

  /** 写入一个全局秘密（加密后落库）。 */
  setGlobalSecret(name: GlobalSecretKey, plaintext: string): void {
    const value = plaintext?.trim() ?? '';
    this.db.setGlobalConfig(name, value === '' ? '' : this.encrypt(value));
  }

  /**
   * 启动时把 `global_config` 里残留的明文秘密加密。
   *
   * 没有主密钥时**跳过并告警**而不是失败 —— 否则存量部署升级后会直接起不来。
   */
  encryptLegacyGlobalSecrets(): number {
    if (!this.isConfigured) {
      this.logger.warn(
        `${SECRET_ENCRYPTION_KEY_ENV} is not set: global secrets stay in plaintext. ` +
          'Set it and restart to encrypt them.',
      );
      return 0;
    }

    let migrated = 0;
    for (const name of GLOBAL_SECRET_KEYS) {
      const raw = this.db.getGlobalConfigValue(name);
      if (!raw || looksEncrypted(raw)) continue;
      this.db.setGlobalConfig(name, this.encrypt(raw));
      migrated += 1;
      this.logger.log(`Encrypted ${name} in global_config`);
    }
    if (migrated > 0) {
      this.logger.log(`Encrypted ${migrated} global secret(s) in global_config`);
    }
    return migrated;
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new SecretCryptoError(
        'NOT_CONFIGURED',
        `${SECRET_ENCRYPTION_KEY_ENV} is not configured; refusing to read or write secrets`,
      );
    }
    return this.key;
  }
}
