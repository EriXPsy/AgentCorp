import type {
  EvaluationProfile,
  KpiRecord,
  RadarScore,
  RoiSnapshot,
} from '@/types/evaluation';

export interface SelectedEvaluationView {
  radarLatest: RadarScore | null;
  kpiLatest: KpiRecord | null;
  roiLatest: RoiSnapshot | null;
}

export function buildSelectedEvaluationView(
  profile: EvaluationProfile | null | undefined,
): SelectedEvaluationView {
  return {
    radarLatest: profile?.radarLatest ?? null,
    kpiLatest: profile?.kpiLatest ?? null,
    roiLatest: profile?.roiLatest ?? null,
  };
}

export function mergeEvaluationAgentNames(
  prev: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> | null {
  let changed = false;
  for (const [id, name] of Object.entries(incoming)) {
    if (name && prev[id] !== name) {
      changed = true;
      break;
    }
  }
  if (!changed) return null;
  return { ...prev, ...incoming };
}
