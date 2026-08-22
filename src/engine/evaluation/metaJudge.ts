/**
 * src/engine/evaluation/metaJudge.ts
 * 评委元评估引擎。
 *
 * 设计来源：
 * - JudgeBench（arXiv:2410.12784）：用「客观正确性子集」检验 LLM 评委是否与事实/人类一致，
 *   发现 GPT-4o 类评委在事实/逻辑正确性上仅略高于随机——评委本身需要被监管。
 * - CALM（arXiv:2410.02736）：一致性率 CR、鲁棒性率 RR 作为评委偏差的量化指标。
 * - ：新增 metaJudge 定期用客观正确性子集检验评委，监控评委漂移。
 * - Judging with Many Minds（arXiv:2505.19477）：多视角反而可能放大偏见（debate
 *   倾向强化既有偏差），而独立的 meta-judge 层对偏见更具抵抗力——这正是本模块
 *   采用「第三方元评估」而非「让评委互辩」的原因。
 * - Meta-Judge Meta-Judges（arXiv:2504.17087）：多 agent 协作给 LLM 评委打分，
 *   用明确 rubric 替代单评委，去单点偏差（实测 ~15.55% 改进）。本模块的逐维诊断
 *   与可配置阈值是该思路在「纯函数、零 LLM 调用」约束下的落地。
 *
 * 本模块回答四个问题（对应四种诊断粒度）：
 * 1. 这个评委总体上准不准？      → 与基准答案（gold）的一致性（accuracy / Krippendorff α）
 * 2. 这个评委最近有没有漂移？    → 滑动窗口上一致性趋势（旧窗口 vs 新窗口）
 * 3. 这个评委在哪些维度/题型上弱？→ 按维度分组的逐维一致性
 * 4. 评委的推理链和它自己的结论矛盾吗？→ 推理-结论一致性（启发式，仅对有思维链的样本）
 *
 * 设计约束（对齐项目架构铁律）：
 * - 纯函数、无副作用、无外部依赖，可直接单测；
 * - 不调用任何 LLM——输入是「评委输出 vs 基准答案」的已收集样本；
 * - 判定阈值全部可配置，默认值有文献依据（α ≥ 0.67 视为可接受，< 0.41 视为不可用，
 *   取自 Krippendorff 2004 的既有信度分级）。
 *
 * 用法（建议接入点）：
 * - 评估中心每次产终评后，把「评委输出 vs 人工复核」样本喂给 metaJudge.assess；
 * - 周期性（如每 50 个样本）调用 driftCheck 看评委是否漂移；
 * - 阈值不达标时，UI 应提示「评委需校准/更换」，并把该评委标记为低置信。
 */

/** 单条元评估样本：一个客观正确性基准题（gold），评委给出的判断。 */
export interface MetaJudgeSample {
  /** 样本 id（去重/审计用） */
  id: string;
  /** 被检验的评委模型标识（如 'minicpm-o-4.5' / 'gpt-4o'） */
  judgeId: string;
  /** 客观正确性基准（gold 标准）——由人工或事实校验给出 */
  gold: boolean;
  /** 评委对该题给出的判断（正确 / 不正确） */
  judgeVerdict: boolean;
  /** 评委给出的置信度（0–1，可选，用于置信校准分析） */
  confidence?: number | null;
  /** 题型/维度标签（如 'factuality' | 'logic' | 'quality'），用于逐维诊断 */
  dim?: string | null;
  /** 采样时间戳（ISO8601，漂移检测用） */
  ts?: string | null;
  /** 裁判给出该结论时的思维链 / 推理文本（可选，供推理-结论一致性审计） */
  reasoning?: string | null;
}

/** 二值一致性分类结果 */
export interface BinaryAgreement {
  /** 样本数 */
  n: number;
  /** 一致数（评委判断 == gold） */
  agree: number;
  /** 一致率（accuracy，0–1） */
  accuracy: number;
}

