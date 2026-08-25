/**
 * src/types/interview.ts
 * HR 面试（S2）契约层（模块 B · ，仅加法，不改动既有类型）。
 *
 * 面试是「对话式收敛」愿景最直接的载体：
 *   模糊高熵需求（S1 市场任务描述）
 *     → 结构化三阶段提问（P1 理解 → P2 手艺探针 → P3 压力）
 *     → 逐维证据沉淀（dimEvidence / hrRatings）
 *     → 可量化能力评估（finalRadar / stageScoreTotal）
 *
 * 全部评估域类型（JobType / RadarDim / CraftDim / RadarScore / SubjectiveScore）
 * 直接复用 `@/types/evaluation` 单一真相源；任务需求复用 `@/types/marketplace`。
 */
import type {
  CraftDim,
  JobType,
  RadarDim,
  RadarScore,
  StageKey,
  SubjectiveScore,
} from '@/types/evaluation';
import type { TaskRequirement } from '@/types/marketplace';
import type { CraftJudgement } from '@/types/craft';

/**
 * 面试三阶段（递进式收敛，顺序不可颠倒）：
 * - P1_understanding：理解力 / 主动澄清（考查 task·comm，把模糊需求逼出边界）
 * - P2_craft_probe  ：按工种下探 craft 维（考查真实手艺，img_ / txt_ / code_ 前缀维）
 * - P3_pressure     ：压力与取舍（考查 reliability·cost，暴露工程判断力）
 */
export type InterviewPhase = 'P1_understanding' | 'P2_craft_probe' | 'P3_pressure';

/** 面试结论（HR 三态，与 StageScore.verdict 解耦） */
export type InterviewRecommendation = 'hire' | 'hold' | 'reject';

/** 一道面试题（题库条目，纯数据、可单测） */
export interface InterviewQuestion {
  /** 题目稳定 id（追问题为 `${qId}:fu{n}`） */
  qId: string;
  /** 所属阶段 */
  phase: InterviewPhase;
  /** 适用工种；'any' = 三工种通用 */
  jobType: JobType | 'any';
  /** 题干（可含 `{{需求}}` 占位符，由 renderPrompt 注入任务上下文） */
  prompt: string;
  /** 本题意在考查的维度（通用六维 + 工种 craft 维混合） */
  targetDims: (RadarDim | CraftDim)[];
  /** 预设追问（证据不足时由 FollowupSuggestChips 暴露） */
  followups?: string[];
}

/** 一轮面试记录（一问一答 + HR 评分） */
export interface InterviewTurn {
  /** 轮次序号（从 1 开始） */
  turn: number;
  /** 对应题目 id */
  qId: string;
  /** 实际提问文本（已渲染占位符） */
  question: string;
  /** 本轮考查维度（可能被任务画像 dimBoost 增补） */
  targetDims: (RadarDim | CraftDim)[];
  /** agent 回答原文 */
  replyText: string;
  /** 思考/回答时延（ms）；手动粘贴时为 null */
  replyLatencyMs: number | null;
  /** 本轮 token 消耗；不可得时为 null */
  tokensUsed: number | null;
  /** 真实调度主键（gateway chat.send 返回），手动模式缺省 */
  runId?: string;
  /** HR 对本轮的打分（0–5，0.5 步进，可只填部分维）。
   *  键为通用六维或工种 craft 维：P1#8 起 HR 可直接给 craft 维打分，
   *  覆盖度据此由人工判断驱动，而非仅正则猜。 */
  hrRatings: Record<string, number>;
  /** HR 证据备注（写入 dimEvidence） */
  evidenceNote?: string;
  /** ISO8601 UTC */
  ts: string;
}

/** 面试关键指标（面试期能力基线，回灌 EvaluationProfile.interviewBaseline） */
export interface InterviewMetrics {
  /** 平均回答时延（ms），全部手动模式时为 null */
  avgReplyLatencyMs: number | null;
  /** 累计 token 消耗，不可得时为 null */
  totalTokens: number | null;
  /** agent 主动澄清次数（反问 / 假设声明） */
  clarificationCount: number;
  /** 被 HR 追问次数 */
  followupCount: number;
  /** targetDims 证据覆盖比（0–1） */
  coverageRatio: number;
}

