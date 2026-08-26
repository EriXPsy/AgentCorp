/**
 * src/stores/designerStore.ts
 * SPADE Designer Zustand store：StyleMemory 状态 + 出题/反思动作。
 *
 * 设计：
 * - StyleMemory / challenge / reflection 均按 team_id 缓存，避免 TeamSpace / Evaluation 互相覆盖
 * - 反思在评估完成后异步触发，不阻塞评估主流程
 * - 出题失败时优雅降级（保留旧 challenge）
 * - store 负责状态壳与 IO；team 级状态拼装下沉到 services/designer/*
 */
import { create } from 'zustand';

import {
  fetchTeamGaps,
  fetchTeamRadar,
  loadAgentMemory,
  loadMemory,
  requestChallenge,
  submitAgentReflection,
  submitReflection,
} from '@/services/designerClient';
import {
  appendUniqueString,
  buildActiveDesignerSelection,
  getDesignerTeamWorkspace,
  isDesignerNotFoundError,
  mergeAgentMemory,
  mergeDesignerTeamWorkspace,
  type DesignerTeamWorkspace,
} from '@/services/designer/designer-state';
import type {
  AgentMemory,
  AgentReflectResponse,
  ChallengeResponse,
  ReflectResponse,
  StyleMemory,
  TeamGapResponse,
  TeamRadarResponse,
} from '@/types/designer';

interface DesignerState {
  /** 当前选中的团队 workspace（兼容现有组件选择器） */
  memory: StyleMemory | null;
  /** 当前团队 ID（active workspace） */
  teamId: string | null;
  /** 当前团队最近一次出题结果 */
  currentChallenge: ChallengeResponse | null;
  /** 当前团队最近一次反思结果 */
  lastReflection: ReflectResponse | null;
  /** 当前团队加载/提交中 */
  loading: boolean;
  /** 当前团队错误信息 */
  error: string | null;
  /** 全部团队 Designer workspace 缓存 */
  teamStates: Record<string, DesignerTeamWorkspace>;

  // ── Agent 级别成长追踪 ──
  /** 已加载的 Agent 成长档案 {agent_id: AgentMemory} */
  agentMemories: Record<string, AgentMemory>;
  /** 最近一次 Agent 反思结果 */
  lastAgentReflection: AgentReflectResponse | null;

  // ── 团队缺口检测 ──
  /** 团队缺口分析缓存 {team_id: TeamGapResponse} */
  teamGaps: Record<string, TeamGapResponse>;
  /** 已通知过的缺口 key（避免重复弹通知） */
  notifiedGapKeys: string[];

  // ── 团队六维雷达 ──
  /** 团队雷达数据 {team_id: TeamRadarResponse} */
  teamRadars: Record<string, TeamRadarResponse>;

  /** 选择当前团队（仅切换当前视图，不清缓存） */
  selectTeam: (teamId: string | null) => void;
  /** 加载团队的 StyleMemory；force=true 时忽略缓存 */
  fetchMemory: (teamId: string, opts?: { force?: boolean }) => Promise<void>;
  /** 请求 Designer 出题 */
  requestChallenge: (
    teamId: string,
    opts?: { jobType?: string; description?: string; memberCount?: number },
  ) => Promise<ChallengeResponse | null>;
  /** 评估后触发团队反思 */
  reflect: (
    teamId: string,
    taskId: string,
    answer: string,
    scores: Record<string, number>,
    outcome: string,
  ) => Promise<ReflectResponse | null>;
  /** 评估后触发 Agent 个人反思 */
  reflectAgent: (
    agentId: string,
    teamId: string,
    taskId: string,
    answer: string,
    scores: Record<string, number>,
    outcome: string,
  ) => Promise<AgentReflectResponse | null>;
  /** 加载单个 Agent 成长档案 */
  fetchAgentMemory: (agentId: string) => Promise<void>;
  /** 分析团队能力缺口（驱动主动招聘通知） */
  fetchTeamGaps: (teamId: string) => Promise<TeamGapResponse | null>;
  /** 加载团队六维雷达数据 */
  fetchTeamRadar: (teamId: string) => Promise<TeamRadarResponse | null>;
  /** 标记某个团队缺口已通知 */
  markGapNotified: (gapKey: string) => void;
  /** 清空当前选择（不清缓存） */
  reset: () => void;
  /** 清空当前团队错误 */
  clearError: () => void;
}

function buildDesignerTeamStatePatch(
  state: Pick<DesignerState, 'teamId' | 'teamStates'>,
  teamId: string,
  patch: Partial<DesignerTeamWorkspace>,
  opts?: { activeTeamId?: string | null },
) {
  const nextTeamStates = mergeDesignerTeamWorkspace(state.teamStates, teamId, patch);
  const activeTeamId = opts?.activeTeamId ?? teamId;
  return {
    teamStates: nextTeamStates,
    ...buildActiveDesignerSelection(activeTeamId, nextTeamStates),
  };
}

