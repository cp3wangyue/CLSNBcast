import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { KookService } from './kook.service';
import { KookWebhookRepository } from './kook-webhook.repository';

@Controller('api/super/kook')
export class KookWebhookStatusController {
  constructor(
    private readonly db: DatabaseService,
    private readonly service: KookService,
    private readonly repository: KookWebhookRepository,
  ) {}

  @Get('webhook-status')
  status() {
    const config = this.db.getGlobalConfig();
    const queue = this.repository.status();
    return {
      mode: 'webhook',
      apiReady: this.service.isReady,
      configured: {
        botToken: !!config.kookBotToken,
        verifyToken: !!config.kookVerifyToken,
        encryptKey: !!config.kookEncryptKey,
      },
      callbackUrl: `${config.publicDomain.replace(/\/+$/, '')}/api/integrations/kook/webhook?compress=0`,
      queue: {
        ...queue,
        oldestPendingMs: queue.oldestPendingAt == null
          ? 0
          : Math.max(0, Date.now() - queue.oldestPendingAt),
      },
    };
  }
}
