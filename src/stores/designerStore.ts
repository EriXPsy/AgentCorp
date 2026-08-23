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
import { requestChallenge, submitReflection, loadMemory } from '@/services/designerClient';
import type {
  ChallengeResponse,
  ReflectResponse,
  StyleMemory,
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

  /** 加载团队的 StyleMemory */
  fetchMemory: (teamId: string) => Promise<void>;
  /** 请求 Designer 出题 */
  requestChallenge: (teamId: string, opts?: { jobType?: string; description?: string; memberCount?: number }) => Promise<ChallengeResponse | null>;
  /** 评估后触发反思 */
  reflect: (teamId: string, taskId: string, answer: string, scores: Record<string, number>, outcome: string) => Promise<ReflectResponse | null>;
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

  reset: () => set({
    memory: null,
    teamId: null,
    currentChallenge: null,
    lastReflection: null,
    loading: false,
    error: null,
  }),

  clearError: () => set({ error: null }),
}));
