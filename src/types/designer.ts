/**
 * src/types/designer.ts
 * SPADE Designer / StyleMemory 前端类型定义。
 *
 * 与后端 model-service/app/scoring/style_memory.py 的 StyleMemory dataclass
 * 和 designer_route.py 的请求/响应模型对齐。
 */

// ── StyleMemory（与后端 StyleMemory.to_dict() 对齐）──────────────────

export interface StyleMemory {
  team_id: string;
  observations: string[];
  current_understanding: string;
  next_challenge_hypothesis: string;
  challenges_issued: string[];
  performance_log: PerformanceEntry[];
  reflection_count: number;
  synthesize_every: number;
  evolved_reflection_system: string | null;
  evolved_hypothesis_system: string | null;
  reflection_quality_history: number[];
  hypothesis_accuracy_history: number[];
  hypothesis_history: string[];
  evolution_count: number;
  evolve_every: number;
}

export interface PerformanceEntry {
  task_id: string;
  outcome: string;
  scores: Record<string, number>;
  ts?: string;
}

// ── API 请求/响应 ─────────────────────────────────────────────────────

export interface ChallengeRequest {
  team_id: string;
  job_type?: string;
  description?: string;
  member_count?: number;
}

export interface ChallengeResponse {
  task_id: string;
  title: string;
  prompt: string;
  target_dims: string[];
  checkpoints: string[];
  difficulty: number;
  design_rationale: string;
}

export interface ReflectRequest {
  team_id: string;
  task_id: string;
  answer: string;
  scores: Record<string, number>;
  outcome: string;
}

export interface ReflectResponse {
  observation: string;
  reflection_count: number;
  current_understanding: string;
  next_hypothesis: string;
}

// ── Agent 级别成长档案 ─────────────────────────────────────────────

export interface AgentMemory {
  agent_id: string;
  team_id: string;
  observations: string[];
  performance_log: PerformanceEntry[];
  submission_count: number;
  pass_count: number;
  score_trajectory: Record<string, number[]>;
  growth_summary: string;
  strengths: string[];
  weaknesses: string[];
  pass_rate: number;
  avg_scores: Record<string, number>;
}

export interface AgentReflectRequest {
  agent_id: string;
  team_id: string;
  task_id: string;
  answer: string;
  scores: Record<string, number>;
  outcome: string;
}

export interface AgentReflectResponse {
  agent_id: string;
  observation: string;
  submission_count: number;
  pass_rate: number;
  strengths: string[];
  weaknesses: string[];
  growth_summary: string;
}

export interface PrescreenResponse {
  radar: Record<string, number>;
  confidence: number;
  fit_summary: string;
  strengths: string[];
  risks: string[];
  recommendation: 'hire' | 'maybe' | 'pass';
  degraded: boolean;
  degraded_reason: string;
}

export interface PrescreenRequest {
  candidate_name: string;
  candidate_description?: string;
  candidate_capabilities?: string[];
  team_id: string;
}

export interface TeamRadarResponse {
  team_id: string;
  dimensions: string[];
  team_scores: Record<string, number>;
  agent_scores: Record<string, Record<string, number>>;
  team_size: number;
  last_updated_submission: number;
}

export interface TeamGapResponse {
  team_id: string;
  gaps: string[];
  recommended_skills: string[];
  hiring_urgency: 'low' | 'medium' | 'high';
  hiring_reason: string;
  team_strengths: string[];
  team_size: number;
}

export interface TeamAgentsMemory {
  team_id: string;
  agents: Record<string, {
    submission_count: number;
    pass_rate: number;
    strengths: string[];
    weaknesses: string[];
    growth_summary: string;
  }>;
  count: number;
}
