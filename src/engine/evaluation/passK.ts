/**
 * src/engine/evaluation/passK.ts
 * pass^k 可靠性引擎（模块 C · 评估中心差异化核心）。
 *
 * 设计依据（来自 Pi Agent / 评测研究）：
 * - 单次打分噪声极大：Farquhar 等（Nature 630:625）指出「语义熵度量的是模型自信度，
 *   不是正确性」；τ-bench 实测 pass^1≈0.6 但 pass^8≈0.25——多跑几次，分数会显著掉。
 * - 因此以「同一（agent, 任务）样本重复裁判 k 次，每次都全维达标才算通过」取代单次打分，
 *   作为上岗/留用的可靠性门槛。
 *
 * 入参 `radars` = 同一样本的 k 次重复裁判雷达（每次一个 RadarScore）。
 * 输出：
 * - allPass：k 次全部「全维达阈值」→ 严格 pass^k 判定（可靠）。
 * - passRate：k 次里「单轮全维通过」的比例（松可靠性指标）。
 * - meanRadar：k 次逐维均值。
 * - dimPassRate：逐维通过率（定位「哪维不稳」）。
 *
 * 纯函数、无副作用、可单测。
 */
import type { RadarScore, RadarDim } from '@/types/evaluation';
import { RADAR_DIMS } from '@/engine/scoring/registry';

/** pass^k 选项 */
export interface PassKOptions {
  /** 单维通过阈值（0–5，默认 3.5：达到"良好"线） */
  threshold?: number;
  /**
   * 重复运行次数 k（默认取 radars.length）。
   * 调用方应保证传入 k 个重复样本；本参数仅用于回显与空样本的 k 值。
   */
  k?: number;
  /** 参与判定的维度（默认全部六维） */
  dims?: RadarDim[];
}

/**
 * 判定语义模式。同名字段在两种模式下含义不同，UI 必须读本字段决定怎么解释，
 * 不许靠字段名猜：
 * - 'repeat'（默认）：同一条 transcript 重复 k 次。allPass = k 次都全维达标；
 *   passRate = 全维达标的次数占比；dimPassRate = 该维在 k 次里达标的比例。
 * - 'sessions'：同一原型下 k 段独立会话各评一次。allPass = 每段都全维达标；
 *   passRate = 全过会话的占比；meanRadar/dimPassRate 基于「各段均值雷达」，
 *   已抹平单段内抖动，会系统性偏高，只可作定位参考，不可当稳定性结论。
 */
export type PassKMode = 'repeat' | 'sessions';

/** pass^k 结果 */
export interface PassKResult {
  /** 判定语义模式（决定下列字段如何解释） */
  mode: PassKMode;
  /** 重复运行次数（= 有效样本数） */
  k: number;
  /**
   * 严格 pass^k 判定：k 次运行是否全部「全维达阈值」。
   * true = 该样本可靠（上岗门槛达标的硬指标）。
   */
  allPass: boolean;
  /**
   * 单轮全维通过率（0–1）：k 次运行里有多少比例的单次是"全维达标"的。
   * 比 allPass 更柔，反映整体稳定性。
   */
  passRate: number;
  /** k 次运行雷达逐维均值（0–5） */
  meanRadar: RadarScore;
  /** 逐维通过率：该维度在多少次运行里达阈值（0–1） */
  dimPassRate: Record<RadarDim, number>;
  /** 有效样本数（= k） */
  sampleCount: number;
  /**
   * 本次 k 次裁判采样收集到的思维链（k 段非空推理拼接；无推理时 null）。
   * 仅加法：供评估页人工抽检时把「当前裁判响应的推理」透传给 metaJudge，
   * 做推理-结论一致性审计。来自 judgeChatEnsemble.reasoning（后端 /api/chat-judge 透传）。
   */
  reasoning?: string | null;
}

/** 全零六维（空样本/判空用） */
function emptyRadar(): RadarScore {
  return { task: 0, quality: 0, comm: 0, creativity: 0, reliability: 0, cost: 0 };
}

/** 单维是否达阈值 */
function dimPass(radar: RadarScore | null | undefined, dim: RadarDim, threshold: number): boolean {
  if (!radar) return false;
  const v = radar[dim];
  return typeof v === 'number' && v >= threshold;
}

/** 单次运行是否「全维通过」（所有参与维度都达阈值） */
export function isAllDimPass(radar: RadarScore | null | undefined, opts?: PassKOptions): boolean {
  const threshold = opts?.threshold ?? 3.5;
  const dims = opts?.dims ?? RADAR_DIMS;
  if (!radar) return false;
  return dims.every((d) => dimPass(radar, d, threshold));
}

/**
 * pass^k 主入口（纯函数）。
 *
 * @param radars 同一样本的 k 次重复裁判结果
 * @param opts 阈值 / k / 维度
 */
export function passK(radars: RadarScore[], opts?: PassKOptions): PassKResult {
  const threshold = opts?.threshold ?? 3.5;
  const dims = opts?.dims ?? RADAR_DIMS;
  const declaredK = opts?.k ?? radars.length;
  const runs = radars.filter((r): r is RadarScore => Boolean(r) && typeof r === 'object');

  if (runs.length === 0) {
    const zeroDim = dims.reduce((acc, d) => {
      acc[d] = 0;
      return acc;
    }, {} as Record<RadarDim, number>);
    return {
      mode: 'repeat',
      k: declaredK || 0,
      allPass: false,
      passRate: 0,
      meanRadar: emptyRadar(),
      dimPassRate: zeroDim,
      sampleCount: 0,
    };
  }

  // 均值雷达（逐维平均）
  const meanRadar = emptyRadar();
  for (const dim of dims) {
    const sum = runs.reduce((acc, r) => acc + (r[dim] ?? 0), 0);
    meanRadar[dim] = Math.round((sum / runs.length) * 10) / 10;
  }

  // 逐维通过率
  const dimPassRate = {} as Record<RadarDim, number>;
  for (const dim of dims) {
    const passed = runs.filter((r) => dimPass(r, dim, threshold)).length;
    dimPassRate[dim] = Math.round((passed / runs.length) * 100) / 100;
  }

  // 单轮全维通过比例
  const roundPasses = runs.filter((r) => isAllDimPass(r, opts)).length;
  const passRate = Math.round((roundPasses / runs.length) * 100) / 100;

  return {
    mode: 'repeat',
    k: runs.length,
    allPass: roundPasses === runs.length,
    passRate,
    meanRadar,
    dimPassRate,
    sampleCount: runs.length,
  };
}

export default passK;
