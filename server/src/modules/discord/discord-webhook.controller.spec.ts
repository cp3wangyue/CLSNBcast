import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';
import { DiscordWebhookController } from './discord-webhook.controller';
import { DiscordShareService } from './discord-share.service';
import { DISCORD_INTERACTION_PING } from './discord-signature';
import {
  DISCORD_INTERACTION,
  DISCORD_MESSAGE_FLAG,
  DISCORD_RESPONSE,
} from './discord.types';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');

function makeController(key: string, shareResult: any) {
  const db = { getGlobalConfig: () => ({ discordPublicKey: key }) } as any;
  const share = { handleShareRequest: () => shareResult } as unknown as DiscordShareService;
  return new DiscordWebhookController(db, share);
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

const shareInteraction = (guildId = 'g1', channelId = 'c1') => ({
  id: 'i1',
  type: DISCORD_INTERACTION.APPLICATION_COMMAND,
  application_id: 'app1',
  guild_id: guildId,
  channel_id: channelId,
  token: 'interaction-token',
  member: { user: { id: 'u1', username: 'tester' } },
  data: { name: 'share' },
});

describe('DiscordWebhookController', () => {
  it('PING 交互返回 type 1（端点连通性校验）', () => {
    const c = makeController(publicKeyHex, { status: 'ok' });
    expect(c.receive(request({ type: DISCORD_INTERACTION_PING }))).toEqual({ type: 1 });
  });

  it('正确签名的普通交互被接受', () => {
    const c = makeController(publicKeyHex, { status: 'ok' });
    const r: any = c.receive(request({ type: 2, data: { name: 'other' } }));
    expect(r.type).toBe(DISCORD_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE);
  });

  describe('/share 命令', () => {
    it('成功时返回仅发起人可见的分享链接', () => {
      const c = makeController(publicKeyHex, {
        status: 'ok',
        shareUrl: 'https://example.com/share?t=abc',
      });
      const r: any = c.receive(request(shareInteraction()));
      expect(r.type).toBe(DISCORD_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE);
      expect(r.data.flags).toBe(DISCORD_MESSAGE_FLAG.EPHEMERAL);
      expect(r.data.content).toContain('https://example.com/share?t=abc');
    });

    it('分享链接必须是 ephemeral —— 否则会把会话 token 泄露到公开频道', () => {
      const c = makeController(publicKeyHex, {
        status: 'ok',
        shareUrl: 'https://example.com/share?t=SECRET',
      });
      const r: any = c.receive(request(shareInteraction()));
      expect(r.data.flags & DISCORD_MESSAGE_FLAG.EPHEMERAL).toBeTruthy();
    });

    it('无可用 Provider 时给出面向用户的说明，且不泄露内部原因', () => {
      const c = makeController(publicKeyHex, {
        status: 'provider_unavailable',
        message: '暂时没有可用的音视频服务，请联系管理员在管理面板配置 Agora 凭证。',
      });
      const r: any = c.receive(request(shareInteraction()));
      expect(r.data.content).toContain('暂时没有可用的音视频服务');
      expect(r.data.content).not.toContain('QUOTA');
    });

    it('未绑定服务器时提示绑定', () => {
      const c = makeController(publicKeyHex, {
        status: 'no_server',
        message: '该服务器尚未绑定或已停用，请先由服务器管理员完成绑定。',
      });
      const r: any = c.receive(request(shareInteraction()));
      expect(r.data.content).toContain('尚未绑定');
    });

    it('未知命令给出可用命令提示', () => {
      const c = makeController(publicKeyHex, { status: 'ok' });
      const body = { ...shareInteraction(), data: { name: 'unknown' } };
      const r: any = c.receive(request(body));
      expect(r.data.content).toContain('/share');
    });
  });

  describe('签名校验', () => {
    it('签名不匹配 -> 401', () => {
      const c = makeController(publicKeyHex, { status: 'ok' });
      try {
        c.receive(request(shareInteraction(), { sig: 'aa'.repeat(64) }));
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(e.status).toBe(401);
        expect(e.message).toBe('invalid_request_signature');
      }
    });

    it('未配置 public key -> 500（配置问题，不是伪造请求）', () => {
      const c = makeController('', { status: 'ok' });
      try {
        c.receive(request({ type: DISCORD_INTERACTION_PING }));
      } catch (e: any) {
        expect(e.status).toBe(500);
        expect(e.message).toBe('discord_public_key_missing');
      }
    });

    it('缺失签名头 -> 401', () => {
      const c = makeController(publicKeyHex, { status: 'ok' });
      try {
        c.receive({ headers: {}, body: Buffer.from('{"type":1}') } as any);
      } catch (e: any) {
        expect(e.status).toBe(401);
      }
    });

    it('签名有效但 body 不是合法 JSON -> 400', () => {
      const c = makeController(publicKeyHex, { status: 'ok' });
      const raw = Buffer.from('not-json', 'utf-8');
      const ts = String(Date.now());
      const sig = sign(null, Buffer.concat([Buffer.from(ts, 'utf-8'), raw]), privateKey).toString('hex');
      try {
        c.receive({
          headers: { 'x-signature-timestamp': ts, 'x-signature-ed25519': sig },
          body: raw,
        } as any);
      } catch (e: any) {
        expect(e.status).toBe(400);
        expect(e.message).toBe('invalid_json');
      }
    });

    it('用另一把私钥签名被拒绝', () => {
      const c = makeController(publicKeyHex, { status: 'ok' });
      const other = generateKeyPairSync('ed25519');
      try {
        c.receive(request(shareInteraction(), { key: other.privateKey }));
      } catch (e: any) {
        expect(e.status).toBe(401);
      }
    });
  });

  it('未处理的交互类型仍需 ACK，避免 Discord 判定超时', () => {
    const c = makeController(publicKeyHex, { status: 'ok' });
    const r: any = c.receive(request({ type: DISCORD_INTERACTION.MESSAGE_COMPONENT }));
    expect(r.type).toBe(DISCORD_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE);
  });
});
