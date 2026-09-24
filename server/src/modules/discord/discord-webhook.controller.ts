import {
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { DatabaseService } from '../database/database.service';
import { DiscordShareService } from './discord-share.service';
import {
  DiscordSignatureError,
  DISCORD_INTERACTION_PING,
  verifyDiscordSignature,
} from './discord-signature';
import {
  DISCORD_INTERACTION,
  DISCORD_MESSAGE_FLAG,
  DISCORD_RESPONSE,
  DiscordInteraction,
} from './discord.types';

/**
 * Discord Interactions Endpoint。
 *
 * 与 KOOK 一样是「入站 HTTP + 签名校验」，因此不需要长连接守护进程。
 * 支持的交互：
 * - PING：端点连通性校验（应用面板保存 URL 时发起）
 * - 斜杠命令 `share`：发起屏幕共享，返回**仅发起人可见**的分享链接
 *
 * 未在 3 秒内 ACK 会被 Discord 判定超时，因此这里同步返回初始响应；
 * 需要长耗时处理的场景应改用 DEFERRED 再补发。
 */
@Controller('api/integrations/discord')
export class DiscordWebhookController {
  private readonly logger = new Logger(DiscordWebhookController.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly share: DiscordShareService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  receive(@Req() request: Request) {
    let payload: DiscordInteraction;

    try {
      const publicKey = this.db.getGlobalConfig().discordPublicKey || '';
      const timestamp = String(request.headers['x-signature-timestamp'] || '');
      const signature = String(request.headers['x-signature-ed25519'] || '');

      // 必须是**原始字节**：main.ts 已为该路由注册 bodyParser.raw。
      // 任何 JSON 解析再序列化都会改变字节，签名必然校验失败。
      const rawBody = request.body as unknown as Buffer;
      verifyDiscordSignature(publicKey, timestamp, signature, rawBody);

      try {
        payload = JSON.parse(rawBody.toString('utf-8')) as DiscordInteraction;
      } catch {
        throw new DiscordSignatureError('invalid_json', 400);
      }
    } catch (error) {
      if (error instanceof DiscordSignatureError) {
        this.logger.warn(`Discord webhook rejected: ${error.code}`);
        throw new HttpException({ message: error.code }, error.status);
      }
      this.logger.error('Discord webhook failed');
      throw new HttpException({ message: 'webhook_failed' }, 500);
    }

    if (payload.type === DISCORD_INTERACTION_PING) {
      this.logger.log('Discord interaction PING verified');
      return { type: DISCORD_INTERACTION.PING };
    }

    if (payload.type === DISCORD_INTERACTION.APPLICATION_COMMAND) {
      return this.handleCommand(payload);
    }

    // 组件交互（按钮）等暂不支持：仍需 ACK，否则 Discord 会显示超时
    this.logger.debug(`Discord interaction not handled: type=${payload.type}`);
    return {
      type: DISCORD_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '暂不支持该操作。', flags: DISCORD_MESSAGE_FLAG.EPHEMERAL },
    };
  }

  private handleCommand(payload: DiscordInteraction) {
    const name = payload.data?.name || '';

    if (name === 'share') {
      const result = this.share.handleShareRequest(payload);
      if (result.status === 'ok' && result.shareUrl) {
        this.logger.log(`Discord share created for guild=${payload.guild_id}`);
        return {
          type: DISCORD_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `🖥 屏幕共享已创建，点击下方链接开始共享：\n${result.shareUrl}`,
            flags: DISCORD_MESSAGE_FLAG.EPHEMERAL,
          },
        };
      }
      return {
        type: DISCORD_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `⚠️ ${result.message || '无法发起共享。'}`,
          flags: DISCORD_MESSAGE_FLAG.EPHEMERAL,
        },
      };
    }

    return {
      type: DISCORD_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '未知命令。可用命令：`/share`', flags: DISCORD_MESSAGE_FLAG.EPHEMERAL },
    };
  }
}
