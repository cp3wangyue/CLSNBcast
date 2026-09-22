import { describe, expect, it } from 'vitest';
import { safeEqual } from './safe-compare';

describe('safeEqual', () => {
  it('相同字符串返回 true', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('不同字符串返回 false', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });

  it('空字符串与空字符串相等', () => {
    expect(safeEqual('', '')).toBe(true);
  });

  it('🔒 长度不同时不抛错（timingSafeEqual 要求等长，这里已哈希成定长）', () => {
    expect(() => safeEqual('short', 'a-much-longer-string-that-differs-in-length')).not.toThrow();
    expect(safeEqual('short', 'a-much-longer-string-that-differs-in-length')).toBe(false);
  });

  it('仅在末尾不同也能识别（避免"前缀相同即通过"的实现错误）', () => {
    expect(safeEqual('eyJhbGciOiJIUzI1NiJ9.sig', 'eyJhbGciOiJIUzI1NiJ9.siG')).toBe(false);
  });

  it('大小写敏感', () => {
    expect(safeEqual('Token', 'token')).toBe(false);
  });

  it('非字符串输入被安全处理（哈希前先转字符串）', () => {
    // @ts-expect-error 测试运行期健壮性
    expect(safeEqual(123, 123)).toBe(true);
  });
});
