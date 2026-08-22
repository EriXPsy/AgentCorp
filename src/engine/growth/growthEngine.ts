/**
 * src/engine/growth/growthEngine.ts
 * 员工成长历程引擎（前端纯函数镜像）。
 *
 * 设计原则：
 * - 纯函数、无副作用、无外部依赖（只用 Math）
 * - 只消费 EvaluationProfile.radarHistory / stageScores，不发网络
 * - 与后端 model-service/app/scoring/growth.py 同构，但独立运行（纯 TS）
 * - 计算成长速度、成长阶段、里程碑、短板、综合成长分
 *
 * 论文依据：HELM (Liang et al. 2022) — 纵向多维度评估；
 * 成长型思维在 Agent 评测中的迁移。
 */

import type { RadarScore, StageScore, JobType } from '@/types/evaluation';
import { RADAR_DIMS } from '@/engine/scoring/registry';

// ----------------------------------------------------------------------
// 类型定义
// ----------------------------------------------------------------------
export interface DimensionTrend {
  dim: string;
  values: number[];
  velocity: number;
  direction: 'improving' | 'declining' | 'stable';
  peak: number;
  current: number;
  delta: number;
}

export interface GrowthMilestone {
  kind: 'first_mvp' | 'dimension_breakthrough' | 'consistency_streak' | 'recovery';
  dimension: string | null;
  description: string;
  scoreBefore: number;
  scoreAfter: number;
}

export interface SkillGap {
  dim: string;
  current: number;
  threshold: number;
  gap: number;
  weight: number;
}

export interface GrowthTrajectory {
  agentId: string;
  totalEvaluations: number;
  timeSpanLabel: string;
  trends: Record<string, DimensionTrend>;
  overallVelocity: number;
  growthPhase: 'rapid' | 'steady' | 'plateau' | 'decline';
  growthScore: number;
  milestones: GrowthMilestone[];
  strengths: string[];
  weaknesses: string[];
  skillGaps: SkillGap[];
}

// ----------------------------------------------------------------------
// 纯函数：最小二乘线性回归
// ----------------------------------------------------------------------
function linregSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function classifyDirection(velocity: number, threshold = 0.05): DimensionTrend['direction'] {
  if (velocity > threshold) return 'improving';
  if (velocity < -threshold) return 'declining';
  return 'stable';
}

function computeConsistency(values: number[]): number {
  if (values.length < 3) return 0.5;
  const diffs: number[] = [];
  for (let i = 1; i < values.length; i++) {
    diffs.push(Math.abs(values[i] - values[i - 1]));
  }
  const meanDiff = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  return Math.max(0, Math.min(1, 1 - meanDiff));
}

function classifyPhase(velocity: number, consistency: number): GrowthTrajectory['growthPhase'] {
  if (velocity > 0.15 && consistency > 0.5) return 'rapid';
  if (velocity > 0.05 && consistency > 0.3) return 'steady';
  if (velocity < -0.05) return 'decline';
  return 'plateau';
}

function growthScore(velocity: number, consistency: number, peakAvg: number): number {
  const vComp = Math.min(1, Math.max(0, velocity / 0.5));
  const lComp = Math.min(1, Math.max(0, peakAvg / 5));
  const cComp = consistency;
  const raw = 40 * vComp + 30 * lComp + 30 * cComp;
  return Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10;
}

// ----------------------------------------------------------------------
// 里程碑检测
// ----------------------------------------------------------------------
function detectMilestones(
  radarHistory: RadarScore[],
  stageScores: StageScore[],
): GrowthMilestone[] {
  const milestones: GrowthMilestone[] = [];

  // 1) 首获 MVP
  for (let i = 0; i < stageScores.length; i++) {
    if (stageScores[i].verdict === 'MVP') {
      const isFirst = stageScores.slice(0, i).every(s => s.verdict !== 'MVP');
      milestones.push({
        kind: isFirst ? 'first_mvp' : 'first_mvp',
        dimension: null,
        description: `阶段 ${stageScores[i].stage} 获评 MVP（总分 ${stageScores[i].total.toFixed(1)}）`,
        scoreBefore: 0,
        scoreAfter: stageScores[i].total,
      });
      break;
    }
  }

  // 2) 维度突破 4.0
  if (radarHistory.length >= 2) {
    const first = radarHistory[0];
    const last = radarHistory[radarHistory.length - 1];
    for (const dim of RADAR_DIMS) {
      const prev = (first as unknown as Record<string, number>)[dim] ?? 0;
      const curr = (last as unknown as Record<string, number>)[dim] ?? 0;
      if (prev < 4.0 && curr >= 4.0) {
        milestones.push({
          kind: 'dimension_breakthrough',
          dimension: dim,
          description: `维度 ${dim} 突破 4.0（${prev.toFixed(1)} → ${curr.toFixed(1)}）`,
          scoreBefore: prev,
          scoreAfter: curr,
        });
      }
    }
  }

  // 3) 一致性连胜
  if (radarHistory.length >= 3) {
    let streak = 0;
    let maxStreak = 0;
    for (let i = 1; i < radarHistory.length; i++) {
      const prevAvg = RADAR_DIMS.reduce(
        (s, d) => s + ((radarHistory[i - 1] as unknown as Record<string, number>)[d] ?? 0),
        0,
      ) / RADAR_DIMS.length;
      const currAvg = RADAR_DIMS.reduce(
        (s, d) => s + ((radarHistory[i] as unknown as Record<string, number>)[d] ?? 0),
        0,
      ) / RADAR_DIMS.length;
      if (currAvg >= prevAvg) {
        streak++;
        maxStreak = Math.max(maxStreak, streak);
      } else {
        streak = 0;
      }
    }
    if (maxStreak >= 3) {
      milestones.push({
        kind: 'consistency_streak',
        dimension: null,
        description: `连续 ${maxStreak} 次评估无退步`,
        scoreBefore: 0,
        scoreAfter: 0,
      });
    }
  }

  // 4) 低谷恢复
  for (let i = 1; i < stageScores.length; i++) {
    if (stageScores[i - 1].verdict === 'FIRED' && stageScores[i].verdict !== 'FIRED') {
      milestones.push({
        kind: 'recovery',
        dimension: null,
        description: `从 FIRED 恢复到 ${stageScores[i].verdict}`,
        scoreBefore: stageScores[i - 1].total,
        scoreAfter: stageScores[i].total,
      });
    }
  }

  return milestones;
}

