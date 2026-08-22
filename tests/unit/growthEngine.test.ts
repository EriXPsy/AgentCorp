/**
 * tests/unit/growthEngine.test.ts
 * 前端成长历程引擎 + 企业适配引擎单测。
 *
 * 覆盖：
 * - 线性回归斜率（完美线性 / 水平 / 下降 / 单点 / 空）
 * - 方向分类
 * - 成长阶段（rapid / steady / plateau / decline）
 * - 一致性计算
 * - 成长分范围
 * - 里程碑检测（first_mvp / breakthrough / streak / recovery）
 * - 短板识别
 * - 企业适配：完美匹配 / 差匹配 / 自定义需求 / 优势 / 建议排序
 * - 维度状态分类
 */
import { describe, it, expect } from 'vitest';
import {
  computeGrowthTrajectory,
  type GrowthTrajectory,
} from '@/engine/growth/growthEngine';
import {
  computeEnterpriseFit,
  type EnterpriseFitResult,
} from '@/engine/growth/enterpriseFit';
import type { RadarScore, StageScore } from '@/types/evaluation';

const DIMS = ['task', 'quality', 'comm', 'creativity', 'reliability', 'cost'] as const;

function makeRadar(values: number[]): RadarScore {
  const r: Record<string, number> = {};
  DIMS.forEach((d, i) => { r[d] = values[i]; });
  return r as unknown as RadarScore;
}

function makeStageScore(verdict: string, total: number, stage = 'preScreen'): StageScore {
  return {
    agentId: 'agent-x',
    stage: stage as StageScore['stage'],
    jobType: 'code',
    objective: [],
    subjective: { agentId: 'agent-x', stage, scores: {}, scoredBy: 'test', ts: '' },
    objectiveWeight: 0.6,
    subjectiveWeight: 0.4,
    objectiveScore: total,
    subjectiveScore: total,
    total,
    verdict: verdict as StageScore['verdict'],
    craftScores: { jobType: 'code', dims: {}, downweighted: [], evidence: {} },
    ts: new Date().toISOString(),
  };
}

// --------------------------------------------------------------------------
// 成长轨迹
// --------------------------------------------------------------------------
describe('computeGrowthTrajectory', () => {
  it('空历史 → 无趋势、无里程碑', () => {
    const t = computeGrowthTrajectory('a1', []);
    expect(t.totalEvaluations).toBe(0);
    expect(t.timeSpanLabel).toBe('尚无评估记录');
    expect(t.milestones).toHaveLength(0);
    // 全 0 分都是短板
    expect(t.skillGaps.length).toBeGreaterThan(0);
  });

  it('单次评估 → 有趋势但无斜率', () => {
    const t = computeGrowthTrajectory('a1', [makeRadar([3, 3.5, 4, 3.2, 3.8, 3.1])]);
    expect(t.totalEvaluations).toBe(1);
    expect(t.timeSpanLabel).toBe('1 次评估');
    for (const d of DIMS) {
      expect(t.trends[d].velocity).toBe(0);
    }
  });

  it('持续进步 → improving', () => {
    const history: RadarScore[] = [];
    for (let i = 0; i < 8; i++) {
      const v = Math.min(5, 2.5 + 0.25 * i);
      history.push(makeRadar([v, v, v, v, v, v]));
    }
    const t = computeGrowthTrajectory('a1', history);
    expect(t.overallVelocity).toBeGreaterThan(0);
    expect(['rapid', 'steady']).toContain(t.growthPhase);
    expect(t.growthScore).toBeGreaterThan(30);
  });

  it('持续退步 → decline', () => {
    const history: RadarScore[] = [];
    for (let i = 0; i < 6; i++) {
      const v = Math.max(0, 4.5 - 0.2 * i);
      history.push(makeRadar([v, v, v, v, v, v]));
    }
    const t = computeGrowthTrajectory('a1', history);
    expect(t.overallVelocity).toBeLessThan(0);
    expect(t.growthPhase).toBe('decline');
  });

  it('持平 → plateau', () => {
    const history: RadarScore[] = Array.from({ length: 5 }, () => makeRadar([3.5, 3.5, 3.5, 3.5, 3.5, 3.5]));
    const t = computeGrowthTrajectory('a1', history);
    expect(t.growthPhase).toBe('plateau');
  });

  it('成长分在 0–100', () => {
    const history: RadarScore[] = [];
    for (let i = 0; i < 5; i++) {
      history.push(makeRadar([3 + i * 0.2, 3, 3.5, 3.2, 3.8, 3.1]));
    }
    const t = computeGrowthTrajectory('a1', history);
    expect(t.growthScore).toBeGreaterThanOrEqual(0);
    expect(t.growthScore).toBeLessThanOrEqual(100);
  });
});

// --------------------------------------------------------------------------
// 里程碑
// --------------------------------------------------------------------------
describe('milestone detection', () => {
  it('首获 MVP', () => {
    const radar = [makeRadar([3, 3, 3, 3, 3, 3]), makeRadar([3.5, 3.5, 3.5, 3.5, 3.5, 3.5])];
    const stages = [makeStageScore('OBSERVE', 55), makeStageScore('MVP', 82, 'interview')];
    const t = computeGrowthTrajectory('a1', radar, stages);
    expect(t.milestones.some(m => m.kind === 'first_mvp')).toBe(true);
  });

  it('维度突破 4.0', () => {
    const radar = [
      makeRadar([3, 3, 3, 3, 3, 3]),
      makeRadar([3.2, 3, 3, 3, 3, 3]),
      makeRadar([4.5, 3, 3, 3, 3, 3]),
    ];
    const t = computeGrowthTrajectory('a1', radar);
    const bts = t.milestones.filter(m => m.kind === 'dimension_breakthrough');
    expect(bts).toHaveLength(1);
    expect(bts[0].dimension).toBe('task');
  });

  it('一致性连胜', () => {
    const radar = Array.from({ length: 5 }, (_, i) =>
      makeRadar([3 + i * 0.1, 3 + i * 0.1, 3, 3, 3, 3]),
    );
    const t = computeGrowthTrajectory('a1', radar);
    expect(t.milestones.some(m => m.kind === 'consistency_streak')).toBe(true);
  });

  it('低谷恢复', () => {
    const radar = [makeRadar([2, 2, 2, 2, 2, 2]), makeRadar([3, 3, 3, 3, 3, 3])];
    const stages = [makeStageScore('FIRED', 40), makeStageScore('OBSERVE', 60, 'interview')];
    const t = computeGrowthTrajectory('a1', radar, stages);
    expect(t.milestones.some(m => m.kind === 'recovery')).toBe(true);
  });
});

