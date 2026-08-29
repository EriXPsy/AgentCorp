/**
 * Chats Page — 独立「会话」页
 * 左侧全高会话列表（分组：团队房间 / 任务会话 / Agent 会话），可收起；
 * 右侧复用 ChatMainArea 渲染对应会话的完整聊天区。
 * 团队房间由 teams store 兜底列出，点击时 ensureTeamSession 再 switchSession。
 *
 * 布局约束：根容器 h-full + overflow-hidden，左右两栏各自 min-h-0 独立滚动，
 * 聊天内容再长也不会把左侧列表带走。
 */
import { useEffect, useMemo, useState } from 'react';
import { ClipboardList, MessageSquare, PanelLeftClose, PanelLeftOpen, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ChatMainArea } from '@/components/chat/ChatMainArea';
import { TeamRosterPanel } from '@/components/chat/TeamRosterPanel';
import { groupChatSessions, type ChatSessionListItem } from '@/lib/chat-session-groups';
import type { RosterMember } from '@/lib/team-roster';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/stores/agents';
import { useApprovalsStore } from '@/stores/approvals';
import { useChatStore } from '@/stores/chat';
import { useRightPanelStore } from '@/stores/rightPanelStore';
import { useTeamsStore } from '@/stores/teams';

/** 列表副标题：相对时间（活跃时间未知则不显示）。 */
function formatRelativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function SessionRow({
  item,
  icon: Icon,
  active,
  onClick,
}: {
  item: ChatSessionListItem;
  icon: typeof Users;
  active: boolean;
  onClick: () => void;
}) {
  const subtitle = formatRelativeTime(item.lastActivity);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-2xl px-2.5 py-2 text-left transition-all duration-200',
        active
          ? 'bg-[#FFD233] shadow-md'
          : 'hover:bg-white hover:shadow-sm',
      )}
    >
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors',
          active ? 'bg-black/10 text-[#1A1C1E]' : 'bg-black/[0.05] text-[var(--neu-ink-soft)] group-hover:bg-[#FFD233]/20 group-hover:text-[#1A1C1E]',
        )}
      >
        <Icon className="h-4 w-4" strokeWidth={1.8} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-[13px] leading-tight',
            active ? 'font-bold text-[#1A1C1E]' : 'font-medium text-[var(--neu-ink)]',
          )}
        >
          {item.label}
        </span>
        {subtitle ? (
          <span
            className={cn(
              'mt-0.5 block text-[11px] leading-tight',
              active ? 'text-[#1A1C1E]/60' : 'text-[var(--neu-ink-soft)]',
            )}
          >
            {subtitle}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function SessionGroup({
  icon,
  title,
  items,
  currentSessionKey,
  onSelect,
}: {
  icon: typeof Users;
  title: string;
  items: ChatSessionListItem[];
  currentSessionKey: string;
  onSelect: (item: ChatSessionListItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="px-3 pb-2">
      <div className="sticky top-0 z-10 -mx-1 flex items-center gap-1.5 bg-[var(--neu-surface)]/90 px-3 pb-1.5 pt-3 backdrop-blur-sm">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--neu-ink-soft)]">
          {title}
        </span>
        <span className="rounded-full bg-black/[0.05] px-1.5 py-px text-[10px] font-bold text-[var(--neu-ink-soft)]">
          {items.length}
        </span>
      </div>
      <div className="space-y-1">
        {items.map((item) => (
          <SessionRow
            key={item.key}
            item={item}
            icon={icon}
            active={item.key === currentSessionKey}
            onClick={() => onSelect(item)}
          />
        ))}
      </div>
    </div>
  );
}

export function Chats() {
  const { t } = useTranslation();
  const tChats = (key: string, defaultValue: string) =>
    t(`common:chatsPage.${key}`, { defaultValue });

  const sessions = useChatStore((s) => s.sessions);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessionLastActivity = useChatStore((s) => s.sessionLastActivity);
  const switchSession = useChatStore((s) => s.switchSession);

  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const teams = useTeamsStore((s) => s.teams);
  const fetchTeams = useTeamsStore((s) => s.fetchTeams);
  const tasks = useApprovalsStore((s) => s.tasks);
  const fetchTasks = useApprovalsStore((s) => s.fetchTasks);

  const [listOpen, setListOpen] = useState(true);

  // 成员花名册右栏：团队房间头部头像叠放区打开（rightPanelStore type='roster'），与 Chat 页同款挂载
  const rightPanelType = useRightPanelStore((s) => s.type);
  const rosterTeamId = useRightPanelStore((s) => s.teamId);
  const closeRightPanel = useRightPanelStore((s) => s.closePanel);

  useEffect(() => {
    void fetchAgents();
    void fetchTeams();
    void fetchTasks();
  }, [fetchAgents, fetchTeams, fetchTasks]);

  // 团队房间：为每个团队确保一条会话条目（与首页同款兜底 effect）
  useEffect(() => {
    const ensure = useChatStore.getState().ensureTeamSession;
    teams.forEach((team) => ensure({ id: team.id, name: team.name }));
  }, [teams]);

  const groups = useMemo(
    () => groupChatSessions(sessions, teams, { tasks, agents, sessionLastActivity }),
    [sessions, teams, tasks, agents, sessionLastActivity],
  );

  const currentSession = sessions.find((s) => s.key === currentSessionKey) ?? null;
  const currentTeamTaskId = currentSession?.teamTaskId ?? null;
  const currentTeamRoomId = currentSession?.isTeamSession && !currentTeamTaskId
    ? currentSession.teamId ?? null
    : null;

  const handleSelect = (item: ChatSessionListItem) => {
    if (item.missing) {
      // teams 兜底出来的房间：先 ensure 再切换
      const team = teams.find((t2) => `team:${t2.id}` === item.key);
      if (team) {
        useChatStore.getState().ensureTeamSession({ id: team.id, name: team.name });
      }
    }
    switchSession(item.key);
  };

  // 花名册成员 → 私聊（与 Chat 页同逻辑）
  const handleRosterDirectChat = (member: RosterMember) => {
    const team = teams.find((t) => t.id === rosterTeamId);
    try {
      useChatStore.getState().openDirectAgentSession(member.id, {
        teamId: team?.id ?? rosterTeamId ?? undefined,
        teamName: team?.name,
        isLeaderChat: member.id === team?.leaderId,
      });
    } catch {
      /* agent 不存在时忽略 */
    }
  };

  const totalCount = groups.teamRooms.length + groups.taskSessions.length + groups.agentSessions.length;

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden bg-white dark:bg-background">
      {/* 左侧会话列表：可收起；宽度动画时内层固定 w-72 防止内容挤压 */}
      <aside
        className={cn(
          'h-full shrink-0 overflow-hidden border-black/[0.06] bg-[var(--neu-surface)] transition-[width] duration-300',
          listOpen ? 'w-72 border-r' : 'w-0 border-r-0',
        )}
      >
        <div className="flex h-full w-72 flex-col">
          <div className="flex h-[52px] shrink-0 items-center justify-between px-5">
            <h1 className="text-[15px] font-semibold text-foreground">{tChats('title', '会话')}</h1>
            <button
              type="button"
              aria-label={tChats('collapseList', '收起会话列表')}
              title={tChats('collapseList', '收起会话列表')}
              onClick={() => setListOpen(false)}
              className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/60 text-[var(--neu-ink-soft)] shadow-sm transition-all hover:bg-white hover:text-[#1A1C1E] hover:shadow-md"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-4">
            <SessionGroup
              icon={Users}
              title={tChats('teamRooms', '团队房间')}
              items={groups.teamRooms}
              currentSessionKey={currentSessionKey}
              onSelect={handleSelect}
            />
            <SessionGroup
              icon={ClipboardList}
              title={tChats('taskSessions', '任务会话')}
              items={groups.taskSessions}
              currentSessionKey={currentSessionKey}
              onSelect={handleSelect}
            />
            <SessionGroup
              icon={MessageSquare}
              title={tChats('agentSessions', 'Agent 会话')}
              items={groups.agentSessions}
              currentSessionKey={currentSessionKey}
              onSelect={handleSelect}
            />
            {totalCount === 0 && (
              <p className="px-5 py-4 text-[13px] text-[var(--neu-ink-soft)]">
                {tChats('empty', '暂无会话')}
              </p>
            )}
          </div>
        </div>
      </aside>

      {/* 右侧聊天区：min-h-0 + 根容器 overflow-hidden，内容滚动不外溢 */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {!listOpen && (
          <button
            type="button"
            aria-label={tChats('expandList', '展开会话列表')}
            title={tChats('expandList', '展开会话列表')}
            onClick={() => setListOpen(true)}
            className="absolute left-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-xl border border-black/[0.06] bg-white/90 text-[var(--neu-ink-soft)] shadow-md backdrop-blur-sm transition-all hover:text-[#1A1C1E] hover:shadow-lg"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}
        <ChatMainArea
          variant={currentTeamTaskId ? 'teamTask' : currentTeamRoomId ? 'teamRoom' : 'agent'}
          taskId={currentTeamTaskId}
          teamId={currentTeamRoomId}
        />
      </div>

      {/* 成员花名册右栏（团队房间头部头像区打开） */}
      {rightPanelType === 'roster' && rosterTeamId && (
        <TeamRosterPanel
          teamId={rosterTeamId}
          onClose={closeRightPanel}
          onDirectChat={handleRosterDirectChat}
        />
      )}
    </div>
  );
}

export default Chats;
