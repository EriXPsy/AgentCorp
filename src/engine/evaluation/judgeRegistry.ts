/**
 * src/engine/evaluation/judgeRegistry.ts
 * 统一评判器契约 + 注册表（M2 测量主干整合的核心收口点）
 * --------------------------------------------------------------------------
 * 「单一派发 + 统一 Evaluator 契约 + 单一规则源」三件套中的「契约 + 注册表」。
 *
 *  - 任何评估（能力评估 / 可靠性审计 / 评分 / 去偏 / 校准 / 排序）都实现 Evaluator。
 *  - 调用方只经 JudgeHub(judgeClient) 取 Evaluator，不直接 import 引擎文件——
 *    消除 src/services 下 14 个散落 judge/scoring 服务各自 import 的耦合。
 *  - 注册时强制 targetDims ⊆ RADAR_DIMS（单一规则源，维度不得漂移）。
 *  - PR#41 新增的 growth / enterpriseFit / arena 必须改写为 Evaluator 并在此注册，
 *    否则 listEvaluators() 不含它们，M2 契约测试（tests/contract/registry.test.ts）红。
 *
 * 零运行副作用：本文件只定义契约与注册表，**不预注册**任何 Evaluator——
 * 各模块在自身加载时用 registerEvaluator 登记，避免循环依赖与回归 PR#41。
 */
import type { RadarDim } from "../../types/evaluation";
import { RADAR_DIMS } from "../scoring/registry";
import { ContractViolation } from "../contracts";

export interface EvaluatorInput {
  agentId: string;
  transcript?: string;
  telemetry?: unknown[];
  usage?: unknown[];
  persona?: unknown;
  /** Evaluator 声明的目标维度（必须是 RADAR_DIMS 子集，注册时校验） */
  targetDims?: RadarDim[];
}

export interface EvaluatorResult {
  /** 落到六维雷达上的分数（Partial：允许 Evaluator 只贡献部分维度） */
  radar?: Partial<Record<RadarDim, number>> | null;
  verdict?: string;
  /** 0–1，供 EvalReport 区分可信/不可信 */
  confidence: number;
  evidence: string[];
  /** 派生来源：诚实标注，便于 EvalReport 区分「模型评判 / 客观 KPI / 转录弱信号 / 不可评」 */
  source: "judge" | "kpi" | "transcript" | "none";
}

export interface Evaluator {
  readonly id: string;
  readonly description: string;
  readonly targetDims?: RadarDim[];
  evaluate(input: EvaluatorInput): Promise<EvaluatorResult> | EvaluatorResult;
}

const REGISTRY = new Map<string, Evaluator>();

/** 任一 Evaluator 必须在此登记；未注册的引擎调用方无法经 JudgeHub 取到（M2 收口）。 */
export function registerEvaluator(e: Evaluator): void {
  if (REGISTRY.has(e.id)) {
    throw new ContractViolation(`Evaluator 重复注册：${e.id}`);
  }
  if (e.targetDims) {
    for (const d of e.targetDims) {
      if (!RADAR_DIMS.includes(d)) {
        throw new ContractViolation(
          `Evaluator ${e.id} 声明维度 "${d}" 不在单一规则源 RADAR_DIMS 中（维度漂移）`,
        );
      }
    }
  }
  REGISTRY.set(e.id, e);
}

export function getEvaluator(id: string): Evaluator | undefined {
  return REGISTRY.get(id);
}

export function listEvaluators(): Evaluator[] {
  return [...REGISTRY.values()];
}

export function hasEvaluator(id: string): boolean {
  return REGISTRY.has(id);
}
