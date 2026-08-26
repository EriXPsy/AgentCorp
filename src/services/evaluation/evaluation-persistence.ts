import type {
  EvaluationProfile,
  LifecycleState,
} from '@/types/evaluation';
import { emptyKpiRecord, emptyRoiSnapshot, ZERO_RADAR } from './evaluation-projection';

export function indexEvaluationProfiles(profiles: EvaluationProfile[]): {
  profilesById: Record<string, EvaluationProfile>;
  lifecycleById: Record<string, LifecycleState>;
} {
  const profilesById: Record<string, EvaluationProfile> = {};
  const lifecycleById: Record<string, LifecycleState> = {};
  for (const profile of profiles) {
    profilesById[profile.agentId] = profile;
    lifecycleById[profile.agentId] = profile.lifecycle;
  }
  return { profilesById, lifecycleById };
}

export function buildPatchedEvaluationProfile(
  prev: EvaluationProfile,
  agentId: string,
  patch: Partial<EvaluationProfile>,
): EvaluationProfile {
  return {
    ...prev,
    ...patch,
    agentId,
    updatedAt: new Date().toISOString(),
  };
}

export function buildMinimalLifecycleProfile(
  agentId: string,
  lifecycle: LifecycleState,
): EvaluationProfile {
  return {
    agentId,
    radarLatest: { ...ZERO_RADAR },
    radarHistory: [],
    kpiLatest: emptyKpiRecord(agentId),
    kpiHistory: [],
    roiLatest: emptyRoiSnapshot(agentId),
    lifecycle,
    runIds: [],
    updatedAt: new Date().toISOString(),
  };
}

export function buildLifecycleUpdateProfile(
  prev: EvaluationProfile,
  lifecycle: LifecycleState,
): EvaluationProfile {
  return {
    ...prev,
    lifecycle,
    updatedAt: new Date().toISOString(),
  };
}
