import type { AgentSummary } from '@/types/agent';
import type { TeamMemberWorkVisibility } from '@/lib/team-work-visibility';

const RECENT_MS = 5 * 60 * 1000;

export function isRecentlyActiveTeamMember(ts: number | undefined): boolean {
  return !!ts && Date.now() - ts < RECENT_MS;
}

export function deriveTeamMemberNextStep(
  statusKey: TeamMemberWorkVisibility['statusKey'],
  agentName: string,
): string {
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

export function getTeamMemberOwnedEntryPoints(
  agent: AgentSummary,
  channelOwners: Record<string, string>,
  configuredChannelTypes: string[],
): string[] {
  return configuredChannelTypes.filter((channelType) => channelOwners[channelType] === agent.id);
}

export function getChildTeamAgents(
  agent: AgentSummary,
  agents: AgentSummary[],
  rootId: string,
): AgentSummary[] {
  return agents.filter((candidate) => {
    if (candidate.id === agent.id) return false;
    if (candidate.reportsTo === agent.id) return true;
    return agent.id === rootId && !candidate.reportsTo;
  });
}

export function fallbackTeamMemberVisibility(
  agent: AgentSummary,
  sessionLastActivity: Record<string, number>,
): TeamMemberWorkVisibility {
  return {
    statusKey: isRecentlyActiveTeamMember(sessionLastActivity[agent.mainSessionKey]) ? 'active' : 'idle',
    activeTaskCount: 0,
    currentWorkTitles: [],
  };
}

export function buildTeamMapHoverAnchor(input: {
  containerRect: DOMRect | undefined;
  targetRect: DOMRect;
}): { top: number; left: number } | null {
  if (!input.containerRect) return null;
  return {
    top: input.targetRect.top - input.containerRect.top + input.targetRect.height / 2 - 40,
    left: input.targetRect.left - input.containerRect.left + input.targetRect.width + 20,
  };
}
