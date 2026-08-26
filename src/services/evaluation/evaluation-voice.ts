import type { Verdict } from '@/types/evaluation';

/** 当裁判没有返回音频块时，用统一口径补一句语音结论。 */
export function buildEvaluationVerdictAnnouncement(
  verdict: Verdict | null,
  verdictUserFit: number,
): string | null {
  if (!verdict) return null;
  const label =
    verdict === 'MVP'
      ? 'MVP'
      : verdict === 'OBSERVE'
        ? '待观察'
        : '暂不录用';
  return `综合判定：${label}。用户契合度 ${Math.round(verdictUserFit)}%。`;
}
