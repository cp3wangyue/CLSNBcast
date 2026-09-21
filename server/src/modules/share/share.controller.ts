import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  UseGuards,
  Req,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ShareTokenGuard } from '../auth/guards/share-token.guard';
import { AgoraService } from '../agora/agora.service';
import { SessionService } from '../session/session.service';
import { ProviderUnavailableError } from '../session/session.service';
import { QualityPresetService } from '../quality/quality-preset.service';
import { CustomQualityInput } from '../quality/quality-preset.types';
import { AgoraRole } from '../agora/agora.types';
import { DatabaseService } from '../database/database.service';

@Controller('api/share')
export class ShareController {
  private readonly logger = new Logger(ShareController.name);

  constructor(
    private readonly agora: AgoraService,
    private readonly sessionService: SessionService,
    private readonly db: DatabaseService,
    private readonly quality: QualityPresetService,
  ) {}

  @Get('info')
  @UseGuards(ShareTokenGuard)
  info(@Req() req: any) {
    const info = this.sessionService.toInfo(req.session);
    const serverId = req.session.guildId || '';
    const allowedQualities = this.agora.getAllowedQualities(serverId);
    return {
      ...info,
      allowedQualities,
      qualityBitrates: this.db.getGlobalConfig().qualityBitrates,
    };
  }

  @Get('token')
  @UseGuards(ShareTokenGuard)
  token(@Req() req: any, @Query('role') role: string) {
    const r: AgoraRole = role === 'publisher' ? 'publisher' : 'subscriber';
    const uid = r === 'publisher' ? 1 : Math.floor(Math.random() * 99999) + 100;
    // generateToken 从会话快照读取 Provider 与 App ID，保证同一会话的发布端与所有
    // 观众端始终落在同一个声网项目上。失败时抛带 code 的 400
    // （SESSION_PROVIDER_MISSING / PROVIDER_APPID_CHANGED / PROVIDER_UNAVAILABLE 等），
    // 不再返回空 appId 让前端自己猜。
    return this.agora.generateToken(req.session, uid, r);
  }

  @Post('start')
  @UseGuards(ShareTokenGuard)
  async start(
    @Req() req: any,
    @Body('quality') quality?: string,
    @Body('clientId') clientId?: string,
    @Body('lowLatency') lowLatency?: boolean,
    @Body('customQuality') customQuality?: CustomQualityInput,
  ) {
    const serverId = req.session.guildId || '';
    const allowedQualities = this.agora.getAllowedQualities(serverId);

    // 自定义画质：不要求出现在预设白名单里（那正是自由画质的意义），
    // 但仍需通过校验；结构性错误直接 400，超出建议范围只返回 warnings。
    const resolution = customQuality
      ? this.quality.resolveFromCustom(customQuality)
      : undefined;

    if (!resolution && (!quality || !allowedQualities.includes(quality))) {
      throw new HttpException(
        { message: '该画质未对本服务器开放，请刷新页面后重新选择', code: 'QUALITY_NOT_ALLOWED' },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (resolution) {
      const rejecting = resolution.issues.filter((issue) => issue.severity === 'reject');
      if (rejecting.length > 0) {
        throw new HttpException(
          {
            message: rejecting.map((issue) => issue.message).join('；'),
            code: 'QUALITY_INVALID',
            issues: resolution.issues,
          },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    let session;
    try {
      session = this.sessionService.startSharing(req.session.token, clientId, lowLatency);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        throw new HttpException({ message: error.message, code: error.code }, HttpStatus.BAD_REQUEST);
      }
      throw error;
    }

    if (session) {
      this.sessionService.applyQuality(session.id, {
        presetId: resolution ? null : quality,
        snapshot: resolution?.snapshot,
        warnings: resolution?.issues.filter((issue) => issue.severity === 'warn') ?? [],
      });
    }
    if (!session) {
      return { ok: false, message: 'unable to start sharing (session ended or publisher locked)' };
    }
    return {
      ok: true,
      // 回传生效参数与提示，前端据此展示"目标参数"与风险提示
      quality: resolution ? resolution.snapshot : this.sessionService.getQualitySnapshot(session.id),
      warnings: resolution?.issues.filter((issue) => issue.severity === 'warn') ?? [],
    };
  }

  @Post('stop')
  @UseGuards(ShareTokenGuard)
  stop(@Req() req: any) {
    const session = this.sessionService.stopSharing(req.session.token);
    return { ok: !!session };
  }
}
