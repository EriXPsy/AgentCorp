import type { AgentSummary } from '@/types/agent';
import type { StyleMemory, TeamRadarResponse } from '@/types/designer';
import type { TeamSummary } from '@/types/team';

export const TEAM_DESIGNER_DIM_LABELS: Record<string, string> = {
  task_completion: '完成度',
  code_quality: '代码质量',
  communication: '沟通',
  creativity: '创造力',
  reliability: '可靠性',
  cost_efficiency: '成本效率',
  code_runnability: '可运行',
  code_efficiency: '效率',
  code_maintainability: '可维护',
  code_security: '安全',
};

export interface TeamSpaceSummaryStats {
  memberCount: number;
  activeTaskCount: number;
  submissionCount: number;
  reflectionCount: number;
}

export function buildTeamSpaceMembers(
  team: TeamSummary | null | undefined,
  agents: AgentSummary[],
): AgentSummary[] {
  if (!team) return [];
  const memberIds = new Set([team.leaderId, ...team.memberIds]);
  return agents.filter((agent) => memberIds.has(agent.id));
}

export function buildTeamSpaceSummaryStats(
  team: TeamSummary,
  radar: TeamRadarResponse | null,
  memory: StyleMemory | null,
): TeamSpaceSummaryStats {
  return {
    memberCount: team.memberCount,
    activeTaskCount: team.activeTaskCount,
    submissionCount: radar?.last_updated_submission ?? 0,
    reflectionCount: memory?.reflection_count ?? 0,
  };
}

export function rankTeamMemberStrengths(radar: Record<string, number> | undefined): Array<[string, number]> {
  return Object.entries(radar ?? {})
    .sort(([, left], [, right]) => right - left)
    .slice(0, 3);
}

export function labelTeamDesignerDimension(dim: string): string {
  return TEAM_DESIGNER_DIM_LABELS[dim] ?? dim;
}