/** 按维度分组的诊断 */
export interface DimDiagnosis {
  dim: string;
  n: number;
  accuracy: number;
  /** 该维是否达到可接受阈值（默认 0.67） */
  acceptable: boolean;
}

/**
 * 第四种诊断：推理-结论一致性（启发式）。
 *
 * 背景：LLM 评委可能「推理链在挑刺、结论却放行」或反过来——思维链与最终判定自相矛盾。
 * 这里不做语义理解（本模块铁律：零 LLM 调用），只用关键词极性粗判：
 *   - 推理文本里负向词（未兑现/偏离/不可运行/错误…）占优，但裁判结论是「可用」
 *     → 推理与结论矛盾；
 *   - 正向词（正确/兑现/满足…）占优，但裁判结论是「不可用」
 *     → 同样矛盾。
 *
 * ⚠️ 明确是启发式：中文一词多义、否定前缀（不符合 vs 符合）会导致误判，
 * 故置信度上限压到 0.6 左右，且 verdict 只分「一致/矛盾/样本不足」三档，
 * 永远不假装精确。样本不足时返回 'insufficient'，绝不凑数。
 */
export interface ReasoningConsistency {
  /** 带 reasoning 文本的样本数 */
  withReasoning: number;
  /** 能解析出明确情感倾向的样本数（中性/空不计入） */
  analyzable: number;
  /** 推理倾向与裁判结论（judgeVerdict）矛盾的样本数 */
  vsVerdictContradictory: number;
  /** 推理倾向与裁判结论一致的样本数 */
  vsVerdictConsistent: number;
  /** 推理倾向与人工基准（gold）矛盾的样本数 */
  vsGoldContradictory: number;
  /** 推理倾向与人工基准一致的样本数 */
  vsGoldConsistent: number;
  /** 启发式结论（样本不足时给 'insufficient'，不凑结论） */
  verdict: 'consistent' | 'contradictory' | 'insufficient';
  /** 矛盾占比（0–1，可解析样本内）；无样本时为 null */
  contradictionRate: number | null;
  /** 启发式置信度（0–1，上限约 0.6，明确低置信） */
  confidence: number;
  /** 人读说明 */
  note: string;
}

/**
 * 负向关键词（命中即倾向「评委认为有问题」）。
 * 先放带否定前缀的复合词（不符合/未达标…），避免被后续正向词「符合/达标」重复命中。
 * 注意：必须把「正向词的否定形式」也列在这里（如 未达标 含 达标），
 * 否则 strip 阶段漏掉它们，正向子串会被误计为正向，导致「未达标」被判成 positive。
 */
const NEGATIVE_REASONING_CUES: readonly string[] = [
  // ── 直接负向短语 ──
  // ⚠️ 注意：不要添加含「错误」子串的复合词（如「出现错误」「存在错误」），
  // 因为「错误」本身已是独立 cue，复合词会导致双重计数（neg 虚高），
  // 在「不会出现错误，但结果准确」这类危险逆否句中把 positive 误判为 neutral。
  '不符合', '不满足', '未满足', '未符合', '未兑现', '未完成', '未实现', '未达成',
  '未达标', '不达标', '未对齐', '不一致', '不准确', '不可行', '不可运行', '无法运行',
  '不能运行', '运行失败', '报错', '有误', '不正确', '错误', '失败', '有缺陷', '存在缺陷',
  '有漏洞', '未通过', '不可靠', '不靠谱', '有问题', '有 bug',
  '有bug', '未跑通', '跑不通', '未生效', '不生效',
  // ── 否定前缀 + 正向词（deny-list 必须穷举这些 4 字组合，否则否定窗口只能否决
  //    正向计数但无法产生负向计数，导致「未能实现」被判为 neutral 而非 negative） ──
  '未能实现', '未能完成', '未能达成', '未能通过', '未能跑通', '未能兑现',
  '不能实现', '不能完成', '不能达到', '不能满足', '不能符合', '不能兑现',
  '没实现', '没完成', '没达到', '没满足', '没通过', '没跑通', '没兑现',
];

