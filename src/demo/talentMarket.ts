/**
 * 人才市场（TalentMarket）—— AgentCorp 的「候选池」接入口
 * --------------------------------------------------------------------------
 * 把外部开源角色库（agency-agents-zh，MIT）解析出的 `CandidateRoleCard[]` 暴露为
 * 可检索的候选池，并映射到 HR 面试闭环的 `ClosedLoopRequest`。
 *
 * 关键定位（对齐整合设计文档）：
 *  - agency-agents 是「考生供给层」；本文件只负责「拉人 + 接线」，
 *    评价与决策仍由 AgentCorp 自身闭环（closedLoop + judgeEnsemble + boss_review）负责。
 *  - 与 4 张核心 RoleCard（boss/recruiter/evaluator/dispatcher）正交：候选卡是考生，
 *    核心卡是考官，不互相替换。
 *  - 数据来源须在 UI 标注（MIT 署名合规），见 `TALENT_MARKET_SOURCE`。
 */

import type { CandidateFilter, CandidateRoleCard } from '@/engine/agents/candidateRoleCard';
import { AGENCY_AGENTS_CANDIDATES } from './data/agencyAgentsCandidates';
import type { JudgeFn, ClosedLoopRequest } from './closedLoop';

/** 人才市场数据源（MIT 署名，供 UI 展示）。 */
export const TALENT_MARKET_SOURCE = {
  repo: 'jnMetaCode/agency-agents-zh',
  license: 'MIT',
  upstream: 'msitarzewski/agency-agents',
  integratedAt: '2026-08-13',
  count: AGENCY_AGENTS_CANDIDATES.length,
} as const;

/** 候选总数（268）。 */
export const CANDIDATE_COUNT = AGENCY_AGENTS_CANDIDATES.length;

/** 按条件过滤候选池。 */
export function listCandidates(filter?: CandidateFilter): CandidateRoleCard[] {
  let pool = AGENCY_AGENTS_CANDIDATES;
  if (filter?.department) {
    const d = filter.department.toLowerCase();
    pool = pool.filter((c) => c.department.toLowerCase() === d);
  }
  if (filter?.origin) {
    pool = pool.filter((c) => c.provenance.origin === filter.origin);
  }
  if (filter?.keyword) {
    const kw = filter.keyword.toLowerCase();
    pool = pool.filter(
      (c) =>
        c.title.toLowerCase().includes(kw) ||
        c.summary.toLowerCase().includes(kw) ||
        c.persona.toLowerCase().includes(kw),
    );
  }
  return pool;
}

/** 按 id 取单个候选。 */
export function getCandidate(id: string): CandidateRoleCard | undefined {
  return AGENCY_AGENTS_CANDIDATES.find((c) => c.id === id);
}

/**
 * 从候选池中选 1 个进入面试（确定性：过滤后取排序首条）。
 * @param filter   过滤条件（部门/来源/关键词）
 * @param preferOrigin  优先选中的来源（如 'china-original' 突出本土角色），找不到回退首条
 */
export function selectCandidate(
  filter?: CandidateFilter,
  preferOrigin?: CandidateRoleCard['provenance']['origin'],
): CandidateRoleCard | undefined {
  const pool = listCandidates(filter);
  if (pool.length === 0) return undefined;
  if (preferOrigin) {
    const pref = pool.find((c) => c.provenance.origin === preferOrigin);
    if (pref) return pref;
  }
  return pool[0];
}

/**
 * 把一个候选卡映射为 HR 面试闭环的请求。
 * 候选 persona 作为「被评 Agent 背景」注入；transcript 为面试工作样张（由 Demo 提供）。
 */
export function buildInterviewRequest(
  candidate: CandidateRoleCard,
  opts: { transcript: string; judge: JudgeFn; bossProfile?: ClosedLoopRequest['bossProfile']; k?: number; threshold?: number },
): ClosedLoopRequest {
  return {
    requirement: `评估「${candidate.title}」（部门：${candidate.departmentLabel ?? candidate.department}）是否胜任岗位。`,
    candidateId: candidate.id,
    candidateName: candidate.title,
    candidatePersona: candidate.persona,
    transcript: opts.transcript,
    bossProfile: opts.bossProfile ?? null,
    k: opts.k ?? 3,
    threshold: opts.threshold ?? 3.5,
    judge: opts.judge,
  };
}
