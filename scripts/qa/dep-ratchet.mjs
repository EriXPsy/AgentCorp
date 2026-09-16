#!/usr/bin/env node
/**
 * scripts/qa/dep-ratchet.mjs — 依赖规则棘轮（refactor PR-1）。
 *
 * 跑 dependency-cruiser 输出 JSON，统计违规总数（新层级规则 + 老规则），
 * 与 scripts/qa/dep-baseline.json 基线比对：只减不增，超出即 exit 1。
 * 存量违规是历史债，棘轮保证不新增；拆分 PR 合入 → 数字下降后更新快照。
 *
 * 用法：node scripts/qa/dep-ratchet.mjs           # 检查模式
 *       node scripts/qa/dep-ratchet.mjs --update   # 重新生成基线快照
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const baselinePath = join(root, 'scripts/qa/dep-baseline.json');
const env = { ...process.env };
delete env.NODE_OPTIONS;

const args = [
  '--config', join(root, '.dependency-cruiser.cjs'),
  '--output-type', 'json',
  'src', 'electron', 'shared',
];

let raw;
try {
  // Windows：node_modules/.bin/depcruise 是 sh shim/.CMD，须经 shell 解析（execFile 不行）。
  const bin = process.platform === 'win32'
    ? `${root}\\node_modules\\.bin\\depcruise.CMD`
    : join(root, 'node_modules/.bin/depcruise');
  raw = execFileSync(bin, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
} catch (err) {
  // depcruise 有违规时 exit 非 0，但 JSON 已在 stdout —— 捕获后继续解析。
  raw = err.stdout || '';
  if (!raw.trim()) {
    console.error('dep-ratchet: depcruise failed to produce output');
    console.error(String(err.stderr || err.message).slice(0, 2000));
    process.exit(1);
  }
}

const report = JSON.parse(raw);
const violations = (report.summary && report.summary.violations) || [];
const byRule = {};
for (const v of violations) {
  byRule[v.rule.name] = (byRule[v.rule.name] || 0) + 1;
}
const total = violations.length;

if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, JSON.stringify({ total, byRule }, null, 2) + '\n');
  console.log(`dep-ratchet: baseline updated → ${total} violations`);
  for (const [rule, n] of Object.entries(byRule)) console.log(`  ${n}  ${rule}`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error('dep-ratchet: baseline missing, run `node scripts/qa/dep-ratchet.mjs --update` first');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
if (total > baseline.total) {
  console.error(`dep-ratchet: FAIL — ${total} violations (baseline ${baseline.total}, only decrease allowed)`);
  for (const [rule, n] of Object.entries(byRule)) {
    const was = baseline.byRule[rule] || 0;
    if (n > was) console.error(`  +${n - was}  ${rule}`);
  }
  process.exit(1);
}
console.log(`dep-ratchet: OK — ${total}/${baseline.total} violations (ratchet)`);
for (const [rule, n] of Object.entries(byRule)) console.log(`  ${n}  ${rule}`);
