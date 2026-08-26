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
  JobType,
  RadarScore,
  StageScore,
  SubjectiveDim,
  SubjectiveScore,
} from '@/types/evaluation';
import type { TaskProfile, TaskRequirement } from '@/types/marketplace';
import type {
  CraftTrialRound,
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

import { getActiveBossProfile } from '@/stores/bossProfile';
import type { DimCoverage, FollowupSuggestion } from '@/engine/interview/dimTracker';
import { fetchCraftTasks, judgeCraftTask, tasksForJob } from '@/services/craftClient';
import { askAgent as runnerAskAgent } from '@/services/interviewRunner';
import { save as saveReport } from '@/services/interviewStore';
import { persistInterviewFinalization } from '@/services/interview/interview-finalization';
import { runCraftTrial } from '@/services/interview/interview-craft';
import { runInterviewJudge } from '@/services/interview/interview-judge';
import {
  appendInterviewReply,
  applyInterviewRating,
  buildConvergenceBeliefVector,
  resolveFollowupQuestion,
  skipInterviewQuestion,
} from '@/services/interview/interview-progress';
import {
  buildInterviewCompletionArtifacts,
  buildInterviewStartState,
  deriveInterviewCoverageRatio,
} from '@/services/interview/interview-workflow';
import {
  pickInterviewUserQuestion,
  startInterviewUserQuestion,
  validateInterviewUserQuestion,
} from '@/services/interview/interview-user-question';
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
    const baselineRadar =
      useEvaluationStore.getState().profiles[input.agentId]?.radarLatest ?? null;
    const createdBy = input.createdBy ?? useScoringStore.getState().ownerId ?? 'default';
    const persona = getActiveBossProfile();
    const startState = buildInterviewStartState({
      agentId: input.agentId,
      requestedJobType: input.jobType,
      taskRequirement: requirement,
      taskProfile: profile,
      baselineRadar,
      createdBy,
      roleCard: input.roleCard,
      persona,
    });

    set({
      interviewId: startState.interviewId,
      agentId: input.agentId,
      agentName: input.agentName,
      sessionKey: input.sessionKey ?? '',
      jobType: startState.jobType,
      createdBy: startState.createdBy,
      taskRequirement: startState.taskRequirement,
      plan: startState.plan,
      askedQIds: [],
      skippedQIds: [],
      currentQuestion: startState.currentQuestion,
      turns: [],
      baselineRadar: startState.baselineRadar,
      coverage: startState.coverage,
      suggestions: startState.suggestions,
      status: 'running',
      dispatching: false,
      targetRole: startState.targetRole,
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
      runId: startState.interviewId,
      agentId: input.agentId,
      jobType: startState.jobType,
      k: startState.plan.length,
      createdBy: startState.createdBy,
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

    const nextState = appendInterviewReply({
      currentQuestion: question,
      turns: state.turns,
      askedQIds: state.askedQIds,
      skippedQIds: state.skippedQIds,
      plan: state.plan,
      judgeConfidence: state.judgeConfidence,
      replyText: text,
      meta,
    });

    set({
      turns: nextState.turns,
      askedQIds: nextState.askedQIds,
      coverage: nextState.coverage,
      suggestions: nextState.suggestions,
      currentQuestion: nextState.currentQuestion,
    });

    recordConvergenceTurn(state.agentId, state.jobType, nextState.turn, nextState.coverage);

    // 每答完一轮就让模型裁判重评全场：HR 无需手动打分即可看到六维。
    // fire-and-forget，失败只落 judgeError，不阻断问答节奏。
    void get().runJudge();
  },

  runJudge: async () => {
    const state = get();
    if (!state.agentId || state.judging) return;

    set({ judging: true, judgeError: null });
    const result = await runInterviewJudge({
      agentId: state.agentId,
      turns: state.turns,
      plan: state.plan,
      persona: getActiveBossProfile(),
    });

    // 期间可能已 reset 或换人，丢弃过期结果
    if (get().agentId !== state.agentId) {
      set({ judging: false });
      return;
    }

    if (result.kind === 'skip') {
      set({ judging: false });
      return;
    }

    if (result.kind === 'error') {
      set({ judging: false, judgeError: result.message });
      return;
    }

    set({
      judging: false,
      judgeRadar: result.patch.judgeRadar,
      judgeSource: result.patch.judgeSource,
      judgeEvidence: result.patch.judgeEvidence,
      judgeConfidence: result.patch.judgeConfidence,
      coverage: result.patch.coverage,
    });
  },

  rateTurn: (turn, dim, value) => {
    const state = get();
    const nextState = applyInterviewRating({
      turns: state.turns,
      plan: state.plan,
      judgeConfidence: state.judgeConfidence,
      turn,
      dim,
      value,
    });
    set({
      turns: nextState.turns,
      coverage: nextState.coverage,
      suggestions: nextState.suggestions,
    });
  },

  noteTurn: (turn, note) => {
    set((s) => ({
      turns: s.turns.map((item) => (item.turn === turn ? { ...item, evidenceNote: note } : item)),
    }));
  },

  applyFollowup: (suggestion) => {
    const state = get();
    const followup = resolveFollowupQuestion({
      currentQuestion: state.currentQuestion,
      turns: state.turns,
      plan: state.plan,
      suggestion,
    });
    if (!followup) return;
    set({ currentQuestion: followup });
  },

  skipQuestion: () => {
    const state = get();
    if (!state.currentQuestion) return;
    const nextState = skipInterviewQuestion({
      currentQuestion: state.currentQuestion,
      skippedQIds: state.skippedQIds,
      askedQIds: state.askedQIds,
      plan: state.plan,
    });
    set(nextState);
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

    const result = await runCraftTrial({
      task,
      sessionKey: state.sessionKey,
      manualAnswer,
      askAgent: runnerAskAgent,
      judgeCraftTask,
    });

    if (!result.trial) {
      set({
        craftRunning: false,
        craftActiveTaskId: null,
        craftError: result.craftError,
      });
      return null;
    }

    set((s) => ({
      craftTrials: [...s.craftTrials.filter((t) => t.taskId !== task.id), result.trial!],
      craftRunning: false,
      craftActiveTaskId: null,
      craftError: result.craftError,
    }));
    return result.trial;
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
    const validationError = validateInterviewUserQuestion({
      interviewId: state.interviewId,
      question,
      candidates,
    });
    if (validationError) {
      set({ userQuestionStatus: 'error', userQuestionError: validationError });
      return false;
    }

    const text = question.trim();
    const arena = useArenaStore.getState();
    set({ userQuestionStatus: 'comparing', userQuestionError: null });
    const result = await startInterviewUserQuestion({
      interviewId: state.interviewId!,
      question: text,
      jobType: state.jobType,
      candidates,
      arena: {
        setRequirementText: arena.setRequirementText,
        setJobType: arena.setJobType,
        setCandidates: arena.setCandidates,
        compare: arena.compare,
        pick: arena.pick,
        snapshot: () => useArenaStore.getState(),
      },
    });

    if (!result.round) {
      set({
        userQuestionStatus: 'error',
        userQuestionError: result.error,
      });
      return false;
    }

    set({
      userQuestionRound: result.round,
      userQuestionStatus: 'ready',
      userQuestionError: null,
    });
    return true;
  },

  pickUserQuestion: async (pick) => {
    const state = get();
    const arena = useArenaStore.getState();
    const result = await pickInterviewUserQuestion({
      round: state.userQuestionRound,
      pick,
      arena: {
        setRequirementText: arena.setRequirementText,
        setJobType: arena.setJobType,
        setCandidates: arena.setCandidates,
        compare: arena.compare,
        pick: arena.pick,
        snapshot: () => useArenaStore.getState(),
      },
    });
    if (!result.round) {
      set({ userQuestionStatus: 'error', userQuestionError: result.error });
      return false;
    }

    set({ userQuestionRound: result.round, userQuestionStatus: 'picked', userQuestionError: null });

    // 面试报告若已落库，立即持久化用户题小节（不进 turns/dimTracker/模型分）
    const report = get().report;
    if (report) {
      try {
        await saveReport({ ...report, userQuestionRound: result.round });
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

    // 收尾前补跑一次模型评审：最后几轮回答也要进模型分
    if (state.turns.length > 0 && !state.judgeRadar) {
      await get().runJudge();
    }
    const judgeRadar = get().judgeRadar;

    // 主观项：S2 启用的 sub_* 维（SubjectiveScorePanel 写入）
    const subjectiveMap = useScoringStore.getState().getSubjective(state.agentId, 'interview');
    const subjectiveSnapshotFallback: SubjectiveScore = {
      agentId: state.agentId,
      stage: 'interview',
      scores: subjectiveMap as Partial<Record<SubjectiveDim, number>>,
      scoredBy: state.createdBy,
      ts: new Date().toISOString(),
    };

    const preStageArtifacts = buildInterviewCompletionArtifacts({
      interviewId: state.interviewId,
      agentId: state.agentId,
      jobType: state.jobType,
      taskRequirement: state.taskRequirement,
      baselineRadar: state.baselineRadar,
      plan: state.plan,
      turns: state.turns,
      craftTrials: state.craftTrials,
      judgeRadar,
      stageScore: null,
      subjectiveSnapshot: subjectiveSnapshotFallback,
      subjectiveMap: subjectiveMap as Record<string, number>,
      createdBy: state.createdBy,
      userQuestionRound: state.userQuestionRound,
      notes: opts?.notes,
      recommendation: opts?.recommendation,
    });

    let stageScore: StageScore | null = null;
    try {
      stageScore = await useScoringStore.getState().runStage({
        agentId: state.agentId,
        stage: 'interview',
        jobType: state.jobType,
        objective: preStageArtifacts.objective,
        subjective: preStageArtifacts.subjective,
        craftEvidence: preStageArtifacts.craftEvidence,
        verifiedEvidence: preStageArtifacts.verifiedEvidence,
        scoredBy: state.createdBy,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'S2 评分卡生成失败（面试记录已保留）' });
    }

    const subjectiveSnapshot: SubjectiveScore =
      stageScore?.subjective ?? subjectiveSnapshotFallback;

    const completionArtifacts = buildInterviewCompletionArtifacts({
      interviewId: state.interviewId,
      agentId: state.agentId,
      jobType: state.jobType,
      taskRequirement: state.taskRequirement,
      baselineRadar: state.baselineRadar,
      plan: state.plan,
      turns: state.turns,
      craftTrials: state.craftTrials,
      judgeRadar,
      stageScore,
      subjectiveSnapshot,
      subjectiveMap: subjectiveMap as Record<string, number>,
      createdBy: state.createdBy,
      userQuestionRound: state.userQuestionRound,
      notes: opts?.notes,
      recommendation: opts?.recommendation,
    });
    const report = completionArtifacts.report;

    const evaluation = useEvaluationStore.getState();
    const finalization = await persistInterviewFinalization({
      report,
      hasEvaluationProfile: Boolean(evaluation.profiles[report.agentId]),
      saveReport,
      setEvaluationRunResult: evaluation.setRunResult,
      computeConvergence: useConvergenceStore.getState().computeScore,
    });

    if (finalization.reportError) {
      set({ error: finalization.reportError });
    } else if (finalization.baselineMessage) {
      set({ error: finalization.baselineMessage });
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
    const belief = buildConvergenceBeliefVector(coverage);
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
  return deriveInterviewCoverageRatio(coverage);
}

export const interviewStoreState = useInterviewStore;
