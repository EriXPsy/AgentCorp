/**
 * agency-agents-zh 桥接解析器（纯函数 · 浏览器安全）
 * --------------------------------------------------------------------------
 * 把外部开源角色库 `jnMetaCode/agency-agents-zh`（MIT）的 Markdown 人格文件，
 * 解析为 AgentCorp 的 `CandidateRoleCard`（只读候选卡）。
 *
 * 设计要点：
 *  - 纯函数、零运行时依赖、不 import `fs` —— 可在浏览器 Demo / vitest 中直接跑。
 *  - 只做「解析投影」，不做评价；Skill / 能力评估由 AgentCorp 自身闭环负责。
 *  - 解析逻辑与构建脚本 `scripts/gen-agency-candidates.mjs` 保持一致（一处改两处改）。
 *
 * 接入的外部仓库结构（已核实 2026-08-13）：
 *  - 角色文件位于 20 个部门目录（academic/design/engineering/.../testing），
 *    每个文件含 YAML frontmatter（name/description/emoji/color）+ 正文 `## ` 小节。
 *  - 正文小节标题因角色而异，故用「子串锚点」提取（规则 / 交付物 / 流程），
 *    未命中的角色以完整 `persona` 兜底，不丢信息。
 */

import type {
  CandidateRoleCard,
  CandidateOrigin,
  CandidateProvenance,
} from './candidateRoleCard';
import { DEPARTMENT_LABELS } from './candidateRoleCard';

/** 接入的外部仓库标识（MIT 合规溯源硬字段）。 */
export const AGENCY_AGENTS_SOURCE_REPO = 'jnMetaCode/agency-agents-zh';
export const AGENCY_AGENTS_UPSTREAM = 'msitarzewski/agency-agents';
/** 接入 AgentCorp 的日期（ISO），用于版本溯源。 */
export const AGENCY_AGENTS_INTEGRATED_AT = '2026-08-13';

/** 角色所在的 20 个部门目录（不含 integrations/examples/scripts/assets 等非角色目录）。 */
export const AGENCY_AGENTS_DEPARTMENTS: readonly string[] = [
  'academic', 'design', 'engineering', 'finance', 'game-development', 'gis', 'hr',
  'legal', 'marketing', 'paid-media', 'product', 'project-management', 'sales',
  'security', 'spatial-computing', 'specialized', 'strategy', 'supply-chain',
  'support', 'testing',
];

/** persona 截断上限，控制候选包体积（完整定义留源仓库）。 */
export const PERSONA_CAP = 2000;
/** 细分字段（规则/交付物/流程）各自截断上限。 */
export const SUBSET_CAP = 800;

/** 解析 YAML frontmatter（仅标量字段 name/description/emoji/color）。无 frontmatter 返回 null。 */
export function parseFrontmatter(md: string): { fm: Record<string, string>; body: string } | null {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (mm) fm[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fm, body: md.slice(m[0].length) };
}

/** 把正文按 `## ` 切成小节，返回 { title, text } 列表。 */
export function splitSections(body: string): { title: string; text: string }[] {
  const lines = body.split(/\r?\n/);
  const sections: { title: string; text: string }[] = [];
  let cur: { title: string; text: string } | null = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      cur = { title: h[1].trim(), text: '' };
      sections.push(cur);
    } else if (cur) {
      cur.text += line + '\n';
    }
  }
  return sections;
}

function joinSections(sections: { title: string; text: string }[], pred: (t: string) => boolean): string {
  return sections
    .filter((s) => pred(s.title))
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/** 由文件名（去 .md）生成候选 id，如 `engineering-security-engineer.md` → `engineering-security-engineer`。 */
export function toCandidateId(fileName: string): string {
  return fileName.replace(/\.md$/i, '');
}

/**
 * 解析单个角色 Markdown → CandidateRoleCard。
 * @param md         完整文件文本
 * @param opts.fileRelPath  相对仓库根的路径，如 `engineering/engineering-security-engineer.md`
 * @param opts.department   部门目录名（缺省从 fileRelPath 推断）
 * @param opts.origin       来源性质（翻译/原创），缺省 unknown
 * @returns 无 frontmatter 或无 `name` 时返回 null（视为非角色文件，跳过）
 */
export function parseAgentFile(
  md: string,
  opts: { fileRelPath: string; department?: string; origin?: CandidateOrigin },
): CandidateRoleCard | null {
  const parsed = parseFrontmatter(md);
  if (!parsed) return null;
  const { fm, body } = parsed;
  if (!fm.name) return null;

  // 去掉正文首个 `# ` H1（与 title 重复）
  const personaBody = body.replace(/^\s*#\s+.*\r?\n/, '');
  const sections = splitSections(personaBody);

  const department = opts.department ?? (opts.fileRelPath.split('/')[0] || 'unknown');
  const provenance: CandidateProvenance = {
    sourceRepo: AGENCY_AGENTS_SOURCE_REPO,
    license: 'MIT',
    upstream: AGENCY_AGENTS_UPSTREAM,
    origin: opts.origin ?? 'unknown',
    fileRelPath: opts.fileRelPath,
    integratedAt: AGENCY_AGENTS_INTEGRATED_AT,
  };

  let persona = personaBody.trim();
  if (persona.length > PERSONA_CAP) {
    persona = persona.slice(0, PERSONA_CAP) + `\n\n…（已截断，完整定义见源仓库 ${opts.fileRelPath}）`;
  }
  // 细分字段始终提取（persona 的子集），各按 SUBSET_CAP 截断
  let boundaries = joinSections(sections, (t) => t.includes('规则'))
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  let bTotal = 0;
  boundaries = boundaries.filter((line) => {
    if (bTotal + line.length > SUBSET_CAP) return false;
    bTotal += line.length;
    return true;
  });
  const deliverables = joinSections(sections, (t) => t.includes('交付物')).slice(0, SUBSET_CAP);
  const workflow = joinSections(sections, (t) => t.includes('流程') || t.includes('工作流')).slice(0, SUBSET_CAP);

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
    provenance,
  };
}
