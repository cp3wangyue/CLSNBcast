import { describe, expect, it } from 'vitest';
import { cn, formatTime } from './utils';

describe('cn', () => {
  it('拼接字符串类名', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('跳过假值（false / undefined / null / 空串）', () => {
    expect(cn('a', false, undefined, null, '', 'c')).toBe('a c');
  });

  it('支持条件对象形式', () => {
    expect(cn('base', { active: true, hidden: false })).toBe('base active');
  });

  it('用 tailwind-merge 消解冲突的 Tailwind 类，后者胜出', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
    // 组件默认样式可被调用方覆盖，这是 cn 存在的意义
    expect(cn('px-4 py-2', 'px-6')).toBe('py-2 px-6');
  });

  it('保留非冲突的 Tailwind 类', () => {
    expect(cn('flex items-center', 'gap-2')).toBe('flex items-center gap-2');
  });
});

describe('formatTime', () => {
  it('null 返回占位符', () => {
    expect(formatTime(null)).toBe('-');
  });

  it('0 视为空值，返回占位符', () => {
    expect(formatTime(0)).toBe('-');
  });

  it('把本地时间格式化为「月/日 时:分」', () => {
    // 使用本地时间构造，避免测试受运行环境时区影响
    const ts = new Date(2026, 8, 22, 14, 30).getTime(); // 2026-09-22 14:30（本地时间）
    const out = formatTime(ts);
    expect(out).toContain('09');
    expect(out).toContain('22');
    expect(out).toContain('14');
    expect(out).toContain('30');
  });
});