export const useDesignerStore = create<DesignerState>((set, get) => ({
  memory: null,
  teamId: null,
  currentChallenge: null,
  lastReflection: null,
  loading: false,
  error: null,
  teamStates: {},
  agentMemories: {},
  lastAgentReflection: null,
  teamGaps: {},
  notifiedGapKeys: [],
  teamRadars: {},

  selectTeam: (teamId) => {
    set((state) => buildActiveDesignerSelection(teamId, state.teamStates));
  },

  fetchMemory: async (teamId, opts) => {
    const cached = getDesignerTeamWorkspace(get().teamStates, teamId);
    if (cached.memory && !opts?.force) {
      set((state) => buildActiveDesignerSelection(teamId, state.teamStates));
      return;
    }

    set((state) =>
      buildDesignerTeamStatePatch(state, teamId, { loading: true, error: null }, { activeTeamId: teamId }),
    );
    try {
      const memory = await loadMemory(teamId);
      set((state) =>
        buildDesignerTeamStatePatch(
          state,
          teamId,
          { memory, loading: false, error: null },
          { activeTeamId: teamId },
        ),
      );
    } catch (e) {
      if (isDesignerNotFoundError(e)) {
        set((state) =>
          buildDesignerTeamStatePatch(
            state,
            teamId,
            { memory: null, loading: false, error: null },
            { activeTeamId: teamId },
          ),
        );
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      set((state) =>
        buildDesignerTeamStatePatch(
          state,
          teamId,
          { loading: false, error: message },
          { activeTeamId: teamId },
        ),
      );
    }
  },

  requestChallenge: async (teamId, opts) => {
    set((state) =>
      buildDesignerTeamStatePatch(state, teamId, { loading: true, error: null }, { activeTeamId: teamId }),
    );
    try {
      const challenge = await requestChallenge({
        team_id: teamId,
        job_type: opts?.jobType ?? 'code',
        description: opts?.description ?? '',
        member_count: opts?.memberCount ?? 0,
      });
      set((state) =>
        buildDesignerTeamStatePatch(
          state,
          teamId,
          { currentChallenge: challenge, loading: false, error: null },
          { activeTeamId: teamId },
        ),
      );
      // 出题后刷新 memory（challenges_issued 已更新）
      void get().fetchMemory(teamId, { force: true });
      return challenge;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set((state) =>
        buildDesignerTeamStatePatch(
          state,
          teamId,
          { loading: false, error: message },
          { activeTeamId: teamId },
        ),
      );
      return null;
    }
  },

  reflect: async (teamId, taskId, answer, scores, outcome) => {
    // 反思不阻塞主流程——静默失败，只记录 warning；仅刷新 team cache
    try {
      const result = await submitReflection({
        team_id: teamId,
        task_id: taskId,
        answer,
        scores,
        outcome,
      });
      set((state) =>
        buildDesignerTeamStatePatch(
          state,
          teamId,
          { lastReflection: result },
          { activeTeamId: state.teamId === teamId ? teamId : state.teamId },
        ),
      );
      // 反思后刷新 memory（observations/understanding 已更新）
      void get().fetchMemory(teamId, { force: true });
      return result;
    } catch (e) {
      console.warn('[designerStore] reflection failed:', e);
      return null;
    }
  },

  reflectAgent: async (agentId, teamId, taskId, answer, scores, outcome) => {
    try {
      const result = await submitAgentReflection({
        agent_id: agentId,
        team_id: teamId,
        task_id: taskId,
        answer,
        scores,
        outcome,
      });
      set((state) => ({
        lastAgentReflection: result,
        agentMemories: {
          ...state.agentMemories,
          [agentId]: mergeAgentMemory(state.agentMemories[agentId], {
            agent_id: agentId,
            team_id: teamId,
            submission_count: result.submission_count,
            pass_rate: result.pass_rate,
            strengths: result.strengths,
            weaknesses: result.weaknesses,
            growth_summary: result.growth_summary,
            observations: [
              ...(state.agentMemories[agentId]?.observations ?? []),
              result.observation,
            ],
            performance_log: state.agentMemories[agentId]?.performance_log ?? [],
            score_trajectory: state.agentMemories[agentId]?.score_trajectory ?? {},
          }),
        },
      }));
      return result;
    } catch (e) {
      console.warn('[designerStore] agent reflection failed:', e);
      return null;
    }
  },

  fetchTeamRadar: async (teamId) => {
    try {
      const radar = await fetchTeamRadar(teamId);
      set((state) => ({ teamRadars: { ...state.teamRadars, [teamId]: radar } }));
      return radar;
    } catch (e) {
      if (!isDesignerNotFoundError(e)) {
        console.warn('[designerStore] team radar fetch failed:', e);
      }
      return null;
    }
  },

  fetchTeamGaps: async (teamId) => {
    try {
      const gaps = await fetchTeamGaps(teamId);
      set((state) => ({ teamGaps: { ...state.teamGaps, [teamId]: gaps } }));
      return gaps;
    } catch (e) {
      // 404 = 团队尚无记录，静默处理
      if (!isDesignerNotFoundError(e)) {
        console.warn('[designerStore] team gaps analysis failed:', e);
      }
      return null;
    }
  },

  fetchAgentMemory: async (agentId) => {
    try {
      const memory = await loadAgentMemory(agentId);
      set((state) => ({
        agentMemories: { ...state.agentMemories, [agentId]: memory },
      }));
    } catch (e) {
      if (!isDesignerNotFoundError(e)) {
        console.warn('[designerStore] load agent memory failed:', e);
      }
    }
  },

  markGapNotified: (gapKey) => {
    set((state) => ({
      notifiedGapKeys: appendUniqueString(state.notifiedGapKeys, gapKey),
    }));
  },

  reset: () =>
    set((state) => ({
      ...buildActiveDesignerSelection(null, state.teamStates),
    })),

  clearError: () => {
    const activeTeamId = get().teamId;
    if (!activeTeamId) {
      set({ error: null });
      return;
    }
    set((state) =>
      buildDesignerTeamStatePatch(
        state,
        activeTeamId,
        { error: null },
        { activeTeamId },
      ),
    );
  },
}));

export const designerStoreState = useDesignerStore;
