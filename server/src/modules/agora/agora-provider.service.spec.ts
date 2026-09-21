import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { AgoraProviderService, AgoraProviderValidationError } from './agora-provider.service';

const HEX_KEY = 'a'.repeat(64);
const APP_ID = '0123456789abcdef0123456789abcdef';
const CERT = 'plain-certificate-value-should-never-be-stored';
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
});
