import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import * as bcrypt from 'bcryptjs';
import { createHmac } from 'crypto';
import { QUALITY_PRESETS } from '../session/session.types';
import { AgoraProviderService } from '../agora/agora-provider.service';
import {
  CreateSpaceProviderDto,
  UpdateSpaceProviderDto,
} from '../agora/agora-provider.dto';
import {
  ServerAdminLoginDto,
  UpdateServerConfigDto,
  BindServerDto,
} from './server-admin.dto';

@Controller('api')
export class ServerAdminController {
  private readonly tokenTtlSec = 7 * 24 * 3600;

  constructor(
    private readonly db: DatabaseService,
    private readonly providers: AgoraProviderService,
  ) {}

  private resolveSpace(params: Record<string, string>) {
    const platform = params.platform || 'kook';
    const externalId = params.externalId || params.serverId || '';
    return {
      platform,
      externalId,
      server: this.db.getSpace(platform, externalId),
    };
  }

  // ===== Auth =====

  /** Bind server: set password for the first time (called from KOOK card button) */
  @Post(['server/:serverId/bind', 'spaces/:platform/:externalId/bind'])
  @HttpCode(HttpStatus.OK)
  bindServer(@Param() params: Record<string, string>, @Body() dto: BindServerDto) {
    const { server } = this.resolveSpace(params);
    if (!server) return { ok: false, message: '服务器不存在' };
    if (server.bound) return { ok: false, message: '服务器已绑定' };

    // 校验绑定 token（未绑定时必须提供有效 token）
    if (!dto.token || !this.db.validateBindToken(server.serverId, dto.token)) {
      return { ok: false, message: '绑定链接无效或已过期，请在 KOOK 服务器内重新发送 /cbhelp 命令' };
    }

    const passwordHash = bcrypt.hashSync(dto.password, 10);
    this.db.updateServer(server.serverId, {
      passwordHash,
      bound: 1,
      reboundAt: Date.now(),
    });
    // 绑定成功后清空 token
    this.db.clearBindToken(server.serverId);
    return { ok: true, message: '绑定成功' };
  }

  /** Check if server is bound (for KOOK card flow) */
  @Get(['server/:serverId/status', 'spaces/:platform/:externalId/status'])
  getServerStatus(@Param() params: Record<string, string>, @Query('token') token?: string) {
    const { platform, externalId, server } = this.resolveSpace(params);
    if (!server) return { exists: false };
    const result: any = {
      exists: true,
      platform,
      externalId,
      bound: !!server.bound,
      guildName: server.guildName,
      openId: server.openId,
    };
    // 未绑定时校验绑定 token
    if (!server.bound) {
      if (!token) {
        result.tokenValid = false;
      } else {
        result.tokenValid = this.db.validateBindToken(server.serverId, token);
      }
    }
    return result;
  }

