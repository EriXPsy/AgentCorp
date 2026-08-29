/**
 * tests/unit/teamChatWorkOrder.test.ts
 *
 * 会话派活执行器（runTeamChatWorkOrder）单测：
 * - 双跑互斥：与 autoWorker 共用 claimed 集合——任务被 claimTask 占用时
 *   会话派活返回 false 不受理；受理期间再次调用也返回 false；结束（含失败）释放。
 * - 失败复位：编排抛错 → workState=failed + status 回到进入派活前的列
 *   （已有交付回 review，无交付回 todo），claim 照样释放。
 * - 正常链路：受理 → 编排 → 落 review/done，返回 true。
 *
 * 隔离：mock 全部 store/引擎依赖；autoWorker 用真实模块（要它的 claimTask/releaseClaim）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KanbanTask } from '@/types/task';
import type { TeamSummary } from '@/types/team';

// ── 受控替身 ────────────────────────────────────────────────────────
let tasks: KanbanTask[] = [];
const updateTaskMock = vi.fn(async (id: string, updates: Partial<KanbanTask>) => {
  const i = tasks.findIndex((t) => t.id === id);
  if (i >= 0) tasks[i] = { ...tasks[i], ...updates } as KanbanTask;
  return tasks[i];
});
const appendEventMock = vi.fn(async (id: string) => tasks.find((t) => t.id === id));

const team: TeamSummary = {
  id: 'team-1',
  name: '测试团队',
  leaderId: 'leader',
  memberIds: ['m1'],
  createdAt: 0,
  chatEvents: [],
  memberCount: 2,
  activeTaskCount: 0,
  lastActiveTime: undefined,
  leaderName: 'Leader',
  memberAvatars: [],
};
const appendTeamChatEventMock = vi.fn(async () => {});

const runOrchestrationMock = vi.fn();

vi.mock('@/stores/approvals', () => ({
  useApprovalsStore: {
    getState: () => ({
      tasks,
      updateTask: updateTaskMock,
      appendTaskExecutionEvent: appendEventMock,
      fetchTasks: vi.fn(async () => {}),
    }),
  },
}));
vi.mock('@/stores/teams', () => ({
  useTeamsStore: {
    getState: () => ({
      teams: [team],
      appendTeamChatEvent: appendTeamChatEventMock,
      updateRoomLive: vi.fn(),
      clearRoomLive: vi.fn(),
    }),
  },
}));
vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => ({
      agents: [{ id: 'leader', mainSessionKey: 'sess-leader' }],
      getAgentPersona: vi.fn(async () => null),
    }),
  },
}));
vi.mock('@/stores/gateway', () => ({
  useGatewayStore: { getState: () => ({ status: { state: 'stopped', port: 0 }, rpc: vi.fn() }) },
}));
vi.mock('@/stores/chat', () => ({
  useChatStore: { getState: () => ({ ensureTeamTaskSession: vi.fn() }) },
}));
vi.mock('@/stores/evaluation', () => ({
  useEvaluationStore: { getState: () => ({ profiles: {} }) },
}));
vi.mock('@/stores/teamRoomBroadcast', () => ({
  createRoomTraceForwarder: () => () => {},
}));
vi.mock('@/engine/squad/squadOrchestration', () => ({
  runSquadOrchestration: (...args: unknown[]) => runOrchestrationMock(...args),
}));
vi.mock('@/engine/squad/squadCollaboration', () => ({
  runSquadCollaboration: vi.fn(),
}));
vi.mock('@/engine/squad/squadRouting', () => ({
  routeBySquadLeader: vi.fn(() => ({ assigneeId: null, leaderKept: true, reason: '' })),
}));
vi.mock('@/engine/llm/realExecutor', () => ({
  runRealChat: vi.fn(async () => ''),
  runRealExecution: vi.fn(),
  isRealExecutorAvailable: vi.fn(async () => false),
}));
vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(async () => ({ success: false })),
}));
vi.mock('@/lib/task-notify', () => ({ notifyTaskTerminal: vi.fn() }));

// ── D/F 数据闭环 store 替身（绩效上报 + 经验卡注入/复盘）──────────────
const fetchMemberStatsMock = vi.fn(async () => {});
const recordOutcomesMock = vi.fn(async () => {});
vi.mock('@/stores/performance', () => ({
  usePerformanceStore: {
    getState: () => ({
      stats: {},
      fetchMemberStats: fetchMemberStatsMock,
      recordOutcomes: recordOutcomesMock,
    }),
  },
  subtasksToOutcomes: (
    subs: Array<{ assigneeId?: string; approved: boolean; rounds: number; error?: string }>,
  ) =>
    subs
      .filter((s) => Boolean(s.assigneeId))
      .map((s) => ({
        agentId: s.assigneeId as string,
        approved: s.error ? false : Boolean(s.approved),
        rounds: Math.max(1, Math.round(s.rounds ?? 1)),
      })),
}));
const getExperienceMock = vi.fn(async (): Promise<Array<{ id: string; content: string; source: string; createdAt: string }>> => []);
const reflectExperienceMock = vi.fn(async () => false);
vi.mock('@/stores/experience', () => ({
  useExperienceStore: {
    getState: () => ({
      getExperience: getExperienceMock,
      appendExperience: vi.fn(async () => {}),
    }),
  },
  buildExperienceText: (cards: Array<{ content: string }>, limit = 10) =>
    cards.length ? cards.slice(-limit).map((c) => `- ${c.content}`).join('\n') : undefined,
  reflectExperience: (...args: unknown[]) => reflectExperienceMock(...args),
}));

import { runTeamChatWorkOrder, isWorkOrderRunning, retryFailedTask } from '@/stores/teamChatWorkOrder';
import { claimTask, releaseClaim, __resetAutoWorkerForTest } from '@/stores/autoWorker';

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: 't1',
    title: '做调研',
    description: '调研竞品',
    status: 'review',
    priority: 'medium',
    assigneeId: 'leader',
    workState: 'done',
    isTeamTask: true,
    teamId: 'team-1',
    teamName: '测试团队',
    canonicalExecution: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as KanbanTask;
}

beforeEach(() => {
  __resetAutoWorkerForTest();
  tasks = [makeTask()];
  updateTaskMock.mockClear();
  appendEventMock.mockClear();
  appendTeamChatEventMock.mockClear();
  runOrchestrationMock.mockReset();
  runOrchestrationMock.mockResolvedValue({ subtasks: [], deliverable: '汇总交付', traces: [] });
  fetchMemberStatsMock.mockClear();
  recordOutcomesMock.mockClear();
  getExperienceMock.mockReset();
  getExperienceMock.mockResolvedValue([]);
  reflectExperienceMock.mockClear();
});

describe('runTeamChatWorkOrder · 双跑互斥', () => {
  it('任务被 autoWorker claimTask 占用 → 会话派活返回 false，不起编排', async () => {
    expect(claimTask('t1')).toBe(true); // 模拟 autoWorker 已领取
    const accepted = await runTeamChatWorkOrder('t1', '再加一页');
    expect(accepted).toBe(false);
    expect(runOrchestrationMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
    releaseClaim('t1');
  });

  it('受理期间重复触发（连点）→ 第二次返回 false；完成后 claim 释放', async () => {
    let resolveOrch: ((v: unknown) => void) | null = null;
    runOrchestrationMock.mockImplementation(
      () => new Promise((r) => { resolveOrch = r; }),
    );
    const p1 = runTeamChatWorkOrder('t1', '再加一页');
    // 第一次已受理并占用
    expect(isWorkOrderRunning('t1')).toBe(true);
    const accepted2 = await runTeamChatWorkOrder('t1', '重复指令');
    expect(accepted2).toBe(false);
    // 让第一次调用推进到编排调用点（编排被挂起模拟执行中）
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(runOrchestrationMock).toHaveBeenCalledTimes(1);

    resolveOrch?.({ subtasks: [], deliverable: '汇总交付', traces: [] });
    expect(await p1).toBe(true);
    // 结束后释放：autoWorker/会话都可在终态后再受理
    expect(isWorkOrderRunning('t1')).toBe(false);
    expect(claimTask('t1')).toBe(true);
    releaseClaim('t1');
  });
});

describe('runTeamChatWorkOrder · 状态流转', () => {
  it('正常链路：受理留痕 → in-progress/working → 编排 → review/done + 房间同步', async () => {
    const accepted = await runTeamChatWorkOrder('t1', '补充数据源');
    expect(accepted).toBe(true);

    const t1 = tasks.find((t) => t.id === 't1')!;
    expect(t1.status).toBe('review');
    expect(t1.workState).toBe('done');
    expect(t1.workResult).toContain('汇总交付');
    // 受理留痕走原子 append 事件端点
    expect(appendEventMock).toHaveBeenCalledWith('t1', expect.objectContaining({ type: 'status' }));
    // 交付同步到团队房间
    expect(appendTeamChatEventMock).toHaveBeenCalledWith('team-1', expect.objectContaining({ to: 'user' }));
  });

  it('失败复位（无既有交付）：编排抛错 → failed + status 回 todo，claim 释放', async () => {
    tasks = [makeTask({ status: 'todo', workState: 'idle', workResult: undefined })];
    runOrchestrationMock.mockRejectedValue(new Error('LLM 超时'));

    await expect(runTeamChatWorkOrder('t1', '做吧')).rejects.toThrow('LLM 超时');

    const t1 = tasks.find((t) => t.id === 't1')!;
    expect(t1.workState).toBe('failed');
    expect(t1.status).toBe('todo');
    expect(t1.workError).toContain('会话派活执行失败');
    expect(isWorkOrderRunning('t1')).toBe(false);
  });

  it('失败复位（已有交付）：status 回 review 而不是 todo', async () => {
    tasks = [makeTask({ status: 'review', workState: 'done', workResult: '上一版交付' })];
    runOrchestrationMock.mockRejectedValue(new Error('编排爆炸'));

    await expect(runTeamChatWorkOrder('t1', '改一版')).rejects.toThrow('编排爆炸');

    const t1 = tasks.find((t) => t.id === 't1')!;
    expect(t1.workState).toBe('failed');
    expect(t1.status).toBe('review');
    expect(isWorkOrderRunning('t1')).toBe(false);
  });
});

describe('retryFailedTask · 失败自救', () => {
  it('failed 任务 → 重新排队（status 回 todo、workState 回 idle），返回 true', async () => {
    tasks = [makeTask({ status: 'todo', workState: 'failed', workError: 'LLM 超时' })];
    const ok = await retryFailedTask('t1');
    expect(ok).toBe(true);
    const t1 = tasks.find((t) => t.id === 't1')!;
    expect(t1.status).toBe('todo');
    expect(t1.workState).toBe('idle');
  });

  it('有既有交付的失败任务也回 todo 重排（AutoWorker 重领从头跑）', async () => {
    tasks = [makeTask({ status: 'review', workState: 'failed', workResult: '上一版交付', workError: '编排爆炸' })];
    const ok = await retryFailedTask('t1');
    expect(ok).toBe(true);
    expect(tasks.find((t) => t.id === 't1')!.status).toBe('todo');
  });

  it('非 failed 任务 → 不受理（不 update）', async () => {
    tasks = [makeTask({ status: 'review', workState: 'done' })];
    const ok = await retryFailedTask('t1');
    expect(ok).toBe(false);
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('任务被占用（编排执行中）→ 不重排，返回 false', async () => {
    tasks = [makeTask({ status: 'todo', workState: 'failed', workError: 'x' })];
    expect(claimTask('t1')).toBe(true);
    const ok = await retryFailedTask('t1');
    expect(ok).toBe(false);
    expect(updateTaskMock).not.toHaveBeenCalled();
    releaseClaim('t1');
  });

  it('任务不存在 → false', async () => {
    expect(await retryFailedTask('ghost')).toBe(false);
  });
});

describe('runTeamChatWorkOrder · D/F 数据闭环接线', () => {
  it('编排前拉绩效+经验注入（experience/qualityMode 契约字段），完成后上报 outcomes + 复盘经验卡', async () => {
    getExperienceMock.mockResolvedValue([
      { id: 'e1', content: '代码任务先定接口再动手', source: 't0', createdAt: '' },
      { id: 'e2', content: '长文任务先列提纲', source: 't0', createdAt: '' },
    ]);
    runOrchestrationMock.mockResolvedValue({
      subtasks: [
        { title: '子1', assigneeId: 'm1', assignedBy: 'decompose', approved: true, rounds: 2, output: 'x', verdict: 'PASS' },
        { title: '子2', assigneeId: 'leader', assignedBy: 'routing', approved: false, rounds: 3, output: null, verdict: 'FAIL', error: 'LLM 超时' },
      ],
      deliverable: '汇总交付',
      traces: [],
      llmCalls: 5,
    });

    const accepted = await runTeamChatWorkOrder('t1', '补充数据源');
    expect(accepted).toBe(true);

    // D：编排前拉绩效快照（供候选 performance 注入）
    expect(fetchMemberStatsMock).toHaveBeenCalled();
    // F：经验卡拼成「- 内容」文本注入编排输入
    const input = runOrchestrationMock.mock.calls[0][0] as { experience?: string; qualityMode?: boolean };
    expect(input.experience).toBe('- 代码任务先定接口再动手\n- 长文任务先列提纲');
    // C：priority=medium → qualityMode false
    expect(input.qualityMode).toBe(false);
    // D：编排结果按子任务归集上报（error 子任务记 approved:false）
    expect(recordOutcomesMock).toHaveBeenCalledWith([
      { agentId: 'm1', approved: true, rounds: 2 },
      { agentId: 'leader', approved: false, rounds: 3 },
    ]);
    // F：交付后 leader 视角复盘经验卡（source 记 taskId）
    expect(reflectExperienceMock).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1', taskId: 't1', taskTitle: '做调研' }),
    );
    expect(
      (reflectExperienceMock.mock.calls[0][0] as { subtasks: unknown[] }).subtasks,
    ).toHaveLength(2);
  });

  // 经验拉取失败的静默语义由 store 内部 catch 保证（见 experience-store.test.ts），
  // 接线侧拿到的永远是 resolved 值，这里覆盖「无卡」路径即可。
  it('高优先级任务 → qualityMode: true；无经验卡 → 不注入 experience 字段', async () => {
    tasks = [makeTask({ priority: 'high' })];
    const accepted = await runTeamChatWorkOrder('t1', '重做一版');
    expect(accepted).toBe(true);

    const input = runOrchestrationMock.mock.calls[0][0] as { experience?: string; qualityMode?: boolean };
    expect(input.qualityMode).toBe(true);
    expect(input.experience).toBeUndefined();
  });

});
