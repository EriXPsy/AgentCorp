import { useState, useMemo, useEffect, useCallback, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Building2, User, X, Bot, Users, Loader2, Upload, Sparkles, Shield, Code, BarChart3, PenTool, Headphones, Store } from 'lucide-react';
import { useAgentsStore } from '@/stores/agents';
import { useTeamsStore } from '@/stores/teams';
import { invokeIpc } from '@/lib/api-client';
import { isBrowserPreviewMode } from '@/lib/browser-preview';
import { getPreviewMarketplaceTemplates } from '@/lib/office-preview-seed';

// Agent 上传面板（嵌入市集，不作为独立页面）
const AgentUpload = lazy(() => import('@/components/upload/AgentUpload').then((m) => ({ default: m.AgentUpload })));
// —— 模块 A 增量：智能匹配（六维解析 + matchScore 排序 + S1 初审）——
import {
  useMarketplaceStore,
  applyDimFilters,
  type MarketCandidateSeed,
} from '@/stores/marketplace';
import { useScoringStore } from '@/stores/scoringStore';
import { getActiveBossProfile, useBossProfileStore } from '@/stores/bossProfile';
import {
  MarketSearchBar,
  type HireTypeFilter,
} from '@/components/marketplace/MarketSearchBar';
import { MarketCandidateCard } from '@/components/marketplace/MarketCandidateCard';
import { GithubImportBar, type GithubImportedCandidate } from '@/components/marketplace/GithubImportBar';
import type { MarketCandidateView } from '@/types/marketplace';

type HireType = '雇佣团队' | '雇佣员工';

type MarketplaceTemplate = {
  id: string;
  name: string;
  description: string;
  emoji: string;
  vibe: string;
  role: string;
  hireType: 'single' | 'team';
  capabilities: string[];
  tags: string[];
  price: string;
  avatar: string;
  rating: number;
  hiredCount: number;
};

type TemplateListResponse = {
  success: boolean;
  templates?: MarketplaceTemplate[];
  error?: string;
};

type HireSingleResponse = {
  success: boolean;
  agentId?: string;
  workspacePath?: string;
  error?: string;
};

type HireTeamResponse = {
  success: boolean;
  leaderId?: string;
  workerIds?: string[];
  teamId?: string;
  teamName?: string;
  error?: string;
};

const HIRE_TYPES: HireType[] = ['雇佣团队', '雇佣员工'];

// ── 模板团队定义 ──────────────────────────────────────────────────
interface TeamTemplate {
  id: string;
  name: string;
  emoji: string;
  description: string;
  members: { role: string; capability: string; icon: typeof Code }[];
  tags: string[];
  hireType: 'team';
}

const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: 'tpl-fullstack-squad',
    name: '全栈开发小队',
    emoji: '⚡',
    description: '前后端通吃的敏捷团队，适合从 0 到 1 快速搭建产品',
    members: [
      { role: '架构师', capability: '系统设计、技术选型', icon: Code },
      { role: '前端工程师', capability: 'React/Vue、UI 实现', icon: PenTool },
      { role: '后端工程师', capability: 'API 设计、数据库', icon: Code },
      { role: '测试工程师', capability: '自动化测试、QA', icon: Shield },
    ],
    tags: ['全栈', '敏捷', 'MVP'],
    hireType: 'team',
  },
  {
    id: 'tpl-data-team',
    name: '数据分析团队',
    emoji: '📊',
    description: '数据采集到可视化一条龙，让数据驱动决策',
    members: [
      { role: '数据工程师', capability: 'ETL、数据管道', icon: Code },
      { role: '分析师', capability: '统计分析、报表', icon: BarChart3 },
      { role: '可视化专家', capability: '图表、Dashboard', icon: PenTool },
    ],
    tags: ['数据', '分析', '可视化'],
    hireType: 'team',
  },
  {
    id: 'tpl-content-studio',
    name: '内容创作工作室',
    emoji: '✍️',
    description: '文案+设计+运营的全能内容团队',
    members: [
      { role: '文案策划', capability: '文案、创意、脚本', icon: PenTool },
      { role: '设计师', capability: '视觉设计、排版', icon: PenTool },
      { role: '运营专家', capability: '增长策略、用户运营', icon: Headphones },
    ],
    tags: ['内容', '创意', '运营'],
    hireType: 'team',
  },
];

