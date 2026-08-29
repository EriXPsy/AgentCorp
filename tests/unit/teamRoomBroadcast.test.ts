/**
 * tests/unit/teamRoomBroadcast.test.ts
 *
 * P0-3 协作过程实时广播单测：
 * - isMilestoneTrace：里程碑 summary / failed 状态命中，高频非里程碑不命中；
 *   P2 起「成员回交产出」放宽为里程碑（成员产出房间可见）
 * - createRoomTraceForwarder：from/to 映射（agent: 前缀剥离、team: → leaderId）、
 *   非里程碑不转发、广播写 appendTeamChatEvent（PUT 持久化）
 *
 * mock @/lib/host-api 为内存实现，仿照 teams-store.test.ts 的快照套路。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TeamSummary, TeamsSnapshot, TeamChatEvent } from '@/types/team';
import type { A2aTraceRecord } from '@/types/evaluation';

function makeTeam(id: string): TeamSummary {
  return {
    id,
    name: `团队-${id}`,
    leaderId: 'leader-1',
    memberIds: ['m-1'],
    createdAt: 0,
    chatEvents: [],
    memberCount: 2,
    activeTaskCount: 0,
    lastActiveTime: undefined,
    leaderName: 'Leader',
    memberAvatars: [],
  };
}

let teams: TeamSummary[];
const appendCalls: Array<{ teamId: string; body: Omit<TeamChatEvent, 'createdAt'> }> = [];

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/teams') {
      return { teams } satisfies TeamsSnapshot;
    }
    // 服务端原子 append 端点的内存实现（仿照 teams-store.test.ts 的快照套路）
    const appendMatch = path.match(/^\/api\/teams\/(.+)\/chat-events$/);
    if (appendMatch && init?.method === 'POST') {
      const teamId = decodeURIComponent(appendMatch[1]);
      const body = JSON.parse(String(init.body)) as Omit<TeamChatEvent, 'createdAt'>;
      appendCalls.push({ teamId, body });
      teams = teams.map((t) =>
        t.id === teamId
          ? { ...t, chatEvents: [...(t.chatEvents ?? []), { ...body, createdAt: new Date().toISOString() }].slice(-200) }
          : t,
      );
      return { teams } satisfies TeamsSnapshot;
    }
    throw new Error(`unexpected path: ${path}`);
  }),
}));

import { useTeamsStore } from '@/stores/teams';
import { isMilestoneTrace, createRoomTraceForwarder } from '@/stores/teamRoomBroadcast';

/** 构造一条最小合法 trace（按需覆盖字段）。 */
function makeTrace(p: Partial<A2aTraceRecord>): A2aTraceRecord {
  const now = new Date().toISOString();
  return {
    trace_id: 'trace-x',
    task_id: 'task-1',
    parent_task_id: 'root-1',
    delegator: 'agent:leader-1',
    delegatee: 'agent:m-1',
    round: 1,
    kind: 'message',
    state: 'working',
    rework_of: null,
    channel: 'internal-rpc',
    sent_at: now,
    completed_at: null,
    summary: '',
    session_key: 'local:m-1',
    root_session_id: 'root-1',
    trigger: 'spawn',
    ...p,
  };
}

beforeEach(() => {
  teams = [makeTeam('team-a')];
  appendCalls.length = 0;
  useTeamsStore.setState({ teams: [makeTeam('team-a')], loading: false, error: null });
});

describe('isMilestoneTrace 里程碑过滤', () => {
  it('各类里程碑 summary 命中', () => {
    expect(isMilestoneTrace(makeTrace({ summary: 'Leader 拆解任务为 2 个子任务：a；b' }))).toBe(true);
    expect(isMilestoneTrace(makeTrace({ summary: '子任务「a」指派给 m1（leader 指定）', state: 'submitted' }))).toBe(true);
    expect(isMilestoneTrace(makeTrace({ summary: '「a」Leader 审阅：PASS — 可以' }))).toBe(true);
    expect(isMilestoneTrace(makeTrace({ summary: '「a」执行失败，改派给 m2 重试：LLM 超时' }))).toBe(true);
    expect(isMilestoneTrace(makeTrace({ summary: 'Leader 汇总交付：最终交付物…', state: 'completed' }))).toBe(true);
    expect(isMilestoneTrace(makeTrace({ summary: 'Leader 重规划：追加 1 个子任务：c' }))).toBe(true);
    expect(isMilestoneTrace(makeTrace({ summary: '开工确认：成员提出 1 个问题，leader 已解答' }))).toBe(true);
    expect(isMilestoneTrace(makeTrace({ summary: '「a」交叉评审后修订产出：…' }))).toBe(true);
  });

  it('failed 状态无论 summary 都命中', () => {
    expect(isMilestoneTrace(makeTrace({ summary: '「a」执行失败：LLM 超时', state: 'failed' }))).toBe(true);
  });

  it('非里程碑（无里程碑关键词的高频中间态）不命中', () => {
    expect(isMilestoneTrace(makeTrace({ summary: '「a」正在生成产出…', state: 'working' }))).toBe(false);
    expect(isMilestoneTrace(makeTrace({ summary: '「a」调用工具：read_file', state: 'working' }))).toBe(false);
  });

  it('成员回交产出（P2 放宽为里程碑）命中，房间可见', () => {
    expect(isMilestoneTrace(makeTrace({ summary: '「a」成员回交产出（第1轮）：产出片段' }))).toBe(true);
    expect(isMilestoneTrace(makeTrace({ summary: '「a」成员回交产出（第2轮）：修订片段', state: 'working' }))).toBe(true);
  });
});

describe('createRoomTraceForwarder', () => {
  it('里程碑 trace 写入房间：agent: 前缀剥离、to=team、content=summary', async () => {
    const forward = createRoomTraceForwarder('team-a');
    forward(makeTrace({ delegator: 'agent:leader-1', summary: 'Leader 拆解任务为 2 个子任务：a；b' }));
    // 非里程碑不转发
    forward(makeTrace({ delegator: 'agent:m-1', summary: '「a」正在生成产出…', state: 'working' }));

    await vi.waitFor(() => expect(appendCalls).toHaveLength(1));
    expect(appendCalls[0].teamId).toBe('team-a');
    expect(appendCalls[0].body.from).toBe('leader-1');
    expect(appendCalls[0].body.to).toBe('team');
    expect(appendCalls[0].body.content).toBe('Leader 拆解任务为 2 个子任务：a；b');
    // store 套用端点返回的快照
    const stored = useTeamsStore.getState().teams.find((t) => t.id === 'team-a')!;
    expect(stored.chatEvents).toHaveLength(1);
  });

  it('delegator 为 team: 开头时 from 用团队 leaderId', async () => {
    const forward = createRoomTraceForwarder('team-a');
    forward(makeTrace({ delegator: 'team:team-a', state: 'failed', summary: '「a」执行失败：x' }));

    await vi.waitFor(() => expect(appendCalls).toHaveLength(1));
    expect(appendCalls[0].body.from).toBe('leader-1');
    expect(appendCalls[0].body.to).toBe('team');
  });
});
