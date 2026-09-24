import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventBusService } from '../events/events.service';
import { DiscordNotifierService } from './discord-notifier.service';
import Database from 'better-sqlite3';
import { DatabaseService } from '../database/database.service';
import { DiscordMessagePayload } from './discord-message-builder';

process.env.SUPER_ADMIN_PASSWORD = 'test-password';

type Sent = { channelId: string; payload: DiscordMessagePayload };
type Edited = { channelId: string; messageId: string; payload: DiscordMessagePayload };

function makeSender() {
  const sent: Sent[] = [];
  const edited: Edited[] = [];
  return {
    sent,
    edited,
    sendToChannel: async (channelId: string, payload: DiscordMessagePayload) => {
      sent.push({ channelId, payload });
      return 'msg-1';
    },
    editMessage: async (channelId: string, messageId: string, payload: DiscordMessagePayload) => {
      edited.push({ channelId, messageId, payload });
    },
  };
}

function setup() {
  currentDir = mkdtempSync(join(tmpdir(), 'discord-notifier-'));
  process.env.DATA_DIR = currentDir;
  const db = new DatabaseService();
  const bus = new EventBusService();
  const sessions: any = {
    getById: (id: string) => sessionStore.get(id),
    setCardMessageId: (id: string, m: string) => {
      const s = sessionStore.get(id);
      if (s) s.cardMessageId = m;
    },
    toInfo: () => ({ standardMinutes: 12, estimatedCost: 0.084 }),
  };
  const sessionStore = new Map<string, any>();
  const svc = new DiscordNotifierService(bus, sessions, db);
  return { db, bus, svc, sessionStore, sessions };
}

let currentDir = '';

/** publicDomain / bound 不在 ALLOWED_SERVER_COLS 里，测试直接写库 */
function rawExec(sql: string, ...params: any[]) {
  const d = new Database(join(currentDir, 'clsnbcast.db'));
  d.prepare(sql).run(...params);
  d.close();
}

function makeServer(db: DatabaseService, guildId: string, platform: string) {
  db.createServer(guildId, 'T', 'o', 'on', '', platform);
  rawExec('UPDATE servers SET public_domain = ?, bound = 1 WHERE server_id = ?', 'https://example.com', guildId);
}

describe('DiscordNotifierService', () => {
  it('Discord 会话开始 -> 发送公开观看卡片', async () => {
    const { db, bus, svc, sessionStore } = setup();
    makeServer(db, 'g1', 'discord');
    sessionStore.set('s1', { id: 's1', status: 'active', token: 'T' });
    const sender = makeSender();
    svc.setSender(sender);

    bus.emitSessionStarted({
      sessionId: 's1', token: 'T', sharerUsername: 'alice',
      targetChannelId: 'c1', guildId: 'g1',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0].channelId).toBe('c1');
    expect(sender.sent[0].payload.content).toContain('https://example.com/view?t=T');
  });

  it('KOOK 会话开始 -> Discord 不发送（避免重复广播）', async () => {
    const { db, bus, svc, sessionStore } = setup();
    makeServer(db, 'g2', 'kook');
    sessionStore.set('s2', { id: 's2', status: 'active', token: 'T' });
    const sender = makeSender();
    svc.setSender(sender);

    bus.emitSessionStarted({
      sessionId: 's2', token: 'T', sharerUsername: 'bob',
      targetChannelId: 'c2', guildId: 'g2',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(sender.sent.length).toBe(0);
  });

  it('会话非 active 时不发卡片（发布端还没真正开始）', async () => {
    const { db, bus, svc, sessionStore } = setup();
    makeServer(db, 'g3', 'discord');
    sessionStore.set('s3', { id: 's3', status: 'pending', token: 'T' });
    const sender = makeSender();
    svc.setSender(sender);

    bus.emitSessionStarted({
      sessionId: 's3', token: 'T', sharerUsername: 'c',
      targetChannelId: 'c3', guildId: 'g3',
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(sender.sent.length).toBe(0);
  });

  it('同一会话不重复发卡片（cardMessageId 幂等）', async () => {
    const { db, bus, svc, sessionStore } = setup();
    makeServer(db, 'g4', 'discord');
    sessionStore.set('s4', { id: 's4', status: 'active', token: 'T', cardMessageId: 'already' });
    const sender = makeSender();
    svc.setSender(sender);

    bus.emitSessionStarted({
      sessionId: 's4', token: 'T', sharerUsername: 'd',
      targetChannelId: 'c4', guildId: 'g4',
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(sender.sent.length).toBe(0);
  });

  it('未配置 sender（无 Bot Token）时静默跳过，不抛错', async () => {
    const { db, bus, svc, sessionStore } = setup();
    makeServer(db, 'g5', 'discord');
    sessionStore.set('s5', { id: 's5', status: 'active', token: 'T' });
    svc.setSender(null);

    expect(() => bus.emitSessionStarted({
      sessionId: 's5', token: 'T', sharerUsername: 'e',
      targetChannelId: 'c5', guildId: 'g5',
    })).not.toThrow();
    await new Promise((r) => setTimeout(r, 30));
  });

  it('会话结束 -> 更新已发布的公开卡片', async () => {
    const { bus, svc, sessionStore } = setup();
    sessionStore.set('s6', {
      id: 's6', status: 'ended', sharerUsername: 'alice',
      totalViewerJoins: 3, durationMs: 60_000,
    });
    const sender = makeSender();
    svc.setSender(sender);

    bus.emitSessionEnded({
      sessionId: 's6', reason: 'sharer_stopped',
      targetChannelId: 'c6', cardMessageId: 'msg-6',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(sender.edited.length).toBe(1);
    expect(sender.edited[0].messageId).toBe('msg-6');
    expect(sender.edited[0].payload.embeds?.[0].title).toContain('已结束');
  });

  it('从未发布过公开卡片的会话结束时不再编辑（避免刷屏）', async () => {
    const { bus, svc, sessionStore } = setup();
    sessionStore.set('s7', { id: 's7', status: 'ended' });
    const sender = makeSender();
    svc.setSender(sender);

    bus.emitSessionEnded({ sessionId: 's7', reason: 'timeout', targetChannelId: 'c7' });
    await new Promise((r) => setTimeout(r, 30));
    expect(sender.edited.length).toBe(0);
  });

  it('销毁时只摘掉自己的监听，不影响 KOOK 的订阅', async () => {
    const { db, bus, svc, sessionStore } = setup();
    makeServer(db, 'g8', 'kook');
    sessionStore.set('s8', { id: 's8', status: 'active', token: 'T' });

    // 模拟 KOOK 也订阅了同一总线
    let kookCalls = 0;
    const kookHandler = () => { kookCalls++; };
    bus.onSessionStarted(kookHandler);

    svc.onModuleDestroy();
    bus.emitSessionStarted({
      sessionId: 's8', token: 'T', sharerUsername: 'x',
      targetChannelId: 'c8', guildId: 'g8',
    });
    await new Promise((r) => setTimeout(r, 30));

    // KOOK 的监听必须还在
    expect(kookCalls).toBe(1);
    expect(bus.listenerCount('session.started')).toBe(1);
  });
});
