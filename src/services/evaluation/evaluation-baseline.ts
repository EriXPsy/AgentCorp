import type { EvaluationProfile } from '@/types/evaluation';
import { latestByAgent as latestInterviewByAgent } from '@/services/interviewStore';

export async function readInterviewBaselineSnapshot(
  agentId: string,
  prev: EvaluationProfile | undefined,
): Promise<EvaluationProfile['interviewBaseline']> {
  try {
    const report = await latestInterviewByAgent(agentId);
    if (!report) return prev?.interviewBaseline;
    const existing = prev?.interviewBaseline;
    if (existing && String(existing.ts) >= String(report.ts)) return existing;
    return {
      radar: report.finalRadar ?? report.baselineRadar,
      metrics: {
        avgReplyLatencyMs: report.metrics.avgReplyLatencyMs,
        totalTokens: report.metrics.totalTokens,
        clarificationCount: report.metrics.clarificationCount,
        followupCount: report.metrics.followupCount,
        coverageRatio: report.metrics.coverageRatio,
      },
      reportId: report.interviewId,
      ts: report.ts,
    };
  } catch {
    return prev?.interviewBaseline;
  }
}
