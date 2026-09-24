import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DiscordWebhookController } from './discord-webhook.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [DiscordWebhookController],
})
export class DiscordModule {}
