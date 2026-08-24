import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Bot, CalendarClock, Code, Cpu, Database, Network, UserCog, Users, Zap } from 'lucide-react';
import { useAgentsStore } from '@/stores/agents';
import { useDesignerStore } from '@/stores/designerStore';
import { useTeamsStore } from '@/stores/teams';
import { useChatStore } from '@/stores/chat';
import { useApprovalsStore } from '@/stores/approvals';
import type { AgentSummary } from '@/types/agent';
import { deriveTeamWorkVisibility, type TeamMemberWorkVisibility } from '@/lib/team-work-visibility';
import { useTeamRuntime } from '@/hooks/use-team-runtime';
import { cn } from '@/lib/utils';
import { TeamMapHeader } from '@/components/team-map/TeamMapHeader';
import { TeamRadar } from '@/components/team/TeamRadar';
import { getTeamMapState } from '@/components/team-map/team-map-selectors';
import { AddMemberSheet } from '@/components/team-map/AddMemberSheet';
import { MemberDetailSheet } from '@/components/team-map/MemberDetailSheet';
import { TeamMapHoverCard } from '@/components/team-map/team-map-hover-card';
import { TeamScheduleSheet } from '@/components/team-map/TeamScheduleSheet';

const AVATAR_COLORS = [
  'bg-blue-100 text-blue-600 ring-1 ring-blue-500/20',
  'bg-amber-100 text-amber-600 ring-1 ring-amber-500/20',
  'bg-emerald-100 text-emerald-600 ring-1 ring-emerald-500/20',
  'bg-violet-100 text-violet-600 ring-1 ring-violet-500/20',
  'bg-pink-100 text-pink-600 ring-1 ring-pink-500/20',
  'bg-cyan-100 text-cyan-600 ring-1 ring-cyan-500/20',
];

const AVATAR_ICONS = [Bot, UserCog, Code, Database, Zap, Cpu];
const RECENT_MS = 5 * 60 * 1000;

function agentColor(idx: number) {
  return AVATAR_COLORS[idx % AVATAR_COLORS.length];
}

function AgentIcon({ idx, className }: { idx: number; className?: string }) {
  const Icon = AVATAR_ICONS[idx % AVATAR_ICONS.length];
  return <Icon className={className} />;
}

function isRecentlyActive(ts: number | undefined): boolean {
  return !!ts && Date.now() - ts < RECENT_MS;
}

function getTeamRole(agent: AgentSummary): 'leader' | 'worker' {
  return agent.teamRole ?? (agent.isDefault ? 'leader' : 'worker');
}

function getChatAccess(agent: AgentSummary): 'direct' | 'leader_only' {
  return agent.chatAccess ?? 'direct';
}

function deriveNextStep(statusKey: TeamMemberWorkVisibility['statusKey'], agentName: string): string {
  switch (statusKey) {
    case 'blocked':
      return `Unblock ${agentName}`;
    case 'waiting_approval':
      return `Review approval for ${agentName}`;
    case 'working':
      return `Track ${agentName}'s execution`;
    case 'active':
      return `Check the latest update from ${agentName}`;
    default:
      return `Queue the next work item for ${agentName}`;
  }
}

function getOwnedEntryPoints(
  agent: AgentSummary,
  channelOwners: Record<string, string>,
  configuredChannelTypes: string[],
): string[] {
  return configuredChannelTypes.filter((channelType) => channelOwners[channelType] === agent.id);
}

function TeamNotFoundState() {
  const { t } = useTranslation('common');

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <div className="mx-auto flex h-full w-full max-w-5xl items-center justify-center px-6 py-10">
        <div className="rounded-[32px] border border-slate-200/80 bg-white px-8 py-10 text-center shadow-sm">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
            <Network className="h-8 w-8" />
          </div>
          <h1 className="mt-6 text-2xl font-semibold text-slate-900">
            {t('teamMap.notFound.title', { defaultValue: 'Team not found' })}
          </h1>
          <p className="mt-3 max-w-md text-sm text-slate-500">
            {t('teamMap.notFound.description', {
              defaultValue: 'Return to Team Overview and choose a valid team.',
            })}
          </p>
          <Link
            to="/team-overview"
            className="mt-6 inline-flex rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-800"
          >
            {t('teamMap.notFound.back', { defaultValue: 'Back to Team Overview' })}
          </Link>
        </div>
      </div>
    </div>
  );
}

