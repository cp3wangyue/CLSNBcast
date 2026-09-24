/**
 * Discord 消息内容构建。
 *
 * KOOK 的 `card-builder.ts` 产出 KMarkdown 卡片数组，Discord 不认这个格式
 * （Discord 用 embed / 纯文本），因此这里独立建一套，不复用 KOOK 的。
 *
 * 刻意只产出**纯数据**（`{ content, embeds }`），不发起任何网络调用，
 * 便于测试，也让发送端可替换。
 *
 * 参考：https://discord.com/developers/docs/resources/message
 */

/** Discord embed 颜色（与 KOOK 卡片 theme 对应） */
const COLOR = {
  /** 进行中（对应 KOOK 的 success） */
  live: 0x2ecc71,
  /** 已结束（对应 KOOK 的 secondary） */
  ended: 0x95a5a6,
} as const;

export interface DiscordMessagePayload {
  content?: string;
  embeds?: Array<{
    title: string;
    description: string;
    color: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
  }>;
}

/** 发布端真正开始共享后，发到公开频道的观看卡片 */
export function buildDiscordViewingCard(opts: {
  sharerUsername: string;
  viewUrl: string;
}): DiscordMessagePayload {
  const name = opts.sharerUsername || '用户';
  return {
    embeds: [
      {
        title: '🖥 屏幕共享进行中',
        description: `${name} 正在共享屏幕，点击下方链接观看。`,
        color: COLOR.live,
      },
    ],
    content: `观看链接：${opts.viewUrl}`,
  };
}

/** 共享结束后更新公开卡片 */
export function buildDiscordEndedCard(opts: {
  sharerUsername: string;
  totalViewerJoins: number;
  durationMs: number | null;
  standardMinutes: number;
  estimatedCost: number;
}): DiscordMessagePayload {
  const name = opts.sharerUsername || '匿名用户';
  const totalSeconds = opts.durationMs ? Math.max(0, Math.round(opts.durationMs / 1000)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const durationText =
    hours > 0 ? `${hours} 小时 ${minutes} 分 ${seconds} 秒` : minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;

  return {
    embeds: [
      {
        title: '📴 屏幕共享已结束',
        description: `${name} 的共享已结束。`,
        color: COLOR.ended,
        fields: [
          { name: '时长', value: durationText, inline: true },
          { name: '观看人次', value: String(opts.totalViewerJoins ?? 0), inline: true },
          { name: '标准分钟', value: String(opts.standardMinutes ?? 0), inline: true },
          { name: '预估费用', value: `${(opts.estimatedCost ?? 0).toFixed(2)} 元`, inline: true },
        ],
      },
    ],
  };
}
