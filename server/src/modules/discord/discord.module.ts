import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SessionModule } from '../session/session.module';
import { DiscordWebhookController } from './discord-webhook.controller';
import { DiscordShareService } from './discord-share.service';

@Module({
  imports: [DatabaseModule, SessionModule],
  controllers: [DiscordWebhookController],
  providers: [DiscordShareService],
  exports: [DiscordShareService],
})
export class DiscordModule {}
