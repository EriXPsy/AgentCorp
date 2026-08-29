/**
 * tests/unit/room-live.test.ts
 *
 * 团队房间「直播中」实况（teams store roomLive + src/lib/room-live.ts）：
 * - updateRoomLive 按 teamId→agentId 多槽位更新，同槽位只更新不追加，多成员并发互不覆盖；
 * - clearRoomLive 清空某团队全部槽位，不影响其他团队；
 * - appendTeamChatEvent 落正式消息时清除该发言者槽位（直播气泡被正式气泡取代）；
 * - 阶段标签 roomLivePhaseLabel 的已知/未知映射。
 *
 * mock @/lib/host-api 为内存实现（同 teams-store.test.ts）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamSummary, TeamsSnapshot, TeamChatEvent } from '@/types/team';

function makeTeam(id: string): TeamSummary {
  return {
    id,
    name: `团队-${id}`,
    leaderId: 'leader-1',
    memberIds: ['m-1', 'm-2'],
    createdAt: 0,
    chatEvents: [],
    memberCount: 3,
    activeTaskCount: 0,
    lastActiveTime: undefined,
    leaderName: 'Leader',
    memberAvatars: [],
  };
}

let teams: TeamSummary[];

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/teams') {
      return { teams } satisfies TeamsSnapshot;
    }
    const appendMatch = path.match(/^\/api\/teams\/(.+)\/chat-events$/);
    if (appendMatch && init?.method === 'POST') {
      const teamId = decodeURIComponent(appendMatch[1]);
      const body = JSON.parse(String(init.body)) as Omit<TeamChatEvent, 'createdAt'>;
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

import { roomLivePhaseLabel, ROOM_LIVE_PHASE_LABELS } from '@/lib/room-live';
import { useTeamsStore } from '@/stores/teams';

function entry(text: string, updatedAt = Date.now()) {
  return { agentName: '成员', phase: 'execute', text, updatedAt };
}

beforeEach(() => {
  teams = [makeTeam('team-a'), makeTeam('team-b')];
  useTeamsStore.setState({
    teams: teams.map((t) => ({ ...t })),
    loading: false,
    error: null,
    roomLive: {},
  });
});

describe('roomLive 多槽位实况', () => {
  it('同 team 不同 agentId 各占一个槽位，并发更新互不覆盖', () => {
    const s = useTeamsStore.getState();
    s.updateRoomLive('team-a', 'm-1', entry('m1 第一版', 1));
    s.updateRoomLive('team-a', 'm-2', entry('m2 第一版', 2));
    useTeamsStore.getState().updateRoomLive('team-a', 'm-1', entry('m1 第二版', 3));

    const room = useTeamsStore.getState().roomLive['team-a'];
    expect(Object.keys(room).sort()).toEqual(['m-1', 'm-2']);
    expect(room['m-1'].text).toBe('m1 第二版'); // 同槽位只更新
    expect(room['m-2'].text).toBe('m2 第一版'); // 其他槽位不受影响
  });

  it('不同 team 的槽位相互隔离', () => {
    useTeamsStore.getState().updateRoomLive('team-a', 'm-1', entry('A 团队'));
    useTeamsStore.getState().updateRoomLive('team-b', 'm-1', entry('B 团队'));

    const live = useTeamsStore.getState().roomLive;
    expect(live['team-a']['m-1'].text).toBe('A 团队');
    expect(live['team-b']['m-1'].text).toBe('B 团队');
  });

  it('entry 为 null 只清除该成员槽位；clearRoomLive 清空全团队且不影响其他团队', () => {
    const s = useTeamsStore.getState();
    s.updateRoomLive('team-a', 'm-1', entry('1'));
    s.updateRoomLive('team-a', 'm-2', entry('2'));
    s.updateRoomLive('team-b', 'm-1', entry('3'));

    useTeamsStore.getState().updateRoomLive('team-a', 'm-1', null);
    let live = useTeamsStore.getState().roomLive;
    expect(live['team-a']['m-1']).toBeUndefined();
    expect(live['team-a']['m-2'].text).toBe('2');

    useTeamsStore.getState().clearRoomLive('team-a');
    live = useTeamsStore.getState().roomLive;
    expect(live['team-a']).toBeUndefined();
    expect(live['team-b']['m-1'].text).toBe('3');
  });
});

describe('正式消息落房间清除直播槽位', () => {
  it('appendTeamChatEvent：发言者槽位被清除，其他成员保留；user 消息不清槽位', async () => {
    const s = useTeamsStore.getState();
    s.updateRoomLive('team-a', 'm-1', entry('m1 正在写'));
    s.updateRoomLive('team-a', 'm-2', entry('m2 正在写'));

    await useTeamsStore.getState().appendTeamChatEvent('team-a', { from: 'm-1', to: 'team', content: '正式产出' });

    let room = useTeamsStore.getState().roomLive['team-a'];
    expect(room['m-1']).toBeUndefined(); // 直播气泡被正式气泡取代
    expect(room['m-2'].text).toBe('m2 正在写');

    await useTeamsStore.getState().appendTeamChatEvent('team-a', { from: 'user', to: 'team', content: '用户插话' });
    room = useTeamsStore.getState().roomLive['team-a'];
    expect(room['m-2'].text).toBe('m2 正在写'); // 用户消息不清任何槽位
  });
});

describe('roomLivePhaseLabel 阶段标签', () => {
  it('已知阶段映射为中文，未知阶段原样返回', () => {
    for (const phase of Object.keys(ROOM_LIVE_PHASE_LABELS)) {
      expect(roomLivePhaseLabel(phase)).toBe(ROOM_LIVE_PHASE_LABELS[phase]);
    }
    expect(roomLivePhaseLabel('unknown-phase')).toBe('unknown-phase');
  });
});
