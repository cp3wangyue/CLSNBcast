import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { KookApiError } from './kook-api.client';
import { KookEventRouter } from './kook-event.router';
import { KookService } from './kook.service';
import { KookWebhookEnvelope } from './kook-event.types';
import { KookWebhookRepository } from './kook-webhook.repository';

@Injectable()
export class KookWebhookWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KookWebhookWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private processing = false;
  private stopping = false;
  private cleanupCounter = 0;

  constructor(
    private readonly repository: KookWebhookRepository,
    private readonly router: KookEventRouter,
    private readonly service: KookService,
  ) {}

  onModuleInit(): void {
    const recovered = this.repository.recoverStale();
    if (recovered) this.logger.warn(`Recovered ${recovered} stale KOOK webhook event(s)`);
    this.timer = setInterval(() => void this.tick(), 500);
    this.logger.log('KOOK webhook worker started');
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.processing || this.stopping || !this.service.isReady) return;
    const event = this.repository.claim();
    if (!event) return;
    this.processing = true;
    try {
      const envelope = JSON.parse(event.payload) as KookWebhookEnvelope;
      const handled = await this.router.route(envelope);
      this.repository.complete(event.eventKey, !handled);
      this.logger.log(
        `KOOK webhook processed: key=${event.eventKey} type=${event.eventType} result=${handled ? 'done' : 'ignored'}`,
      );
    } catch (error: any) {
      const retryable = error instanceof KookApiError ? error.retryable : true;
      const errorCode = error instanceof KookApiError
        ? `kook_api_${error.status || 'network'}_${error.kookCode || 'unknown'}`
        : 'processing_error';
      if (retryable && event.attempts < 5) {
        this.repository.retry(event.eventKey, event.attempts, errorCode);
        this.logger.warn(`KOOK webhook retry scheduled: key=${event.eventKey} attempt=${event.attempts}`);
      } else {
        this.repository.dead(event.eventKey, errorCode);
        this.logger.error(`KOOK webhook dead: key=${event.eventKey} error=${errorCode}`);
      }
    } finally {
      this.processing = false;
      if (++this.cleanupCounter >= 10000) {
        this.cleanupCounter = 0;
        const removed = this.repository.cleanup();
        if (removed) this.logger.log(`Cleaned ${removed} old KOOK webhook event(s)`);
      }
    }
  }
}
