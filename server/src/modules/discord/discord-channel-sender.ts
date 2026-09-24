import { Injectable, Logger } from '@nestjs/common';
import { DiscordApiClient } from './discord-api.client';
import { DiscordMessageSender } from './discord-notifier.service';
import { DiscordMessagePayload } from './discord-message-builder';
import { SecretCryptoService } from '../crypto/secret-crypto.service';

/**
 * 把 `DiscordApiClient` 适配成 notifier 需要的 `DiscordMessageSender`。
 *
 * 分开的意义：notifier 只依赖「能发消息」这个能力，不依赖具体是 REST API
 * 还是别的实现 —— 这样未配置 Bot Token 时可以注入 null，配置后才启用，
 * 而事件链路本身无需改动。
 */
@Injectable()
export class DiscordChannelSender implements DiscordMessageSender {
  private readonly logger = new Logger(DiscordChannelSender.name);
  private client: DiscordApiClient | null = null;

  constructor(private readonly crypto: SecretCryptoService) {}

  /**
   * 读取当前配置的 Bot Token 并（重新）构建客户端。
   * Token 未配置时返回 false，调用方据此决定是否启用发送。
   */
  refresh(): boolean {
    let token = '';
    try {
      token = this.crypto.getGlobalSecret('discordBotToken') || '';
    } catch {
      // 无主密钥但库中已有密文时 getGlobalSecret 会抛错；此处按「未配置」处理，
      // 避免整个模块初始化失败（KOOK 也因此不可用）
      token = '';
    }
    if (!token) {
      this.client = null;
      return false;
    }
    this.client = new DiscordApiClient(token);
    return true;
  }

  isReady(): boolean {
    return !!this.client;
  }

  async sendToChannel(channelId: string, payload: DiscordMessagePayload): Promise<string | null> {
    if (!this.client) return null;
    return this.client.sendMessage(channelId, payload);
  }

  async editMessage(
    channelId: string,
    messageId: string,
    payload: DiscordMessagePayload,
  ): Promise<void> {
    if (!this.client) return;
    await this.client.editMessage(channelId, messageId, payload);
  }
}
