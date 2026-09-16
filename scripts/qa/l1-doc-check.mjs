#!/usr/bin/env node
/**
 * scripts/qa/l1-doc-check.mjs — L1 域入口文档头检查器（refactor PR-1）。
 *
 * 读取 scripts/qa/l1-domains.json（已登记域路径数组），对每个域的 index.ts
 * 校验头部注释块含 @domain / @purpose / @behaviors / @dive 四个结构化标记
 * （存在性检查，内容质量由评审抽检承担）。
 *
 * 本 PR 域清单为空（[]）—— 空跑验证管线，PR-2 起随域拆分逐域登记。
 *
 * 用法：node scripts/qa/l1-doc-check.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const domainsPath = join(root, 'scripts/qa/l1-domains.json');

if (!existsSync(domainsPath)) {
  console.error('l1-doc-check: scripts/qa/l1-domains.json missing');
  process.exit(1);
}
const domains = JSON.parse(readFileSync(domainsPath, 'utf8'));

const REQUIRED = ['@domain', '@purpose', '@behaviors', '@dive'];
let failed = 0;

for (const domain of domains) {
  const entry = join(root, domain, 'index.ts');
  if (!existsSync(entry)) {
    console.error(`l1-doc-check: FAIL — ${domain}/index.ts not found`);
    failed += 1;
    continue;
  }
  const head = readFileSync(entry, 'utf8').split(/^export |^import /m)[0];
  const missing = REQUIRED.filter((tag) => !head.includes(tag));
  if (missing.length > 0) {
    console.error(`l1-doc-check: FAIL — ${domain}/index.ts missing ${missing.join(', ')}`);
    failed += 1;
  } else {
    console.log(`l1-doc-check: OK — ${domain}`);
  }
}

if (failed > 0) process.exit(1);
console.log(`l1-doc-check: ${domains.length - failed}/${domains.length} domains pass`);
