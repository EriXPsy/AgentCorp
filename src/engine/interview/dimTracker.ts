/**
 * src/engine/interview/dimTracker.ts
 * 维度证据追踪与追问建议引擎（模块 B ·  / §3.2）。
 *
 * 「对话式收敛」的收敛度量在这里：每一轮回答都会被折算成对应维度的**证据强度**，
 * 覆盖度（coverage）就是「模糊 → 清晰」的进度条；证据最薄弱的维度会被翻译成
 * 具体追问建议（FollowupSuggestChips），驱动 HR 把提问打到信息缺口上，
 * 而不是随机寒暄——这就是「用结构化追问压低认知熵」的可执行形式。
 *
 * 本文件全部为纯函数、无副作用（不读 store / 不发网络），可直接单测。
 */
import type { CraftDim, RadarDim, RadarScore } from '@/types/evaluation';
import type { InterviewMetrics, InterviewRecommendation, InterviewTurn } from '@/types/interview';
import { RADAR_DIMS, CRAFT_LINKS } from '@/engine/scoring/registry';
import { RADAR_DIM_LABELS } from '@/engine/marketplace/radarSource';
// 信息增益选题：用单维 2PL IRT 把「再问一题能削减的不确定性」量化为 EIG，
// 替代原「覆盖度升序」的贪心排序（详见 ./irt.ts）。
import { dimInformationGain, DEFAULT_ITEM_A, DEFAULT_ITEM_B, type IrtResponse } from './irt';

/** 单维证据覆盖情况 */
export interface DimCoverage {
  /** 维度键（通用六维或 craft 维） */
  dim: RadarDim | CraftDim;
  /** 中文标签 */
  label: string;
  /** 命中该维的提问轮数 */
  asked: number;
  /** 提供了有效回答的轮数（非空回答） */
  answered: number;
  /** 证据强度累计（0–1 × 轮数） */
  strength: number;
  /** 覆盖度（0–1，1 = 证据充分） */
  coverage: number;
  /** HR 已给分（仅通用六维，未打分为 null） */
  rating: number | null;
}

/** 追问建议（喂给 FollowupSuggestChips） */
export interface FollowupSuggestion {
  /** 建议要补的维度 */
  dim: RadarDim | CraftDim;
  /** 维度中文标签 */
  label: string;
  /** 为什么建议追这个维（覆盖度说明） */
  reason: string;
  /** 可直接发送的追问题干 */
  prompt: string;
}

/** craft 维中文标签（题库/看板复用） */
export const CRAFT_DIM_LABELS: Record<CraftDim, string> = {
  img_composition: '构图',
  img_style_fit: '风格契合',
  img_fidelity: '细节保真',
  img_aesthetic_consistency: '审美一致性',
  img_multimodal_follow: '多模态遵循',
  txt_factuality: '事实准确',
  txt_coherence: '结构连贯',
  txt_tone_fit: '语气契合',
  txt_info_density: '信息密度',
  txt_instruction_follow: '指令遵循',
  code_runnability: '可运行性',
  code_efficiency: '性能效率',
  code_test_coverage: '测试覆盖',
  code_maintainability: '可维护性',
  code_security: '安全性',
};

