/**
 * src/stores/evaluation.ts
 * 评估中心 Zustand store（AgentCorp 评估层编排中枢）。
 *
 * 职责：
 * - 持有全部 agent 的 EvaluationProfile 与聚合视图（radar/kpi/roi/lifecycle/leaderboard）。
 * - 编排评估服务（采集/落库均在主进程，渲染层经 Host API 访问）：
 *   - evaluationData：collectRunData / listAgentSessions（主进程采集客户端）
 *   - tokenUsageCollector.buildRoiSnapshot：纯函数 ROI 计算（真实 token 成本）
 *   - judgeClient：evaluate（MiniCPM-o 外部裁判，SSE 流）
 *   - evaluationRuntime：linkRunToTask（runId ↔ task 落库）
 *   - metricsEngine：纯函数聚合 KPI
 *   - evaluationStore：Host API 客户端（主进程 electron-store 落库）
 *
 * 设计约束：
 * - 所有服务均为异步、可容错；任一环节失败不应中断其余流程（judge 失败时回退 Mock）。
 * - 数据真相在主进程 electron-store（agentcorp.evaluation），本 store 仅持内存镜像。
 */
import { create } from 'zustand';

import type {
  EvaluationProfile,
  RadarScore,
  KpiRecord,
  RoiSnapshot,
  LifecycleState,
  LeaderboardEntry,
  LeaderboardTier,
  Verdict,
  BossProfile,
} from '@/types/evaluation';
import { verdictToLifecycleState, LIFECYCLE_TO_STATE } from '@/types/lifecycle';
import { save as evalSave, list as evalList } from '@/services/evaluationStore';
import { computeKpi } from '@/engine/metricsEngine';
import { zscore } from '@/engine/roiEngine';
import { tokenUsageCollector } from '@/services/tokenUsageCollector';
import { collectRunData } from '@/services/evaluationData';
import { judgeClient, type JudgeRunInput } from '@/services/judgeClient';
import {
  judgeChatEnsemble,
  allPassAcrossSessions,
  type JudgeEnsembleResult,
} from '@/services/judgeEnsemble';
import { personalizationRiskFromRadarMap } from '@/engine/evaluation/evalSuite';
import { getActiveBossProfile } from '@/stores/bossProfile';
import { passK, type PassKResult } from '@/engine/evaluation/passK';
import { linkRunToTask } from '@/services/evaluationRuntime';
import { speech } from '@/services/speech';
// 模块 B 增量（仅加法）：
// - interviewStore：★通道②读取端（面试报告 → EvaluationProfile.interviewBaseline）
// - scoringStore  ：★通道③回灌端（偏好权重 → 裁判 → 绩效六维 → 市场重排）
import { latestByAgent as latestInterviewByAgent } from '@/services/interviewStore';
import { useScoringStore } from '@/stores/scoringStore';

/** 一次评估运行的入参（由 Evaluation 页面在捕获 runId 后传入） */
export interface EvaluationRunInput {
  /** 来自 gateway.rpc('chat.send') 的执行主键；缺失时仅做本地画像（不写 runlink） */
  runId?: string | null;
  agentId: string;
  agentName: string;
  sessionKey: string;
  sessionId: string;
  taskId?: string;
  task?: { title: string; description: string; weight: number };
  persona?: string;
  /** A · 老板原型（用户个性化）：描述「正在评估/雇佣这位 agent 的人」，区别于 agent.persona */
  bossProfile?: BossProfile;
  /**
   * 转录兜底：仅当主进程采集不到会话转录时启用（例如多 Agent 编排路径的
   * LLM 调用不落在某个 gateway 会话里，`collectRunData` 会返回空 transcript）。
   * 空转录会让裁判无证据可依、只能给中性分，那等于白评一次。
   * 有采集到真实转录时**一律以采集为准**，这里只是补位，不是覆盖。
   */
  transcriptFallback?: string;
}

const ZERO_RADAR: RadarScore = {
  task: 0,
  quality: 0,
  comm: 0,
  creativity: 0,
  reliability: 0,
  cost: 0,
};

