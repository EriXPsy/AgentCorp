// @vitest-environment jsdom
/**
 * tests/unit/team-roster-panel.test.tsx
 *
 * 成员花名册右栏（src/components/chat/TeamRosterPanel.tsx）渲染测试：
 * - 「成员 · N」头 + 成员行（头像/名字/角色副标题/leader 徽章）
 * - 状态点映射：in-progress 任务 assignee → 忙碌(amber)；其余 → 空闲(green)
 * - 点击成员行触发私聊回调；点击 ✕ 触发关闭回调
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentSummary } from '@/types/agent';
import type { KanbanTask } from '@/types/task';
import type { TeamSummary } from '@/types/team';

const hostApiFetchMock = vi.fn();
vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

import { TeamRosterPanel } from '@/components/chat/TeamRosterPanel';
import { useAgentsStore } from '@/stores/agents';
import { useApprovalsStore } from '@/stores/approvals';
import { useTeamsStore } from '@/stores/teams';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeAgent(id: string, name: string, responsibility: string, teamRole: 'leader' | 'worker'): AgentSummary {
  return {
    id,
    name,
    persona: '',
    isDefault: false,
    model: '',
    modelDisplay: '',
    inheritedModel: false,
    workspace: '',
    agentDir: '',
    mainSessionKey: `agent:${id}:main`,
    channelTypes: [],
    avatar: null,
    teamRole,
    chatAccess: 'direct',
    responsibility,
  };
}

function makeTeam(): TeamSummary {
  return {
    id: 'team-1',
    name: '官网改版',
    leaderId: 'leader-1',
    memberIds: ['m-1', 'm-2'],
    description: '',
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    memberCount: 3,
    activeTaskCount: 0,
    lastActiveTime: undefined,
    leaderName: '项目经理',
    memberAvatars: [],
  };
}

function makeTask(id: string, status: KanbanTask['status'], assigneeId?: string): KanbanTask {
  return {
    id,
    title: `任务${id}`,
    description: '',
    status,
    priority: 'medium',
    workState: 'idle',
    isTeamTask: true,
    assigneeId,
  } as KanbanTask;
}

function seedStores(tasks: KanbanTask[]) {
  useTeamsStore.setState({ teams: [makeTeam()] });
  useAgentsStore.setState({
    agents: [
      makeAgent('leader-1', '项目经理', '项目管理', 'leader'),
      makeAgent('m-1', '小明', '', 'worker'),
      makeAgent('m-2', '小红', 'UI/UX 设计', 'worker'),
    ],
    agentStatuses: {},
  });
  useApprovalsStore.setState({ tasks });
}

describe('TeamRosterPanel · 成员花名册', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
    seedStores([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('渲染「成员 · 3」头与全部成员行（名字 + 角色副标题 + leader 徽章）', () => {
    render(<TeamRosterPanel teamId="team-1" onClose={() => {}} />);
    expect(screen.getByText('成员 · 3')).toBeInTheDocument();
    expect(screen.getByText('项目经理')).toBeInTheDocument();
    expect(screen.getByText('项目管理')).toBeInTheDocument();
    expect(screen.getByText('小明')).toBeInTheDocument();
    // 无 responsibility 回退 teamRole 标签
    expect(screen.getByText('成员')).toBeInTheDocument();
    expect(screen.getByText('UI/UX 设计')).toBeInTheDocument();
    expect(screen.getByText('leader')).toBeInTheDocument();
  });

  it('状态点映射：in-progress assignee → 忙碌(amber)，其余 → 空闲(green)', () => {
    seedStores([makeTask('t1', 'in-progress', 'm-1')]);
    render(<TeamRosterPanel teamId="team-1" onClose={() => {}} />);
    expect(screen.getByText('忙碌')).toBeInTheDocument();
    expect(screen.getAllByText('空闲')).toHaveLength(2);
    expect(screen.getByTestId('roster-dot-m-1')).toHaveStyle({ background: '#f59e0b' });
    expect(screen.getByTestId('roster-dot-leader-1')).toHaveStyle({ background: '#22c55e' });
  });

  it('点击成员行触发私聊回调（带成员信息）', () => {
    const onDirectChat = vi.fn();
    render(<TeamRosterPanel teamId="team-1" onClose={() => {}} onDirectChat={onDirectChat} />);
    fireEvent.click(screen.getByTitle('私聊 小红'));
    expect(onDirectChat).toHaveBeenCalledTimes(1);
    expect(onDirectChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm-2', name: '小红', status: 'online' }),
    );
  });

  it('点击 ✕ 触发关闭回调', () => {
    const onClose = vi.fn();
    render(<TeamRosterPanel teamId="team-1" onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('关闭成员面板'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('团队不存在时渲染兜底文案', () => {
    render(<TeamRosterPanel teamId="ghost-team" onClose={() => {}} />);
    expect(screen.getByText('团队不存在或已解散。')).toBeInTheDocument();
  });
});
