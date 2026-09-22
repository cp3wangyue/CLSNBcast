import { BadRequestException, Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { AgoraProviderService } from './agora-provider.service';
import { QualityConfigService } from '../quality/quality-config.service';
import { QualityPresetService } from '../quality/quality-preset.service';
import { UsageLedgerService } from '../usage/usage-ledger.service';
import { SuperAdminController } from '../super-admin/super-admin.controller';
import { ServerAdminController } from '../server-admin/server-admin.controller';

const HEX_KEY = 'a'.repeat(64);
const CERT = 'fedcba9876543210fedcba9876543210';
const APP_ID = '0123456789abcdef0123456789abcdef';

const SPACE_A = 'guild-a';
const SPACE_B = 'guild-b';

describe('Agora Provider 管理端接口', () => {
  let dir: string;
  let db: DatabaseService;
  let providers: AgoraProviderService;
  let qualityConfig: QualityConfigService;
  let ledger: UsageLedgerService;
  let presets: QualityPresetService;
  let superAdmin: SuperAdminController;
  let spaceAdmin: ServerAdminController;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    process.env.SUPER_ADMIN_PASSWORD = 'test-password';
    dir = mkdtempSync(join(tmpdir(), 'clsnbcast-api-'));
    process.env.DATA_DIR = dir;
    process.env.SECRET_ENCRYPTION_KEY = HEX_KEY;

    db = new DatabaseService();
    providers = new AgoraProviderService(db, new SecretCryptoService());
    qualityConfig = new QualityConfigService(db);
    qualityConfig.onModuleInit();
    ledger = new UsageLedgerService(db, qualityConfig);
    presets = new QualityPresetService(db, qualityConfig);
    presets.onModuleInit();
    superAdmin = new SuperAdminController(db, providers, qualityConfig, ledger, presets);
    spaceAdmin = new ServerAdminController(db, providers);

    db.createServer(SPACE_A, 'A 服务器', 'owner-a', '服主A');
    db.createServer(SPACE_B, 'B 服务器', 'owner-b', '服主B');
  });

  afterEach(() => {
    db.onModuleDestroy();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.SECRET_ENCRYPTION_KEY;
    delete process.env.SUPER_ADMIN_PASSWORD;
  });

  // ===== 超管 =====

  describe('SuperAdminController /api/super/providers', () => {
    function createPlatformProvider(overrides: Record<string, unknown> = {}) {
      return superAdmin.createProvider({
        ownerType: 'platform',
        name: '平台池',
        appId: APP_ID,
        appCertificate: CERT,
        ...overrides,
      } as any);
    }

    it('创建并返回管理端视图，不含明文证书', () => {
      const result = createPlatformProvider();
      expect(result.ok).toBe(true);
      expect(result.provider.hasAppCertificate).toBe(true);
      expect(JSON.stringify(result)).not.toContain(CERT);
    });

    it('列表与详情都不含明文证书', () => {
      createPlatformProvider({ customerSecret: 'customer-secret-plain' });

      const list = superAdmin.listProviders();
      expect(list).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain(CERT);
      expect(JSON.stringify(list)).not.toContain('customer-secret-plain');

      const detail = superAdmin.getProvider(list[0].id);
      expect(JSON.stringify(detail)).not.toContain(CERT);
      expect(detail).toHaveProperty('hasCustomerSecret', true);
    });

    it('可以创建 space / user 归属的 Provider', () => {
      const space = superAdmin.createProvider({
        ownerType: 'space', ownerId: SPACE_A, name: 'space', appId: APP_ID, appCertificate: CERT,
      } as any);
      const user = superAdmin.createProvider({
        ownerType: 'user', ownerId: 'kook-1', name: 'byok', appId: APP_ID, appCertificate: CERT,
      } as any);

      expect(space.provider.ownerType).toBe('space');
      expect(user.provider.ownerType).toBe('user');
    });

    it('更新 Provider 时不传 appCertificate 则证书保持不变', () => {
      const { provider } = createPlatformProvider();
      superAdmin.updateProvider(provider.id, { name: '改名' } as any);
      expect(providers.getWithSecrets(provider.id)!.appCertificate).toBe(CERT);
    });

    it('更新时可以轮换证书', () => {
      const { provider } = createPlatformProvider();
      superAdmin.updateProvider(provider.id, { appCertificate: 'rotated-cert' } as any);
      expect(providers.getWithSecrets(provider.id)!.appCertificate).toBe('rotated-cert');
    });

    it('更新不存在的 Provider 返回失败', () => {
      expect(superAdmin.updateProvider('nope', { name: 'x' } as any).ok).toBe(false);
    });

    it('详情不存在时返回失败', () => {
      expect(superAdmin.getProvider('nope')).toHaveProperty('ok', false);
    });

    it('删除未被引用的 Provider', () => {
      const { provider } = createPlatformProvider();
      expect(superAdmin.removeProvider(provider.id).ok).toBe(true);
      expect(superAdmin.listProviders()).toHaveLength(0);
    });

    it('校验失败时抛出 400 而不是 500', () => {
      try {
        createPlatformProvider({ appId: '' });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getStatus()).toBe(400);
      }
    });
  });

  // ===== 服务器管理员（BYOK）=====

  describe('ServerAdminController 空间级 Provider', () => {
    function createOwn(spaceId: string, overrides: Record<string, unknown> = {}) {
      return spaceAdmin.createProvider({ serverId: spaceId }, {
        name: '自带凭证',
        appId: APP_ID,
        appCertificate: CERT,
        ...overrides,
      } as any);
    }

    it('创建时强制绑定到当前服务器', () => {
      const result = createOwn(SPACE_A);
      expect(result.ok).toBe(true);
      expect(result.provider.ownerType).toBe('space');
      expect(result.provider.ownerId).toBe(SPACE_A);
    });

    it('🔒 请求里伪造 ownerType/ownerId 不会生效（防越权创建平台池 Provider）', () => {
      const result = spaceAdmin.createProvider({ serverId: SPACE_A }, {
        name: '伪装',
        appId: APP_ID,
        appCertificate: CERT,
        // 恶意载荷：试图创建平台池 Provider 或挂到别的服务器
        ownerType: 'platform',
        ownerId: SPACE_B,
      } as any);

      expect(result.provider.ownerType).toBe('space');
      expect(result.provider.ownerId).toBe(SPACE_A);
      // 平台池里没有多出东西
      expect(providers.listForAdminByOwner('platform', '')).toHaveLength(0);
    });

    it('列表只返回本服务器的 Provider', () => {
      createOwn(SPACE_A);
      createOwn(SPACE_B);

      const listA = spaceAdmin.listProviders({ serverId: SPACE_A });
      expect(listA).toHaveLength(1);
      expect(listA[0].ownerId).toBe(SPACE_A);
    });

    it('列表不含明文证书', () => {
      createOwn(SPACE_A);
      expect(JSON.stringify(spaceAdmin.listProviders({ serverId: SPACE_A }))).not.toContain(CERT);
    });

    it('可以更新自己的 Provider', () => {
      const { provider } = createOwn(SPACE_A);
      const result = spaceAdmin.updateProvider(
        { serverId: SPACE_A, id: provider.id },
        { name: '新名字' } as any,
      );
      expect(result.ok).toBe(true);
      expect(providers.getForAdmin(provider.id)!.name).toBe('新名字');
    });

    it('🔒 不能更新别的服务器的 Provider（IDOR）', () => {
      const { provider } = createOwn(SPACE_B);

      const result = spaceAdmin.updateProvider(
        { serverId: SPACE_A, id: provider.id },
        { name: '被篡改' } as any,
      );

      expect(result.ok).toBe(false);
      expect(providers.getForAdmin(provider.id)!.name).toBe('自带凭证');
    });

    it('🔒 不能删除别的服务器的 Provider（IDOR）', () => {
      const { provider } = createOwn(SPACE_B);

      const result = spaceAdmin.removeProvider({ serverId: SPACE_A, id: provider.id });

      expect(result.ok).toBe(false);
      expect(providers.getForAdmin(provider.id)).toBeTruthy();
    });

    it('🔒 不能操作平台池 Provider', () => {
      const platform = superAdmin.createProvider({
        ownerType: 'platform', name: '平台池', appId: APP_ID, appCertificate: CERT,
      } as any).provider;

      expect(spaceAdmin.updateProvider({ serverId: SPACE_A, id: platform.id }, { name: 'x' } as any).ok).toBe(false);
      expect(spaceAdmin.removeProvider({ serverId: SPACE_A, id: platform.id }).ok).toBe(false);
      expect(providers.getForAdmin(platform.id)!.name).toBe('平台池');
    });

    it('可以删除自己的 Provider', () => {
      const { provider } = createOwn(SPACE_A);
      expect(spaceAdmin.removeProvider({ serverId: SPACE_A, id: provider.id }).ok).toBe(true);
      expect(providers.getForAdmin(provider.id)).toBeUndefined();
    });

    it('不存在的服务器返回失败', () => {
      expect(spaceAdmin.createProvider({ serverId: 'nope' }, {
        name: 'x', appId: APP_ID, appCertificate: CERT,
      } as any).ok).toBe(false);
      expect(spaceAdmin.listProviders({ serverId: 'nope' })).toEqual([]);
    });
  });

  // ===== 端到端：创建后能真的签发 Token =====

  describe('创建 Provider 后会话可以正常签发', () => {
    it('频道主自己配的凭证能被会话解析到', () => {
      spaceAdmin.createProvider({ serverId: SPACE_A }, {
        name: '自带凭证', appId: APP_ID, appCertificate: CERT,
      } as any);

      const resolution = providers.resolveForSession({
        serverId: SPACE_A,
        sharerUserId: 'someone',
      });

      expect(resolution.status).toBe('ok');
      if (resolution.status !== 'ok') throw new Error('unreachable');
      expect(resolution.provider.appId).toBe(APP_ID);
      expect(resolution.reason).toBe('space-default');
    });

    it('另一个服务器仍然解析不到（凭证不串台）', () => {
      spaceAdmin.createProvider({ serverId: SPACE_A }, {
        name: '自带凭证', appId: APP_ID, appCertificate: CERT,
      } as any);

      expect(
        providers.resolveForSession({ serverId: SPACE_B, sharerUserId: 'someone' }).status,
      ).toBe('failed');
    });
  });
});
