import type { EvaluationProfile, LifecycleState } from '@/types/evaluation';
import { save as evalSave, list as evalList } from '@/services/evaluationStore';
import {
  buildLifecycleUpdateProfile,
  buildMinimalLifecycleProfile,
  buildPatchedEvaluationProfile,
  indexEvaluationProfiles,
} from './evaluation-persistence';

/** 读取全部评估档案并投影成 store 友好的索引结构。 */
export async function loadIndexedEvaluationProfiles() {
  return indexEvaluationProfiles(await evalList());
}

/** 覆盖写单个评估档案。 */
export async function persistEvaluationProfile(profile: EvaluationProfile): Promise<EvaluationProfile> {
  await evalSave(profile);
  return profile;
}

/** 在现有档案上应用 patch 并持久化。 */
export async function persistPatchedEvaluationProfile(
  prev: EvaluationProfile,
  agentId: string,
  patch: Partial<EvaluationProfile>,
): Promise<EvaluationProfile> {
  const next = buildPatchedEvaluationProfile(prev, agentId, patch);
  await evalSave(next);
  return next;
}

/** 只更新生命周期；不存在档案时先补一个最小占位档案。 */
export async function persistLifecycleEvaluationProfile(
  agentId: string,
  lifecycle: LifecycleState,
  prev: EvaluationProfile | undefined,
): Promise<EvaluationProfile> {
  const next = prev
    ? buildLifecycleUpdateProfile(prev, lifecycle)
    : buildMinimalLifecycleProfile(agentId, lifecycle);
  await evalSave(next);
  return next;
}
