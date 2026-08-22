/**
 * src/stores/interview.ts
 * HR 面试（S2）编排 store（模块 B ·  / §7）。
 *
 * 职责：
 * - startSession：从人才市场任务画像派生题序（★通道①），装配面试会话；
 * - askAgent / submitReply：经 interviewRunner 真实调度或手动录入拿到回答；
 * - rateTurn：HR 逐轮六维打分（证据 → 可量化能力）；
 * - coverage / suggestions：dimTracker 实时算覆盖度与追问建议（对话式收敛的进度条）；
 * - finishSession：聚合 → S2 评分卡（runStage）→ 报告落库（★通道②）
 *                  → 立即回写 EvaluationProfile.interviewBaseline。
 *
 * 数据真相在 electron-store（agentcorp.interview / agentcorp.stage-scores），
 * 本 store 仅持内存镜像；任一网络/落库环节失败不中断面试流程。
 */
import { create } from 'zustand';

import type {
  CraftDim,
  JobType,
  RadarDim,
  RadarScore,
  StageScore,
  SubjectiveDim,
  SubjectiveScore,
} from '@/types/evaluation';
import type { TaskProfile, TaskRequirement } from '@/types/marketplace';
import type {
  CraftTrialRound,
  InterviewPhase,
  InterviewQuestion,
  InterviewRecommendation,
  InterviewReport,
  InterviewTurn,
  UserQuestionRound,
} from '@/types/interview';
import type { CraftTask } from '@/types/craft';
import type { CandidateEmbedding, TurnState } from '@/types/convergence';
import type { CandidateRef } from '@/types/arena';
import type { RoleCard } from '@/engine/agents/roleCard';

import {
  makeFollowupQuestion,
  nextQuestion as pickNextQuestion,
  planTargetDims,
  renderPrompt,
  selectQuestions,
} from '@/engine/interview/questionBank';
import { getActiveBossProfile } from '@/stores/bossProfile';
import {
  buildDimEvidence,
  buildMetrics,
  aggregateHrRadar,
  computeCoverage,
  coverageRatio,
  recommendationOf,
  recommendationTrace,
  suggestFollowups,
  shouldTerminateFollowup,
  DEFAULT_FOLLOWUP_BUDGET,
  type DimCoverage,
  type FollowupSuggestion,
} from '@/engine/interview/dimTracker';
import {
  aggregateCraftDims,
  buildCraftEvidence,
  buildVerifiedEvidence,
} from '@/engine/interview/craftAggregate';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import { fetchCraftTasks, judgeCraftTask, tasksForJob } from '@/services/craftClient';
import { askAgent as runnerAskAgent } from '@/services/interviewRunner';
import { judgeChatEnsemble } from '@/services/judgeEnsemble';
import { save as saveReport } from '@/services/interviewStore';
import { useMarketplaceStore } from '@/stores/marketplace';
import { useEvaluationStore } from '@/stores/evaluation';
import { useScoringStore } from '@/stores/scoringStore';
import { useConvergenceStore } from '@/stores/convergenceStore';
import { useArenaStore } from '@/stores/arenaStore';

/** 面试会话状态机 */
export type InterviewStatus = 'idle' | 'running' | 'scoring' | 'finished';

/** startSession 入参 */
export interface StartSessionInput {
  agentId: string;
  agentName: string;
  /** 目标 agent 主会话键（真实调度用；缺省则只能手动录入） */
  sessionKey?: string;
  /** 显式工种；缺省时取市场任务画像推断值 */
  jobType?: JobType | null;
  /** 显式任务需求；缺省时直读 marketplaceStore（★通道①） */
  taskRequirement?: TaskRequirement;
  /** 显式任务画像；缺省时直读 marketplaceStore（★通道①） */
  taskProfile?: TaskProfile;
  /** 目标角色卡：作为本场面试的岗位画像上下文（面板与建议可引用 role.goal） */
  roleCard?: RoleCard;
  /** 面试官（owner id） */
  createdBy?: string;
}

