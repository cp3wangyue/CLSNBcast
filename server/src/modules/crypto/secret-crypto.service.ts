import { Injectable, Logger } from '@nestjs/common';
import {
  SecretCryptoError,
  decryptSecret,
  encryptSecret,
  hasAnyEncryptedValue,
  parseMasterKey,
} from './secret-crypto';

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
@Injectable()
export class SecretCryptoService {
  private readonly logger = new Logger(SecretCryptoService.name);
  private readonly key: Buffer | null;

  constructor() {
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

  /**
   * 启动门禁：**库里已有密文、但密钥缺失**时必须让进程失败退出。
   *
   * 调用方（Phase 1 的 Provider 仓储）把待检查的密文列值传进来。这样这个服务
   * 不需要知道任何表结构，同时门禁仍然有效。
   *
   * 反过来「有密钥但库里没有密文」是正常状态，不需要拦截。
   */
  assertUsableForExistingSecrets(values: Iterable<string | null | undefined>): void {
    if (this.key) return;
    if (!hasAnyEncryptedValue(values)) return;

    const message =
      `FATAL: encrypted data exists in the database but ${SECRET_ENCRYPTION_KEY_ENV} ` +
      'is not set or is unusable. Provide the correct key and restart.';
    this.logger.error(message);
    throw new Error(message);
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