function EmptyTeamState() {
  const { t } = useTranslation('common');

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-12">
      <div className="rounded-[28px] border border-dashed border-slate-300 bg-white/80 px-8 py-10 text-center shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
          <Users className="h-6 w-6" />
        </div>
        <h2 className="mt-5 text-xl font-semibold text-slate-900">
          {t('teamMap.emptyTeam.title', { defaultValue: 'No members in this team yet' })}
        </h2>
        <p className="mt-3 max-w-md text-sm text-slate-500">
          {t('teamMap.emptyTeam.description', {
            defaultValue:
              'Add agents from the member panel to build this team map. The leader stays pinned as the root node.',
          })}
        </p>
      </div>
    </div>
  );
}

function TeamMapLoadingState() {
  const { t } = useTranslation('common');

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <TeamMapHeader
        teamName={t('teamMap.loading.title', { defaultValue: 'Loading team map...' })}
        memberCount={0}
        addDisabled
      />
      <div className="flex-1 overflow-hidden p-4 md:p-6 xl:p-8">
        <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[32px] border border-slate-200/60 bg-slate-50 shadow-sm">
          <div className="absolute right-6 top-6 z-10 flex items-center gap-5 text-xs text-slate-400">
            <span className="font-medium">{t('status.loading')}</span>
          </div>
          <div className="flex flex-1 items-center justify-center px-6 py-12">
            <div className="w-full max-w-3xl space-y-6">
              <div className="mx-auto h-32 w-64 animate-pulse rounded-[28px] border border-slate-200 bg-white/80" />
              <div className="grid gap-4 md:grid-cols-2">
                <div className="h-28 animate-pulse rounded-[24px] border border-slate-200 bg-white/70" />
                <div className="h-28 animate-pulse rounded-[24px] border border-slate-200 bg-white/70" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentNode({
  agent,
  idx,
  isRoot,
  selected,
  workVisibility,
  onClick,
  onHoverStart,
  onHoverEnd,
  nodeRef,
}: {
  agent: AgentSummary;
  idx: number;
  isRoot: boolean;
  selected: boolean;
  workVisibility?: TeamMemberWorkVisibility;
  onClick?: () => void;
  onHoverStart?: (target: HTMLDivElement) => void;
  onHoverEnd?: () => void;
  nodeRef?: (node: HTMLDivElement | null) => void;
}) {
  const { t } = useTranslation('common');
  const statusKey = workVisibility?.statusKey ?? 'idle';
  const currentWorkTitles = workVisibility?.currentWorkTitles ?? [];
  const role = getTeamRole(agent);
  const access = getChatAccess(agent);
  const isWorking = statusKey === 'working' || statusKey === 'active';

  return (
    <motion.div
      ref={nodeRef}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onMouseEnter={(event) => onHoverStart?.(event.currentTarget)}
      onMouseLeave={() => onHoverEnd?.()}
      onFocus={(event) => onHoverStart?.(event.currentTarget)}
      onBlur={() => onHoverEnd?.()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick?.();
        }
      }}
      whileHover={{ y: -4, boxShadow: '0 12px 40px rgba(0,0,0,0.08)' }}
      className={cn(
        'relative cursor-pointer rounded-[26px] bg-white p-5 text-left shadow-sm transition-all',
        isRoot ? 'w-64 border-2 border-slate-900 bg-slate-50/80' : 'w-56 border border-slate-200',
        selected && 'ring-2 ring-[rgb(var(--ac-rgb,0_122_255))] ring-offset-4 ring-offset-slate-50',
      )}
    >
      <div className="flex items-start gap-4">
        <div
          className={cn(
            'relative flex shrink-0 items-center justify-center rounded-2xl',
            isRoot
              ? 'h-14 w-14 bg-slate-900 text-white shadow-md'
              : `h-12 w-12 ${agentColor(idx)}`,
          )}
        >
          {isRoot ? <Network className="h-7 w-7" /> : <AgentIcon idx={idx} className="h-6 w-6" />}
          {isWorking ? (
            <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-3.5 w-3.5 rounded-full border-2 border-white bg-blue-500" />
            </span>
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          {isRoot ? (
            <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.2em] text-blue-600">
              {t('teamMap.header.leaderLabel', { defaultValue: 'Team Leader' })}
            </p>
          ) : null}
          <p className={cn('truncate font-semibold text-slate-900', isRoot ? 'text-base' : 'text-sm')}>
            {agent.name}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">{t(`teamMap.role.${role}`)}</p>
          {access === 'leader_only' ? (
            <p className="mt-1 text-[10px] font-medium text-blue-600">
              {t('teamMap.access.leader_only')}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-slate-50 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            {t('teamMap.node.currentTask')}
          </span>
          <span
            className={cn(
              'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold',
              statusKey === 'blocked'
                ? 'bg-amber-100 text-amber-800'
                : statusKey === 'waiting_approval'
                  ? 'bg-violet-100 text-violet-800'
                  : isWorking
                    ? 'bg-blue-100 text-blue-800'
                    : 'bg-slate-100 text-slate-500',
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                statusKey === 'blocked'
                  ? 'bg-amber-500'
                  : statusKey === 'waiting_approval'
                    ? 'bg-violet-500'
                    : isWorking
                      ? 'bg-blue-500'
                      : 'bg-slate-400',
              )}
            />
            {t(`teamMap.status.${statusKey}`)}
          </span>
        </div>
        <p className="mt-2 line-clamp-2 min-h-[36px] text-xs leading-5 text-slate-700">
          {currentWorkTitles[0] ?? t('teamMap.node.noCurrentWork')}
        </p>
      </div>
    </motion.div>
  );
}

function ConnectorLines({ childCount }: { childCount: number }) {
  if (childCount === 0) return null;

  const nodeWidth = 208;
  const gap = 24;
  const totalWidth = childCount * nodeWidth + (childCount - 1) * gap;
  const svgWidth = Math.max(totalWidth, 240);
  const centerX = svgWidth / 2;
  const midY = 28;

  const childCenters = Array.from({ length: childCount }, (_, index) => {
    const startX = (svgWidth - totalWidth) / 2;
    return startX + index * (nodeWidth + gap) + nodeWidth / 2;
  });

  return (
    <svg width={svgWidth} height={56} className="-my-px overflow-visible" style={{ display: 'block' }}>
      <path d={`M ${centerX} 0 L ${centerX} ${midY}`} stroke="#e2e8f0" strokeWidth="2" fill="none" />
      {childCount > 1 ? (
        <path
          d={`M ${childCenters[0]} ${midY} L ${childCenters[childCenters.length - 1]} ${midY}`}
          stroke="#e2e8f0"
          strokeWidth="2"
          fill="none"
        />
      ) : null}
      {childCenters.map((x) => (
        <path key={x} d={`M ${x} ${midY} L ${x} 56`} stroke="#e2e8f0" strokeWidth="2" fill="none" />
      ))}
    </svg>
  );
}

function getChildAgents(agent: AgentSummary, agents: AgentSummary[], rootId: string) {
  return agents.filter((candidate) => {
    if (candidate.id === agent.id) return false;
    if (candidate.reportsTo === agent.id) return true;
    return agent.id === rootId && !candidate.reportsTo;
  });
}

function RecursiveNode({
  agent,
  allAgents,
  rootId,
  index,
  selectedAgentId,
  workVisibility,
  sessionLastActivity,
  onSelectAgent,
  onHoverAgent,
  onLeaveAgent,
  registerNode,
}: {
  agent: AgentSummary;
  allAgents: AgentSummary[];
  rootId: string;
  index: number;
  selectedAgentId: string | null;
  workVisibility: Record<string, TeamMemberWorkVisibility>;
  sessionLastActivity: Record<string, number>;
  onSelectAgent: (agent: AgentSummary) => void;
  onHoverAgent: (agent: AgentSummary, target: HTMLDivElement) => void;
  onLeaveAgent: () => void;
  registerNode: (agentId: string, node: HTMLDivElement | null) => void;
}) {
  const childAgents = getChildAgents(agent, allAgents, rootId);

  return (
    <div className="flex flex-col items-center">
      <AgentNode
        agent={agent}
        idx={index}
        isRoot={agent.id === rootId}
        selected={selectedAgentId === agent.id}
        workVisibility={
          workVisibility[agent.id] ?? {
            statusKey: isRecentlyActive(sessionLastActivity[agent.mainSessionKey]) ? 'active' : 'idle',
            activeTaskCount: 0,
            currentWorkTitles: [],
          }
        }
        onClick={() => onSelectAgent(agent)}
        onHoverStart={(target) => onHoverAgent(agent, target)}
        onHoverEnd={onLeaveAgent}
        nodeRef={(node) => registerNode(agent.id, node)}
      />

      {childAgents.length > 0 ? <ConnectorLines childCount={childAgents.length} /> : null}

      {childAgents.length > 0 ? (
        <div className="flex items-start justify-center gap-8">
          {childAgents.map((child, childIndex) => (
            <RecursiveNode
              key={child.id}
              agent={child}
              allAgents={allAgents}
              rootId={rootId}
              index={childIndex + 1}
              selectedAgentId={selectedAgentId}
              workVisibility={workVisibility}
              sessionLastActivity={sessionLastActivity}
              onSelectAgent={onSelectAgent}
              onHoverAgent={onHoverAgent}
              onLeaveAgent={onLeaveAgent}
              registerNode={registerNode}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TeamMap() {
  const navigate = useNavigate();
  const { teamId } = useParams<{ teamId: string }>();
  const { t } = useTranslation('common');
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [scale, setScale] = useState(1);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [radarOpen, setRadarOpen] = useState(false);
  const [lastFocusedNodeId, setLastFocusedNodeId] = useState<string | null>(null);
  const [hoveredAgentId, setHoveredAgentId] = useState<string | null>(null);
  const [hoverCardAnchor, setHoverCardAnchor] = useState<{ top: number; left: number } | null>(null);

  const {
    agents,
    loading: agentsLoading,
    fetchAgents,
    configuredChannelTypes,
    channelOwners,
  } = useAgentsStore();
  const { teams, loading: teamsLoading, fetchTeams, removeMember } = useTeamsStore();
  const tasks = useApprovalsStore((state) => state.tasks ?? []);
  const fetchTasks = useApprovalsStore((state) => state.fetchTasks ?? (async () => undefined));
  const sessionLastActivity = useChatStore((state) => state.sessionLastActivity);
  const openDirectAgentSession = useChatStore((state) => state.openDirectAgentSession);
  const { byAgent: runtimeByAgent } = useTeamRuntime();

  useEffect(() => {
    void Promise.all([fetchAgents(), fetchTeams(), fetchTasks()]);
  }, [fetchAgents, fetchTeams, fetchTasks]);

  // 加载团队雷达数据
  const teamRadars = useDesignerStore((s) => s.teamRadars);
  const fetchTeamRadar = useDesignerStore((s) => s.fetchTeamRadar);
  const currentRadar = teamId ? teamRadars[teamId] : null;

  useEffect(() => {
    if (teamId && radarOpen) {
      void fetchTeamRadar(teamId);
    }
  }, [teamId, radarOpen, fetchTeamRadar]);

  const loading = agentsLoading || teamsLoading;
  const currentTeam = teams.find((team) => team.id === teamId) ?? null;

  const { leader, members, scopedAgents } = useMemo(() => {
    if (!currentTeam) {
      return {
        leader: null,
        members: [] as AgentSummary[],
        scopedAgents: [] as AgentSummary[],
      };
    }

    return getTeamMapState(agents, currentTeam);
  }, [agents, currentTeam]);

  const workVisibility = useMemo(
    () => deriveTeamWorkVisibility(scopedAgents, sessionLastActivity, runtimeByAgent, tasks),
    [runtimeByAgent, scopedAgents, sessionLastActivity, tasks],
  );

  useEffect(() => {
    if (leader && !selectedAgentId) {
      setSelectedAgentId(leader.id);
    }
  }, [leader, selectedAgentId]);

  const selectedAgent = scopedAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  const hoveredAgent = scopedAgents.find((agent) => agent.id === hoveredAgentId) ?? null;
  const selectedAgentOwnedEntryPoints = selectedAgent
    ? getOwnedEntryPoints(selectedAgent, channelOwners, configuredChannelTypes)
    : [];
  const selectedWorkVisibility = selectedAgent
    ? workVisibility[selectedAgent.id] ?? {
        statusKey: isRecentlyActive(sessionLastActivity[selectedAgent.mainSessionKey]) ? 'active' : 'idle',
        activeTaskCount: 0,
        currentWorkTitles: [],
      }
    : undefined;
  const hoveredAgentWorkVisibility = hoveredAgent
    ? workVisibility[hoveredAgent.id] ?? {
        statusKey: isRecentlyActive(sessionLastActivity[hoveredAgent.mainSessionKey]) ? 'active' : 'idle',
        activeTaskCount: 0,
        currentWorkTitles: [],
      }
    : undefined;

  const zoomIn = () => setScale((value) => Math.min(2, +(value + 0.2).toFixed(1)));
  const zoomOut = () => setScale((value) => Math.max(0.4, +(value - 0.2).toFixed(1)));
  const zoomFit = () => setScale(1);

  useEffect(() => {
    if (detailOpen || !lastFocusedNodeId) {
      return;
    }

    nodeRefs.current[lastFocusedNodeId]?.focus();
  }, [detailOpen, lastFocusedNodeId]);

  if (loading) {
    return <TeamMapLoadingState />;
  }

  const registerNode = (agentId: string, node: HTMLDivElement | null) => {
    nodeRefs.current[agentId] = node;
  };

  const handleHoverAgent = (agent: AgentSummary, target: HTMLDivElement) => {
    const containerRect = containerRef.current?.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    setHoveredAgentId(agent.id);
    setHoverCardAnchor(
      containerRect
        ? {
            top: targetRect.top - containerRect.top + targetRect.height / 2 - 40,
            left: targetRect.left - containerRect.left + targetRect.width + 20,
          }
        : null,
    );
  };

  const clearHoverAgent = () => {
    setHoveredAgentId(null);
    setHoverCardAnchor(null);
  };

  if (!loading && (!teamId || !currentTeam)) {
    return <TeamNotFoundState />;
  }

  return (
    <div className="flex h-full flex-col bg-slate-50">
      {currentTeam ? (
        <TeamMapHeader
          teamName={currentTeam.name}
          memberCount={currentTeam.memberCount}
          onAddMember={() => setAddMemberOpen(true)}
        />
      ) : null}

      <div className="flex-1 overflow-hidden p-4 md:p-6 xl:p-8">
        <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-[32px] border border-slate-200/60 bg-slate-50 shadow-sm">
          {currentTeam ? (
            <div className="absolute left-6 top-6 z-10">
              <button
                type="button"
                onClick={() => setScheduleOpen(true)}
                className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-900"
              >
                <CalendarClock className="h-4 w-4" />
                {t('teamMap.schedules.open', { defaultValue: '定时任务' })}
              </button>
            </div>
          ) : null}
          <div className="absolute right-6 top-6 z-10 flex items-center gap-5 text-xs text-slate-500">
            <span className="flex items-center gap-2 font-medium">
              <span className="h-2 w-2 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.6)]" />
              {t('teamMap.status.active')}
            </span>
            <span className="flex items-center gap-2 font-medium">
              <span className="h-2 w-2 rounded-full bg-slate-400" />
              {t('teamMap.status.idle')}
            </span>
            {scale !== 1 ? <span className="font-medium text-slate-400">{Math.round(scale * 100)}%</span> : null}
            {loading ? <span className="text-slate-400">{t('status.loading')}</span> : null}
          </div>

          {leader ? (
            <div
              ref={containerRef}
              className="flex flex-1 items-center justify-center overflow-auto pb-16 pt-12"
              style={{
                backgroundImage: 'radial-gradient(#e2e8f0 1px, transparent 1px)',
                backgroundSize: '24px 24px',
              }}
            >
              <div
                className="flex flex-col items-center transition-transform duration-200"
                style={{ transform: `scale(${scale})`, transformOrigin: 'center top' }}
              >
                <RecursiveNode
                  agent={leader}
                  allAgents={scopedAgents}
                  rootId={leader.id}
                  index={0}
                  selectedAgentId={selectedAgentId}
                  workVisibility={workVisibility}
                  sessionLastActivity={sessionLastActivity}
                  onSelectAgent={(agent) => {
                    setSelectedAgentId(agent.id);
                    setLastFocusedNodeId(agent.id);
                    setDetailOpen(true);
                  }}
                  onHoverAgent={handleHoverAgent}
                  onLeaveAgent={clearHoverAgent}
                  registerNode={registerNode}
                />
              </div>

              {hoveredAgent && hoveredAgentWorkVisibility && hoverCardAnchor ? (
                <TeamMapHoverCard
                  open={Boolean(hoveredAgentId)}
                  anchor={hoverCardAnchor}
                  statusKey={hoveredAgentWorkVisibility.statusKey}
                  statusLabel={t(`teamMap.status.${hoveredAgentWorkVisibility.statusKey}`)}
                  currentTask={hoveredAgentWorkVisibility.currentWorkTitles[0] ?? null}
                  blockingReason={
                    hoveredAgentWorkVisibility.statusKey === 'blocked'
                      ? hoveredAgentWorkVisibility.currentWorkTitles[0] ?? null
                      : null
                  }
                  nextStep={deriveNextStep(hoveredAgentWorkVisibility.statusKey, hoveredAgent.name)}
                />
              ) : null}
            </div>
          ) : (
            <EmptyTeamState />
          )}

          <div className="absolute bottom-6 left-6 z-10 flex flex-col gap-1.5">
            {([
              { icon: '+', action: zoomIn, title: t('teamMap.zoom.in') },
              { icon: '-', action: zoomOut, title: t('teamMap.zoom.out') },
              { icon: 'Fit', action: zoomFit, title: t('teamMap.zoom.reset') },
            ] as const).map(({ icon, action, title }) => (
              <button
                key={icon}
                type="button"
                title={title}
                onClick={action}
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-900"
              >
                {icon}
              </button>
            ))}
          </div>

          {currentTeam && members.length === 0 && leader ? (
            <div className="absolute bottom-6 right-6 z-10 max-w-sm">
              <div className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-sm text-slate-600 shadow-sm backdrop-blur">
                {t('teamMap.emptyTeam.title', { defaultValue: 'No members in this team yet' })}
              </div>
            </div>
          ) : null}

          {/* 团队能力雷达 */}
          {currentTeam ? (
            <>
              {!radarOpen && (
                <button
                  type="button"
                  onClick={() => setRadarOpen(true)}
                  className="absolute bottom-6 right-6 z-10 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-900"
                >
                  <Network className="h-4 w-4" />
                  {t('teamMap.radar.toggle', { defaultValue: '能力雷达' })}
                </button>
              )}
              {radarOpen && (
                <div className="absolute bottom-6 right-6 z-10 w-[340px] rounded-2xl border border-slate-200 bg-white/95 shadow-lg backdrop-blur">
                  <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                    <span className="text-xs font-bold text-slate-700">
                      {t('teamMap.radar.title', { defaultValue: '团队能力雷达' })}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRadarOpen(false)}
                      className="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="p-4">
                    {currentRadar ? (
                      <TeamRadar data={currentRadar} />
                    ) : (
                      <div className="flex flex-col items-center gap-2 py-6">
                        <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-transparent" />
                        <span className="text-[10px] text-slate-400">加载雷达数据...</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>

      {currentTeam && leader ? (
        <AddMemberSheet
          open={addMemberOpen}
          onOpenChange={setAddMemberOpen}
          teamId={currentTeam.id}
          leaderId={currentTeam.leaderId}
          memberIds={currentTeam.memberIds}
          onAdded={async () => {
            await fetchTeams();
          }}
        />
      ) : null}

      {currentTeam ? (
        <TeamScheduleSheet
          open={scheduleOpen}
          onOpenChange={setScheduleOpen}
          teamId={currentTeam.id}
          teamName={currentTeam.name}
        />
      ) : null}

      {currentTeam && selectedAgent ? (
        <MemberDetailSheet
          open={detailOpen}
          onOpenChange={(open) => {
            setDetailOpen(open);
            if (!open) {
              clearHoverAgent();
            }
          }}
          agent={selectedAgent}
          teamId={currentTeam.id}
          isLeader={selectedAgent.id === currentTeam.leaderId}
          ownedEntryPoints={selectedAgentOwnedEntryPoints}
          activity={
            selectedAgent && selectedWorkVisibility
              ? {
                  statusLabel: t(`teamMap.status.${selectedWorkVisibility.statusKey}`),
                  currentWorkTitles: selectedWorkVisibility.currentWorkTitles,
                  blockingReason:
                    selectedWorkVisibility.statusKey === 'blocked'
                      ? selectedWorkVisibility.currentWorkTitles[0] ?? null
                      : null,
                  nextStep: deriveNextStep(selectedWorkVisibility.statusKey, selectedAgent.name),
                }
              : undefined
          }
          onRemoveMember={async (agentId) => {
            await removeMember(currentTeam.id, agentId);
            await fetchTeams();
            setDetailOpen(false);
          }}
          onOpenChat={(agent) => {
            openDirectAgentSession(agent.id, {
              teamId: currentTeam.id,
              teamName: currentTeam.name,
              isLeaderChat: agent.id === currentTeam.leaderId,
            });
            navigate('/');
          }}
        />
      ) : null}
    </div>
  );
}

export default TeamMap;
