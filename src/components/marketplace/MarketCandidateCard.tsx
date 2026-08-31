/**
 * src/components/marketplace/MarketCandidateCard.tsx
 * 市场候选卡（模块 A）。
 *
 * 在既有卡片视觉之上叠加评估层能力：
 * - 迷你六维雷达（复用 pages/Evaluation/RadarChart，recharts）
 * - matchScore 徽章（四项分解 tooltip）
 * - 数据来源角标（已评估 / 初审 / 预估）
 * - S1 初审按钮（无六维时）
 * - 绩效徽章（有 S3 评分卡时：total + verdict 色块）
 * - 雇佣按钮（IPC 流程由页面注入，卡片只回调）
 */
import { Star, Building2, User, ShoppingCart, Gauge, Loader2, Award, Heart } from 'lucide-react';
import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { cn, isAvatarImage } from '@/lib/utils';
import { RadarChartView } from '@/pages/Evaluation/RadarChart';
import { MatchScoreBadge } from '@/components/marketplace/MatchScoreBadge';
import { BossFavoriteBadge } from '@/components/marketplace/BossFavoriteBadge';
import { RADAR_SOURCE_LABELS, type RadarSourceKind } from '@/engine/marketplace/radarSource';
import { useLikesStore, resolveLikeKey } from '@/stores/likesStore';
import type { MarketCandidateView } from '@/types/marketplace';
import type { Verdict } from '@/types/evaluation';
import type { JobType } from '@/types/evaluation';

export interface MarketCandidateCardProps {
  candidate: MarketCandidateView;
  /** 卡片入场动画序号 */
  index?: number;
  /** 是否正在雇佣该候选 */
  hiring?: boolean;
  /** 雇佣按钮是否禁用（其他候选雇佣中） */
  hireDisabled?: boolean;
  /** 是否正在 S1 初审 */
  prescreening?: boolean;
  /** 点击雇佣 */
  onHire: (candidate: MarketCandidateView) => void;
  /** 点击「S1 初审」 */
  onPrescreen: (candidate: MarketCandidateView) => void;
}

/** 来源角标配色 */
const SOURCE_TONE: Record<RadarSourceKind, string> = {
  evaluation: 'bg-emerald-50 text-emerald-600',
  prescreen: 'bg-blue-50 text-blue-600',
  heuristic: 'bg-amber-50 text-amber-600',
  none: 'bg-gray-100 text-gray-400',
};

/**
 * 候选头像：avatar 可能是 emoji（Web 预览种子）也可能是图片 URL / data URL
 * （Electron 模板或 dicebear CDN）。emoji 直接渲染；图片加载失败（CDN 不可达）
 * 时回落为名字首字符色块，绝不显示裂图图标。
 */
function CandidateAvatar({ name, avatar }: { name: string; avatar: string }) {
  const [imgFailed, setImgFailed] = useState(false);
  const boxClass =
    'h-16 w-16 overflow-hidden rounded-[20px] shadow-sm transition-transform duration-700 group-hover:scale-110';
  if (isAvatarImage(avatar) && !imgFailed) {
    return (
      <div className={boxClass}>
        <img
          src={avatar}
          alt={name}
          className="h-full w-full object-cover"
          onError={() => setImgFailed(true)}
        />
      </div>
    );
  }
  return (
    <div
      className={cn(
        boxClass,
        'flex items-center justify-center bg-[#FFD233]/20 text-2xl font-bold text-[#1A1C1E]',
      )}
    >
      {avatar && !isAvatarImage(avatar) ? avatar : (name.trim().charAt(0) || '🤖')}
    </div>
  );
}

/** 绩效 verdict 配色 */
const VERDICT_TONE: Record<Verdict, string> = {
  MVP: 'bg-emerald-500 text-white',
  OBSERVE: 'bg-amber-400 text-[#1A1C1E]',
  FIRED: 'bg-rose-500 text-white',
};

