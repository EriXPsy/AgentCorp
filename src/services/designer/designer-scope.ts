import type { TeamSummary } from '@/types/team';

/**
 * Designer 的 StyleMemory / challenge / reflection 以 team 为学习单元。
 * 当页面从单个 agent 入口进入时，优先回溯其所属团队；找不到时退回 agentId，
 * 兼容历史上按 agent 独立累计记忆的路径。
 */
export function resolveDesignerTeamIdForAgent(
  agentId: string,
  teams: TeamSummary[],
): string {
  const ownerTeam = teams.find(
    (team) => team.leaderId === agentId || team.memberIds.includes(agentId),
  );
  return ownerTeam?.id ?? agentId;
}
