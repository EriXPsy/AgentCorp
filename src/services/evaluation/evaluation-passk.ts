import { allPassAcrossSessions, judgeChatEnsemble, type JudgeEnsembleResult } from '@/services/judgeEnsemble';
import { passK, type PassKResult } from '@/engine/evaluation/passK';
import type { BossProfile, EvaluationProfile } from '@/types/evaluation';

export type EvaluationPassKResult =
  | { kind: 'error'; message: string }
  | { kind: 'success'; result: PassKResult };

export interface RunEvaluationPassKInput {
  agentId: string;
  transcript: string | null;
  profile: EvaluationProfile | undefined;
  k: number;
  useSessions?: boolean;
  activeBossProfile: BossProfile;
}

export async function runEvaluationPassK(
  input: RunEvaluationPassKInput,
): Promise<EvaluationPassKResult> {
  if (input.useSessions) {
    const activeId = input.activeBossProfile?.id ?? 'neutral';
    const sessions = input.profile?.sessionsByPersona?.[activeId] ?? [];
    const usable = sessions.filter(
      (session): session is typeof session & { transcript: string } =>
        typeof session.transcript === 'string' && session.transcript.length > 0,
    );
    const transcripts = usable.map((session) => session.transcript);
    if (transcripts.length < 2) {
      return {
        kind: 'error',
        message: '状态化多轮测算需要同一原型下 ≥2 段历史会话，请先在该老板原型下运行多次评估。',
      };
    }

    const summaries = usable.map((session) => session.summary ?? session.transcript.slice(0, 200));
    const sessionResults = await Promise.all(
      transcripts.map((transcript, index) =>
        judgeChatEnsemble(input.agentId, transcript, {
          k: 1,
          persona: input.activeBossProfile,
          history: summaries.slice(0, index),
        }),
      ),
    );
    const valid = sessionResults.filter(
      (result): result is JudgeEnsembleResult => Boolean(result) && Boolean(result?.meanRadar),
    );
    if (valid.length < 2) {
      return {
        kind: 'error',
        message: '裁判服务不可用或部分会话评分失败，无法跨会话测算 pass^k。',
      };
    }

    const perSessionPass = valid.map((result) => result.passK.allPass);
    const allRadars = valid.map((result) => result.meanRadar);
    const base = passK(allRadars, { k: allRadars.length });
    const sessionReasoning = valid
      .flatMap((result) => result.reasoning ?? [])
      .filter((text) => typeof text === 'string' && text.trim().length > 0);

    return {
      kind: 'success',
      result: {
        ...base,
        mode: 'sessions',
        k: allRadars.length,
        allPass: allPassAcrossSessions(perSessionPass),
        passRate: Math.round((perSessionPass.filter(Boolean).length / perSessionPass.length) * 100) / 100,
        reasoning: sessionReasoning.length > 0 ? sessionReasoning.join('\n---\n') : null,
      },
    };
  }

  if (!input.transcript) {
    return {
      kind: 'error',
      message: '尚无转录文本，请先运行一次评估以采集对话。',
    };
  }

  const result = await judgeChatEnsemble(input.agentId, input.transcript, {
    k: input.k,
    persona: input.activeBossProfile,
  });
  if (!result) {
    return {
      kind: 'error',
      message: '裁判服务不可用，无法计算 pass^k（需联网的 MiniCPM-o 裁判）。',
    };
  }

  const ensembleReasoning = (result.reasoning ?? []).filter((text) => text.trim().length > 0);
  return {
    kind: 'success',
    result: {
      ...result.passK,
      reasoning: ensembleReasoning.length > 0 ? ensembleReasoning.join('\n---\n') : null,
    },
  };
}
