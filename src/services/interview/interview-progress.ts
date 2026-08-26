import type { InterviewQuestion, InterviewTurn } from '@/types/interview';
import { makeFollowupQuestion, nextQuestion as pickNextQuestion, planTargetDims } from '@/engine/interview/questionBank';
import {
  computeCoverage,
  suggestFollowups,
  shouldTerminateFollowup,
  DEFAULT_FOLLOWUP_BUDGET,
  type DimCoverage,
  type FollowupSuggestion,
} from '@/engine/interview/dimTracker';

export interface AppendInterviewReplyInput {
  currentQuestion: InterviewQuestion;
  turns: InterviewTurn[];
  askedQIds: string[];
  skippedQIds: string[];
  plan: InterviewQuestion[];
  judgeConfidence: number | null;
  replyText: string;
  meta?: { latencyMs?: number | null; tokensUsed?: number | null; runId?: string | null };
}

export interface AppendInterviewReplyResult {
  turn: InterviewTurn;
  turns: InterviewTurn[];
  askedQIds: string[];
  coverage: DimCoverage[];
  suggestions: FollowupSuggestion[];
  currentQuestion: InterviewQuestion | null;
}

function buildFollowupAwareQuestionIds(questionId: string, askedQIds: string[]): string[] {
  const baseQId = questionId.includes(':fu') ? questionId.split(':fu')[0] : questionId;
  return [...new Set([...askedQIds, baseQId, questionId])];
}

function buildSuggestions(
  turns: InterviewTurn[],
  plan: InterviewQuestion[],
  judgeConfidence: number | null,
): { coverage: DimCoverage[]; suggestions: FollowupSuggestion[] } {
  const targetDims = planTargetDims(plan);
  const coverage = computeCoverage(turns, targetDims);
  const suggestions = shouldTerminateFollowup(turns, targetDims, {
    confidence: judgeConfidence ?? undefined,
  })
    ? []
    : suggestFollowups(turns, targetDims, { budget: DEFAULT_FOLLOWUP_BUDGET });
  return { coverage, suggestions };
}

export function appendInterviewReply(
  input: AppendInterviewReplyInput,
): AppendInterviewReplyResult {
  const text = input.replyText.trim();
  const turn: InterviewTurn = {
    turn: input.turns.length + 1,
    qId: input.currentQuestion.qId,
    question: input.currentQuestion.prompt,
    targetDims: [...input.currentQuestion.targetDims],
    replyText: text,
    replyLatencyMs: input.meta?.latencyMs ?? null,
    tokensUsed: input.meta?.tokensUsed ?? null,
    runId: input.meta?.runId ?? undefined,
    hrRatings: {},
    ts: new Date().toISOString(),
  };

  const turns = [...input.turns, turn];
  const askedQIds = buildFollowupAwareQuestionIds(input.currentQuestion.qId, input.askedQIds);
  const { coverage, suggestions } = buildSuggestions(turns, input.plan, input.judgeConfidence);
  const consumed = [...new Set([...askedQIds, ...input.skippedQIds])];

  return {
    turn,
    turns,
    askedQIds,
    coverage,
    suggestions,
    currentQuestion: pickNextQuestion(input.plan, consumed),
  };
}

export interface ApplyInterviewRatingInput {
  turns: InterviewTurn[];
  plan: InterviewQuestion[];
  judgeConfidence: number | null;
  turn: number;
  dim: string;
  value: number;
}

export interface ApplyInterviewRatingResult {
  turns: InterviewTurn[];
  coverage: DimCoverage[];
  suggestions: FollowupSuggestion[];
}

export function applyInterviewRating(
  input: ApplyInterviewRatingInput,
): ApplyInterviewRatingResult {
  const turns = input.turns.map((item) =>
    item.turn === input.turn
      ? { ...item, hrRatings: { ...item.hrRatings, [input.dim]: input.value } }
      : item,
  );
  const { coverage, suggestions } = buildSuggestions(turns, input.plan, input.judgeConfidence);
  return { turns, coverage, suggestions };
}

export interface ResolveFollowupQuestionInput {
  currentQuestion: InterviewQuestion | null;
  turns: InterviewTurn[];
  plan: InterviewQuestion[];
  suggestion: FollowupSuggestion;
}

function stripFollowupSuffix(qId: string): string {
  return qId.split(':fu')[0];
}

export function resolveFollowupQuestion(
  input: ResolveFollowupQuestionInput,
): InterviewQuestion | null {
  const { currentQuestion, turns, plan, suggestion } = input;

  const fromCurrent =
    currentQuestion && !currentQuestion.qId.includes(':fu') && currentQuestion.targetDims.includes(suggestion.dim)
      ? stripFollowupSuffix(currentQuestion.qId)
      : null;
  const fromTurns = turns
    .filter((turn) => !turn.qId.includes(':fu') && turn.targetDims.includes(suggestion.dim))
    .map((turn) => stripFollowupSuffix(turn.qId));
  const baseQId =
    fromCurrent
    ?? fromTurns[fromTurns.length - 1]
    ?? (currentQuestion ? stripFollowupSuffix(currentQuestion.qId) : null)
    ?? plan[0]?.qId;

  if (!baseQId) return null;
  const base = plan.find((question) => question.qId === baseQId) ?? plan[0];
  if (!base) return null;

  const index = turns.filter((turn) => turn.qId.startsWith(`${baseQId}:fu`)).length + 1;
  return {
    ...makeFollowupQuestion(base, suggestion.prompt, index),
    targetDims: [suggestion.dim],
  };
}

export interface SkipInterviewQuestionInput {
  currentQuestion: InterviewQuestion;
  skippedQIds: string[];
  askedQIds: string[];
  plan: InterviewQuestion[];
}

export interface SkipInterviewQuestionResult {
  skippedQIds: string[];
  currentQuestion: InterviewQuestion | null;
}

export function skipInterviewQuestion(
  input: SkipInterviewQuestionInput,
): SkipInterviewQuestionResult {
  const qId = input.currentQuestion.qId;
  const skippedQIds = input.skippedQIds.includes(qId)
    ? input.skippedQIds
    : [...input.skippedQIds, qId];
  const consumed = [...new Set([...input.askedQIds, ...skippedQIds])];
  return {
    skippedQIds,
    currentQuestion: pickNextQuestion(input.plan, consumed),
  };
}

export function buildConvergenceBeliefVector(coverage: DimCoverage[]): number[] {
  if (coverage.length === 0) return [0];
  return coverage.map((item) => {
    const rating = typeof item.rating === 'number' ? item.rating / 5 : item.coverage;
    return Math.round(((item.coverage + rating) / 2) * 1000) / 1000;
  });
}

export function classifyCraftRunMode(sessionKey: string | undefined, manualAnswer?: string): {
  requiresManualInput: boolean;
  initialAnswerText: string;
} {
  const initialAnswerText = manualAnswer?.trim() ?? '';
  return {
    requiresManualInput: initialAnswerText.length === 0 && !sessionKey,
    initialAnswerText,
  };
}

export function normalizeCraftTrialRound(input: {
  taskId: string;
  title: string;
  prompt: string;
  answerText: string;
  mode: 'agent' | 'manual';
  answerLatencyMs: number | null;
}): { taskId: string; title: string; prompt: string; answerText: string; mode: 'agent' | 'manual'; answerLatencyMs: number | null; ts: string } {
  return {
    ...input,
    ts: new Date().toISOString(),
  };
}
