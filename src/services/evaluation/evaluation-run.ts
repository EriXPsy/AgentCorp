import type {
  BossProfile,
  EvaluationProfile,
  KpiRecord,
  LifecycleState,
  RadarScore,
  RoiSnapshot,
  Verdict,
} from '@/types/evaluation';
import { verdictToLifecycleState, LIFECYCLE_TO_STATE } from '@/types/lifecycle';
import { judgeClient, type JudgeRunInput } from '@/services/judgeClient';
import { personalizationRiskFromRadarMap } from '@/engine/evaluation/evalSuite';

export interface ConsumeJudgeStreamHooks {
  onRadarUpdate?: (radar: Partial<RadarScore>) => void;
  onNarrationDelta?: (delta: string) => void;
  onNarrationFallbackSpeech?: (delta: string) => void;
  onAudioChunk?: (chunk: string, format: 'pcm16' | 'wav', sampleRate: number) => void;
}

export interface ConsumedJudgeStreamResult {
  radarScore: RadarScore;
  verdict: Verdict | null;
  verdictUserFit: number;
  verdictEvidence: string[];
  judgeSource: 'judge' | 'mixed' | 'degraded' | null;
  sawAudio: boolean;
}

const ZERO_RADAR: RadarScore = {
  task: 0,
  quality: 0,
  comm: 0,
  creativity: 0,
  reliability: 0,
  cost: 0,
};

export async function consumeEvaluationJudgeStream(
  judgeInput: JudgeRunInput,
  hooks: ConsumeJudgeStreamHooks = {},
): Promise<ConsumedJudgeStreamResult> {
  const radar: Partial<RadarScore> = {};
  let verdict: Verdict | null = null;
  let verdictUserFit = 0;
  let verdictEvidence: string[] = [];
  let sawAudio = false;
  let judgeDims = 0;
  let degradedDims = 0;

  for await (const event of judgeClient.evaluate(judgeInput)) {
    if (event.type === 'radar_update') {
      radar[event.dim] = event.score;
      if (event.source === 'degraded') degradedDims += 1;
      else judgeDims += 1;
      hooks.onRadarUpdate?.(radar);
      continue;
    }
    if (event.type === 'narration') {
      if (event.delta) {
        hooks.onNarrationDelta?.(event.delta);
        if (!sawAudio) hooks.onNarrationFallbackSpeech?.(event.delta);
      }
      continue;
    }
    if (event.type === 'audio') {
      sawAudio = true;
      hooks.onAudioChunk?.(event.chunk, event.format, event.sample_rate);
      continue;
    }
    if (event.type === 'verdict') {
      verdict = event.verdict;
      verdictUserFit = event.user_fit;
      verdictEvidence = event.evidence_trace;
      if (event.source === 'degraded') degradedDims += 1;
      else judgeDims += 1;
    }
  }

  const judgeSource: 'judge' | 'mixed' | 'degraded' | null =
    judgeDims + degradedDims === 0
      ? null
      : degradedDims === 0
        ? 'judge'
        : judgeDims === 0
          ? 'degraded'
          : 'mixed';

  return {
    radarScore: { ...ZERO_RADAR, ...radar },
    verdict,
    verdictUserFit,
    verdictEvidence,
    judgeSource,
    sawAudio,
  };
}

export interface BuildEvaluationProfileInput {
  input: {
    runId?: string | null;
    agentId: string;
    bossProfile?: BossProfile;
  };
  prev: EvaluationProfile | undefined;
  radarScore: RadarScore;
  kpi: KpiRecord;
  roi: RoiSnapshot;
  transcript: string;
  interviewBaseline: EvaluationProfile['interviewBaseline'];
  verdict: Verdict | null;
  verdictUserFit: number;
  verdictEvidence: string[];
  judgeSource: 'judge' | 'mixed' | 'degraded' | null;
}

export interface BuildEvaluationProfileResult {
  profile: EvaluationProfile;
  lifecycle: LifecycleState;
}

export function buildEvaluationProfile(input: BuildEvaluationProfileInput): BuildEvaluationProfileResult {
  const lifecycle: LifecycleState = input.verdict
    ? verdictToLifecycleState(input.verdict)
    : LIFECYCLE_TO_STATE.active;

  const radarByPersona = {
    ...(input.prev?.radarByPersona ?? {}),
    [input.input.bossProfile?.id ?? 'neutral']: input.radarScore,
  };

  const profile: EvaluationProfile = {
    agentId: input.input.agentId,
    radarLatest: input.radarScore,
    radarHistory: [...(input.prev?.radarHistory ?? []), input.radarScore],
    kpiLatest: input.kpi,
    kpiHistory: [...(input.prev?.kpiHistory ?? []), input.kpi],
    roiLatest: input.roi,
    lifecycle,
    runIds: [...(input.prev?.runIds ?? []), ...(input.input.runId ? [input.input.runId] : [])],
    updatedAt: new Date().toISOString(),
    userFitLatest: input.verdict ? input.verdictUserFit : input.prev?.userFitLatest,
    evidenceTraceLatest: input.verdict ? input.verdictEvidence : input.prev?.evidenceTraceLatest,
    jobType: input.prev?.jobType,
    stageScores: input.prev?.stageScores,
    subjectiveLatest: input.prev?.subjectiveLatest,
    subjectiveHistory: input.prev?.subjectiveHistory,
    craftLatest: input.prev?.craftLatest,
    interviewBaseline: input.interviewBaseline,
    radarByPersona,
    personalizationRisk: personalizationRiskFromRadarMap(radarByPersona),
    sessionsByPersona: {
      ...(input.prev?.sessionsByPersona ?? {}),
      [input.input.bossProfile?.id ?? 'neutral']: [
        ...(input.prev?.sessionsByPersona?.[input.input.bossProfile?.id ?? 'neutral'] ?? []),
        {
          ts: new Date().toISOString(),
          summary: input.transcript.slice(0, 200),
          transcript: input.transcript,
        },
      ].slice(-3),
    },
    lastPersonaId: input.input.bossProfile?.id ?? 'neutral',
    judgeSource: input.judgeSource,
  };

  return { profile, lifecycle };
}
