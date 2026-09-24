import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SessionModule } from '../session/session.module';
import { DiscordWebhookController } from './discord-webhook.controller';
import { DiscordShareService } from './discord-share.service';
import { DiscordNotifierService } from './discord-notifier.service';

@Module({
  imports: [DatabaseModule, SessionModule],
  controllers: [DiscordWebhookController],
  providers: [DiscordShareService, DiscordNotifierService],
  exports: [DiscordShareService, DiscordNotifierService],
})
export class DiscordModule {}
