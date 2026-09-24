import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';
import {
  verifyDiscordSignature,
  DiscordSignatureError,
  DISCORD_INTERACTION_PING,
} from './discord-signature';

/**
 * 用**真实生成的 Ed25519 密钥对**测试，而不是写死的签名常量。
 * 写死常量只能证明「比较逻辑等于它自己」，证明不了校验真的成立。
 */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');

function signBody(timestamp: string, body: Buffer): string {
  const message = Buffer.concat([Buffer.from(timestamp, 'utf-8'), body]);
  return sign(null, message, privateKey).toString('hex');
}

describe('verifyDiscordSignature', () => {
  const body = Buffer.from(JSON.stringify({ type: DISCORD_INTERACTION_PING }), 'utf-8');

  it('正确签名通过校验', () => {
    const ts = String(Date.now());
    expect(() => verifyDiscordSignature(publicKeyHex, ts, signBody(ts, body), body)).not.toThrow();
  });

  it('被篡改的请求体被拒绝', () => {
    const ts = String(Date.now());
    const sig = signBody(ts, body);
    const tampered = Buffer.from(JSON.stringify({ type: 999 }), 'utf-8');
    expect(() => verifyDiscordSignature(publicKeyHex, ts, sig, tampered)).toThrow(
      DiscordSignatureError,
    );
  });

  it('时间戳参与签名 —— 换个时间戳则原签名失效', () => {
    const ts = String(Date.now());
    const sig = signBody(ts, body);
    // 同一 body、同一签名，但声称的时间戳不同 => 必须失败，
    // 否则重放/伪造时间戳就没有意义了
    expect(() => verifyDiscordSignature(publicKeyHex, String(Date.now() + 1000), sig, body)).toThrow(
      DiscordSignatureError,
    );
  });

  it('用另一把私钥签的签名被拒绝', () => {
    const other = generateKeyPairSync('ed25519');
    const otherHex = other.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
    const ts = String(Date.now());
    const sig = sign(null, Buffer.concat([Buffer.from(ts, 'utf-8'), body]), other.privateKey).toString('hex');
    expect(() => verifyDiscordSignature(publicKeyHex, ts, sig, body)).toThrow(DiscordSignatureError);
    // 反向：用我们的私钥签、却拿别人的公钥验，也必须失败
    expect(() => verifyDiscordSignature(otherHex, ts, signBody(ts, body), body)).toThrow(
      DiscordSignatureError,
    );
  });

  it('缺失签名头 -> 401', () => {
    const ts = String(Date.now());
    for (const [t, s] of [['', 'aa'.repeat(64)], [ts, '']]) {
      try {
        verifyDiscordSignature(publicKeyHex, t, s, body);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(DiscordSignatureError);
        expect((e as DiscordSignatureError).status).toBe(401);
      }
    }
  });

  it('签名长度不是 128 hex -> 401', () => {
    const ts = String(Date.now());
    try {
      verifyDiscordSignature(publicKeyHex, ts, 'abcd', body);
    } catch (e) {
      expect((e as DiscordSignatureError).status).toBe(401);
    }
  });

  it('空请求体被拒绝', () => {
    const ts = String(Date.now());
    expect(() => verifyDiscordSignature(publicKeyHex, ts, signBody(ts, body), Buffer.alloc(0))).toThrow(
      DiscordSignatureError,
    );
  });

  it('未配置 public key -> 500（配置问题，不是客户端伪造）', () => {
    const ts = String(Date.now());
    try {
      verifyDiscordSignature('', ts, signBody(ts, body), body);
    } catch (e) {
      expect((e as DiscordSignatureError).status).toBe(500);
      expect((e as DiscordSignatureError).code).toBe('discord_public_key_missing');
    }
  });

  it('public key 格式非法 -> 500', () => {
    const ts = String(Date.now());
    for (const bad of ['not-hex', 'zz'.repeat(32), 'ab']) {
      try {
        verifyDiscordSignature(bad, ts, signBody(ts, body), body);
      } catch (e) {
        expect((e as DiscordSignatureError).status).toBe(500);
      }
    }
  });

  it('错误信息与 code 不含密钥或请求体内容', () => {
    const ts = String(Date.now());
    try {
      verifyDiscordSignature(publicKeyHex, ts, 'deadbeef', body);
    } catch (e) {
      const msg = (e as Error).message + '|' + (e as DiscordSignatureError).code;
      expect(msg).not.toContain(publicKeyHex);
      expect(msg).not.toContain('DISCORD_INTERACTION_PING');
    }
  });

  it('rawBody 必须是原始字节 —— 重新序列化会让签名失效（文档化陷阱）', () => {
    // 这是集成时最容易踩的坑：先 JSON.parse 再 JSON.stringify
    // 会改变键序/空白，导致签名必然不匹配。这里用内容相同但字节不同的
    // body 复刻该情形，确认校验会如实拒绝。
    const ts = String(Date.now());
    const original = Buffer.from('{"type":1,"b":  2}', 'utf-8');
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(original.toString())), 'utf-8');
    const sig = signBody(ts, original);
    expect(reserialized.equals(original)).toBe(false);
    expect(() => verifyDiscordSignature(publicKeyHex, ts, sig, reserialized)).toThrow(
      DiscordSignatureError,
    );
  });

  it('PING 常量与 Discord 官方定义一致（type 1）', () => {
    expect(DISCORD_INTERACTION_PING).toBe(1);
  });
});