interface InterviewState {
  /** 会话主键（= InterviewReport.interviewId） */
  interviewId: string | null;
  agentId: string | null;
  agentName: string;
  sessionKey: string;
  jobType: JobType;
  createdBy: string;
  /** 通道①：面试考查维度的源头 */
  taskRequirement: TaskRequirement;
  /** 本场题序（三阶段递进） */
  plan: InterviewQuestion[];
  /** 已问过的题 id（含已跳过；nextQuestion 据此跳过不再问） */
  askedQIds: string[];
  /** 被 HR 主动跳过的题 id（与已答区分，进度条单独统计，不计入"已完成"） */
  skippedQIds: string[];
  /** 当前待问的题（可能是追问题） */
  currentQuestion: InterviewQuestion | null;
  /** 已完成的问答轮次 */
  turns: InterviewTurn[];
  /** 入场基线六维（S1 初审 / 既有评估档案） */
  baselineRadar: RadarScore | null;
  /** 实时维度覆盖（dimTracker 聚合） */
  coverage: DimCoverage[];
  /** 实时追问建议（覆盖最薄弱的维度优先） */
  suggestions: FollowupSuggestion[];
  status: InterviewStatus;
  /** 正在真实调度 agent */
  dispatching: boolean;
  /** 最近一次调度模式提示（manual = 需要手动粘贴） */
  lastMode: 'agent' | 'manual' | null;
  /** 最近一次调度返回的 runId */
  lastRunId: string | null;
  /** 本场面试的目标角色卡（作为上下文使用） */
  targetRole: RoleCard | null;
  /** 面试报告（finishSession 产出） */
  report: InterviewReport | null;
  /** 最近一张 S2 评分卡 */
  stageScore: StageScore | null;
  /** 本场工种试做题（按 jobType 从后端题库筛出，同题同 rubric） */
  craftTasks: CraftTask[];
  /** 已完成的试做题轮次（LLM-as-judge 客观分） */
  craftTrials: CraftTrialRound[];
  /** 正在跑试做题（作答 + 评分） */
  craftRunning: boolean;
  /** 当前正在跑的题 id（UI 高亮） */
  craftActiveTaskId: string | null;
  /** 试做题链路错误（题库拉取 / judge 不可用），不阻断面试主流程 */
  craftError: string | null;
  /**
   * 模型裁判对本场对话的六维评审（judgeChatEnsemble 聚合）。
   * 这是 HR 面试的客观分主线：HR 手动打分只作为补充，不再是唯一来源。
   */
  judgeRadar: RadarScore | null;
  /** 模型评审来源：judge = k 次全为真裁判，mixed = 部分降级，degraded = 全降级 */
  judgeSource: 'judge' | 'mixed' | 'degraded' | null;
  /** 模型评审引用的证据（checkpoint 引文 / 判据） */
  judgeEvidence: string[];
  /** 模型评审置信度（0–1） */
  judgeConfidence: number | null;
  /** 正在跑模型评审 */
  judging: boolean;
  /** 模型评审错误（后端不可用等），不阻断面试；有值时不造分 */
  judgeError: string | null;
  /** 用户自定义题（P3 后可选环节，复用 Arena 通道；不进 turns/dimTracker/模型分） */
  userQuestionRound: UserQuestionRound | null;
  userQuestionStatus: 'idle' | 'comparing' | 'ready' | 'picked' | 'error';
  userQuestionError: string | null;
  error: string | null;

  startSession: (input: StartSessionInput) => void;
  /** 真实调度当前题（失败自动降级手动模式） */
  askAgent: () => Promise<void>;
  /** 录入一条回答（手动粘贴 / 调度成功后回填） */
  submitReply: (
    replyText: string,
    meta?: { latencyMs?: number | null; tokensUsed?: number | null; runId?: string | null },
  ) => void;
  /**
   * 让模型裁判评审当前已有对话（LLM-as-judge 主线）。
   * 幂等可重跑；失败只置 judgeError，绝不补分。
   */
  runJudge: () => Promise<void>;
  /** HR 逐轮打分（对模型分的人工修正，非唯一来源）。dim 可为通用六维或 craft 维（P1#8 起支持 craft 维） */
  rateTurn: (turn: number, dim: string, value: number) => void;
  /** HR 逐轮证据备注 */
  noteTurn: (turn: number, note: string) => void;
  /** 采纳一条追问建议（生成追问题并设为当前题） */
  applyFollowup: (suggestion: FollowupSuggestion) => void;
  /** 跳过当前题，前进到题序下一题 */
  skipQuestion: () => void;
  /** 拉取本工种试做题库（幂等，已有则不重复请求） */
  loadCraftTasks: () => Promise<void>;
  /** 跑一道试做题：候选作答（或用传入答案）→ LLM-as-judge 评分 */
  runCraftTask: (taskId: string, manualAnswer?: string) => Promise<CraftTrialRound | null>;
  /** 按题序依次跑完本工种全部未做的试做题 */
  runAllCraftTasks: () => Promise<void>;
  /** 清空试做题错误提示 */
  clearCraftError: () => void;
  /** 发起用户自定义题（复用 Arena compare，context='interview'） */
  startUserQuestion: (question: string, candidates: CandidateRef[]) => Promise<boolean>;
  /** 用户自定义题主观选择（复用 Arena user-pick） */
  pickUserQuestion: (pick: string | 'draw' | 'none') => Promise<boolean>;
  /** 清空用户自定义题状态 */
  resetUserQuestion: () => void;
  /** 结束面试：评分卡 + 报告落库 + 回写绩效基线 */
  finishSession: (opts?: { notes?: string; recommendation?: InterviewRecommendation }) => Promise<InterviewReport | null>;
  /** 清空会话（不删落库数据） */
  reset: () => void;
  clearError: () => void;
}

