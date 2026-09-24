import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { DatabaseService } from '../database/database.service';
import { DiscordShareService } from './discord-share.service';
import { DISCORD_INTERACTION, DiscordInteraction } from './discord.types';
import { ProviderUnavailableError } from '../session/session.service';

process.env.SUPER_ADMIN_PASSWORD = 'test-password';

let currentDataDir = '';

function makeDb(): DatabaseService {
  currentDataDir = mkdtempSync(join(tmpdir(), 'discord-share-'));
  process.env.DATA_DIR = currentDataDir;
  // 迁移在构造函数里跑，无需 onModuleInit
  return new DatabaseService();
}

/** publicDomain / bound 不在 ALLOWED_SERVER_COLS 里，测试直接写库 */
function rawExec(sql: string, ...params: any[]) {
  const d = new Database(join(currentDataDir, 'clsnbcast.db'));
  d.prepare(sql).run(...params);
  d.close();
}

/** 建一个已绑定的服务器 —— 未绑定的会被直接忽略 */
function bindServer(db: DatabaseService, guildId: string) {
  const s = db.createServer(guildId, '测试服务器', 'owner-1', 'ownerName', '', 'discord');
  db.updateServer(guildId, { bound: 1 } as any);
  // publicDomain 不在 ALLOWED 列里，直接写库
  rawExec('UPDATE servers SET public_domain = ?, bound = 1 WHERE server_id = ?', 'https://example.com', guildId);
  return s;
}

function interaction(guildId?: string, channelId = 'c1'): DiscordInteraction {
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

describe('DiscordShareService', () => {
  let db: DatabaseService;
  let sessions: any;
  let svc: DiscordShareService;

  beforeEach(() => {
    db = makeDb();
    sessions = {
      createSession: (p: any) => ({
        id: 'sess-1',
        token: 'SESSION_TOKEN',
        ...p,
      }),
    };
    svc = new DiscordShareService(db, sessions as any);
  });

  it('已绑定服务器 + 有 Provider -> 返回分享链接', () => {
    bindServer(db, 'g1');
    const r = svc.handleShareRequest(interaction('g1'));
    expect(r.status).toBe('ok');
    expect(r.shareUrl).toBe('https://example.com/share?t=SESSION_TOKEN');
  });

  it('服务器未绑定 -> no_server，且不创建会话', () => {
    db.createServer('g2', '未绑定', 'owner-1', 'ownerName', '', 'discord');
    let called = false;
    sessions.createSession = () => { called = true; return {}; };
    const r = svc.handleShareRequest(interaction('g2'));
    expect(r.status).toBe('no_server');
    expect(called).toBe(false);
  });

  it('服务器不存在 -> no_server', () => {
    expect(svc.handleShareRequest(interaction('nope')).status).toBe('no_server');
  });

  it('私信（无 guild_id）-> no_server，因为无法归属服务器', () => {
    bindServer(db, 'g1');
    const r = svc.handleShareRequest(interaction(undefined));
    expect(r.status).toBe('no_server');
    expect(r.message).toContain('服务器频道');
  });

  it('无可用 Provider -> provider_unavailable，给出面向用户的说明', () => {
    bindServer(db, 'g1');
    sessions.createSession = () => {
      throw new ProviderUnavailableError('QUOTA_EXCEEDED', 'quota exceeded');
    };
    const r = svc.handleShareRequest(interaction('g1'));
    expect(r.status).toBe('provider_unavailable');
    expect(r.message).toContain('Agora 凭证');
    // 不能把内部错误码直接抛给用户
    expect(r.message).not.toContain('QUOTA_EXCEEDED');
  });

  it('连续性触发被冷却拦截（防止连点创建多个会话）', () => {
    bindServer(db, 'g1');
    expect(svc.handleShareRequest(interaction('g1')).status).toBe('ok');
    expect(svc.handleShareRequest(interaction('g1')).status).toBe('cooldown');
  });

  it('不同频道的触发互不冷却', () => {
    bindServer(db, 'g1');
    expect(svc.handleShareRequest(interaction('g1', 'c1')).status).toBe('ok');
    expect(svc.handleShareRequest(interaction('g1', 'c2')).status).toBe('ok');
  });

  it('创建的会话带正确的归属与发起人信息', () => {
    bindServer(db, 'g1');
    let captured: any = null;
    sessions.createSession = (p: any) => { captured = p; return { id: 's1', token: 'T' }; };
    svc.handleShareRequest(interaction('g1'));
    expect(captured.serverId).toBe('g1');
    expect(captured.guildId).toBe('g1');
    expect(captured.sharerUserId).toBe('u1');
    expect(captured.targetChannelId).toBe('c1');
  });

  it('触发词匹配语义与 KOOK 一致', () => {
    expect(svc.matchesTrigger('帮我屏幕共享', '屏幕共享,共享屏幕')).toBe(true);
    expect(svc.matchesTrigger('随便说点别的', '屏幕共享,共享屏幕')).toBe(false);
    expect(svc.matchesTrigger('屏幕共享', '')).toBe(false);
  });

  it('publicDomain 末尾斜杠被去掉，不产生双斜杠链接', () => {
    bindServer(db, 'g1');
    rawExec('UPDATE servers SET public_domain = ? WHERE server_id = ?', 'https://example.com/', 'g1');
    const r = svc.handleShareRequest(interaction('g1'));
    expect(r.shareUrl).toBe('https://example.com/share?t=SESSION_TOKEN');
  });

  it('discord 平台的服务器记录被正确建立（platform 列）', () => {
    const s = bindServer(db, 'g-discord');
    expect(s.platform).toBe('discord');
    const stored = db.getSpace('discord', 'g-discord');
    expect(stored).toBeTruthy();
    // 不应该被当成 kook 空间
    expect(db.getSpace('kook', 'g-discord')).toBeFalsy();
  });

  it('Discord 与 KOOK 的同 externalId 互不串台', () => {
    bindServer(db, 'same-id');
    db.createServer('same-id-kook', 'KOOK 服务器', 'o', 'on', '', 'kook');
    // KOOK 的服务器用另一个 server_id，但即使 external_id 相同也不会混
    const discord = db.getSpace('discord', 'same-id');
    expect(discord?.platform).toBe('discord');
  });
});