/**
 * 工种试做题一轮（P2 手艺探针的客观分来源）。
 *
 * 与 InterviewTurn 的区别：turn 由 HR 主观打分，本结构由 model-service
 * 的 LLM-as-judge 按固定 rubric 判定，**HR 不可改分**。同题同 rubric，
 * 因此个人上传的 agent 与头部开源项目起点一致（不受 star 数影响）。
 */
export interface CraftTrialRound {
  taskId: string;
  /** 题目标题（展示用，避免重复拉题库） */
  title: string;
  /** 实际下发的题面 */
  prompt: string;
  /** 候选作答原文 */
  answerText: string;
  /** 作答通道：agent = 真实调度，manual = HR 手动粘贴 */
  mode: 'agent' | 'manual';
  /** 作答时延（ms）；手动模式为 null */
  answerLatencyMs: number | null;
  /** 裁判结果；judge 后端不可用时为 null（不补分） */
  judgement: CraftJudgement | null;
  /** judge 失败原因（judgement 为 null 时填充，UI 据此提示而非展示 0 分） */
  judgeError?: string;
  /** ISO8601 UTC */
  ts: string;
}

/**
 * 用户自定义题（无参考答案。
 * 复用 Arena 通道（context='interview'）：用户按实际情况出题 → 同工种候选作答 →
 * 用户主观选择。**不进 turns[]、不进 dimTracker 证据、不进模型分**（仅用户偏好）。
 */
export interface UserQuestionRound {
  /** 用户按自己实际情况出的题（无参考答案） */
  question: string;
  /** 复用 Arena 通道（context='interview'）的 matchId */
  matchId: string;
  /** 候选作答快照（用于报告展示，与 ArenaMatch.candidates 同构子集） */
  candidates: { agentId: string; agentName: string; answerText: string }[];
  /** 用户主观判断：agent_id | 'draw' | 'none' | null */
  pick: string | 'draw' | 'none' | null;
  /** 可选备注（未来可回灌 PreferenceProfile / BossFavorite 触发源） */
  note?: string;
  /** ISO8601 UTC */
  ts: string;
}

/** 一次完整面试的报告（落库 electron-store `agentcorp.interview`，键 = interviewId） */
export interface InterviewReport {
  interviewId: string;
  agentId: string;
  jobType: JobType;
  /** 恒为 'interview'（S2），便于与 StageScore 对齐 */
  stage: Extract<StageKey, 'interview'>;
  /** 通道①：来自人才市场的任务需求（面试考查维度的源头） */
  taskRequirement: TaskRequirement;
  /** 入场基线六维（S1 初审 / 既有评估档案），无则 null */
  baselineRadar: RadarScore | null;
  /** 全部问答轮次 */
  turns: InterviewTurn[];
  /** 工种试做题轮次（LLM-as-judge 客观分，与 turns 的 HR 主观分并列） */
  craftTrials: CraftTrialRound[];
  /** 逐维证据（键为 RadarDim | CraftDim 字符串） */
  dimEvidence: Partial<Record<string, string[]>>;
  /** 面试期关键指标 */
  metrics: InterviewMetrics;
  /** 面试后六维（HR 评分聚合，覆盖基线），无评分时为 null */
  finalRadar: RadarScore | null;
  /** S2 评分卡总分（0–100），未跑评分卡时 null */
  stageScoreTotal: number | null;
  /** S2 主观赋分快照 */
  subjective: SubjectiveScore | null;
  /** 关联收敛轨迹 runId（ConvergenceTrajectoryWidget 用） */
  convergenceRunId?: string;
  /** HR 结论 */
  recommendation: InterviewRecommendation;
  /** 阈值决策可追溯（#9 修复）：hire/hold/reject 的判定依据，供上岗后绩效闭环回流校验 */
  thresholdDecision?: string;
  /** 闭环标签（与上岗后绩效对比，验证「面试承诺 vs 实际」），中性化为 postHireLoop */
  loopTag?: string;
  /** HR 总评备注 */
  notes?: string;
  /** 用户自定义题（可选独立小节，复用 Arena 通道；不进 turns/dimTracker/模型分） */
  userQuestionRound?: UserQuestionRound;
  /** 面试官（owner id） */
  createdBy: string;
  /** ISO8601 UTC */
  ts: string;
}
