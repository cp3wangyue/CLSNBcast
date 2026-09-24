/**
 * Discord 共享链路的**集成测试**：不 mock SessionService。
 *
 * 之前 discord-share.service.spec.ts 的成功路径用的是 mock 的 sessionService，
 * 只能证明「我们调用了它」，证明不了「会话真的被建出来、链接真的能生成」。
 * 本文件用真实的 DatabaseService + AgoraProviderService + SessionService，
 * 完整走通 /share → Provider 解析 → 会话落库 → 分享链接。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { DatabaseService } from '../database/database.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { AgoraProviderService } from '../agora/agora-provider.service';
import { AgoraService } from '../agora/agora.service';
import { SessionService } from '../session/session.service';
import { UsageLedgerService } from '../usage/usage-ledger.service';
import { QualityConfigService } from '../quality/quality-config.service';
import { QualityPresetService } from '../quality/quality-preset.service';
import { DiscordShareService } from './discord-share.service';
import { DiscordNotifierService } from './discord-notifier.service';
import { EventBusService } from '../events/events.service';
import { DISCORD_INTERACTION, DiscordInteraction } from './discord.types';
import { DiscordMessagePayload } from './discord-message-builder';

process.env.SUPER_ADMIN_PASSWORD = 'test-password';
// 健康检查要能解密证书，因此必须提供主密钥
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY || 'a'.repeat(64);

let dir = '';

function makeDb(): DatabaseService {
  dir = mkdtempSync(join(tmpdir(), 'discord-integration-'));
  process.env.DATA_DIR = dir;
  return new DatabaseService();
}

function rawExec(sql: string, ...params: any[]) {
  const d = new Database(join(dir, 'clsnbcast.db'));
  d.prepare(sql).run(...params);
  d.close();
}

/** 32 字符证书：声网的长度要求，也是健康检查能通过的前提 */
const APP_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const APP_CERT = '098f6bcd4621d373cade4e832627b4f6';

function interaction(guildId: string, channelId = 'c1'): DiscordInteraction {
  return {
    id: 'i1',
    type: DISCORD_INTERACTION.APPLICATION_COMMAND,
    application_id: 'app1',
    guild_id: guildId,
    channel_id: channelId,
    token: 'tok',
    member: { user: { id: 'u1', username: 'tester' } },
    data: { name: 'share' },
  };
}

