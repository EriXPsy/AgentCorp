import { describe, it, expect, beforeEach } from 'vitest';
import { runClosedLoop, type ClosedLoopRequest } from '@/demo/closedLoop';
import { mockJudge } from '@/demo/mockJudge';
import { resetRules } from '@/demo/skills/experienceStore';

/**
 * SP-08 经验复用闭环实证：
 * 同一候选连跑两次，第二次应复用第一次沉淀的结构化规则（priorExperience）。
 */
const SAMPLE: Omit<ClosedLoopRequest, 'judge'> = {
  requirement: '招聘一名能独立承担前端组件库开发的 Agent 工程师。',
  candidateId: 'exp-01',
  candidateName: 'FrontendAgent-07',
  candidatePersona: '前端组件库 Agent，擅长 React/TS。',
  transcript:
    '面试官：如何拆分大型表单？\n候选：先复述需求，再按职责拆为 FormProvider/Field/Validator/ErrorSummary，每步最小可用版本。',
  k: 3,
  threshold: 3.5,
};

describe('经验沉淀 Store（SP-08 经验复用闭环）', () => {
  beforeEach(() => resetRules());

  it('同一候选连跑两次，第二次复用第一次沉淀的结构化规则', async () => {
    const r1 = await runClosedLoop({ ...SAMPLE, judge: mockJudge });
    const r2 = await runClosedLoop({ ...SAMPLE, judge: mockJudge });

    // 首次运行无历史经验
    expect(r1.priorExperience).toEqual([]);
    // 第二次运行复用了第一次沉淀的规则
    expect(r2.priorExperience.length).toBeGreaterThanOrEqual(1);
    expect(r2.priorExperience[0].summary).toBe(r1.precipitatedRule.summary);
    expect(r2.priorExperience[0].weakestDim).toBe(r1.precipitatedRule.weakestDim);
  });

  it('不同候选互不串扰（按 candidateId 隔离）', async () => {
    await runClosedLoop({ ...SAMPLE, candidateId: 'exp-A', judge: mockJudge });
    const rB = await runClosedLoop({ ...SAMPLE, candidateId: 'exp-B', judge: mockJudge });
    expect(rB.priorExperience).toEqual([]);
  });
});
