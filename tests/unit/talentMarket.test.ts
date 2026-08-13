import { describe, it, expect } from 'vitest';
import { AGENCY_AGENTS_CANDIDATES } from '@/demo/data/agencyAgentsCandidates';
import {
  CANDIDATE_COUNT,
  TALENT_MARKET_SOURCE,
  listCandidates,
  getCandidate,
  selectCandidate,
  buildInterviewRequest,
} from '@/demo/talentMarket';
import { mockJudge } from '@/demo/mockJudge';
import { runClosedLoop } from '@/demo/closedLoop';

describe('talentMarket（SP-21 人才市场候选池）', () => {
  it('候选包含 268 个角色（对齐 agency-agents-zh 官方口径）', () => {
    expect(CANDIDATE_COUNT).toBe(268);
    expect(AGENCY_AGENTS_CANDIDATES.length).toBe(268);
  });

  it('MIT 来源标注完整', () => {
    expect(TALENT_MARKET_SOURCE.repo).toBe('jnMetaCode/agency-agents-zh');
    expect(TALENT_MARKET_SOURCE.license).toBe('MIT');
    expect(TALENT_MARKET_SOURCE.count).toBe(268);
    // 全部候选都带 MIT 溯源
    expect(AGENCY_AGENTS_CANDIDATES.every((c) => c.provenance.license === 'MIT')).toBe(true);
    expect(AGENCY_AGENTS_CANDIDATES.every((c) => c.provenance.sourceRepo.includes('agency-agents-zh'))).toBe(true);
  });

  it('按部门过滤（工程部 42）', () => {
    const eng = listCandidates({ department: 'engineering' });
    expect(eng.length).toBe(42);
    expect(eng.every((c) => c.department === 'engineering')).toBe(true);
  });

  it('按关键词过滤命中中文名', () => {
    const hits = listCandidates({ keyword: '安全' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((c) => c.id === 'engineering-security-engineer')).toBe(true);
  });

  it('getCandidate 按 id 取人', () => {
    const c = getCandidate('engineering-security-engineer');
    expect(c).toBeDefined();
    expect(c!.title).toBe('安全工程师');
  });

  it('selectCandidate 取过滤后首条，可优先本土原创', () => {
    const first = selectCandidate({ department: 'engineering' });
    expect(first).toBeDefined();
    expect(first!.department).toBe('engineering');
    const cn = selectCandidate(undefined, 'china-original');
    expect(cn).toBeDefined();
    expect(cn!.provenance.origin).toBe('china-original');
  });

  it('buildInterviewRequest 把候选映射进 HR 面试闭环', () => {
    const c = getCandidate('engineering-security-engineer')!;
    const req = buildInterviewRequest(c, { transcript: '示例工作样张', judge: mockJudge });
    expect(req.candidateId).toBe(c.id);
    expect(req.candidateName).toBe(c.title);
    expect(req.candidatePersona).toBe(c.persona);
    expect(req.judge).toBe(mockJudge);
    expect(req.k).toBe(3);
  });

  it('端到端：从 268 候选池选 1 个 → 进入面试闭环 → 产出 boss 决策（SP-21 Demo 链路）', async () => {
    const candidate = selectCandidate({ department: 'engineering' })!;
    const req = buildInterviewRequest(candidate, {
      transcript: '候选人提交了一段工程实现样张，包含架构设计与代码。',
      judge: mockJudge,
    });
    const res = await runClosedLoop(req);
    expect(res).toBeDefined();
    expect(res.bossDecision).toBeDefined();
    expect(['hire', 'observe', 'reject', 'rollback']).toContain(res.bossDecision.action);
    // 轨迹含八步闭环标签
    expect(res.trace.length).toBeGreaterThanOrEqual(5);
  });
});