const EMPTY_REQUIREMENT: TaskRequirement = { text: '', jobType: 'all', tags: [] };

/** 生成面试主键 */
function makeInterviewId(agentId: string): string {
  return `itv-${agentId}-${Date.now()}`;
}

/**
 * 由「维度覆盖度 + HR 评分」构造收敛 belief 向量。
 *
 * 语义：向量每一维 = 该考查维度当前的确定性（0–1）。
 * 面试推进 → 证据变厚 → 向量整体抬升并稳定，即「认知熵下降」的可视化载体，
 * 供 ConvergenceTrajectoryWidget 做 PCA 轨迹投影。
 */
function beliefVector(coverage: DimCoverage[]): number[] {
  if (coverage.length === 0) return [0];
  return coverage.map((item) => {
    const rating = typeof item.rating === 'number' ? item.rating / 5 : item.coverage;
    return Math.round(((item.coverage + rating) / 2) * 1000) / 1000;
  });
}

/**
 * 问答轮次 → 供 chat-judge 评审的 transcript。
 *
 * 与 evaluationStore 的 transcript 同口径（角色前缀 + 空行分隔），
 * 使同一套 rubric 在 S2 面试与 S3 评估间可比。
 */
export function buildTranscript(turns: InterviewTurn[]): string {
  return turns
    .map((t) => `面试官：${t.question}\n候选：${t.replyText}`)
    .join('\n\n');
}

/**
 * 纯 HR 打分聚合（不回落任何基线）。
 *
 * 模型分不可用时，评分卡只能拿 HR 真实打过的分；缺维即缺证据，
 * 宁可让评分卡看到「维度不全」，也不用 S1 印象分冒充面试结论。
 */
function hrRadarOnly(turns: InterviewTurn[]): RadarScore | null {
  return aggregateHrRadar(turns, null);
}

/** 当前题所处阶段（无当前题时取题序最后一题的阶段） */
export function phaseOf(question: InterviewQuestion | null, plan: InterviewQuestion[]): InterviewPhase {
  if (question) return question.phase;
  const last = plan[plan.length - 1];
  return last ? last.phase : 'P1_understanding';
}

