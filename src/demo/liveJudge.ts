/**
 * 真实评委适配器：把现有 judgeClient.judgeChat 包装成闭环注入式 JudgeFn。
 * 网关（127.0.0.1:3210）不可达时 judgeChat 返回 null → 调用方降级 mock，
 * 与 agentcorp-fresh 既有「离线回退」语义一致。
 */
import { judgeChat } from '@/services/judgeClient';
import type { JudgeFn, JudgeFnInput, JudgeFnOutput } from './closedLoop';

export const liveJudge: JudgeFn = async (input: JudgeFnInput): Promise<JudgeFnOutput | null> => {
  const res = await judgeChat(
    input.agentId,
    input.transcript,
    input.bossProfile ?? null,
    null,
    input.variant,
  );
  if (!res || !res.radar) return null;
  return {
    radar: res.radar,
    verdict: res.verdict ?? 'OBSERVE',
    confidence: res.confidence,
    evidence: res.evidence_trace,
  };
};

/**
 * Demo 页默认评委：先试真实网关，失败再降级 mock —— 真实环境用真评委，
 * 沙箱/离线态用 mock，保证闭环永远可跑通（honest fallback，不静默假装成功）。
 */
export const demoJudge: JudgeFn = async (input: JudgeFnInput): Promise<JudgeFnOutput | null> => {
  const live = await liveJudge(input);
  if (live) return live;
  const { mockJudge } = await import('./mockJudge');
  return mockJudge(input);
};
