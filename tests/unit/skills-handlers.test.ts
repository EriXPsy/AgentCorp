import { describe, it, expect } from 'vitest';
import {
  bossReviewSkill,
  capabilityAssessmentSkill,
  reliabilityAuditSkill,
} from '@/demo/skills/handlers';
import { mockJudge } from '@/demo/mockJudge';

describe('Skill handlers（GOAI 复赛必选项 · 失败降级）', () => {
  it('reliability_audit 在 radars 为空时降级返回（不抛）', async () => {
    const res = await reliabilityAuditSkill({ radars: [] });
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
  });

  it('bossReviewSkill 高离散度 evaluation → rollback + 需人工确认', async () => {
    const evaluation = {
      biasAudit: { unstable: true, maxSpread: 5 },
      passK: { allPass: false, passRate: 0.2 },
      verdict: null as null,
      confidence: 0,
    };
    const res = await bossReviewSkill({ evaluation });
    expect(res.ok).toBe(true);
    const data = res.data as { action: string; requiresHumanAck: boolean };
    expect(data.action).toBe('rollback');
    expect(data.requiresHumanAck).toBe(true);
  });

  it('capabilityAssessmentSkill 用 mockJudge 正常产出 evaluation（passK 存在）', async () => {
    const res = await capabilityAssessmentSkill({
      agentId: 'x',
      transcript: 't',
      judge: mockJudge,
      k: 3,
      threshold: 3.5,
    });
    expect(res.ok).toBe(true);
    expect((res.data as any).passK).toBeTruthy();
  });

  it('capabilityAssessmentSkill 评委全 null → 降级返回', async () => {
    const res = await capabilityAssessmentSkill({
      agentId: 'x',
      transcript: 't',
      judge: async () => null,
      k: 3,
    });
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
  });
});