export function MarketCandidateCard({
  candidate,
  index = 0,
  hiring = false,
  hireDisabled = false,
  prescreening = false,
  onHire,
  onPrescreen,
}: MarketCandidateCardProps) {
  const { radarResolution: resolution } = candidate;
  const hasRadar = !!resolution.radar;

  // 小红心：B 站式点赞（类 B 站点赞），本地持久化经 reactionStore
  const likeKey = resolveLikeKey(candidate);
  const like = useLikesStore((s) => s.likes[likeKey]);
  const toggling = useLikesStore((s) => s.toggling[likeKey]);
  const hydrateLike = useLikesStore((s) => s.hydrate);
  const toggleLike = useLikesStore((s) => s.toggle);

  useEffect(() => {
    if (likeKey) void hydrateLike(likeKey);
  }, [likeKey, hydrateLike]);

  const likeCount = like?.count ?? 0;
  const likedByMe = like?.likedByMe ?? false;
  const jobType: JobType | null = candidate.jobType;

  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: Math.min(index * 0.06, 0.5) }}
      className="group relative flex flex-col overflow-hidden rounded-[40px] glass p-7 shadow-[0_20px_50px_rgba(0,0,0,0.04)] transition-shadow duration-300 hover:shadow-[0_30px_60px_rgba(0,0,0,0.06)]"
    >
      {/* 装饰光晕 */}
      <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-[#FFD233]/10 blur-3xl transition-colors duration-700 group-hover:bg-[#FFD233]/20" />

      {/* 头像 + 评分 / 类型 */}
      <div className="relative flex items-start justify-between">
        <CandidateAvatar name={candidate.name} avatar={candidate.avatar} />
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-1 rounded-full bg-[#FFD233]/20 px-3 py-1">
            <Star size={14} className="fill-[#FFD233] text-[#FFD233]" />
            {/* rating=0 是「无评分」约定（无真实信誉数据时不伪造） */}
            <span className="text-sm font-bold text-[#1A1C1E]">
              {candidate.rating > 0 ? candidate.rating.toFixed(1) : 'N/A'}
            </span>
          </div>
          <span
            className={cn(
              'flex items-center gap-1 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider',
              candidate.hireType === 'team'
                ? 'bg-emerald-50 text-emerald-600'
                : 'bg-blue-50 text-blue-600',
            )}
          >
            {candidate.hireType === 'team' ? <Building2 size={10} /> : <User size={10} />}
            {candidate.hireType === 'team' ? '团队方案' : '单体方案'}
          </span>
        </div>
      </div>

      {/* 名称 + 匹配分 */}
      <div className="mt-4 flex items-center justify-between gap-3">
        <h3 className="text-xl font-bold text-[#1A1C1E]">{candidate.name}</h3>
        <MatchScoreBadge match={candidate.match} />
      </div>

      {/* 标签 */}
      <div className="mt-3 flex flex-wrap gap-2">
        {candidate.tags.map((tag) => (
          <span
            key={tag}
            className="rounded-full bg-[#F2F0E9] px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-500"
          >
            {tag}
          </span>
        ))}
      </div>

      {/* 简介 */}
      <p className="mt-3 text-sm leading-relaxed text-gray-500 line-clamp-2">
        {candidate.description}
      </p>

      {/* 能力面板：迷你雷达 / S1 初审入口 */}
      <div className="mt-4 rounded-3xl bg-[#F8F7F3] p-2">
        <div className="flex items-center justify-between px-2 pt-1">
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400">
            六维能力
          </span>
          <div className="flex items-center gap-1.5">
            {resolution.stageScoreTotal != null && (
              <span
                className={cn(
                  'flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold',
                  resolution.verdict ? VERDICT_TONE[resolution.verdict] : 'bg-gray-200 text-gray-600',
                )}
                title="S3 绩效评分卡 total"
              >
                <Award size={10} />
                绩效 {resolution.stageScoreTotal.toFixed(0)}
              </span>
            )}
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-bold',
                SOURCE_TONE[resolution.source],
              )}
            >
              {RADAR_SOURCE_LABELS[resolution.source]}
            </span>
          </div>
        </div>

        {hasRadar ? (
          <RadarChartView score={resolution.radar} height={150} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-6">
            <p className="text-center text-[11px] leading-relaxed text-gray-400">
              该候选暂无六维能力数据，先跑一次 S1 初审再参与智能匹配
            </p>
            <button
              type="button"
              onClick={() => onPrescreen(candidate)}
              disabled={prescreening}
              className="flex items-center gap-1.5 rounded-full bg-[#1A1C1E] px-4 py-2 text-xs font-bold text-white shadow-md transition-colors hover:bg-[#FF6B4A] disabled:opacity-50"
            >
              {prescreening ? <Loader2 size={14} className="animate-spin" /> : <Gauge size={14} />}
              {prescreening ? '初审中...' : 'S1 初审'}
            </button>
          </div>
        )}
      </div>

      {/* 底部：报价 / 已雇佣 / 小红心 / 雇佣按钮 */}
      <div className="mt-auto flex items-end justify-between border-t border-gray-100/60 pt-5">
        <div className="flex items-end gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400">
              部署费用
            </p>
            <p className="mt-1 text-lg font-bold text-[#1A1C1E]">{candidate.price}</p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400">
              已引入
            </p>
            <p className="mt-1 text-lg font-bold text-[#1A1C1E]">
              {candidate.hiredCount > 0 ? candidate.hiredCount : '—'}
            </p>
          </div>
          {/* 小红心：类 B 站点赞（实体红 + 计数用 --neu-ink-soft） */}
          <button
            type="button"
            onClick={() => void toggleLike(likeKey)}
            disabled={!!toggling || !likeKey}
            aria-label={likedByMe ? '取消点赞' : '点赞'}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-transform',
              toggling ? 'opacity-60' : 'hover:scale-110 active:scale-95',
            )}
            title={likedByMe ? '取消点赞' : '点赞'}
          >
            <Heart
              size={17}
              className={likedByMe ? 'fill-[#FF4D6D] text-[#FF4D6D]' : 'text-gray-400'}
            />
            <span className="text-xs font-bold tabular-nums text-[var(--neu-ink-soft)]">
              {likeCount}
            </span>
          </button>
        </div>
        <button
          type="button"
          onClick={() => onHire(candidate)}
          disabled={hireDisabled}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#1A1C1E] text-white shadow-lg shadow-[#1A1C1E]/10 transition-colors hover:bg-[#FF6B4A] disabled:opacity-50"
        >
          {hiring ? (
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
          ) : (
            <ShoppingCart size={20} />
          )}
        </button>
      </div>

      {/* 最受 boss 青睐徽章（测评后展示；市场卡纯展示 + 投票入口在测评页） */}
      {jobType && (
        <div className="mt-3 flex items-center justify-start">
          <BossFavoriteBadge
            agentId={likeKey}
            agentName={candidate.name}
            jobType={jobType}
            mode="rank"
            votable={false}
          />
        </div>
      )}
    </motion.div>
  );
}

export default MarketCandidateCard;
