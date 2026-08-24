/**
 * src/stores/designerStore.ts
 * SPADE Designer Zustand store：StyleMemory 状态 + 出题/反思动作。
 *
 * 设计：
 * - StyleMemory 按 team_id 缓存，切换团队时自动加载
 * - 反思在评估完成后异步触发，不阻塞评估主流程
 * - 出题失败时优雅降级（保留旧 challenge）
 */
import { create } from 'zustand';
import { requestChallenge, submitReflection, loadMemory, submitAgentReflection, loadAgentMemory, fetchTeamGaps, fetchTeamRadar } from '@/services/designerClient';
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
  /** 当前团队的 StyleMemory（null = 尚未加载） */
  memory: StyleMemory | null;
  /** 当前团队 ID */
  teamId: string | null;
  /** 最近一次出题结果 */
  currentChallenge: ChallengeResponse | null;
  /** 最近一次反思结果 */
  lastReflection: ReflectResponse | null;
  /** 加载/提交中 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;

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

  /** 加载团队的 StyleMemory */
  fetchMemory: (teamId: string) => Promise<void>;
  /** 请求 Designer 出题 */
  requestChallenge: (teamId: string, opts?: { jobType?: string; description?: string; memberCount?: number }) => Promise<ChallengeResponse | null>;
  /** 评估后触发团队反思 */
  reflect: (teamId: string, taskId: string, answer: string, scores: Record<string, number>, outcome: string) => Promise<ReflectResponse | null>;
  /** 评估后触发 Agent 个人反思 */
  reflectAgent: (agentId: string, teamId: string, taskId: string, answer: string, scores: Record<string, number>, outcome: string) => Promise<AgentReflectResponse | null>;
  /** 加载单个 Agent 成长档案 */
  fetchAgentMemory: (agentId: string) => Promise<void>;
  /** 分析团队能力缺口（驱动主动招聘通知） */
  fetchTeamGaps: (teamId: string) => Promise<TeamGapResponse | null>;
  /** 加载团队六维雷达数据 */
  fetchTeamRadar: (teamId: string) => Promise<TeamRadarResponse | null>;
  /** 清空状态（切换团队时） */
  reset: () => void;
  clearError: () => void;
}

export const useDesignerStore = create<DesignerState>((set, get) => ({
  memory: null,
  teamId: null,
  currentChallenge: null,
  lastReflection: null,
  loading: false,
  error: null,
  agentMemories: {},
  lastAgentReflection: null,
  teamGaps: {},
  notifiedGapKeys: [],
  teamRadars: {},

  fetchMemory: async (teamId) => {
    // 已加载过同一团队则跳过
    if (get().teamId === teamId && get().memory) return;
    set({ loading: true, error: null, teamId });
    try {
      const memory = await loadMemory(teamId);
      set({ memory, loading: false });
    } catch (e) {
      // 404 = 团队还没出过题，尚无 StyleMemory——这是正常初始状态
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('404') || msg.includes('不存在')) {
        set({ memory: null, loading: false, teamId });
      } else {
        set({ error: msg, loading: false });
      }
    }
  },

  requestChallenge: async (teamId, opts) => {
    set({ loading: true, error: null, teamId });
    try {
      const challenge = await requestChallenge({
        team_id: teamId,
        job_type: opts?.jobType ?? 'code',
        description: opts?.description ?? '',
        member_count: opts?.memberCount ?? 0,
      });
      set({ currentChallenge: challenge, loading: false });
      // 出题后刷新 memory（challenges_issued 已更新）
      void get().fetchMemory(teamId);
      return challenge;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false });
      return null;
    }
  },

  reflect: async (teamId, taskId, answer, scores, outcome) => {
    // 反思不阻塞主流程——静默失败，只记录错误
    try {
      const result = await submitReflection({
        team_id: teamId,
        task_id: taskId,
        answer,
        scores,
        outcome,
      });
      set({ lastReflection: result });
      // 反思后刷新 memory（observations/understanding 已更新）
      void get().fetchMemory(teamId);
      return result;
    } catch (e) {
      // 静默失败：反思是增强功能，不应中断评估主流程
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
          [agentId]: {
            ...(state.agentMemories[agentId] ?? {} as AgentMemory),
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
            avg_scores: {},
          } as AgentMemory,
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
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('404') && !msg.includes('不存在')) {
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
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('404') && !msg.includes('不存在')) {
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
      // 404 = 该 agent 尚无档案，正常初始状态
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('404') && !msg.includes('不存在')) {
        console.warn('[designerStore] load agent memory failed:', e);
      }
    }
  },

  reset: () => set({
    memory: null,
    teamId: null,
    currentChallenge: null,
    lastReflection: null,
    loading: false,
    error: null,
    agentMemories: {},
    lastAgentReflection: null,
    teamGaps: {},
    notifiedGapKeys: [],
    teamRadars: {},
  }),

  clearError: () => set({ error: null }),
}));
