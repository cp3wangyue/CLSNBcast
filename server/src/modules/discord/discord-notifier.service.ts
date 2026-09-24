import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventBusService } from '../events/events.service';
import { SessionService } from '../session/session.service';
import { DatabaseService } from '../database/database.service';
import {
  buildDiscordEndedCard,
  buildDiscordViewingCard,
  DiscordMessagePayload,
} from './discord-message-builder';

/**
 * 发送 Discord 消息的能力。
 *
 * 抽成接口是为了让事件处理逻辑**不依赖真实 API**：
 * 未配置 Bot Token 时注入 no-op 实现，配置后才换成真实 client。
 * 这也让整条事件链路无需凭证即可完整测试。
 */
export interface DiscordMessageSender {
  sendToChannel(channelId: string, payload: DiscordMessagePayload): Promise<string | null>;
  editMessage(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<void>;
}

/**
 * Discord 侧的会话生命周期广播。
 *
 * 复用与 KOOK **同一个** EventBusService —— 这正是平台接缝的价值：
 * 会话状态机不感知平台，谁订阅谁负责自己的呈现形式。
 *
 * 与 KOOK 对齐的语义：
 * - 只在会话真正 `active` 后发公开观看卡片（发布端开始了才算开播）
 * - 同一会话只发一次（`publishing` 去重 + `cardMessageId` 幂等）
 * - 结束卡片只在曾发布过公开卡片时才更新，避免为「从未开播」的会话刷屏
 */
@Injectable()
export class DiscordNotifierService implements OnModuleDestroy {
  private readonly logger = new Logger(DiscordNotifierService.name);
  private readonly publishing = new Set<string>();

  constructor(
    private readonly bus: EventBusService,
    private readonly sessionService: SessionService,
    private readonly db: DatabaseService,
  ) {
    // 保留引用，销毁时只摘掉自己的监听 —— 直接 removeAllListeners 会
    // 连带移除 KOOK 的订阅（两者共用同一个总线）
    this.onStarted = (e) => void this.handleStarted(e);
    this.onEnded = (e) => void this.handleEnded(e);
    this.bus.onSessionStarted(this.onStarted);
    this.bus.onSessionEnded(this.onEnded);
  }

  private readonly onStarted: (e: {
    sessionId: string;
    token: string;
    sharerUsername: string;
    targetChannelId: string;
    guildId: string;
  }) => void;

  private readonly onEnded: (e: {
    sessionId: string;
    targetChannelId?: string;
    cardMessageId?: string;
    reason: string;
  }) => void;

  /** 由模块装配时注入；未配置 Bot Token 时为 null，此时跳过发送 */
  private sender: DiscordMessageSender | null = null;

  setSender(sender: DiscordMessageSender | null): void {
    this.sender = sender;
  }

  private async handleStarted(event: {
    sessionId: string;
    token: string;
    sharerUsername: string;
    targetChannelId: string;
    guildId: string;
  }) {
    const session = this.sessionService.getById(event.sessionId);
    if (!session || session.cardMessageId || this.publishing.has(event.sessionId)) return;

    // 只有 Discord 的服务器才由这里广播；KOOK 的由 KookService 处理
    if (!this.isDiscordGuild(event.guildId)) return;
    if (!event.targetChannelId || !this.sender) return;

    this.publishing.add(event.sessionId);
    try {
      const current = this.sessionService.getById(event.sessionId);
      if (!current || current.cardMessageId || current.status !== 'active') return;

      const publicDomain = this.publicDomainFor(event.guildId);
      const payload = buildDiscordViewingCard({
        sharerUsername: event.sharerUsername,
        viewUrl: `${publicDomain}/view?t=${event.token}`,
      });
      const messageId = await this.sender.sendToChannel(event.targetChannelId, payload);
      if (messageId) {
        this.sessionService.setCardMessageId(event.sessionId, messageId);
      }
      this.logger.log(`Discord viewing card published for session=${event.sessionId}`);
    } catch (e: any) {
      this.logger.error(`Discord viewing card failed: ${e?.message || e}`);
    } finally {
      this.publishing.delete(event.sessionId);
    }
  }

  private async handleEnded(event: {
    sessionId: string;
    targetChannelId?: string;
    cardMessageId?: string;
    reason: string;
  }) {
    // 未发布过公开卡片就无需更新，避免给「从未开播」的会话刷屏
    if (!event.cardMessageId || !event.targetChannelId || !this.sender) return;

    try {
      const session = this.sessionService.getById(event.sessionId);
      const info = session ? this.sessionService.toInfo(session) : null;
      const payload = buildDiscordEndedCard({
        sharerUsername: session?.sharerUsername || '匿名用户',
        totalViewerJoins: session?.totalViewerJoins ?? 0,
        durationMs: session?.durationMs ?? null,
        standardMinutes: info?.standardMinutes ?? 0,
        estimatedCost: info?.estimatedCost ?? 0,
      });
      await this.sender.editMessage(event.targetChannelId, event.cardMessageId, payload);
      this.logger.log(`Discord ended card updated for session=${event.sessionId}`);
    } catch (e: any) {
      this.logger.error(`Discord ended card failed: ${e?.message || e}`);
    }
  }

  private isDiscordGuild(guildId: string): boolean {
    const server = this.db.getServer(guildId);
    return server?.platform === 'discord';
  }

  private publicDomainFor(guildId: string): string {
    const server = this.db.getServer(guildId);
    const raw = server?.publicDomain || this.db.getGlobalConfig().publicDomain || '';
    return raw.replace(/\/+$/, '');
  }

  onModuleDestroy() {
    // 只摘掉本服务注册的监听：总线是全局单例且与 KOOK 共用，
    // removeAllListeners 会误删 KOOK 的订阅。
    this.bus.off('session.started', this.onStarted);
    this.bus.off('session.ended', this.onEnded);
  }
}
