import type { EvaluationProfile } from '@/types/evaluation';
import type { InterviewReport } from '@/types/interview';

export function buildInterviewBaselineFromReport(
  report: InterviewReport,
): EvaluationProfile['interviewBaseline'] {
  return {
    radar: report.finalRadar ?? report.baselineRadar,
    metrics: report.metrics,
    reportId: report.interviewId,
    ts: report.ts,
  };
}

export interface PersistInterviewFinalizationInput {
  report: InterviewReport;
  hasEvaluationProfile: boolean;
  saveReport: (report: InterviewReport) => Promise<void>;
  setEvaluationRunResult: (
    agentId: string,
    patch: Partial<EvaluationProfile>,
  ) => Promise<void>;
  computeConvergence: () => Promise<unknown>;
}

export interface PersistInterviewFinalizationResult {
  reportError: string | null;
  baselineMessage: string | null;
}

export async function persistInterviewFinalization(
  input: PersistInterviewFinalizationInput,
): Promise<PersistInterviewFinalizationResult> {
  let reportError: string | null = null;
  let baselineMessage: string | null = null;

  try {
    await input.saveReport(input.report);
  } catch (error) {
    reportError = error instanceof Error ? error.message : '面试报告落库失败';
  }

  try {
    if (input.hasEvaluationProfile) {
      await input.setEvaluationRunResult(input.report.agentId, {
        jobType: input.report.jobType,
        interviewBaseline: buildInterviewBaselineFromReport(input.report),
      });
    } else {
      baselineMessage =
        '该 agent 尚未在绩效中心建档，面试基线暂未回灌（不影响本次面试归档）；若需回灌基线，请先在「评估中心」运行一次评估。';
    }
  } catch {
    // 档案不存在或落库失败不阻断面试收尾
  }

  try {
    await input.computeConvergence();
  } catch {
    // 收敛评分为 best-effort，不影响主流程
  }

  return { reportError, baselineMessage };
}