// --------------------------------------------------------------------------
// 短板
// --------------------------------------------------------------------------
describe('skill gaps', () => {
  it('低于阈值的维度进入短板', () => {
    const radar = [makeRadar([2, 4, 2.5, 3.5, 1.5, 3])];
    const t = computeGrowthTrajectory('a1', radar, [], 'code', 3.0);
    const gapDims = t.skillGaps.map(g => g.dim);
    expect(gapDims).toContain('task');
    expect(gapDims).toContain('comm');
    expect(gapDims).toContain('reliability');
    expect(gapDims).not.toContain('quality');
    expect(gapDims).not.toContain('creativity');
  });
});

// --------------------------------------------------------------------------
// 企业适配
// --------------------------------------------------------------------------
describe('computeEnterpriseFit', () => {
  const radar = (vals: number[]) => makeRadar(vals);
  const craft = (entries: Record<string, number>) => entries;

  it('完美匹配 → ready', () => {
    const r = computeEnterpriseFit(
      'a1', 'code',
      radar([5, 5, 5, 5, 5, 5]),
      craft({ code_runnability: 5, code_efficiency: 5, code_test_coverage: 5, code_maintainability: 5, code_security: 5 }),
    );
    expect(r.overallFit).toBeGreaterThanOrEqual(90);
    expect(r.readiness).toBe('ready');
  });

  it('差匹配 → not_ready', () => {
    const r = computeEnterpriseFit(
      'a1', 'code',
      radar([1, 1, 1, 1, 1, 1]),
      craft({ code_runnability: 1, code_efficiency: 1, code_test_coverage: 1, code_maintainability: 1, code_security: 1 }),
    );
    expect(r.overallFit).toBeLessThan(50);
    expect(r.readiness).toBe('not_ready');
  });

  it('自定义要求 → 低于要求维度报 below/critical', () => {
    const r = computeEnterpriseFit(
      'a1', 'text',
      radar([4, 3, 2, 3, 3.5, 3]),
      craft({ txt_factuality: 2, txt_coherence: 4, txt_tone_fit: 2.5, txt_info_density: 3.5, txt_instruction_follow: 3 }),
      undefined,
      undefined,
      { txt_factuality: 4.0, txt_tone_fit: 3.5 },
    );
    const ff = r.dimensionFits['txt_factuality'];
    expect(['below', 'critical']).toContain(ff.status);
    expect(ff.gap).toBeGreaterThan(0);
  });

  it('超标的维度进入 strengths', () => {
    const r = computeEnterpriseFit(
      'a1', 'text',
      radar([3, 3, 3, 3, 3, 3]),
      craft({ txt_factuality: 5, txt_coherence: 4.5, txt_tone_fit: 4, txt_info_density: 3.5, txt_instruction_follow: 3 }),
    );
    expect(r.strengths).toContain('txt_factuality');
  });

  it('建议按差距降序排列', () => {
    const r = computeEnterpriseFit(
      'a1', 'code',
      radar([2, 2, 2, 2, 2, 2]),
      craft({ code_runnability: 2, code_efficiency: 2, code_test_coverage: 2, code_maintainability: 2, code_security: 2 }),
    );
    if (r.recommendations.length >= 2) {
      for (let i = 0; i < r.recommendations.length - 1; i++) {
        const gapA = r.recommendations[i].targetScore - r.recommendations[i].currentScore;
        const gapB = r.recommendations[i + 1].targetScore - r.recommendations[i + 1].currentScore;
        expect(gapA).toBeGreaterThanOrEqual(gapB);
      }
    }
  });

  it('radar_fit 和 craft_fit 分别计算', () => {
    const r = computeEnterpriseFit(
      'a1', 'code',
      radar([4, 4, 4, 4, 4, 4]),
      craft({ code_runnability: 2, code_efficiency: 2, code_test_coverage: 2, code_maintainability: 2, code_security: 2 }),
    );
    expect(r.radarFit).toBeGreaterThan(r.craftFit);
  });

  it('维度状态分类', () => {
    // 通过 computeEnterpriseFit 间接测试
    const r = computeEnterpriseFit(
      'a1', 'code',
      radar([4.5, 3.5, 3, 2, 3.5, 3]),
      craft({ code_runnability: 4.5, code_efficiency: 3.5, code_test_coverage: 3, code_maintainability: 2, code_security: 3 }),
    );
    expect(r.dimensionFits['task'].status).toBe('exceeds');   // 4.5 - 3.5 = 1.0 ≥ 0.5
    expect(r.dimensionFits['quality'].status).toBe('meets');  // 3.5 - 3.5 = 0
    expect(r.dimensionFits['comm'].status).toBe('below');     // 3 - 3.5 = -0.5
    expect(r.dimensionFits['code_maintainability'].status).toBe('critical'); // 2 - 3.5 = -1.5
  });
});
