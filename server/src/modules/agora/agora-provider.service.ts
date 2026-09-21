import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RtcRole, RtcTokenBuilder } from 'agora-token';
import { randomUUID } from 'crypto';
import {
  AgoraProviderHealthStatus,
  AgoraProviderOwnerType,
  AgoraProviderRecord,
  DatabaseService,
} from '../database/database.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { DEFAULT_USAGE_TIMEZONE, evaluateQuota } from './provider-quota';

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

/**
 * Provider 入参校验失败。
 *
 * 直接继承 `BadRequestException`，这样任何 controller 抛出来都会自动变成
 * 带 `{message, code}` 的 400，无需在每个接口里写 try/catch。
 */
export class AgoraProviderValidationError extends BadRequestException {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super({ message, code });
    this.name = 'AgoraProviderValidationError';
  }
}

/** Provider 解析失败的原因。 */
export type ProviderResolutionFailureCode = 'NO_PROVIDER' | 'NOT_AUTHORIZED' | 'QUOTA_EXCEEDED';

/** 命中的解析层级，便于排查「这个会话为什么用了那个 Provider」。 */
export type ProviderResolutionReason = 'explicit' | 'space-default' | 'user-byok' | 'platform-pool';

export interface ResolveProviderInput {
  /** KOOK 服务器 ID（`servers.server_id`） */
  serverId: string;
  /** 分享者 KOOK 用户 ID，用于 BYOK 归属匹配 */
  sharerUserId: string;
  /** 手动指定的 Provider */
  requestedProviderId?: string;
  /** 调用者是否被允许显式指定 Provider（管理员为 true，普通用户为 false） */
  allowExplicitSelection?: boolean;
  /** 计费周期时区，默认 `Asia/Shanghai` */
  timeZone?: string;
}

/**
 * Provider 解析结果。
 *
 * ⚠️ 判别字段用**字符串字面量**而不是布尔 `ok`：本仓库 `strictNullChecks: false`，
 * 布尔字面量类型会被放宽为 `boolean`，导致 TS 无法对联合类型做判别收窄
 * （`if (!result.ok)` 之后拿不到失败分支的 `code`）。
 */
export type ProviderResolution =
  | { status: 'ok'; provider: AgoraProviderRecord; reason: ProviderResolutionReason }
  | { status: 'failed'; code: ProviderResolutionFailureCode; message: string };

type UsabilityCheck =
  | { status: 'ok' }
  | { status: 'failed'; code: ProviderResolutionFailureCode; message: string };

