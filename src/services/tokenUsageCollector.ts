/**
 * src/services/tokenUsageCollector.ts
 * token 用量采集 + ROI 计算（Host API 客户端 + 纯函数）。
 *
 * 用量扫描已迁入主进程（electron/services/evaluation/eval-data.ts）；
 * collectBySession / collectByAgent 委托 Host API。
 * buildRoiSnapshot 为纯函数，保留在渲染层供编排 store 与单测直接使用。
 */
import { collectRunData } from '@/services/evaluationData';
import type { TokenUsageHistoryEntry } from '../../shared/token-usage';
import {
  computeRoi,
  DEFAULT_ROI_BASELINE,
  type CostInput,
  type ValueInput,
} from '@/engine/roiEngine';
import type { RoiSnapshot, TelemetryEvent } from '@/types/evaluation';

/** 当 usage 无 costUsd 时的兜底单价（美元 / 1k token） */
const NOMINAL_COST_PER_1K_TOKENS = 0.01;

/** 单 agent 的全部近期 token 用量 */
export async function collectByAgent(agentId: string): Promise<TokenUsageHistoryEntry[]> {
  const data = await collectRunData(agentId, '');
  return data.entries;
}

/** 单 session 的全部近期 token 用量 */
export async function collectBySession(sessionId: string): Promise<TokenUsageHistoryEntry[]> {
  const data = await collectRunData('', sessionId);
  return data.entries;
}

/**
 * 由真实 token 用量 + 遥测聚合出 RoiSnapshot。
 * 成本主线采用 usage 中的 costUsd（缺失时按 token 数兜底折算），
 * 价值主线由客观 KPI（任务完成率）× 单位效用基准推得。
 */
export function buildRoiSnapshot(
  entries: TokenUsageHistoryEntry[],
  telemetry: TelemetryEvent[],
  agentId: string,
  window: string,
  opts?: { radarCost?: number; population?: number[] },
): RoiSnapshot {
  const totalCost = entries.reduce(
    (sum, e) => sum + (e.costUsd ?? (e.totalTokens / 1000) * NOMINAL_COST_PER_1K_TOKENS),
    0,
  );
  const nSuccess = telemetry.filter((t) => t.success).length;
  const tcr = telemetry.length > 0 ? nSuccess / telemetry.length : 0;
  const rework = telemetry.reduce((sum, t) => sum + t.rework, 0);

  const cost: CostInput = {
    c_tok: totalCost,
    c_npu: 0,
    c_call: entries.length * 0.001,
    c_hum: 0,
    c_ret: rework * 0.001,
  };
  const value: ValueInput = {
    weight: { task: 1 },
    success: { task: tcr },
    U_base: 100,
    rho: 1,
    n_retry: rework,
    n_success: nSuccess,
    V_hum: 0,
  };

  const partial = computeRoi(cost, value, DEFAULT_ROI_BASELINE, {
    radarCost: opts?.radarCost,
    population: opts?.population,
  });

  return { agentId, window, ...partial };
}

/** 聚合导出（供 evaluation store 按约定名编排） */
export const tokenUsageCollector = {
  collectByAgent,
  collectBySession,
  buildRoiSnapshot,
};
