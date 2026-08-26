import type { BossProfile, RadarScore } from '@/types/evaluation';
import type { InterviewQuestion, InterviewTurn } from '@/types/interview';
import {
  computeCoverage,
  type DimCoverage,
} from '@/engine/interview/dimTracker';
import { planTargetDims } from '@/engine/interview/questionBank';
import { judgeChatEnsemble, type JudgeEnsembleResult } from '@/services/judgeEnsemble';
import { buildInterviewTranscript } from './interview-workflow';

export interface RunInterviewJudgeInput {
  agentId: string | null;
  turns: InterviewTurn[];
  plan: InterviewQuestion[];
  persona?: BossProfile | null;
}

export interface InterviewJudgePatch {
  judgeRadar: RadarScore;
  judgeSource: 'judge' | 'mixed' | 'degraded';
  judgeEvidence: string[];
  judgeConfidence: number;
  coverage: DimCoverage[];
}

export type RunInterviewJudgeResult =
  | { kind: 'skip'; reason: 'missing-agent' | 'empty-transcript' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; transcript: string; ensemble: JudgeEnsembleResult; patch: InterviewJudgePatch };

export async function runInterviewJudge(
  input: RunInterviewJudgeInput,
): Promise<RunInterviewJudgeResult> {
  if (!input.agentId) {
    return { kind: 'skip', reason: 'missing-agent' };
  }

  const transcript = buildInterviewTranscript(input.turns);
  if (transcript.trim().length === 0) {
    return { kind: 'skip', reason: 'empty-transcript' };
  }

  const ensemble = await judgeChatEnsemble(input.agentId, transcript, {
    persona: input.persona,
  }).catch(() => null);

  if (!ensemble) {
    return {
      kind: 'error',
      message: '模型裁判暂不可用，本场六维暂无模型分（不会用估算值代替）',
    };
  }

  const targetDims = planTargetDims(input.plan);
  return {
    kind: 'success',
    transcript,
    ensemble,
    patch: {
      judgeRadar: ensemble.meanRadar,
      judgeSource: ensemble.source,
      judgeEvidence: ensemble.evidence_trace,
      judgeConfidence: ensemble.confidence,
      coverage: computeCoverage(input.turns, targetDims, ensemble.meanRadar),
    },
  };
}
