import { describe, it, expect } from 'vitest';
import {
  buildDiscordViewingCard,
  buildDiscordEndedCard,
} from './discord-message-builder';

describe('buildDiscordViewingCard', () => {
  it('包含观看链接与发起人', () => {
    const p = buildDiscordViewingCard({
      sharerUsername: 'alice',
      viewUrl: 'https://example.com/view?t=TOKEN',
    });
    expect(p.content).toContain('https://example.com/view?t=TOKEN');
    expect(p.embeds?.[0].description).toContain('alice');
  });

  it('用户名为空时不显示 undefined', () => {
    const p = buildDiscordViewingCard({ sharerUsername: '', viewUrl: 'https://x/y' });
    expect(JSON.stringify(p)).not.toContain('undefined');
  });

  it('进行中用 live 颜色', () => {
    const p = buildDiscordViewingCard({ sharerUsername: 'a', viewUrl: 'https://x' });
    expect(p.embeds?.[0].color).toBe(0x2ecc71);
  });
});

describe('buildDiscordEndedCard', () => {
  it('时长按 时/分/秒 格式化', () => {
    const p = buildDiscordEndedCard({
      sharerUsername: 'bob',
      totalViewerJoins: 3,
      durationMs: 3_661_000, // 1h1m1s
      standardMinutes: 12,
      estimatedCost: 0.084,
    });
    const dur = p.embeds?.[0].fields?.find((f) => f.name === '时长')?.value;
    expect(dur).toBe('1 小时 1 分 1 秒');
  });

  it('不足一小时只显示分秒', () => {
    const p = buildDiscordEndedCard({
      sharerUsername: 'bob',
      totalViewerJoins: 0,
      durationMs: 65_000,
      standardMinutes: 1,
      estimatedCost: 0,
    });
    const dur = p.embeds?.[0].fields?.find((f) => f.name === '时长')?.value;
    expect(dur).toBe('1 分 5 秒');
  });

  it('durationMs 为 null 时时长为 0 秒，不显示 NaN', () => {
    const p = buildDiscordEndedCard({
      sharerUsername: 'bob',
      totalViewerJoins: 0,
      durationMs: null,
      standardMinutes: 0,
      estimatedCost: 0,
    });
    const dur = p.embeds?.[0].fields?.find((f) => f.name === '时长')?.value;
    expect(dur).toBe('0 秒');
    expect(JSON.stringify(p)).not.toContain('NaN');
  });

  it('含观看人次 / 标准分钟 / 预估费用字段', () => {
    const p = buildDiscordEndedCard({
      sharerUsername: 'bob',
      totalViewerJoins: 7,
      durationMs: 1000,
      standardMinutes: 42,
      estimatedCost: 0.294,
    });
    const names = p.embeds?.[0].fields?.map((f) => f.name);
    expect(names).toEqual(['时长', '观看人次', '标准分钟', '预估费用']);
    const cost = p.embeds?.[0].fields?.find((f) => f.name === '预估费用')?.value;
    expect(cost).toBe('0.29 元');
  });

  it('数值缺失时补 0 而不是 undefined/NaN', () => {
    const p = buildDiscordEndedCard({
      sharerUsername: '',
      totalViewerJoins: undefined as any,
      durationMs: null,
      standardMinutes: undefined as any,
      estimatedCost: undefined as any,
    });
    const json = JSON.stringify(p);
    expect(json).not.toContain('undefined');
    expect(json).not.toContain('NaN');
  });

  it('结束用 ended 颜色，与进行中区分', () => {
    const p = buildDiscordEndedCard({
      sharerUsername: 'a',
      totalViewerJoins: 0,
      durationMs: 0,
      standardMinutes: 0,
      estimatedCost: 0,
    });
    expect(p.embeds?.[0].color).toBe(0x95a5a6);
  });
});