/** 维度追问模板（按维给出「打在信息缺口上」的追问） */
const FOLLOWUP_TEMPLATES: Record<string, string> = {
  task: '回到任务本身：请把交付物拆成可勾选的清单，并标出你认为最容易翻车的一项。',
  quality: '你所说的「做好」具体是什么标准？请给出两条我能直接验收的判据。',
  comm: '如果要向一个完全不懂这块的人解释你的方案，你会怎么讲？请用三句话说完。',
  creativity: '除了你刚才这一种做法，还有没有第二、第三种路径？它们各自的代价是什么？',
  reliability: '这个方案最可能在哪一步失败？失败后你怎么发现、怎么回滚？',
  cost: '这套做法的时间与算力成本大概是多少？如果预算只有一半，你砍哪里？',
  img_composition: '请把构图讲到可执行：主体占比、重心位置、留白比例分别是多少？',
  img_style_fit: '请把「风格」翻译成参数：色板、材质、光线、参考各给一个具体值。',
  img_fidelity: '出现结构崩坏时你的修复顺序是什么？哪一步之后你会选择重生成？',
  img_aesthetic_consistency: '系列图一致性靠什么锁定？你怎么验收「像同一个人做的」？',
  img_multimodal_follow: '图文冲突时你的判定规则是什么？举一个必须以文字为准的例子。',
  txt_factuality: '这条信息你怎么核实？无法核实时你在正文里怎么表述？',
  txt_coherence: '请给出这篇的结构骨架（每段一句话），让我看到逻辑链条。',
  txt_tone_fit: '同样的意思，换成另一类读者你会怎么改写？请各给一句开头。',
  txt_info_density: '请把你刚才那段话删掉三分之一而不丢信息，删的是哪些？',
  txt_instruction_follow: '需求里互相冲突的两条，你怎么取舍？什么情况下你会回来问我？',
  code_runnability: '交付前你会跑哪几条验证？本地通过、线上不通时第一步做什么？',
  code_efficiency: '请给出定位性能问题的前三步，以及每一步你看的指标。',
  code_test_coverage: '你会覆盖哪些分支、主动放弃哪些？放弃的风险怎么向我交代？',
  code_maintainability: '请说明你的模块边界划分依据，并举一个你会拒绝的抽象。',
  code_security: '这个功能暴露到公网你重点防哪三类风险？怎么验证防住了？',
};

/** 证据充分所需的强度阈值（达到即视为覆盖度 1） */
const EVIDENCE_TARGET = 1;

/** 维度中文标签（通用六维 + craft 维统一入口） */
export function dimLabel(dim: RadarDim | CraftDim | string): string {
  if ((RADAR_DIMS as string[]).includes(dim)) {
    return RADAR_DIM_LABELS[dim as RadarDim];
  }
  return CRAFT_DIM_LABELS[dim as CraftDim] ?? String(dim);
}

/**
 * 单条回答的证据强度（0–1，确定性启发式）。
 *
 * 打分信号（全部可解释，不使用随机）：
 * - 长度：太短的回答几乎不含证据；
 * - 结构化：出现编号 / 分点 / 换行，说明在给方法而不是口号；
 * - 具体性：包含数字、单位、专有名词（英文/代码符号）；
 * - 条件性：出现「如果 / 否则 / 取决于」等取舍语，说明在讲判断而非背诵。
 */
export function evidenceStrength(reply: string): number {
  const text = (reply ?? '').trim();
  if (text.length === 0) return 0;

  let score = 0;
  // 长度分（最多 0.4）：奖励「适中篇幅」，但过长(>300字)视为啰嗦略降，
  // 以对抗 verbosity 偏差——裁判 rubric 本就「只看质量不看长度」，
  // 回退启发式不应与之相反（修复缺陷：裁判失效时信号反转、奖励啰嗦）。
  if (text.length >= 20) score += 0.15;
  if (text.length >= 80) score += 0.15;
  if (text.length >= 200 && text.length <= 300) score += 0.1;
  if (text.length > 300) score -= 0.05;
  // 结构化分（最多 0.2）
  if (/(\n|^)\s*(\d+[.、)]|[-*·])/.test(text)) score += 0.12;
  if (text.split('\n').filter((line) => line.trim().length > 0).length >= 3) score += 0.08;
  // 具体性分（最多 0.25）
  if (/\d/.test(text)) score += 0.1;
  if (/[A-Za-z_]{3,}/.test(text)) score += 0.08;
  if (/(比如|例如|举例|案例)/.test(text)) score += 0.07;
  // 取舍/条件分（最多 0.15）
  if (/(如果|若|否则|取决于|权衡|取舍|代价|风险)/.test(text)) score += 0.15;

  return Math.min(1, Math.round(score * 100) / 100);
}