/** 正向关键词（命中即倾向「评委认为达标」） */
const POSITIVE_REASONING_CUES: readonly string[] = [
  '兑现', '满足', '符合', '达成', '完成', '实现', '通过', '准确', '良好', '优秀',
  '达标', '可行', '可靠', '没问题', '无误', '一致', '对齐', '正确', '达到要求', '认可',
];

/**
 * 否定字符集合：当这些字符紧邻出现在某个正向词之前时，该正向词是被否定的
 * （如「未实现」「不能满足」），不应计入正向命中。
 *
 * ⚠️ 关键设计：deny-list（NEGATIVE_REASONING_CUES）只覆盖「能与正向词拼成连续负向短语」的
 * 常见组合（未实现/不能完成…），而中文否定前缀「未/不/没」可搭配任意正向词（未能兑现、
 * 不能达到、没满足……）无法穷举。故在 deny-list 挖空之后，再对剩余的正向词做一次
 * 「否定字符邻接」否决（negation window），补上 deny-list 未枚举的组合。
 */
const NEGATION_PREFIX_CHARS: ReadonlySet<string> = new Set(['不', '未', '没', '非', '无', '勿', '别']);

/** 否定窗口（字符数）：正向词前 WIN 个字符内若出现否定字符，则该正向词被否决。 */
const NEGATION_WINDOW = 2;

/**
 * 统计关键词在文本中的非重叠命中次数（纯函数）。
 */
function countCues(text: string, cues: readonly string[]): number {
  let count = 0;
  for (const cue of cues) {
    let idx = text.indexOf(cue);
    while (idx !== -1) {
      count += 1;
      idx = text.indexOf(cue, idx + cue.length);
    }
  }
  return count;
}

/**
 * 统计正向关键词命中数，但否决「紧邻否定字符」的正向词（纯函数）。
 * 先由调用方把负向短语挖空，再对剩余正向词做否定邻接否决。
 */
function countPositiveCues(stripped: string, cues: readonly string[]): number {
  let count = 0;
  for (const cue of cues) {
    let idx = stripped.indexOf(cue);
    while (idx !== -1) {
      // 回看 WIN 个字符：只要其中有一个否定字符，该正向词即被否定（如「未[能]实现」中
      // deny-list 挖掉「未实现」后「能」仍在、「实现」被「能」否决；「未能兑现」里
      // 「未」在「兑现」前 2 格内 → 否决）。无否定邻接才计入正向。
      let vetoed = false;
      for (let k = 1; k <= NEGATION_WINDOW; k++) {
        if (idx - k >= 0 && NEGATION_PREFIX_CHARS.has(stripped[idx - k])) {
          vetoed = true;
          break;
        }
      }
      if (!vetoed) count += 1;
      idx = stripped.indexOf(cue, idx + cue.length);
    }
  }
  return count;
}

/**
 * 推理文本情感极性（纯函数，可单测）。
 * 先数负向命中并把这些片段挖空，再数正向命中（带否定邻接否决），按数量定极性；
 * 正负都为 0 → neutral（无法解析，不计入可分析样本）。
 *
 * 已知启发式边界（诚实声明，非缺陷）：
 * - 跨子句的远距否定（如「整体不错，但第三章存在错误」）不会被否定窗口捕获，
 *   因为「错误」与前面的正向词被标点/多字隔开，超出 WIN=2；此类按各 cue 独立计数。
 * - 双重否定（「未能跑通，不能达标」）语义模糊，按字面负向 cue 多数判定。
 * 置信度上限由 assessReasoningConsistency 压到 ≤0.6，verdict 只分三档，绝不假装精确。
 */
