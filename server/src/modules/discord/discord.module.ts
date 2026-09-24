import { Module, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CryptoModule } from '../crypto/crypto.module';
import { SessionModule } from '../session/session.module';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { DiscordWebhookController } from './discord-webhook.controller';
import { DiscordShareService } from './discord-share.service';
import { DiscordNotifierService } from './discord-notifier.service';
import { DiscordChannelSender } from './discord-channel-sender';

/**
 * 按是否配置 Bot Token 决定是否启用真实发送。
 *
 * notifier 订阅的是全局事件总线，若 sender 恒为 null 则观看/结束卡片
 * 永远不会发出。这里在模块初始化时尝试装配真实 client；未配置凭证时
 * 保持 null（事件仍会被安全跳过，见 DiscordNotifierService），
 * 配置后无需改代码即可生效。
 */
@Module({
  imports: [DatabaseModule, CryptoModule, SessionModule],
  controllers: [DiscordWebhookController],
  providers: [DiscordShareService, DiscordNotifierService, DiscordChannelSender],
  exports: [DiscordShareService, DiscordNotifierService],
})
export class DiscordModule implements OnModuleInit {
  private readonly logger = new Logger(DiscordModule.name);

  constructor(
    private readonly sender: DiscordChannelSender,
    private readonly notifier: DiscordNotifierService,
    private readonly crypto: SecretCryptoService,
  ) {}

  onModuleInit(): void {
    if (this.sender.refresh()) {
      this.notifier.setSender(this.sender);
      this.logger.log('Discord message sender enabled (bot token configured)');
    }
    else {
      this.notifier.setSender(null);
      this.logger.warn(
        'Discord bot token not configured; viewing/ended cards will be skipped ' +
        '(set it in the super admin panel)',
      );
    }
  }
}
