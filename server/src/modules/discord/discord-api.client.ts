import { Logger } from '@nestjs/common';
import { DiscordMessagePayload } from './discord-message-builder';

const API_BASE = 'https://discord.com/api/v10';

export class DiscordApiError extends Error {
  constructor(
    message: string,
    /** 429 与 5xx 可重试；4xx（除 429）是请求本身有问题，重试无意义 */
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }
}

/**
 * Discord REST API 客户端。
 *
 * 只实现本项目需要的两个能力：发消息、编辑消息。参照 `KookApiClient` 的
 * 成熟度标准：超时控制、可重试判定、以及**日志绝不回显凭证**。
 *
 * 鉴权：`Authorization: Bot <token>`。
 * 参考：https://discord.com/developers/docs/resources/message
 */
export class DiscordApiClient {
  private readonly logger = new Logger(DiscordApiClient.name);
  private readonly timeoutMs: number;

  constructor(private readonly botToken: string) {
    const configured = Number(process.env.DISCORD_API_TIMEOUT_MS || 10000);
    this.timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 10000;
  }

  /** 发消息；返回新消息的 ID，供后续编辑使用 */
  async sendMessage(channelId: string, payload: DiscordMessagePayload): Promise<string | null> {
    const data = await this.request(
      `/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    const id = data?.id;
    return id ? String(id) : null;
  }

  async editMessage(
    channelId: string,
    messageId: string,
    payload: DiscordMessagePayload,
  ): Promise<void> {
    await this.request(
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
  }

  private async request(path: string, init: RequestInit): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: {
          ...(init.headers || {}),
          Authorization: `Bot ${this.botToken}`,
        },
        signal: controller.signal,
      });
    } catch (error: any) {
      const message = error?.name === 'AbortError' ? 'request timeout' : 'network failure';
      throw new DiscordApiError(`Discord API ${path} ${message}`, true);
    } finally {
      clearTimeout(timer);
    }

    // 204（如部分 DELETE）没有响应体
    if (response.status === 204) return null;

    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new DiscordApiError(
        `Discord API ${path} invalid response`,
        response.status >= 500,
        response.status,
      );
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      // 只记状态码与 Discord 的错误码，不回显请求体（可能含 token 或频道内容）
      this.logger.error(
        `Discord API ${path} failed: status=${response.status} code=${body?.code ?? 'unknown'}`,
      );
      throw new DiscordApiError(
        `Discord API ${path} failed`,
        retryable,
        response.status,
      );
    }
    return body;
  }
}