/** 回答是否属于「主动澄清」（反问或显式声明假设） */
export function isClarification(reply: string): boolean {
  const text = (reply ?? '').trim();
  if (text.length === 0) return false;
  return /[?？]/.test(text) || /(我先假设|默认假设|前提是|需要你确认|想跟你确认)/.test(text);
}

/** 该轮是否为追问（qId 带 `:fu` 后缀，由 makeFollowupQuestion 生成） */
export function isFollowupTurn(turn: InterviewTurn): boolean {
  return turn.qId.includes(':fu');
}

/**
 * 逐维聚合证据覆盖度。
 * @param turns 已完成的问答轮次
 * @param targetDims 本场面试要覆盖的全部维度（来自 questionBank.planTargetDims）
 * @param judgeRadar 可选：模型裁判（chat-judge）给出的六维分（0–5）。提供时，
 *   对应通用六维的证据强度改由模型分驱动（score/5 → coverage），
 *   正则启发式仅作为 judge 不可用时的兜底。craft 维不受影响。
 */
export function computeCoverage(
  turns: InterviewTurn[],
  targetDims: (RadarDim | CraftDim)[],
  judgeRadar?: RadarScore | null,
): DimCoverage[] {
  // 汇总每维的 HR 评分（取最近一次非空评分；含 craft 维，键为字符串）
  const ratings: Record<string, number> = {};
  for (const turn of turns) {
    for (const [dim, value] of Object.entries(turn.hrRatings)) {
      if (typeof value === 'number') ratings[dim] = value;
    }
  }

  return targetDims.map((dim) => {
    let asked = 0;
    let answered = 0;
    let strength = 0;
    for (const turn of turns) {
      if (!turn.targetDims.includes(dim)) continue;
      asked += 1;
      const s = evidenceStrength(turn.replyText);
      if (s > 0) {
        answered += 1;
        strength += s;
      }
    }
    // C：模型裁判可用时，通用六维以模型分为准（0–5 → 0–1 强度）
    const judgeScore =
      judgeRadar && (RADAR_DIMS as string[]).includes(dim)
        ? judgeRadar[dim as RadarDim]
        : undefined;
    if (typeof judgeScore === 'number' && judgeScore > 0) {
      strength = judgeScore / 5;
      if (answered === 0 && asked > 0) answered = asked;
    }
    const isRadar = (RADAR_DIMS as string[]).includes(dim);
    // P1#8：craft 维人工评分优先驱动覆盖度（修复"只能被正则猜"）。
    // 模型分与正则只对通用六维生效，craft 维此前纯靠 evidenceStrength 估算，
    // 现在 HR 直接打分即按 rating/5 计算覆盖度，人工判断覆盖正则启发式。
    if (!isRadar && typeof ratings[dim] === 'number' && ratings[dim] > 0) {
      strength = ratings[dim] / 5;
      if (answered === 0 && asked > 0) answered = asked;
    }
    return {
      dim,
      label: dimLabel(dim),
      asked,
      answered,
      strength: Math.round(strength * 100) / 100,
      coverage: Math.min(1, strength / EVIDENCE_TARGET),
      rating: typeof ratings[dim] === 'number' ? ratings[dim] : null,
    } satisfies DimCoverage;
  });
}

/** 全场覆盖比（0–1，InterviewMetrics.coverageRatio） */
export function coverageRatio(coverage: DimCoverage[]): number {
  if (coverage.length === 0) return 0;
  const sum = coverage.reduce((acc, item) => acc + item.coverage, 0);
  return Math.round((sum / coverage.length) * 100) / 100;
}

/**
/**
 * 把某维已积累的作答转成 IRT 二项作答序列，供信息增益选题使用。
 * 优先用 HR 人工评分（≥3 视为达标/正确），无评分时回落到 evidenceStrength 启发式
 * （≥0.5 视为达标）。每题采用统一默认参数（DEFAULT_ITEM_A/B），因追问探针尚无标定 a/b。
 */