// ----------------------------------------------------------------------
// 主入口
// ----------------------------------------------------------------------
export function computeGrowthTrajectory(
  agentId: string,
  radarHistory: RadarScore[],
  stageScores: StageScore[] = [],
  _jobType: JobType = 'code',
  gapThreshold = 3.0,
): GrowthTrajectory {
  const n = radarHistory.length;

  // 1) 每维度趋势
  const trends: Record<string, DimensionTrend> = {};
  const allCurrents: number[] = [];
  const allVelocities: number[] = [];

  for (const dim of RADAR_DIMS) {
    const values = radarHistory.map(rh => (rh as unknown as Record<string, number>)[dim] ?? 0);
    const velocity = Math.round(linregSlope(values) * 10000) / 10000;
    const direction = classifyDirection(velocity);
    const peak = values.length > 0 ? Math.max(...values) : 0;
    const current = values.length > 0 ? values[values.length - 1] : 0;
    const delta = values.length >= 2 ? Math.round((current - values[0]) * 100) / 100 : 0;
    trends[dim] = { dim, values, velocity, direction, peak, current, delta };
    if (values.length > 0) {
      allCurrents.push(current);
      allVelocities.push(velocity);
    }
  }

  // 2) 整体速度 & 一致性
  const overallVelocity =
    allVelocities.length > 0
      ? Math.round((allVelocities.reduce((s, v) => s + v, 0) / allVelocities.length) * 10000) / 10000
      : 0;

  const consistencies = RADAR_DIMS.map(d => computeConsistency(trends[d].values));
  const avgConsistency =
    consistencies.length > 0
      ? Math.round((consistencies.reduce((s, c) => s + c, 0) / consistencies.length) * 10000) / 10000
      : 0.5;

  // 3) 成长阶段
  const growthPhase = classifyPhase(overallVelocity, avgConsistency);

  // 4) 成长分
  const peakAvg =
    Object.values(trends).length > 0
      ? Object.values(trends).reduce((s, t) => s + t.peak, 0) / Object.values(trends).length
      : 0;
  const gScore = growthScore(overallVelocity, avgConsistency, peakAvg);

  // 5) 里程碑
  const milestones = detectMilestones(radarHistory, stageScores);

  // 6) 优势/弱势维度
  const sorted = Object.values(trends).sort((a, b) => b.current - a.current);
  const strengths = sorted.filter(t => t.current > 0).slice(0, 3).map(t => t.dim);
  const weaknesses = sorted
    .filter(t => t.current > 0)
    .slice(-3)
    .reverse()
    .map(t => t.dim);

  // 7) 短板
  const defaultWeight = 1 / RADAR_DIMS.length;
  const skillGaps: SkillGap[] = [];
  for (const dim of RADAR_DIMS) {
    const current = trends[dim].current;
    if (current < gapThreshold) {
      skillGaps.push({
        dim,
        current,
        threshold: gapThreshold,
        gap: Math.round((gapThreshold - current) * 100) / 100,
        weight: defaultWeight,
      });
    }
  }
  skillGaps.sort((a, b) => b.gap * b.weight - a.gap * a.weight);

  // 人文标签
  let timeSpanLabel: string;
  if (n === 0) timeSpanLabel = '尚无评估记录';
  else if (n === 1) timeSpanLabel = '1 次评估';
  else timeSpanLabel = `${n} 次评估`;

  return {
    agentId,
    totalEvaluations: n,
    timeSpanLabel,
    trends,
    overallVelocity,
    growthPhase,
    growthScore: gScore,
    milestones,
    strengths,
    weaknesses,
    skillGaps,
  };
}

export default computeGrowthTrajectory;
