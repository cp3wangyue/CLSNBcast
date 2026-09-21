import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AgoraProviderHealthStatus,
  AgoraProviderOwnerType,
  AgoraProviderRecord,
  DatabaseService,
} from '../database/database.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';

/** 管理端可见的 Provider 视图。**绝不含任何明文秘密。** */
export interface AgoraProviderAdminView {
  id: string;
  ownerType: AgoraProviderOwnerType;
  ownerId: string;
  name: string;
  /** App ID 不是秘密，明文返回便于面板展示与核对。 */
  appId: string;
  /** 只暴露「是否已配置」，永不返回证书本身。 */
  hasAppCertificate: boolean;
  customerId: string | null;
  hasCustomerSecret: boolean;
  enabled: boolean;
  priority: number;
  tokenExpireSec: number;
  healthStatus: AgoraProviderHealthStatus;
  healthCheckedAt: number | null;
  healthMessage: string;
  /** null = 不限量 */
  monthlyQuotaStandardMinutes: number | null;
  quotaEnforced: boolean;
  estimatedUsageStandardMinutes: number;
  usagePeriodKey: string;
  lastUsedAt: number | null;
  allowedPresetIds: string[] | null;
  note: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 含明文秘密的内部视图。
 *
 * ⚠️ **绝不允许出现在任何 API 响应里**，也不允许写入日志。
 * 唯一合法用途是 Token 签发与健康检查。
 */
export interface AgoraProviderWithSecrets {
  provider: AgoraProviderRecord;
  appCertificate: string;
  customerSecret: string | null;
}

export interface AgoraProviderCreateRequest {
  ownerType: AgoraProviderOwnerType;
  ownerId?: string;
  name: string;
  appId: string;
  /** 明文入参，由本服务加密后落库。 */
  appCertificate: string;
  customerId?: string | null;
  customerSecret?: string | null;
  enabled?: boolean;
  priority?: number;
  tokenExpireSec?: number;
  monthlyQuotaStandardMinutes?: number | null;
  quotaEnforced?: boolean;
  allowedPresetIds?: string[] | null;
  note?: string;
}

export interface AgoraProviderUpdateRequest {
  name?: string;
  appId?: string;
  /** `undefined` = 保持不变；非空字符串 = 覆盖为新值。 */
  appCertificate?: string;
  customerId?: string | null;
  customerSecret?: string;
  enabled?: boolean;
  priority?: number;
  tokenExpireSec?: number;
  monthlyQuotaStandardMinutes?: number | null;
  quotaEnforced?: boolean;
  allowedPresetIds?: string[] | null;
  note?: string;
}

export class AgoraProviderValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgoraProviderValidationError';
  }
}

const OWNER_TYPES: AgoraProviderOwnerType[] = ['platform', 'space', 'user'];
const MIN_TOKEN_EXPIRE_SEC = 60;
const MAX_TOKEN_EXPIRE_SEC = 24 * 3600;

/**
 * Agora Provider 池的业务层。
 *
 * 职责边界：
 * - **加密只在这里发生**。`DatabaseService` 只原样存取密文，从不接触明文，
 *   因此明文秘密在整个代码库中只出现在本服务内部。
 * - 管理端视图（`AgoraProviderAdminView`）只暴露 `hasXxx` 布尔值，
 *   明文秘密只能通过 `getWithSecrets()` 取得，而它只被 Token 签发与健康检查调用。
 */
@Injectable()
export class AgoraProviderService implements OnModuleInit {
  private readonly logger = new Logger(AgoraProviderService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly crypto: SecretCryptoService,
  ) {}

  onModuleInit(): void {
    // 启动门禁：库里已有密文、但主密钥缺失或不可用时，让进程直接失败退出。
    // 否则应用会带着「读不出凭证」的状态继续运行，问题被推迟到用户开始共享时才暴露。
    this.crypto.assertUsableForExistingSecrets(this.db.listProviderCiphertexts());
  }

  // ===== 管理端读取 =====

  listForAdmin(): AgoraProviderAdminView[] {
    return this.db.listProviders().map((record) => this.toAdminView(record));
  }

  listForAdminByOwner(ownerType: AgoraProviderOwnerType, ownerId: string): AgoraProviderAdminView[] {
    return this.db.listProvidersByOwner(ownerType, ownerId).map((record) => this.toAdminView(record));
  }

  getForAdmin(id: string): AgoraProviderAdminView | undefined {
    const record = this.db.getProvider(id);
    return record ? this.toAdminView(record) : undefined;
  }

  // ===== 内部读取（含明文秘密）=====