function dimResponses(turns: InterviewTurn[], dim: RadarDim | CraftDim): IrtResponse[] {
  const responses: IrtResponse[] = [];
  for (const turn of turns) {
    if (!turn.targetDims.includes(dim)) continue;
    // hrRatings 仅按 RadarDim 建键；CraftDim 在运行时恒为 undefined → 回落 evidenceStrength 启发式。
    const rating = turn.hrRatings[dim as RadarDim];
    const correct =
      typeof rating === 'number'
        ? rating >= 3
        : evidenceStrength(turn.replyText) >= 0.5;
    responses.push({ correct, a: DEFAULT_ITEM_A, b: DEFAULT_ITEM_B });
  }
  return responses;
}

/**
 * 追问建议：在证据薄弱的维度里，按**期望信息增益(EIG) 降序**排序优先追问，
 * 而非原「覆盖度升序」的贪心排序。
 *
 * 信息增益视角：哪维「再问一题能削减的不确定性最大」就先问哪维。
 * - 零证据维：后验=先验（最不确定，EIG 最大）→ 自然最优先；
 * - 已强证据维：后验集中、边际增益递减 → 自然靠后。
 * 这比单纯「覆盖度缺口」更贴合「熵收敛」内核：体现边际信息递减，避免对
 * 已收敛维无效追问。
 *
 * 已经充分覆盖（coverage ≥ 0.8）的维度不再建议——避免把已达标维以
 * 「证据偏薄」的矛盾文案推给 HR（P2 文案修正）。
 * 全部维度均已达标 = 收敛完成 → 返回空（不保底兜底，不臆造追问）。
 */
export function suggestFollowups(
  turns: InterviewTurn[],
  targetDims: (RadarDim | CraftDim)[],
  opts: { max?: number; threshold?: number; budget?: number } = {},
): FollowupSuggestion[] {
  const max = opts.max ?? 3;
  const threshold = opts.threshold ?? 0.8;

  // 追问预算耗尽：不再建议
  if (typeof opts.budget === 'number' && followupBudgetRemaining(turns, opts.budget) <= 0) {
    return [];
  }

  const coverage = computeCoverage(turns, targetDims);
  // 全维度先按 EIG 降序（零证据→熵最大→最优先；强证据→熵低→靠后），
  //     稳定 tie-break：EIG 相同时先问被问更少的维。
  const allByInfoGain = [...coverage].sort((a, b) => {
    const ga = dimInformationGain(dimResponses(turns, a.dim));
    const gb = dimInformationGain(dimResponses(turns, b.dim));
    if (Math.abs(ga - gb) > 1e-9) return gb - ga;
    return a.asked - b.asked;
  });
  // 仅取未充分覆盖（coverage < threshold）的维作为候选追问；
  // 全部达标 = 收敛完成 → 返回空，不把已达标维说成「证据偏薄」（main P2 语义）
  const weakByInfoGain = allByInfoGain.filter((item) => item.coverage < threshold);
  const picked = weakByInfoGain.slice(0, max);

  return picked.map((item) => ({
    dim: item.dim,
    label: item.label,
    reason:
      item.asked === 0
        ? '尚未提问，零证据'
        : item.answered === 0
          ? '已提问但未获得有效回答'
          : `证据偏薄（覆盖 ${(item.coverage * 100).toFixed(0)}%）`,
    prompt:
      FOLLOWUP_TEMPLATES[item.dim] ??
      `关于「${item.label}」，请再具体一点：给出你的做法、判断标准和一个真实例子。`,
  }));
}

/** agent 主动澄清次数 */
export function countClarifications(turns: InterviewTurn[]): number {
  return turns.filter((t) => isClarification(t.replyText)).length;
}

/** 被追问次数 */
export function countFollowups(turns: InterviewTurn[]): number {
  return turns.filter(isFollowupTurn).length;
}

