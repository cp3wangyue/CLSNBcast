import { createHash, timingSafeEqual } from 'crypto';

/**
 * 常量时间字符串比较。
 *
 * 直接用 `a === b` 会在第一个不同字节处提前返回，理论上让攻击者通过响应时间差异
 * 逐字节猜出签名/HMAC。比较前先各自哈希成固定长度，再用 `timingSafeEqual`：
 * 长度不再泄漏信息，`timingSafeEqual` 也不会因长度不等而抛错。
 */
export function safeEqual(actual: string, expected: string): boolean {
  const a = createHash('sha256').update(String(actual), 'utf8').digest();
  const b = createHash('sha256').update(String(expected), 'utf8').digest();
  return timingSafeEqual(a, b);
}
