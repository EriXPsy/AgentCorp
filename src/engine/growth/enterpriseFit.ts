/**
 * src/engine/growth/enterpriseFit.ts
 * 企业适配引擎（前端纯函数镜像）。
 *
 * 设计原则：
 * - 纯函数、无副作用、无外部依赖
 * - 复用 RADAR_DIMS / JOB_CRAFT_DIMS，不新增维度
 * - 与后端 enterprise_fit.py 同构
 *
 * 论文依据：Competency Model (McClelland 1973)；
 * Persona-based Evaluation (Wang et al. 2025)。
 */

import type { RadarScore, JobType } from '@/types/evaluation';
import { RADAR_DIMS, JOB_CRAFT_DIMS } from '@/engine/scoring/registry';

// ----------------------------------------------------------------------
// 类型定义
// ----------------------------------------------------------------------
export interface DimensionFit {
  dim: string;
  actual: number;
  required: number;
  gap: number;
  status: 'exceeds' | 'meets' | 'below' | 'critical';
}

export interface TrainingRecommendation {
  dim: string;
  priority: number;
  currentScore: number;
  targetScore: number;
  reason: string;
  suggestedAction: string;
}

export interface EnterpriseFitResult {
  agentId: string;
  jobType: JobType;
  overallFit: number;
  readiness: 'ready' | 'developing' | 'not_ready';
  dimensionFits: Record<string, DimensionFit>;
  strengths: string[];
  recommendations: TrainingRecommendation[];
  radarFit: number;
  craftFit: number;
}

// ----------------------------------------------------------------------
// 纯函数
// ----------------------------------------------------------------------
function cosineSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  const keys = Object.keys(a).filter(k => k in b);
  if (keys.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const k of keys) {
    dot += a[k] * b[k];
  }
  for (const v of Object.values(a)) normA += v * v;
  for (const v of Object.values(b)) normB += v * v;
  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, Math.min(1, dot / (normA * normB)));
}

function dimStatus(actual: number, required: number): DimensionFit['status'] {
  const diff = actual - required;
  if (diff >= 0.5) return 'exceeds';
  if (diff >= 0) return 'meets';
  if (diff >= -1.0) return 'below';
  return 'critical';
}

function classifyReadiness(fit: number, criticalCount: number): EnterpriseFitResult['readiness'] {
  if (fit >= 75 && criticalCount === 0) return 'ready';
  if (fit >= 50 || criticalCount <= 1) return 'developing';
  return 'not_ready';
}

const ACTION_TEMPLATES: Record<string, string> = {
  task: '加强任务理解与规划能力：多做端到端任务分解练习',
  quality: '提升输出质量：注重细节打磨与交付标准',
  comm: '改善沟通表达：练习面向不同受众的清晰传达',
  creativity: '拓展创造性思维：尝试多种方案对比择优',
  reliability: '增强可靠性：加强边界条件处理与异常恢复',
  cost: '优化成本意识：减少冗余步骤、提升效率',
};

