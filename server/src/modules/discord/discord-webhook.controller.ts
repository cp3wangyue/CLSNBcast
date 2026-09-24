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
import {
  DiscordSignatureError,
  DISCORD_INTERACTION_PING,
  verifyDiscordSignature,
} from './discord-signature';

/**
 * Discord Interactions Endpoint。
 *
 * 与 KOOK 一样是「入站 HTTP + 签名校验」，因此不需要长连接守护进程。
 * 当前只完成「签名校验 + PING 响应」这一段，业务事件（斜杠命令等）尚未接线 ——
 * 先把平台接缝跑通，避免在 Discord 侧凭证未配置时引入半成品逻辑。
 *
 * Public Key 不是秘密（Discord 官方文档明确说明可公开），因此明文存于
 * `global_config`，不走 SecretCryptoService；后者只用于必须回读的秘密。
 */
@Controller('api/integrations/discord')
export class DiscordWebhookController {
  private readonly logger = new Logger(DiscordWebhookController.name);

  constructor(private readonly db: DatabaseService) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  receive(@Req() request: Request) {
    try {
      const publicKey = this.db.getGlobalConfig().discordPublicKey || '';
      const timestamp = String(request.headers['x-signature-timestamp'] || '');
      const signature = String(request.headers['x-signature-ed25519'] || '');

      // 必须是**原始字节**：main.ts 已为该路由注册 bodyParser.raw。
      // 任何 JSON 解析再序列化都会改变字节，签名必然校验失败。
      const rawBody = request.body as unknown as Buffer;
      verifyDiscordSignature(publicKey, timestamp, signature, rawBody);

      let payload: any = {};
      try {
        payload = JSON.parse(rawBody.toString('utf-8'));
      } catch {
        throw new DiscordSignatureError('invalid_json', 400);
      }

      // Discord 在应用面板保存 URL 时会发 PING 校验端点连通性
      if (payload?.type === DISCORD_INTERACTION_PING) {
        this.logger.log('Discord interaction PING verified');
        return { type: DISCORD_INTERACTION_PING };
      }

      this.logger.log(`Discord interaction accepted: type=${payload?.type}`);
      return { ok: true };
    } catch (error) {
      if (error instanceof DiscordSignatureError) {
        this.logger.warn(`Discord webhook rejected: ${error.code}`);
        throw new HttpException({ message: error.code }, error.status);
      }
      this.logger.error('Discord webhook failed');
      throw new HttpException({ message: 'webhook_failed' }, 500);
    }
  }
}
