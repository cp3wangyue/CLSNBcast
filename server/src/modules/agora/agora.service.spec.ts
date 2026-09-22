import { HttpException, Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { AgoraService, TokenSessionRef } from './agora.service';
import { AgoraProviderService } from './agora-provider.service';

const HEX_KEY = 'a'.repeat(64);
/** 声网 App ID 是 32 位十六进制 */
const APP_ID = '0123456789abcdef0123456789abcdef';
/** App Certificate 也是 32 位，太短会让 token 构建失败 */
const CERT = 'fedcba9876543210fedcba9876543210';
const OTHER_APP_ID = 'ffffffffffffffffffffffffffffffff';

function sessionRef(overrides: Partial<TokenSessionRef> = {}): TokenSessionRef {
  return {
    id: 's1',
    channel: 'cb_abcdef123456',
    providerId: '',
    agoraAppId: APP_ID,
    ...overrides,
  };
}

/** 断言抛出的 HttpException 带有指定业务 code，并返回其 message 供进一步检查。 */
function expectFailure(fn: () => unknown, expectedCode: string): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    const body = (e as HttpException).getResponse() as { code?: string; message?: string };
    expect(body.code).toBe(expectedCode);
    return body.message ?? '';
  }
  throw new Error(`expected a failure with code ${expectedCode}, but nothing was thrown`);
}

