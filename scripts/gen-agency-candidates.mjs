/**
 * gen-agency-candidates.mjs —— 把克隆的 agency-agents-zh 角色库解析为 AgentCorp 候选包
 * --------------------------------------------------------------------------
 * 用法（在 agentcorp-fresh 根目录）：
 *   node scripts/gen-agency-candidates.mjs [repoDir]
 *   repoDir 缺省为 ../../agency-agents-zh（即 YouAreFired/agency-agents-zh）
 *
 * 产物：src/demo/data/agencyAgentsCandidates.ts
 *   —— 导出 AGENCY_AGENTS_CANDIDATES: CandidateRoleCard[]，供浏览器 Demo / 测试直接 import。
 *
 * 解析逻辑必须与 src/engine/agents/agencyAgentsBridge.ts 的 parseAgentFile 保持一致。
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPO_DIR = process.argv[2] ? resolve(process.argv[2]) : resolve(__dirname, '../../agency-agents-zh');
const OUT_FILE = resolve(ROOT, 'src/demo/data/agencyAgentsCandidates.ts');

const SOURCE_REPO = 'jnMetaCode/agency-agents-zh';
const UPSTREAM = 'msitarzewski/agency-agents';
const INTEGRATED_AT = '2026-08-13';

const DEPARTMENTS = [
  'academic', 'design', 'engineering', 'finance', 'game-development', 'gis', 'hr',
  'legal', 'marketing', 'paid-media', 'product', 'project-management', 'sales',
  'security', 'spatial-computing', 'specialized', 'strategy', 'supply-chain',
  'support', 'testing',
];

const DEPARTMENT_LABELS = {
  academic: '学术', design: '设计', engineering: '工程', finance: '金融',
  'game-development': '游戏开发', gis: 'GIS', hr: '人力资源', integrations: '工具集成',
  legal: '法务', marketing: '营销', 'paid-media': '付费媒体', product: '产品',
  'project-management': '项目管理', sales: '销售', security: '安全',
  'spatial-computing': '空间计算', specialized: '专项', strategy: '战略',
  'supply-chain': '供应链', support: '支持', testing: '测试',
};

// ---- 解析逻辑（镜像 bridge） ----
const PERSONA_CAP = 2000; // persona 截断上限，控制包体积（完整定义留源仓库）
const SUBSET_CAP = 800;   // 细分字段（规则/交付物/流程）各自截断上限

function cap(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (mm) fm[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fm, body: md.slice(m[0].length) };
}

function splitSections(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) { cur = { title: h[1].trim(), text: '' }; sections.push(cur); }
    else if (cur) cur.text += line + '\n';
  }
  return sections;
}

function joinSections(sections, pred) {
  return sections.filter((s) => pred(s.title)).map((s) => s.text.trim()).filter(Boolean).join('\n\n').trim();
}

function toCandidateId(fileName) { return fileName.replace(/\.md$/i, ''); }

function parseAgentFile(md, opts) {
  const parsed = parseFrontmatter(md);
  if (!parsed) return null;
  const { fm, body } = parsed;
  if (!fm.name) return null;
  const personaBody = body.replace(/^\s*#\s+.*\r?\n/, '');
  const sections = splitSections(personaBody);
  const department = opts.department ?? (opts.fileRelPath.split('/')[0] || 'unknown');

  let persona = personaBody.trim();
  if (persona.length > PERSONA_CAP) {
    persona = persona.slice(0, PERSONA_CAP) + `\n\n…（已截断，完整定义见源仓库 ${opts.fileRelPath}）`;
  }
  // 细分字段始终提取（它们是 persona 的子集，按 SUBSET_CAP 截断，避免冗余放大体积）
  let boundaries = joinSections(sections, (t) => t.includes('规则'))
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let bTotal = 0;
  boundaries = boundaries.filter((line) => {
    if (bTotal + line.length > SUBSET_CAP) return false;
    bTotal += line.length;
    return true;
  });
  const deliverables = cap(joinSections(sections, (t) => t.includes('交付物')), SUBSET_CAP);
  const workflow = cap(joinSections(sections, (t) => t.includes('流程') || t.includes('工作流')), SUBSET_CAP);

  return {
    id: toCandidateId(opts.fileRelPath.split('/').pop() ?? fm.name),
    title: fm.name,
    summary: fm.description ?? '',
    department,
    departmentLabel: DEPARTMENT_LABELS[department],
    emoji: fm.emoji || undefined,
    color: fm.color || undefined,
    persona,
    boundaries,
    deliverables,
    workflow,
    provenance: {
      sourceRepo: SOURCE_REPO, license: 'MIT', upstream: UPSTREAM,
      origin: opts.origin ?? 'unknown', fileRelPath: opts.fileRelPath, integratedAt: INTEGRATED_AT,
    },
  };
}

function parseAgentListOriginMap(agentListMd) {
  const map = {};
  for (const line of agentListMd.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cols = line.split('|').slice(1, -1).map((c) => c.trim().replace(/`/g, ''));
    if (cols.length < 4) continue;
    const id = toCandidateId(cols[0]);
    if (!id || id.toLowerCase() === 'agent id') continue;
    const originCol = cols[3] ?? '';
    let origin = 'unknown';
    if (originCol.includes('原创')) origin = 'china-original';
    else if (originCol.includes('翻译')) origin = 'translated';
    map[id] = origin;
  }
  return map;
}

// ---- 遍历仓库 ----
function collectRoleFiles(dir) {
  const out = [];
  const walk = (p) => {
    let entries;
    try { entries = readdirSync(p); } catch { return; }
    for (const e of entries) {
      const full = join(p, e);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (e.endsWith('.md') && !/^(README|CATALOG|AGENT-LIST|UPSTREAM|CONTRIBUTING)/i.test(e)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function main() {
  if (!existsSync(REPO_DIR)) {
    console.error(`[gen-agency-candidates] 找不到仓库目录: ${REPO_DIR}`);
    process.exit(1);
  }
  const agentListPath = join(REPO_DIR, 'AGENT-LIST.md');
  const originMap = existsSync(agentListPath) ? parseAgentListOriginMap(readFileSync(agentListPath, 'utf8')) : {};

  const candidates = [];
  const byDepartment = {};
  let skipped = 0;

  for (const dept of DEPARTMENTS) {
    const deptDir = join(REPO_DIR, dept);
    for (const f of collectRoleFiles(deptDir)) {
      const md = readFileSync(f, 'utf8');
      const fileRelPath = relative(REPO_DIR, f).split(/[\\/]/).join('/');
      const card = parseAgentFile(md, {
        fileRelPath, department: dept,
        origin: originMap[toCandidateId(f.split(/[\\/]/).pop() ?? '')],
      });
      if (!card) { skipped++; continue; }
      candidates.push(card);
      byDepartment[dept] = (byDepartment[dept] ?? 0) + 1;
    }
  }
  candidates.sort((a, b) => (a.department + a.id).localeCompare(b.department + b.id));

  const header = `/**
 * AUTO-GENERATED by scripts/gen-agency-candidates.mjs — 不要手改。
 * ----------------------------------------------------------------------
 * 数据来源：agency-agents-zh（${SOURCE_REPO}），许可证 MIT。
 * 上游英文项目：${UPSTREAM}。接入日期：${INTEGRATED_AT}。
 *
 * MIT 合规：本文件中的角色定义版权归 agency-agents-zh 原作者所有，
 * 以 MIT 许可证授权复用。AgentCorp 仅做解析投影，不主张这些角色定义的著作权。
 * 完整许可证见仓库根 THIRD_PARTY_LICENSES。
 *
 * 重新生成：node scripts/gen-agency-candidates.mjs
 */
import type { CandidateRoleCard } from '../../engine/agents/candidateRoleCard';

export const AGENCY_AGENTS_CANDIDATES: CandidateRoleCard[] =
  ${JSON.stringify(candidates, null, 0)} as CandidateRoleCard[];

export const AGENCY_AGENTS_COUNT = AGENCY_AGENTS_CANDIDATES.length;
`;

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, header, 'utf8');

  console.log(`[gen-agency-candidates] 已生成 ${candidates.length} 个候选（跳过 ${skipped}）`);
  console.log('[gen-agency-candidates] 按部门:', JSON.stringify(byDepartment, null, 0));
  console.log(`[gen-agency-candidates] 输出: ${OUT_FILE}`);
}

main();
