#!/usr/bin/env node
/**
 * Lint 基线门禁。
 *
 * 为什么需要基线：存量代码里有 149 处 `any`（Express 中间件、KOOK 事件
 * payload 等），一次性改完风险太大。直接 `eslint --max-warnings 0`
 * 会让 CI 立刻失败且无法通过；完全不设限又挡不住新增。
 *
 * 折中：记录当前告警数为基线，**超过基线即失败**（新增的 any 会被拦下），
 * 存量不阻塞；随着逐步清理，把基线往下调即可。
 *
 * 用 ESLint 的 Node API 而不是 spawn 子进程：避免 Windows 下 npx/eslint
 * 可执行文件路径与引号转义的一系列问题。
 */
const path = require('path');
const fs = require('fs');

const SERVER_DIR = path.join(__dirname, '..');
const BASELINE_FILE = path.join(SERVER_DIR, '.eslint-baseline.json');
const DEFAULT_BASELINE = 149;

let baseline = DEFAULT_BASELINE;
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).warnings;
} catch {
  /* 基线文件缺失时用默认值 */
}

(async () => {
  const { ESLint } = require('eslint');
  const eslint = new ESLint({ cwd: SERVER_DIR });
  const results = await eslint.lintFiles(['src/**/*.ts']);

  let errors = 0;
  let warnings = 0;
  for (const file of results) {
    for (const m of file.messages || []) {
      if (m.severity === 2) errors++;
      else warnings++;
    }
  }

  console.log(`eslint: errors=${errors} warnings=${warnings} baseline=${baseline}`);

  if (errors > 0) {
    console.error(`\n❌ 存在 ${errors} 个 error 级问题，必须清零。`);
    process.exit(1);
  }

  if (warnings > baseline) {
    console.error(
      `\n❌ 告警数 ${warnings} 超过基线 ${baseline}（新增 ${warnings - baseline} 条）。\n` +
        '   请修复新增的问题；若是有意放宽，请同步更新 server/.eslint-baseline.json。',
    );
    process.exit(1);
  }

  if (warnings < baseline) {
    console.log(
      `\n✅ 告警数 ${warnings} 低于基线 ${baseline}（减少了 ${baseline - warnings} 条）。\n` +
        `   建议把 .eslint-baseline.json 下调到 ${warnings}，锁定这次清理成果。`,
    );
  } else {
    console.log('\n✅ 与基线持平，无新增问题。');
  }
})().catch((e) => {
  console.error('lint gate failed:', e && e.message);
  process.exit(1);
});
