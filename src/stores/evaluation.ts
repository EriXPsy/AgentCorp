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
} from '@/types/evaluation';
import { getActiveBossProfile } from '@/stores/bossProfile';
import type { PassKResult } from '@/engine/evaluation/passK';
import { speech } from '@/services/speech';
import { useScoringStore } from '@/stores/scoringStore';
import {
  computeEvaluationLeaderboard,
  ZERO_RADAR,
} from '@/services/evaluation/evaluation-projection';
import { runEvaluationPassK } from '@/services/evaluation/evaluation-passk';
import { executeAgentEvaluation } from '@/services/evaluation/run-agent-evaluation';
import {
  buildSelectedEvaluationView,
  mergeEvaluationAgentNames,
} from '@/services/evaluation/evaluation-ui';
import type {
  EvaluationRunInput,
  EvaluationRunOutcome,
} from '@/services/evaluation/evaluation-types';
import {
  loadIndexedEvaluationProfiles,
  persistEvaluationProfile,
  persistLifecycleEvaluationProfile,
  persistPatchedEvaluationProfile,
} from '@/services/evaluation/evaluation-repository';
import {
  buildEvaluationPassKErrorPatch,
  buildEvaluationPassKStartPatch,
  buildEvaluationPassKSuccessPatch,
  buildEvaluationRunErrorPatch,
  buildEvaluationRunStartPatch,
  buildEvaluationRunSuccessPatch,
  buildPersistedEvaluationCollectionsPatch,
} from '@/services/evaluation/evaluation-state';
import { buildEvaluationVerdictAnnouncement } from '@/services/evaluation/evaluation-voice';

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
  runEvaluation: (input: EvaluationRunInput) => Promise<EvaluationRunOutcome | null>;
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
      const indexed = await loadIndexedEvaluationProfiles();
      set({ profiles: indexed.profilesById, lifecycle: indexed.lifecycleById });
      get().runLeaderboard();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  upsertProfile: async (profile) => {
    const persisted = await persistEvaluationProfile(profile);
    set((state) => buildPersistedEvaluationCollectionsPatch(state, persisted));
    get().runLeaderboard();
  },

  setRunResult: async (agentId, patch) => {
    const prev = get().profiles[agentId];
    if (!prev) return;
    const persisted = await persistPatchedEvaluationProfile(prev, agentId, patch);
    set((state) => buildPersistedEvaluationCollectionsPatch(state, persisted));
    get().runLeaderboard();
  },

  setLifecycle: async (agentId, state) => {
    const persisted = await persistLifecycleEvaluationProfile(agentId, state, get().profiles[agentId]);
    set((current) => buildPersistedEvaluationCollectionsPatch(current, persisted));
    get().runLeaderboard();
  },

  runLeaderboard: () => {
    const { profiles, agentNames } = get();
    set({ leaderboard: computeEvaluationLeaderboard(profiles, agentNames) });
  },

  registerAgentNames: (names) => {
    const merged = mergeEvaluationAgentNames(get().agentNames, names);
    if (!merged) return;
    set({ agentNames: merged });
    get().runLeaderboard();
  },

  runEvaluation: async (input) => {
    speech.cancel(); // 打断上一次播报
    set(buildEvaluationRunStartPatch(input, get().agentNames));

    try {
      const result = await executeAgentEvaluation({
        input,
        prevProfile: get().profiles[input.agentId],
        profiles: get().profiles,
        userWeight: useScoringStore.getState().userWeight,
        hooks: {
          onRadarUpdate: (radar) => {
            set({ radarLatest: { ...(get().radarLatest ?? ZERO_RADAR), ...radar } });
          },
          onNarrationDelta: (delta) => {
            set((state) => ({ narrationText: state.narrationText + delta }));
          },
          onNarrationFallbackSpeech: (delta) => {
            speech.speak(delta);
          },
          onAudioChunk: (chunk, format, sampleRate) => {
            void speech.playAudioChunk(chunk, format, sampleRate);
          },
        },
      });

      const verdictAnnouncement = buildEvaluationVerdictAnnouncement(
        result.verdict,
        result.verdictUserFit,
      );
      if (verdictAnnouncement && !result.sawAudio) {
        speech.speak(verdictAnnouncement);
      }

      await persistEvaluationProfile(result.profile);
      set((state) => buildEvaluationRunSuccessPatch(state, result));
      get().runLeaderboard();

      return {
        profile: result.profile,
        lifecycle: result.lifecycle,
        transcript: result.transcript,
        verdict: result.verdict,
        verdictUserFit: result.verdictUserFit,
        sawAudio: result.sawAudio,
      };
    } catch (e) {
      set(buildEvaluationRunErrorPatch(e instanceof Error ? e.message : String(e)));
      return null;
    }
  },

  selectAgent: (agentId) => {
    set({ selectedAgentId: agentId });
    const profile = agentId ? get().profiles[agentId] : null;
    set(buildSelectedEvaluationView(profile));
  },

  clearError: () => set({ error: null }),

  toggleVoice: () => {
    const next = !get().voiceEnabled;
    speech.setEnabled(next);
    set({ voiceEnabled: next });
  },

  runPassK: async (agentId, k = 3, opts) => {
    set(buildEvaluationPassKStartPatch());
    try {
      const result = await runEvaluationPassK({
        agentId,
        transcript: get().lastTranscript,
        profile: get().profiles[agentId],
        k,
        useSessions: opts?.useSessions,
        activeBossProfile: getActiveBossProfile(),
      });
      if (result.kind === 'error') {
        set(buildEvaluationPassKErrorPatch(result.message));
        return;
      }
      set(buildEvaluationPassKSuccessPatch(result.result));
    } catch (e) {
      set(buildEvaluationPassKErrorPatch(e instanceof Error ? e.message : String(e)));
    }
  },
}));
