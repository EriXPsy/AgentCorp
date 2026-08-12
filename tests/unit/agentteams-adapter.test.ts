import { describe, it, expect } from 'vitest';
import {
  toAgentTeamsAgent,
  createTeam,
  createTask,
  runTask,
} from '@/demo/agentteams-adapter';
import { ROLE_CARDS, ROLE_CARD_BY_ID } from '@/engine/agents/roleCard';

describe('AgentTeams 薄适配（决策 X 实证）', () => {
  it('roleCard 映射为 AgentTeams Agent，含身份/能力/边界', () => {
    const at = toAgentTeamsAgent(ROLE_CARD_BY_ID.evaluator);
    expect(at.agentId).toBe('evaluator');
    expect(at.role).toBe('evaluator');
    expect(at.capabilities.length).toBeGreaterThan(0); // 能力投影
    expect(at.boundaries.riskLevel).toBe('medium');
    expect(at.boundaries.forbidden).toContain('录用');
  });

  it('Team 含 ≥3 个异构职能 Agent（GOAI 1.1）', () => {
    const team = createTeam();
    const roles = team.agents.map((a) => a.role);
    expect(roles).toEqual(expect.arrayContaining(['boss', 'recruiter', 'evaluator']));
    expect(team.sharedContext.length).toBeGreaterThan(0); // 上下文通道
  });

  it('Task 含任务拆解与候选上下文', () => {
    const task = createTask({
      title: '招募前端 Agent',
      requirement: '招聘前端组件库 Agent',
      candidateId: 'fe-07',
      candidateName: 'FrontendAgent-07',
      transcript: '面试官：如何拆分表单？\n候选：先复述需求再拆分。',
    });
    expect(task.decomposition.length).toBeGreaterThan(0);
    expect(task.candidateId).toBe('fe-07');
  });

  it('runTask 端到端产出 AgentTeams Run（状态追踪 + 结果）', async () => {
    const team = createTeam();
    const task = createTask({
      title: '招募前端 Agent',
      requirement: '招聘前端组件库 Agent',
      candidateId: 'fe-07',
      candidateName: 'FrontendAgent-07',
      transcript: '面试官：如何拆分表单？\n候选：先复述需求，再按职责拆为 FormProvider/Field/Validator/ErrorSummary。',
    });
    const run = await runTask(team, task);
    expect(run.status).toMatch(/completed|failed/);
    expect(run.steps.length).toBeGreaterThanOrEqual(5);
    expect(run.result?.bossDecision.action).toBeTruthy();
    expect(ROLE_CARDS.length).toBeGreaterThanOrEqual(3);
  });
});