  /**
   * 取出解密后的 Provider。
   *
   * ⚠️ 返回值含明文证书，调用方必须**只**把它用于签发 Token / 健康检查，
   * 不得放进响应体或日志。
   */
  getWithSecrets(id: string): AgoraProviderWithSecrets | undefined {
    const provider = this.db.getProvider(id);
    if (!provider) return undefined;

    const appCertificate = provider.appCertificateEnc
      ? this.crypto.decrypt(provider.appCertificateEnc)
      : '';
    const customerSecret = provider.customerSecretEnc
      ? this.crypto.decrypt(provider.customerSecretEnc)
      : null;

    return { provider, appCertificate, customerSecret };
  }

  // ===== 写入 =====

  create(input: AgoraProviderCreateRequest): AgoraProviderAdminView {
    this.assertValidCreate(input);
    const id = randomUUID();

    const record = this.db.createProvider({
      id,
      ownerType: input.ownerType,
      ownerId: this.normalizeOwnerId(input.ownerType, input.ownerId),
      name: input.name.trim(),
      appId: input.appId.trim(),
      appCertificateEnc: this.crypto.encrypt(input.appCertificate),
      customerId: input.customerId?.trim() || null,
      customerSecretEnc: input.customerSecret
        ? this.crypto.encrypt(input.customerSecret)
        : null,
      enabled: input.enabled !== false,
      priority: input.priority ?? 100,
      tokenExpireSec: input.tokenExpireSec ?? 3600,
      monthlyQuotaStandardMinutes: input.monthlyQuotaStandardMinutes ?? null,
      quotaEnforced: input.quotaEnforced === true,
      allowedPresetIds: input.allowedPresetIds ?? null,
      note: input.note ?? '',
    });

    // 只记录 id 与归属，不记录 App ID 之外的任何凭证信息
    this.logger.log(
      `Created Agora provider ${record.id} (owner=${record.ownerType}:${record.ownerId || '-'})`,
    );
    return this.toAdminView(record);
  }

  update(id: string, input: AgoraProviderUpdateRequest): AgoraProviderAdminView | undefined {
    const existing = this.db.getProvider(id);
    if (!existing) return undefined;

    const fields: Partial<AgoraProviderRecord> = {};

    if (input.name !== undefined) {
      this.assertNonEmpty(input.name, 'name');
      fields.name = input.name.trim();
    }
    if (input.appId !== undefined) {
      this.assertAppId(input.appId);
      fields.appId = input.appId.trim();
    }
    // 秘密字段：undefined 表示「保持不变」，因此不会因为面板回传掩码而覆盖真值
    if (input.appCertificate !== undefined) {
      this.assertNonEmpty(input.appCertificate, 'appCertificate');
      fields.appCertificateEnc = this.crypto.encrypt(input.appCertificate);
    }
    if (input.customerId !== undefined) {
      fields.customerId = input.customerId?.trim() || null;
    }
    if (input.customerSecret !== undefined) {
      this.assertNonEmpty(input.customerSecret, 'customerSecret');
      fields.customerSecretEnc = this.crypto.encrypt(input.customerSecret);
    }
    if (input.enabled !== undefined) fields.enabled = input.enabled ? 1 : 0;
    if (input.priority !== undefined) {
      this.assertPriority(input.priority);
      fields.priority = input.priority;
    }
    if (input.tokenExpireSec !== undefined) {
      this.assertTokenExpire(input.tokenExpireSec);
      fields.tokenExpireSec = input.tokenExpireSec;
    }
    if (input.monthlyQuotaStandardMinutes !== undefined) {
      this.assertQuota(input.monthlyQuotaStandardMinutes);
      fields.monthlyQuotaStandardMinutes = input.monthlyQuotaStandardMinutes;
    }
    if (input.quotaEnforced !== undefined) fields.quotaEnforced = input.quotaEnforced ? 1 : 0;
    if (input.allowedPresetIds !== undefined) {
      fields.allowedPresetIds = input.allowedPresetIds ? JSON.stringify(input.allowedPresetIds) : null;
    }
    if (input.note !== undefined) fields.note = input.note;

    this.db.updateProvider(id, fields);
    const updated = this.db.getProvider(id)!;
    return this.toAdminView(updated);
  }

  /**
   * 删除 Provider。
   *
   * 已被会话引用的 Provider **不允许删除**：历史会话的 `provider_id` 会变成悬空引用，
   * 用量账本与故障排查都会失去依据。要停用请改为 `enabled = false`。
   */
  remove(id: string): { ok: boolean; message?: string } {
    if (!this.db.getProvider(id)) {
      return { ok: false, message: 'Provider 不存在' };
    }
    const bound = this.db.countSessionsByProvider(id);
    if (bound > 0) {
      return {
        ok: false,
        message: `该 Provider 已被 ${bound} 个会话引用，不能删除。如需停止使用请改为「停用」。`,
      };
    }
    this.db.deleteProvider(id);
    this.logger.log(`Deleted Agora provider ${id}`);
    return { ok: true };
  }

