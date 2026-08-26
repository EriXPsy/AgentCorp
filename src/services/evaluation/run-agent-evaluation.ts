import type {
  EvaluationProfile,
  KpiRecord,
  LifecycleState,
  RadarScore,
  RoiSnapshot,
  Verdict,
} from '@/types/evaluation';
import type { JudgeRunInput } from '@/services/judgeClient';
import type { EvaluationRunInput } from './evaluation-types';
import { computeKpi } from '@/engine/metricsEngine';
import { tokenUsageCollector } from '@/services/tokenUsageCollector';
import { collectRunData } from '@/services/evaluationData';
import {
  buildEvaluationProfile,
  consumeEvaluationJudgeStream,
  type ConsumeJudgeStreamHooks,
} from './evaluation-run';
import { currentEvaluationWindow } from './evaluation-projection';
import { readInterviewBaselineSnapshot } from './evaluation-baseline';
import { linkRunToTask } from '@/services/evaluationRuntime';

export interface ExecuteAgentEvaluationInput {
  input: EvaluationRunInput;
  prevProfile: EvaluationProfile | undefined;
  profiles: Record<string, EvaluationProfile>;
  userWeight: Record<string, number>;
  hooks?: ConsumeJudgeStreamHooks;
}

export interface ExecuteAgentEvaluationResult {
  profile: EvaluationProfile;
  lifecycle: LifecycleState;
  radarScore: RadarScore;
  kpi: KpiRecord;
  roi: RoiSnapshot;
  transcript: string;
  verdict: Verdict | null;
  verdictUserFit: number;
  sawAudio: boolean;
}

export function buildEvaluationJudgeInput(input: {
  agentId: string;
  agentName: string;
  persona?: string;
  bossProfile?: EvaluationRunInput['bossProfile'];
  task?: EvaluationRunInput['task'];
  transcript: string;
  usage: unknown[];
  telemetry: unknown[];
  userWeight: Record<string, number>;
}): JudgeRunInput {
  return {
    agentId: input.agentId,
    agentName: input.agentName,
    persona: input.persona,
    bossProfile: input.bossProfile,
    task: input.task ?? { title: 'Ad-hoc task', description: '', weight: 1 },
    transcript: input.transcript,
    usage: input.usage as JudgeRunInput['usage'],
    telemetry: input.telemetry as JudgeRunInput['telemetry'],
    preference: { weight: { ...input.userWeight } },
  };
}

export async function executeAgentEvaluation(
  payload: ExecuteAgentEvaluationInput,
): Promise<ExecuteAgentEvaluationResult> {
  const { input, prevProfile, profiles, userWeight, hooks } = payload;
  const collected = await collectRunData(input.agentId, input.sessionId);
  const { events, entries } = collected;
  const transcript = collected.transcript.trim().length > 0
    ? collected.transcript
    : (input.transcriptFallback ?? '');

  const window = currentEvaluationWindow();
  const kpi = computeKpi(events, window, prevProfile?.radarHistory ?? []);
  const roiPopulation = Object.values(profiles)
    .filter((profile) => profile.agentId !== input.agentId)
    .map((profile) => profile.roiLatest?.roi ?? 0);
  const roi = tokenUsageCollector.buildRoiSnapshot(entries, events, input.agentId, window, {
    population: roiPopulation.length > 0 ? roiPopulation : undefined,
  });

  const judgeInput = buildEvaluationJudgeInput({
    agentId: input.agentId,
    agentName: input.agentName,
    persona: input.persona,
    bossProfile: input.bossProfile,
    task: input.task,
    transcript,
    usage: entries,
    telemetry: events,
    userWeight,
  });

  const judgeResult = await consumeEvaluationJudgeStream(judgeInput, hooks);
  const interviewBaseline = await readInterviewBaselineSnapshot(input.agentId, prevProfile);
  const builtProfile = buildEvaluationProfile({
    input: {
      runId: input.runId,
      agentId: input.agentId,
      bossProfile: input.bossProfile,
    },
    prev: prevProfile,
    radarScore: judgeResult.radarScore,
    kpi,
    roi,
    transcript,
    interviewBaseline,
    verdict: judgeResult.verdict,
    verdictUserFit: judgeResult.verdictUserFit,
    verdictEvidence: judgeResult.verdictEvidence,
    judgeSource: judgeResult.judgeSource,
  });

  if (input.runId) {
    await linkRunToTask(input.runId, {
      taskId: input.taskId ?? '',
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
    });
  }

  return {
    profile: builtProfile.profile,
    lifecycle: builtProfile.lifecycle,
    radarScore: judgeResult.radarScore,
    kpi,
    roi,
    transcript,
    verdict: judgeResult.verdict,
    verdictUserFit: judgeResult.verdictUserFit,
    sawAudio: judgeResult.sawAudio,
  };
}
