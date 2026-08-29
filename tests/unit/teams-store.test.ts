/**
 * tests/unit/teams-store.test.ts
 *
 * useTeamsStore.appendTeamChatEvent（团队房间消息追加）单测：
 * - 走服务端原子 append 端点 POST /api/teams/:id/chat-events（不再读-改-写 PUT 整包），
 *   用返回的 teams 快照同步 store
 * - 未知 teamId → 无操作（不发起请求）
 * - chatEvents 封顶 200 条由服务端处理（mock 端点模拟），store 套用快照
 *
 * mock @/lib/host-api 为内存实现，模拟主进程快照返回（含新端点）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TeamSummary, TeamsSnapshot, UpdateTeamRequest, TeamChatEvent } from '@/types/team';

function makeTeam(id: string, chatEvents: TeamsSnapshot['teams'][number]['chatEvents'] = []): TeamSummary {
  return {
    id,
    name: `团队-${id}`,
    leaderId: 'leader-1',
    memberIds: ['m-1'],
    createdAt: 0,
    chatEvents,
    memberCount: 2,
    activeTaskCount: 0,
    lastActiveTime: undefined,
    leaderName: 'Leader',
    memberAvatars: [],
  };
}

let teams: TeamSummary[];
const putCalls: Array<{ teamId: string; body: UpdateTeamRequest }> = [];
const appendCalls: Array<{ teamId: string; body: Omit<TeamChatEvent, 'createdAt'> }> = [];

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/teams') {
      return { teams } satisfies TeamsSnapshot;
    }
    // 服务端原子 append 端点的内存实现：补 createdAt、封顶 200、返回最新快照
    const appendMatch = path.match(/^\/api\/teams\/(.+)\/chat-events$/);
    if (appendMatch && init?.method === 'POST') {
      const teamId = decodeURIComponent(appendMatch[1]);
      const body = JSON.parse(String(init.body)) as Omit<TeamChatEvent, 'createdAt'>;
      appendCalls.push({ teamId, body });
      teams = teams.map((t) =>
        t.id === teamId
          ? {
              ...t,
              chatEvents: [
                ...(t.chatEvents ?? []),
                { ...body, createdAt: new Date().toISOString() },
              ].slice(-200),
            }
          : t,
      );
      return { teams } satisfies TeamsSnapshot;
    }
    const putMatch = path.match(/^\/api\/teams\/(.+)$/);
    if (putMatch && init?.method === 'PUT') {
      const teamId = decodeURIComponent(putMatch[1]);
      const body = JSON.parse(String(init.body)) as UpdateTeamRequest;
      putCalls.push({ teamId, body });
      teams = teams.map((t) => (t.id === teamId ? { ...t, ...body } : t));
      return { teams } satisfies TeamsSnapshot;
    }
    throw new Error(`unexpected path: ${path}`);
  }),
}));

import { useTeamsStore } from '@/stores/teams';

beforeEach(() => {
  teams = [makeTeam('team-a')];
  putCalls.length = 0;
  appendCalls.length = 0;
  useTeamsStore.setState({ teams: [makeTeam('team-a')], loading: false, error: null });
});

describe('appendTeamChatEvent（原子 append 端点）', () => {
  it('追加事件：POST chat-events 原子端点，store 套用返回快照', async () => {
    await useTeamsStore.getState().appendTeamChatEvent('team-a', {
      from: 'leader-1',
      to: 'user',
      content: '「计算器」交付完成，请验收',
    });

    // 走原子端点，不再读-改-写 PUT 整包
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0].teamId).toBe('team-a');
    expect(appendCalls[0].body).toEqual({
      from: 'leader-1',
      to: 'user',
      content: '「计算器」交付完成，请验收',
    });
    expect(putCalls).toHaveLength(0);

    // store 状态同步（createdAt 由服务端补）
    const stored = useTeamsStore.getState().teams.find((t) => t.id === 'team-a')!;
    expect(stored.chatEvents).toHaveLength(1);
    expect(stored.chatEvents![0].from).toBe('leader-1');
    expect(typeof stored.chatEvents![0].createdAt).toBe('string');
  });

  it('未知 teamId → 无操作（不发起任何请求）', async () => {
    await useTeamsStore.getState().appendTeamChatEvent('team-x', {
      from: 'leader-1',
      to: 'user',
      content: 'hi',
    });
    expect(appendCalls).toHaveLength(0);
    expect(putCalls).toHaveLength(0);
  });

  it('chatEvents 封顶 200 条（服务端处理）：已满 200 时再追加，快照仍 200 且最新在最尾', async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({
      from: 'leader-1',
      to: 'user',
      content: `msg-${i}`,
      createdAt: new Date(i).toISOString(),
    }));
    teams = [makeTeam('team-a', full)];
    useTeamsStore.setState({ teams: [makeTeam('team-a', full)] });

    await useTeamsStore.getState().appendTeamChatEvent('team-a', {
      from: 'leader-1',
      to: 'user',
      content: '新消息',
    });

    expect(appendCalls).toHaveLength(1);
    const stored = useTeamsStore.getState().teams.find((t) => t.id === 'team-a')!;
    expect(stored.chatEvents).toHaveLength(200);
    expect(stored.chatEvents![0].content).toBe('msg-1'); // 最旧的一条被挤出
    expect(stored.chatEvents![199].content).toBe('新消息');
  });
});

describe('fetchTeams 快照兜底（浏览器预览 shim）', () => {
  it('shim 返回 200 空对象（teams 字段缺失）→ 兜底为空数组，不白屏', async () => {
    teams = undefined as unknown as TeamSummary[]; // 模拟 shim：{ teams: undefined }
    await useTeamsStore.getState().fetchTeams();
    expect(useTeamsStore.getState().teams).toEqual([]);
    expect(useTeamsStore.getState().error).toBeNull();
  });
});
