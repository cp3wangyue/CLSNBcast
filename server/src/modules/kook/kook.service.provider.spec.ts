import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { AgoraProviderService } from '../agora/agora-provider.service';
import { AgoraService } from '../agora/agora.service';
import { EventBusService } from '../events/events.service';
import { SessionService } from '../session/session.service';
import { UsageLedgerService } from '../usage/usage-ledger.service';
import { KookService } from './kook.service';
import { KookMessageEvent } from './kook-event.types';

const SERVER_ID = 'guild-kook';
const APP_ID = '0123456789abcdef0123456789abcdef';
const CERT = 'fedcba9876543210fedcba9876543210';

function message(content: string, overrides: Partial<KookMessageEvent> = {}): KookMessageEvent {
  return {
    id: 'msg-1',
    msg_id: 'msg-1',
    type: 1,
    content,
    target_id: 'chan-1',
    guild_id: SERVER_ID,
    author_id: 'user-1',
    extra: {
      type: 1,
      guild_id: SERVER_ID,
      author: { id: 'user-1', username: '测试用户', bot: false },
    },
    ...overrides,
  };
}

/**
 * 触发词 → 会话创建这条链路，在 Phase 1-3 之后会因「选不出 Provider」而失败。
 * 本文件锁定 KOOK 侧的处理：必须给用户明确提示，且**不得创建注定不可用的会话**。
 *
 * 注意：这里直接调 `handleIncomingMessage`，绕过 webhook worker —— worker 在
 * `KookService.isReady`（即已配置 KOOK Bot Token）之前不会处理任何事件，
 * 因此没有真实 Bot Token 时无法从 HTTP 层驱动这条链路。
 */
describe('KookService × Agora Provider', () => {
  let dir: string;
  let db: DatabaseService;
  let providers: AgoraProviderService;
  let sessions: SessionService;
  let kook: KookService;

  function seedServer(overrides: Record<string, unknown> = {}) {
    db.createServer(SERVER_ID, 'KOOK 测试服务器', 'owner-1', '服主');
    db.updateServer(SERVER_ID, {
      bound: 1,
      status: 'active',
      triggerWords: '屏幕共享,共享屏幕',
      ...overrides,
    });
  }

  function sessionCount(): number {
    return db.getAllSessions().length;
  }

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    dir = mkdtempSync(join(tmpdir(), 'clsnbcast-kook-'));
    process.env.DATA_DIR = dir;
    process.env.SECRET_ENCRYPTION_KEY = 'a'.repeat(64);

    db = new DatabaseService();
    providers = new AgoraProviderService(db, new SecretCryptoService());
    const agora = new AgoraService(db, providers);
    const bus = new EventBusService();
    const ledger = new UsageLedgerService(db);
    sessions = new SessionService(db, agora, providers, bus, ledger);
    kook = new KookService(sessions, db, bus);
    // Registers bus listeners; without a KOOK bot token `this.bot` stays null.
    await kook.onModuleInit();
  });

  afterEach(() => {
    db.onModuleDestroy();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.SECRET_ENCRYPTION_KEY;
  });

  it('没有可用 Provider 时：不创建会话，也不抛错', async () => {
    seedServer();
    expect(sessionCount()).toBe(0);

    await expect(kook.handleIncomingMessage(message('屏幕共享'))).resolves.toBeUndefined();

    expect(sessionCount()).toBe(0);
  });

  it('没有可用 Provider 时记 warn 日志，便于排查', async () => {
    seedServer();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');

    await kook.handleIncomingMessage(message('屏幕共享'));

    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('NO_PROVIDER');
  });

  it('服务器未绑定/未激活时同样不创建会话', async () => {
    seedServer({ bound: 0 });
    providers.create({
      ownerType: 'space', ownerId: SERVER_ID, name: 'p', appId: APP_ID, appCertificate: CERT,
    });

    await kook.handleIncomingMessage(message('屏幕共享'));

    expect(sessionCount()).toBe(0);
  });

  it('有可用 Provider 时创建会话，并绑定该 Provider 与 App ID 快照', async () => {
    seedServer();
    const provider = providers.create({
      ownerType: 'space', ownerId: SERVER_ID, name: '服务器自带凭证',
      appId: APP_ID, appCertificate: CERT,
    });

    await kook.handleIncomingMessage(message('屏幕共享'));

    const all = db.getAllSessions();
    expect(all).toHaveLength(1);
    expect(all[0].providerId).toBe(provider.id);
    expect(all[0].agoraAppId).toBe(APP_ID);
    expect(all[0].status).toBe('pending');
    expect(all[0].sharerUserId).toBe('user-1');
    expect(all[0].channel.startsWith('cb_')).toBe(true);
  });

  it('创建出的会话可以直接签发 Token（发布端与观众端同 App ID）', async () => {
    seedServer();
    providers.create({
      ownerType: 'space', ownerId: SERVER_ID, name: 'p', appId: APP_ID, appCertificate: CERT,
    });
    const agora = new AgoraService(db, providers);

    await kook.handleIncomingMessage(message('屏幕共享'));
    const session = db.getAllSessions()[0];

    const pub = agora.generateToken(session, 1, 'publisher');
    const sub = agora.generateToken(session, 555, 'subscriber');
    expect(pub.appId).toBe(APP_ID);
    expect(sub.appId).toBe(APP_ID);
    expect(sub.channel).toBe(pub.channel);
    expect(pub.token).not.toBe(sub.token);
  });

  it('内容不含触发词时不创建会话', async () => {
    seedServer();
    providers.create({
      ownerType: 'space', ownerId: SERVER_ID, name: 'p', appId: APP_ID, appCertificate: CERT,
    });

    await kook.handleIncomingMessage(message('今天天气不错'));

    expect(sessionCount()).toBe(0);
  });

  it('/cbhelp 与旧别名 /xchelp 都能触发帮助流程且不抛错', async () => {
    seedServer();

    await expect(kook.handleIncomingMessage(message('/cbhelp'))).resolves.toBeUndefined();
    await expect(
      kook.handleIncomingMessage(message('/xchelp', { id: 'msg-2', msg_id: 'msg-2' })),
    ).resolves.toBeUndefined();

    expect(sessionCount()).toBe(0);
  });

  it('同一用户+频道 10 秒内重复触发只创建一个会话（冷却生效）', async () => {
    seedServer();
    providers.create({
      ownerType: 'space', ownerId: SERVER_ID, name: 'p', appId: APP_ID, appCertificate: CERT,
    });

    await kook.handleIncomingMessage(message('屏幕共享', { id: 'm1', msg_id: 'm1' }));
    await kook.handleIncomingMessage(message('屏幕共享', { id: 'm2', msg_id: 'm2' }));

    expect(sessionCount()).toBe(1);
  });

  it('不同用户各自触发会各自创建会话（冷却按用户+频道隔离）', async () => {
    seedServer();
    providers.create({
      ownerType: 'space', ownerId: SERVER_ID, name: 'p', appId: APP_ID, appCertificate: CERT,
    });

    await kook.handleIncomingMessage(message('屏幕共享', { id: 'm1', msg_id: 'm1', author_id: 'user-a' }));
    await kook.handleIncomingMessage(
      message('屏幕共享', {
        id: 'm2', msg_id: 'm2', author_id: 'user-b', target_id: 'chan-b',
        extra: { type: 1, guild_id: SERVER_ID, author: { id: 'user-b', username: 'B', bot: false } },
      }),
    );

    expect(sessionCount()).toBe(2);
  });
});
