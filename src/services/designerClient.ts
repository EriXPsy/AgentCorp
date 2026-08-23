/**
 * src/services/designerClient.ts
 * SPADE Designer 后端客户端：自适应出题 + 反思回写 + 记忆读取。
 *
 * 网络：经 Host API 代理（hostApiFetch → IPC → 127.0.0.1:3210 → model-service），
 * 与 craftClient / convergenceService 同一条链路。
 *
 * 三个端点：
 *   POST /api/designer/challenge — 基于 StyleMemory 自适应出题
 *   POST /api/designer/reflect   — 评估后触发反思，更新语义记忆
 *   GET  /api/designer/memory/:team_id — 读取完整 StyleMemory
 */
import { hostApiFetch } from '@/lib/host-api';
import type {
  ChallengeRequest,
  ChallengeResponse,
  ReflectRequest,
  ReflectResponse,
  StyleMemory,
} from '@/types/designer';

/** 请求 Designer 出题（基于团队 StyleMemory） */
export async function requestChallenge(req: ChallengeRequest): Promise<ChallengeResponse> {
  return hostApiFetch<ChallengeResponse>('/api/designer/challenge', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

/** 对团队提交进行反思，更新 StyleMemory */
export async function submitReflection(req: ReflectRequest): Promise<ReflectResponse> {
  return hostApiFetch<ReflectResponse>('/api/designer/reflect', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

/** 读取团队的完整 StyleMemory */
export async function loadMemory(teamId: string): Promise<StyleMemory> {
  return hostApiFetch<StyleMemory>(`/api/designer/memory/${encodeURIComponent(teamId)}`, {
    method: 'GET',
  });
}
