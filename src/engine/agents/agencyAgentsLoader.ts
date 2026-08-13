/**
 * agency-agents-zh 实时加载器（Node 专用 · 不进浏览器）
 * --------------------------------------------------------------------------
 * 遍历克隆到本地的 `agency-agents-zh` 仓库，把全部角色 .md 解析为
 * `CandidateRoleCard[]`。供「重新生成候选包」或「dev 期实时接入」使用，
 * **不要**在浏览器 Demo 中 import 本文件（依赖 `fs`）。
 *
 * 预生成的候选包见 `src/demo/data/agencyAgentsCandidates.ts`（由
 * `scripts/gen-agency-candidates.mjs` 产出），浏览器 Demo 与测试读它即可。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CandidateOrigin, CandidateRoleCard } from './candidateRoleCard';
import {
  AGENCY_AGENTS_DEPARTMENTS,
  parseAgentFile,
  toCandidateId,
} from './agencyAgentsBridge';

/**
 * 解析 AGENT-LIST.md 的表格，构建 `id → 来源` 映射。
 * 列格式：`| Agent ID | 中文名 | 描述 | 来源 |`，来源含「原创」→ china-original，
 * 含「翻译」→ translated，其余 unknown。
 */
export function parseAgentListOriginMap(agentListMd: string): Record<string, CandidateOrigin> {
  const map: Record<string, CandidateOrigin> = {};
  for (const line of agentListMd.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cols = line.split('|').slice(1, -1).map((c) => c.trim().replace(/`/g, ''));
    if (cols.length < 4) continue;
    const id = toCandidateId(cols[0]);
    if (!id || id.toLowerCase() === 'agent id') continue;
    const originCol = cols[3] ?? '';
    let origin: CandidateOrigin = 'unknown';
    if (originCol.includes('原创')) origin = 'china-original';
    else if (originCol.includes('翻译')) origin = 'translated';
    map[id] = origin;
  }
  return map;
}

/** 递归收集目录下所有 .md（排除 README/CATALOG/AGENT-LIST 等文档文件）。 */
function collectRoleFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    let entries: string[];
    try {
      entries = readdirSync(p);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(p, e);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (e.endsWith('.md') && !/^(README|CATALOG|AGENT-LIST|UPSTREAM|CONTRIBUTING)/i.test(e)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * 遍历克隆仓库，解析全部角色为候选卡。
 * @param repoDir  agency-agents-zh 仓库根目录（含 20 个部门子目录）
 * @param agentListPath  可选，AGENT-LIST.md 路径，用于补全来源
 */
export function loadAgencyAgents(
  repoDir: string,
  agentListPath?: string,
): { candidates: CandidateRoleCard[]; skipped: number; byDepartment: Record<string, number> } {
  const originMap: Record<string, CandidateOrigin> = {};
  if (agentListPath) {
    try {
      Object.assign(originMap, parseAgentListOriginMap(readFileSync(agentListPath, 'utf8')));
    } catch {
      /* 缺 AGENT-LIST 不致命，来源回退 unknown */
    }
  }

  const candidates: CandidateRoleCard[] = [];
  const byDepartment: Record<string, number> = {};
  let skipped = 0;

  for (const dept of AGENCY_AGENTS_DEPARTMENTS) {
    const deptDir = join(repoDir, dept);
    const files = collectRoleFiles(deptDir);
    for (const f of files) {
      const md = readFileSync(f, 'utf8');
      const fileRelPath = relative(repoDir, f).split(/[\\/]/).join('/');
      const card = parseAgentFile(md, {
        fileRelPath,
        department: dept,
        origin: originMap[toCandidateId(f.split(/[\\/]/).pop() ?? '')],
      });
      if (!card) {
        skipped++;
        continue;
      }
      candidates.push(card);
      byDepartment[dept] = (byDepartment[dept] ?? 0) + 1;
    }
  }

  // 稳定排序：按部门 + id
  candidates.sort((a, b) => (a.department + a.id).localeCompare(b.department + b.id));
  return { candidates, skipped, byDepartment };
}
