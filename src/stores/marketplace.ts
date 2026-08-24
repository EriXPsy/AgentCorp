/**
 * src/stores/marketplace.ts
 * 人才市场（S1 初审）状态编排 store（模块 A ·  / §7.1）。
 *
 * 职责：
 * - 持有任务需求 `taskRequirement` 与派生画像 `taskProfile`（taskMatch 确定性词典）；
 * - 持有六维阈值筛选 `dimFilters` 与排序方式 `sortKey`；
 * - 把外部候选源（IPC 模板卡 / 已雇佣 agent）归一为 `MarketCandidateView`，
 *   六维经 `radarSource` 三源解析、匹配分经 `matchScore` 计算；
 * - `runPrescreen`：对无六维候选发起 S1 初审（POST /api/evaluate-stage），
 *   失败时降级为启发式种子，保证离线可用。
 *
 * 数据真相：候选原始数据在页面（IPC 返回），评估域真相在 evaluation/scoring store，
 * 本 store 只做「视图装配 + 排序」，不落库。
 */
import { create } from 'zustand';
import type { EvaluationProfile, JobType, RadarDim, RadarScore, StageScore } from '@/types/evaluation';
import type {
  MarketCandidateView,
  MatchScoreBreakdown,
  TaskProfile,
  TaskRequirement,
} from '@/types/marketplace';
import { requestPrescreen } from '@/services/designerClient';
import { useTeamsStore } from '@/stores/teams';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import {
  heuristicRadar,
  parseBudgetNumber,
  radarMean,
  resolveAgentRadar,
  type HeuristicSeed,
} from '@/engine/marketplace/radarSource';
import { extractTaskProfile, inferJobType, EMPTY_TASK_PROFILE } from '@/engine/marketplace/taskMatch';
import { budgetRefOf, matchScore, sortByMatch } from '@/engine/marketplace/matchScore';
import { paretoRankCandidates } from '@/engine/marketplace/paretoRank';
import { useEvaluationStore } from '@/stores/evaluation';
import { useScoringStore } from '@/stores/scoringStore';
import { getActiveBossProfile } from '@/stores/bossProfile';
import { bossPersonaBoost } from '@/engine/interview/questionBank';
import { getFavorites, getLike } from '@/services/reactionStore';
import { resolveLikeKey } from '@/stores/likesStore';

/** 排序方式：智能匹配 / 初审分 / 报价 / 性价比 / Pareto 前沿 */
export type MarketSortKey = 'match' | 'review' | 'budget' | 'costperf' | 'pareto';

/** 排序方式中文标签（UI 与文案单一真相） */
export const SORT_KEY_LABELS: Record<MarketSortKey, string> = {
  match: '智能匹配',
  review: '初审分',
  budget: '报价（低→高）',
  costperf: '性价比',
  pareto: '质量×成本前沿',
};

/** 六维阈值筛选的循环档位（点击一次进一档） */
export const DIM_THRESHOLD_CYCLE: number[] = [0, 3, 3.5, 4, 4.5];

/** 外部候选源（IPC 模板卡 / 已雇佣 agent 归一入参） */
export interface MarketCandidateSeed {
  id: string;
  /** 已雇佣后产生的真实 agentId（可读评估域档案） */
  agentId?: string;
  name: string;
  description: string;
  tags: string[];
  hireType: 'single' | 'team';
  price: string;
  avatar: string;
  rating: number;
  hiredCount: number;
  /** 团队能力条目（启发式种子用） */
  capabilities?: string[];
  /** 显式工种（缺省时由文本推断） */
  jobType?: JobType | null;
}

/** 六维阈值筛选表（0 = 不过滤） */
export type DimFilters = Record<RadarDim, number>;

const EMPTY_DIM_FILTERS: DimFilters = {
  task: 0,
  quality: 0,
  comm: 0,
  creativity: 0,
  reliability: 0,
  cost: 0,
};

const EMPTY_REQUIREMENT: TaskRequirement = { text: '', jobType: 'all', tags: [] };

interface MarketplaceState {
  /** 任务需求（用户输入） */
  taskRequirement: TaskRequirement;
  /** 派生任务画像（确定性词典解析） */
  taskProfile: TaskProfile;
  /** 六维阈值筛选 */
  dimFilters: DimFilters;
  /** 排序方式 */
  sortKey: MarketSortKey;
  /** 候选视图（已含六维解析与匹配分，按当前 sortKey 排序） */
  candidates: MarketCandidateView[];
  /** 候选原始种子（重算时复用，避免页面重复传入） */
  seeds: MarketCandidateSeed[];
  /** 正在初审的候选 id 集合 */
  prescreening: Record<string, boolean>;
  /** 是否允许启发式兜底六维（默认 false：先让用户点「S1 初审」） */
  allowHeuristic: boolean;
  error: string | null;