export const useInterviewStore = create<InterviewState>((set, get) => ({
  interviewId: null,
  agentId: null,
  agentName: '',
  sessionKey: '',
  jobType: 'code',
  createdBy: 'default',
  taskRequirement: { ...EMPTY_REQUIREMENT },
      plan: [],
      askedQIds: [],
      skippedQIds: [],
      currentQuestion: null,
      turns: [],
  baselineRadar: null,
  coverage: [],
  suggestions: [],
  status: 'idle',
  dispatching: false,
  lastMode: null,
  lastRunId: null,
  targetRole: null,
  report: null,
  stageScore: null,
  craftTasks: [],
  craftTrials: [],
  craftRunning: false,
  craftActiveTaskId: null,
  craftError: null,
  judgeRadar: null,
  judgeSource: null,
  judgeEvidence: [],
  judgeConfidence: null,
  judging: false,
  judgeError: null,
  userQuestionRound: null,
  userQuestionStatus: 'idle',
  userQuestionError: null,
  error: null,

  startSession: (input) => {
    // ★ 通道①：市场任务画像 → 面试考查维度
    const market = useMarketplaceStore.getState();
    const requirement = input.taskRequirement ?? market.taskRequirement ?? EMPTY_REQUIREMENT;
    const profile = input.taskProfile ?? market.taskProfile;
    const jobType: JobType = input.jobType ?? profile?.jobType ?? 'code';

    const plan = selectQuestions({
      jobType,
      dimBoost: profile?.dimBoost,
      tags: requirement.tags,
      // A · 人格化选题：把激活的老板原型喂入，使题序随「与谁协作」而变
      persona: getActiveBossProfile(),
    }).map((q) => ({
      ...q,
      prompt: renderPrompt(q.prompt, {
        taskText: requirement.text,
        tags: requirement.tags,
        qId: q.qId,
      }),
    }));

    // 入场基线：既有评估档案的最新六维（S1 初审 / 历史评估）
    const baselineRadar =
      useEvaluationStore.getState().profiles[input.agentId]?.radarLatest ?? null;

    const interviewId = makeInterviewId(input.agentId);
    const targetDims = planTargetDims(plan);
    const createdBy = input.createdBy ?? useScoringStore.getState().ownerId ?? 'default';

    set({
      interviewId,
      agentId: input.agentId,
      agentName: input.agentName,
      sessionKey: input.sessionKey ?? '',
      jobType,
      createdBy,
      taskRequirement: requirement,
      plan,
      askedQIds: [],
      skippedQIds: [],
      currentQuestion: plan[0] ?? null,
      turns: [],
      baselineRadar,
      coverage: computeCoverage([], targetDims),
      suggestions: suggestFollowups([], targetDims),
      status: 'running',
      dispatching: false,
      targetRole: input.roleCard ?? null,
      lastMode: null,
      lastRunId: null,
      report: null,
      stageScore: null,
      craftTasks: [],
      craftTrials: [],
      craftRunning: false,
      craftActiveTaskId: null,
      craftError: null,
      judgeRadar: null,
      judgeSource: null,
      judgeEvidence: [],
      judgeConfidence: null,
      judging: false,
      judgeError: null,
      error: null,
    });

    // 收敛轨迹：一次面试 = 一条 trace，interviewId 即 runId
    useConvergenceStore.getState().initTrace({
      runId: interviewId,
      agentId: input.agentId,
      jobType,
      k: plan.length,
      createdBy,
    });

    // 试做题题库：开场即预拉，P2 阶段可直接开跑（失败只置 craftError）
    void get().loadCraftTasks();
  },

  askAgent: async () => {
    const { currentQuestion, sessionKey, dispatching } = get();
    if (!currentQuestion || dispatching) return;
    if (!sessionKey) {
      set({ lastMode: 'manual', error: '该候选没有可用会话键，请手动粘贴回答' });
      return;
    }
    set({ dispatching: true, error: null });
    const result = await runnerAskAgent({ sessionKey, question: currentQuestion.prompt });
    set({ dispatching: false, lastMode: result.mode, lastRunId: result.runId });

    if (result.mode === 'agent' && result.replyText.trim().length > 0) {
      get().submitReply(result.replyText, {
        latencyMs: result.latencyMs,
        runId: result.runId,
        tokensUsed: null,
      });
      return;
    }
    set({ error: result.error ?? '未取回回答，请手动粘贴' });
  },

  submitReply: (replyText, meta) => {
    const state = get();
    const question = state.currentQuestion;
    if (!question || !state.agentId) return;
    const text = replyText.trim();
    if (text.length === 0) return;

    const turn: InterviewTurn = {
      turn: state.turns.length + 1,
      qId: question.qId,
      question: question.prompt,
      targetDims: [...question.targetDims],
      replyText: text,
      replyLatencyMs: meta?.latencyMs ?? null,
      tokensUsed: meta?.tokensUsed ?? null,
      runId: meta?.runId ?? undefined,
      hrRatings: {},
      ts: new Date().toISOString(),
    };

    const turns = [...state.turns, turn];

    // P1#5 修复：追问轮（qId 含 `:fu`）把「本体题 qId」一并记入 askedQIds，
    // 否则 nextQuestion(plan, …) 只会跳过追问自身的 qId，而本体题不在 askedQIds
    // 中，会被重新问出（被顶掉的题重现）。这里把本体题与追问 qId 都记上。
    const baseQId = question.qId.includes(':fu')
      ? question.qId.split(':fu')[0]
      : question.qId;
    const askedQIds = [...new Set([...state.askedQIds, baseQId, question.qId])];
    const targetDims = planTargetDims(state.plan);
    const coverage = computeCoverage(turns, targetDims);
    // P1#6：追问建议接入预算封顶；#8 修复：覆盖度/置信度达标即自适应终止，避免无效追问。
    const suggestions = shouldTerminateFollowup(turns, targetDims, {
      confidence: state.judgeConfidence ?? undefined,
    })
      ? []
      : suggestFollowups(turns, targetDims, { budget: DEFAULT_FOLLOWUP_BUDGET });
    // 题序按「已答 ∪ 已跳过」为已消耗，跳过过的题不再重问。
    const consumed = [...new Set([...askedQIds, ...state.skippedQIds])];

    set({
      turns,
      askedQIds,
      coverage,
      suggestions,
      currentQuestion: pickNextQuestion(state.plan, consumed),
    });

    recordConvergenceTurn(state.agentId, state.jobType, turn, coverage);

    // 每答完一轮就让模型裁判重评全场：HR 无需手动打分即可看到六维。
    // fire-and-forget，失败只落 judgeError，不阻断问答节奏。
    void get().runJudge();
  },

  runJudge: async () => {
    const state = get();
    if (!state.agentId || state.judging) return;
    const transcript = buildTranscript(state.turns);
    if (transcript.trim().length === 0) return;

    set({ judging: true, judgeError: null });
    const result = await judgeChatEnsemble(state.agentId, transcript, {
      persona: getActiveBossProfile(),
    }).catch(() => null);

    // 期间可能已 reset 或换人，丢弃过期结果
    if (get().agentId !== state.agentId) {
      set({ judging: false });
      return;
    }

    if (!result) {
      set({
        judging: false,
        judgeError: '模型裁判暂不可用，本场六维暂无模型分（不会用估算值代替）',
      });
      return;
    }

    const targetDims = planTargetDims(get().plan);
    set({
      judging: false,
      judgeRadar: result.meanRadar,
      judgeSource: result.source,
      judgeEvidence: result.evidence_trace,
      judgeConfidence: result.confidence,
      // 模型分接入覆盖度：通用六维不再由正则强度估算
      coverage: computeCoverage(get().turns, targetDims, result.meanRadar),
    });
  },

  rateTurn: (turn, dim, value) => {
    const state = get();
    const turns = state.turns.map((item) =>
      item.turn === turn ? { ...item, hrRatings: { ...item.hrRatings, [dim]: value } } : item,
    );
    const targetDims = planTargetDims(state.plan);
    const coverage = computeCoverage(turns, targetDims);
    // P1#6：打分后重算追问建议，受预算封顶约束；#8 修复：覆盖度/置信度达标即停。
    const suggestions = shouldTerminateFollowup(turns, targetDims, {
      confidence: state.judgeConfidence ?? undefined,
    })
      ? []
      : suggestFollowups(turns, targetDims, { budget: DEFAULT_FOLLOWUP_BUDGET });
    set({ turns, coverage, suggestions });
  },

  noteTurn: (turn, note) => {
    set((s) => ({
      turns: s.turns.map((item) => (item.turn === turn ? { ...item, evidenceNote: note } : item)),
    }));
  },

  applyFollowup: (suggestion) => {
    const state = get();
    const current = state.currentQuestion;
    // 取本体题 qId（去掉可能的 `:fu{n}` 后缀），保证父题恒为 plan 中的本体题，
    // 避免 `:fu:fu` 嵌套链，也避免追问挂在另一个追问上。
    const stripFu = (qId: string) => qId.split(':fu')[0];

    // P1#5 修复：父题优先取「覆盖该维、且不是追问轮」的本体题——
    //   1) 当前待问题若直接考查该维（用户正盯着它），优先；
    //   2) 否则取最近一次问过该维的本体题（= 该维的「证据缺口题」）；
    //   3) 兜底当前待问题 / 题序首题。
    // 这样追问始终挂在真实考过该维的本体题上，不会顶掉任何未问的题。
    const fromCurrent =
      current && !current.qId.includes(':fu') && current.targetDims.includes(suggestion.dim)
        ? stripFu(current.qId)
        : null;
    const fromTurns = state.turns
      .filter((t) => !t.qId.includes(':fu') && t.targetDims.includes(suggestion.dim))
      .map((t) => stripFu(t.qId));
    const baseQId =
      fromCurrent ??
      fromTurns[fromTurns.length - 1] ??
      (current ? stripFu(current.qId) : null) ??
      state.plan[0]?.qId;
    if (!baseQId) return;
    const base = state.plan.find((q) => q.qId === baseQId) ?? state.plan[0];
    if (!base) return;

    // 同一本体题已发起的追问序号（防 `:fu` 序号冲突）。
    const index = state.turns.filter((t) => t.qId.startsWith(`${baseQId}:fu`)).length + 1;
    const followup = makeFollowupQuestion(base, suggestion.prompt, index);
    // 追问题只考查被建议的那一维，保证证据精准落到缺口上。
    set({ currentQuestion: { ...followup, targetDims: [suggestion.dim] } });
  },

  skipQuestion: () => {
    const state = get();
    if (!state.currentQuestion) return;
    const qId = state.currentQuestion.qId;
    // P2 修复：跳过写 skippedQIds（与已答对账区分，进度条单独统计、不计入「已完成」），
    // 但题序推进要把「已答 ∪ 已跳过」都视为已消耗，跳过的题不再重问。
    const skippedQIds = state.skippedQIds.includes(qId)
      ? state.skippedQIds
      : [...state.skippedQIds, qId];
    const consumed = [...new Set([...state.askedQIds, ...skippedQIds])];
    set({ skippedQIds, currentQuestion: pickNextQuestion(state.plan, consumed) });
  },

  loadCraftTasks: async () => {
    const state = get();
    if (state.craftTasks.length > 0) return;
    try {
      const all = await fetchCraftTasks();
      const mine = tasksForJob(all, state.jobType);
      set({ craftTasks: mine, craftError: null });
    } catch (e) {
      set({
        craftTasks: [],
        craftError:
          e instanceof Error ? e.message : '试做题题库不可用（model-service 未启动？）',
      });
    }
  },

  runCraftTask: async (taskId, manualAnswer) => {
    const state = get();
    const task = state.craftTasks.find((t) => t.id === taskId);
    if (!task || state.craftRunning) return null;

    set({ craftRunning: true, craftActiveTaskId: taskId, craftError: null });

    // 1) 取答案：优先手动传入，否则真实调度候选作答
    let answerText = manualAnswer?.trim() ?? '';
    let mode: 'agent' | 'manual' = 'manual';
    let answerLatencyMs: number | null = null;

    if (answerText.length === 0) {
      if (!state.sessionKey) {
        set({
          craftRunning: false,
          craftActiveTaskId: null,
          craftError: '该候选没有可用会话键，请手动粘贴试做题答案',
        });
        return null;
      }
      const ask = await runnerAskAgent({ sessionKey: state.sessionKey, question: task.prompt });
      answerText = ask.replyText.trim();
      mode = ask.mode;
      answerLatencyMs = ask.latencyMs;
      if (answerText.length === 0) {
        set({
          craftRunning: false,
          craftActiveTaskId: null,
          craftError: ask.error ?? '未取回试做题答案，请手动粘贴',
        });
        return null;
      }
    }

    // 2) 评分：judge 不可用时保留答案、judgement 置 null，绝不补分
    const trial: CraftTrialRound = {
      taskId: task.id,
      title: task.title,
      prompt: task.prompt,
      answerText,
      mode,
      answerLatencyMs,
      judgement: null,
      ts: new Date().toISOString(),
    };
    try {
      const j = await judgeCraftTask({ task_id: task.id, answer: answerText });
      trial.judgement = j;
      // 降级：judge 后端不可用时后端返回 200 + degraded=true，
      // 机器证据仍有效，但 LLM 评分缺失——保留 judgement 带证据，标注原因。
      if (j.degraded) {
        trial.judgeError = j.degraded_reason || 'LLM 评分不可用，仅保留机器验证';
      }
    } catch (e) {
      trial.judgeError =
        e instanceof Error ? e.message : '评分后端不可用，本题记为未评测';
    }

    set((s) => ({
      craftTrials: [...s.craftTrials.filter((t) => t.taskId !== task.id), trial],
      craftRunning: false,
      craftActiveTaskId: null,
      craftError: trial.judgeError ?? null,
    }));
    return trial;
  },

  runAllCraftTasks: async () => {
    const pending = get().craftTasks.filter(
      (task) => !get().craftTrials.some((t) => t.taskId === task.id),
    );
    for (const task of pending) {
      const trial = await get().runCraftTask(task.id);
      // 作答通道断了（无会话键 / 取不回答案）就停，避免连环失败刷屏
      if (trial === null) break;
    }
  },

  clearCraftError: () => set({ craftError: null }),

  startUserQuestion: async (question, candidates) => {
    const state = get();
    if (!state.interviewId) {
      set({ userQuestionStatus: 'error', userQuestionError: '尚无进行中的面试会话' });
      return false;
    }
    const text = question.trim();
    if (!text) {
      set({ userQuestionStatus: 'error', userQuestionError: '用户题不能为空' });
      return false;
    }
    if (candidates.length < 2) {
      set({ userQuestionStatus: 'error', userQuestionError: '用户题至少需要两个候选 agent' });
      return false;
    }

    // 复用 arenaStore 的 compare（context='interview' + interviewId）
    const arena = useArenaStore.getState();
    arena.setRequirementText(text);
    arena.setJobType(state.jobType);
    arena.setCandidates(candidates);
    set({ userQuestionStatus: 'comparing', userQuestionError: null });
    await arena.compare({ context: 'interview', interviewId: state.interviewId });

    const arenaAfter = useArenaStore.getState();
    if (arenaAfter.status === 'error' || !arenaAfter.match) {
      set({
        userQuestionStatus: 'error',
        userQuestionError: arenaAfter.error ?? '用户题对决失败（后端不可用）',
      });
      return false;
    }
    const match = arenaAfter.match;
    set({
      userQuestionRound: {
        question: text,
        matchId: match.matchId,
        candidates: match.candidates.map((c) => ({
          agentId: c.agentId,
          agentName: c.agentName,
          answerText: c.answerText,
        })),
        pick: null,
        ts: new Date().toISOString(),
      },
      userQuestionStatus: 'ready',
      userQuestionError: null,
    });
    return true;
  },

  pickUserQuestion: async (pick) => {
    const state = get();
    const round = state.userQuestionRound;
    if (!round) {
      set({ userQuestionStatus: 'error', userQuestionError: '尚未发起用户自定义题' });
      return false;
    }
    const arena = useArenaStore.getState();
    if (arena.match?.matchId !== round.matchId) {
      set({ userQuestionStatus: 'error', userQuestionError: '对决状态不一致，请重新发起' });
      return false;
    }
    await arena.pick(pick);
    const arenaAfter = useArenaStore.getState();
    if (arenaAfter.status === 'error') {
      set({ userQuestionStatus: 'error', userQuestionError: arenaAfter.error ?? 'pick 回传失败' });
      return false;
    }
    const updated: UserQuestionRound = {
      ...round,
      pick,
      ts: new Date().toISOString(),
    };
    set({ userQuestionRound: updated, userQuestionStatus: 'picked', userQuestionError: null });

    // 面试报告若已落库，立即持久化用户题小节（不进 turns/dimTracker/模型分）
    const report = get().report;
    if (report) {
      try {
        await saveReport({ ...report, userQuestionRound: updated });
      } catch {
        // 落库失败不阻断用户题流程（下次 finishSession 会带上）
      }
    }
    return true;
  },

  resetUserQuestion: () =>
    set({ userQuestionRound: null, userQuestionStatus: 'idle', userQuestionError: null }),

  finishSession: async (opts) => {
    const state = get();
    if (!state.agentId || !state.interviewId) return null;
    set({ status: 'scoring', error: null });

    const targetDims: (RadarDim | CraftDim)[] = planTargetDims(state.plan);
    const metrics = buildMetrics(state.turns, targetDims);

    // 收尾前补跑一次模型评审：最后几轮回答也要进模型分
    if (state.turns.length > 0 && !state.judgeRadar) {
      await get().runJudge();
    }
    const judgeRadar = get().judgeRadar;

    // 面试后六维 = 模型分为底，HR 手动打过的维覆盖之（人工修正优先）
    const hrRadar = aggregateHrRadar(state.turns, judgeRadar);
    const finalRadar = hrRadar ?? judgeRadar;
    const dimEvidence = buildDimEvidence(state.turns);

    // 客观项：面试期六维（模型分 + HR 修正）+ 试做题 craft 维（LLM-as-judge）
    //
    // 只有真实评过的分能进评分卡。此前无人打分时 aggregateHrRadar 会回落
    // baselineRadar（来源含 S1 star 印象分），等于把印象分当面试客观证据，
    // 与「同题同 rubric、不受 star 影响」的立意冲突 —— 故这里显式排除。
    const objective: Record<string, number> = {};
    const radarForScore = judgeRadar ? finalRadar : hrRadarOnly(state.turns);
    if (radarForScore) {
      for (const dim of RADAR_DIMS) objective[dim] = radarForScore[dim];
    }
    const craft = aggregateCraftDims(state.craftTrials);
    for (const [dim, score] of Object.entries(craft.dims)) objective[dim] = score;
    // 主观项：S2 启用的 sub_* 维（SubjectiveScorePanel 写入）
    const subjectiveMap = useScoringStore.getState().getSubjective(state.agentId, 'interview');
    const subjective: Record<string, number> = {};
    for (const [dim, value] of Object.entries(subjectiveMap)) {
      if (typeof value === 'number') subjective[dim] = value;
    }
    // craft 证据（题库 P2 阶段产出）
    const craftEvidence: Record<string, string> = {};
    for (const [dim, list] of Object.entries(dimEvidence)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      if ((RADAR_DIMS as string[]).includes(dim)) continue;
      craftEvidence[dim] = list.join(' ／ ').slice(0, 500);
    }
    // 试做题的 checkpoint 引文优先于 HR 手写备注（展示用证据）
    for (const [dim, text] of Object.entries(buildCraftEvidence(state.craftTrials))) {
      craftEvidence[dim] = text;
    }
    // 机器可核验证据（沙盒真实执行）走独立字段：只有它能解除 requiresReal 维的 Q6 降权。
    // 裁判引文再漂亮也不算数——否则等于让被监管方给自己发合格证。
    const verifiedEvidence = buildVerifiedEvidence(state.craftTrials);

    let stageScore: StageScore | null = null;
    try {
      stageScore = await useScoringStore.getState().runStage({
        agentId: state.agentId,
        stage: 'interview',
        jobType: state.jobType,
        objective,
        subjective,
        craftEvidence,
        verifiedEvidence,
        scoredBy: state.createdBy,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'S2 评分卡生成失败（面试记录已保留）' });
    }

    const subjectiveSnapshot: SubjectiveScore =
      stageScore?.subjective ?? {
        agentId: state.agentId,
        stage: 'interview',
        scores: subjectiveMap as Partial<Record<SubjectiveDim, number>>,
        scoredBy: state.createdBy,
        ts: new Date().toISOString(),
      };

    const stageScoreTotal = stageScore ? stageScore.total : null;
    const report: InterviewReport = {
      interviewId: state.interviewId,
      agentId: state.agentId,
      jobType: state.jobType,
      stage: 'interview',
      taskRequirement: state.taskRequirement,
      baselineRadar: state.baselineRadar,
      turns: state.turns,
      craftTrials: state.craftTrials,
      dimEvidence,
      metrics,
      finalRadar,
      stageScoreTotal,
      subjective: subjectiveSnapshot,
      convergenceRunId: state.interviewId,
      recommendation:
        opts?.recommendation ??
        recommendationOf(stageScoreTotal, finalRadar, metrics.coverageRatio),
      // #9 修复：阈值决策可追溯，挂载到报告供上岗后绩效闭环校验
      ...recommendationTrace(stageScoreTotal, finalRadar, metrics.coverageRatio),
      notes: opts?.notes,
      userQuestionRound: state.userQuestionRound ?? undefined,
      createdBy: state.createdBy,
      ts: new Date().toISOString(),
    };

    // ★ 通道②（存储端）：面试报告落库
    try {
      await saveReport(report);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '面试报告落库失败' });
    }

    // ★ 通道②（回灌端）：立即写入 EvaluationProfile.interviewBaseline，
    // 让绩效中心与市场页无需等待下一次 S3 评估即可看到面试基线。
    try {
      const evaluation = useEvaluationStore.getState();
      if (evaluation.profiles[report.agentId]) {
        await evaluation.setRunResult(report.agentId, {
          jobType: report.jobType,
          interviewBaseline: {
            radar: report.finalRadar ?? report.baselineRadar,
            metrics: report.metrics,
            reportId: report.interviewId,
            ts: report.ts,
          },
        });
      } else {
        // P2 修复：此前无档案时静默丢失回灌，HR 以为基线已回灌实则没有。
        // 这里显式提示，避免「面试已归档却查无基线」的困惑（不阻断收尾）。
        set({
          error:
            '该 agent 尚未在绩效中心建档，面试基线暂未回灌（不影响本次面试归档）；若需回灌基线，请先在「评估中心」运行一次评估。',
        });
      }
    } catch {
      // 档案不存在或落库失败不阻断面试收尾
    }

    // 收敛评分（best-effort，失败保本地）
    try {
      await useConvergenceStore.getState().computeScore();
    } catch {
      // 忽略
    }

    set({ status: 'finished', report, stageScore });
    return report;
  },

  reset: () => {
    set({
      interviewId: null,
      agentId: null,
      agentName: '',
      sessionKey: '',
      jobType: 'code',
      taskRequirement: { ...EMPTY_REQUIREMENT },
      plan: [],
      askedQIds: [],
      skippedQIds: [],
      currentQuestion: null,
      turns: [],
      baselineRadar: null,
      coverage: [],
      suggestions: [],
      status: 'idle',
      dispatching: false,
      lastMode: null,
      lastRunId: null,
      report: null,
      stageScore: null,
      craftTasks: [],
      craftTrials: [],
      craftRunning: false,
      craftActiveTaskId: null,
      craftError: null,
      judgeRadar: null,
      judgeSource: null,
      judgeEvidence: [],
      judgeConfidence: null,
      judging: false,
      judgeError: null,
      createdBy: 'default',
      userQuestionRound: null,
      userQuestionStatus: 'idle',
      userQuestionError: null,
      error: null,
    });
  },

  clearError: () => set({ error: null }),
}));

/** 把一轮问答写进收敛轨迹（失败静默，不影响面试） */
function recordConvergenceTurn(
  agentId: string,
  jobType: JobType,
  turn: InterviewTurn,
  coverage: DimCoverage[],
): void {
  try {
    const belief = beliefVector(coverage);
    const candidate: CandidateEmbedding = {
      candidate_id: `${agentId}#T${turn.turn}`,
      turn: turn.turn,
      summary_text: turn.replyText.slice(0, 160),
      embedding: belief,
      job_type: jobType,
    };
    const turnState: TurnState = {
      turn: turn.turn,
      candidates: [candidate],
      belief_embedding: belief,
    };
    useConvergenceStore.getState().recordTurn(turnState);
  } catch {
    // 收敛轨迹为增强特性，异常不影响面试主流程
  }
}

/** 覆盖比（供页面直接展示，避免重复计算） */
export function currentCoverageRatio(coverage: DimCoverage[]): number {
  return coverageRatio(coverage);
}

export const interviewStoreState = useInterviewStore;
