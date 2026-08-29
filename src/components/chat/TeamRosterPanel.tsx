/**
 * src/components/chat/TeamRosterPanel.tsx
 * 团队成员花名册右栏（Knowe 风格）：「成员 · N」头 + 成员行
 * （圆头像 + 名字/角色副标题 + 右侧状态点：忙碌 amber / 空闲 green / 离线 gray）。
 * 点击成员行触发私聊回调；数据来源：teams/agents/approvals store，
 * 忙闲由 in-progress 任务 assignee 实时推导（见 lib/team-roster）。
 */
import { useMemo } from 'react';
import { useAgentsStore } from '@/stores/agents';
import { useApprovalsStore } from '@/stores/approvals';
import { useTeamsStore } from '@/stores/teams';
import { buildTeamRoster, type RosterMember, type RosterStatus } from '@/lib/team-roster';
import { AgentAvatar } from '@/components/chat/AgentAvatar';

const STATUS_META: Record<RosterStatus, { dot: string; label: string }> = {
  busy: { dot: '#f59e0b', label: '忙碌' },
  online: { dot: '#22c55e', label: '空闲' },
  offline: { dot: '#c7c7cc', label: '离线' },
};

export function TeamRosterPanel({
  teamId,
  onClose,
  onDirectChat,
}: {
  teamId: string;
  onClose: () => void;
  onDirectChat?: (member: RosterMember) => void;
}) {
  const teams = useTeamsStore((s) => s.teams);
  const agents = useAgentsStore((s) => s.agents);
  const agentStatuses = useAgentsStore((s) => s.agentStatuses);
  const tasks = useApprovalsStore((s) => s.tasks);

  const team = teams.find((t) => t.id === teamId) ?? null;
  const roster = useMemo(
    () => (team ? buildTeamRoster(team, agents, tasks, agentStatuses) : []),
    [team, agents, tasks, agentStatuses],
  );

  if (!team) {
    return (
      <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-black/[0.06] bg-white dark:border-white/10 dark:bg-background">
        <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-black/[0.06] px-5">
          <span className="text-[14px] font-semibold text-[#000000]">成员</span>
          <button
            type="button"
            aria-label="关闭成员面板"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-[16px] text-[#8e8e93] transition-colors hover:bg-[#f2f2f7] hover:text-[#000000]"
          >
            ✕
          </button>
        </header>
        <p className="px-5 py-6 text-[12px] text-muted-foreground">团队不存在或已解散。</p>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col overflow-y-auto border-l border-black/[0.06] bg-white dark:border-white/10 dark:bg-background">
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-black/[0.06] px-5">
        <span className="text-[14px] font-semibold text-[#000000]">成员 · {roster.length}</span>
        <button
          type="button"
          aria-label="关闭成员面板"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-full text-[16px] text-[#8e8e93] transition-colors hover:bg-[#f2f2f7] hover:text-[#000000]"
        >
          ✕
        </button>
      </header>
      <div className="flex flex-col gap-0 px-3 py-3">
        {roster.map((m) => (
          <button
            key={m.id}
            type="button"
            title={`私聊 ${m.name}`}
            onClick={() => onDirectChat?.(m)}
            className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-[#f2f2f7]"
          >
            <AgentAvatar
              avatar={m.avatar}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-[18px]"
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                <span className="truncate">{m.name}</span>
                {m.isLeader && (
                  <span
                    className="shrink-0 rounded px-1 py-px text-[9px] font-bold"
                    style={{ background: '#FFD23333', color: '#b8860b' }}
                  >
                    leader
                  </span>
                )}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{m.role}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                data-testid={`roster-dot-${m.id}`}
                className="h-2 w-2 rounded-full"
                style={{ background: STATUS_META[m.status].dot }}
              />
              {STATUS_META[m.status].label}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

export default TeamRosterPanel;