  /** 装配候选（页面拿到 IPC 模板后调用） */
  hydrate: (seeds: MarketCandidateSeed[]) => void;
  /** 设置需求文本（自动重解析画像并重排） */
  setTaskText: (text: string) => void;
  /** 设置期望工种 */
  setJobType: (jobType: JobType | 'all') => void;
  /** 设置排序方式 */
  setSortKey: (key: MarketSortKey) => void;
  /** 点击维度 chip：阈值循环 0→3→3.5→4→4.5→0 */
  cycleDimFilter: (dim: RadarDim) => void;
  /** 清空全部维度阈值 */
  resetDimFilters: () => void;
  /** 清空需求 */
  resetRequirement: () => void;
  /** 重算六维解析 + 匹配分 + 排序（userWeight 变化时调用） */
  rescore: () => void;
  /** 装配小红心点赞数 / BossFavorite 名次（reactionStore 读取，best-effort） */
  hydrateReactions: () => Promise<void>;
  /** S1 初审：启发式种子 → POST /api/evaluate-stage；失败降级启发式 */
  runPrescreen: (candidateId: string) => Promise<void>;
  clearError: () => void;
}

/** 由 seed 构造启发式种子入参 */
function toHeuristicSeed(seed: MarketCandidateSeed): HeuristicSeed {
  return {
    name: seed.name,
    description: seed.description,
    tags: seed.tags,
    budgetNum: parseBudgetNumber(seed.price),
    hireType: seed.hireType,
    capabilityCount: seed.capabilities?.length ?? 0,
  };
}

/**
 * 读取某候选的阶段评分卡。
 *
 * 两个来源合并（★通道③：绩效结果 → 市场匹配权重 的读取端）：
 * - scoringStore.stageScores：本次会话刚跑出来的卡（最新，同 agent 仅一张）；
 * - EvaluationProfile.stageScores：已落库的历史卡（scoringStore.runStage 回写），
 *   保证刷新后 S3 绩效卡仍能算出 matchScore.perfBoost，而不是退回中性 0.5。
 * 同一 stage 冲突时以内存镜像为准。
 */
function readStageScores(
  agentId: string | undefined,
  profile?: EvaluationProfile,
): StageScore[] {
  if (!agentId) return [];
  const cached = useScoringStore.getState().stageScores[agentId];
  const persisted = profile?.stageScores ?? [];
  if (!cached) return persisted;
  return [cached, ...persisted.filter((item) => item.stage !== cached.stage)];
}

/**
 * 由 seed + 评估域数据装配单条候选视图（不含 match，match 在 rescore 中统一算）。
 * 已解析过的候选可传入 `keepResolution` 复用（初审后保留结果，避免被重算覆盖）。
 */
function buildCandidate(
  seed: MarketCandidateSeed,
  allowHeuristic: boolean,
  keepResolution?: MarketCandidateView['radarResolution'],
): MarketCandidateView {
  const agentId = seed.agentId;
  const profiles = useEvaluationStore.getState().profiles;
  const profile = agentId ? profiles[agentId] : undefined;

  const resolved = resolveAgentRadar({
    profile,
    stageScores: readStageScores(agentId, profile),
    heuristic: toHeuristicSeed(seed),
    allowHeuristic,
  });

  // 若既有解析结果比新解析「更实」（已初审/已评估），予以保留
  const rank: Record<string, number> = { evaluation: 3, prescreen: 2, heuristic: 1, none: 0 };
  const radarResolution =
    keepResolution && rank[keepResolution.source] > rank[resolved.source]
      ? { ...keepResolution, stageScoreTotal: resolved.stageScoreTotal ?? keepResolution.stageScoreTotal, verdict: resolved.verdict ?? keepResolution.verdict }
      : resolved;

  return {
    id: seed.id,
    agentId: seed.agentId,
    name: seed.name,
    description: seed.description,
    tags: seed.tags,
    hireType: seed.hireType,
    price: seed.price,
    budgetNum: parseBudgetNumber(seed.price),
    avatar: seed.avatar,
    rating: seed.rating,
    hiredCount: seed.hiredCount,
    jobType: seed.jobType ?? inferJobType(`${seed.name} ${seed.description} ${seed.tags.join(' ')}`),
    radarResolution,
  };
}