describe('AgoraService.generateToken', () => {
  let dir: string;
  let db: DatabaseService;
  let providers: AgoraProviderService;
  let service: AgoraService;
  let providerId: string;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    dir = mkdtempSync(join(tmpdir(), 'clsnbcast-agora-'));
    process.env.DATA_DIR = dir;
    process.env.SECRET_ENCRYPTION_KEY = HEX_KEY;

    db = new DatabaseService();
    providers = new AgoraProviderService(db, new SecretCryptoService(db));
    service = new AgoraService(db, providers);

    providerId = providers.create({
      ownerType: 'space',
      ownerId: 'guild-1',
      name: '服务器自带凭证',
      appId: APP_ID,
      appCertificate: CERT,
      tokenExpireSec: 3600,
    }).id;
  });

  afterEach(() => {
    db.onModuleDestroy();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.SECRET_ENCRYPTION_KEY;
  });

  describe('正常签发', () => {
    it('返回结构与旧实现一致（前端无需改动）', () => {
      const result = service.generateToken(sessionRef({ providerId }), 1, 'publisher');

      expect(Object.keys(result).sort()).toEqual(['appId', 'channel', 'expireSec', 'token', 'uid'].sort());
      expect(result.channel).toBe('cb_abcdef123456');
      expect(result.uid).toBe(1);
      expect(result.appId).toBe(APP_ID);
      expect(result.expireSec).toBe(3600);
      expect(result.token.length).toBeGreaterThan(0);
    });

    it('使用会话快照的 channel 与传入的 uid', () => {
      const result = service.generateToken(
        sessionRef({ providerId, channel: 'cb_zzz' }),
        4242,
        'subscriber',
      );
      expect(result.channel).toBe('cb_zzz');
      expect(result.uid).toBe(4242);
    });

    it('发布端与观众端拿到不同的 token', () => {
      const ref = sessionRef({ providerId });
      const pub = service.generateToken(ref, 1, 'publisher');
      const sub = service.generateToken(ref, 555, 'subscriber');
      expect(pub.token).not.toBe(sub.token);
    });

    it('签发成功后记录最后使用时间', () => {
      expect(providers.getForAdmin(providerId)!.lastUsedAt).toBeNull();
      service.generateToken(sessionRef({ providerId }), 1, 'publisher');
      expect(providers.getForAdmin(providerId)!.lastUsedAt).toBeGreaterThan(0);
    });

    it('未绑定 Provider 的旧会话无法签发（明确报错而不是发空 token）', () => {
      const message = expectFailure(
        () => service.generateToken(sessionRef({ providerId: '' }), 1, 'publisher'),
        'SESSION_PROVIDER_MISSING',
      );
      expect(message).toContain('重新发起共享');
    });

    it('Provider 不存在时报 PROVIDER_UNAVAILABLE', () => {
      expectFailure(
        () => service.generateToken(sessionRef({ providerId: 'nope' }), 1, 'publisher'),
        'PROVIDER_UNAVAILABLE',
      );
    });

    it('Provider 被停用时报 PROVIDER_UNAVAILABLE', () => {
      providers.update(providerId, { enabled: false });
      expectFailure(
        () => service.generateToken(sessionRef({ providerId }), 1, 'publisher'),
        'PROVIDER_UNAVAILABLE',
      );
    });

    it('Provider 没有证书时报 PROVIDER_NO_CERTIFICATE', () => {
      db.updateProvider(providerId, { appCertificateEnc: '' });
      expectFailure(
        () => service.generateToken(sessionRef({ providerId }), 1, 'publisher'),
        'PROVIDER_NO_CERTIFICATE',
      );
    });
  });

  describe('🔒 App ID 漂移不变量', () => {
    it('Provider 的 App ID 与会话快照不一致时拒绝签发', () => {
      // 模拟「管理员在共享进行中改了 App ID」
      db.updateProvider(providerId, { appId: OTHER_APP_ID });

      const message = expectFailure(
        () => service.generateToken(sessionRef({ providerId }), 1, 'publisher'),
        'PROVIDER_APPID_CHANGED',
      );
      expect(message).toContain('重新发起共享');
    });

    it('漂移时记 error 日志，且日志里带上会话与两个 App ID 便于排查', () => {
      db.updateProvider(providerId, { appId: OTHER_APP_ID });
      const errorSpy = vi.spyOn(Logger.prototype, 'error');

      expect(() => service.generateToken(sessionRef({ providerId }), 1, 'publisher')).toThrow();

      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('App ID drift');
      expect(logged).toContain(APP_ID);
      expect(logged).toContain(OTHER_APP_ID);
    });

    it('漂移时观众端同样被拒绝（不会有人被发到另一个声网项目）', () => {
      db.updateProvider(providerId, { appId: OTHER_APP_ID });
      expectFailure(
        () => service.generateToken(sessionRef({ providerId }), 777, 'subscriber'),
        'PROVIDER_APPID_CHANGED',
      );
    });

    it('App ID 改回与会话快照一致后又能正常签发', () => {
      db.updateProvider(providerId, { appId: OTHER_APP_ID });
      expect(() => service.generateToken(sessionRef({ providerId }), 1, 'publisher')).toThrow();

      db.updateProvider(providerId, { appId: APP_ID });
      const result = service.generateToken(sessionRef({ providerId }), 1, 'publisher');
      expect(result.appId).toBe(APP_ID);
    });

    it('会话快照里的 App ID 不会被 updateSession 改掉（该列不在白名单里）', () => {
      db.createSession({
        id: 's1', token: 'tok1', channel: 'cb_1', serverId: 'guild-1',
        sharerUserId: 'u1', sharerUsername: 'u', guildId: 'guild-1', targetChannelId: 'c1',
        status: 'pending', viewerCount: 0, peakViewers: 0, totalViewerJoins: 0,
        viewerDurationMs: 0, quality: '1080p_2', cardMessageId: null, manualCreated: 0,
        createdAt: 1, startedAt: null, endedAt: null, durationMs: null, lastHeartbeat: 1,
        graceStartedAt: null, graceReason: null, lastViewerAt: null,
        publisherClientId: null, lowLatency: 0,
        providerId, agoraAppId: APP_ID,
      });

      db.updateSession('s1', { providerId: OTHER_APP_ID, agoraAppId: OTHER_APP_ID } as any);

      const row = db.getSessionById('s1')!;
      expect(row.providerId).toBe(providerId);
      expect(row.agoraAppId).toBe(APP_ID);
    });

    it('bindSessionProvider 只能绑定一次（活跃会话无法被换 Provider）', () => {
      db.createSession({
        id: 's2', token: 'tok2', channel: 'cb_2', serverId: 'guild-1',
        sharerUserId: 'u1', sharerUsername: 'u', guildId: 'guild-1', targetChannelId: 'c1',
        status: 'active', viewerCount: 1, peakViewers: 1, totalViewerJoins: 1,
        viewerDurationMs: 0, quality: '1080p_2', cardMessageId: null, manualCreated: 0,
        createdAt: 1, startedAt: 1, endedAt: null, durationMs: null, lastHeartbeat: 1,
        graceStartedAt: null, graceReason: null, lastViewerAt: null,
        publisherClientId: null, lowLatency: 0,
        providerId, agoraAppId: APP_ID,
      });

      db.bindSessionProvider('s2', OTHER_APP_ID, OTHER_APP_ID);

      const row = db.getSessionById('s2')!;
      expect(row.providerId).toBe(providerId);
      expect(row.agoraAppId).toBe(APP_ID);
    });
  });

  describe('凭证不外泄', () => {
    it('签发结果里不含证书', () => {
      const result = service.generateToken(sessionRef({ providerId }), 1, 'publisher');
      expect(JSON.stringify(result)).not.toContain(CERT);
    });

    it('签发过程的日志不含证书', () => {
      const spies = [
        vi.spyOn(Logger.prototype, 'log'),
        vi.spyOn(Logger.prototype, 'warn'),
        vi.spyOn(Logger.prototype, 'error'),
      ];
      service.generateToken(sessionRef({ providerId }), 1, 'publisher');

      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          expect(call.map(String).join(' ')).not.toContain(CERT);
        }
      }
    });

    it('错误信息不含证书', () => {
      db.updateProvider(providerId, { appId: OTHER_APP_ID });
      try {
        service.generateToken(sessionRef({ providerId }), 1, 'publisher');
      } catch (e) {
        expect(JSON.stringify((e as HttpException).getResponse())).not.toContain(CERT);
      }
    });
  });

  describe('generateChannelName', () => {
    it('使用 cb_ 前缀', () => {
      expect(service.generateChannelName('abc123')).toBe('cb_abc123');
    });
  });

  describe('getAllowedQualities（保持不变）', () => {
    it('未绑定或未激活的服务器返回空', () => {
      expect(service.getAllowedQualities(undefined)).toEqual([]);
      expect(service.getAllowedQualities('guild-1')).toEqual([]);
    });

    it('已绑定且激活的服务器返回白名单中合法的档位', () => {
      db.createServer('guild-1', '测试', 'o', 'o');
      db.updateServer('guild-1', { bound: 1, status: 'active' });
      db.updateServer('guild-1', {
        allowedQualities: JSON.stringify(['720p30', 'not-a-real-key', '1080p_2', '720p30']),
      });

      expect(service.getAllowedQualities('guild-1')).toEqual(['720p30', '1080p_2']);
    });
  });
});
