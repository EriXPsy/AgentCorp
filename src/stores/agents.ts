import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { deriveBusyAgentIds } from '@/lib/team-roster';
import { useApprovalsStore } from '@/stores/approvals';
import type { ChannelType } from '@/types/channel';
import type { AgentChatAccess, AgentLifecycleStatus, AgentRoleCardInput, AgentSummary, AgentsSnapshot, AgentTeamRole } from '@/types/agent';

// agentId → 人格文本（null 表示该 agent 没有 SOUL.md 或读取失败）。
// 模块级缓存：同一 agentId 只走一次 IPC，避免重复读盘。
const personaCache = new Map<string, string | null>();

interface AgentsState {
  agents: AgentSummary[];
  defaultAgentId: string;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  agentStatuses: Record<string, 'online' | 'offline' | 'busy'>;
  agentLifecycleStatuses: Record<string, AgentLifecycleStatus>;
  agentSessionCounts: Record<string, number>;
  loading: boolean;
  error: string | null;
  fetchAgents: () => Promise<void>;
  createAgent: (input: {
    name: string;
    persona?: string;
    teamRole?: AgentTeamRole;
    model?: string;
    roleCard?: AgentRoleCardInput;
  }) => Promise<{ createdAgentId: string }>;
  updateAgent: (
    agentId: string,
    updates: {
      name?: string;
      persona?: string;
      model?: string;
      avatar?: string | null;
      reportsTo?: string | null;
      teamRole?: AgentTeamRole;
      chatAccess?: AgentChatAccess;
      responsibility?: string;
      roleCard?: AgentRoleCardInput;
    },
  ) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  assignChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  removeChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  updateAgentStatus: (agentId: string, status: 'online' | 'offline' | 'busy') => void;
  fetchAgentStatuses: () => Promise<void>;
  getAgentPersona: (agentId: string) => Promise<string | null>;
  clearError: () => void;
}

function applySnapshot(snapshot: AgentsSnapshot | undefined) {
  // 浏览器预览 shim 可能返回 200 空对象：各字段兜底，防消费方 .map/.forEach 白屏。
  return snapshot ? {
    agents: snapshot.agents ?? [],
    defaultAgentId: snapshot.defaultAgentId ?? null,
    configuredChannelTypes: snapshot.configuredChannelTypes ?? [],
    channelOwners: snapshot.channelOwners ?? {},
  } : {};
}

function deriveLifecycleStatus(
  status: 'online' | 'offline' | 'busy' | undefined,
  _sessionCount: number
): AgentLifecycleStatus {
  if (status === 'offline') return 'maintenance';
  if (status === 'busy') return 'training';
  // Online agents (with or without sessions) are active — they've been hired/deployed
  return 'active';
}

export const useAgentsStore = create<AgentsState>((set) => ({
  agents: [],
  defaultAgentId: 'main',
  configuredChannelTypes: [],
  channelOwners: {},
  agentStatuses: {},
  agentLifecycleStatuses: {},
  agentSessionCounts: {},
  loading: false,
  error: null,

  fetchAgents: async () => {
    set({ loading: true, error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents');
      set((state) => {
        const newState = {
          ...applySnapshot(snapshot),
          loading: false,
        };
        const statuses: Record<string, 'online' | 'offline' | 'busy'> = {};
        const lifecycleStatuses: Record<string, AgentLifecycleStatus> = {};
        const sessionCounts: Record<string, number> = {};
        const agentsWithLifecycle: AgentSummary[] = [];

        for (const agent of newState.agents || []) {
          const prevStatus = state.agentStatuses[agent.id] || 'online';
          statuses[agent.id] = prevStatus;
          sessionCounts[agent.id] = state.agentSessionCounts[agent.id] || 0;
          lifecycleStatuses[agent.id] = deriveLifecycleStatus(
            prevStatus,
            sessionCounts[agent.id]
          );
          agentsWithLifecycle.push({ ...agent, lifecycleStatus: lifecycleStatuses[agent.id] });
        }

        return {
          ...newState,
          agents: agentsWithLifecycle,
          agentStatuses: statuses,
          agentLifecycleStatuses: lifecycleStatuses,
          agentSessionCounts: sessionCounts,
        };
      });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  createAgent: async (input) => {
    set({ error: null });
    try {
      const result = await hostApiFetch<AgentsSnapshot & { success?: boolean; createdAgentId: string }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      set(applySnapshot(result));
      return { createdAgentId: result.createdAgentId };
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgent: async (
    agentId: string,
    updates: {
      name?: string;
      persona?: string;
      model?: string;
      avatar?: string | null;
      reportsTo?: string | null;
      teamRole?: AgentTeamRole;
      chatAccess?: AgentChatAccess;
      responsibility?: string;
      roleCard?: AgentRoleCardInput;
    },
  ) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}`,
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

  deleteAgent: async (agentId: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}`,
        { method: 'DELETE' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  assignChannel: async (agentId: string, channelType: ChannelType) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}`,
        { method: 'PUT' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  removeChannel: async (agentId: string, channelType: ChannelType) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}`,
        { method: 'DELETE' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgentStatus: (agentId: string, status: 'online' | 'offline' | 'busy') => {
    set((state) => {
      const agent = state.agents.find((a) => a.id === agentId);
      const lifecycleStatus = agent
        ? deriveLifecycleStatus(status, state.agentSessionCounts[agentId] || 0)
        : state.agentLifecycleStatuses[agentId];
      return {
        agentStatuses: {
          ...state.agentStatuses,
          [agentId]: status,
        },
        agentLifecycleStatuses: {
          ...state.agentLifecycleStatuses,
          [agentId]: lifecycleStatus,
        },
        agents: state.agents.map((a) =>
          a.id === agentId ? { ...a, lifecycleStatus } : a
        ),
      };
    });
  },

  fetchAgentStatuses: async () => {
    // 忙闲派生：任一 in-progress 看板任务的 assignee → busy；
    // 其余沿用已有基础状态（默认 online，人工标记的 offline 不被任务推导覆盖）。
    // Gateway 若以后提供状态 API，可在此基础上叠加。
    const busyIds = deriveBusyAgentIds(useApprovalsStore.getState().tasks);
    set((state) => {
      const statuses: Record<string, 'online' | 'offline' | 'busy'> = {};
      for (const agent of state.agents) {
        const prev = state.agentStatuses[agent.id] || 'online';
        statuses[agent.id] = prev === 'offline' ? 'offline' : busyIds.has(agent.id) ? 'busy' : 'online';
      }
      return { agentStatuses: statuses };
    });
  },

  getAgentPersona: async (agentId: string) => {
    // 命中缓存直接返回（包括已确认的 null）
    if (personaCache.has(agentId)) {
      return personaCache.get(agentId) ?? null;
    }
    try {
      const res = await invokeIpc<{ success?: boolean; persona?: string | null }>('agent:getPersona', agentId);
      const persona = res?.success ? (res.persona ?? null) : null;
      personaCache.set(agentId, persona);
      return persona;
    } catch (error) {
      // IPC 失败同样按「无人格」处理并缓存，不向上抛错
      console.warn(`[agents] getAgentPersona(${agentId}) failed:`, error);
      personaCache.set(agentId, null);
      return null;
    }
  },

  clearError: () => set({ error: null }),
}));