/** 按 sortKey 排序（纯函数，可单测） */
export function sortCandidates(
  candidates: MarketCandidateView[],
  sortKey: MarketSortKey,
): MarketCandidateView[] {
  if (sortKey === 'match') return sortByMatch(candidates);

  if (sortKey === 'pareto') {
    const ranked = paretoRankCandidates(candidates);
    const frontById = new Map(ranked.map((r) => [r.id, r.front]));
    // 先按前沿升序（0 = 最优），同前沿按质量均值降序
    return [...candidates]
      .map((c) => ({ c, front: frontById.get(c.id) ?? Number.MAX_SAFE_INTEGER }))
      .sort(
        (a, b) =>
          a.front - b.front ||
          radarMean(b.c.radarResolution.radar) - radarMean(a.c.radarResolution.radar),
      )
      .map((item) => item.c);
  }

  const arr = [...candidates];
  if (sortKey === 'budget') {
    arr.sort((a, b) => a.budgetNum - b.budgetNum);
    return arr;
  }
  if (sortKey === 'review') {
    arr.sort((a, b) => radarMean(b.radarResolution.radar) - radarMean(a.radarResolution.radar));
    return arr;
  }
  // costperf：能力均值 / 报价（免费视为 1 元，避免除零）
  const perf = (c: MarketCandidateView) =>
    (radarMean(c.radarResolution.radar) * 100) / Math.max(1, c.budgetNum);
  arr.sort((a, b) => perf(b) - perf(a));
  return arr;
}

/** 六维阈值硬过滤（纯函数，可单测）：无六维的候选在有阈值时被过滤掉 */
export function applyDimFilters(
  candidates: MarketCandidateView[],
  filters: DimFilters,
): MarketCandidateView[] {
  const active = RADAR_DIMS.filter((dim) => (filters[dim] ?? 0) > 0);
  if (active.length === 0) return candidates;
  return candidates.filter((c) => {
    const radar = c.radarResolution.radar;
    if (!radar) return false;
    return active.every((dim) => (radar[dim] ?? 0) >= filters[dim]);
  });
}

