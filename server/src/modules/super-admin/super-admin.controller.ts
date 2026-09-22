import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import * as bcrypt from 'bcryptjs';
import { createHmac } from 'crypto';
import { AgoraProviderService } from '../agora/agora-provider.service';
import { QualityConfigService } from '../quality/quality-config.service';
import { QualityPresetService } from '../quality/quality-preset.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { UsageLedgerService } from '../usage/usage-ledger.service';
import {
  CreateAgoraProviderDto,
  UpdateAgoraProviderDto,
} from '../agora/agora-provider.dto';
import {
  CreateQualityPresetDto,
  UpdateQualityPresetDto,
} from './super-admin.dto';
import {
  SuperAdminLoginDto,
  UpdateGlobalConfigDto,
  UpdateServerDto,
} from './super-admin.dto';
import { QUALITY_PRESETS, type QualityBitrateConfig } from '../session/session.types';

/** 用户 ID 脱敏：保留首 3 位和末 4 位 */
function maskUserId(uid: string): string {
  if (!uid || uid.length <= 7) return uid;
  return uid.slice(0, 3) + '****' + uid.slice(-4);
}

@Controller('api/super')
export class SuperAdminController {
  private superPasswordHash: string;
  private readonly tokenSecret: string;
  private readonly tokenTtlSec = 7 * 24 * 3600;

  constructor(
    private readonly db: DatabaseService,
    private readonly providers: AgoraProviderService,
    private readonly qualityConfig: QualityConfigService,
    private readonly usage: UsageLedgerService,
    private readonly presets: QualityPresetService,
    private readonly crypto: SecretCryptoService,
  ) {
    const pwd = process.env.SUPER_ADMIN_PASSWORD!;
    this.superPasswordHash = bcrypt.hashSync(pwd, 10);
    this.tokenSecret = pwd;
  }