export function Marketplace() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('全部');
  const [activeHireType, setActiveHireType] = useState<HireTypeFilter>('全部');
  const [showListingModal, setShowListingModal] = useState(false);
  const [showPurchasedModal, setShowPurchasedModal] = useState(false);
  const [purchasedAgentName, setPurchasedAgentName] = useState('');
  const [purchasedType, setPurchasedType] = useState<'single' | 'team'>('single');
  const [purchasedCount, setPurchasedCount] = useState(1);
  const [purchasing, setPurchasing] = useState(false);
  const [purchasingId, setPurchasingId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<MarketplaceTemplate[]>([]);
  // GitHub 导入的候选（与本地模板并列进入市集；不带任何初始能力分）
  const [githubImports, setGithubImports] = useState<GithubImportedCandidate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);

  const { fetchAgents } = useAgentsStore();
  const { teams, fetchTeams } = useTeamsStore();
  // Tab 结构：发现人才 / 我的团队 / 上传 Agent
  const [activeTab, setActiveTab] = useState<'discover' | 'teams' | 'upload'>('discover');

  // —— 模块 A：市场智能匹配 store ——
  const candidates = useMarketplaceStore((s) => s.candidates);
  const dimFilters = useMarketplaceStore((s) => s.dimFilters);
  const prescreening = useMarketplaceStore((s) => s.prescreening);
  const marketError = useMarketplaceStore((s) => s.error);
  const hydrateCandidates = useMarketplaceStore((s) => s.hydrate);
  const rescoreCandidates = useMarketplaceStore((s) => s.rescore);
  const runPrescreen = useMarketplaceStore((s) => s.runPrescreen);
  const resetDimFilters = useMarketplaceStore((s) => s.resetDimFilters);
  const resetRequirement = useMarketplaceStore((s) => s.resetRequirement);
  const hydrateReactions = useMarketplaceStore((s) => s.hydrateReactions);
  // 心智权重（绩效双榜拖拽回灌后变化）→ 市场排序即时刷新
  const userWeight = useScoringStore((s) => s.userWeight);
  // D · 老板原型（用户个性化）：订阅激活原型，切换时重排市场以反映 per-user FIT
  const activeBossId = useBossProfileStore((s) => s.activeId);
  const activeBoss = getActiveBossProfile();
  const personalized = activeBoss.id !== 'neutral';

  // Fetch real templates from bundled resources
  useEffect(() => { void fetchTeams(); }, [fetchTeams]);

  useEffect(() => {
    async function loadTemplates() {
      try {
        const res = await invokeIpc<TemplateListResponse>('marketplace:listTemplates');
        if (res.success && res.templates && res.templates.length > 0) {
          setTemplates(res.templates);
        } else if (isBrowserPreviewMode()) {
          // Web 预览：IPC 无后端，回退到本地种子模板（与 Office 数据一致）
          setTemplates(getPreviewMarketplaceTemplates());
        }
      } catch (err) {
        console.error('Failed to load marketplace templates:', err);
        // 拉取失败且处于 web 预览：同样回退，避免「加载失败 / 空市集」
        if (isBrowserPreviewMode()) {
          setTemplates(getPreviewMarketplaceTemplates());
        }
      } finally {
        setLoadingTemplates(false);
      }
    }
    void loadTemplates();
  }, []);

  // D · 激活老板原型变化 → 立即按 per-user FIT 重排市场（个性化推荐即时生效）
  useEffect(() => {
    rescoreCandidates();
  }, [activeBossId, rescoreCandidates]);

  // 模板 → 候选种子（六维解析与匹配分在 store 内完成）
  useEffect(() => {
    if (templates.length === 0 && githubImports.length === 0) return;
    const seeds: MarketCandidateSeed[] = templates.map((tpl) => ({
      id: tpl.id,
      name: tpl.name,
      description: tpl.description,
      tags: tpl.tags,
      hireType: tpl.hireType,
      price: tpl.price,
      avatar: tpl.avatar,
      rating: tpl.rating,
      hiredCount: tpl.hiredCount,
      capabilities: tpl.capabilities,
    }));
    // GitHub 导入卡与本地模板并列进场。rating 传 0 表示「无评分」而不是「差评」：
    // 排序依据是六维实测与任务匹配分，六维为空时走「待初审」分支，
    // 因此新导入的项目不会因为没人用过就被压到列表底部。
    for (const item of githubImports) {
      seeds.push({
        id: item.id,
        name: item.name,
        description: item.description,
        tags: item.tags,
        hireType: 'single',
        price: item.price,
        avatar: item.avatar,
        rating: 0,
        hiredCount: item.hiredCount,
        jobType: item.jobType,
      });
    }
    hydrateCandidates(seeds);
  }, [templates, githubImports, hydrateCandidates]);

  // 心智权重变化 → 重算匹配分并重排（绩效结果回灌市场的可见执行点）
  useEffect(() => {
    rescoreCandidates();
  }, [userWeight, rescoreCandidates]);

  // 装配小红心 / BossFavorite 视图字段（best-effort，失败不影响卡片渲染）
  useEffect(() => {
    void hydrateReactions();
  }, [hydrateReactions, candidates.length]);

  // 初审失败等提示（网络不可用时降级启发式，不阻塞流程）
  useEffect(() => {
    if (marketError) toast.message(marketError);
  }, [marketError]);

  /** 关键词 / 标签 / 雇佣形态过滤（保持既有交互）+ 六维门槛硬过滤（新增） */
  const visibleCandidates = useMemo(() => {
    const byDim = applyDimFilters(candidates, dimFilters);
    const q = searchQuery.trim().toLowerCase();
    return byDim.filter((c) => {
      const matchesSearch =
        !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q);
      const matchesFilter =
        activeFilter === '全部' || c.tags.some((tag) => tag.includes(activeFilter));
      const hireType: HireType = c.hireType === 'team' ? '雇佣团队' : '雇佣员工';
      const matchesHireType = activeHireType === '全部' || hireType === activeHireType;
      return matchesSearch && matchesFilter && matchesHireType;
    });
  }, [candidates, dimFilters, searchQuery, activeFilter, activeHireType]);

  /**
   * 雇佣流程（既有 IPC 逻辑原样保留，仅从内联卡片抽取为回调）。
   * 团队雇佣需要 capabilities，从原始模板中回查。
   */
  const handleHire = useCallback(
    async (candidate: MarketCandidateView) => {
      if (purchasingId) return;
      const tpl = templates.find((t) => t.id === candidate.id);
      const capabilities = tpl?.capabilities ?? [];
      setPurchasingId(candidate.id);
      setPurchasing(true);
      try {
        if (candidate.hireType === 'team') {
          const res = await invokeIpc<HireTeamResponse>(
            'marketplace:hireTeam',
            candidate.id,
            candidate.name,
            capabilities,
          );
          if (!res.success) {
            throw new Error(res.error || '雇佣团队失败');
          }
          await fetchTeams();
          setPurchasedAgentName(candidate.name);
          setPurchasedType('team');
          setPurchasedCount(capabilities.length + 1);
        } else {
          const res = await invokeIpc<HireSingleResponse>(
            'marketplace:hireSingle',
            candidate.id,
            candidate.name,
          );
          if (!res.success) {
            throw new Error(res.error || '雇佣员工失败');
          }
          setPurchasedAgentName(candidate.name);
          setPurchasedType('single');
          setPurchasedCount(1);
        }

        await fetchAgents();
        setShowPurchasedModal(true);
      } catch (err) {
        toast.error(`雇佣 ${candidate.name} 失败: ${String(err)}`);
      } finally {
        setPurchasing(false);
        setPurchasingId(null);
      }
    },
    [purchasingId, templates, fetchAgents, fetchTeams],
  );

  return (
    <div className="tech-bg h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-7xl space-y-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="flex items-start justify-between"
        >
          <div>
            <h1 className="text-4xl font-bold tracking-tight text-[#1A1C1E]">
              {t('marketplace.title', '人才市集')}
            </h1>
            <p className="mt-2 text-lg text-gray-500">
              {t('marketplace.subtitle', '发现并雇佣全球最顶尖的数字员工')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowListingModal(true)}
            className="flex items-center gap-2 rounded-full bg-[#1A1C1E] px-8 py-3 text-sm font-bold text-white shadow-xl transition-all hover:scale-105 hover:bg-[#FF6B4A]"
          >
            <Plus size={18} />
            {t('marketplace.listEmployee', '上架我的员工')}
          </button>
        </motion.div>

        {/* GitHub 一键导入：让「新发布的开源 agent」也能公平进场 */}
        <GithubImportBar onChange={setGithubImports} />

        {/* ═══ Tab 导航 ═══ */}
        <div className="flex gap-1 rounded-full bg-[#F2F0E9] p-1">
          {([
            { key: 'discover' as const, label: '发现人才', icon: Store },
            { key: 'teams' as const, label: `我的团队${teams.length > 0 ? ` (${teams.length})` : ''}`, icon: Users },
            { key: 'upload' as const, label: '上传 Agent', icon: Upload },
          ]).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setActiveTab(key)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-full px-5 py-2.5 text-[13px] font-bold transition-all ${
                activeTab === key
                  ? 'bg-white text-[#1A1C1E] shadow-sm'
                  : 'text-gray-400 hover:text-[#1A1C1E]'
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        {/* ═══ Tab: 发现人才 ═══ */}
        {activeTab === 'discover' && (
          <div className="space-y-5">
            <MarketSearchBar
              keyword={searchQuery}
              onKeywordChange={setSearchQuery}
              activeTag={activeFilter}
              onTagChange={setActiveFilter}
              hireType={activeHireType}
              onHireTypeChange={setActiveHireType}
              teamCount={templates.filter((a) => a.hireType === 'team').length}
              singleCount={templates.filter((a) => a.hireType === 'single').length}
            />
            {personalized ? (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#FF6B4A]/30 bg-[#FF6B4A]/5 px-3 py-2 text-[11px]">
                <span className="font-bold text-[#1A1C1E] dark:text-white">
                  按「{activeBoss.name ?? activeBoss.id}」个性化
                </span>
                <span className="text-gray-400">
                  市场排序已随该老板原型强调的维度加权
                </span>
              </div>
            ) : null}
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3 items-stretch">
              {loadingTemplates && (
                <div className="col-span-full flex flex-col items-center justify-center py-20">
                  <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
                  <p className="mt-3 text-sm font-bold text-gray-400">加载人才市集...</p>
                </div>
              )}
              {!loadingTemplates &&
                visibleCandidates.map((candidate, i) => (
                  <MarketCandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    index={i}
                    hiring={purchasing && purchasingId === candidate.id}
                    hireDisabled={purchasing && purchasingId !== candidate.id}
                    prescreening={!!prescreening[candidate.id]}
                    onHire={handleHire}
                    onPrescreen={(c) => void runPrescreen(c.id)}
                  />
                ))}
            </div>
            {!loadingTemplates && visibleCandidates.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20">
                <p className="text-lg font-bold text-gray-400">
                  {t('marketplace.empty', '没有找到匹配的 Agent')}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setActiveFilter('全部');
                    setActiveHireType('全部');
                    resetDimFilters();
                    resetRequirement();
                  }}
                  className="mt-4 rounded-full bg-[#1A1C1E] px-6 py-2.5 text-sm font-bold text-white transition-colors hover:bg-[#FF6B4A]"
                >
                  {t('marketplace.clearFilters', '清除筛选')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ═══ Tab: 我的团队 ═══ */}
        {activeTab === 'teams' && (
          <div className="space-y-8">
            {/* 当前团队 */}
            {teams.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-bold text-[#1A1C1E]">我的团队</h2>
                  <span className="rounded-full bg-[#F2F0E9] px-3 py-1 text-[11px] font-bold text-gray-500">
                    {teams.length} 个团队
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {teams.map((team) => (
                    <div
                      key={team.id}
                      className="rounded-2xl border border-gray-100 bg-white/80 p-5 transition-all hover:border-[#FFD233]/50 hover:shadow-md"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#F2F0E9] text-base">
                          👥
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px] font-bold text-[#1A1C1E]">{team.name}</p>
                          <p className="text-[11px] text-gray-400">
                            {team.memberCount} 人 · Leader: {team.leaderName || '未指定'}
                          </p>
                        </div>
                      </div>
                      {team.description && (
                        <p className="mt-2.5 text-[11px] leading-relaxed text-gray-400 line-clamp-2">
                          {team.description}
                        </p>
                      )}
                      {team.memberAvatars.length > 0 && (
                        <div className="mt-3 flex items-center justify-between">
                          <div className="flex -space-x-2">
                            {team.memberAvatars.slice(0, 5).map((m) => (
                              <div
                                key={m.id}
                                title={m.name}
                                className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-[#F2F0E9] text-[10px] font-bold text-[#1A1C1E]"
                              >
                                {m.name.slice(0, 1)}
                              </div>
                            ))}
                            {team.memberCount > 5 && (
                              <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-gray-100 text-[9px] text-gray-500">
                                +{team.memberCount - 5}
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => navigate(`/team-map/${team.id}`)}
                            className="rounded-full border border-gray-200 px-3 py-1 text-[10px] font-bold text-gray-500 transition-all hover:border-[#FFD233] hover:text-[#1A1C1E]"
                          >
                            查看
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 模板团队 */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-lg font-bold text-[#1A1C1E]">
                  <Sparkles size={16} className="text-[#FFD233]" />
                  模板团队
                </h2>
                <span className="text-[11px] text-gray-400">一键雇佣完整团队</span>
              </div>
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
                {TEAM_TEMPLATES.map((tpl) => (
                  <div
                    key={tpl.id}
                    className="group rounded-2xl border border-gray-100 bg-white/80 p-6 transition-all hover:border-[#FFD233]/50 hover:shadow-lg"
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-3xl">{tpl.emoji}</span>
                      <div className="flex-1">
                        <p className="text-[15px] font-bold text-[#1A1C1E]">{tpl.name}</p>
                        <p className="mt-0.5 text-[11px] text-gray-400">{tpl.members.length} 人团队</p>
                      </div>
                    </div>
                    <p className="mt-3 text-[12px] leading-relaxed text-gray-500">{tpl.description}</p>
                    <div className="mt-4 space-y-1.5">
                      {tpl.members.map((m) => (
                        <div key={m.role} className="flex items-center gap-2 rounded-xl bg-[#F2F0E9]/60 px-3 py-1.5">
                          <m.icon size={12} className="text-gray-500" />
                          <span className="text-[11px] font-bold text-[#1A1C1E]">{m.role}</span>
                          <span className="text-[10px] text-gray-400">· {m.capability}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 flex items-center justify-between border-t border-gray-50 pt-3">
                      <div className="flex gap-1">
                        {tpl.tags.map((tag) => (
                          <span key={tag} className="rounded bg-gray-100 px-1.5 py-0.5 text-[9px] text-gray-500">
                            {tag}
                          </span>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="rounded-full bg-[#1A1C1E] px-5 py-2 text-[11px] font-bold text-white transition-all hover:bg-[#FF6B4A] group-hover:scale-105"
                      >
                        雇佣团队
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ═══ Tab: 上传 Agent ═══ */}
        {activeTab === 'upload' && (
          <div className="mx-auto max-w-2xl">
            <div className="rounded-2xl border border-gray-100 bg-white/80 p-6">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1A1C1E] text-white">
                  <Upload size={16} />
                </div>
                <div>
                  <h2 className="text-[15px] font-bold text-[#1A1C1E]">上传我的 Agent</h2>
                  <p className="text-[11px] text-gray-400">GitHub / 手动 / JSON · 上传后自动归队并触发 Designer 出题</p>
                </div>
              </div>
              <Suspense fallback={<div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>}>
                <AgentUpload />
              </Suspense>
            </div>
          </div>
        )}
      </div>

      {/* List Employee Modal */}
      <AnimatePresence>
        {showListingModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
            onClick={() => setShowListingModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.3 }}
              className="relative mx-4 w-full max-w-lg rounded-[32px] bg-white p-8 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setShowListingModal(false)}
                className="absolute right-6 top-6 rounded-full p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              >
                <X size={20} />
              </button>

              <h2 className="text-2xl font-bold text-[#1A1C1E]">
                {t('marketplace.listTitle', '上架我的员工')}
              </h2>
              <p className="mt-2 text-sm text-gray-500">
                {t('marketplace.listSubtitle', '将你的 Agent 发布到市集，让更多团队发现和雇佣')}
              </p>

              <div className="mt-6 space-y-4">
                <div>
                  <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.2em] text-gray-400">
                    {t('marketplace.agentName', 'Agent 名称')}
                  </label>
                  <input
                    type="text"
                    placeholder={t('marketplace.agentNamePlaceholder', '给你的 Agent 取个名字')}
                    className="h-12 w-full rounded-2xl border border-gray-100 bg-[#F2F0E9]/50 px-4 text-sm font-bold text-[#1A1C1E] placeholder:text-gray-400 focus:border-[#FFD233] focus:outline-none focus:ring-2 focus:ring-[#FFD233]/20"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.2em] text-gray-400">
                    {t('marketplace.agentType', '上架类型')}
                  </label>
                  <div className="flex gap-3">
                    {HIRE_TYPES.map((type) => (
                      <button
                        key={type}
                        type="button"
                        className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-gray-100 bg-white px-4 py-3 text-sm font-bold text-[#1A1C1E] transition-all hover:border-[#FFD233] hover:bg-[#FFD233]/10 focus:border-[#FFD233] focus:ring-2 focus:ring-[#FFD233]/20"
                      >
                        {type === '雇佣团队' ? <Building2 size={16} /> : <User size={16} />}
                        {type === '雇佣团队'
                          ? t('marketplace.typeCompany', '团队 (SOP 工作流)')
                          : t('marketplace.typeEmployee', '员工 (单个 Agent)')}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.2em] text-gray-400">
                    {t('marketplace.agentDesc', '简介')}
                  </label>
                  <textarea
                    rows={3}
                    placeholder={t('marketplace.agentDescPlaceholder', '描述你的 Agent 能做什么...')}
                    className="w-full rounded-2xl border border-gray-100 bg-[#F2F0E9]/50 px-4 py-3 text-sm font-bold text-[#1A1C1E] placeholder:text-gray-400 focus:border-[#FFD233] focus:outline-none focus:ring-2 focus:ring-[#FFD233]/20"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.2em] text-gray-400">
                    {t('marketplace.agentPrice', '定价')}
                  </label>
                  <input
                    type="text"
                    placeholder={t('marketplace.agentPricePlaceholder', '例如 ¥299/月 或 免费')}
                    className="h-12 w-full rounded-2xl border border-gray-100 bg-[#F2F0E9]/50 px-4 text-sm font-bold text-[#1A1C1E] placeholder:text-gray-400 focus:border-[#FFD233] focus:outline-none focus:ring-2 focus:ring-[#FFD233]/20"
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowListingModal(false)}
                className="mt-6 w-full rounded-full bg-[#1A1C1E] py-4 text-sm font-bold text-white shadow-xl transition-all hover:scale-[1.02] hover:bg-[#FF6B4A]"
              >
                {t('marketplace.submitListing', '提交上架')}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Purchase Success Modal */}
      <AnimatePresence>
        {showPurchasedModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
            onClick={() => { setShowPurchasedModal(false); navigate('/team-overview'); }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              className="relative mx-4 w-full max-w-sm rounded-[32px] bg-white p-8 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Checkmark circle */}
              <div className="mb-6 flex justify-center">
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ delay: 0.1, type: 'spring', stiffness: 200, damping: 15 }}
                  className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-50"
                >
                  {purchasedType === 'team' ? (
                    <Users className="h-10 w-10 text-emerald-500" />
                  ) : (
                    <Bot className="h-10 w-10 text-emerald-500" />
                  )}
                </motion.div>
              </div>

              {/* Title */}
              <div className="text-center">
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                >
                  <h2 className="text-2xl font-bold text-[#1A1C1E]">已购买</h2>
                  <p className="mt-2 text-base font-medium text-emerald-500">购买成功</p>
                </motion.div>

                {/* Info */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="mt-4 space-y-2"
                >
                  <div className="inline-flex items-center gap-2 rounded-full bg-[#F2F0E9] px-4 py-2">
                    {purchasedType === 'team' ? (
                      <Users className="h-4 w-4 text-gray-500" />
                    ) : (
                      <Bot className="h-4 w-4 text-gray-500" />
                    )}
                    <span className="text-sm font-bold text-[#1A1C1E]">{purchasedAgentName}</span>
                  </div>
                  <p className="text-sm text-gray-400">
                    {purchasedType === 'team'
                      ? `包含 ${purchasedCount} 个成员`
                      : '已添加至你的人力资产'}
                  </p>
                </motion.div>

                {/* CTA */}
                <motion.button
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 }}
                  type="button"
                  onClick={() => { setShowPurchasedModal(false); navigate('/team-overview'); }}
                  className="mt-6 w-full rounded-full bg-[#1A1C1E] py-4 text-sm font-bold text-white shadow-xl transition-all hover:bg-[#FF6B4A]"
                >
                  查看人力资产
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