  /** Login to server admin panel */
  @Post(['server/:serverId/login', 'spaces/:platform/:externalId/login'])
  @HttpCode(HttpStatus.OK)
  login(@Param() params: Record<string, string>, @Body() dto: ServerAdminLoginDto) {
    const { platform, externalId, server } = this.resolveSpace(params);
    if (!server) return { ok: false, message: '服务器不存在' };
    if (!server.bound) return { ok: false, message: '服务器尚未绑定' };

    if (!bcrypt.compareSync(dto.password, server.passwordHash)) {
      return { ok: false, message: '密码错误' };
    }

    const payload = {
      role: 'space_admin',
      spaceId: server.serverId,
      platform,
      externalId,
      exp: Math.floor(Date.now() / 1000) + this.tokenTtlSec,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    // 使用每服务器独立的 HMAC 密钥签名
    const serverSecret = server.serverSecret || process.env.SUPER_ADMIN_PASSWORD!;
    const sig = createHmac('sha256', serverSecret).update(body).digest('base64url');
    return { ok: true, token: body + '.' + sig };
  }

  // ===== Server Config =====

  @Get(['server/:serverId/config', 'spaces/:platform/:externalId/config'])
  getConfig(@Param() params: Record<string, string>) {
    const { platform, externalId, server } = this.resolveSpace(params);
    if (!server) return { ok: false, message: '服务器不存在' };

    return {
      spaceId: server.serverId,
      serverId: externalId,
      platform,
      externalId,
      guildName: server.guildName,
      agoraAppId: server.agoraAppId,
      agoraAppCertificate: server.agoraAppCertificate ? '******' : '',
      agoraTokenExpireSec: server.agoraTokenExpireSec,
      allowedQualities: JSON.parse(server.allowedQualities),
      triggerWordLabels: this.db.getGlobalConfig().triggerWordLabels,
      enabledTriggerWords: server.triggerWords.split(',').map(word => word.trim()).filter(Boolean),
      idleTimeoutSec: server.idleTimeoutSec,
      heartbeatIntervalSec: server.heartbeatIntervalSec,
      noViewerTimeoutSec: server.noViewerTimeoutSec,
      publicDomain: this.db.getGlobalConfig().publicDomain,
      allowLowLatency: server.allowLowLatency,
    };
  }

  @Put(['server/:serverId/config', 'spaces/:platform/:externalId/config'])
  updateConfig(@Param() params: Record<string, string>, @Body() dto: UpdateServerConfigDto) {
    const { server } = this.resolveSpace(params);
    if (!server) return { ok: false, message: '服务器不存在' };

    const updates: any = {};
    if (dto.agoraAppId !== undefined) updates.agoraAppId = dto.agoraAppId;
    if (dto.agoraAppCertificate !== undefined && dto.agoraAppCertificate !== '******') {
      updates.agoraAppCertificate = dto.agoraAppCertificate;
    }
    if (dto.agoraTokenExpireSec !== undefined) updates.agoraTokenExpireSec = dto.agoraTokenExpireSec;
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

    this.db.updateServer(server.serverId, updates);
    return { ok: true };
  }

  // ===== Sessions =====

  @Get(['server/:serverId/sessions', 'spaces/:platform/:externalId/sessions'])
  listSessions(@Param() params: Record<string, string>) {
    const { server } = this.resolveSpace(params);
    if (!server) return [];
    return this.db.getSessionsByServerFiltered(server.serverId, server.reboundAt);
  }

  // ===== Agora Providers（频道主 BYOK）=====
  //
  // 频道主只能管理**自己服务器**的 Provider：
  // - `ownerType` / `ownerId` 由服务端强制写入，请求里带也会被 ValidationPipe 的
  //   `whitelist` 剥离。否则频道主可以伪造请求创建平台池 Provider，越权占用我们的声网账号。
  // - 改/删之前校验目标 Provider 确实归属该服务器，避免用 ID 越权操作别人的凭证（IDOR）。
  // - 响应走 `AgoraProviderAdminView`，只含 `hasAppCertificate` 布尔值，明文永不回传。

  @Get(['server/:serverId/providers', 'spaces/:platform/:externalId/providers'])
  listProviders(@Param() params: Record<string, string>) {
    const { server } = this.resolveSpace(params);
    if (!server) return [];
    return this.providers.listForAdminByOwner('space', server.serverId);
  }

  @Post(['server/:serverId/providers', 'spaces/:platform/:externalId/providers'])
  @HttpCode(HttpStatus.OK)
  createProvider(
    @Param() params: Record<string, string>,
    @Body() dto: CreateSpaceProviderDto,
  ) {
    const { server } = this.resolveSpace(params);
    if (!server) return { ok: false, message: '服务器不存在' };

    const provider = this.providers.create({
      // 归属强制绑定到当前服务器，不接受客户端指定
      ownerType: 'space',
      ownerId: server.serverId,
      name: dto.name,
      appId: dto.appId,
      appCertificate: dto.appCertificate,
      tokenExpireSec: dto.tokenExpireSec,
      enabled: dto.enabled,
      note: dto.note,
    });
    return { ok: true, provider };
  }

  @Put(['server/:serverId/providers/:id', 'spaces/:platform/:externalId/providers/:id'])
  updateProvider(
    @Param() params: Record<string, string>,
    @Body() dto: UpdateSpaceProviderDto,
  ) {
    const owned = this.resolveOwnedProvider(params);
    if ('error' in owned) return owned.error;

    const updated = this.providers.update(params.id, dto);
    if (!updated) return { ok: false, message: 'Provider 不存在' };
    return { ok: true, provider: updated };
  }

  @Delete(['server/:serverId/providers/:id', 'spaces/:platform/:externalId/providers/:id'])
  removeProvider(@Param() params: Record<string, string>) {
    const owned = this.resolveOwnedProvider(params);
    if ('error' in owned) return owned.error;
    return this.providers.remove(params.id);
  }

  /** 解析目标 Provider 并确认它属于当前服务器。 */
  private resolveOwnedProvider(
    params: Record<string, string>,
  ): { provider: ReturnType<AgoraProviderService['getForAdmin']> } | { error: { ok: false; message: string } } {
    const { server } = this.resolveSpace(params);
    if (!server) return { error: { ok: false, message: '服务器不存在' } };

    const provider = this.providers.getForAdmin(params.id);
    if (!provider || provider.ownerType !== 'space' || provider.ownerId !== server.serverId) {
      return { error: { ok: false, message: 'Provider 不存在或不属于该服务器' } };
    }
    return { provider };
  }
}
