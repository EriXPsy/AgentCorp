import { describe, it, expect } from 'vitest';
import { createTeam, createTask, runTask } from '@/demo/agentteams-adapter';
import { RADAR_DIMS } from '@/engine/scoring/registry';

/**
 * SP-05 Demo 接 AgentTeams 薄适配实证：
 * ClosedLoopDemo 走 createTeam → createTask → runTask，步骤面板标注 Agent + Skill。
 */
describe('Demo 接 AgentTeams 薄适配（SP-05）', () => {
  it('runTask 产出带 Skill 标签的执行轨迹（Agent + Skill 标注）', async () => {
    const team = createTeam();
    const task = createTask({
      title: '招募前端 Agent',
      requirement: '招聘前端组件库 Agent',
      candidateId: 'fe-07',
      candidateName: 'FrontendAgent-07',
      candidatePersona: '前端组件库 Agent，擅长 React/TS。',
      transcript: '面试官：如何拆分表单？\n候选：先复述需求，再按职责拆为 FormProvider/Field/Validator/ErrorSummary。',
    });
    const run = await runTask(team, task);

    expect(run.status).toMatch(/completed|failed/);
    expect(run.result).toBeTruthy();
    expect(run.steps.length).toBeGreaterThanOrEqual(5);
    // 至少有一条轨迹带 Skill 标签（Agent + Skill 标注实证）
    const withSkill = run.steps.filter((s) => typeof s.skill === 'string' && s.skill!.length > 0);
    expect(withSkill.length).toBeGreaterThan(0);
    // 标签来自 5 个真实 Skill id
    const validSkills = ['agent_interview', 'capability_assessment', 'reliability_audit', 'boss_review', 'orchestrate'];
    for (const s of withSkill) expect(validSkills).toContain(s.skill);
    // 每步都有执行 Agent 与状态
    for (const s of run.steps) {
      expect(s.agent).toBeTruthy();
      expect(['ok', 'warn', 'blocked']).toContain(s.status);
    }
  });

  it('createTask 拆解含候选上下文且动态生成（SP-06 协同基元）', () => {
    const task = createTask({
      title: '招募前端 Agent',
      requirement: '招聘前端组件库 Agent',
      candidateId: 'fe-07',
      candidateName: 'FrontendAgent-07',
      candidatePersona: '前端组件库 Agent，擅长 React/TS。',
      transcript: 'x',
    });
    expect(task.decomposition.length).toBeGreaterThan(0);
    expect(task.decomposition[0]).toContain('recruiter');
    expect(task.decomposition[1]).toContain('evaluator');
    expect(task.decomposition[2]).toContain('boss');
    // 拆解引用了六维维度（RADAR_DIMS）与岗位
    expect(task.decomposition[1]).toContain(RADAR_DIMS.join('/'));
    expect(task.decomposition[0]).toContain('前端');
  });
});