export const useMarketplaceStore = create<MarketplaceState>((set, get) => ({
  taskRequirement: { ...EMPTY_REQUIREMENT },
  taskProfile: { ...EMPTY_TASK_PROFILE },
  dimFilters: { ...EMPTY_DIM_FILTERS },
  sortKey: 'match',
  candidates: [],
  seeds: [],
  prescreening: {},
  allowHeuristic: false,
  error: null,

  hydrate: (seeds) => {
    const { allowHeuristic } = get();
    const prev = new Map(get().candidates.map((c) => [c.id, c] as const));
    const built = seeds.map((seed) =>
      buildCandidate(seed, allowHeuristic, prev.get(seed.id)?.radarResolution),
    );
    set({ seeds, candidates: built });
    get().rescore();
  },

  setTaskText: (text) => {
    const jobType = get().taskRequirement.jobType;
    const profile = extractTaskProfile(text, jobType);
    set({
      taskRequirement: { text, jobType, tags: profile.tags },
      taskProfile: profile,
    });
    get().rescore();
  },

  setJobType: (jobType) => {
    const text = get().taskRequirement.text;
    const profile = extractTaskProfile(text, jobType);
    set({
      taskRequirement: { text, jobType, tags: profile.tags },
      taskProfile: profile,
    });
    get().rescore();
  },

  setSortKey: (key) => {
    set((s) => ({ sortKey: key, candidates: sortCandidates(s.candidates, key) }));
  },

  cycleDimFilter: (dim) => {
    set((s) => {
      const current = s.dimFilters[dim] ?? 0;
      const idx = DIM_THRESHOLD_CYCLE.indexOf(current);
      const next = DIM_THRESHOLD_CYCLE[(idx + 1) % DIM_THRESHOLD_CYCLE.length];
      return { dimFilters: { ...s.dimFilters, [dim]: next } };
    });
  },

  resetDimFilters: () => set({ dimFilters: { ...EMPTY_DIM_FILTERS } }),

  resetRequirement: () =>
    set({
      taskRequirement: { ...EMPTY_REQUIREMENT },
      taskProfile: { ...EMPTY_TASK_PROFILE },
    }),

  rescore: () => {
    const { candidates, taskProfile, sortKey } = get();
    const userWeight = useScoringStore.getState().userWeight;
    const budgetRef = budgetRefOf(candidates);
    // D · 老板原型强调：让市场契合度按「与谁协作」个性化（中性原型 → {} → 不改变排序）
    const personaBoost = bossPersonaBoost(getActiveBossProfile());

    const scored: MarketCandidateView[] = candidates.map((c) => {
      const breakdown: MatchScoreBreakdown | null = matchScore(
        {
          id: c.id,
          tags: c.tags,
          budgetNum: c.budgetNum,
          radar: c.radarResolution.radar,
          stageScoreTotal: c.radarResolution.stageScoreTotal ?? null,
          jobType: c.jobType,
        },
        taskProfile,
        { userWeight, budgetRef, personaBoost },
      );
      return { ...c, match: breakdown ?? undefined };
    });

    set({ candidates: sortCandidates(scored, sortKey) });
  },

  hydrateReactions: async () => {
    const { candidates } = get();
    const jobs = new Set<JobType>();
    for (const c of candidates) if (c.jobType) jobs.add(c.jobType);

    // 并行拉取各工种青睐榜 + 各候选点赞
    const [rankings, likes] = await Promise.all([
      Promise.all([...jobs].map((j) => getFavorites(j).catch(() => null))),
      Promise.all(
        candidates.map((c) => getLike(resolveLikeKey(c)).catch(() => null)),
      ),
    ]);
    const rankByAgent = new Map<string, number>();
    const favCountByAgent = new Map<string, number>();
    rankings.forEach((ranking) => {
      if (!ranking) return;
      ranking.ranking.forEach((entry, idx) => {
        rankByAgent.set(entry.agentId, idx + 1);
        favCountByAgent.set(entry.agentId, entry.count);
      });
    });
    const likeByAgent = new Map<string, { count: number; likedByMe: boolean }>();
    likes.forEach((rec) => {
      if (!rec) return;
      likeByAgent.set(rec.agentId, { count: rec.count, likedByMe: rec.likedByMe });
    });

    const enriched: MarketCandidateView[] = candidates.map((c) => {
      const key = resolveLikeKey(c);
      const like = likeByAgent.get(key);
      return {
        ...c,
        likeCount: like?.count ?? 0,
        likedByMe: like?.likedByMe ?? false,
        favoriteRank: rankByAgent.get(key) ?? undefined,
        favoriteCount: favCountByAgent.get(key) ?? undefined,
      };
    });
    set({ candidates: enriched });
  },

  runPrescreen: async (candidateId) => {
    const candidate = get().candidates.find((c) => c.id === candidateId);
    const seed = get().seeds.find((s) => s.id === candidateId);
    if (!candidate || !seed) return;
    if (get().prescreening[candidateId]) return;

    set((s) => ({ prescreening: { ...s.prescreening, [candidateId]: true }, error: null }));

    // 启发式兜底雷达（LLM 不可用时用）
    const seedRadar: RadarScore = heuristicRadar(toHeuristicSeed(seed));
    let nextResolution = { ...candidate.radarResolution };

    try {
      // 取用户第一个团队作为需求侧上下文
      const teams = useTeamsStore.getState().teams;
      const teamId = teams[0]?.id;

      const result = await requestPrescreen({
        candidate_name: seed.name,
        candidate_description: seed.description,
        candidate_capabilities: seed.capabilities ?? [],
        team_id: teamId ?? '',
      });

      if (!result.degraded && Object.keys(result.radar).length > 0) {
        // 真实初审成功：用 LLM 评分
        nextResolution = {
          radar: result.radar as unknown as RadarScore,
          source: 'prescreen',
          confidence: result.confidence,
        };
      } else {
        // LLM 不可用：降级启发式
        nextResolution = { radar: seedRadar, source: 'heuristic', confidence: 0.3 };
        set({ error: result.degraded_reason || 'S1 初审降级为启发式' });
      }
    } catch (e) {
      nextResolution = { radar: seedRadar, source: 'heuristic', confidence: 0.3 };
      set({ error: e instanceof Error ? e.message : 'S1 初审失败' });
    }

    set((s) => ({
      candidates: s.candidates.map((c) =>
        c.id === candidateId ? { ...c, radarResolution: nextResolution } : c,
      ),
      prescreening: { ...s.prescreening, [candidateId]: false },
    }));
    get().rescore();
  },

  clearError: () => set({ error: null }),
}));

export const marketplaceStore = useMarketplaceStore;
