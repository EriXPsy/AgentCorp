import type { PassKResult } from '@/engine/evaluation/passK';
import type { EvaluationProfile, LifecycleState } from '@/types/evaluation';
import type { EvaluationRunInput } from './evaluation-types';
import type { ExecuteAgentEvaluationResult } from './run-agent-evaluation';
import { buildSelectedEvaluationView } from './evaluation-ui';

export interface EvaluationProfileCollections {
  profiles: Record<string, EvaluationProfile>;
  lifecycle: Record<string, LifecycleState>;
}

/** 把一个持久化后的 profile 回写到 store collections。 */
export function buildPersistedEvaluationCollectionsPatch(
  current: EvaluationProfileCollections,
  profile: EvaluationProfile,
): EvaluationProfileCollections {
  return {
    profiles: { ...current.profiles, [profile.agentId]: profile },
    lifecycle: { ...current.lifecycle, [profile.agentId]: profile.lifecycle },
  };
}

/** 一次评估开始前，先清理流式 UI 与上一轮可靠性状态。 */
export function buildEvaluationRunStartPatch(
  input: EvaluationRunInput,
  agentNames: Record<string, string>,
) {
  return {
    agentNames:
      input.agentName && agentNames[input.agentId] !== input.agentName
        ? { ...agentNames, [input.agentId]: input.agentName }
        : agentNames,
    streaming: true,
    error: null,
    currentRunId: input.runId ?? null,
    selectedAgentId: input.agentId,
    narrationText: '',
    lastTranscript: null,
    passKResult: null,
  };
}

/** 评估完成后，把最新 profile 与选中视图一次性回写。 */
export function buildEvaluationRunSuccessPatch(
  current: EvaluationProfileCollections,
  result: ExecuteAgentEvaluationResult,
) {
  return {
    ...buildPersistedEvaluationCollectionsPatch(current, result.profile),
    ...buildSelectedEvaluationView(result.profile),
    lastTranscript: result.transcript,
    streaming: false,
    error: null,
  };
}

export function buildEvaluationRunErrorPatch(message: string) {
  return {
    streaming: false,
    error: message,
  };
}

export function buildEvaluationPassKStartPatch() {
  return {
    passKRunning: true,
    passKResult: null,
    error: null,
  };
}

export function buildEvaluationPassKSuccessPatch(result: PassKResult) {
  return {
    passKRunning: false,
    passKResult: result,
  };
}

export function buildEvaluationPassKErrorPatch(message: string) {
  return {
    passKRunning: false,
    error: message,
  };
}
