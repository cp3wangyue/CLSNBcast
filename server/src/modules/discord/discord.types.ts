/**
 * Discord 交互的类型定义（只声明本项目用到的字段）。
 *
 * Discord 的交互模型与 KOOK 不同：
 * - KOOK 是「消息事件 + 卡片按钮回调」；
 * - Discord 是「Interaction（斜杠命令 / 组件交互）」，且**必须在 3 秒内先 ACK**，
 *   后续内容通过 webhook 补发。
 *
 * 因此这里刻意只建模需要的部分，不追求覆盖全部官方字段。
 * 参考：https://discord.com/developers/docs/interactions/receiving-and-responding
 */

/** Interaction Type */
export const DISCORD_INTERACTION = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

/** Interaction Callback Type（初始响应的 type） */
export const DISCORD_RESPONSE = {
  /** 立即响应一条消息 */
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  /** 延迟响应（先 ACK，后续用 webhook 补发） */
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

/** 消息 flags */
export const DISCORD_MESSAGE_FLAG = {
  /** 只有触发者可见（对应 KOOK 的「临时卡片」语义） */
  EPHEMERAL: 1 << 6,
} as const;

export interface DiscordUser {
  id: string;
  username: string;
}

export interface DiscordMember {
  user?: DiscordUser;
}

export interface DiscordInteraction {
  id: string;
  type: number;
  /** 应用 ID（即 Bot 的 Application ID） */
  application_id: string;
  /** 交互发生的频道 */
  channel_id?: string;
  /** 所在的服务器（Guild）；私信场景为空 */
  guild_id?: string;
  /** 触发者：命令场景在 member.user，私信场景在 user */
  member?: DiscordMember;
  user?: DiscordUser;
  /** 用于后续补发消息的 token（不是我们的会话 token） */
  token: string;
  data?: {
    /** 命令名（type 2） */
    name?: string;
    /** 组件 custom_id（type 3） */
    custom_id?: string;
    /** 命令选项（本项目暂不用，但保留以便扩展） */
    options?: Array<{ name: string; value: unknown }>;
  };
}

/** 取触发者；两种场景都要兼容，否则私信里会拿到 undefined */
export function discordInteractionUser(i: DiscordInteraction): DiscordUser | undefined {
  return i.member?.user ?? i.user;
}
