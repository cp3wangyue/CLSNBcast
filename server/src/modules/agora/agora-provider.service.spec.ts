import { Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { AgoraProviderService, AgoraProviderValidationError } from './agora-provider.service';
import { currentPeriodKey } from './provider-quota';

const HEX_KEY = 'a'.repeat(64);
const APP_ID = '0123456789abcdef0123456789abcdef';
// 声网 App Certificate 固定 32 字符；长度不对时 RtcTokenBuilder 会返回空串而不是抛错
const CERT = 'fedcba9876543210fedcba9876543210';
const CUSTOMER_SECRET = 'plain-customer-secret';

function baseCreate(overrides: Record<string, unknown> = {}) {
  return {
    ownerType: 'platform' as const,
    name: '平台默认 Provider',
    appId: APP_ID,
    appCertificate: CERT,
    ...overrides,
  };
}

describe('AgoraProviderService', () => {
  let dir: string;
  let db: DatabaseService;
  let crypto: SecretCryptoService;
  let service: AgoraProviderService;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    dir = mkdtempSync(join(tmpdir(), 'clsnbcast-provider-'));
    process.env.DATA_DIR = dir;
    process.env.SECRET_ENCRYPTION_KEY = HEX_KEY;

    db = new DatabaseService();
    crypto = new SecretCryptoService();
    service = new AgoraProviderService(db, crypto);
  });

  afterEach(() => {
    db.onModuleDestroy();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.SECRET_ENCRYPTION_KEY;
  });

  // ===== 创建 =====

  describe('create', () => {
    it('创建 platform Provider 并返回管理端视图', () => {
      const view = service.create(baseCreate());

      expect(view.id).toBeTruthy();
      expect(view.ownerType).toBe('platform');
      expect(view.ownerId).toBe('');
      expect(view.name).toBe('平台默认 Provider');
      expect(view.appId).toBe(APP_ID);
      expect(view.enabled).toBe(true);
      expect(view.priority).toBe(100);
      expect(view.tokenExpireSec).toBe(3600);
      expect(view.healthStatus).toBe('unknown');
      expect(view.monthlyQuotaStandardMinutes).toBeNull();
      expect(view.quotaEnforced).toBe(false);
    });

    it('证书加密落库：库里不是明文，且是可解密的信封', () => {
      const view = service.create(baseCreate());
      const stored = db.getProvider(view.id)!;

      expect(stored.appCertificateEnc).not.toBe(CERT);
      expect(stored.appCertificateEnc).not.toContain(CERT);
      expect(stored.appCertificateEnc.startsWith('v1:')).toBe(true);
      expect(crypto.decrypt(stored.appCertificateEnc)).toBe(CERT);
    });

    it('管理端视图只暴露「是否已配置」，不含明文证书', () => {
      const view = service.create(
        baseCreate({ customerId: 'cust-1', customerSecret: CUSTOMER_SECRET }),
      );

      expect(view.hasAppCertificate).toBe(true);
      expect(view.hasCustomerSecret).toBe(true);
      expect(view.customerId).toBe('cust-1');

      // 整个视图序列化后不得出现任何明文秘密
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain(CERT);
      expect(serialized).not.toContain(CUSTOMER_SECRET);
    });

    it('customerSecret 也加密存储', () => {
      const view = service.create(baseCreate({ customerSecret: CUSTOMER_SECRET }));
      const stored = db.getProvider(view.id)!;

      expect(stored.customerSecretEnc).not.toBe(CUSTOMER_SECRET);
      expect(crypto.decrypt(stored.customerSecretEnc!)).toBe(CUSTOMER_SECRET);
    });

    it('未提供 customerSecret 时存 null，hasCustomerSecret 为 false', () => {
      const view = service.create(baseCreate());
      expect(view.hasCustomerSecret).toBe(false);
      expect(db.getProvider(view.id)!.customerSecretEnc).toBeNull();
    });

    it('space / user 归属需要 ownerId', () => {
      const space = service.create(baseCreate({ ownerType: 'space', ownerId: 'guild-1' }));
      expect(space.ownerType).toBe('space');
      expect(space.ownerId).toBe('guild-1');

      const user = service.create(baseCreate({ ownerType: 'user', ownerId: 'kook-user-1' }));
      expect(user.ownerType).toBe('user');
      expect(user.ownerId).toBe('kook-user-1');
    });

    it('allowedPresetIds 往返为数组', () => {
      const view = service.create(baseCreate({ allowedPresetIds: ['1080p_2', '720p30'] }));
      expect(view.allowedPresetIds).toEqual(['1080p_2', '720p30']);
    });

    it('配额可留空表示不限量', () => {
      expect(service.create(baseCreate()).monthlyQuotaStandardMinutes).toBeNull();
      expect(
        service.create(baseCreate({ monthlyQuotaStandardMinutes: 50000 }))
          .monthlyQuotaStandardMinutes,
      ).toBe(50000);
    });

    it('日志不泄露明文证书或 Customer Secret', () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log');
      service.create(baseCreate({ customerSecret: CUSTOMER_SECRET }));

      for (const call of logSpy.mock.calls) {
        const rendered = call.map(String).join(' ');
        expect(rendered).not.toContain(CERT);
        expect(rendered).not.toContain(CUSTOMER_SECRET);
      }
    });
  });

  // ===== 校验 =====

  describe('create 校验', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['ownerType 非法', { ownerType: 'nope' }, 'INVALID_OWNER_TYPE'],
      ['platform 不该带 ownerId', { ownerId: 'x' }, 'INVALID_OWNER_ID'],
      ['space 缺少 ownerId', { ownerType: 'space' }, 'INVALID_OWNER_ID'],
      ['user 缺少 ownerId', { ownerType: 'user' }, 'INVALID_OWNER_ID'],
      ['name 为空', { name: '  ' }, 'EMPTY_FIELD'],
      ['appId 为空', { appId: '' }, 'EMPTY_FIELD'],
      ['appId 含空白', { appId: 'abc def' }, 'INVALID_APP_ID'],
      ['appCertificate 为空', { appCertificate: '' }, 'EMPTY_FIELD'],
      ['priority 非整数', { priority: 1.5 }, 'INVALID_PRIORITY'],
      ['priority 为负', { priority: -1 }, 'INVALID_PRIORITY'],
      ['tokenExpireSec 过小', { tokenExpireSec: 10 }, 'INVALID_TOKEN_EXPIRE'],
      ['tokenExpireSec 过大', { tokenExpireSec: 999999 }, 'INVALID_TOKEN_EXPIRE'],
      ['配额为 0', { monthlyQuotaStandardMinutes: 0 }, 'INVALID_QUOTA'],
      ['配额为负', { monthlyQuotaStandardMinutes: -5 }, 'INVALID_QUOTA'],
    ];

    for (const [label, overrides, expectedCode] of cases) {
      it(`拒绝：${label}`, () => {
        try {
          service.create(baseCreate(overrides));
          throw new Error('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(AgoraProviderValidationError);
          expect((e as AgoraProviderValidationError).code).toBe(expectedCode);
        }
      });
    }

    it('校验失败时不会留下半条记录', () => {
      expect(() => service.create(baseCreate({ appId: '' }))).toThrow();
      expect(service.listForAdmin()).toHaveLength(0);
    });
  });

  // ===== 内部读取 =====

  describe('getWithSecrets', () => {
    it('返回解密后的明文，供 Token 签发使用', () => {
      const view = service.create(baseCreate({ customerSecret: CUSTOMER_SECRET }));
      const withSecrets = service.getWithSecrets(view.id)!;

      expect(withSecrets.appCertificate).toBe(CERT);
      expect(withSecrets.customerSecret).toBe(CUSTOMER_SECRET);
      expect(withSecrets.provider.appId).toBe(APP_ID);
    });

    it('不存在时返回 undefined', () => {
      expect(service.getWithSecrets('nope')).toBeUndefined();
    });

    it('主密钥不匹配时解密抛错（不会静默返回空串）', () => {
      const view = service.create(baseCreate());
      process.env.SECRET_ENCRYPTION_KEY = 'b'.repeat(64);
      const otherService = new AgoraProviderService(db, new SecretCryptoService());

      expect(() => otherService.getWithSecrets(view.id)).toThrow(/wrong key or corrupted/);
    });
  });

  // ===== 更新 =====

  describe('update', () => {
    it('未传的字段保持原值', () => {
      const view = service.create(baseCreate({ priority: 10, note: '原始备注' }));
      const updated = service.update(view.id, { name: '改个名字' })!;

      expect(updated.name).toBe('改个名字');
      expect(updated.priority).toBe(10);
      expect(updated.note).toBe('原始备注');
      expect(updated.appId).toBe(APP_ID);
    });

    it('appCertificate 传 undefined 时保持原证书不变（面板回传掩码不会覆盖真值）', () => {
      const view = service.create(baseCreate());
      service.update(view.id, { name: '新名字', appCertificate: undefined });

      expect(service.getWithSecrets(view.id)!.appCertificate).toBe(CERT);
    });

    it('显式传 appCertificate 时轮换证书', () => {
      const view = service.create(baseCreate());
      service.update(view.id, { appCertificate: 'rotated-certificate' });

      expect(service.getWithSecrets(view.id)!.appCertificate).toBe('rotated-certificate');
    });

    it('customerSecret 同样支持保持不变与轮换', () => {
      const view = service.create(baseCreate({ customerSecret: CUSTOMER_SECRET }));
      service.update(view.id, { name: 'x' });
      expect(service.getWithSecrets(view.id)!.customerSecret).toBe(CUSTOMER_SECRET);

      service.update(view.id, { customerSecret: 'rotated-secret' });
      expect(service.getWithSecrets(view.id)!.customerSecret).toBe('rotated-secret');
    });

    it('可以停用与启用', () => {
      const view = service.create(baseCreate());
      expect(service.update(view.id, { enabled: false })!.enabled).toBe(false);
      expect(service.update(view.id, { enabled: true })!.enabled).toBe(true);
    });

    it('可以调整配额、优先级、过期时间与可用画质', () => {
      const view = service.create(baseCreate());
      const updated = service.update(view.id, {
        monthlyQuotaStandardMinutes: 12345,
        quotaEnforced: true,
        priority: 5,
        tokenExpireSec: 7200,
        allowedPresetIds: ['4k30'],
        note: '备注',
      })!;

      expect(updated.monthlyQuotaStandardMinutes).toBe(12345);
      expect(updated.quotaEnforced).toBe(true);
      expect(updated.priority).toBe(5);
      expect(updated.tokenExpireSec).toBe(7200);
      expect(updated.allowedPresetIds).toEqual(['4k30']);
      expect(updated.note).toBe('备注');
    });

    it('配额可改回不限量', () => {
      const view = service.create(baseCreate({ monthlyQuotaStandardMinutes: 100 }));
      expect(service.update(view.id, { monthlyQuotaStandardMinutes: null })!
        .monthlyQuotaStandardMinutes).toBeNull();
    });

    it('不存在的 Provider 返回 undefined', () => {
      expect(service.update('nope', { name: 'x' })).toBeUndefined();
    });

    it('非法值同样被拒绝', () => {
      const view = service.create(baseCreate());
      expect(() => service.update(view.id, { priority: -1 })).toThrow(AgoraProviderValidationError);
      expect(() => service.update(view.id, { appId: '' })).toThrow(AgoraProviderValidationError);
      expect(() => service.update(view.id, { appCertificate: '' })).toThrow(AgoraProviderValidationError);
    });

    it('ownerType / ownerId 无法通过 update 篡改（不在可更新列里）', () => {
      const view = service.create(baseCreate());
      service.update(view.id, { ownerType: 'space', ownerId: 'hacked' } as any);

      const after = service.getForAdmin(view.id)!;
      expect(after.ownerType).toBe('platform');
      expect(after.ownerId).toBe('');
    });
  });

  // ===== 删除 =====

  describe('remove', () => {
    it('删除未被引用的 Provider', () => {
      const view = service.create(baseCreate());
      expect(service.remove(view.id)).toEqual({ ok: true });
      expect(service.getForAdmin(view.id)).toBeUndefined();
    });

    it('拒绝删除已被会话引用的 Provider', () => {
      const view = service.create(baseCreate());
      db.createSession({
        id: 's1', token: 'tok1', channel: 'cb_1', serverId: 'g1',
        sharerUserId: 'u1', sharerUsername: 'u', guildId: 'g1', targetChannelId: 'c1',
        status: 'pending', viewerCount: 0, peakViewers: 0, totalViewerJoins: 0,
        viewerDurationMs: 0, quality: '1080p_2', cardMessageId: null, manualCreated: 0,
        createdAt: 1, startedAt: null, endedAt: null, durationMs: null, lastHeartbeat: 1,
        graceStartedAt: null, graceReason: null, lastViewerAt: null,
        publisherClientId: null, lowLatency: 0,
        providerId: view.id, agoraAppId: APP_ID,
      });

      const result = service.remove(view.id);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('不能删除');
      expect(service.getForAdmin(view.id)).toBeTruthy();
    });

    it('不存在的 Provider 返回失败', () => {
      expect(service.remove('nope').ok).toBe(false);
    });
  });

  // ===== 列表与使用记录 =====

  describe('listForAdmin / markUsed', () => {
    it('按 priority 升序返回', () => {
      service.create(baseCreate({ name: 'c', priority: 30 }));
      service.create(baseCreate({ name: 'a', priority: 10 }));
      service.create(baseCreate({ name: 'b', priority: 20 }));

      expect(service.listForAdmin().map((p) => p.name)).toEqual(['a', 'b', 'c']);
    });

    it('按归属过滤', () => {
      service.create(baseCreate({ name: 'platform-default' }));
      service.create(baseCreate({ name: 'space-1', ownerType: 'space', ownerId: 'g1' }));
      service.create(baseCreate({ name: 'space-2', ownerType: 'space', ownerId: 'g2' }));

      expect(service.listForAdminByOwner('space', 'g1').map((p) => p.name)).toEqual(['space-1']);
      expect(service.listForAdminByOwner('space', 'g2').map((p) => p.name)).toEqual(['space-2']);
      expect(service.listForAdminByOwner('platform', '').map((p) => p.name)).toEqual([
        'platform-default',
      ]);
      expect(service.listForAdminByOwner('user', 'u1')).toHaveLength(0);
    });

    it('markUsed 记录最后使用时间', () => {
      const view = service.create(baseCreate());
      expect(service.getForAdmin(view.id)!.lastUsedAt).toBeNull();

      service.markUsed(view.id);
      expect(service.getForAdmin(view.id)!.lastUsedAt).toBeGreaterThan(0);
    });
  });

  // ===== 启动门禁 =====

  describe('onModuleInit 启动门禁', () => {
    it('库里没有密文时，缺密钥也能启动', () => {
      delete process.env.SECRET_ENCRYPTION_KEY;
      const noKeyService = new AgoraProviderService(db, new SecretCryptoService());
      expect(() => noKeyService.onModuleInit()).not.toThrow();
    });

    it('库里已有密文但密钥缺失时，启动直接失败', () => {
      service.create(baseCreate());
      delete process.env.SECRET_ENCRYPTION_KEY;

      const noKeyService = new AgoraProviderService(db, new SecretCryptoService());
      expect(() => noKeyService.onModuleInit()).toThrow(/FATAL/);
    });

    it('密钥存在时正常启动', () => {
      service.create(baseCreate());
      expect(() => service.onModuleInit()).not.toThrow();
    });
  });

  // ===== 存量凭证迁移 =====

  describe('存量服务器凭证迁移（onModuleInit）', () => {
    /**
     * 直接把明文凭证写进 servers 表，模拟「由旧代码创建的库」。
     *
     * 不能再走 `db.updateServer()`：那三个 agora 列自 Phase 1 起已被移出
     * `ALLOWED_SERVER_COLS`（否则会留下一条明文证书的写入路径），
     * 只有存量迁移与 clearServerCertificate 走直接 SQL。
     */
    function writeLegacyCredentialColumns(
      serverId: string,
      appId: string,
      cert: string,
      tokenExpireSec = 3600,
    ) {
      const raw = new Database(join(dir, 'clsnbcast.db'));
      try {
        raw
          .prepare(
            `UPDATE servers
             SET agora_app_id = ?, agora_app_certificate = ?, agora_token_expire_sec = ?
             WHERE server_id = ?`,
          )
          .run(appId, cert, tokenExpireSec, serverId);
      } finally {
        raw.close();
      }
    }

    /** 造一个持有明文 Agora 凭证的「旧库服务器」。 */
    function seedLegacyServer(
      serverId: string,
      opts: { guildName?: string; tokenExpireSec?: number } = {},
    ) {
      db.createServer(serverId, opts.guildName ?? `服务器 ${serverId}`, 'owner-1', '服主');
      writeLegacyCredentialColumns(serverId, APP_ID, CERT, opts.tokenExpireSec ?? 3600);
    }

    it('把明文凭证迁成 owner_type=space 的 Provider，并加密存储', () => {
      seedLegacyServer('guild-1', { guildName: '测试服务器' });
      service.onModuleInit();

      const providers = service.listForAdminByOwner('space', 'guild-1');
      expect(providers).toHaveLength(1);
      expect(providers[0].name).toBe('测试服务器 自带凭证');
      expect(providers[0].appId).toBe(APP_ID);
      expect(providers[0].hasAppCertificate).toBe(true);

      // 证书确实加密落库，且可解回原值
      const stored = db.getProvider(providers[0].id)!;
      expect(stored.appCertificateEnc).not.toContain(CERT);
      expect(crypto.decrypt(stored.appCertificateEnc)).toBe(CERT);
      expect(service.getWithSecrets(providers[0].id)!.appCertificate).toBe(CERT);
    });

    it('回填该服务器已有会话的 Provider 绑定', () => {
      seedLegacyServer('guild-1');
      for (const id of ['s1', 's2']) {
        db.createSession({
          id, token: `tok-${id}`, channel: `cb_${id}`, serverId: 'guild-1',
          sharerUserId: 'u1', sharerUsername: 'u', guildId: 'guild-1', targetChannelId: 'c1',
          status: 'ended', viewerCount: 0, peakViewers: 0, totalViewerJoins: 0,
          viewerDurationMs: 0, quality: '1080p_2', cardMessageId: null, manualCreated: 0,
          createdAt: 1, startedAt: null, endedAt: null, durationMs: null, lastHeartbeat: 1,
          graceStartedAt: null, graceReason: null, lastViewerAt: null,
          publisherClientId: null, lowLatency: 0,
          providerId: '', agoraAppId: '',
        });
      }

      service.onModuleInit();

      const provider = service.listForAdminByOwner('space', 'guild-1')[0];
      for (const id of ['s1', 's2']) {
        const row = db.getSessionById(id)!;
        expect(row.providerId).toBe(provider.id);
        expect(row.agoraAppId).toBe(APP_ID);
      }
    });

    it('幂等：重复启动不会重复创建 Provider', () => {
      seedLegacyServer('guild-1');
      service.onModuleInit();
      service.onModuleInit();
      service.onModuleInit();

      expect(service.listForAdminByOwner('space', 'guild-1')).toHaveLength(1);
    });

    it('迁移后清空服务器上的明文证书（秘密不得明文落盘）', () => {
      seedLegacyServer('guild-1');
      service.onModuleInit();

      expect(db.getServer('guild-1')!.agoraAppCertificate).toBe('');
      // 证书没有丢：仍能从 Provider 里解出
      const provider = service.listForAdminByOwner('space', 'guild-1')[0];
      expect(service.getWithSecrets(provider.id)!.appCertificate).toBe(CERT);
    });

    it('Provider 已存在但明文残留时，启动会清掉残留', () => {
      seedLegacyServer('guild-1');
      service.onModuleInit();

      // 模拟「上次迁移成功、但清空明文这一步失败」
      writeLegacyCredentialColumns('guild-1', APP_ID, CERT);
      service.onModuleInit();

      expect(db.getServer('guild-1')!.agoraAppCertificate).toBe('');
      // 不会因此多出一个 Provider
      expect(service.listForAdminByOwner('space', 'guild-1')).toHaveLength(1);
    });

    it('没有主密钥时跳过迁移并告警（而不是崩溃）', () => {
      seedLegacyServer('guild-1');
      delete process.env.SECRET_ENCRYPTION_KEY;
      const noKeyService = new AgoraProviderService(db, new SecretCryptoService());
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');

      expect(() => noKeyService.onModuleInit()).not.toThrow();
      expect(service.listForAdminByOwner('space', 'guild-1')).toHaveLength(0);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('cannot be migrated'))).toBe(true);
    });

    it('多个服务器各自迁成独立 Provider', () => {
      seedLegacyServer('guild-1');
      seedLegacyServer('guild-2');
      service.onModuleInit();

      expect(service.listForAdminByOwner('space', 'guild-1')).toHaveLength(1);
      expect(service.listForAdminByOwner('space', 'guild-2')).toHaveLength(1);
      expect(service.listForAdmin()).toHaveLength(2);
    });

    it('只有一个服务器凭证坏掉时，其余仍完成迁移', () => {
      // 第一个服务器的 App ID 含空白 → 校验失败
      db.createServer('bad', '坏服务器', 'o', 'o');
      writeLegacyCredentialColumns('bad', 'has space', CERT);
      seedLegacyServer('guild-2');

      const errorSpy = vi.spyOn(Logger.prototype, 'error');
      expect(() => service.onModuleInit()).not.toThrow();

      expect(service.listForAdminByOwner('space', 'bad')).toHaveLength(0);
      expect(service.listForAdminByOwner('space', 'guild-2')).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('guildName 为空时用 serverId 兜底，不因校验失败中断启动', () => {
      seedLegacyServer('guild-x', { guildName: '' });
      expect(() => service.onModuleInit()).not.toThrow();

      const providers = service.listForAdminByOwner('space', 'guild-x');
      expect(providers).toHaveLength(1);
      expect(providers[0].name).toContain('guild-x');
    });

    it('越界的 tokenExpireSec 被夹取到合法区间', () => {
      seedLegacyServer('guild-low', { tokenExpireSec: 5 });
      seedLegacyServer('guild-high', { tokenExpireSec: 999999 });
      service.onModuleInit();

      expect(service.listForAdminByOwner('space', 'guild-low')[0].tokenExpireSec).toBe(60);
      expect(service.listForAdminByOwner('space', 'guild-high')[0].tokenExpireSec).toBe(24 * 3600);
    });

    it('没有存量凭证时不做任何事', () => {
      db.createServer('guild-empty', '无凭证服务器', 'o', 'o');
      service.onModuleInit();
      expect(service.listForAdmin()).toHaveLength(0);
    });

    it('迁移日志不泄露明文证书', () => {
      seedLegacyServer('guild-1');
      const logSpy = vi.spyOn(Logger.prototype, 'log');
      service.onModuleInit();

      for (const call of logSpy.mock.calls) {
        expect(call.map(String).join(' ')).not.toContain(CERT);
      }
    });
  });

  // ===== 会话创建时的 Provider 解析 =====

  describe('resolveForSession', () => {
    const SERVER = 'guild-1';
    const SHARER = 'kook-user-1';

    function make(overrides: Record<string, unknown> = {}) {
      return service.create(baseCreate(overrides));
    }

    function resolve(overrides: Partial<Parameters<typeof service.resolveForSession>[0]> = {}) {
      return service.resolveForSession({ serverId: SERVER, sharerUserId: SHARER, ...overrides });
    }

    it('没有任何 Provider 时返回 NO_PROVIDER，并给出面向用户的文案', () => {
      const result = resolve();
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') throw new Error('unreachable');
      expect(result.code).toBe('NO_PROVIDER');
      expect(result.message).toContain('尚未配置可用的声网 Provider');
    });

    describe('优先级：space 默认 > user BYOK > 平台池', () => {
      it('三者都存在时选 space 默认', () => {
        make({ name: 'platform', ownerType: 'platform', priority: 1 });
        make({ name: 'byok', ownerType: 'user', ownerId: SHARER, priority: 2 });
        const space = make({ name: 'space', ownerType: 'space', ownerId: SERVER, priority: 3 });

        const result = resolve();
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('unreachable');
        expect(result.provider.id).toBe(space.id);
        expect(result.reason).toBe('space-default');
      });

      it('没有 space 时选 user BYOK', () => {
        make({ name: 'platform', ownerType: 'platform', priority: 1 });
        const byok = make({ name: 'byok', ownerType: 'user', ownerId: SHARER, priority: 2 });

        const result = resolve();
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('unreachable');
        expect(result.provider.id).toBe(byok.id);
        expect(result.reason).toBe('user-byok');
      });

      it('只剩平台池时选平台池中 priority 最小的', () => {
        make({ name: 'platform-slow', ownerType: 'platform', priority: 50 });
        const fast = make({ name: 'platform-fast', ownerType: 'platform', priority: 5 });

        const result = resolve();
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('unreachable');
        expect(result.provider.id).toBe(fast.id);
        expect(result.reason).toBe('platform-pool');
      });

      it('别人的 space / user Provider 不会被误用', () => {
        make({ name: 'other-space', ownerType: 'space', ownerId: 'guild-other' });
        make({ name: 'other-user', ownerType: 'user', ownerId: 'someone-else' });

        expect(resolve().status).toBe('failed');
      });
    });

    describe('跳过不可用的 Provider', () => {
      it('跳过已停用的，回退到下一个', () => {
        const disabled = make({ name: 'disabled-space', ownerType: 'space', ownerId: SERVER });
        service.update(disabled.id, { enabled: false });
        const fallback = make({ name: 'platform', ownerType: 'platform' });

        const result = resolve();
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('unreachable');
        expect(result.provider.id).toBe(fallback.id);
      });

      it('跳过健康检查未通过的', () => {
        const sick = make({ name: 'sick', ownerType: 'space', ownerId: SERVER });
        db.updateProvider(sick.id, { healthStatus: 'unhealthy' });
        const fallback = make({ name: 'platform', ownerType: 'platform' });

        const result = resolve();
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('unreachable');
        expect(result.provider.id).toBe(fallback.id);
      });

      it('degraded 仍可用（只是性能下降，不该停用）', () => {
        const degraded = make({ name: 'degraded', ownerType: 'space', ownerId: SERVER });
        db.updateProvider(degraded.id, { healthStatus: 'degraded' });

        const result = resolve();
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('unreachable');
        expect(result.provider.id).toBe(degraded.id);
      });

      it('跳过没有证书的 Provider', () => {
        const noCert = make({ name: 'no-cert', ownerType: 'space', ownerId: SERVER });
        db.updateProvider(noCert.id, { appCertificateEnc: '' });

        expect(resolve().status).toBe('failed');
      });
    });

    describe('配额', () => {
      const currentKey = currentPeriodKey();

      it('已超配额的被跳过，回退到未超配额的', () => {
        const full = make({ name: 'full', ownerType: 'space', ownerId: SERVER });
        db.updateProvider(full.id, {
          monthlyQuotaStandardMinutes: 100,
          quotaEnforced: 1,
          estimatedUsageStandardMinutes: 100,
          usagePeriodKey: currentKey,
        });
        const spare = make({ name: 'spare', ownerType: 'platform' });

        const result = resolve();
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('unreachable');
        expect(result.provider.id).toBe(spare.id);
      });

      it('全部超配额时返回 QUOTA_EXCEEDED', () => {
        const full = make({ name: 'full', ownerType: 'space', ownerId: SERVER });
        db.updateProvider(full.id, {
          monthlyQuotaStandardMinutes: 100,
          quotaEnforced: 1,
          estimatedUsageStandardMinutes: 100,
          usagePeriodKey: currentKey,
        });

        const result = resolve();
        expect(result.status).toBe('failed');
        if (result.status !== 'failed') throw new Error('unreachable');
        expect(result.code).toBe('QUOTA_EXCEEDED');
      });

      it('未开启强制时不拦截', () => {
        const p = make({ name: 'soft', ownerType: 'space', ownerId: SERVER });
        db.updateProvider(p.id, {
          monthlyQuotaStandardMinutes: 100,
          quotaEnforced: 0,
          estimatedUsageStandardMinutes: 99999,
          usagePeriodKey: currentKey,
        });

        expect(resolve().status).toBe('ok');
      });

      it('估算值属于上一周期时不算超配额', () => {
        const p = make({ name: 'stale', ownerType: 'space', ownerId: SERVER });
        db.updateProvider(p.id, {
          monthlyQuotaStandardMinutes: 100,
          quotaEnforced: 1,
          estimatedUsageStandardMinutes: 99999,
          usagePeriodKey: '2020-01',
        });

        expect(resolve().status).toBe('ok');
      });
    });

    describe('显式指定', () => {
      it('普通用户不能显式指定平台池 Provider', () => {
        const p = make({ name: 'platform', ownerType: 'platform' });

        const result = resolve({ requestedProviderId: p.id, allowExplicitSelection: false });
        expect(result.status).toBe('failed');
        if (result.status !== 'failed') throw new Error('unreachable');
        expect(result.code).toBe('NOT_AUTHORIZED');
      });

      it('管理员可以显式指定平台池 Provider', () => {
        const p = make({ name: 'platform', ownerType: 'platform' });

        const result = resolve({ requestedProviderId: p.id, allowExplicitSelection: true });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('unreachable');
        expect(result.provider.id).toBe(p.id);
        expect(result.reason).toBe('explicit');
      });

      it('可以显式指定本服务器的 space Provider', () => {
        const p = make({ name: 'space', ownerType: 'space', ownerId: SERVER });

        const result = resolve({ requestedProviderId: p.id });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('unreachable');
        expect(result.reason).toBe('explicit');
      });

      it('不能显式指定别的服务器的 space Provider', () => {
        const p = make({ name: 'other', ownerType: 'space', ownerId: 'guild-other' });

        const result = resolve({ requestedProviderId: p.id });
        expect(result.status).toBe('failed');
        if (result.status !== 'failed') throw new Error('unreachable');
        expect(result.code).toBe('NOT_AUTHORIZED');
      });

      it('可以显式指定自己的 BYOK Provider', () => {
        const p = make({ name: 'byok', ownerType: 'user', ownerId: SHARER });

        const result = resolve({ requestedProviderId: p.id });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('unreachable');
        expect(result.reason).toBe('explicit');
      });

      it('不能显式指定别人的 BYOK Provider', () => {
        const p = make({ name: 'byok', ownerType: 'user', ownerId: 'someone-else' });

        const result = resolve({ requestedProviderId: p.id });
        expect(result.status).toBe('failed');
        if (result.status !== 'failed') throw new Error('unreachable');
        expect(result.code).toBe('NOT_AUTHORIZED');
      });

      it('指定的 Provider 不存在时返回 NO_PROVIDER', () => {
        const result = resolve({ requestedProviderId: 'nope' });
        expect(result.status).toBe('failed');
        if (result.status !== 'failed') throw new Error('unreachable');
        expect(result.code).toBe('NO_PROVIDER');
      });

      it('显式指定的 Provider 已停用时失败，不会悄悄换别的', () => {
        const p = make({ name: 'platform', ownerType: 'platform' });
        service.update(p.id, { enabled: false });

        const result = resolve({ requestedProviderId: p.id, allowExplicitSelection: true });
        expect(result.status).toBe('failed');
      });
    });
  });

  // ===== 健康检查 =====

  describe('健康检查（离线）', () => {
    it('证书合法时标记为 healthy 并记录检查时间', () => {
      const { id } = service.create(baseCreate());

      const outcome = service.checkHealth(id);

      expect(outcome.status).toBe('healthy');
      expect(outcome.message).toBe('');

      const view = service.getForAdmin(id)!;
      expect(view.healthStatus).toBe('healthy');
      expect(view.healthCheckedAt).toBeGreaterThan(0);
      expect(view.healthMessage).toBe('');
    });

    it('没有证书时标记为 unhealthy', () => {
      const { id } = service.create(baseCreate());
      db.updateProvider(id, { appCertificateEnc: '' });

      const outcome = service.checkHealth(id);

      expect(outcome.status).toBe('unhealthy');
      expect(outcome.message).toContain('未配置 App Certificate');
    });

    it('🔎 证书长度不合法时也标记为 unhealthy（此时 SDK 返回空串而不是抛错）', () => {
      // 声网 App Certificate 固定 32 字符。长度不对时 buildTokenWithUid 不抛错，
      // 而是返回空串 —— 只靠 try/catch 会把它误判为健康。
      const { id } = service.create(baseCreate({ appCertificate: 'too-short' }));

      const outcome = service.checkHealth(id);

      expect(outcome.status).toBe('unhealthy');
      expect(outcome.message).toContain('32 字符');
    });

    it('主密钥不匹配（解密失败）时标记为 unhealthy', () => {
      const { id } = service.create(baseCreate());
      process.env.SECRET_ENCRYPTION_KEY = 'b'.repeat(64);
      const other = new AgoraProviderService(db, new SecretCryptoService());

      expect(other.checkHealth(id).status).toBe('unhealthy');
    });

    it('已停用的 Provider 跳过检查，状态保持不变', () => {
      const { id } = service.create(baseCreate());
      service.checkHealth(id); // 先变成 healthy
      service.update(id, { enabled: false });

      const outcome = service.checkHealth(id);

      expect(outcome.status).toBe('healthy');
      expect(service.getForAdmin(id)!.healthStatus).toBe('healthy');
    });

    it('不存在的 Provider 返回 unknown', () => {
      expect(service.checkHealth('nope').status).toBe('unknown');
    });

    it('checkAllHealth 覆盖全部 Provider', () => {
      const healthy = service.create(baseCreate({ name: 'a' })).id;
      const broken = service.create(baseCreate({ name: 'b', appCertificate: 'short' })).id;

      const results = service.checkAllHealth();

      expect(results).toHaveLength(2);
      expect(results.find((r) => r.providerId === healthy)!.status).toBe('healthy');
      expect(results.find((r) => r.providerId === broken)!.status).toBe('unhealthy');
    });

    it('检查结果与解析联动：被判不健康的 Provider 不再被分配新会话', () => {
      const broken = service.create(
        baseCreate({ ownerType: 'space', ownerId: 'g1', appCertificate: 'short' }),
      ).id;
      expect(service.resolveForSession({ serverId: 'g1', sharerUserId: 'u' }).status).toBe('ok');

      service.checkHealth(broken);

      expect(service.resolveForSession({ serverId: 'g1', sharerUserId: 'u' }).status).toBe('failed');
    });

    it('health_message 与日志都不含证书', () => {
      const { id } = service.create(baseCreate({ appCertificate: 'short' }));
      const spies = [
        vi.spyOn(Logger.prototype, 'log'),
        vi.spyOn(Logger.prototype, 'warn'),
        vi.spyOn(Logger.prototype, 'error'),
      ];

      const outcome = service.checkHealth(id);

      expect(outcome.message).not.toContain(CERT);
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          expect(call.map(String).join(' ')).not.toContain(CERT);
        }
      }
      expect(service.getForAdmin(id)!.healthMessage).not.toContain(CERT);
    });

    it('onModuleInit 会先做一次检查，让面板启动就有状态', () => {
      const { id } = service.create(baseCreate());
      expect(service.getForAdmin(id)!.healthCheckedAt).toBeNull();

      service.onModuleInit();

      expect(service.getForAdmin(id)!.healthStatus).toBe('healthy');
      expect(service.getForAdmin(id)!.healthCheckedAt).toBeGreaterThan(0);
    });
  });
});
