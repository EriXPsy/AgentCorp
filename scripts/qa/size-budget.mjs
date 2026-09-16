#!/usr/bin/env node
/**
 * scripts/qa/size-budget.mjs — 超大文件体积棘轮（refactor PR-1）。
 *
 * 统计 src/ electron/ shared/ 下非测试 .ts/.tsx 中 >600 行的文件数，
 * 与 scripts/qa/size-baseline.json 基线比对：只减不增，超出即 exit 1。
 * 拆分 PR 合入 → 基线数字应逐步下降（更新基线即提交快照）。
 *
 * 用法：node scripts/qa/size-budget.mjs           # 检查模式（CI/本地门禁）
 *       node scripts/qa/size-budget.mjs --update   # 重新生成基线快照
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const baselinePath = join(root, 'scripts/qa/size-baseline.json');
const THRESHOLD = 600;

/** 递归收集目录下全部文件（相对路径），不做 node_modules/产物过滤以外的事 */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = ['src', 'electron', 'shared'].flatMap((d) => walk(join(root, d)))
  .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts') && !/[\\/]tests?[\\/]/.test(f));

const over = files
  .map((f) => ({ file: f.slice(root.length + 1).replace(/\\/g, '/'), lines: readFileSync(f, 'utf8').split('\n').length }))
  .filter((x) => x.lines > THRESHOLD)
  .sort((a, b) => b.lines - a.lines);

if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, JSON.stringify({ threshold: THRESHOLD, count: over.length, files: over }, null, 2) + '\n');
  console.log(`size-budget: baseline updated → ${over.length} files > ${THRESHOLD} lines`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(`size-budget: baseline missing, run \`node scripts/qa/size-budget.mjs --update\` first`);
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
if (over.length > baseline.count) {
  console.error(`size-budget: FAIL — ${over.length} files > ${THRESHOLD} lines (baseline ${baseline.count}, only decrease allowed)`);
  for (const x of over.slice(0, 10)) console.error(`  ${x.lines}  ${x.file}`);
  process.exit(1);
}
console.log(`size-budget: OK — ${over.length}/${baseline.count} files > ${THRESHOLD} lines (ratchet)`);