/** 默认追问预算（最多允许追问几次，避免无限追问拖垮面试节奏） */
export const DEFAULT_FOLLOWUP_BUDGET = 2;

/**
 * 剩余追问预算：max − 已追问次数。
 * 预算耗尽（返回 0）时 HR 不应再发起追问，应由建议逻辑自动停发。
 */
export function followupBudgetRemaining(
  turns: InterviewTurn[],
  max: number = DEFAULT_FOLLOWUP_BUDGET,
): number {
  return Math.max(0, max - countFollowups(turns));
}

/** 平均回答时延（全部手动模式返回 null） */
export function averageLatency(turns: InterviewTurn[]): number | null {
  const values = turns
    .map((t) => t.replyLatencyMs)
    .filter((v): v is number => typeof v === 'number' && v > 0);
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** 累计 token 消耗（全部不可得返回 null） */
export function totalTokens(turns: InterviewTurn[]): number | null {
  const values = turns
    .map((t) => t.tokensUsed)
    .filter((v): v is number => typeof v === 'number' && v > 0);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0);
}

/**
 * 汇总 HR 逐轮评分为通用六维（缺维回落到 craft 维的 CRAFT_LINKS 映射，再缺则回落基线）。
 * @param turns 问答轮次
 * @param baseline 入场基线六维（可为 null）
 */
export function aggregateHrRadar(
  turns: InterviewTurn[],
  baseline: RadarScore | null = null,
): RadarScore | null {
  const sums: Partial<Record<RadarDim, number>> = {};
  const counts: Partial<Record<RadarDim, number>> = {};

  for (const turn of turns) {
    for (const [key, value] of Object.entries(turn.hrRatings)) {
      if (typeof value !== 'number') continue;
      const dim = key as RadarDim;
      sums[dim] = (sums[dim] ?? 0) + value;
      counts[dim] = (counts[dim] ?? 0) + 1;
      // craft 维证据经 CRAFT_LINKS 回灌通用六维
      for (const target of turn.targetDims) {
        const links = (CRAFT_LINKS as Record<string, RadarDim[]>)[target];
        if (!links) continue;
        for (const linked of links) {
          if (linked === dim) continue;
          sums[linked] = (sums[linked] ?? 0) + value * 0.5;
          counts[linked] = (counts[linked] ?? 0) + 0.5;
        }
      }
    }
  }

  const rated = RADAR_DIMS.filter((dim) => (counts[dim] ?? 0) > 0);
  if (rated.length === 0) return baseline ? { ...baseline } : null;

  const radar: RadarScore = {
    task: 0,
    quality: 0,
    comm: 0,
    creativity: 0,
    reliability: 0,
    cost: 0,
  };
  for (const dim of RADAR_DIMS) {
    const count = counts[dim] ?? 0;
    if (count > 0) {
      const avg = (sums[dim] ?? 0) / count;
      radar[dim] = Math.round(Math.min(5, Math.max(0, avg)) * 2) / 2;
    } else {
      radar[dim] = baseline ? baseline[dim] : 0;
    }
  }
  return radar;
}

/** 汇总面试指标（写入 InterviewReport.metrics / EvaluationProfile.interviewBaseline） */
export function buildMetrics(
  turns: InterviewTurn[],
  targetDims: (RadarDim | CraftDim)[],
): InterviewMetrics {
  return {
    avgReplyLatencyMs: averageLatency(turns),
    totalTokens: totalTokens(turns),
    clarificationCount: countClarifications(turns),
    followupCount: countFollowups(turns),
    coverageRatio: coverageRatio(computeCoverage(turns, targetDims)),
  };
}

/** 逐维证据文本（写入 InterviewReport.dimEvidence） */
export function buildDimEvidence(turns: InterviewTurn[]): Partial<Record<string, string[]>> {
  const evidence: Record<string, string[]> = {};
  for (const turn of turns) {
    const note = (turn.evidenceNote ?? '').trim();
    const snippet = note.length > 0 ? note : turn.replyText.trim().slice(0, 120);
    if (snippet.length === 0) continue;
    for (const dim of turn.targetDims) {
      if (!evidence[dim]) evidence[dim] = [];
      evidence[dim].push(`T${turn.turn}｜${snippet}`);
    }
  }
  return evidence;
}