/** 当前考核窗口（ISO 周，如 2025-W30） */
function currentWindow(): string {
  const d = new Date();
  const oneJan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(
    ((d.getTime() - oneJan.getTime()) / 86_400_000 + oneJan.getDay() + 1) / 7,
  );
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

interface EvaluationState {
  profiles: Record<string, EvaluationProfile>;
  radarLatest: RadarScore | null;
  kpiLatest: KpiRecord | null;
  roiLatest: RoiSnapshot | null;
  lifecycle: Record<string, LifecycleState>;
  leaderboard: LeaderboardEntry[];
  /** agentId → 展示名（榜单渲染用；由页面经 registerAgentNames 注入） */
  agentNames: Record<string, string>;
  selectedAgentId: string | null;
  streaming: boolean;
  currentRunId: string | null;
  error: string | null;
  /** 讲解文本（narration 事件增量累计，重新评估时清空） */
  narrationText: string;
  /** 语音播报开关（默认开） */
  voiceEnabled: boolean;

  /**
   * 最近一次评估 transcript（runEvaluation 采集后写入，供 pass^k 可靠性复判复用，
   * 避免重复采集）。无 transcript 时 pass^k 不可用。
   */
  lastTranscript: string | null;
  /** pass^k 可靠性结论（runPassK 计算后写入；null = 尚未测算） */
  passKResult: PassKResult | null;
  /** pass^k 测算中标记 */
  passKRunning: boolean;

  /** 从 electron-store 载入全部评估档案 */
  loadAll: () => Promise<void>;
  /** 保存（覆盖写）某个 agent 的评估档案 */
  upsertProfile: (profile: EvaluationProfile) => Promise<void>;
  /** 局部刷新某 agent 的画像字段 */
  setRunResult: (agentId: string, patch: Partial<EvaluationProfile>) => Promise<void>;
  /** 治理动作：软退休 / 回岗（仅改 lifecycle 并落库，不物理删除） */
  setLifecycle: (agentId: string, state: LifecycleState) => Promise<void>;
  /** 依据当前 profiles 重算擂台排名 */
  runLeaderboard: () => void;
  /**
   * 注册 agentId → 展示名映射（榜单显示用）。
   * 画像本身不存名字（名字属于 agent 域、会被改名），故由持有 agent 列表的页面注入；
   * 未注册时榜单回退显示 agentId。合并写入，不覆盖既有条目。
   */
  registerAgentNames: (names: Record<string, string>) => void;
  /** 完整评估编排：真实 KPI/ROI + 外部裁判 → 画像落库 + runlink */
  runEvaluation: (input: EvaluationRunInput) => Promise<EvaluationProfile | null>;
  selectAgent: (agentId: string | null) => void;
  clearError: () => void;
  toggleVoice: () => void;
  /**
   * 可靠性 pass^k 测算：
   * - 默认（无 opts）：复用 lastTranscript 重复裁判 k 次并聚合（既有行为，纯增量）；
   * - opts.useSessions=true：取该 agent 在「激活老板原型」下的多段历史会话，
   *   逐段独立评判后用 allPassAcrossSessions 判定（B · 状态化多轮，升级语义：
   *   同一原型下每一段会话都达标，才算「可靠」——避免把单次幸运达标当成稳健）。
   */
  runPassK: (agentId: string, k?: number, opts?: { useSessions?: boolean }) => Promise<void>;
}

/**
 * 由 profiles 重算擂台排名。
 * - roi_norm：群体 ≥2 时用当前全部 profile 的 roi 数组经 roiEngine.zscore 重算
 *   （与 computeRoi 内 roi_norm = zscore(population, roi) 同一计算；无法重调
 *   buildRoiSnapshot，因 entries/telemetry 不留存于画像），排序 roi_norm 优先；
 *   单 agent 时 z-score 恒 0 无区分度，排序/展示回退裸 roi。
 * - 榜首标记 MVP；已退休标记 BOTTOM；末位（非退休）亦标记 BOTTOM 以呈现「末位淘汰」候选。
 */
function computeLeaderboard(
  profiles: Record<string, EvaluationProfile>,
  names: Record<string, string>,
): LeaderboardEntry[] {
  const all = Object.values(profiles);
  if (all.length === 0) return [];

  const population = all.map((p) => p.roiLatest?.roi ?? 0);
  const useNorm = population.length > 1;
  const withRoi = all
    .map((p, i) => ({
      profile: p,
      roi: population[i],
      roiNorm: useNorm ? zscore(population, population[i]) : 0,
    }))
    .sort((a, b) => (useNorm ? b.roiNorm - a.roiNorm : b.roi - a.roi));

  const total = withRoi.length;
  return withRoi.map((item, idx) => {
    const rank = idx + 1;
    const state = item.profile.lifecycle;
    let tier: LeaderboardTier = 'NORMAL';
    if (state === 'RETIRED') tier = 'BOTTOM';
    else if (rank === 1) tier = 'MVP';
    else if (rank === total) tier = 'BOTTOM'; // 末位淘汰候选
    return {
      agentId: item.profile.agentId,
      name: names[item.profile.agentId] ?? item.profile.agentId,
      rank,
      // 优先裁判 verdict 的真实 user_fit；存量数据缺省时回退 task*20（历史近似）
      user_fit: Math.round(
        item.profile.userFitLatest ?? (item.profile.radarLatest?.task ?? 0) * 20,
      ),
      roi_norm: item.roiNorm,
      state,
      tier,
      // 透明披露：把画像上的裁判来源带进榜单，渲染层据此分区展示（degraded 不与真实评测并列）
      judge_source: item.profile.judgeSource ?? null,
    } satisfies LeaderboardEntry;
  });
}

export const useEvaluationStore = create<EvaluationState>((set, get) => ({
  profiles: {},
  radarLatest: null,
  kpiLatest: null,
  roiLatest: null,
  lifecycle: {},
  leaderboard: [],
  agentNames: {},
  selectedAgentId: null,
  streaming: false,
  currentRunId: null,
  error: null,
  narrationText: '',
  voiceEnabled: true,
  lastTranscript: null,
  passKResult: null,
  passKRunning: false,

  loadAll: async () => {
    try {
      const profiles = await evalList();
      const map: Record<string, EvaluationProfile> = {};
      const lifecycle: Record<string, LifecycleState> = {};
      for (const p of profiles) {
        map[p.agentId] = p;
        lifecycle[p.agentId] = p.lifecycle;
      }
      set({ profiles: map, lifecycle });
      get().runLeaderboard();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  upsertProfile: async (profile) => {
    await evalSave(profile);
    set((state) => ({
      profiles: { ...state.profiles, [profile.agentId]: profile },
      lifecycle: { ...state.lifecycle, [profile.agentId]: profile.lifecycle },
    }));
    get().runLeaderboard();
  },

  setRunResult: async (agentId, patch) => {
    const prev = get().profiles[agentId];
    if (!prev) return;
    const next: EvaluationProfile = { ...prev, ...patch, agentId, updatedAt: new Date().toISOString() };
    await evalSave(next);
    set((state) => ({
      profiles: { ...state.profiles, [agentId]: next },
      lifecycle: { ...state.lifecycle, [agentId]: next.lifecycle },
    }));
    get().runLeaderboard();
  },

  setLifecycle: async (agentId, state) => {
    const prev = get().profiles[agentId];
    if (!prev) {
      // 尚无画像时仅记录生命周期（写入最小画像）
      const minimal: EvaluationProfile = {
        agentId,
        radarLatest: { ...ZERO_RADAR },
        radarHistory: [],
        kpiLatest: emptyKpi(agentId),
        kpiHistory: [],
        roiLatest: emptyRoi(agentId),
        lifecycle: state,
        runIds: [],
        updatedAt: new Date().toISOString(),
      };
      await evalSave(minimal);
      set((s) => ({
        profiles: { ...s.profiles, [agentId]: minimal },
        lifecycle: { ...s.lifecycle, [agentId]: state },
      }));
      get().runLeaderboard();
      return;
    }
    const next: EvaluationProfile = { ...prev, lifecycle: state, updatedAt: new Date().toISOString() };
    await evalSave(next);
    set((s) => ({
      profiles: { ...s.profiles, [agentId]: next },
      lifecycle: { ...s.lifecycle, [agentId]: state },
    }));
    get().runLeaderboard();
  },

  runLeaderboard: () => {
    const { profiles, agentNames } = get();
    set({ leaderboard: computeLeaderboard(profiles, agentNames) });
  },

  registerAgentNames: (names) => {
    const prev = get().agentNames;
    // 无新增/无变化时不 set，避免无谓的重渲染与递归重算
    let changed = false;
    for (const [id, name] of Object.entries(names)) {
      if (name && prev[id] !== name) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    set({ agentNames: { ...prev, ...names } });
    get().runLeaderboard();
  },

  runEvaluation: async (input) => {
    speech.cancel(); // 打断上一次播报
    // 榜单名字来源之一：本次评估已经带了 agentName，直接登记，避免榜单显示裸 agentId
    if (input.agentName) {
      set((s) => ({ agentNames: { ...s.agentNames, [input.agentId]: input.agentName } }));
    }
    set({
      streaming: true,
      error: null,
      currentRunId: input.runId ?? null,
      selectedAgentId: input.agentId,
      narrationText: '',
    });
    try {
      // 1+2) 一次采集：token 用量 + 遥测事件 + 转录（主进程完成，sessionId 为空时仅按 agent 兜底）
      const collected = await collectRunData(input.agentId, input.sessionId);
      const { events, entries } = collected;
      // 采集优先；采集为空时才用调用方提供的兜底转录（如编排交付物）
      const transcript =
        collected.transcript.trim().length > 0
          ? collected.transcript
          : (input.transcriptFallback ?? '');
      // 缓存 transcript 供 pass^k 复判复用（纯增量，不改变既有评估流）
      set({ lastTranscript: transcript });

      // 3) 客观 KPI（来自真实遥测）
      const window = currentWindow();
      const kpi = computeKpi(events, window, get().profiles[input.agentId]?.radarHistory ?? []);

      // 4) ROI（使用真实 token 成本 / 用量）
      // population：其余 profile 的 roi 数组 → roi_norm 为真实群体 z-score
      // （08-07 修复：此前 population 从未传入，roi_norm 恒 undefined/0）
      const roiPopulation = Object.values(get().profiles)
        .filter((p) => p.agentId !== input.agentId)
        .map((p) => p.roiLatest?.roi ?? 0);
      const roi = tokenUsageCollector.buildRoiSnapshot(entries, events, input.agentId, window, {
        // 单 agent（无对照群）时不传，roi_norm 保持 undefined 而非误导性的 0
        population: roiPopulation.length > 0 ? roiPopulation : undefined,
      });

      // 5) 外部裁判（MiniCPM-o），失败时 judgeClient 内部回退 Mock
      // ★ 通道③（回灌端）：把用户拖拽学出来的六维权重带进裁判，
      // 使 S3 打分反映「这个用户真正在乎什么」，最终经 stageScore →
      // radarSource.latestStageScore('performance') → matchScore.perfBoost 影响市场排序。
      const userWeight = useScoringStore.getState().userWeight;
      const judgeInput: JudgeRunInput = {
        agentId: input.agentId,
        agentName: input.agentName,
        persona: input.persona,
        // A · 老板原型：把激活的用户个性化画像带给流式裁判（后端识别时注入评估上下文）
        bossProfile: input.bossProfile,
        task: input.task ?? { title: 'Ad-hoc task', description: '', weight: 1 },
        transcript,
        usage: entries,
        // 真实逐任务遥测：fallbackMock 有真实遥测时走客观 KPI 路径（08-07 诚实化）
        telemetry: events,
        preference: { weight: { ...userWeight } },
      };

      const radar: Partial<RadarScore> = {};
      let verdict: Verdict | null = null;
      let verdictUserFit = 0;
      let verdictEvidence: string[] = [];
      let sawAudio = false; // 本流出现过 audio 事件 → narration 只上屏（防双播）
      // E · 透明披露：分别计数真裁判与回退的维度，据此区分 judge / mixed / degraded。
      // 此前是「任一维降级即整体标 degraded」，会把 5 维真裁判 + 1 维回退
      // 说成全盘不可信，与实际不符。
      let judgeDims = 0;
      let degradedDims = 0;
      for await (const ev of judgeClient.evaluate(judgeInput)) {
        if (ev.type === 'radar_update') {
          radar[ev.dim] = ev.score;
          if (ev.source === 'degraded') degradedDims += 1;
          else judgeDims += 1;
          set({ radarLatest: { ...ZERO_RADAR, ...radar } });
        } else if (ev.type === 'narration') {
          if (ev.delta) {
            set((state) => ({ narrationText: state.narrationText + ev.delta }));
            if (!sawAudio) speech.speak(ev.delta);
          }
        } else if (ev.type === 'audio') {
          sawAudio = true;
          void speech.playAudioChunk(ev.chunk, ev.format, ev.sample_rate);
        } else if (ev.type === 'verdict') {
          verdict = ev.verdict;
          verdictUserFit = ev.user_fit;
          verdictEvidence = ev.evidence_trace;
          // verdict 自带来源：只有 radar_update 全被跳过时才靠它兜底标降级
          if (ev.source === 'degraded') degradedDims += 1;
          else judgeDims += 1;
        }
      }

      // 无任何来源标注（如 mock 流）时保守记 null，不谎报 judge
      const judgeSource: 'judge' | 'mixed' | 'degraded' | null =
        judgeDims + degradedDims === 0
          ? null
          : degradedDims === 0
            ? 'judge'
            : judgeDims === 0
              ? 'degraded'
              : 'mixed';

      // 语音宣判：流中无 audio 宣判块时（fallbackMock / tts 不可用）合成文本兜底
      if (verdict && !sawAudio) {
        const label =
          verdict === 'MVP' ? 'MVP' : verdict === 'OBSERVE' ? '待观察' : 'You are fired';
        speech.speak(`综合判定：${label}。用户契合度 ${Math.round(verdictUserFit)}%。`);
      }

      const radarScore: RadarScore = { ...ZERO_RADAR, ...radar };
      const lifecycle: LifecycleState = verdict
        ? verdictToLifecycleState(verdict)
        : LIFECYCLE_TO_STATE.active;

      // 6) 落库画像
      const prev = get().profiles[input.agentId];
      // ★ 通道②（读取端）：拉取该 agent 最新面试报告，作为绩效对比基线写入档案。
      // 面试期承诺（finalRadar / 时延 / 澄清次数）在这里与上岗后实际表现并置。
      const interviewBaseline = await readInterviewBaseline(input.agentId, prev);
      const profile: EvaluationProfile = {
        agentId: input.agentId,
        radarLatest: radarScore,
        radarHistory: [...(prev?.radarHistory ?? []), radarScore],
        kpiLatest: kpi,
        kpiHistory: [...(prev?.kpiHistory ?? []), kpi],
        roiLatest: roi,
        lifecycle,
        runIds: [...(prev?.runIds ?? []), ...(input.runId ? [input.runId] : [])],
        updatedAt: new Date().toISOString(),
        // verdict 真实落地（08-07）：无 verdict 时沿用既有值
        userFitLatest: verdict ? verdictUserFit : prev?.userFitLatest,
        evidenceTraceLatest: verdict ? verdictEvidence : prev?.evidenceTraceLatest,
        // 仅加法字段：无面试记录时保持既有值（可能是 undefined）
        jobType: prev?.jobType,
        stageScores: prev?.stageScores,
        subjectiveLatest: prev?.subjectiveLatest,
        subjectiveHistory: prev?.subjectiveHistory,
        craftLatest: prev?.craftLatest,
        interviewBaseline,
        // C · 基准套件：把本次（在某老板原型下）的六维雷达按原型 id 落入矩阵，
        // 供维度×原型对比与 personalization delta 计算（中性基线写入 'neutral'）。
        radarByPersona: {
          ...(prev?.radarByPersona ?? {}),
          [input.bossProfile?.id ?? 'neutral']: radarScore,
        },
        // B · 个性化风险：由本次写入后的 radarByPersona 推导跨原型最大漂移风险等级
        // （'high' = 该 agent 表现随协作对象显著漂移，需额外把关）。
        personalizationRisk: personalizationRiskFromRadarMap({
          ...(prev?.radarByPersona ?? {}),
          [input.bossProfile?.id ?? 'neutral']: radarScore,
        }),
        // B · 状态化多轮（历史协作）：把本次会话摘要（含完整 transcript，封顶 3 条）
        // 按激活老板原型累积，供后续跨会话 pass^k 复用与「记忆」注入裁判上下文。
        sessionsByPersona: {
          ...(prev?.sessionsByPersona ?? {}),
          [input.bossProfile?.id ?? 'neutral']: [
            ...(prev?.sessionsByPersona?.[input.bossProfile?.id ?? 'neutral'] ?? []),
            {
              ts: new Date().toISOString(),
              summary: transcript.slice(0, 200),
              transcript,
            },
          ].slice(-3),
        },
        // E · 透明披露：记录本次评估所用的老板原型与裁判来源，供评估卡明示机制
        lastPersonaId: input.bossProfile?.id ?? 'neutral',
        judgeSource,
      };
      await evalSave(profile);

      // 7) runId ↔ task 关联落库
      if (input.runId) {
        await linkRunToTask(input.runId, {
          taskId: input.taskId ?? '',
          agentId: input.agentId,
          sessionKey: input.sessionKey,
          sessionId: input.sessionId,
        });
      }

      set((state) => ({
        profiles: { ...state.profiles, [input.agentId]: profile },
        radarLatest: radarScore,
        kpiLatest: kpi,
        roiLatest: roi,
        lifecycle: { ...state.lifecycle, [input.agentId]: lifecycle },
        streaming: false,
      }));
      get().runLeaderboard();
      return profile;
    } catch (e) {
      set({ streaming: false, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  selectAgent: (agentId) => {
    set({ selectedAgentId: agentId });
    const p = agentId ? get().profiles[agentId] : null;
    // 无画像时清空右栏镜像，避免残留上一个 agent 的雷达/KPI/ROI。
    set({
      radarLatest: p?.radarLatest ?? null,
      kpiLatest: p?.kpiLatest ?? null,
      roiLatest: p?.roiLatest ?? null,
    });
  },

  clearError: () => set({ error: null }),

  toggleVoice: () => {
    const next = !get().voiceEnabled;
    speech.setEnabled(next);
    set({ voiceEnabled: next });
  },

  runPassK: async (agentId, k = 3, opts) => {
    set({ passKRunning: true, passKResult: null, error: null });
    try {
      // B · 状态化多轮（历史协作）：跨「同原型多 session」全对判定
      if (opts?.useSessions) {
        const activeId = getActiveBossProfile()?.id ?? 'neutral';
        const sessions = get().profiles[agentId]?.sessionsByPersona?.[activeId] ?? [];
        // 只保留有 transcript 的会话，transcript 与 summary 从同一份列表派生，
        // 保证下标一一对应（否则 history 的 slice(0, i) 会错位到别的会话上）
        const usable = sessions.filter(
          (s): s is typeof s & { transcript: string } =>
            typeof s.transcript === 'string' && s.transcript.length > 0,
        );
        const transcripts = usable.map((s) => s.transcript);
        if (transcripts.length < 2) {
          set({
            passKRunning: false,
            error: '状态化多轮测算需要同一原型下 ≥2 段历史会话，请先在该老板原型下运行多次评估。',
          });
          return;
        }
        const persona = getActiveBossProfile();
        // 摘要按时间正序，与 transcripts 同下标，供逐段注入「此前发生过什么」
        const summaries = usable.map((s) => s.summary ?? s.transcript.slice(0, 200));
        // 每段独立会话各跑一次裁判。第 i 段带上前 i 段的摘要作为 历史协作，
        // 使记忆真正累积——裁判评第 3 段时知道第 1、2 段发生过什么，
        // 才能考察「是否前后一致、是否记得此前约定」。首段无历史 = 无状态基线。
        const sessionResults = await Promise.all(
          transcripts.map((t, i) =>
            judgeChatEnsemble(agentId, t, {
              k: 1,
              persona,
              history: summaries.slice(0, i),
            }),
          ),
        );
        const valid = sessionResults.filter(
          (r): r is JudgeEnsembleResult => Boolean(r) && Boolean(r?.meanRadar),
        );
        if (valid.length < 2) {
          set({
            passKRunning: false,
            error: '裁判服务不可用或部分会话评分失败，无法跨会话测算 pass^k。',
          });
          return;
        }
        const perSessionPass = valid.map((r) => r.passK.allPass);
        const allRadars = valid.map((r) => r.meanRadar);
        // 跨会话聚合：k = 会话数；allPass 升级为「每段都全过」；passRate 为全过会话占比。
        // 标 mode='sessions'，因为 meanRadar/dimPassRate 仍是「各段均值雷达」派生的，
        // 与 allPass/passRate 的会话级语义不同，必须让 UI 能分辨（详见 PassKMode 注释）。
        const base = passK(allRadars, { k: allRadars.length });
        // 收集各段会话裁判的思维链（供 metaJudge 推理-结论一致性审计）；无推理时为 null
        const sessionReasoning = valid
          .flatMap((r) => r.reasoning ?? [])
          .filter((t) => typeof t === 'string' && t.trim().length > 0);
        const combined: PassKResult = {
          ...base,
          mode: 'sessions',
          k: allRadars.length,
          allPass: allPassAcrossSessions(perSessionPass),
          passRate:
            Math.round(
              (perSessionPass.filter(Boolean).length / perSessionPass.length) * 100,
            ) / 100,
          reasoning: sessionReasoning.length > 0 ? sessionReasoning.join('\n---\n') : null,
        };
        set({ passKResult: combined, passKRunning: false });
        return;
      }

      // 默认：单次 transcript 重复 k 次（既有行为不变）
      const transcript = get().lastTranscript;
      if (!transcript) {
        set({
          passKRunning: false,
          error: '尚无转录文本，请先运行一次评估以采集对话。',
        });
        return;
      }
      const result = await judgeChatEnsemble(agentId, transcript, {
        k,
        // A · 人格化裁判：把激活的老板原型透传给 judgeChat（前缀注入「评估上下文」）
        persona: getActiveBossProfile(),
      });
      if (!result) {
        // 裁判服务不可用（离线/503）：优雅降级，不阻塞主流程
        set({
          passKRunning: false,
          error: '裁判服务不可用，无法计算 pass^k（需联网的 MiniCPM-o 裁判）。',
        });
        return;
      }
      // 把 ensemble 收集到的裁判思维链一并带入 passKResult，供人工抽检时透传给 metaJudge。
      // k 段非空推理拼接；无推理（未启用思考模式/全降级）时为 null。
      const ensembleReasoning = (result.reasoning ?? []).filter((t) => t.trim().length > 0);
      set({
        passKResult: {
          ...result.passK,
          reasoning: ensembleReasoning.length > 0 ? ensembleReasoning.join('\n---\n') : null,
        },
        passKRunning: false,
      });
    } catch (e) {
      set({ passKRunning: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
}));

/**
 * ★ 通道②（读取端）：面试报告 → 绩效基线。
 *
 * 取该 agent 最新一份 InterviewReport，折叠成 EvaluationProfile.interviewBaseline。
 * 若已有更新的基线（面试收尾时已即时回写）或读不到报告，则沿用既有值，
 * 保证「面试刚结束 → 立刻跑绩效」不会把新基线覆盖成旧的。
 */
async function readInterviewBaseline(
  agentId: string,
  prev: EvaluationProfile | undefined,
): Promise<EvaluationProfile['interviewBaseline']> {
  try {
    const report = await latestInterviewByAgent(agentId);
    if (!report) return prev?.interviewBaseline;
    const existing = prev?.interviewBaseline;
    if (existing && String(existing.ts) >= String(report.ts)) return existing;
    return {
      radar: report.finalRadar ?? report.baselineRadar,
      metrics: {
        avgReplyLatencyMs: report.metrics.avgReplyLatencyMs,
        totalTokens: report.metrics.totalTokens,
        clarificationCount: report.metrics.clarificationCount,
        followupCount: report.metrics.followupCount,
        coverageRatio: report.metrics.coverageRatio,
      },
      reportId: report.interviewId,
      ts: report.ts,
    };
  } catch {
    // 无 electron-store 运行时或读取失败：不影响绩效主流程
    return prev?.interviewBaseline;
  }
}

/** KPI 零值占位（治理动作在无画像时使用） */
function emptyKpi(agentId: string): KpiRecord {
  return {
    agentId,
    task_completion_rate: 0,
    first_success_rate: 0,
    rework_rate: 0,
    avg_delivery_latency_ms: 0,
    autonomy_rate: 0,
    escalation_rate: 0,
    cross_task_generalization: 0,
    stability_consistency: 0,
    sample_n: 0,
    window: currentWindow(),
    computedAt: new Date().toISOString(),
  };
}

/** ROI 零值占位 */
function emptyRoi(agentId: string): RoiSnapshot {
  return {
    agentId,
    cost_total: 0,
    value_total: 0,
    roi: 0,
    ipr: 0,
    srpc: 0,
    cps: 0,
    cost_perf_score: 0,
    roi_index: 0,
    roi_norm: 0,
    window: currentWindow(),
  };
}
