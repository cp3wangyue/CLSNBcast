import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SessionService, ProviderUnavailableError } from '../session/session.service';
import { DiscordInteraction, discordInteractionUser } from './discord.types';

export interface DiscordShareResult {
  status: 'ok' | 'no_server' | 'no_trigger' | 'provider_unavailable' | 'cooldown';
  /** 成功时给发起人的分享链接 */
  shareUrl?: string;
  /** 失败时面向用户的说明 */
  message?: string;
}

/**
 * Discord 侧的共享发起逻辑。
 *
 * 设计要点：**这个对象不发起任何 Discord 网络调用**。
 * 「触发词匹配 → 冷却 → 建会话 → 生成链接」全部是本地逻辑，
 * 因此无需 Discord 凭证即可完整测试；真正的 API 调用由
 * `DiscordApiClient` 承担（可注入、可替换）。
 *
 * 与 KOOK 的语义对齐：
 * - 会话键（serverId）用 guild_id；
 * - 分享链接 `{publicDomain}/share?t={session.token}`，与平台无关；
 * - 未绑定 / 未登记的服务器直接忽略（不泄露服务器是否存在）。
 */
@Injectable()
export class DiscordShareService {
  private readonly logger = new Logger(DiscordShareService.name);

  /** 与 KOOK 一致的用户+频道维度冷却 */
  private static readonly TRIGGER_COOLDOWN_MS = 5000;
  private readonly recentTriggers = new Map<string, number>();

  constructor(
    private readonly db: DatabaseService,
    private readonly sessionService: SessionService,
  ) {}

  /**
   * 处理一次「发起共享」请求。
   *
   * @param interaction 已通过签名校验的交互
   * @returns 结果；调用方据此决定回复什么
   */
  handleShareRequest(interaction: DiscordInteraction): DiscordShareResult {
    const guildId = interaction.guild_id || '';
    const channelId = interaction.channel_id || '';
    const user = discordInteractionUser(interaction);

    if (!guildId) {
      // 私信场景没有 guild，无法归属到服务器
      return { status: 'no_server', message: '请在服务器频道中使用，暂不支持私信发起。' };
    }
    if (!user?.id) {
      return { status: 'no_server', message: '无法识别发起者，请重试。' };
    }

    const serverConfig = this.getServerConfig(guildId);
    if (!serverConfig) {
      this.logger.debug(`Discord: ignoring trigger for unbound/inactive server ${guildId}`);
      return { status: 'no_server', message: '该服务器尚未绑定或已停用，请先由服务器管理员完成绑定。' };
    }

    // 冷却：Discord 的斜杠命令也可能被连点
    const key = `${user.id}:${channelId}`;
    const last = this.recentTriggers.get(key);
    if (last && Date.now() - last < DiscordShareService.TRIGGER_COOLDOWN_MS) {
      return { status: 'cooldown', message: '操作过于频繁，请稍后再试。' };
    }
    this.recentTriggers.set(key, Date.now());
    if (this.recentTriggers.size > 100) {
      const now = Date.now();
      for (const [k, v] of this.recentTriggers) {
        if (now - v > DiscordShareService.TRIGGER_COOLDOWN_MS * 2) this.recentTriggers.delete(k);
      }
    }

    const session = this.createSession(interaction, user, guildId, channelId);
    if (!session) {
      return {
        status: 'provider_unavailable',
        message: '暂时没有可用的音视频服务，请联系管理员在管理面板配置 Agora 凭证。',
      };
    }

    const publicDomain = (serverConfig.publicDomain || '').replace(/\/+$/, '');
    return { status: 'ok', shareUrl: `${publicDomain}/share?t=${session.token}` };
  }

  private createSession(
    interaction: DiscordInteraction,
    user: { id: string; username: string },
    guildId: string,
    channelId: string,
  ) {
    try {
      return this.sessionService.createSession({
        sharerUserId: user.id,
        sharerUsername: user.username || '用户',
        guildId,
        targetChannelId: channelId,
        serverId: guildId,
      });
    } catch (e) {
      if (e instanceof ProviderUnavailableError) {
        this.logger.warn(`Discord: no usable provider for guild=${guildId}: ${e.code}`);
        return null;
      }
      throw e;
    }
  }

  private getServerConfig(guildId: string) {
    const server = this.db.getServer(guildId);
    if (!server) return null;
    if (!server.bound) return null;
    if (server.status && server.status !== 'active') return null;
    const cfg = this.db.getGlobalConfig();
    return {
      publicDomain: server.publicDomain || cfg.publicDomain || '',
      triggerWords: server.triggerWords || '',
    };
  }

  /**
   * 触发词匹配。Discord 的斜杠命令本身就是显式触发，
   * 但保留这个方法让「普通消息里含触发词」也能工作（需 Message Content Intent）。
   */
  matchesTrigger(content: string, triggerWords: string): boolean {
    const words = triggerWords
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean);
    if (!words.length) return false;
    return words.some((w) => content.includes(w));
  }
}
