/**
 * src/services/judgeEnsemble.ts
 * 裁判 ensemble（模块 C · 评估中心可靠性底座 增量）。
 *
 * 单次 chat-judge 噪声大（见 passK.ts 设计依据），故对同一条 transcript 重复裁判 k 次，
 * 再做聚合：
 * - aggregateRadars：逐维均值雷达（抑制单次抖动）；
 * - majorityVerdict：多数裁决 verdict（k 次里出现最多的判定）；
 * - 平均 confidence；
 * - passK：k 次重复的 pass^k 可靠性结论（核心差异化指标）。
 *
 * 跨家族扩展点：`models` 数组预留。当前后端 /api/chat-judge 契约仅接受
 * (agent_id, transcript)，未暴露 model 字段，故默认走"同模型重复采样"；
 * 后端支持逐模型调用后，可在 k 次循环里按 models 轮转实现跨家族交叉验证，
 * 无需改动调用方。
 *
 * 顺序交换去位置偏差：pairwise 比较（arena）的位置偏差在此单样本评分场景不显著，
 * 但 ensemble 的"重复采样 + 均值 + 多数裁决"本身即对位置/初始化的去偏。
 * 后续若接入 arenaCompareEnsemble，可在此追加 A/B 顺序交换分支。
 *
 * 全部为纯函数 + 一次异步编排；judgeChat 失败（离线/503）返回 null，由调用方降级。
 */
import type { BossProfile, RadarScore, Verdict } from '@/types/evaluation';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import { judgeChat, auditJudgeBias, type JudgeBiasAudit } from '@/services/judgeClient';
import { passK, type PassKResult } from '@/engine/evaluation/passK';
// 跨评委一致性（Krippendorff α）：k 次重复采样可视作 k 个「评委副本」，
// 用 α 度量它们对同一样本的评分一致性，作为离散度审计的补充（α 低 → 更值得人工复核）。
import { krippendorffAlphaMulti } from '@/engine/evaluation/ranking';

/** judge ensemble 选项 */
export interface JudgeEnsembleOptions {
  /** 重复运行次数（默认 3） */
  k?: number;
  /**
   * 跨家族模型列表（扩展点）。
   * 当前占位：后端未接受 model 字段，始终用同一裁判；后端支持后可逐模型调用。
   */
  models?: string[];
  /** 单维通过阈值（透传给 passK） */
  threshold?: number;
  /**
   * A · 老板原型（用户个性化）：透传给 judgeChat，使其在前缀注入「评估上下文」，
   * 实现 Wang 的个性化评估——同一 agent 对不同老板表现不同。
   */
  persona?: BossProfile | null;
  /**
   * B · 历史协作摘要：透传给 judgeChat，在前缀注入「历史协作」段落，
   * 使裁判能考察 agent 是否前后一致、是否记得此前约定。
   * 空/缺省 → 无状态评估（既有行为）。
   */
  history?: string[] | null;
}

/**
 * judge ensemble 的来源三态。
 * 此前只有 judge / degraded 两态，且「任一次真裁判」即记 judge，
 * 于是 1 次真 + 2 次回退也报 judge，高估了结论可信度。
 */
export type EnsembleSource = 'judge' | 'mixed' | 'degraded';