describe('Discord 共享链路（集成，真实 Provider/Session）', () => {
  let db: DatabaseService;
  let crypto: SecretCryptoService;
  let providers: AgoraProviderService;
  let sessions: SessionService;
  let share: DiscordShareService;
  let agora: AgoraService;
  let bus: EventBusService;

  beforeEach(() => {
    db = makeDb();
    crypto = new SecretCryptoService(db);
    providers = new AgoraProviderService(db, crypto);
    providers.onModuleInit();

    // 按真实依赖装配，不 mock —— 这样成功路径才是真的被验证
    const qualityConfig = new QualityConfigService(db);
    qualityConfig.onModuleInit();
    const qualityPresets = new QualityPresetService(db, qualityConfig);
    qualityPresets.onModuleInit();
    const ledger = new UsageLedgerService(db, qualityConfig);
    agora = new AgoraService(db, providers);
    bus = new EventBusService();
    sessions = new SessionService(db, agora, providers, bus, ledger, qualityConfig, qualityPresets);
    share = new DiscordShareService(db, sessions);

    // 平台池 Provider（走正常创建路径，证书会被加密存储）
    providers.create({
      name: '集成测试 Provider',
      appId: APP_ID,
      appCertificate: APP_CERT,
      ownerType: 'platform',
      ownerId: '',
    });
  });

  it('建出的 Provider 能通过健康检查（证书已加密且可签 Token）', () => {
    const list = providers.listForAdmin();
    expect(list.length).toBe(1);
    const outcome = providers.checkHealth(list[0].id);
    expect(outcome.status).toBe('healthy');
  });

  it('证书在库中是密文，不是明文', () => {
    const raw = new Database(join(dir, 'clsnbcast.db'), { readonly: true });
    const row = raw.prepare('SELECT app_certificate_enc FROM agora_providers').get() as any;
    raw.close();
    expect(row.app_certificate_enc).toContain('v1:');
    expect(row.app_certificate_enc).not.toContain(APP_CERT);
  });

  it('/share 在已绑定服务器 + 健康 Provider 下返回真实分享链接', () => {
    const gid = 'g-integration';
    db.createServer(gid, '集成测试服务器', 'o', 'owner', '', 'discord');
    rawExec('UPDATE servers SET bound = 1, public_domain = ? WHERE server_id = ?', 'https://example.com', gid);

    const r = share.handleShareRequest(interaction(gid));
    expect(r.status).toBe('ok');
    expect(r.shareUrl).toMatch(/^https:\/\/example\.com\/share\?t=[0-9a-f]{64}$/);
  });

  it('返回的链接里的 token 能查到对应会话（不是凭空生成的字符串）', () => {
    const gid = 'g-integration-2';
    db.createServer(gid, 'T', 'o', 'owner', '', 'discord');
    rawExec('UPDATE servers SET bound = 1, public_domain = ? WHERE server_id = ?', 'https://example.com', gid);

    const r = share.handleShareRequest(interaction(gid));
    const token = new URL(r.shareUrl!).searchParams.get('t')!;

    const row = new Database(join(dir, 'clsnbcast.db'), { readonly: true })
      .prepare('SELECT id, guild_id, status, provider_id, agora_app_id FROM sessions WHERE token = ?')
      .get(token) as any;
    expect(row).toBeTruthy();
    expect(row.guild_id).toBe(gid);
    expect(row.status).toBe('pending');
    expect(row.provider_id).toBeTruthy();
    expect(row.agora_app_id).toBe(APP_ID);
  });

  it('会话绑定了正确的 Provider 与 App ID 快照', () => {
    const gid = 'g-integration-3';
    db.createServer(gid, 'T', 'o', 'owner', '', 'discord');
    rawExec('UPDATE servers SET bound = 1, public_domain = ? WHERE server_id = ?', 'https://example.com', gid);

    const r = share.handleShareRequest(interaction(gid));
    const token = new URL(r.shareUrl!).searchParams.get('t')!;
    const session = sessions.getByToken(token);
    expect(session).toBeTruthy();
    expect(session!.agoraAppId).toBe(APP_ID);
  });

  it('能用该会话签发发布端与观众端 Token（证明凭证真的可用）', () => {
    const gid = 'g-integration-4';
    db.createServer(gid, 'T', 'o', 'owner', '', 'discord');
    rawExec('UPDATE servers SET bound = 1, public_domain = ? WHERE server_id = ?', 'https://example.com', gid);

    const r = share.handleShareRequest(interaction(gid));
    const session = sessions.getByToken(new URL(r.shareUrl!).searchParams.get('t')!)!;

    const pub = agora.generateToken(session, 1, 'publisher');
    const viewer = agora.generateToken(session, 2, 'subscriber');
    expect(pub.token).toBeTruthy();
    expect(viewer.token).toBeTruthy();
    expect(pub.appId).toBe(APP_ID);
    expect(pub.token).not.toBe(viewer.token);
  });

  it('公开观看卡片：会话转 active 后广播，链接用 view 路径', async () => {
    const gid = 'g-integration-5';
    db.createServer(gid, 'T', 'o', 'owner', '', 'discord');
    rawExec('UPDATE servers SET bound = 1, public_domain = ? WHERE server_id = ?', 'https://example.com', gid);

    const r = share.handleShareRequest(interaction(gid));
    const token = new URL(r.shareUrl!).searchParams.get('t')!;

    const notifier = new DiscordNotifierService(bus, sessions, db);
    const sent: DiscordMessagePayload[] = [];
    notifier.setSender({
      sendToChannel: async (_c, p) => { sent.push(p); return 'msg-1'; },
      editMessage: async () => {},
    });

    // 发布端真正开始 -> 状态转 active
    sessions.getByToken(token);
    const session = sessions.getByToken(token)!;
    rawExec("UPDATE sessions SET status = 'active', started_at = ? WHERE id = ?", Date.now(), session.id);

    bus.emitSessionStarted({
      sessionId: session.id,
      token,
      sharerUsername: 'tester',
      targetChannelId: 'c1',
      guildId: gid,
    });
    await new Promise((res) => setTimeout(res, 30));

    expect(sent.length).toBe(1);
    expect(sent[0].content).toContain(`https://example.com/view?t=${token}`);
  });
});
