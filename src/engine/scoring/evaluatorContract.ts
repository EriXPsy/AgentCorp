/**
 * src/engine/scoring/evaluatorContract.ts
 * Tier 2 Evaluator 契约的前端镜像（与后端 evaluator_protocol.py 一一对应）。
 *
 * 用途：
 * - 前端调用后端 JudgeRegistry 派发接口时，入参/出参的类型约束；
 * - CI 用 evaluatorContract.test.ts 强制保证与后端契约不漂移。
 *
 * 与后端 EvaluatorInput / EvaluatorOutput 字段对齐。
 */

import type { JobType } from "./registry";

/** 所有 Evaluator 的统一入参（与后端 EvaluatorInput 对齐）。 */
export interface EvaluatorInput {
  agentId: string;
  jobType: JobType;
  taskId?: string;
  answer?: string;
  radarScores?: Record<string, number>;
  craftScores?: Record<string, number>;
  requirement?: string;
  verifiedEvidence?: Record<string, string>;
  options?: Record<string, unknown>;
}

/** 所有 Evaluator 的统一产出（与后端 EvaluatorOutput 对齐）。 */
export interface EvaluatorOutput {
  evaluatorId: string;
  scores: Record<string, number>;
  verifiedEvidence: Record<string, string>;
  craftEvidence: Record<string, string>;
  confidence: number;
  reasoning: string;
  metadata?: Record<string, unknown>;
}

/** 已知 Evaluator ID（CI 强制：新增必在此登记）。 */
export const KNOWN_EVALUATOR_IDS = [
  "craft_judge",
  "arena_judge",
  "sandbox",
  "growth",
  "enterprise_fit",
] as const;

export type KnownEvaluatorId = (typeof KNOWN_EVALUATOR_IDS)[number];

/** 单个 Evaluator 的运行时遥测（与后端 _EvalStats 对齐）。 */
export interface EvaluatorStats {
  calls: number;
  errors: number;
  totalMs: number;
  avgMs: number;
  lastCallTs: number;
}

/** GET /api/registry/status 响应（与后端 JudgeRegistry.stats() 对齐）。 */
export interface RegistryStatus {
  evaluators: string[];
  stats: Record<string, EvaluatorStats>;
}