/** 一次健康检查的结果。 */
export interface ProviderHealthOutcome {
  providerId: string;
  status: AgoraProviderHealthStatus;
  message: string;
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
    this.adoptLegacyServerCredentials();
    // 启动时先探一次，让管理面板立刻有健康状态可看。
    // 离线检查是纯本地 HMAC 计算，不产生任何声网调用或计费。
    this.checkAllHealth();
  }

  // ===== 健康检查 =====

  /**
   * 单个 Provider 的**离线**健康检查。
   *
   * 判定逻辑：能解密证书 + 能用它签出一个 Token ⇒ healthy。
   * 两者都是本地计算（AES-GCM 解密 + HMAC 签名），**不产生任何声网侧调用与计费**。
   *
   * 声网没有「免费验证 App ID 是否可用」的接口，所以：
   * - 这里能覆盖「证书配错了 / 主密钥不匹配 / 字段为空」这类最常见的问题；
   * - 覆盖不到「账号欠费 / 项目被停用」——那需要调用官方 RESTful API（需 Customer ID/Secret），
   *   留待后续按需接入；真实 RTC join 探针会产生真实计费，只应手动触发。
   *
   * 已停用的 Provider 跳过检查，避免给面板制造无意义告警。
   */
  checkHealth(providerId: string): ProviderHealthOutcome {
    const provider = this.db.getProvider(providerId);
    if (!provider) {
      return { providerId, status: 'unknown', message: 'Provider 不存在' };
    }
    if (!provider.enabled) {
      return { providerId, status: provider.healthStatus, message: provider.healthMessage };
    }

    let status: AgoraProviderHealthStatus;
    let message: string;

    if (!provider.appCertificateEnc) {
      status = 'unhealthy';
      message = '未配置 App Certificate';
    } else {
      try {
        const withSecrets = this.getWithSecrets(providerId)!;
        const now = Math.floor(Date.now() / 1000);
        const probe = RtcTokenBuilder.buildTokenWithUid(
          provider.appId,
          withSecrets.appCertificate,
          'cb_healthcheck',
          1,
          RtcRole.PUBLISHER,
          now + 60,
          now + 60,
        );
        if (!probe) {
          // ⚠️ agora-token 在 App Certificate 长度不合法（声网要求 32 字符）时
          // **不抛错，而是返回空串**。只靠 try/catch 会把这种情况误判为健康。
          status = 'unhealthy';
          message = 'App Certificate 长度不合法（声网要求 32 字符），无法签发 Token';
        } else {
          status = 'healthy';
          message = '';
        }
      } catch {
        // 不回显底层错误：它的信息可能含密文片段。只给出可操作的原因。
        status = 'unhealthy';
        message = 'App ID 或 App Certificate 不可用（无法签发 Token）';
      }
    }

    this.db.updateProvider(providerId, {
      healthStatus: status,
      healthCheckedAt: Date.now(),
      healthMessage: message,
    });
    return { providerId, status, message };
  }

  checkAllHealth(): ProviderHealthOutcome[] {
    return this.db.listProviders().map((provider) => this.checkHealth(provider.id));
  }

  /** 定时离线健康检查。30 分钟一次，全程免费。 */
  @Interval(30 * 60 * 1000)
  scheduledHealthCheck(): void {
    const results = this.checkAllHealth();
    const unhealthy = results.filter((outcome) => outcome.status === 'unhealthy');
    if (unhealthy.length > 0) {
      this.logger.warn(
        `Health check: ${unhealthy.length}/${results.length} provider(s) unhealthy: ` +
          unhealthy.map((o) => `${o.providerId}(${o.message})`).join(', '),
      );
    }
  }

  /**
   * 把存量「每服务器一份明文 Agora 配置」迁移成 `owner_type='space'` 的 Provider 行。
   *
   * 为什么放在这里而不是 migration：
   * - 需要加密服务，而 migration 是纯 DB 函数，不应依赖运行时服务；
   * - 未配置主密钥时必须能安全跳过（没有密钥就无法加密），migration 没有这种条件语义。
   *
   * 幂等：同 `ownerId` 已存在 space Provider 就跳过，因此每次启动重复执行是安全的。
   *
   * 迁移完成后会**清空** `servers.agora_app_certificate`（秘密不得明文落盘）。
   * 该列自 Phase 1-3 起已无任何消费者，且已从 `ALLOWED_SERVER_COLS` 移除，
   * 因此不存在「清空后旧路径读不到证书」的风险。
   */
  private adoptLegacyServerCredentials(): void {
    const candidates = this.db.listServersWithPlaintextCredentials();
    if (candidates.length === 0) return;

    if (!this.crypto.isConfigured) {
      this.logger.warn(
        `${candidates.length} server(s) still hold plaintext Agora credentials, but the ` +
          'encryption key is not configured, so they cannot be migrated. Set ' +
          'SECRET_ENCRYPTION_KEY and restart.',
      );
      return;
    }

    let adopted = 0;
    for (const server of candidates) {
      const existing = this.db.listProvidersByOwner('space', server.serverId);
      if (existing.length > 0) {
        // 上次已经迁移过，剩下的明文证书只是残留 —— 直接清掉，并补齐漏掉的会话回填。
        // 不做这一步的话，明文会永远留在库里（下次启动时该服务器已不在候选列表里）。
        this.db.backfillSessionsProvider(server.serverId, existing[0].id, existing[0].appId);
        this.db.clearServerCertificate(server.serverId);
        this.logger.log(
          `Cleared residual plaintext Agora certificate of server ${server.serverId} ` +
            `(provider ${existing[0].id} already holds it encrypted)`,
        );
        continue;
      }

      try {
        const provider = this.create({
          ownerType: 'space',
          ownerId: server.serverId,
          // 服务器名可能为空，此时回退到 serverId，避免校验失败打断启动
          name: `${server.guildName?.trim() || server.serverId} 自带凭证`,
          appId: server.agoraAppId,
          appCertificate: server.agoraAppCertificate,
          // 存量值可能不在合法区间内，夹取而不是抛错，避免一个坏配置卡住整个启动
          tokenExpireSec: this.clampTokenExpire(server.agoraTokenExpireSec),
          note: '由存量服务器配置自动迁移',
        });

        const backfilled = this.db.backfillSessionsProvider(
          server.serverId,
          provider.id,
          server.agoraAppId,
        );
        // 证书已加密存进 Provider，清掉服务器上的明文。
        // 这一步必须在 Token 签发切到 Provider 之后（同一 commit），否则旧路径会读不到证书。
        this.db.clearServerCertificate(server.serverId);

        adopted += 1;
        this.logger.log(
          `Adopted legacy Agora credentials of server ${server.serverId} as provider ` +
            `${provider.id} (backfilled ${backfilled} session(s), plaintext cleared)`,
        );
      } catch (error) {
        // 单个服务器的坏数据不应阻止应用启动，其余服务器仍应完成迁移
        this.logger.error(
          `Failed to adopt legacy Agora credentials of server ${server.serverId}: ` +
            `${(error as Error).message}`,
        );
      }
    }

    if (adopted > 0) {
      this.logger.log(`Adopted ${adopted} legacy Agora credential set(s) into the provider pool`);
    }
  }

  private clampTokenExpire(value: number | undefined): number {
    if (!Number.isFinite(value)) return 3600;
    return Math.min(MAX_TOKEN_EXPIRE_SEC, Math.max(MIN_TOKEN_EXPIRE_SEC, Math.floor(value as number)));
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

  // ===== 会话创建时的 Provider 解析 =====

  /**
   * 为一个新会话选定 Provider。
   *
   * 解析优先级（逐级回退，任一级命中即返回）：
   * 1. **显式指定** —— 手动选择。必须校验调用者有权使用该 Provider。
   * 2. **服务器默认** `owner_type='space'` 且属于该 serverId
   * 3. **用户自带** `owner_type='user'` 且属于该 sharerUserId（BYOK）
   * 4. **平台池** `owner_type='platform'`，按 priority 升序
   *
   * 全部不可用时返回失败码，**绝不静默回退到任意 App ID** —— 那会让观众被发到
   * 一个与分享者不同的声网项目，且完全没有报错。
   */
  resolveForSession(input: ResolveProviderInput): ProviderResolution {
    const timeZone = input.timeZone ?? DEFAULT_USAGE_TIMEZONE;

    // 1. 显式指定
    if (input.requestedProviderId) {
      const provider = this.db.getProvider(input.requestedProviderId);
      if (!provider) {
        return { status: 'failed', code: 'NO_PROVIDER', message: '指定的声网 Provider 不存在' };
      }
      if (!this.isAuthorizedFor(provider, input)) {
        return { status: 'failed', code: 'NOT_AUTHORIZED', message: '无权使用该声网 Provider' };
      }
      const check = this.checkUsable(provider, timeZone);
      if (check.status === 'failed') return check;
      return { status: 'ok', provider, reason: 'explicit' };
    }

    // 2 / 3 / 4. 按候选组依次尝试
    const groups: { reason: ProviderResolutionReason; list: AgoraProviderRecord[] }[] = [
      { reason: 'space-default', list: this.db.listProvidersByOwner('space', input.serverId) },
      { reason: 'user-byok', list: this.db.listProvidersByOwner('user', input.sharerUserId) },
      { reason: 'platform-pool', list: this.db.listProvidersByOwner('platform', '') },
    ];

    let sawQuotaExceeded = false;
    for (const group of groups) {
      for (const provider of group.list) {
        const check = this.checkUsable(provider, timeZone);
        if (check.status === 'ok') return { status: 'ok', provider, reason: group.reason };
        if (check.code === 'QUOTA_EXCEEDED') sawQuotaExceeded = true;
      }
    }

    if (sawQuotaExceeded) {
      return {
        status: 'failed',
        code: 'QUOTA_EXCEEDED',
        message: '所有可用的声网 Provider 均已达到本月配额上限，请稍后再试或联系管理员',
      };
    }
    return {
      status: 'failed',
      code: 'NO_PROVIDER',
      message:
        '该服务器尚未配置可用的声网 Provider，请让服务器管理员先配置 App ID 与 App Certificate',
    };
  }

  /** 显式指定 Provider 时的权限校验。 */
  private isAuthorizedFor(provider: AgoraProviderRecord, input: ResolveProviderInput): boolean {
    switch (provider.ownerType) {
      case 'platform':
        // 平台池属于全体用户共享的资源，只有管理员能显式指定
        return input.allowExplicitSelection === true;
      case 'space':
        return provider.ownerId === input.serverId;
      case 'user':
        return provider.ownerId === input.sharerUserId;
      default:
        return false;
    }
  }

  /** Provider 当前是否可用于新会话。 */
  private checkUsable(provider: AgoraProviderRecord, timeZone: string): UsabilityCheck {
    if (!provider.enabled) {
      return { status: 'failed', code: 'NO_PROVIDER', message: `声网 Provider「${provider.name}」已停用` };
    }
    if (provider.healthStatus === 'unhealthy') {
      return {
        status: 'failed',
        code: 'NO_PROVIDER',
        message: `声网 Provider「${provider.name}」健康检查未通过`,
      };
    }
    if (!provider.appCertificateEnc) {
      return {
        status: 'failed',
        code: 'NO_PROVIDER',
        message: `声网 Provider「${provider.name}」未配置 App Certificate`,
      };
    }
    if (evaluateQuota(provider, timeZone).exceeded) {
      return {
        status: 'failed',
        code: 'QUOTA_EXCEEDED',
        message: `声网 Provider「${provider.name}」已达到本月配额上限`,
      };
    }
    return { status: 'ok' };
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