export function reasoningPolarity(text: string): 'positive' | 'negative' | 'neutral' {
  const lower = text.toLowerCase();
  const neg = countCues(lower, NEGATIVE_REASONING_CUES);
  // 挖掉负向短语，避免其内部的正向子串（如「不符合」里的「符合」）被重复计入
  let stripped = lower;
  for (const cue of NEGATIVE_REASONING_CUES) {
    stripped = stripped.split(cue).join(' '.repeat(cue.length));
  }
  const pos = countPositiveCues(stripped, POSITIVE_REASONING_CUES);
  if (neg === 0 && pos === 0) return 'neutral';
  if (neg > pos) return 'negative';
  if (pos > neg) return 'positive';
  return 'neutral';
}

/** 推理-结论一致性诊断所需的最少可解析样本数（不足则判 insufficient，不凑数） */
const MIN_ANALYZABLE_REASONING = 3;

/**
 * 第四种诊断：推理-结论一致性（纯函数、启发式、零 LLM）。
 * 仅对有 reasoning 且能解析出极性的样本做判断；样本不足时返回 insufficient。
 */
export function assessReasoningConsistency(
  samples: MetaJudgeSample[],
): ReasoningConsistency {
  const withReasoning = samples.filter(
    (s) => typeof s.reasoning === 'string' && s.reasoning.trim().length > 0,
  );
  let analyzable = 0;
  let vsVerdictContradictory = 0;
  let vsVerdictConsistent = 0;
  let vsGoldContradictory = 0;
  let vsGoldConsistent = 0;

  for (const s of withReasoning) {
    const polarity = reasoningPolarity(s.reasoning as string);
    if (polarity === 'neutral') continue;
    analyzable += 1;
    const reasoningPositive = polarity === 'positive';
    // 推理倾向 vs 裁判结论：正向推理应对应「可用」，负向推理应对应「不可用」
    if (reasoningPositive !== s.judgeVerdict) vsVerdictContradictory += 1;
    else vsVerdictConsistent += 1;
    // 推理倾向 vs 人工基准：同上，但对照 gold
    if (reasoningPositive !== s.gold) vsGoldContradictory += 1;
    else vsGoldConsistent += 1;
  }

  // 样本不足 → 直接判 insufficient，不拿极少样本凑一个看似精确的矛盾率
  if (analyzable < MIN_ANALYZABLE_REASONING) {
    return {
      withReasoning: withReasoning.length,
      analyzable,
      vsVerdictContradictory,
      vsVerdictConsistent,
      vsGoldContradictory,
      vsGoldConsistent,
      verdict: 'insufficient',
      contradictionRate: null,
      confidence: 0,
      note: `样本不足：仅有 ${withReasoning.length} 条带推理文本、其中 ${analyzable} 条可解析倾向，`
        + `未达 ${MIN_ANALYZABLE_REASONING} 条门槛——不做推理-结论一致性判断，避免用极少样本凑结论。`,
    };
  }

  // 以「推理 vs 裁判结论」为主口径（推理链解释的是裁判自己的判定）
  const contradictionRate =
    Math.round((vsVerdictContradictory / analyzable) * 1000) / 1000;
  const verdict: ReasoningConsistency['verdict'] =
    vsVerdictContradictory > 0 ? 'contradictory' : 'consistent';

  // 启发式置信度：样本越多越敢信，但关键词法天生弱，上限压到 0.6
  const confidence = Math.min(0.6, Math.round((0.3 + analyzable * 0.03) * 100) / 100);

  const note =
    verdict === 'contradictory'
      ? `启发式（关键词极性，低置信 ≈${confidence}）：${analyzable} 条可解析样本中有 `
        + `${vsVerdictContradictory} 条推理倾向与裁判结论矛盾（如推理在挑刺却判可用，或反之）。`
        + `建议人工复核这些样本——可能是裁判推理与结论脱节。`
      : `启发式（关键词极性，低置信 ≈${confidence}）：${analyzable} 条可解析样本的推理倾向与裁判结论基本一致。`;

  return {
    withReasoning: withReasoning.length,
    analyzable,
    vsVerdictContradictory,
    vsVerdictConsistent,
    vsGoldContradictory,
    vsGoldConsistent,
    verdict,
    contradictionRate,
    confidence,
    note,
  };
}