  // ===== Auth =====

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: SuperAdminLoginDto) {
    if (!bcrypt.compareSync(dto.password, this.superPasswordHash)) {
      return { ok: false, message: '密码错误' };
    }
    const payload = { role: 'super_admin', exp: Math.floor(Date.now() / 1000) + this.tokenTtlSec };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', this.tokenSecret).update(body).digest('base64url');
    return { ok: true, token: body + '.' + sig };
  }

  // ===== Global Config =====

  @Get('config')
  getConfig() {
    const cfg = this.db.getGlobalConfig();
    // 费率展示必须读**可配置的** quality_config，否则面板会显示过期费率：
    // 系数与单价自 Phase 2-3 起不再来自硬编码表，改配置后这里要跟着变。
    const billing = this.qualityConfig.get();
    const price = billing.standardMinutePrice;
    const hourlyRate = (coefficient: number) => coefficient * price * 60;

    return {
      kookBotToken: cfg.kookBotToken ? '******' : '',
      kookVerifyToken: cfg.kookVerifyToken ? '******' : '',
      kookEncryptKey: cfg.kookEncryptKey ? '******' : '',
      publicDomain: cfg.publicDomain,
      triggerWordLabels: cfg.triggerWordLabels,
      qualityBitrates: cfg.qualityBitrates,
      qualityProfiles: QUALITY_PRESETS.map((quality) => {
        const rule = this.qualityConfig.tierRuleFor(quality.width, quality.height);
        return {
          key: quality.key,
          label: quality.label,
          width: quality.width,
          height: quality.height,
          frameRate: quality.frameRate,
          tier: rule.tier,
          interactiveViewerHourlyRate: hourlyRate(rule.interactive),
          liveViewerHourlyRate: hourlyRate(rule.ultraLowLatency),
        };
      }),
      broadcasterHourlyRate: hourlyRate(billing.audioCoefficients.broadcaster),
      standardMinutePrice: price,
    };
  }

  @Put('config')
  updateConfig(@Body() dto: UpdateGlobalConfigDto) {
    // 掩码表示「不修改」。明文经加密后落库（没有主密钥时抛错，绝不静默存明文）。
    if (dto.kookBotToken !== undefined && dto.kookBotToken !== '******') {
      this.crypto.setGlobalSecret('kookBotToken', dto.kookBotToken);
    }
    if (dto.kookVerifyToken !== undefined && dto.kookVerifyToken !== '******') {
      this.crypto.setGlobalSecret('kookVerifyToken', dto.kookVerifyToken);
    }
    if (dto.kookEncryptKey !== undefined && dto.kookEncryptKey !== '******') {
      this.crypto.setGlobalSecret('kookEncryptKey', dto.kookEncryptKey);
    }
    if (dto.publicDomain !== undefined) {
      this.db.setGlobalConfig('publicDomain', dto.publicDomain);
    }
    if (dto.qualityBitrates !== undefined) {
      const sanitized = this.sanitizeQualityBitrates(dto.qualityBitrates);
      this.db.setGlobalConfig('qualityBitrates', JSON.stringify(sanitized));
    }
    if (dto.triggerWordLabels !== undefined) {
      const labels = [...new Set(dto.triggerWordLabels.map(word => word.trim()).filter(Boolean))];
      if (labels.length === 0) throw new BadRequestException('至少保留一个触发词标签');
      this.db.setTriggerWordLabels(labels);
    }
    return { ok: true };
  }

  private sanitizeQualityBitrates(input: QualityBitrateConfig): QualityBitrateConfig {
    const result: QualityBitrateConfig = {};
    for (const quality of QUALITY_PRESETS) {
      const value = input[quality.key] || {};
      const bitrateMin = value.bitrateMin;
      const bitrateMax = value.bitrateMax;
      for (const [name, bitrate] of Object.entries({ bitrateMin, bitrateMax })) {
        if (bitrate !== undefined && (!Number.isFinite(bitrate) || bitrate <= 0)) {
          throw new BadRequestException(`${quality.label} 的 ${name} 必须为正数或留空`);
        }
      }
      if (bitrateMin !== undefined && bitrateMax !== undefined && bitrateMax < bitrateMin) {
        throw new BadRequestException(`${quality.label} 的最高码率不能低于最低码率`);
      }
      result[quality.key] = {
        ...(bitrateMin !== undefined ? { bitrateMin } : {}),
        ...(bitrateMax !== undefined ? { bitrateMax } : {}),
      };
    }
    return result;
  }

  // ===== Server Management =====

  @Get('spaces')
  listSpaces(@Query('platform') platform?: string) {
    return this.db.listSpaces(platform || undefined).map((s) => ({
      spaceId: s.serverId,
      platform: s.platform,
      externalId: s.externalId,
      serverId: s.externalId,
      openId: s.openId,
      guildName: s.guildName,
      ownerId: s.ownerId,
      ownerUsername: s.ownerUsername,
      bound: !!s.bound,
      status: s.status,
      agoraAppId: s.agoraAppId ? '******' : '',
      createdAt: s.createdAt,
    }));
  }

  @Get('spaces/:platform/:externalId')
  getSpace(
    @Param('platform') platform: string,
    @Param('externalId') externalId: string,
  ) {
    const s = this.db.getSpace(platform, externalId);
    if (!s) return { ok: false, message: '平台空间不存在' };
    return {
      spaceId: s.serverId,
      platform: s.platform,
      externalId: s.externalId,
      serverId: s.externalId,
      openId: s.openId,
      guildName: s.guildName,
      ownerId: s.ownerId,
      ownerUsername: s.ownerUsername,
      bound: !!s.bound,
      status: s.status,
      agoraAppId: s.agoraAppId,
      agoraAppCertificate: s.agoraAppCertificate ? '******' : '',
      agoraTokenExpireSec: s.agoraTokenExpireSec,
      allowedQualities: JSON.parse(s.allowedQualities),
      enabledTriggerWords: s.triggerWords.split(',').map(word => word.trim()).filter(Boolean),
      triggerWordLabels: this.db.getGlobalConfig().triggerWordLabels,
      idleTimeoutSec: s.idleTimeoutSec,
      heartbeatIntervalSec: s.heartbeatIntervalSec,
      noViewerTimeoutSec: s.noViewerTimeoutSec,
      publicDomain: this.db.getGlobalConfig().publicDomain,
      allowLowLatency: s.allowLowLatency,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  @Get('spaces/:platform/:externalId/events')
  getSpaceEvents(
    @Param('platform') platform: string,
    @Param('externalId') externalId: string,
  ) {
    const space = this.db.getSpace(platform, externalId);
    return space ? this.db.getServerEvents(space.serverId) : [];
  }

  @Get('spaces/:platform/:externalId/sessions')
  getSpaceSessions(
    @Param('platform') platform: string,
    @Param('externalId') externalId: string,
  ) {
    const space = this.db.getSpace(platform, externalId);
    if (!space) return [];
    return this.db.getSessionsByServer(space.serverId).map(s => ({
      ...s,
      sharerUserId: maskUserId(s.sharerUserId),
    }));
  }

  @Put('spaces/:platform/:externalId')
  updateSpace(
    @Param('platform') platform: string,
    @Param('externalId') externalId: string,
    @Body() dto: UpdateServerDto,
  ) {
    const space = this.db.getSpace(platform, externalId);
    if (!space) return { ok: false, message: '平台空间不存在' };
    return this.updateServer(space.serverId, dto);
  }

  @Delete('spaces/:platform/:externalId')
  deleteSpace(
    @Param('platform') platform: string,
    @Param('externalId') externalId: string,
  ) {
    const space = this.db.getSpace(platform, externalId);
    if (!space) return { ok: false, message: '平台空间不存在' };
    this.db.deleteServer(space.serverId);
    return { ok: true };
  }

  @Get('servers')
  listServers() {
    const servers = this.db.listServers();
    return servers.map((s) => ({
      serverId: s.serverId,
      openId: s.openId,
      guildName: s.guildName,
      ownerId: s.ownerId,
      ownerUsername: s.ownerUsername,
      bound: !!s.bound,
      status: s.status,
      agoraAppId: s.agoraAppId ? '******' : '',
      createdAt: s.createdAt,
    }));
  }

  @Get('servers/:id')
  getServer(@Param('id') id: string) {
    const s = this.db.getServer(id);
    if (!s) return { ok: false, message: '服务器不存在' };
    return {
      serverId: s.serverId,
      openId: s.openId,
      guildName: s.guildName,
      ownerId: s.ownerId,
      ownerUsername: s.ownerUsername,
      bound: !!s.bound,
      status: s.status,
      agoraAppId: s.agoraAppId,
      agoraAppCertificate: s.agoraAppCertificate ? '******' : '',
      agoraTokenExpireSec: s.agoraTokenExpireSec,
      allowedQualities: JSON.parse(s.allowedQualities),
      enabledTriggerWords: s.triggerWords.split(',').map(word => word.trim()).filter(Boolean),
      triggerWordLabels: this.db.getGlobalConfig().triggerWordLabels,
      idleTimeoutSec: s.idleTimeoutSec,
      heartbeatIntervalSec: s.heartbeatIntervalSec,
      noViewerTimeoutSec: s.noViewerTimeoutSec,
      publicDomain: this.db.getGlobalConfig().publicDomain,
      allowLowLatency: s.allowLowLatency,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  @Get('servers/:id/events')
  getServerEvents(@Param('id') id: string) {
    return this.db.getServerEvents(id);
  }

  @Get('servers/:id/sessions')
  getServerSessions(@Param('id') id: string) {
    return this.db.getSessionsByServer(id).map(s => ({
      ...s,
      sharerUserId: maskUserId(s.sharerUserId),
    }));
  }

  @Put('servers/:id')
  updateServer(@Param('id') id: string, @Body() dto: UpdateServerDto) {
    const s = this.db.getServer(id);
    if (!s) return { ok: false, message: '服务器不存在' };

    const updates: any = {};
    // Agora 凭证自 Phase 1 起由 Provider 管理（见 /api/super/providers）。
    // 这里刻意不再接受 agoraAppId / agoraAppCertificate / agoraTokenExpireSec：
    // 否则服务器记录上会存在一条**明文**证书写入路径，而签发 Token 根本不会读它。
    if (dto.allowedQualities !== undefined) {
      const validKeys = new Set(QUALITY_PRESETS.map(quality => quality.key));
      const allowed = [...new Set(dto.allowedQualities.filter(key => validKeys.has(key)))];
      if (allowed.length === 0) throw new BadRequestException('至少开放一个有效画质');
      updates.allowedQualities = JSON.stringify(allowed);
    }
    if (dto.enabledTriggerWords !== undefined) {
      const allowed = new Set(this.db.getGlobalConfig().triggerWordLabels);
      const enabled = [...new Set(dto.enabledTriggerWords.map(word => word.trim()).filter(word => allowed.has(word)))];
      if (enabled.length === 0) throw new BadRequestException('至少启用一个触发词标签');
      updates.triggerWords = enabled.join(',');
    }
    if (dto.idleTimeoutSec !== undefined) updates.idleTimeoutSec = dto.idleTimeoutSec;
    if (dto.heartbeatIntervalSec !== undefined) updates.heartbeatIntervalSec = dto.heartbeatIntervalSec;
    if (dto.noViewerTimeoutSec !== undefined) updates.noViewerTimeoutSec = dto.noViewerTimeoutSec;
    if (dto.allowLowLatency !== undefined) updates.allowLowLatency = dto.allowLowLatency;

    this.db.updateServer(id, updates);
    return { ok: true };
  }

  @Delete('servers/:id')
  deleteServer(@Param('id') id: string) {
    const s = this.db.getServer(id);
    if (!s) return { ok: false, message: '服务器不存在' };
    this.db.deleteServer(id);
    return { ok: true };
  }

  // ===== Sessions =====

  @Get('sessions')
  listAllSessions() {
    return this.db.getAllSessions().map(s => ({
      ...s,
      sharerUserId: maskUserId(s.sharerUserId),
    }));
  }

  @Get('sessions/server/:serverId')
  listServerSessions(@Param('serverId') serverId: string) {
    return this.db.getSessionsByServer(serverId).map(s => ({
      ...s,
      sharerUserId: maskUserId(s.sharerUserId),
    }));
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  deleteSession(@Param('id') id: string) {
    const ok = this.db.deleteSession(id);
    return { ok };
  }

  // ===== Agora Providers =====
  //
  // 所有响应都走 `AgoraProviderAdminView`，只包含 `hasAppCertificate` /
  // `hasCustomerSecret` 布尔值。明文凭证**没有任何接口可以读回**，
  // 只能由 Token 签发与健康检查在服务端内部使用。

  @Get('providers')
  listProviders() {
    return this.providers.listForAdmin();
  }

  @Get('providers/:id')
  getProvider(@Param('id') id: string) {
    const provider = this.providers.getForAdmin(id);
    if (!provider) return { ok: false, message: 'Provider 不存在' };
    return provider;
  }

  @Post('providers')
  @HttpCode(HttpStatus.OK)
  createProvider(@Body() dto: CreateAgoraProviderDto) {
    return { ok: true, provider: this.providers.create(this.toCreateRequest(dto)) };
  }

  @Put('providers/:id')
  updateProvider(@Param('id') id: string, @Body() dto: UpdateAgoraProviderDto) {
    const updated = this.providers.update(id, dto);
    if (!updated) return { ok: false, message: 'Provider 不存在' };
    return { ok: true, provider: updated };
  }

  @Delete('providers/:id')
  removeProvider(@Param('id') id: string) {
    return this.providers.remove(id);
  }

  // ===== 用量看板 =====

  /**
   * Provider 用量看板。
   *
   * `period` 省略时为当前计费周期（时区取自 `quality_config`）。
   * 数据来自 `provider_usage_monthly`，由定时任务从账本重算；
   * 事实来源始终是 `usage_intervals`。
   */
  @Get('usage')
  getUsage(@Query('period') period?: string) {
    const rows = this.usage.getUsageDashboard(period);
    return {
      period: rows.length > 0 ? rows[0].periodKey : (period ?? ''),
      timezone: this.qualityConfig.getUsageTimezone(),
      rows,
    };
  }

  /** 手动触发一次汇总（改完配置或排查时用，不必等定时任务）。 */
  @Post('usage/rebuild')
  @HttpCode(HttpStatus.OK)
  rebuildUsage(@Query('period') period?: string) {
    const key = period ?? this.usage.resolvePeriodKey();
    this.usage.rebuildMonthlyRollup(key);
    return { ok: true, period: key };
  }

  /** 单个会话的账本明细（看板下钻）。 */
  @Get('usage/sessions/:sessionId')
  getSessionUsage(@Param('sessionId') sessionId: string) {
    return this.usage.getSessionUsage(sessionId);
  }

  // ===== 画质预设（Phase 3）=====

  /** 全部预设（含停用），按 sort_order 升序。附带计费档位，便于核对每档怎么计费。 */
  @Get('qualities')
  listQualities() {
    return this.presets.list().map((preset) => ({
      id: preset.id,
      label: preset.label,
      width: preset.width,
      height: preset.height,
      frameRate: preset.frameRate,
      bitrateMin: preset.bitrateMin,
      bitrateMax: preset.bitrateMax,
      optimizationMode: preset.optimizationMode,
      codec: preset.codec,
      enabled: preset.enabled,
      isBuiltin: preset.isBuiltin,
      sortOrder: preset.sortOrder,
      tier: this.qualityConfig.tierRuleFor(preset.width, preset.height).tier,
    }));
  }

  /**
   * 新增画质预设。
   *
   * `id` 一旦写入不可改 —— 它被 `servers.allowed_qualities` 与存量会话引用。
   */
  @Post('qualities')
  @HttpCode(HttpStatus.OK)
  createQuality(@Body() dto: CreateQualityPresetDto) {
    return { ok: true, preset: this.presets.create(dto) };
  }

  /** 更新预设参数。id 不可改。 */
  @Put('qualities/:id')
  updateQuality(@Param('id') id: string, @Body() dto: UpdateQualityPresetDto) {
    const updated = this.presets.update(id, dto);
    if (!updated) return { ok: false, message: '画质预设不存在' };
    return { ok: true, preset: updated };
  }

  /** 删除预设。内置或被会话引用的不可删除 —— 要停用请用 update({ enabled: false })。 */
  @Delete('qualities/:id')
  removeQuality(@Param('id') id: string) {
    return this.presets.remove(id);
  }

  private toCreateRequest(dto: CreateAgoraProviderDto) {
    return {
      ownerType: dto.ownerType,
      ownerId: dto.ownerId,
      name: dto.name,
      appId: dto.appId,
      appCertificate: dto.appCertificate,
      customerId: dto.customerId ?? null,
      customerSecret: dto.customerSecret ?? null,
      enabled: dto.enabled,
      priority: dto.priority,
      tokenExpireSec: dto.tokenExpireSec,
      monthlyQuotaStandardMinutes: dto.monthlyQuotaStandardMinutes ?? null,
      quotaEnforced: dto.quotaEnforced,
      allowedPresetIds: dto.allowedPresetIds ?? null,
      note: dto.note,
    };
  }
}
