import { HttpStatus, Injectable } from '@nestjs/common';
import { createDecipheriv } from 'crypto';
import { safeEqual } from '../auth/safe-compare';
import { inflateRawSync, inflateSync } from 'zlib';
import { DatabaseService } from '../database/database.service';
import { KookWebhookEnvelope } from './kook-event.types';
import { SecretCryptoService } from '../crypto/secret-crypto.service';

export class KookWebhookProtocolError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'KookWebhookProtocolError';
  }
}

@Injectable()
export class KookWebhookCodec {
  private readonly maxBodyBytes = 1024 * 1024;

  constructor(
    private readonly db: DatabaseService,
    private readonly crypto: SecretCryptoService,
  ) {}

  decode(raw: Buffer): KookWebhookEnvelope {
    // 秘密在库中加密存储，只在这里解密后使用；明文不写日志、不进响应、不返回前端
    const expectedVerifyToken = this.crypto.getGlobalSecret('kookVerifyToken');
    const encryptKey = this.crypto.getGlobalSecret('kookEncryptKey');
    if (!expectedVerifyToken || !encryptKey) {
      throw new KookWebhookProtocolError(HttpStatus.SERVICE_UNAVAILABLE, 'webhook_not_configured');
    }
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      throw new KookWebhookProtocolError(HttpStatus.BAD_REQUEST, 'empty_body');
    }
    if (raw.length > this.maxBodyBytes) {
      throw new KookWebhookProtocolError(HttpStatus.PAYLOAD_TOO_LARGE, 'body_too_large');
    }

    const outer = this.parseJsonWithCompressionFallback(raw);
    const decoded = typeof outer?.encrypt === 'string'
      ? this.decryptEnvelope(outer.encrypt, encryptKey)
      : outer;
    if (!decoded || typeof decoded !== 'object' || decoded.s !== 0 || !this.isRecord(decoded.d)) {
      throw new KookWebhookProtocolError(HttpStatus.BAD_REQUEST, 'invalid_envelope');
    }

    const actualVerifyToken = decoded.d.verify_token;
    if (
      typeof actualVerifyToken !== 'string' ||
      !this.secureEqual(actualVerifyToken, expectedVerifyToken)
    ) {
      throw new KookWebhookProtocolError(HttpStatus.UNAUTHORIZED, 'invalid_verify_token');
    }

    const sanitizedData = { ...decoded.d };
    delete sanitizedData.verify_token;
    return {
      s: 0,
      ...(typeof decoded.sn === 'number' ? { sn: decoded.sn } : {}),
      d: sanitizedData,
    };
  }

  private parseJsonWithCompressionFallback(raw: Buffer): any {
    const direct = this.tryParseJson(raw);
    if (direct.ok) return direct.value;

    for (const inflate of [inflateSync, inflateRawSync]) {
      try {
        const inflated = inflate(raw, { maxOutputLength: this.maxBodyBytes });
        const parsed = this.tryParseJson(inflated);
        if (parsed.ok) return parsed.value;
      } catch {
        // Try the next supported deflate representation.
      }
    }
    throw new KookWebhookProtocolError(HttpStatus.BAD_REQUEST, 'invalid_json_or_compression');
  }

  private tryParseJson(raw: Buffer): { ok: true; value: any } | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(raw.toString('utf8')) };
    } catch {
      return { ok: false };
    }
  }

  private decryptEnvelope(encrypted: string, encryptKey: string): any {
    try {
      const keyBytes = Buffer.from(encryptKey, 'utf8');
      if (keyBytes.length === 0 || keyBytes.length > 32) throw new Error('invalid key length');
      const key = Buffer.alloc(32);
      keyBytes.copy(key);

      const firstLayer = Buffer.from(encrypted, 'base64');
      if (firstLayer.length <= 16) throw new Error('invalid encrypted data');
      const iv = firstLayer.subarray(0, 16);
      const secondLayer = firstLayer.subarray(16).toString('utf8');
      const cipherText = Buffer.from(secondLayer, 'base64');
      if (cipherText.length === 0 || cipherText.length % 16 !== 0) {
        throw new Error('invalid cipher length');
      }

      const decipher = createDecipheriv('aes-256-cbc', key, iv);
      const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
      if (plain.length > this.maxBodyBytes) throw new Error('decrypted body too large');
      return JSON.parse(plain.toString('utf8'));
    } catch {
      throw new KookWebhookProtocolError(HttpStatus.BAD_REQUEST, 'decrypt_failed');
    }
  }

  private secureEqual(actual: string, expected: string): boolean {
    return safeEqual(actual, expected);
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
}