/** judge ensemble 结果 */
export interface JudgeEnsembleResult {
  /** judge = k 次全为真裁判；mixed = 真裁判与回退混合；degraded = 全部回退 */
  source: EnsembleSource;
  /** 有效运行中真正由外部裁判产出的次数（与 radars.length 对比即知混合比例） */
  judgeCount: number;
  /** 每次运行的雷达（已过滤掉 null） */
  radars: RadarScore[];
  /** 多次运行均值雷达 */
  meanRadar: RadarScore;
  /** 多数裁决 verdict */
  verdict: Verdict | null;
  /** 平均置信度（0–1） */
  confidence: number;
  /** pass^k 可靠性结论 */
  passK: PassKResult;
  /** 去重后的证据留痕 */
  evidence_trace: string[];
  /** 评委偏差审计（元评估）：k 次离散度；unstable 时结论置信已被下调 */
  biasAudit?: JudgeBiasAudit;
  /**
   * 跨评委一致性（Krippendorff α，-1..1）：
   * 把 k 次重复采样视为 k 个评委副本，度量评分矩阵的序数一致性。
   * α ≥ 0.67 可接受；< 0.41 不可用（Krippendorff 分级）。
   * 与 biasAudit（维度极差）互补：α 低而极差小时说明「整体偏移」而非「单维不稳」。
   */
  agreementAlpha?: number | null;
  /**
   * 本轮 k 次采样实际用到的裁判模型（去重，顺序即首次出现顺序）。
   * 长度 ≥2 说明真的做了跨家族交叉验证；长度 =1 说明只是同模型重复采样。
   * 必须如实回传：否则「不绑定单一模型家族」就是一句无法核对的声明。
   */
  models?: string[];
  /**
   * 是否构成统计意义上的重复测量：至少一次采样温度 >0，或用到 ≥2 个模型。
   * 全为温度 0 的同模型重复时，k 次输出逐字相同，pass^k 会退化为 pass^1 的复读。
   */
  realResampling?: boolean;
  /**
   * k 次采样各自收集到的裁判思维链（非空，去重保序）。
   * 供 metaJudge 做「推理-结论一致性」审计；未启用思考模式时为空/缺失。
   */
  reasoning?: string[];
}

/** 全零六维 */
function emptyRadar(): RadarScore {
  return { task: 0, quality: 0, comm: 0, creativity: 0, reliability: 0, cost: 0 };
}

/** 多个雷达逐维平均（纯函数，可单测） */
export function aggregateRadars(radars: RadarScore[]): RadarScore {
  const out = emptyRadar();
  const valid = radars.filter((r): r is RadarScore => Boolean(r) && typeof r === 'object');
  if (valid.length === 0) return out;
  for (const dim of RADAR_DIMS) {
    const sum = valid.reduce((acc, r) => acc + (r[dim] ?? 0), 0);
    out[dim] = Math.round((sum / valid.length) * 10) / 10;
  }
  return out;
}

/** 多数裁决（纯函数，可单测）：返回出现次数最多的 verdict；平票取首次出现 */
export function majorityVerdict(verdicts: (Verdict | null | undefined)[]): Verdict | null {
  const counts: Partial<Record<Verdict, number>> = {};
  for (const v of verdicts) {
    if (!v) continue;
    counts[v] = (counts[v] ?? 0) + 1;
  }
  let best: Verdict | null = null;
  let bestCount = 0;
  for (const v of Object.keys(counts) as Verdict[]) {
    const c = counts[v] ?? 0;
    if (c > bestCount) {
      bestCount = c;
      best = v;
    }
  }
  return best;
}

/**
 * B · 跨「同原型多 session」全对判定（纯函数，可单测）。
 * 可靠性 pass^k 升级为：同一 boss 原型下，agent 必须在**每一段独立会话**里都达标，
 * 才算「可靠」——避免把单次幸运达标当成稳健。任一段不过 → 不可靠。
 * 调用方应保证入参为 ≥2 段会话的判定；空数组按空真返回 true（由调用方把关）。
 */
export function allPassAcrossSessions(perSessionPass: boolean[]): boolean {
  if (perSessionPass.length === 0) return true;
  return perSessionPass.every(Boolean);
}

/**
 * 对同一条 transcript 重复调用裁判 k 次并聚合。
 *
 * @returns 聚合结果；k 次全部失败（无有效雷达）时返回 null（调用方降级处理）。
 */
