import { describe, it, expect } from 'vitest';
import { runClosedLoop, type ClosedLoopRequest } from '@/demo/closedLoop';
import { mockJudge } from '@/demo/mockJudge';

const SAMPLE: Omit<ClosedLoopRequest, 'judge'> = {
  requirement: '招聘一名能独立承担前端组件库开发的 Agent 工程师。',
  candidateId: 'fe-agent-07',
  candidateName: 'FrontendAgent-07',
  candidatePersona: '前端组件库 Agent，擅长 React/TS。',
  transcript:
    '面试官：如何拆分大型表单？\n候选：先复述需求，再按职责拆为 FormProvider/Field/Validator/ErrorSummary，每步最小可用版本。',
  k: 3,
  threshold: 3.5,
};

describe('ClosedLoop orchestrator（GOAI 八步闭环实证）', () => {
  it('跑通 boss→recruiter→evaluator→boss 端到端闭环', async () => {
    const res = await runClosedLoop({ ...SAMPLE, judge: mockJudge });
    // evaluator：k 次评分 + 聚合 + pass^k + 偏差审计 全部产出
    expect(res.evaluation.radars.length).toBeGreaterThanOrEqual(2);
    expect(res.evaluation.meanRadar).toBeTypeOf('object');
    expect(['MVP', 'OBSERVE', 'FIRED']).toContain(res.evaluation.verdict);
    expect(res.evaluation.passK.k).toBeGreaterThanOrEqual(2);
    expect(res.evaluation.biasAudit).toHaveProperty('unstable');
    // boss：产生明确决策
    expect(['hire', 'observe', 'reject', 'rollback']).toContain(res.bossDecision.action);
    // trace：覆盖八步闭环多个阶段
    expect(res.trace.length).toBeGreaterThanOrEqual(5);
    const phases = res.trace.map((t) => t.phase);
    expect(phases).toContain('decompose');
    expect(phases).toContain('verify');
    expect(phases).toContain('approve');
    // 证据与经验沉淀非空
    expect(res.experience.length).toBeGreaterThan(0);
  });

  it('同一输入可复现（mock 确定性）', async () => {
    const a = await runClosedLoop({ ...SAMPLE, judge: mockJudge });
    const b = await runClosedLoop({ ...SAMPLE, judge: mockJudge });
    expect(a.evaluation.meanRadar).toEqual(b.evaluation.meanRadar);
    expect(a.bossDecision.action).toEqual(b.bossDecision.action);
  });

  it('评委离散度过高触发回滚并要求人工确认', async () => {
    // 构造一个抖动极大的 mock：每维在 0~5 间随机跳，确保 unstable
    const noisy: typeof mockJudge = async (input) => {
      const base = (input.variant % 2 === 0) ? 0.2 : 4.8;
      // 强行制造大极差：维度按 variant 在 0.2 与 4.8 间翻转
      const dims = ['task', 'quality', 'comm', 'creativity', 'reliability', 'cost'] as const;
      const radar = Object.fromEntries(dims.map((d, i) => [d, (i % 2 === 0 ? base : 5 - base)])) as any;
      return { radar, verdict: 'OBSERVE', confidence: 0.5, evidence: ['noisy'] };
    };
    const res = await runClosedLoop({ ...SAMPLE, judge: noisy });
    expect(res.evaluation.biasAudit.unstable).toBe(true);
    expect(res.bossDecision.action).toBe('rollback');
    expect(res.bossDecision.requiresHumanAck).toBe(true);
  });
});
