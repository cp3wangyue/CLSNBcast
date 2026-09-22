/**
 * 秘密脱敏。
 *
 * 目标：**任何**日志都不能出现秘密明文 —— 包括将来不小心写下的调试日志。
 *
 * 做法是在进程级别包一层 console：把已知的敏感值替换成 `***`，
 * 并按常见模式（长随机串、JWT、base64 块）兜底。它不是安全边界（服务端本就持有明文），
 * 而是防止"日志/崩溃转储/日志采集系统"把秘密带出去。
 */
const REDACTED = '***';

/** 需要按值脱敏的秘密。启动时读取一次；环境变量为空则忽略。 */
const secretNames = [
  'SUPER_ADMIN_PASSWORD',
  'SECRET_ENCRYPTION_KEY',
  'KOOK_BOT_TOKEN',
  'KOOK_VERIFY_TOKEN',
  'KOOK_ENCRYPT_KEY',
];

function collectSecretValues(): string[] {
  const values: string[] = [];
  for (const name of secretNames) {
    const value = process.env[name];
    if (value && value.length >= 6) values.push(value);
  }
  return values;
}

const secretValues = collectSecretValues();

/**
 * 兜底模式：识别看起来像凭证的字符串。
 * 只匹配"高置信度"的形状，避免把普通文本打码影响可读性。
 */
const SUSPICIOUS_PATTERNS: RegExp[] = [
  // JWT
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  // 32/64 位十六进制（声网 App ID / 常见随机密钥）
  /\b[0-9a-fA-F]{32}(?:[0-9a-fA-F]{32})?\b/g,
  // key=value / "key":"value" 形态的已知秘密名
  /(SUPER_ADMIN_PASSWORD|SECRET_ENCRYPTION_KEY|KOOK_BOT_TOKEN|KOOK_VERIFY_TOKEN|KOOK_ENCRYPT_KEY)\s*[=:]\s*["']?[^"'\s,}]{4,}/gi,
];

function scrubString(input: string): string {
  let output = input;
  for (const secret of secretValues) {
    if (output.includes(secret)) {
      // split/join 比 replace 安全：不需要处理正则元字符
      output = output.split(secret).join(REDACTED);
    }
  }
  for (const pattern of SUSPICIOUS_PATTERNS) {
    output = output.replace(pattern, (match) => {
      // key=value 形态保留键名，只打码值
      const eq = match.search(/[=:]/);
      if (eq > 0) return `${match.slice(0, eq + 1)} ${REDACTED}`;
      return REDACTED;
    });
  }
  return output;
}

/** 安装日志脱敏。返回还原函数（仅测试需要）。 */
export function installLogScrubber(): () => void {
  // 保存**原始函数引用本身**，而不是 `fn.bind(console)`。
  // 绑定产生的副本与原始引用不相等，会让「还原」留下一个包装层，
  // 多次安装 / 还原后层层叠加，也让调用方无法用引用相等判断还原是否成功。
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  const wrap = (fn: (...args: unknown[]) => void) =>
    function scrubbedConsole(...args: unknown[]) {
      const scrubbed = args.map((arg) =>
        typeof arg === 'string' ? scrubString(arg) : arg,
      );
      return fn.apply(console, scrubbed);
    } as typeof console.log;

  console.log = wrap(originals.log);
  console.info = wrap(originals.info);
  console.warn = wrap(originals.warn);
  console.error = wrap(originals.error);

  return () => {
    console.log = originals.log;
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
  };
}

export { scrubString };
