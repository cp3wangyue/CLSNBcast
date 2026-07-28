import { Injectable, Logger } from '@nestjs/common';
import { KookService } from './kook.service';
import { KookButtonClickEvent, KookMessageEvent, KookWebhookEnvelope } from './kook-event.types';

@Injectable()
export class KookEventRouter {
  private readonly logger = new Logger(KookEventRouter.name);

  constructor(private readonly service: KookService) {}

  async route(envelope: KookWebhookEnvelope): Promise<boolean> {
    const data = envelope.d as any;
    const eventType = data?.extra?.type || data?.event_type;

    if (data.type === 255) {
      if (eventType === 'message_btn_click') {
        const body = data.extra?.body || {};
        const event: KookButtonClickEvent = {
          msgId: body.msg_id || data.msg_id || '',
          userId: body.user_id || '',
          username: body.user_info?.username || '',
          targetId: body.target_id || data.target_id || '',
          guildId: data.extra?.guild_id || data.guild_id || '',
          value: body.value || '',
        };
        await this.service.handleButtonClick(event);
        return true;
      }
      if (eventType === 'self_joined_guild') {
        const guildId = data.extra?.body?.guild_id || '';
        if (!guildId) return false;
        await this.service.handleGuildJoin(guildId, '');
        return true;
      }
      if (eventType === 'self_exited_guild') {
        const guildId = data.extra?.body?.guild_id || '';
        if (!guildId) return false;
        await this.service.handleGuildLeave(guildId);
        return true;
      }
      if (eventType !== 'message') {
        this.logger.debug(`KOOK webhook ignored system event: ${eventType || 'unknown'}`);
        return false;
      }
    }

    if (data.type === 1 || data.type === 9 || eventType === 'message') {
      const message: KookMessageEvent = {
        ...data,
        id: data.msg_id || data.id || '',
      };
      await this.service.handleIncomingMessage(message);
      return true;
    }

    this.logger.debug(`KOOK webhook ignored event: type=${data.type ?? 'unknown'}`);
    return false;
  }
}