export async function judgeChatEnsemble(
  agentId: string,
  transcript: string,
  opts?: JudgeEnsembleOptions,
): Promise<JudgeEnsembleResult | null> {
  const k = opts?.k ?? 3;
  const threshold = opts?.threshold ?? 3.5;

  const radars: RadarScore[] = [];
  const verdicts: (Verdict | null)[] = [];
  const confidences: number[] = [];
  const evidence: string[] = [];
  const models: string[] = [];
  const temperatures: number[] = [];
  const reasoning: string[] = [];
  let judgeCount = 0;

  for (let i = 0; i < k; i += 1) {
    // 每次重复用不同的 rubricVariant 旋转维度顺序，平均掉维度排列偏差（自洽扰动）
    const res = await judgeChat(agentId, transcript, opts?.persona, opts?.history, i).catch(
      () => null,
    );
    if (!res || !res.radar) continue;
    radars.push(res.radar);
    if (res.verdict) verdicts.push(res.verdict);
    if (typeof res.confidence === 'number') confidences.push(res.confidence);
    if (res.source === 'judge') judgeCount += 1;
    if (res.judgeModel && !models.includes(res.judgeModel)) models.push(res.judgeModel);
    if (typeof res.temperature === 'number') temperatures.push(res.temperature);
    if (Array.isArray(res.evidence_trace)) evidence.push(...res.evidence_trace);
    // 收集裁判思维链（去重保序），供 metaJudge 审计推理-结论一致性
    if (typeof res.reasoning === 'string' && res.reasoning.trim() && !reasoning.includes(res.reasoning)) {
      reasoning.push(res.reasoning);
    }
  }

  if (radars.length === 0) return null;

  const meanRadar = aggregateRadars(radars);
  const verdict = majorityVerdict(verdicts);
  const confidence = confidences.length
    ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
    : 0;

  // 元评估：审计 k 次离散度，离散度过高说明评委对该维不稳定，下调置信并提示人工复核
  const bias = auditJudgeBias(radars);
  // 跨评委一致性 α（k 次重复 = k 个评委副本）。
  // 矩阵朝向必须严格匹配 krippendorffAlphaMulti 契约（ranking.ts:44）：
  //   rows = 候选(N) = 6 个雷达维，cols = 评委(K) = k 次重复运行。
  // 故按维度投影：每个维度一行，该维在 k 次运行下的取值作为 k 个评委评分。
  // 转置错误（行=运行、列=维）会让稳定 agent 算出负 α，误触发人工复核。
  const agreementAlpha =
    radars.length >= 2
      ? krippendorffAlphaMulti(RADAR_DIMS.map((d) => radars.map((r) => r[d] ?? 0)))
      : null;
  let adjustedConfidence = confidence;
  let evidenceTrace = Array.from(new Set(evidence));
  if (bias.unstable) {
    adjustedConfidence = Math.round(confidence * 0.8 * 100) / 100;
    evidenceTrace = [
      ...evidenceTrace,
      `⚠️ 评委离散度偏高（maxSpread=${bias.maxSpread}）：结论置信已下调，建议人工复核或增采 k`,
    ];
  } else if (agreementAlpha !== null && agreementAlpha < 0.67) {
    adjustedConfidence = Math.round(confidence * 0.9 * 100) / 100;
    evidenceTrace = [
      ...evidenceTrace,
      `⚠️ 评委一致性偏低（Krippendorff α=${agreementAlpha} < 0.67）：存在整体偏移，置信已下调，建议人工复核`,
    ];
  }

  // 采样真实性自检：k 次若全是同模型、温度 0，输出必然逐字相同，
  // pass^k 与离散度审计都会失去统计意义。此时如实标注，不让「重复测量」名不副实。
  const realResampling = models.length > 1 || temperatures.some((t) => t > 0);
  if (radars.length > 1 && !realResampling) {
    evidenceTrace = [
      ...evidenceTrace,
      'ℹ️ 本轮为同模型、温度 0 的确定性重复：结论可复现，但不构成统计意义上的重复测量'
        + '（配置 JUDGE_ENSEMBLE_TEMPERATURE>0 或 JUDGE_MODELS 跨家族池可启用真实重采样）',
    ];
  }
  if (models.length > 1) {
    evidenceTrace = [
      ...evidenceTrace,
      `✓ 跨家族交叉验证：本轮由 ${models.length} 个不同裁判模型采样（${models.join(' / ')}）`,
    ];
  }

  const pk = passK(radars, { k: radars.length, threshold });

  const source: EnsembleSource =
    judgeCount === 0 ? 'degraded' : judgeCount === radars.length ? 'judge' : 'mixed';

  return {
    source,
    judgeCount,
    radars,
    meanRadar,
    verdict,
    confidence: adjustedConfidence,
    passK: pk,
    evidence_trace: evidenceTrace,
    biasAudit: bias,
    agreementAlpha,
    models,
    realResampling,
    reasoning: reasoning.length > 0 ? reasoning : undefined,
  };
}

export default judgeChatEnsemble;
