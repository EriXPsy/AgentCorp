/**
 * Chat Page
 * Native React implementation communicating with OpenClaw Gateway
 * via gateway:rpc IPC. The page now acts as the main KaiTianClaw
 * workbench surface while retaining the existing chat runtime wiring.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Bot } from 'lucide-react';
import { useChatStore } from '@/stores/chat';
import { toast } from 'sonner';
import { useAgentsStore } from '@/stores/agents';
import { useTeamsStore } from '@/stores/teams';
import { useRightPanelStore } from '@/stores/rightPanelStore';
import { useSettingsStore } from '@/stores/settings';
import { ContextRail } from '@/components/workbench/context-rail';
import { ChatMainArea } from '@/components/chat/ChatMainArea';
import { TeamRosterPanel } from '@/components/chat/TeamRosterPanel';
import type { RosterMember } from '@/lib/team-roster';
import { isSystemInjectedUserMessage, extractReminderContent } from './message-utils';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  buildLeaderOnlyBlockedMessage,
  isDirectMainSessionBlocked,
  resolveReportingLeader,
} from '@/lib/team-chat-access';
import { buildLeaderProgressBrief } from '@/lib/team-progress-brief';

export function Chat() {
  const { t } = useTranslation(['chat', 'common']);
  const navigate = useNavigate();
  const rightPanelMode = useSettingsStore((s) => s.rightPanelMode);
  const openPanel = useRightPanelStore((s) => s.openPanel);
  // 成员花名册右栏：由 TeamChatView 头部头像叠放区打开（rightPanelStore type='roster'）
  const rightPanelType = useRightPanelStore((s) => s.type);
  const rosterTeamId = useRightPanelStore((s) => s.teamId);
  const closeRightPanel = useRightPanelStore((s) => s.closePanel);

  const messages = useChatStore((s) => s.messages);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessions = useChatStore((s) => s.sessions);
  const currentSession = sessions.find((s) => s.key === currentSessionKey) ?? null;
  const currentTeamTaskId = currentSession?.teamTaskId ?? null;
  // 团队房间：isTeamSession 且不带具体任务
  const currentTeamRoomId = currentSession?.isTeamSession && !currentTeamTaskId
    ? currentSession.teamId ?? null
    : null;
  const sending = useChatStore((s) => s.sending);
  const isRunActive = sending;
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const sessionLastActivity = useChatStore((s) => s.sessionLastActivity);
  const cleanupEmptySession = useChatStore((s) => s.cleanupEmptySession);

  const agents = useAgentsStore((s) => s.agents);
  const configuredChannelTypes = useAgentsStore((s) => s.configuredChannelTypes);
  const channelOwners = useAgentsStore((s) => s.channelOwners);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const teams = useTeamsStore((s) => s.teams);
  const fetchTeams = useTeamsStore((s) => s.fetchTeams);

  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [teamBriefOpen, setTeamBriefOpen] = useState(false);
  const agentPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!agentPickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) {
        setAgentPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [agentPickerOpen]);

  const switchSession = useChatStore((s) => s.switchSession);
  const currentAgentName = agents.find((agent) => agent.id === currentAgentId)?.name ?? 'AgentCorp';
  const currentAgent = agents.find((agent) => agent.id === currentAgentId) ?? null;
  const teamBrief = useMemo(
    () => buildLeaderProgressBrief({
      leaderId: currentAgentId ?? 'main',
      agents,
      sessionLastActivity,
      configuredChannelTypes,
      channelOwners,
    }),
    [agents, channelOwners, configuredChannelTypes, currentAgentId, sessionLastActivity],
  );

  useEffect(() => {
    return () => {
      cleanupEmptySession();
    };
  }, [cleanupEmptySession]);

  useEffect(() => {
    void fetchAgents();
    void fetchTeams();
  }, [fetchAgents, fetchTeams]);

  // 花名册成员 → 私聊（与 TeamChatView 原头部私聊按钮同逻辑）
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

  // 团队房间：为每个团队确保一条会话条目（组建团队即出现在会话列表）
  useEffect(() => {
    const ensure = useChatStore.getState().ensureTeamSession;
    teams.forEach((t) => ensure({ id: t.id, name: t.name }));
  }, [teams]);

  useEffect(() => {
    if (currentSessionKey || agents.length === 0) return;
    const mainAgent = agents.find((agent) => agent.isDefault) ?? agents.find((agent) => agent.id === 'main') ?? null;
    if (mainAgent?.mainSessionKey) {
      switchSession(mainAgent.mainSessionKey);
    }
  }, [agents, currentSessionKey, switchSession]);

  // Push notification to the bell when system-injected reminder messages arrive
  const notifiedKeysRef = useRef(new Set<string>());
  useEffect(() => {
    for (const msg of messages) {
      if (!isSystemInjectedUserMessage(msg)) continue;
      // Use id, or fall back to a content-based fingerprint for messages without id
      const key = msg.id
        || `ts:${msg.timestamp ?? 0}:${String(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)).slice(0, 80)}`;
      if (notifiedKeysRef.current.has(key)) continue;
      notifiedKeysRef.current.add(key);
      const reminder = extractReminderContent(msg);
      toast(reminder ? `提醒：${reminder}` : '定时提醒已触发');
    }
  }, [messages]);

  return (
    <div className={cn('relative flex h-full min-h-0 bg-white transition-colors duration-500 dark:bg-background')}>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[52px] shrink-0 items-center justify-between gap-4 bg-white px-5 dark:bg-background">
          <div ref={agentPickerRef} className="relative flex min-w-0 items-center gap-[6px]">
          {currentTeamTaskId || currentTeamRoomId ? (
            <div className="flex items-center gap-1 px-2 py-1">
              <h1 className="truncate text-[15px] font-semibold text-foreground">
                {currentSession?.displayName ?? '团队'}
              </h1>
            </div>
          ) : (
          <button
            type="button"
            onClick={() => setAgentPickerOpen((v) => !v)}
            className="flex items-center gap-1 rounded-lg px-2 py-1 transition-colors hover:bg-[#f2f2f7]"
          >
            {currentAgent?.avatar ? (
              <img src={currentAgent.avatar} alt="" className="h-5 w-5 rounded-full object-cover" />
            ) : null}
            <h1 className="truncate text-[15px] font-semibold text-foreground">
              {currentAgentName}
            </h1>
            <span className="text-[12px] text-[#8e8e93]">▾</span>
          </button>
          )}
          {isRunActive && (
            <span className="text-[12px] font-medium text-muted-foreground whitespace-nowrap">
              {currentAgentName} 正在思考中
            </span>
          )}
            {agentPickerOpen && agents.length > 0 && (
              <div className="absolute left-0 top-full z-50 mt-1 w-[200px] overflow-hidden rounded-xl border border-black/[0.08] bg-white shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => {
                      if (isDirectMainSessionBlocked(agent, agent.mainSessionKey)) {
                        toast.error(buildLeaderOnlyBlockedMessage(agent, resolveReportingLeader(agent, agents)));
                        setAgentPickerOpen(false);
                        return;
                      }
                      switchSession(agent.mainSessionKey);
                      setAgentPickerOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-[#f2f2f7]',
                      agent.id === currentAgentId && 'bg-[#f2f2f7] font-medium',
                    )}
                  >
                    {agent.avatar ? (
                      <img src={agent.avatar} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
                    ) : (
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-agentcorp-ac text-[11px] text-white">✦</span>
                    )}
                    <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                    {agent.id === currentAgentId && <span className="shrink-0 text-[10px] text-agentcorp-ac">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={t('common:rightPanel.openFiles', { defaultValue: 'Open files panel' })}
              onClick={() => openPanel('file', currentAgentId ?? undefined)}
              className={cn(
                'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                rightPanelMode === 'files'
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <FileText className="h-4 w-4" strokeWidth={1.5} />
              <span>{t('common:workbench.files')}</span>
            </button>
            <button
              type="button"
              aria-label={t('common:rightPanel.openAgent', { defaultValue: 'Open agent panel' })}
              onClick={() => openPanel('agent', currentAgentId ?? undefined)}
              className={cn(
                'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                rightPanelMode === 'agent'
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <Bot className="h-4 w-4" strokeWidth={1.5} />
              <span>{t('common:workbench.agent')}</span>
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <ChatMainArea
            variant={currentTeamTaskId ? 'teamTask' : currentTeamRoomId ? 'teamRoom' : 'agent'}
            taskId={currentTeamTaskId}
            teamId={currentTeamRoomId}
          />

          {rightPanelMode !== null && <ContextRail />}
          {rightPanelType === 'roster' && rosterTeamId && (
            <TeamRosterPanel
              teamId={rosterTeamId}
              onClose={closeRightPanel}
              onDirectChat={handleRosterDirectChat}
            />
          )}
        </div>
      </div>

      {teamBriefOpen && (
        <aside className="absolute right-0 top-0 z-40 flex h-full w-[340px] flex-col overflow-y-auto border-l border-black/[0.06] bg-white">
          <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-black/[0.06] px-5">
            <span className="text-[14px] font-semibold text-[#000000]">{t('common:teamBrief.title')}</span>
            <button
              type="button"
              aria-label="close-team-brief"
              onClick={() => setTeamBriefOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-[16px] text-[#8e8e93] transition-colors hover:bg-[#f2f2f7]"
            >
              ×
            </button>
          </header>
          <div className="space-y-4 px-5 py-4">
            <div className="rounded-2xl border border-black/[0.06] bg-[#fffaf3] p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#b45309]">{t('common:teamBrief.summary')}</p>
              <p className="mt-2 text-[13px] leading-6 text-[#4b5563]">{teamBrief.summaryText}</p>
              <p className="mt-3 rounded-xl bg-white px-3 py-2 text-[12px] text-[#334155]">{teamBrief.dashboard.primaryNextAction}</p>
            </div>
            <div className="grid gap-3">
              <div className="rounded-2xl border border-black/[0.06] bg-[#f8fafc] p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748b]">{t('common:teamBrief.activeWork')}</p>
                <div className="mt-2 space-y-2">
                  {teamBrief.dashboard.activeWorkItems.length > 0 ? teamBrief.dashboard.activeWorkItems.slice(0, 3).map((item) => (
                    <p key={`${item.memberId}-${item.title}`} className="rounded-xl bg-white px-3 py-2 text-[12px] text-[#111827]">
                      {item.memberName}: {item.title}
                    </p>
                  )) : (
                    <p className="rounded-xl bg-white px-3 py-2 text-[12px] text-[#64748b]">{t('common:teamBrief.noActiveWork')}</p>
                  )}
                </div>
              </div>
              <div className="rounded-2xl border border-black/[0.06] bg-[#f8fafc] p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748b]">{t('common:teamBrief.blockers')}</p>
                <div className="mt-2 space-y-2">
                  {teamBrief.blockedItems.length > 0 ? teamBrief.blockedItems.map((item) => (
                    <p key={item} className="rounded-xl bg-white px-3 py-2 text-[12px] text-[#111827]">{item}</p>
                  )) : (
                    <p className="rounded-xl bg-white px-3 py-2 text-[12px] text-[#64748b]">{t('common:teamBrief.noBlockers')}</p>
                  )}
                </div>
              </div>
              <div className="rounded-2xl border border-black/[0.06] bg-[#f8fafc] p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748b]">{t('common:teamBrief.nextSteps')}</p>
                <div className="mt-2 space-y-2">
                  {teamBrief.nextSteps.length > 0 ? teamBrief.nextSteps.slice(0, 3).map((item) => (
                    <p key={item} className="rounded-xl bg-white px-3 py-2 text-[12px] text-[#111827]">{item}</p>
                  )) : (
                    <p className="rounded-xl bg-white px-3 py-2 text-[12px] text-[#64748b]">{t('common:teamBrief.noNextSteps')}</p>
                  )}
                </div>
              </div>
            </div>
            {teamBrief.members.map((member) => (
              <div key={member.id} className="rounded-xl border border-black/[0.06] bg-[#fafafc] p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[13px] font-medium text-[#111827]">{member.name}</p>
                  <span className="text-[11px] text-[#8e8e93]">{t(`common:teamMap.status.${member.statusKey}`)}</span>
                </div>
                <p className="mt-2 text-[11px] text-[#8e8e93]">{member.etaText}</p>
                {member.currentWorkTitles.map((title) => (
                  <p key={title} className="mt-2 text-[12px] text-[#374151]">{title}</p>
                ))}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => navigate(`/agents/${encodeURIComponent(member.id)}`)}
                    className="rounded-lg border border-black/10 bg-white px-2.5 py-1 text-[11px] text-[#374151]"
                  >
                    {t('common:teamBrief.openMember')}
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate('/kanban')}
                    className="rounded-lg border border-black/10 bg-white px-2.5 py-1 text-[11px] text-[#374151]"
                  >
                    {t('common:teamBrief.openKanban')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}

export default Chat;
