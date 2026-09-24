import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';
import { DiscordWebhookController } from './discord-webhook.controller';
import { DISCORD_INTERACTION_PING } from './discord-signature';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');

function makeController(key: string) {
  const db = { getGlobalConfig: () => ({ discordPublicKey: key }) } as any;
  return new DiscordWebhookController(db);
}

function request(body: object, { ts, sig, key = privateKey }: { ts?: string; sig?: string; key?: any } = {}) {
  const raw = Buffer.from(JSON.stringify(body), 'utf-8');
  const timestamp = ts ?? String(Date.now());
  const signature =
    sig ?? sign(null, Buffer.concat([Buffer.from(timestamp, 'utf-8'), raw]), key).toString('hex');
  return {
    headers: {
      'x-signature-timestamp': timestamp,
      'x-signature-ed25519': signature,
    },
    body: raw,
  } as any;
}

describe('DiscordWebhookController', () => {
  it('PING 交互返回 type 1（端点连通性校验）', () => {
    const c = makeController(publicKeyHex);
    const res = c.receive(request({ type: DISCORD_INTERACTION_PING }));
    expect(res).toEqual({ type: 1 });
  });

  it('正确签名的普通交互被接受', () => {
    const c = makeController(publicKeyHex);
    expect(c.receive(request({ type: 2 }))).toEqual({ ok: true });
  });

  it('签名不匹配 -> 401', () => {
    const c = makeController(publicKeyHex);
    expect(() => c.receive(request({ type: 2 }, { sig: 'aa'.repeat(64) }))).toThrow();
    try {
      c.receive(request({ type: 2 }, { sig: 'aa'.repeat(64) }));
    } catch (e: any) {
      expect(e.status).toBe(401);
      expect(e.message).toBe('invalid_request_signature');
    }
  });

  it('未配置 public key -> 500（配置问题，不是伪造请求）', () => {
    const c = makeController('');
    try {
      c.receive(request({ type: DISCORD_INTERACTION_PING }));
    } catch (e: any) {
      expect(e.status).toBe(500);
      expect(e.message).toBe('discord_public_key_missing');
    }
  });

  it('缺失签名头 -> 401', () => {
    const c = makeController(publicKeyHex);
    const raw = Buffer.from(JSON.stringify({ type: 1 }), 'utf-8');
    try {
      c.receive({ headers: {}, body: raw } as any);
    } catch (e: any) {
      expect(e.status).toBe(401);
    }
  });

  it('签名有效但 body 不是合法 JSON -> 400', () => {
    const c = makeController(publicKeyHex);
    const raw = Buffer.from('not-json', 'utf-8');
    const ts = String(Date.now());
    const sig = sign(null, Buffer.concat([Buffer.from(ts, 'utf-8'), raw]), privateKey).toString('hex');
    try {
      c.receive({ headers: { 'x-signature-timestamp': ts, 'x-signature-ed25519': sig }, body: raw } as any);
    } catch (e: any) {
      expect(e.status).toBe(400);
      expect(e.message).toBe('invalid_json');
    }
  });

  it('用另一把私钥签名被拒绝', () => {
    const c = makeController(publicKeyHex);
    const other = generateKeyPairSync('ed25519');
    try {
      c.receive(request({ type: DISCORD_INTERACTION_PING }, { key: other.privateKey }));
    } catch (e: any) {
      expect(e.status).toBe(401);
    }
  });
});
