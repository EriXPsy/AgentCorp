import type {
  BossProfile,
  CraftDim,
  JobType,
  RadarDim,
  RadarScore,
  StageScore,
  SubjectiveScore,
} from '@/types/evaluation';
import type { TaskProfile, TaskRequirement } from '@/types/marketplace';
import type {
  CraftTrialRound,
  InterviewPhase,
  InterviewQuestion,
  InterviewRecommendation,
  InterviewReport,
  InterviewTurn,
  UserQuestionRound,
} from '@/types/interview';
import type { RoleCard } from '@/engine/agents/roleCard';
import {
  planTargetDims,
  renderPrompt,
  selectQuestions,
} from '@/engine/interview/questionBank';
import {
  aggregateHrRadar,
  buildDimEvidence,
  buildMetrics,
  computeCoverage,
  coverageRatio,
  recommendationOf,
  recommendationTrace,
  suggestFollowups,
  DEFAULT_FOLLOWUP_BUDGET,
  type DimCoverage,
  type FollowupSuggestion,
} from '@/engine/interview/dimTracker';
import { aggregateCraftDims, buildCraftEvidence, buildVerifiedEvidence } from '@/engine/interview/craftAggregate';
import { RADAR_DIMS } from '@/engine/scoring/registry';

export interface BuildInterviewStartStateInput {
  agentId: string;
  requestedJobType?: JobType | null;
  taskRequirement: TaskRequirement;
  taskProfile?: TaskProfile;
  baselineRadar: RadarScore | null;
  createdBy: string;
  roleCard?: RoleCard;
  persona?: BossProfile | null;
}

export interface InterviewStartStatePatch {
  interviewId: string;
  jobType: JobType;
  taskRequirement: TaskRequirement;
  plan: InterviewQuestion[];
  currentQuestion: InterviewQuestion | null;
  coverage: DimCoverage[];
  suggestions: FollowupSuggestion[];
  baselineRadar: RadarScore | null;
  createdBy: string;
  targetRole: RoleCard | null;
}

export function makeInterviewId(agentId: string): string {
  return `itv-${agentId}-${Date.now()}`;
}

export function buildInterviewTranscript(turns: InterviewTurn[]): string {
  return turns
    .map((turn) => `面试官：${turn.question}\n候选：${turn.replyText}`)
    .join('\n\n');
}

export function deriveHrOnlyRadar(turns: InterviewTurn[]): RadarScore | null {
  return aggregateHrRadar(turns, null);
}

export function deriveInterviewPhase(
  question: InterviewQuestion | null,
  plan: InterviewQuestion[],
): InterviewPhase {
  if (question) return question.phase;
  const last = plan[plan.length - 1];
  return last ? last.phase : 'P1_understanding';
}

export function deriveInterviewCoverageRatio(coverage: DimCoverage[]): number {
  return coverageRatio(coverage);
}

export function buildInterviewStartState(
  input: BuildInterviewStartStateInput,
): InterviewStartStatePatch {
  const jobType: JobType = input.requestedJobType ?? input.taskProfile?.jobType ?? 'code';
  const plan = selectQuestions({
    jobType,
    dimBoost: input.taskProfile?.dimBoost,
    tags: input.taskRequirement.tags,
    persona: input.persona,
  }).map((question) => ({
    ...question,
    prompt: renderPrompt(question.prompt, {
      taskText: input.taskRequirement.text,
      tags: input.taskRequirement.tags,
      qId: question.qId,
    }),
  }));

  const targetDims = planTargetDims(plan);
  return {
    interviewId: makeInterviewId(input.agentId),
    jobType,
    taskRequirement: input.taskRequirement,
    plan,
    currentQuestion: plan[0] ?? null,
    coverage: computeCoverage([], targetDims),
    suggestions: suggestFollowups([], targetDims, { budget: DEFAULT_FOLLOWUP_BUDGET }),
    baselineRadar: input.baselineRadar,
    createdBy: input.createdBy,
    targetRole: input.roleCard ?? null,
  };
}

export interface BuildInterviewCompletionArtifactsInput {
  interviewId: string;
  agentId: string;
  jobType: JobType;
  taskRequirement: TaskRequirement;
  baselineRadar: RadarScore | null;
  plan: InterviewQuestion[];
  turns: InterviewTurn[];
  craftTrials: CraftTrialRound[];
  judgeRadar: RadarScore | null;
  stageScore: StageScore | null;
  subjectiveSnapshot: SubjectiveScore;
  subjectiveMap: Record<string, number>;
  createdBy: string;
  userQuestionRound?: UserQuestionRound | null;
  notes?: string;
  recommendation?: InterviewRecommendation;
}

export interface InterviewCompletionArtifacts {
  finalRadar: RadarScore | null;
  objective: Record<string, number>;
  subjective: Record<string, number>;
  craftEvidence: Record<string, string>;
  verifiedEvidence: Record<string, string>;
  report: InterviewReport;
}

export function buildInterviewCompletionArtifacts(
  input: BuildInterviewCompletionArtifactsInput,
): InterviewCompletionArtifacts {
  const targetDims: (RadarDim | CraftDim)[] = planTargetDims(input.plan);
  const metrics = buildMetrics(input.turns, targetDims);
  const hrRadar = aggregateHrRadar(input.turns, input.judgeRadar);
  const finalRadar = hrRadar ?? input.judgeRadar;
  const dimEvidence = buildDimEvidence(input.turns);

  const objective: Record<string, number> = {};
  const radarForScore = input.judgeRadar ? finalRadar : deriveHrOnlyRadar(input.turns);
  if (radarForScore) {
    for (const dim of RADAR_DIMS) objective[dim] = radarForScore[dim];
  }
  const craft = aggregateCraftDims(input.craftTrials);
  for (const [dim, score] of Object.entries(craft.dims)) objective[dim] = score;

  const subjective: Record<string, number> = {};
  for (const [dim, value] of Object.entries(input.subjectiveMap)) {
    if (typeof value === 'number') subjective[dim] = value;
  }

  const craftEvidence: Record<string, string> = {};
  for (const [dim, list] of Object.entries(dimEvidence)) {
    if (!Array.isArray(list) || list.length === 0) continue;
    if ((RADAR_DIMS as string[]).includes(dim)) continue;
    craftEvidence[dim] = list.join(' ／ ').slice(0, 500);
  }
  for (const [dim, text] of Object.entries(buildCraftEvidence(input.craftTrials))) {
    craftEvidence[dim] = text;
  }
  const verifiedEvidence = buildVerifiedEvidence(input.craftTrials);

  const stageScoreTotal = input.stageScore ? input.stageScore.total : null;
  const recommendation =
    input.recommendation
    ?? recommendationOf(stageScoreTotal, finalRadar, metrics.coverageRatio);

  const report: InterviewReport = {
    interviewId: input.interviewId,
    agentId: input.agentId,
    jobType: input.jobType,
    stage: 'interview',
    taskRequirement: input.taskRequirement,
    baselineRadar: input.baselineRadar,
    turns: input.turns,
    craftTrials: input.craftTrials,
    dimEvidence,
    metrics,
    finalRadar,
    stageScoreTotal,
    subjective: input.subjectiveSnapshot,
    convergenceRunId: input.interviewId,
    recommendation,
    ...recommendationTrace(stageScoreTotal, finalRadar, metrics.coverageRatio),
    notes: input.notes,
    userQuestionRound: input.userQuestionRound ?? undefined,
    createdBy: input.createdBy,
    ts: new Date().toISOString(),
  };

  return {
    finalRadar,
    objective,
    subjective,
    craftEvidence,
    verifiedEvidence,
    report,
  };
}