// ----------------------------------------------------------------------
// 主入口
// ----------------------------------------------------------------------
export function computeEnterpriseFit(
  agentId: string,
  jobType: JobType,
  radarScores: RadarScore,
  craftScores: Record<string, number>,
  enterpriseWeights?: Record<string, number>,
  radarRequirements?: Record<string, number>,
  craftRequirements?: Record<string, number>,
): EnterpriseFitResult {
  const craftDims = JOB_CRAFT_DIMS[jobType] ?? [];
  const radar = radarScores as unknown as Record<string, number>;

  // 1) 通用六维适配
  const radarFits: Record<string, DimensionFit> = {};
  for (const dim of RADAR_DIMS) {
    const actual = radar[dim] ?? 0;
    const required = radarRequirements?.[dim] ?? 3.5;
    radarFits[dim] = {
      dim,
      actual,
      required,
      gap: Math.round((required - actual) * 100) / 100,
      status: dimStatus(actual, required),
    };
  }

  // 2) craft 维适配
  const craftFits: Record<string, DimensionFit> = {};
  for (const dim of craftDims) {
    const actual = craftScores[dim] ?? 0;
    const required = craftRequirements?.[dim] ?? 3.5;
    craftFits[dim] = {
      dim,
      actual,
      required,
      gap: Math.round((required - actual) * 100) / 100,
      status: dimStatus(actual, required),
    };
  }

  const allFits = { ...radarFits, ...craftFits };

  // 3) 综合匹配分
  // 用「加权达标率」替代纯余弦相似度：余弦只看方向不看量级，
  // 全 1.0 向量和全 5.0 向量余弦=1.0，必须引入量级分量。
  // 公式：ratio = Σ(actual×w) / Σ(required×w)，再与达标率加权。
  const weights: Record<string, number> = {};
  for (const d of Object.keys(allFits)) {
    weights[d] = enterpriseWeights?.[d] ?? 1.0;
  }
  let wActual = 0;
  let wRequired = 0;
  for (const [d, f] of Object.entries(allFits)) {
    wActual += f.actual * (weights[d] ?? 1);
    wRequired += f.required * (weights[d] ?? 1);
  }
  const magnitudeRatio = wRequired > 0 ? Math.min(1, wActual / wRequired) : 0;

  const totalDims = Object.keys(allFits).length;
  const metCount = Object.values(allFits).filter(
    f => f.status === 'exceeds' || f.status === 'meets',
  ).length;
  const meetRate = totalDims > 0 ? metCount / totalDims : 0;
  const overallFit = Math.round((0.5 * magnitudeRatio + 0.3 * meetRate + 0.2 * cosineSimilarity(weights, Object.fromEntries(Object.entries(allFits).map(([d, f]) => [d, f.actual])))) * 1000) / 10;

  // 4) radar_fit & craft_fit 分离
  let radarWActual = 0;
  let radarWRequired = 0;
  for (const d of RADAR_DIMS) {
    const w = enterpriseWeights?.[d] ?? 1.0;
    radarWActual += (radar[d] ?? 0) * w;
    radarWRequired += (radarRequirements?.[d] ?? 3.5) * w;
  }
  const radarMagRatio = radarWRequired > 0 ? Math.min(1, radarWActual / radarWRequired) : 0;
  const radarMet = Object.values(radarFits).filter(
    f => f.status === 'exceeds' || f.status === 'meets',
  ).length;
  const radarFit = Math.round((0.5 * radarMagRatio + 0.3 * (radarMet / RADAR_DIMS.length) + 0.2 * cosineSimilarity(
    Object.fromEntries(RADAR_DIMS.map(d => [d, enterpriseWeights?.[d] ?? 1.0])),
    Object.fromEntries(RADAR_DIMS.map(d => [d, radar[d] ?? 0])),
  )) * 1000) / 10;

  let craftFit = 0;
  if (craftDims.length > 0) {
    let craftWActual = 0;
    let craftWRequired = 0;
    for (const d of craftDims) {
      const w = enterpriseWeights?.[d] ?? 1.0;
      craftWActual += (craftScores[d] ?? 0) * w;
      craftWRequired += (craftRequirements?.[d] ?? 3.5) * w;
    }
    const craftMagRatio = craftWRequired > 0 ? Math.min(1, craftWActual / craftWRequired) : 0;
    const craftMet = Object.values(craftFits).filter(
      f => f.status === 'exceeds' || f.status === 'meets',
    ).length;
    craftFit = Math.round((0.5 * craftMagRatio + 0.3 * (craftMet / craftDims.length) + 0.2 * cosineSimilarity(
      Object.fromEntries(craftDims.map(d => [d, enterpriseWeights?.[d] ?? 1.0])),
      Object.fromEntries(craftDims.map(d => [d, craftScores[d] ?? 0])),
    )) * 1000) / 10;
  }

  // 5) 优势维度
  const strengths = Object.entries(allFits)
    .filter(([, f]) => f.status === 'exceeds')
    .map(([d]) => d);

  // 6) 培训建议
  const weakDims = Object.entries(allFits)
    .filter(([, f]) => f.status === 'below' || f.status === 'critical')
    .sort((a, b) => b[1].gap - a[1].gap);

  const recommendations: TrainingRecommendation[] = weakDims.map(([dim, fit], idx) => ({
    dim,
    priority: idx + 1,
    currentScore: fit.actual,
    targetScore: fit.required,
    reason: `当前 ${fit.actual.toFixed(1)}，要求 ${fit.required.toFixed(1)}，差距 ${fit.gap.toFixed(1)}`,
    suggestedAction: ACTION_TEMPLATES[dim] ?? `加强 ${dim} 维度的专项训练`,
  }));

  // 7) 就绪度
  const criticalCount = Object.values(allFits).filter(f => f.status === 'critical').length;
  const readiness = classifyReadiness(overallFit, criticalCount);

  return {
    agentId,
    jobType,
    overallFit,
    readiness,
    dimensionFits: allFits,
    strengths,
    recommendations,
    radarFit,
    craftFit,
  };
}

export default computeEnterpriseFit;
