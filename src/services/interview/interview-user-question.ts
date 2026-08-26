import type { JobType } from '@/types/evaluation';
import type { ArenaMatch, ArenaPick, CandidateRef } from '@/types/arena';
import type { UserQuestionRound } from '@/types/interview';
import type { ArenaCompareOptions, ArenaCompareStatus } from '@/stores/arenaStore';

export interface InterviewArenaRuntime {
  setRequirementText: (text: string) => void;
  setJobType: (jobType: JobType) => void;
  setCandidates: (candidates: CandidateRef[]) => void;
  compare: (opts?: ArenaCompareOptions) => Promise<void>;
  pick: (pick: ArenaPick) => Promise<void>;
  snapshot: () => { status: ArenaCompareStatus; match: ArenaMatch | null; error: string | null };
}

export function validateInterviewUserQuestion(input: {
  interviewId: string | null;
  question: string;
  candidates: CandidateRef[];
}): string | null {
  if (!input.interviewId) return '尚无进行中的面试会话';
  if (!input.question.trim()) return '用户题不能为空';
  if (input.candidates.length < 2) return '用户题至少需要两个候选 agent';
  return null;
}

export function buildUserQuestionRound(
  question: string,
  match: ArenaMatch,
): UserQuestionRound {
  return {
    question,
    matchId: match.matchId,
    candidates: match.candidates.map((candidate) => ({
      agentId: candidate.agentId,
      agentName: candidate.agentName,
      answerText: candidate.answerText,
    })),
    pick: null,
    ts: new Date().toISOString(),
  };
}

export function updateUserQuestionRound(
  round: UserQuestionRound,
  pick: ArenaPick,
): UserQuestionRound {
  return {
    ...round,
    pick,
    ts: new Date().toISOString(),
  };
}

export async function startInterviewUserQuestion(input: {
  interviewId: string;
  question: string;
  jobType: JobType;
  candidates: CandidateRef[];
  arena: InterviewArenaRuntime;
}): Promise<{ round: UserQuestionRound | null; error: string | null }> {
  input.arena.setRequirementText(input.question);
  input.arena.setJobType(input.jobType);
  input.arena.setCandidates(input.candidates);
  await input.arena.compare({ context: 'interview', interviewId: input.interviewId });

  const after = input.arena.snapshot();
  if (after.status === 'error' || !after.match) {
    return {
      round: null,
      error: after.error ?? '用户题对决失败（后端不可用）',
    };
  }

  return {
    round: buildUserQuestionRound(input.question, after.match),
    error: null,
  };
}

export async function pickInterviewUserQuestion(input: {
  round: UserQuestionRound | null;
  pick: ArenaPick;
  arena: InterviewArenaRuntime;
}): Promise<{ round: UserQuestionRound | null; error: string | null }> {
  if (!input.round) {
    return { round: null, error: '尚未发起用户自定义题' };
  }

  const before = input.arena.snapshot();
  if (before.match?.matchId !== input.round.matchId) {
    return { round: null, error: '对决状态不一致，请重新发起' };
  }

  await input.arena.pick(input.pick);
  const after = input.arena.snapshot();
  if (after.status === 'error') {
    return { round: null, error: after.error ?? 'pick 回传失败' };
  }

  return {
    round: updateUserQuestionRound(input.round, input.pick),
    error: null,
  };
}
