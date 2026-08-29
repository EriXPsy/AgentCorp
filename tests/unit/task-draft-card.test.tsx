// @vitest-environment jsdom
/**
 * tests/unit/task-draft-card.test.tsx
 *
 * 立项确认卡（src/components/chat/TaskDraftCard.tsx）Knowe 化渲染测试：
 * - pending：标题行「派发任务」+ 剩余 mm:ss 倒计时（fake timers 走秒）、
 *   说明文案、被指派人行、引用指令块、按钮组回调（确认/拒绝/我有新意见）
 * - 终态流转：超时（15 分钟默认窗口）→「已超时」；confirmed/cancelled/superseded → 对应文案，按钮消失
 * - 倒计时纯函数（getTaskDraftPhase/formatDraftRemainingMs）与协议解析回归
 *   （buildTaskDraftEvent/parseTaskDraftEvent/collectTaskDraftResolutions 格式不变）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { TaskDraftCard } from '@/components/chat/TaskDraftCard';
import {
  TASK_DRAFT_TIMEOUT_MS,
  buildTaskDraftEvent,
  buildTaskDraftResolution,
  collectTaskDraftResolutions,
  formatDraftRemainingMs,
  getTaskDraftPhase,
  parseTaskDraftEvent,
  parseTaskDraftResolution,
} from '@/lib/team-task-chat';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CARD = { id: 'd1-1', title: '官网首页响应式走查', requirement: '对「方向 A」首页做响应式走查，输出问题清单。' };
const NOW = new Date('2026-08-29T10:00:00.000Z').getTime();

function renderCard(overrides: Partial<Parameters<typeof TaskDraftCard>[0]> = {}) {
  const props = {
    card: CARD,
    createdAt: new Date(NOW).toISOString(),
    assignee: { name: '方明志', role: '测试' },
    action: null,
    onConfirm: vi.fn(),
    onReject: vi.fn(),
    onRevise: vi.fn(),
    ...overrides,
  };
  render(<TaskDraftCard {...props} />);
  return props;
}

describe('TaskDraftCard · pending 态', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('渲染标题行、说明、被指派人行、引用指令块与 15:00 初始倒计时', () => {
    renderCard();
    expect(screen.getByText('派发任务')).toBeInTheDocument();
    expect(screen.getByText('剩余 15:00')).toBeInTheDocument();
    expect(screen.getByText('需要你确认后，任务才会派发给成员')).toBeInTheDocument();
    expect(screen.getByText('官网首页响应式走查')).toBeInTheDocument();
    expect(screen.getByText('方明志')).toBeInTheDocument();
    expect(screen.getByText('测试')).toBeInTheDocument();
    expect(screen.getByText(/对「方向 A」首页做响应式走查/)).toBeInTheDocument();
  });

  it('倒计时每秒走表：61 秒后显示 13:59', () => {
    renderCard();
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByText('剩余 13:59')).toBeInTheDocument();
  });

  it('按钮回调：确认 / 拒绝 / 我有新意见', () => {
    const props = renderCard();
    fireEvent.click(screen.getByText('确认'));
    fireEvent.click(screen.getByText('拒绝'));
    fireEvent.click(screen.getByText('我有新意见'));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onReject).toHaveBeenCalledTimes(1);
    expect(props.onRevise).toHaveBeenCalledTimes(1);
  });

  it('超时后转「已超时」终态：按钮消失、倒计时消失', () => {
    renderCard();
    act(() => {
      vi.advanceTimersByTime(TASK_DRAFT_TIMEOUT_MS + 1000);
    });
    expect(screen.getByText('已超时，请重新发起')).toBeInTheDocument();
    expect(screen.queryByText('确认')).not.toBeInTheDocument();
    expect(screen.queryByText(/剩余/)).not.toBeInTheDocument();
  });
});

describe('TaskDraftCard · 处置终态', () => {
  afterEach(() => {
    cleanup();
  });

  it('confirmed → 已确认，任务派发中', () => {
    renderCard({ action: 'confirmed' });
    expect(screen.getByText('✅ 已确认，任务派发中')).toBeInTheDocument();
    expect(screen.queryByText('确认')).not.toBeInTheDocument();
  });

  it('cancelled → 已拒绝，本次不派发', () => {
    renderCard({ action: 'cancelled' });
    expect(screen.getByText('已拒绝，本次不派发')).toBeInTheDocument();
  });

  it('superseded → 已被新草稿取代', () => {
    renderCard({ action: 'superseded' });
    expect(screen.getByText('已被新草稿取代')).toBeInTheDocument();
  });

  it('已处置的草稿即使超过 15 分钟也保持处置终态（不回超时）', () => {
    renderCard({ action: 'confirmed', createdAt: new Date(NOW - TASK_DRAFT_TIMEOUT_MS - 1000).toISOString() });
    expect(screen.getByText('✅ 已确认，任务派发中')).toBeInTheDocument();
  });
});

describe('草稿卡倒计时纯函数', () => {
  it('getTaskDraftPhase：处置优先于超时', () => {
    const createdAt = new Date(NOW).toISOString();
    expect(getTaskDraftPhase(null, createdAt, NOW)).toBe('pending');
    expect(getTaskDraftPhase(null, createdAt, NOW + TASK_DRAFT_TIMEOUT_MS)).toBe('expired');
    expect(getTaskDraftPhase('confirmed', createdAt, NOW + TASK_DRAFT_TIMEOUT_MS * 2)).toBe('confirmed');
    expect(getTaskDraftPhase(null, undefined, NOW + TASK_DRAFT_TIMEOUT_MS * 2)).toBe('pending');
  });

  it('formatDraftRemainingMs：mm:ss，负值归零', () => {
    expect(formatDraftRemainingMs(900_000)).toBe('15:00');
    expect(formatDraftRemainingMs(839_000)).toBe('13:59');
    expect(formatDraftRemainingMs(0)).toBe('00:00');
    expect(formatDraftRemainingMs(-5_000)).toBe('00:00');
  });
});

describe('立项卡协议解析回归（格式不变）', () => {
  it('草稿事件往返解析', () => {
    const content = buildTaskDraftEvent({ title: CARD.title, requirement: CARD.requirement });
    expect(content.startsWith('[task-draft]')).toBe(true);
    const card = parseTaskDraftEvent(content);
    expect(card?.title).toBe(CARD.title);
    expect(card?.requirement).toBe(CARD.requirement);
    expect(card?.id).toBeTruthy();
  });

  it('处置事件往返解析与汇总（最新生效）', () => {
    const confirmed = buildTaskDraftResolution('d1-1', 'confirmed');
    expect(parseTaskDraftResolution(confirmed)).toEqual({ id: 'd1-1', action: 'confirmed' });
    const map = collectTaskDraftResolutions([
      { content: buildTaskDraftResolution('d1-1', 'confirmed') },
      { content: '普通聊天' },
      { content: buildTaskDraftResolution('d1-1', 'superseded') },
    ]);
    expect(map.get('d1-1')).toBe('superseded');
  });
});
