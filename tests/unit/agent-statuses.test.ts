/**
 * tests/unit/agent-statuses.test.ts
 *
 * agents store fetchAgentStatuses 忙闲派生单测（mock hostApiFetch 网络层）：
 * - in-progress 任务的 assignee → busy
 * - 无在办任务 → online（含旧 busy 状态回收）
 * - 人工标记的 offline 不被任务推导覆盖
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSummary } from '@/types/agent';
import type { KanbanTask } from '@/types/task';

const hostApiFetchMock = vi.fn();
vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

import { useAgentsStore } from '@/stores/agents';
import { useApprovalsStore } from '@/stores/approvals';

function makeAgent(id: string): AgentSummary {
  return {
    id,
    name: `成员-${id}`,
    persona: '',
    isDefault: false,
    model: '',
    modelDisplay: '',
    inheritedModel: false,
    workspace: '',
    agentDir: '',
    mainSessionKey: `agent:${id}:main`,
    channelTypes: [],
    teamRole: 'worker',
    chatAccess: 'direct',
    responsibility: '',
  };
}

function makeTask(id: string, status: KanbanTask['status'], assigneeId?: string): KanbanTask {
  return {
    id,
    title: `任务${id}`,
    description: '',
    status,
    priority: 'medium',
    workState: status === 'in-progress' ? 'working' : 'idle',
    isTeamTask: true,
    assigneeId,
  } as KanbanTask;
}

describe('fetchAgentStatuses · 忙闲派生', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
    useAgentsStore.setState({
      agents: [makeAgent('a1'), makeAgent('a2'), makeAgent('a3')],
      agentStatuses: {},
    });
    useApprovalsStore.setState({ tasks: [] });
  });

  it('in-progress 任务的 assignee → busy，其余 → online', async () => {
    useApprovalsStore.setState({
      tasks: [makeTask('t1', 'in-progress', 'a1'), makeTask('t2', 'review', 'a2'), makeTask('t3', 'done', 'a3')],
    });
    await useAgentsStore.getState().fetchAgentStatuses();
    const s = useAgentsStore.getState().agentStatuses;
    expect(s.a1).toBe('busy');
    expect(s.a2).toBe('online');
    expect(s.a3).toBe('online');
  });

  it('任务完成后 busy 回收为 online', async () => {
    useAgentsStore.setState({ agentStatuses: { a1: 'busy' } });
    useApprovalsStore.setState({ tasks: [makeTask('t1', 'done', 'a1')] });
    await useAgentsStore.getState().fetchAgentStatuses();
    expect(useAgentsStore.getState().agentStatuses.a1).toBe('online');
  });

  it('人工标记的 offline 不被任务推导覆盖', async () => {
    useAgentsStore.setState({ agentStatuses: { a1: 'offline' } });
    useApprovalsStore.setState({ tasks: [makeTask('t1', 'in-progress', 'a1')] });
    await useAgentsStore.getState().fetchAgentStatuses();
    expect(useAgentsStore.getState().agentStatuses.a1).toBe('offline');
  });

  it('无 assigneeId 的在办任务不影响任何人', async () => {
    useApprovalsStore.setState({ tasks: [makeTask('t1', 'in-progress')] });
    await useAgentsStore.getState().fetchAgentStatuses();
    const s = useAgentsStore.getState().agentStatuses;
    expect(s.a1).toBe('online');
    expect(s.a2).toBe('online');
  });
});

describe('fetchAgents 快照兜底（浏览器预览 shim）', () => {
  it('shim 返回 200 空对象（agents 等字段缺失）→ 兜底为空数组/空表，不白屏', async () => {
    hostApiFetchMock.mockReset();
    hostApiFetchMock.mockResolvedValue({}); // 模拟 shim：字段全缺失
    useAgentsStore.setState({ agents: [makeAgent('old')], agentStatuses: {} });

    await useAgentsStore.getState().fetchAgents();

    const s = useAgentsStore.getState();
    expect(s.agents).toEqual([]);
    expect(s.configuredChannelTypes).toEqual([]);
    expect(s.channelOwners).toEqual({});
    expect(s.error).toBeNull();
  });
});
