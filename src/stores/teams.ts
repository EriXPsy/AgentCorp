import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import type { TeamSummary, CreateTeamRequest, UpdateTeamRequest, TeamsSnapshot, TeamChatEvent } from '@/types/team';

/** 房间实况条目：某成员当前正在进行的阶段发言（内存态，不落盘、不进 chatEvents）。 */
export interface RoomLiveEntry {
  agentName: string;
  /** 编排阶段（decompose/execute/review/…），展示标签见 lib/room-live。 */
  phase: string;
  /** 当前进展摘要（同 agent 同槽位只更新不追加，防刷屏）。 */
  text: string;
  updatedAt: number;
}

interface TeamsState {
  teams: TeamSummary[];
  loading: boolean;
  error: string | null;
  /** 房间实况：teamId → agentId → 当前发言（多成员并发各占一个槽位，互不覆盖）。 */
  roomLive: Record<string, Record<string, RoomLiveEntry>>;

  // CRUD operations
  fetchTeams: () => Promise<void>;
  createTeam: (request: CreateTeamRequest) => Promise<void>;
  updateTeam: (teamId: string, updates: UpdateTeamRequest) => Promise<void>;
  deleteTeam: (teamId: string) => Promise<void>;

  /** 团队房间追加一条消息（基于最新状态，封顶 200 条）。 */
  appendTeamChatEvent: (teamId: string, event: Omit<TeamChatEvent, 'createdAt'>) => Promise<void>;

  /** 更新房间实况槽位；entry 为 null 时清除该成员的槽位（正式消息落房间后调用）。 */
  updateRoomLive: (teamId: string, agentId: string, entry: RoomLiveEntry | null) => void;
  /** 清空某团队的全部实况槽位（编排结束时调用）。 */
  clearRoomLive: (teamId: string) => void;

  // Convenience methods
  addMember: (teamId: string, agentId: string) => Promise<void>;
  removeMember: (teamId: string, agentId: string) => Promise<void>;

  clearError: () => void;
}

function applySnapshot(snapshot: TeamsSnapshot | undefined) {
  // 浏览器预览 shim 对未知路由返回 200 空对象：teams 必须兜底为空数组，
  // 否则 teams.forEach 等消费方直接白屏（Chat 页 ensureTeamSession effect 实测踩中）。
  return snapshot ? { teams: snapshot.teams ?? [] } : {};
}

/**
 * 每团队一条 append 请求链。
 * 服务端 append 原子加锁，但响应是全量 teams 快照：编排期间 trace 广播并发打多条
 * append，响应乱序到达时旧快照后到会覆盖新快照，后追加的消息从 UI 消失。
 * 按 teamId 串行化（后一次等前一次完成再发），保证响应顺序即发送顺序。
 */
const appendChains = new Map<string, Promise<void>>();

export const useTeamsStore = create<TeamsState>((set, get) => ({
  teams: [],
  loading: false,
  error: null,
  roomLive: {},

  updateRoomLive: (teamId, agentId, entry) => {
    set((state) => {
      const room = { ...(state.roomLive[teamId] ?? {}) };
      if (entry) room[agentId] = entry;
      else delete room[agentId];
      return { roomLive: { ...state.roomLive, [teamId]: room } };
    });
  },

  clearRoomLive: (teamId) => {
    set((state) => {
      if (!state.roomLive[teamId]) return {};
      const roomLive = { ...state.roomLive };
      delete roomLive[teamId];
      return { roomLive };
    });
  },

  fetchTeams: async () => {
    set({ loading: true, error: null });
    try {
      const snapshot = await hostApiFetch<TeamsSnapshot>('/api/teams');
      set({
        ...applySnapshot(snapshot),
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  createTeam: async (request: CreateTeamRequest) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<TeamsSnapshot>('/api/teams', {
        method: 'POST',
        body: JSON.stringify(request),
      });
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateTeam: async (teamId: string, updates: UpdateTeamRequest) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<TeamsSnapshot>(
        `/api/teams/${encodeURIComponent(teamId)}`,
        {
          method: 'PUT',
          body: JSON.stringify(updates),
        }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  deleteTeam: async (teamId: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<TeamsSnapshot>(
        `/api/teams/${encodeURIComponent(teamId)}`,
        { method: 'DELETE' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  addMember: async (teamId: string, agentId: string) => {
    const team = get().teams.find((t) => t.id === teamId);
    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }

    // Add member if not already present
    const memberIds = team.memberIds.includes(agentId)
      ? team.memberIds
      : [...team.memberIds, agentId];

    await get().updateTeam(teamId, { memberIds });
  },

  removeMember: async (teamId: string, agentId: string) => {
    const team = get().teams.find((t) => t.id === teamId);
    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }

    // Remove member from list
    const memberIds = team.memberIds.filter((id) => id !== agentId);

    await get().updateTeam(teamId, { memberIds });
  },

  clearError: () => set({ error: null }),

  appendTeamChatEvent: (teamId, event) => {
    // 本地无此团队 → 静默无操作（与读-改-写时代行为一致，也省一次必然失败的请求）
    const team = get().teams.find((t) => t.id === teamId);
    if (!team) return Promise.resolve();

    // 正式消息落房间 → 清除该发言者的「直播中」实况槽位（直播气泡被正式气泡取代）。
    if (event.from !== 'user') get().updateRoomLive(teamId, event.from, null);

    // 未读角标：房间来新消息时若用户不在该会话，未读 +1。
    // 团队房间（team:<teamId>）是纯本地会话，事件不走 handleChatEvent，未读在这里记账；
    // 用户正在该房间发消息时 currentSessionKey 命中，不会自增。动态 import 避免循环依赖。
    void import('./chat')
      .then(({ useChatStore }) => {
        const chat = useChatStore.getState();
        const sessionKey = `team:${teamId}`;
        if (chat.currentSessionKey !== sessionKey) {
          chat.updateSessionUnreadCount(sessionKey, 1);
        }
      })
      .catch(() => {});

    // 串行化：挂到该团队的链尾，等前一次响应套用快照后再发，避免乱序覆盖丢消息。
    // catch 续链：前一次失败不阻断后续 append。
    const prev = appendChains.get(teamId) ?? Promise.resolve();
    const chained = prev.catch(() => {}).then(async () => {
      set({ error: null });
      try {
        // 服务端原子 append 端点（不再读-改-写 PUT 整个 team，避免并发追加互相覆盖丢消息）；
        // createdAt 与 200 条封顶由服务端处理，返回最新 teams 快照直接套用。
        const snapshot = await hostApiFetch<TeamsSnapshot>(
          `/api/teams/${encodeURIComponent(teamId)}/chat-events`,
          {
            method: 'POST',
            body: JSON.stringify(event),
          }
        );
        set(applySnapshot(snapshot));
      } catch (error) {
        set({ error: String(error) });
        throw error;
      }
    });
    // 链上存永不 reject 的版本，本次失败不打断后续追加
    appendChains.set(teamId, chained.catch(() => {}));
    return chained;
  },
}));
