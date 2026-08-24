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
  AgentMemory,
  AgentReflectRequest,
  AgentReflectResponse,
  ChallengeRequest,
  ChallengeResponse,
  ReflectRequest,
  ReflectResponse,
  StyleMemory,
  TeamAgentsMemory,
  TeamGapResponse,
  TeamRadarResponse,
  PrescreenRequest,
  PrescreenResponse,
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

// ── Agent 级别 API ─────────────────────────────────────────────────

/** 对单个 Agent 提交进行反思，更新个人成长档案 */
export async function submitAgentReflection(req: AgentReflectRequest): Promise<AgentReflectResponse> {
  return hostApiFetch<AgentReflectResponse>('/api/designer/agent-reflect', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

/** 读取单个 Agent 的完整成长档案 */
export async function loadAgentMemory(agentId: string): Promise<AgentMemory> {
  return hostApiFetch<AgentMemory>(`/api/designer/agent-memory/${encodeURIComponent(agentId)}`, {
    method: 'GET',
  });
}

/** S1 初审：Designer LLM 对候选做六维适配评分 */
export async function requestPrescreen(req: PrescreenRequest): Promise<PrescreenResponse> {
  return hostApiFetch<PrescreenResponse>('/api/designer/prescreen', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

/** 读取团队六维雷达数据（移动平均） */
export async function fetchTeamRadar(teamId: string): Promise<TeamRadarResponse> {
  return hostApiFetch<TeamRadarResponse>(
    `/api/designer/team-radar/${encodeURIComponent(teamId)}`,
    { method: 'GET' },
  );
}

/** 分析团队能力缺口（用于主动招聘通知） */
export async function fetchTeamGaps(teamId: string): Promise<TeamGapResponse> {
  return hostApiFetch<TeamGapResponse>(
    `/api/designer/team-gaps/${encodeURIComponent(teamId)}`,
    { method: 'GET' },
  );
}

/** 读取一个团队下所有 Agent 的成长档案汇总 */
export async function loadTeamAgentsMemory(teamId: string): Promise<TeamAgentsMemory> {
  return hostApiFetch<TeamAgentsMemory>(
    `/api/designer/agent-memory/team/${encodeURIComponent(teamId)}`,
    { method: 'GET' },
  );
}