  /** 记录一次成功使用，供「最后使用时间」展示与用量归属。 */
  markUsed(id: string): void {
    this.db.updateProvider(id, { lastUsedAt: Date.now() });
  }

  // ===== 视图转换 =====

  private toAdminView(record: AgoraProviderRecord): AgoraProviderAdminView {
    return {
      id: record.id,
      ownerType: record.ownerType,
      ownerId: record.ownerId,
      name: record.name,
      appId: record.appId,
      hasAppCertificate: !!record.appCertificateEnc,
      customerId: record.customerId,
      hasCustomerSecret: !!record.customerSecretEnc,
      enabled: !!record.enabled,
      priority: record.priority,
      tokenExpireSec: record.tokenExpireSec,
      healthStatus: record.healthStatus,
      healthCheckedAt: record.healthCheckedAt,
      healthMessage: record.healthMessage,
      monthlyQuotaStandardMinutes: record.monthlyQuotaStandardMinutes,
      quotaEnforced: !!record.quotaEnforced,
      estimatedUsageStandardMinutes: record.estimatedUsageStandardMinutes,
      usagePeriodKey: record.usagePeriodKey,
      lastUsedAt: record.lastUsedAt,
      allowedPresetIds: this.parsePresetIds(record.allowedPresetIds),
      note: record.note,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private parsePresetIds(raw: string | null): string[] | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : null;
    } catch {
      this.logger.warn('Invalid allowed_preset_ids JSON; treating as unrestricted');
      return null;
    }
  }

  // ===== 校验 =====

  private assertValidCreate(input: AgoraProviderCreateRequest): void {
    if (!OWNER_TYPES.includes(input.ownerType)) {
      throw new AgoraProviderValidationError(
        'INVALID_OWNER_TYPE',
        `ownerType 必须是 ${OWNER_TYPES.join(' / ')} 之一`,
      );
    }
    // platform 属于全局池，没有归属对象；space / user 必须指明归属
    if (input.ownerType === 'platform') {
      if (input.ownerId) {
        throw new AgoraProviderValidationError(
          'INVALID_OWNER_ID',
          'ownerType=platform 时不应指定 ownerId',
        );
      }
    } else if (!input.ownerId?.trim()) {
      throw new AgoraProviderValidationError(
        'INVALID_OWNER_ID',
        `ownerType=${input.ownerType} 时必须指定 ownerId`,
      );
    }

    this.assertNonEmpty(input.name, 'name');
    this.assertAppId(input.appId);
    this.assertNonEmpty(input.appCertificate, 'appCertificate');
    if (input.priority !== undefined) this.assertPriority(input.priority);
    if (input.tokenExpireSec !== undefined) this.assertTokenExpire(input.tokenExpireSec);
    if (input.monthlyQuotaStandardMinutes !== undefined) {
      this.assertQuota(input.monthlyQuotaStandardMinutes);
    }
  }

  private normalizeOwnerId(ownerType: AgoraProviderOwnerType, ownerId?: string): string {
    return ownerType === 'platform' ? '' : (ownerId ?? '').trim();
  }

  private assertNonEmpty(value: string, field: string): void {
    if (!value || !value.trim()) {
      throw new AgoraProviderValidationError('EMPTY_FIELD', `${field} 不能为空`);
    }
  }

  /**
   * App ID 校验刻意宽松：只要求非空、长度合理、不含空白。
   * 声网 App ID 目前是 32 位十六进制，但格式并非我们的契约，
   * 过严会在声网调整格式时误拒合法凭证。
   */
  private assertAppId(appId: string): void {
    const value = (appId ?? '').trim();
    if (!value) {
      throw new AgoraProviderValidationError('EMPTY_FIELD', 'appId 不能为空');
    }
    if (value.length > 64 || /\s/.test(value)) {
      throw new AgoraProviderValidationError('INVALID_APP_ID', 'appId 格式不合法');
    }
  }

  private assertPriority(priority: number): void {
    if (!Number.isInteger(priority) || priority < 0 || priority > 100000) {
      throw new AgoraProviderValidationError('INVALID_PRIORITY', 'priority 必须是不小于 0 的整数');
    }
  }

  private assertTokenExpire(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < MIN_TOKEN_EXPIRE_SEC || seconds > MAX_TOKEN_EXPIRE_SEC) {
      throw new AgoraProviderValidationError(
        'INVALID_TOKEN_EXPIRE',
        `tokenExpireSec 必须是 ${MIN_TOKEN_EXPIRE_SEC}~${MAX_TOKEN_EXPIRE_SEC} 之间的整数`,
      );
    }
  }

  private assertQuota(minutes: number | null): void {
    // null = 不限量，合法
    if (minutes === null) return;
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new AgoraProviderValidationError(
        'INVALID_QUOTA',
        'monthlyQuotaStandardMinutes 必须为正数，或留空表示不限量',
      );
    }
  }
}
