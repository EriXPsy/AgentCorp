import type {
  AgentMemory,
  ChallengeResponse,
  ReflectResponse,
  StyleMemory,
} from '@/types/designer';

export interface DesignerTeamWorkspace {
  memory: StyleMemory | null;
  currentChallenge: ChallengeResponse | null;
  lastReflection: ReflectResponse | null;
  loading: boolean;
  error: string | null;
}

export const EMPTY_DESIGNER_TEAM_WORKSPACE: DesignerTeamWorkspace = {
  memory: null,
  currentChallenge: null,
  lastReflection: null,
  loading: false,
  error: null,
};

export function getDesignerTeamWorkspace(
  teamStates: Record<string, DesignerTeamWorkspace>,
  teamId: string | null | undefined,
): DesignerTeamWorkspace {
  if (!teamId) return EMPTY_DESIGNER_TEAM_WORKSPACE;
  return teamStates[teamId] ?? EMPTY_DESIGNER_TEAM_WORKSPACE;
}

export function mergeDesignerTeamWorkspace(
  teamStates: Record<string, DesignerTeamWorkspace>,
  teamId: string,
  patch: Partial<DesignerTeamWorkspace>,
): Record<string, DesignerTeamWorkspace> {
  return {
    ...teamStates,
    [teamId]: {
      ...getDesignerTeamWorkspace(teamStates, teamId),
      ...patch,
    },
  };
}

export function buildActiveDesignerSelection(
  teamId: string | null,
  teamStates: Record<string, DesignerTeamWorkspace>,
) {
  const workspace = getDesignerTeamWorkspace(teamStates, teamId);
  return {
    teamId,
    memory: workspace.memory,
    currentChallenge: workspace.currentChallenge,
    lastReflection: workspace.lastReflection,
    loading: workspace.loading,
    error: workspace.error,
  };
}

export function isDesignerNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('404') || message.includes('不存在');
}

export function appendUniqueString(prev: string[], value: string): string[] {
  return prev.includes(value) ? prev : [...prev, value];
}

export function mergeAgentMemory(
  prev: AgentMemory | undefined,
  patch: Partial<AgentMemory> & Pick<AgentMemory, 'agent_id' | 'team_id'>,
): AgentMemory {
  return {
    agent_id: patch.agent_id,
    team_id: patch.team_id,
    observations: patch.observations ?? prev?.observations ?? [],
    performance_log: patch.performance_log ?? prev?.performance_log ?? [],
    submission_count: patch.submission_count ?? prev?.submission_count ?? 0,
    pass_count: patch.pass_count ?? prev?.pass_count ?? 0,
    score_trajectory: patch.score_trajectory ?? prev?.score_trajectory ?? {},
    growth_summary: patch.growth_summary ?? prev?.growth_summary ?? '',
    strengths: patch.strengths ?? prev?.strengths ?? [],
    weaknesses: patch.weaknesses ?? prev?.weaknesses ?? [],
    pass_rate: patch.pass_rate ?? prev?.pass_rate ?? 0,
    avg_scores: patch.avg_scores ?? prev?.avg_scores ?? {},
  };
}
