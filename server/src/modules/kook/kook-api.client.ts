import { Logger } from '@nestjs/common';
import { errorMessage, isAbortError } from '../../common/error-message';

const API_BASE = 'https://www.kookapp.cn/api/v3';

export class KookApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly kookCode?: number,
  ) {
    super(message);
    this.name = 'KookApiError';
  }
}

export class KookApiClient {
  private readonly logger = new Logger(KookApiClient.name);
  private readonly timeoutMs: number;
  private botId: string | null = null;
  private readonly sentMessageIds = new Set<string>();
  private readonly maxSentMessageIds = 10000;

  constructor(private readonly token: string) {
    const configured = Number(process.env.KOOK_API_TIMEOUT_MS || 10000);
    this.timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 10000;
  }

  getBotId(): string | null {
    return this.botId;
  }

  setBotId(id: string): void {
    this.botId = id || null;
  }

  isOwnMessage(id?: string): boolean {
    return !!id && this.sentMessageIds.has(id);
  }

  async sendTextMessage(channelId: string, content: string): Promise<any> {
    return this.postApi('/message/create', { target_id: channelId, content, type: 1 });
  }

  async sendTempTextMessage(channelId: string, content: string, tempTargetUserId: string): Promise<any> {
    return this.postApi('/message/create', {
      target_id: channelId,
      content,
      type: 1,
      temp_target_id: tempTargetUserId,
    });
  }

  async sendKMarkdownMessage(channelId: string, content: string): Promise<any> {
    return this.postApi('/message/create', { target_id: channelId, content, type: 9 });
  }

  async sendCardMessage(channelId: string, cards: unknown): Promise<any> {
    return this.postApi('/message/create', {
      target_id: channelId,
      type: 10,
      content: typeof cards === 'string' ? cards : JSON.stringify(cards),
    });
  }

  async sendTempCardMessage(channelId: string, cards: unknown, tempTargetUserId: string): Promise<any> {
    return this.postApi('/message/create', {
      target_id: channelId,
      type: 10,
      content: typeof cards === 'string' ? cards : JSON.stringify(cards),
      temp_target_id: tempTargetUserId,
    });
  }

  async updateMessage(msgId: string, content: string, type: number): Promise<any> {
    return this.postApi('/message/update', { msg_id: msgId, content, type });
  }

  async deleteMessage(msgId: string): Promise<any> {
    return this.postApi('/message/delete', { msg_id: msgId });
  }

  async getGuild(guildId: string): Promise<any> {
    return this.getApi(`/guild/view?guild_id=${encodeURIComponent(guildId)}`);
  }

  async getGuildList(): Promise<any[]> {
    const items: any[] = [];
    let page = 1;
    // 分页循环：出口是下面的 break（页码到达总数 / 当前页为空），不是常量条件
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const data = await this.getApi(`/guild/list?page=${page}&page_size=50`);
      const current = Array.isArray(data?.items) ? data.items : [];
      items.push(...current);
      const totalPages = Number(data?.meta?.page_total || 1);
      if (page >= totalPages || current.length === 0) break;
      page++;
    }
    return items;
  }

  async getGuildChannels(guildId: string): Promise<any[]> {
    const items: any[] = [];
    let page = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const data = await this.getApi(
        `/channel/list?guild_id=${encodeURIComponent(guildId)}&page=${page}&page_size=50`,
      );
      const current = Array.isArray(data?.items) ? data.items : [];
      items.push(...current);
      const totalPages = Number(data?.meta?.page_total || 1);
      if (page >= totalPages || current.length === 0) break;
      page++;
    }
    return items;
  }

  async getChannelInfo(channelId: string): Promise<any> {
    return this.getApi(`/channel/view?target_id=${encodeURIComponent(channelId)}`);
  }

  async getMe(): Promise<any> {
    return this.getApi('/user/me');
  }

  async sendPrivateMessage(userId: string, content: string, type = 1): Promise<any> {
    return this.postApi('/direct-message/create', { target_id: userId, content, type });
  }

  private async request(path: string, init: RequestInit): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bot ${this.token}`,
          ...(init.headers || {}),
        },
      });
    } catch (error: unknown) {
      const message = isAbortError(error) ? 'request timeout' : 'network failure';
      throw new KookApiError(`KOOK API ${path} ${message}`, true);
    }

    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new KookApiError(
        `KOOK API ${path} invalid response`,
        response.status >= 500,
        response.status,
      );
    }

    const code = Number(body?.code);
    if (!response.ok || code !== 0) {
      const retryable = response.status === 429 || response.status >= 500;
      this.logger.error(
        `KOOK API ${path} failed: status=${response.status} code=${Number.isFinite(code) ? code : 'unknown'}`,
      );
      throw new KookApiError(
        `KOOK API ${path} failed`,
        retryable,
        response.status,
        Number.isFinite(code) ? code : undefined,
      );
    }
    return body?.data;
  }

  private getApi(path: string): Promise<any> {
    return this.request(path, { method: 'GET' });
  }

  private async postApi(path: string, body: unknown): Promise<any> {
    const data = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const sentId = data?.msg_id || data?.id;
    if (sentId) this.registerSentMessage(String(sentId));
    return data;
  }

  private registerSentMessage(id: string): void {
    if (this.sentMessageIds.size >= this.maxSentMessageIds) {
      const first = this.sentMessageIds.values().next().value;
      if (first) this.sentMessageIds.delete(first);
    }
    this.sentMessageIds.add(id);
  }
}