/**
 * 评委元评估结果。
 * 综合三种诊断：总体一致性 / 漂移 / 逐维薄弱点。
 */
export interface MetaJudgeReport {
  judgeId: string;
  /** 样本量 */
  sampleCount: number;
  /** 总体一致率（accuracy） */
  accuracy: number;
  /** 原始一致率是否达到下限（默认 0.75）。注意：未经随机校正，仅供参考。 */
  overallAcceptable: boolean;
  /**
   * 卡方校正后的一致性 α（Krippendorff）。二值判断下随机一致会被扣除，
   * 因此这是判断「评委是否真的比抛硬币强」的唯一可靠指标。
   */
  alpha: number;
  /** α 是否达到可接受线（默认 0.67）——**准入判据以此为准**。 */
  alphaAcceptable: boolean;
  /** 漂移检测结果（样本足够时才有意义） */
  drift: {
    /** 旧窗口（更早 50% 样本）一致率 */
    earlyAccuracy: number;
    /** 新窗口（更近 50% 样本）一致率 */
    recentAccuracy: number;
    /** 漂移量 = recentAccuracy − earlyAccuracy（负 = 变差） */
    delta: number;
    /** 是否判定为「漂移」（|delta| 超过阈值且样本足够） */
    drifted: boolean;
    /** 漂移方向（'improved' | 'degraded' | 'stable' | 'insufficient'） */
    direction: 'improved' | 'degraded' | 'stable' | 'insufficient';
  };
  /** 逐维诊断（样本带 dim 时才生成） */
  byDim: DimDiagnosis[];
  /** 最弱维度（accuracy 最低，可接受性为 false 时优先提示校准） */
  weakestDim: DimDiagnosis | null;
  /** 平均置信度（样本带 confidence 时）——用于置信校准检查 */
  avgConfidence: number | null;
  /** 置信校准缺口 = |avgConfidence − accuracy|（越接近 0 越好；差距大说明评委过度自信） */
  calibrationGap: number | null;
  /** 第四种诊断：推理-结论一致性（启发式，仅对有思维链的样本；样本不足时为 insufficient） */
  reasoningConsistency: ReasoningConsistency;
}

/** 元评估选项 */
export interface MetaJudgeOptions {
  /** 原始一致率下限（默认 0.75；未经随机校正，仅供参考） */
  acceptableThreshold?: number;
  /** α 可接受下限（默认 0.67，Krippendorff 分级）——准入判据以此为准 */
  alphaAcceptableThreshold?: number;
  /** 漂移判定阈值（|delta| 超过此值视为漂移） */
  driftThreshold?: number;
  /** 漂移检测所需最少样本数（不足则 direction='insufficient'） */
  minSamplesForDrift?: number;
}

/** 默认阈值（文献依据） */
export const META_JUDGE_DEFAULTS = {
  /**
   * 原始一致率（accuracy）的可接受下限。
   *
   * ⚠️ 口径澄清：0.67 这个数字来自 Krippendorff 对 **α（卡方校正后的一致性）** 的分级，
   * 直接套到未经随机校正的 accuracy 上会系统性高估评委质量 ——
   * 二值判断的随机基线就有 0.5，accuracy=0.67 实际只比抛硬币好一点。
   * 因此本项目：
   *   - accuracy 用 0.75 作为下限（对应 α≈0.5 量级的弱一致性，仍属「勉强」）；
   *   - **真正的准入判据是 alphaAcceptableThreshold（α ≥ 0.67）**，
   *     报告里两者都给，UI 以 α 为准。
   * 文献依据：Krippendorff 2004 的信度分级；chance-corrected 指标相对 accuracy
   * 的必要性见 Rating Roulette（EMNLP 2025 Findings）—— 该文实测 MT-bench 上
   * 人类之间 accuracy 0.827 但 α 仅 0.478，正是这个高估效应。
   */
  acceptableThreshold: 0.75,
  /** α ≥ 0.67：可接受（Krippendorff 2004）。这才是 chance-corrected 的准入线。 */
  alphaAcceptableThreshold: 0.67,
  /** 漂移判定：窗口间一致率变化超 0.15 视为显著 */
  driftThreshold: 0.15,
  /** 至少 20 个样本才做漂移检测（统计意义下限） */
  minSamplesForDrift: 20,
} as const;

