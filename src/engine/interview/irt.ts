/**
 * src/engine/interview/irt.ts
 * 轻量 2PL IRT + Fisher 信息量 —— 用于「信息增益驱动」的追问选题。
 *
 * 设计哲学（对齐「熵收敛」产品内核）：
 *   面试不是「把每个维度问一遍」的清单遍历，而是**逐轮把模糊意图收敛成可验收路径**
 *   的熵削减过程。哪一轮问哪一维，应当由「再问一题能削减多少不确定性」决定，
 *   而不是由「还差几个维度没问到」的贪心覆盖驱动。
 *
 *   本模块用单维 2PL IRT 建模每个候选维度上的能力 θ：
 *     - 作答 → 后验分布（贝叶斯更新）
 *     - 后验熵 → 当前对该维能力的不确定性
 *     - 期望信息增益(EIG) → 若再问一题，预期能削减的熵
 *   选题时优先 EIG 最大的薄弱维：零证据维后验=先验（熵最大，自然最优先），
 *   已强证据维熵低、边际增益递减，自然靠后。
 *
 * 全部为纯函数、无副作用、无外部依赖，可直接单测。数值实现采用离散 θ 网格 +
 * 正态先验（EAP 估计），精度足以支撑「建议排序」这一 advisory 用途，不参与打分。
 *
 * 学术依据：
 * - 2PL IRT + EIG 选题属经典计算机自适应测试（CAT）内核（van der Linden & Glas），
 *   信息量最大化选题已被证明在题目数受限时最省题、估计最稳。
 * - CalibratedRubric（arXiv:2607.29252）：用 IRT 组装 task-adaptive rubric bank，
 *   「贝叶斯可测性过滤 + IRT 组装」提升人机一致性与排序保真度——与本模块的
 *   θ 估计 + EIG 选题同源，但其 rubric  bank 经过实证标定。
 * - 已知缺口：DEFAULT_ITEM_A=1.0 / DEFAULT_ITEM_B=0 为占位参数，尚未用真人面试
 *   数据标定区分度 a 与难度 b。EIG 在形式上正确，但 item 参数未校准会削弱选题
 *   最优性（参见 CalibratedRubric 的实证标定流程作为后续落地参照）。
 */

// ── 能力 θ 离散网格（标准正态区间，覆盖绝大多数能力估计）──────────────
export const THETA_MIN = -3;
export const THETA_MAX = 3;
export const THETA_STEP = 0.15;
/** 默认正态先验均值（能力无偏先验） */
export const PRIOR_MEAN = 0;
/** 默认正态先验标准差（宽先验：面试前对候选人能力几乎无信息） */
export const PRIOR_SD = 1.5;

/** 题默认参数：区分度 a 与难度 b。追问探针无标定 a/b 时统一采用。 */
export const DEFAULT_ITEM_A = 1.0;
export const DEFAULT_ITEM_B = 0;

/** 单条作答（二项 IRT：对/错） */
export interface IrtResponse {
  /** 作答是否正确（或是否「达标」：证据强度≥阈值 / HR 评分≥3） */
  correct: boolean;
  /** 题目区分度 a（>0） */
  a: number;
  /** 题目难度 b */
  b: number;
}

/** 生成 θ 网格 */
export function thetaGrid(opts?: {
  thetaMin?: number;
  thetaMax?: number;
  thetaStep?: number;
}): number[] {
  const min = opts?.thetaMin ?? THETA_MIN;
  const max = opts?.thetaMax ?? THETA_MAX;
  const step = opts?.thetaStep ?? THETA_STEP;
  const out: number[] = [];
  for (let t = min; t <= max + 1e-9; t += step) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}

/** 正态先验密度（未归一化；后续会归一化） */
function normalPdf(x: number, mean: number, sd: number): number {
  const z = (x - mean) / sd;
  return Math.exp(-0.5 * z * z);
}

/** 2PL 项目反应概率：P(正确 | θ) = 1 / (1 + exp(-a·(θ − b))) */
export function irt2pl(theta: number, a: number, b: number): number {
  return 1 / (1 + Math.exp(-a * (theta - b)));
}

/** 2PL Fisher 信息量：I(θ) = a² · P(θ) · (1 − P(θ))（在 P=0.5 即 θ=b 处最大） */
export function fisherInfo(theta: number, a: number, b: number): number {
  const p = irt2pl(theta, a, b);
  return a * a * p * (1 - p);
}

/** 在 θ 网格上构建正态先验（归一化） */
export function priorDistribution(opts?: {
  thetaGrid?: number[];
  priorMean?: number;
  priorSd?: number;
}): number[] {
  const grid = opts?.thetaGrid ?? thetaGrid();
  const mean = opts?.priorMean ?? PRIOR_MEAN;
  const sd = opts?.priorSd ?? PRIOR_SD;
  const raw = grid.map((t) => normalPdf(t, mean, sd));
  const sum = raw.reduce((acc, v) => acc + v, 0) || 1;
  return raw.map((v) => v / sum);
}

