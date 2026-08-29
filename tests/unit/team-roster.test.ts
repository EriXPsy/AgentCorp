/**
 * tests/unit/team-roster.test.ts
 *
 * 团队花名册纯函数（src/lib/team-roster.ts）单测：
 * - deriveBusyAgentIds：in-progress 任务的 assignee → 忙碌；其余状态/无 assignee 不计
 * - buildTeamRoster：leader 在前、角色副标题（responsibility 优先回退 teamRole）、
 *   busy 覆盖基础状态、找不到的 agent 跳过
 * - buildBusyStatusLine：群头部实时状态行文案
 * - formatBubbleTime：气泡 hover 时间戳 HH:mm，非法输入回空串
 */
import { describe, expect, it } from 'vitest';

import {
  buildBusyStatusLine,
  buildTeamRoster,
  deriveBusyAgentIds,
  formatBubbleTime,
  memberRoleLabel,
} from '@/lib/team-roster';

describe('deriveBusyAgentIds', () => {
  it('in-progress 任务的 assignee 推导为忙碌', () => {
    const busy = deriveBusyAgentIds([
      { status: 'in-progress', assigneeId: 'a1' },
      { status: 'in-progress', assigneeId: 'a2' },
    ]);
    expect([...busy].sort()).toEqual(['a1', 'a2']);
  });

  it('todo/review/done 状态不推导为忙碌', () => {
    const busy = deriveBusyAgentIds([
      { status: 'todo', assigneeId: 'a1' },
      { status: 'review', assigneeId: 'a2' },
      { status: 'done', assigneeId: 'a3' },
    ]);
    expect(busy.size).toBe(0);
  });

  it('无 assigneeId 的 in-progress 任务忽略', () => {
    const busy = deriveBusyAgentIds([{ status: 'in-progress' }]);
    expect(busy.size).toBe(0);
  });
});

describe('memberRoleLabel', () => {
  it('responsibility 优先', () => {
    expect(memberRoleLabel({ responsibility: '前端', teamRole: 'worker' })).toBe('前端');
  });

  it('缺省回退 teamRole 标签', () => {
    expect(memberRoleLabel({ responsibility: '', teamRole: 'leader' })).toBe('负责人');
    expect(memberRoleLabel({ responsibility: '  ', teamRole: 'worker' })).toBe('成员');
  });
});

describe('buildTeamRoster', () => {
  const team = { leaderId: 'leader-1', memberIds: ['m-1', 'm-2'] };
  const agents = [
    { id: 'leader-1', name: '团长', avatar: '🧑‍💼', responsibility: '项目管理', teamRole: 'leader' as const },
    { id: 'm-1', name: '小明', avatar: '🧑', responsibility: '', teamRole: 'worker' as const },
    { id: 'm-2', name: '小红', avatar: '👩', responsibility: 'UI/UX 设计', teamRole: 'worker' as const },
  ];

  it('leader 在前，角色副标题按 responsibility/teamRole 取', () => {
    const roster = buildTeamRoster(team, agents, []);
    expect(roster.map((m) => m.id)).toEqual(['leader-1', 'm-1', 'm-2']);
    expect(roster[0].isLeader).toBe(true);
    expect(roster.map((m) => m.role)).toEqual(['项目管理', '成员', 'UI/UX 设计']);
  });

  it('in-progress 任务 assignee 覆盖基础状态为 busy', () => {
    const roster = buildTeamRoster(
      team,
      agents,
      [{ status: 'in-progress', assigneeId: 'm-1' }],
      { 'm-1': 'online', 'm-2': 'offline' },
    );
    expect(roster.find((m) => m.id === 'm-1')?.status).toBe('busy');
    expect(roster.find((m) => m.id === 'm-2')?.status).toBe('offline');
    expect(roster.find((m) => m.id === 'leader-1')?.status).toBe('online');
  });

  it('找不到的 agent id 跳过', () => {
    const roster = buildTeamRoster({ leaderId: 'ghost', memberIds: ['m-1'] }, agents, []);
    expect(roster.map((m) => m.id)).toEqual(['m-1']);
  });
});

describe('buildBusyStatusLine', () => {
  it('无忙碌成员 → 空串', () => {
    expect(buildBusyStatusLine([])).toBe('');
  });

  it('单个/多个忙碌成员', () => {
    expect(buildBusyStatusLine(['小明'])).toBe('小明 正在工作…');
    expect(buildBusyStatusLine(['小明', '小红'])).toBe('小明、小红 正在工作…');
  });
});

describe('formatBubbleTime', () => {
  it('合法 ISO 时间 → HH:mm', () => {
    expect(formatBubbleTime('2026-08-29T09:05:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
  });

  it('缺失/非法 → 空串', () => {
    expect(formatBubbleTime(undefined)).toBe('');
    expect(formatBubbleTime('not-a-date')).toBe('');
  });
});
