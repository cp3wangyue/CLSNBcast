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
import { AgoraRole } from '../agora/agora.types';
import { DatabaseService } from '../database/database.service';

@Controller('api/share')
export class ShareController {
  private readonly logger = new Logger(ShareController.name);

  constructor(
    private readonly agora: AgoraService,
    private readonly sessionService: SessionService,
    private readonly db: DatabaseService,
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
  start(
    @Req() req: any,
    @Body('quality') quality?: string,
    @Body('clientId') clientId?: string,
    @Body('lowLatency') lowLatency?: boolean,
  ) {
    const serverId = req.session.guildId || '';
    const allowedQualities = this.agora.getAllowedQualities(serverId);
    if (!quality || !allowedQualities.includes(quality)) {
      throw new HttpException(
        { message: '该画质未对本服务器开放，请刷新页面后重新选择', code: 'QUALITY_NOT_ALLOWED' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const session = this.sessionService.startSharing(
      req.session.token,
      clientId,
      lowLatency,
    );
    if (session) {
      this.sessionService.updateQuality(session.id, quality);
    }
    if (!session) {
      return { ok: false, message: 'unable to start sharing (session ended or publisher locked)' };
    }
    return { ok: true };
  }

  @Post('stop')
  @UseGuards(ShareTokenGuard)
  stop(@Req() req: any) {
    const session = this.sessionService.stopSharing(req.session.token);
    return { ok: !!session };
  }
}
