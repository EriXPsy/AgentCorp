import type { AgentLifecycleStatus, AgentSummary } from '@/types/agent';
import type { TeamSummary } from '@/types/team';
import { resolveDesignerTeamIdForAgent } from '@/services/designer/designer-scope';

export type TeamOverviewAssetType = 'team' | 'employee';

export interface TeamOverviewAsset {
  id: string;
  type: TeamOverviewAssetType;
  name: string;
  avatar?: string;
  initials: string;
  lifecycleStatus: AgentLifecycleStatus;
  healthScore: number;
  taskCount: number;
  source: 'marketplace' | 'local' | 'custom';
  team?: TeamSummary;
  memberCount?: number;
  leaderName?: string;
  agent?: AgentSummary;
}

export interface TeamOverviewKpis {
  active: number;
  totalTasks: number;
  avgHealth: number;
}

const TEAM_OVERVIEW_STATUS_ORDER: Record<AgentLifecycleStatus, number> = {
  active: 0,
  training: 1,
  onboarding: 2,
  maintenance: 3,
  retired: 4,
};

export function computeTeamOverviewHealthScore(
  lifecycle: AgentLifecycleStatus,
  sessionCount: number,
): number {
  if (sessionCount > 0) {
    const busyness = Math.min(sessionCount / 20, 1);
    return Math.round(70 + busyness * 25);
  }
  switch (lifecycle) {
    case 'active':
      return 85;
    case 'training':
      return 60;
    case 'maintenance':
      return 40;
    case 'onboarding':
      return 50;
    case 'retired':
      return 10;
    default:
      return 30;
  }
}

export function buildTeamOverviewInitials(name: string): string {
  const parts = name
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return name.slice(0, 2).toUpperCase();
  return parts
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function buildTeamOverviewAssets(input: {
  teams: TeamSummary[];
  agents: AgentSummary[];
  agentLifecycleStatuses: Record<string, AgentLifecycleStatus>;
  agentSessionCounts: Record<string, number>;
}): TeamOverviewAsset[] {
  const { teams, agents, agentLifecycleStatuses, agentSessionCounts } = input;
  const teamAgentIds = new Set<string>();
  for (const team of teams) {
    teamAgentIds.add(team.leaderId);
    for (const memberId of team.memberIds) teamAgentIds.add(memberId);
  }

  const rows: TeamOverviewAsset[] = [];

  for (const team of teams) {
    const leaderAgent = agents.find((agent) => agent.id === team.leaderId);
    const lifecycle = agentLifecycleStatuses[team.leaderId] ?? 'onboarding';
    const sessionCount = agentSessionCounts[team.leaderId] ?? 0;
    rows.push({
      id: team.id,
      type: 'team',
      name: team.name,
      lifecycleStatus: lifecycle,
      healthScore: computeTeamOverviewHealthScore(lifecycle, sessionCount),
      taskCount: team.activeTaskCount,
      source: leaderAgent?.source ?? 'local',
      team,
      memberCount: team.memberCount,
      leaderName: team.leaderName,
      initials: team.name.slice(0, 2).toUpperCase(),
      avatar: team.memberAvatars?.[0]?.avatar ?? undefined,
    });
  }

  for (const agent of agents) {
    if (teamAgentIds.has(agent.id)) continue;
    const lifecycle = agentLifecycleStatuses[agent.id] ?? 'onboarding';
    const sessionCount = agentSessionCounts[agent.id] ?? 0;
    rows.push({
      id: agent.id,
      type: 'employee',
      name: agent.name,
      avatar: agent.avatar ?? undefined,
      lifecycleStatus: lifecycle,
      healthScore: computeTeamOverviewHealthScore(lifecycle, sessionCount),
      taskCount: sessionCount,
      source: agent.source ?? 'custom',
      agent,
      initials: buildTeamOverviewInitials(agent.name),
    });
  }

  return rows.sort((left, right) => {
    const lifecycleDelta =
      TEAM_OVERVIEW_STATUS_ORDER[left.lifecycleStatus] -
      TEAM_OVERVIEW_STATUS_ORDER[right.lifecycleStatus];
    if (lifecycleDelta !== 0) return lifecycleDelta;
    const leftTime = left.team?.lastActiveTime ?? 0;
    const rightTime = right.team?.lastActiveTime ?? 0;
    return rightTime - leftTime;
  });
}

export function buildTeamOverviewKpis(assets: TeamOverviewAsset[]): TeamOverviewKpis {
  const active = assets.filter((asset) => asset.lifecycleStatus === 'active').length;
  const totalTasks = assets.reduce((sum, asset) => sum + asset.taskCount, 0);
  const avgHealth =
    assets.length > 0
      ? Math.round(assets.reduce((sum, asset) => sum + asset.healthScore, 0) / assets.length)
      : 0;
  return { active, totalTasks, avgHealth };
}

export function resolveTeamOverviewMemoryRoute(
  asset: TeamOverviewAsset,
  teams: TeamSummary[],
): string {
  if (asset.type === 'team' && asset.team) {
    return `/team-space/${asset.team.id}`;
  }
  const agentId = asset.agent?.id ?? asset.id;
  const ownerTeamId = resolveDesignerTeamIdForAgent(agentId, teams);
  return ownerTeamId === agentId
    ? `/evaluation?agentId=${encodeURIComponent(agentId)}&panel=challenge`
    : `/team-space/${encodeURIComponent(ownerTeamId)}`;
}