/**
 * HR 结论建议（stageScoreTotal 优先，缺失时用覆盖度 + 六维均值兜底）。
 * 仅为建议值，HR 可在 UI 上覆盖。
 */
export function recommendationOf(
  stageScoreTotal: number | null,
  finalRadar: RadarScore | null,
  ratio: number,
): InterviewRecommendation {
  if (typeof stageScoreTotal === 'number') {
    if (stageScoreTotal >= 75) return 'hire';
    if (stageScoreTotal >= 55) return 'hold';
    return 'reject';
  }
  if (finalRadar) {
    const mean = RADAR_DIMS.reduce((acc, dim) => acc + finalRadar[dim], 0) / RADAR_DIMS.length;
    if (mean >= 4 && ratio >= 0.6) return 'hire';
    if (mean >= 2.5) return 'hold';
    return 'reject';
  }
  return 'hold';
}

/**
 * #9 修复（可追溯版）：把阈值决策抽成可追踪结构，供面试报告挂载，
 * 与上岗后绩效做闭环校验（验证「面试承诺 vs 实际」）。
 * 注意：原 patch 把未使用变量留在 recommendationOf 内 → 死代码 + lint 失败；
 * 此处改为独立纯函数，由 interview_store 调用并挂载到报告。
 * 原内部阶段代号「S3 上岗绩效」已中性化为「上岗后绩效闭环」。
 */
export function recommendationTrace(
  stageScoreTotal: number | null,
  finalRadar: RadarScore | null,
  ratio: number,
): { thresholdDecision: string; loopTag: string } {
  let thresholdDecision: string;
  if (typeof stageScoreTotal === 'number') {
    if (stageScoreTotal >= 75) thresholdDecision = 'hire_75';
    else if (stageScoreTotal >= 55) thresholdDecision = 'hold_55';
    else thresholdDecision = 'reject_sub55';
  } else if (finalRadar) {
    const mean = RADAR_DIMS.reduce((acc, dim) => acc + finalRadar[dim], 0) / RADAR_DIMS.length;
    if (mean >= 4 && ratio >= 0.6) thresholdDecision = 'hire_mean4';
    else if (mean >= 2.5) thresholdDecision = 'hold_mean2.5';
    else thresholdDecision = 'reject_mean2.5';
  } else {
    thresholdDecision = 'hold_default';
  }
  const loopTag = `threshold:${thresholdDecision}:postHireLoop_pending`;
  return { thresholdDecision, loopTag };
}

/**
 * 自适应终止判定（缺陷 #8 修复）：在「预算封顶」之外，增加「置信度/覆盖度达标即停」的
 * 严谨终止条件，避免固定追问 2 次造成的无效追问或收敛不足。
 * - coverageRatio 已达阈值（默认 0.9）→ 已收敛，停；
 * - 模型裁判置信度达标（默认 ≥0.8）且覆盖度 ≥0.6 → 信号充分，停；
 * - 否则交由预算逻辑裁决。
 */
export function shouldTerminateFollowup(
  turns: InterviewTurn[],
  targetDims: (RadarDim | CraftDim)[],
  opts: { coverageThreshold?: number; confidence?: number; confidenceThreshold?: number } = {},
): boolean {
  const coverageThreshold = opts.coverageThreshold ?? 0.9;
  const confidenceThreshold = opts.confidenceThreshold ?? 0.8;
  const ratio = coverageRatio(computeCoverage(turns, targetDims));
  if (ratio >= coverageThreshold) return true;
  if (
    typeof opts.confidence === 'number' &&
    ratio >= 0.6 &&
    opts.confidence >= confidenceThreshold
  ) {
    return true;
  }
  return false;
}
