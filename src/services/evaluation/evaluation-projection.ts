import type {
  EvaluationProfile,
  KpiRecord,
  LeaderboardEntry,
  LeaderboardTier,
  RadarScore,
  RoiSnapshot,
} from '@/types/evaluation';
import { zscore } from '@/engine/roiEngine';

export const ZERO_RADAR: RadarScore = {
  task: 0,
  quality: 0,
  comm: 0,
  creativity: 0,
  reliability: 0,
  cost: 0,
};

export function currentEvaluationWindow(): string {
  const d = new Date();
  const oneJan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(
    ((d.getTime() - oneJan.getTime()) / 86_400_000 + oneJan.getDay() + 1) / 7,
  );
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function computeEvaluationLeaderboard(
  profiles: Record<string, EvaluationProfile>,
  names: Record<string, string>,
): LeaderboardEntry[] {
  const all = Object.values(profiles);
  if (all.length === 0) return [];

  const population = all.map((profile) => profile.roiLatest?.roi ?? 0);
  const useNorm = population.length > 1;
  const withRoi = all
    .map((profile, index) => ({
      profile,
      roi: population[index],
      roiNorm: useNorm ? zscore(population, population[index]) : 0,
    }))
    .sort((a, b) => (useNorm ? b.roiNorm - a.roiNorm : b.roi - a.roi));

  const total = withRoi.length;
  return withRoi.map((item, index) => {
    const rank = index + 1;
    const state = item.profile.lifecycle;
    let tier: LeaderboardTier = 'NORMAL';
    if (state === 'RETIRED') tier = 'BOTTOM';
    else if (rank === 1) tier = 'MVP';
    else if (rank === total) tier = 'BOTTOM';

    return {
      agentId: item.profile.agentId,
      name: names[item.profile.agentId] ?? item.profile.agentId,
      rank,
      user_fit: Math.round(item.profile.userFitLatest ?? (item.profile.radarLatest?.task ?? 0) * 20),
      roi_norm: item.roiNorm,
      state,
      tier,
      judge_source: item.profile.judgeSource ?? null,
    } satisfies LeaderboardEntry;
  });
}

export function emptyKpiRecord(agentId: string): KpiRecord {
  return {
    agentId,
    task_completion_rate: 0,
    first_success_rate: 0,
    rework_rate: 0,
    avg_delivery_latency_ms: 0,
    autonomy_rate: 0,
    escalation_rate: 0,
    cross_task_generalization: 0,
    stability_consistency: 0,
    sample_n: 0,
    window: currentEvaluationWindow(),
    computedAt: new Date().toISOString(),
  };
}

export function emptyRoiSnapshot(agentId: string): RoiSnapshot {
  return {
    agentId,
    cost_total: 0,
    value_total: 0,
    roi: 0,
    ipr: 0,
    srpc: 0,
    cps: 0,
    cost_perf_score: 0,
    roi_index: 0,
    roi_norm: 0,
    window: currentEvaluationWindow(),
  };
}
