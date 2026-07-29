import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { KookQueuedEvent, KookWebhookEnvelope } from './kook-event.types';

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalize(record[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

@Injectable()
export class KookWebhookRepository {
  constructor(private readonly db: DatabaseService) {}

  enqueue(envelope: KookWebhookEnvelope) {
    const payload = canonicalize(envelope);
    const payloadHash = createHash('sha256').update(payload).digest('hex');
    const data = envelope.d;
    const eventId = typeof data.msg_id === 'string' ? data.msg_id : '';
    const sn = typeof envelope.sn === 'number' ? envelope.sn : null;
    const eventKey = eventId
      ? `msg:${eventId}`
      : `fallback:${sn == null ? 'none' : sn}:${payloadHash}`;
    const eventType = data.type === 255
      ? String((data.extra as any)?.type || data.event_type || 'system')
      : String(data.type ?? 'unknown');
    return this.db.enqueueKookWebhookEvent({
      eventKey,
      eventId,
      sn,
      eventType,
      payload,
      payloadHash,
    });
  }

  recoverStale(): number {
    return this.db.recoverStaleKookWebhookEvents(Date.now() - 5 * 60 * 1000);
  }

  claim(): KookQueuedEvent | undefined {
    return this.db.claimKookWebhookEvent();
  }

  complete(eventKey: string, ignored = false): void {
    this.db.completeKookWebhookEvent(eventKey, ignored ? 'ignored' : 'done');
  }

  beginBusinessEffect(eventKey: string): 'execute' | 'done' | 'ignored' | 'uncertain' {
    return this.db.beginKookWebhookBusinessEffect(eventKey);
  }

  completeBusinessEffect(eventKey: string, ignored = false): void {
    this.db.completeKookWebhookBusinessEffect(eventKey, ignored ? 'ignored' : 'done');
  }

  markBusinessEffectUncertain(eventKey: string, errorCode: string): void {
    this.db.markKookWebhookBusinessEffectUncertain(eventKey, errorCode);
  }

  retry(eventKey: string, attempts: number, errorCode: string): void {
    const delays = [2000, 5000, 15000, 60000, 300000];
    const base = delays[Math.min(Math.max(attempts - 1, 0), delays.length - 1)];
    const jitter = Math.floor(Math.random() * Math.min(1000, base / 5));
    this.db.retryKookWebhookEvent(eventKey, Date.now() + base + jitter, errorCode);
  }

  dead(eventKey: string, errorCode: string): void {
    this.db.deadKookWebhookEvent(eventKey, errorCode);
  }

  status() {
    return this.db.getKookWebhookStatus();
  }

  cleanup(): number {
    const day = 24 * 60 * 60 * 1000;
    return this.db.cleanupKookWebhookEvents(Date.now() - 7 * day, Date.now() - 30 * day);
  }
}
