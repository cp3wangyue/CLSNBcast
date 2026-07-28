import {
  Controller,
  HttpException,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { KookWebhookCodec, KookWebhookProtocolError } from './kook-webhook.codec';
import { KookWebhookRepository } from './kook-webhook.repository';

@Controller('api/integrations/kook')
export class KookWebhookController {
  private readonly logger = new Logger(KookWebhookController.name);

  constructor(
    private readonly codec: KookWebhookCodec,
    private readonly repository: KookWebhookRepository,
  ) {}

  @Post('webhook')
  receive(@Req() request: Request) {
    try {
      const envelope = this.codec.decode(request.body as unknown as Buffer);
      const data = envelope.d as any;
      if (data.channel_type === 'WEBHOOK_CHALLENGE') {
        if (typeof data.challenge !== 'string' || !data.challenge) {
          throw new KookWebhookProtocolError(400, 'invalid_challenge');
        }
        this.logger.log('KOOK webhook challenge verified');
        return { challenge: data.challenge };
      }

      const result = this.repository.enqueue(envelope);
      if (result.conflict) {
        this.logger.warn(`KOOK webhook event key conflict: key=${result.eventKey}`);
      }
      this.logger.log(
        `KOOK webhook accepted: key=${result.eventKey} duplicate=${!result.inserted} sn=${envelope.sn ?? 'none'}`,
      );
      return { ok: true };
    } catch (error) {
      if (error instanceof KookWebhookProtocolError) {
        this.logger.warn(`KOOK webhook rejected: ${error.code}`);
        throw new HttpException({ message: error.code }, error.status);
      }
      this.logger.error('KOOK webhook persistence failed');
      throw new HttpException({ message: 'webhook_persistence_failed' }, 500);
    }
  }
}
