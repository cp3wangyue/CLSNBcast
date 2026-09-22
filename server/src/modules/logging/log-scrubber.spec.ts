import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installLogScrubber, scrubString } from './log-scrubber';

/**
 * 脱敏器测试。
 *
 * 注意：环境值在模块加载时读取一次，因此这里同时验证
 * 「已知值脱敏」与「按形状兜底」两条路径。
 */
describe('scrubString', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['SUPER_ADMIN_PASSWORD', 'SECRET_ENCRYPTION_KEY', 'KOOK_BOT_TOKEN']) {
      envBackup[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(envBackup)) {
      if (envBackup[key] === undefined) delete process.env[key];
      else process.env[key] = envBackup[key];
    }
  });

  it('打码 32 位十六进制串（声网 App ID / 随机密钥形状）', () => {
    const appId = '0123456789abcdef0123456789abcdef';
    expect(scrubString(`appId=${appId}`)).not.toContain(appId);
    expect(scrubString(`appId=${appId}`)).toContain('***');
  });

  it('打码 64 位十六进制串', () => {
    const key = 'a'.repeat(64);
    expect(scrubString(`key: ${key}`)).not.toContain(key);
  });

  it('打码 JWT（三段，eyJ 开头）', () => {
    const jwt =
      'eyJyb2xlIjoic3VwZXIiLCJleHAiOjE3OTA2MjI0MDJ9' +
      '.bnoH4-QcGXtZcpuRZNGFmyFseTHC-2ReW4dS7GRSGbA' +
      '.sigpart12345678';
    expect(scrubString(`token=${jwt}`)).not.toContain(jwt);
  });

  it('key=value 形态保留键名，只打码值', () => {
    const out = scrubString('SUPER_ADMIN_PASSWORD=hunter2secret');
    expect(out).toContain('SUPER_ADMIN_PASSWORD');
    expect(out).not.toContain('hunter2secret');
    expect(out).toContain('***');
  });

  it('不破坏普通文本', () => {
    const text = 'session session-1 ended: reason=manual';
    expect(scrubString(text)).toBe(text);
  });

  it('短十六进制串不会被误杀（如 "abc123"）', () => {
    expect(scrubString('user abc123 joined')).toBe('user abc123 joined');
  });

  it('不含秘密时原样返回', () => {
    const text = 'clsnbcast server running on http://localhost:3520';
    expect(scrubString(text)).toBe(text);
  });

  it('🔒 已知秘密名即使值很短也不回显（走兜底模式）', () => {
    const out = scrubString('KOOK_BOT_TOKEN=abcd');
    expect(out).not.toContain('abcd');
  });
});

describe('installLogScrubber', () => {
  let originalLog: typeof console.log;

  beforeEach(() => {
    // Vitest 自身也会包装 console，因此每个用例都单独存取，避免跨用例污染
    originalLog = console.log;
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it('包装 console 并脱敏输出', () => {
    const seen: string[] = [];
    // 先替换 console.log，再安装脱敏器：
    // 脱敏器会包装这个捕获函数，于是我们能直接观察到它传下去的（已脱敏的）参数。
    console.log = ((...args: unknown[]) => { seen.push(args.join(' ')); }) as typeof console.log;
    const restore = installLogScrubber();
    console.log(`cert=${'fedcba9876543210fedcba9876543210'}`);
    restore();

    const out = seen.join('\n');
    expect(out).not.toContain('fedcba9876543210fedcba9876543210');
    expect(out).toContain('***');
  });

  it('还原后恢复安装前的 console', () => {
    const before = console.log;
    const restore = installLogScrubber();
    expect(console.log).not.toBe(before);
    restore();
    expect(console.log).toBe(before);
  });
});