/** 按时间戳排序（升序）；无时间戳的样本排在最后并保持原序 */
function sortByTs<T extends { ts?: string | null }>(samples: T[]): T[] {
  return [...samples].sort((a, b) => {
    const ta = a.ts ? Date.parse(a.ts) : Number.POSITIVE_INFINITY;
    const tb = b.ts ? Date.parse(b.ts) : Number.POSITIVE_INFINITY;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb;
  });
}

/** 计算一致率（纯函数） */
export function agreement(samples: Pick<MetaJudgeSample, 'gold' | 'judgeVerdict'>[]): BinaryAgreement {
  const n = samples.length;
  let agree = 0;
  for (const s of samples) {
    if (s.gold === s.judgeVerdict) agree += 1;
  }
  return { n, agree, accuracy: n === 0 ? 0 : Math.round((agree / n) * 1000) / 1000 };
}

/**
 * 二值数据的 Krippendorff's α（等价于 Cohen's κ 的 α 特例，无 rater 维度差异）。
 * 这里用于「评委判断 vs gold 标准」的一致性：α = 1 − Do/De。
 * - Do = 观测不一致比例；De = 期望不一致比例（边际随机）。
 * - 返回 -1..1；α ≥ 0.67 可接受，α < 0.41 不可用（Krippendorff 分级）。
 * 纯函数实现，不引 Python sidecar。
 */
export function krippendorffAlpha(
  samples: Pick<MetaJudgeSample, 'gold' | 'judgeVerdict'>[],
): number {
  const n = samples.length;
  if (n < 2) return 0;
  // 2×2 列联表：gold \ judgeVerdict
  let a11 = 0; // gold=true, judge=true
  let a12 = 0; // gold=true, judge=false
  let a21 = 0; // gold=false, judge=true
  let a22 = 0; // gold=false, judge=false
  for (const s of samples) {
    if (s.gold) {
      if (s.judgeVerdict) a11 += 1;
      else a12 += 1;
    } else {
      if (s.judgeVerdict) a21 += 1;
      else a22 += 1;
    }
  }
  // 观测不一致比例 Do
  const disagree = a12 + a21;
  const Do = disagree / n;
  // 期望不一致比例 De（基于边际独立的随机一致率）
  const goldTrue = a11 + a12;
  const judgeTrue = a11 + a21;
  // 随机期望一致率 Pe = P(gold=t)·P(judge=t) + P(gold=f)·P(judge=f)
  const Pe = (goldTrue / n) * (judgeTrue / n) + ((n - goldTrue) / n) * ((n - judgeTrue) / n);
  const De = 1 - Pe;
  if (De <= 0) return 1; // 边际完全确定，无分歧空间 → 视为完全一致
  return Math.round((1 - Do / De) * 1000) / 1000;
}