/**
 * 贝叶斯更新：给定先验与若干作答，返回后验分布（同网格，已归一化）。
 * 对数空间累乘以数值稳定，再归一化。
 */
export function bayesUpdate(
  prior: number[],
  grid: number[],
  responses: IrtResponse[],
): number[] {
  if (prior.length === 0) return [];
  const logPrior = prior.map((p) => Math.log(Math.max(p, 1e-12)));
  const posteriorLog = grid.map((_, i) => {
    let acc = logPrior[i];
    for (const r of responses) {
      const p = irt2pl(grid[i], r.a, r.b);
      const likelihood = r.correct ? p : 1 - p;
      acc += Math.log(Math.max(likelihood, 1e-12));
    }
    return acc;
  });
  const maxLog = Math.max(...posteriorLog);
  const exps = posteriorLog.map((v) => Math.exp(v - maxLog));
  const sum = exps.reduce((acc, v) => acc + v, 0) || 1;
  return exps.map((v) => v / sum);
}

/** 后验香农熵（nat）：熵越高 = 对该维能力越不确定 = 再问一题增益越大。 */
export function posteriorEntropy(posterior: number[]): number {
  let h = 0;
  for (const p of posterior) {
    if (p > 1e-12) h -= p * Math.log(p);
  }
  return h;
}

/** EAP 能力估计：后验在网格上的加权平均 θ。 */
export function eapAbility(posterior: number[], grid: number[]): number {
  if (posterior.length !== grid.length || posterior.length === 0) return PRIOR_MEAN;
  let sum = 0;
  for (let i = 0; i < grid.length; i++) sum += posterior[i] * grid[i];
  return sum;
}

/**
 * 期望信息增益(EIG)：对某维再问一题（探针项目 probe）后，预期能削减的后验熵。
 *
 *   EIG = H(当前后验) − [ P(对)·H(后验|对) + P(错)·H(后验|错) ]
 *
 * P(对) 用当前后验对探针项目的边际正确率估计。零作答（后验=先验、最不确定）
 * 时 EIG 最大；已强证据（后验集中）时 EIG 趋近 0——天然体现边际信息递减，
 * 正是「信息增益驱动」优于「覆盖度贪心」的核心。
 */
export function expectedInformationGain(
  responses: IrtResponse[],
  probe: { a: number; b: number },
  opts?: { thetaGrid?: number[]; priorMean?: number; priorSd?: number },
): number {
  const grid = opts?.thetaGrid ?? thetaGrid();
  const prior = priorDistribution({ thetaGrid: grid, priorMean: opts?.priorMean, priorSd: opts?.priorSd });
  const posterior = bayesUpdate(prior, grid, responses);
  const hBefore = posteriorEntropy(posterior);
  if (hBefore <= 1e-9) return 0; // 已完全确定，再问无增益

  // 边际正确率：后验对探针项目的期望 P(正确)
  let pCorrect = 0;
  for (let i = 0; i < grid.length; i++) pCorrect += posterior[i] * irt2pl(grid[i], probe.a, probe.b);
  pCorrect = Math.min(1, Math.max(0, pCorrect));

  const postGivenCorrect = bayesUpdate(prior, grid, [...responses, { correct: true, ...probe }]);
  const postGivenWrong = bayesUpdate(prior, grid, [...responses, { correct: false, ...probe }]);
  const hAfter = pCorrect * posteriorEntropy(postGivenCorrect) + (1 - pCorrect) * posteriorEntropy(postGivenWrong);

  return Math.max(0, hBefore - hAfter);
}

/**
 * 便捷入口：给定某维已积累的作答，返回其 EIG（探针难度自动置于该维当前 EAP 估计，
 * 即 θ=b 处 Fisher 信息最大）。用于选题排序。
 */
export function dimInformationGain(
  responses: IrtResponse[],
  opts?: { itemA?: number; priorMean?: number; priorSd?: number; thetaGrid?: number[] },
): number {
  const grid = opts?.thetaGrid ?? thetaGrid();
  const prior = priorDistribution({ thetaGrid: grid, priorMean: opts?.priorMean, priorSd: opts?.priorSd });
  const posterior = bayesUpdate(prior, grid, responses);
  const ability = eapAbility(posterior, grid);
  const a = opts?.itemA ?? DEFAULT_ITEM_A;
  return expectedInformationGain(responses, { a, b: ability }, { thetaGrid: grid, priorMean: opts?.priorMean, priorSd: opts?.priorSd });
}
