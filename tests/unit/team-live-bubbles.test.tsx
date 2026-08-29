// @vitest-environment jsdom
/**
 * tests/unit/team-live-bubbles.test.tsx
 *
 * 团队房间「直播中」实况气泡（src/components/chat/TeamLiveBubbles.tsx）渲染测试：
 * - 每个 live 槽位渲染一个直播气泡：头像 + 名字·角色 + 阶段中文标签 + 进展摘要；
 * - 多成员并发各自渲染、按 updatedAt 升序排列；
 * - 成员表查不到的 agentId 退回 entry 自带名字；空 live 不渲染。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentSummary } from '@/types/agent';
import type { RoomLiveEntry } from '@/stores/teams';

import { TeamLiveBubbles } from '@/components/chat/TeamLiveBubbles';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

function makeMember(id: string, name: string, responsibility: string) {
  return {
    id,
    name,
    avatar: '🧑‍💻',
    responsibility,
    teamRole: 'worker',
  } as Pick<AgentSummary, 'id' | 'name' | 'avatar' | 'responsibility' | 'teamRole'>;
}

function live(agentName: string, phase: string, text: string, updatedAt: number): RoomLiveEntry {
  return { agentName, phase, text, updatedAt };
}

describe('TeamLiveBubbles', () => {
  it('渲染直播气泡：名字·角色 + 阶段标签 + 进展摘要 + testid', () => {
    render(
      <TeamLiveBubbles
        live={{ 'm-1': live('备用名', 'execute', '正在写第一章', 1) }}
        members={[makeMember('m-1', '小明', '前端开发')]}
      />,
    );

    expect(screen.getByTestId('live-bubble-m-1')).toBeInTheDocument();
    expect(screen.getByText('小明')).toBeInTheDocument();
    expect(screen.getByText('· 前端开发')).toBeInTheDocument();
    expect(screen.getByText('执行任务')).toBeInTheDocument();
    expect(screen.getByText(/正在写第一章/)).toBeInTheDocument();
    expect(screen.getByText('正在工作…')).toBeInTheDocument();
  });

  it('多成员并发：各占一个气泡，按 updatedAt 升序排列', () => {
    const { container } = render(
      <TeamLiveBubbles
        live={{
          'm-2': live('小红', 'review', '审阅中', 20),
          'm-1': live('小明', 'execute', '执行中', 10),
        }}
        members={[makeMember('m-1', '小明', '前端开发'), makeMember('m-2', '小红', '测试')]}
      />,
    );

    const bubbles = container.querySelectorAll('[data-testid^="live-bubble-"]');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].getAttribute('data-testid')).toBe('live-bubble-m-1');
    expect(bubbles[1].getAttribute('data-testid')).toBe('live-bubble-m-2');
    expect(screen.getByText('审阅产出')).toBeInTheDocument();
  });

  it('成员表查不到的 agentId：退回 entry 自带名字，无角色副标题', () => {
    render(<TeamLiveBubbles live={{ ghost: live('幽灵成员', 'summarize', '汇总中', 1) }} members={[]} />);

    expect(screen.getByTestId('live-bubble-ghost')).toBeInTheDocument();
    expect(screen.getByText('幽灵成员')).toBeInTheDocument();
    expect(screen.getByText('汇总交付')).toBeInTheDocument();
  });

  it('空 live 不渲染任何内容', () => {
    const { container } = render(<TeamLiveBubbles live={{}} members={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