/** 按维度分组诊断（纯函数） */
export function diagnoseByDim(samples: MetaJudgeSample[]): DimDiagnosis[] {
  const groups = new Map<string, MetaJudgeSample[]>();
  for (const s of samples) {
    const dim = s.dim ?? 'unspecified';
    if (!groups.has(dim)) groups.set(dim, []);
    groups.get(dim)!.push(s);
  }
  const out: DimDiagnosis[] = [];
  for (const [dim, group] of groups) {
    const acc = agreement(group).accuracy;
    out.push({
      dim,
      n: group.length,
      accuracy: acc,
      acceptable: acc >= META_JUDGE_DEFAULTS.acceptableThreshold,
    });
  }
  // 按 accuracy 升序（最弱在前），同值按 n 降序（样本多的优先）
  out.sort((a, b) => a.accuracy - b.accuracy || b.n - a.n);
  return out;
}

/**
 * 漂移检测（纯函数）：
 * 按时间戳排序后把样本平分为 early/recent 两半，比较两半一致率。
 */
export function driftCheck(
  samples: MetaJudgeSample[],
  opts?: { driftThreshold?: number; minSamplesForDrift?: number },
): MetaJudgeReport['drift'] {
  const driftThreshold = opts?.driftThreshold ?? META_JUDGE_DEFAULTS.driftThreshold;
  const minSamples = opts?.minSamplesForDrift ?? META_JUDGE_DEFAULTS.minSamplesForDrift;
  const sorted = sortByTs(samples);
  if (sorted.length < minSamples) {
    return {
      earlyAccuracy: 0,
      recentAccuracy: 0,
      delta: 0,
      drifted: false,
      direction: 'insufficient',
    };
  }
  const half = Math.floor(sorted.length / 2);
  const early = sorted.slice(0, half);
  const recent = sorted.slice(half);
  const earlyAcc = agreement(early).accuracy;
  const recentAcc = agreement(recent).accuracy;
  const delta = Math.round((recentAcc - earlyAcc) * 1000) / 1000;
  const absDelta = Math.abs(delta);
  const drifted = absDelta >= driftThreshold;
  const direction: MetaJudgeReport['drift']['direction'] =
    !drifted ? 'stable' : delta > 0 ? 'improved' : 'degraded';
  return { earlyAccuracy: earlyAcc, recentAccuracy: recentAcc, delta, drifted, direction };
}

/**
 * 元评估主入口：综合总体一致性、漂移、逐维诊断、置信校准。
 * 纯函数、无副作用。
 */
export function assessMetaJudge(
  samples: MetaJudgeSample[],
  opts?: MetaJudgeOptions,
): MetaJudgeReport {
  const acceptableThreshold =
    opts?.acceptableThreshold ?? META_JUDGE_DEFAULTS.acceptableThreshold;
  const judgeId = samples[0]?.judgeId ?? 'unknown';

  const agg = agreement(samples);
  const alpha = krippendorffAlpha(samples);
  const byDim = diagnoseByDim(samples);
  const drift = driftCheck(samples, {
    driftThreshold: opts?.driftThreshold,
    minSamplesForDrift: opts?.minSamplesForDrift,
  });

  // 置信校准：平均置信 vs 一致率
  const confidences = samples
    .map((s) => s.confidence)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  const avgConfidence = confidences.length
    ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 1000) / 1000
    : null;
  const calibrationGap =
    avgConfidence !== null ? Math.round(Math.abs(avgConfidence - agg.accuracy) * 1000) / 1000 : null;

  const weakestDim = byDim.length > 0 ? byDim[0] : null;

  // 第四种诊断：推理-结论一致性（纯启发式，仅消费样本自带 reasoning）
  const reasoningConsistency = assessReasoningConsistency(samples);

  return {
    judgeId,
    sampleCount: agg.n,
    accuracy: agg.accuracy,
    overallAcceptable: agg.accuracy >= acceptableThreshold,
    alpha,
    alphaAcceptable:
      alpha >= (opts?.alphaAcceptableThreshold ?? META_JUDGE_DEFAULTS.alphaAcceptableThreshold),
    drift,
    byDim,
    weakestDim,
    avgConfidence,
    calibrationGap,
    reasoningConsistency,
  };
}

export default assessMetaJudge;
