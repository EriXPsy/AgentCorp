/**
 * src/components/evaluation/PreferenceInsightPanel.tsx
 * 用户心智模型面板（T40，增量 §3.3 preference 面板 / §7.3 通道 A 可视化）。
 *
 * 展示「绩效拖拽/主观分 → dimLift → UserPreference.weight」回灌链路的结果：
 * - 六维 userWeight vs DEFAULT_WEIGHT 双条对比（当前权重 = 黄，基准 = 灰）；
 * - dimLift 徽章：不同工种打分倾向经 CRAFT_LINKS 反推出的六维偏好抬升；
 * - 信号数 N 与 top 偏移维摘要（「你更看重哪几维」）。
 * 纯读 scoringStore，零副作用；市场页 matchScore 的 effWeight 用的就是同一份权重。
 *
 * i18n：用户可见文案走 common:evaluation.preference.*，六维标签复用 evaluation.dims.*。
 */
import { useMemo } from 'react';
import { Brain, TrendingDown, TrendingUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useScoringStore, DEFAULT_WEIGHT } from '@/stores/scoringStore';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import type { RadarDim } from '@/types/evaluation';

/** 六维 zh 默认标签（i18n defaultValue，与 RadarChart 同口径） */
const DIM_DEFAULTS: Record<RadarDim, string> = {
  task: '任务',
  quality: '质量',
  comm: '沟通',
  creativity: '创意',
  reliability: '可靠',
  cost: '性价比',
};

/** 条形宽度归一基准：权重条按 max(所有权重) 撑满，视觉对比更明显 */
function widthPct(value: number, maxValue: number): number {
  if (maxValue <= 0) return 0;
  return Math.round((value / maxValue) * 100);
}

export function PreferenceInsightPanel() {
  const { t } = useTranslation('common');
  const userWeight = useScoringStore((s) => s.userWeight);
  const preferenceProfile = useScoringStore((s) => s.preferenceProfile);
  const signals = useScoringStore((s) => s.preferenceSignals);

  const dimLift = preferenceProfile?.dimLift ?? {};
  const signalCount = signals.length;

  const dimLabel = (dim: RadarDim) => t(`evaluation.dims.${dim}`, DIM_DEFAULTS[dim]);

  /** 每维偏移（当前 − 基准），排序取 top 偏好摘要 */
  const rows = useMemo(() => {
    return (RADAR_DIMS as RadarDim[]).map((d) => {
      const current = userWeight[d] ?? 0;
      const base = DEFAULT_WEIGHT[d] ?? 0;
      return { dim: d, current, base, delta: current - base, lift: dimLift[d] ?? 0 };
    });
  }, [userWeight, preferenceProfile]);

  const maxW = useMemo(
    () => Math.max(...rows.map((r) => Math.max(r.current, r.base)), 0.0001),
    [rows],
  );

  /** 「你更看重」摘要：偏移为正的维度按 delta 降序取 top-2 */
  const topDims = useMemo(
    () =>
      rows
        .filter((r) => r.delta > 0.0005)
        .sort((a, b) => b.delta - a.delta)
        .slice(0, 2),
    [rows],
  );

  return (
    <div className="space-y-4">
      {/* 摘要头 */}
      <div className="flex items-center justify-between rounded-2xl border border-white/40 bg-white/60 p-4 dark:bg-white/5">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-[#FFD233]" />
          <div>
            <p className="text-[13px] font-bold text-[#1A1C1E] dark:text-white">
              {t('evaluation.preference.title', '用户心智模型 · 六维偏好权重')}
            </p>
            <p className="text-[11px] text-gray-400">
              {t('evaluation.preference.note', {
                count: signalCount,
                defaultValue: '双榜拖拽 / 主观打分 → dimLift → 权重回灌（α=0.15，Σ=1 重归一）· 累计信号 N = {{count}}',
              })}
            </p>
          </div>
        </div>
        <p className="max-w-[220px] text-right text-[12px] text-gray-500 dark:text-gray-300">
          {topDims.length > 0 ? (
            <>
              {t('evaluation.preference.topPre', '你更看重')}{' '}
              {topDims.map((r, i) => (
                <span key={r.dim} className="font-bold text-[#1A1C1E] dark:text-white">
                  {i > 0 ? t('evaluation.preference.dimSep', '、') : ''}
                  {dimLabel(r.dim)}
                </span>
              ))}
            </>
          ) : (
            t('evaluation.preference.noSignal', '暂未检测到明显偏好（去双榜拖一拖试试）')
          )}
        </p>
      </div>

      {/* 六维对比条 */}
      <div className="space-y-3 rounded-2xl border border-white/40 bg-white/60 p-4 dark:bg-white/5">
        {rows.map((r) => (
          <div key={r.dim}>
            <div className="flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1.5 font-semibold text-gray-500 dark:text-gray-300">
                {dimLabel(r.dim)}
                {r.delta > 0.0005 ? (
                  <TrendingUp className="h-3 w-3 text-emerald-500" />
                ) : r.delta < -0.0005 ? (
                  <TrendingDown className="h-3 w-3 text-rose-400" />
                ) : null}
                {r.lift !== 0 ? (
                  <span className="rounded-full bg-emerald-100 px-1.5 py-px text-[9px] font-bold text-emerald-600">
                    lift {r.lift > 0 ? '+' : ''}
                    {r.lift.toFixed(2)}
                  </span>
                ) : null}
              </span>
              <span className="tabular-nums text-gray-400">
                <span className="font-bold text-[#1A1C1E] dark:text-white">
                  {(r.current * 100).toFixed(1)}%
                </span>{' '}
                / {t('evaluation.preference.base', '基准')} {(r.base * 100).toFixed(1)}%
                <span
                  className={`ml-1 font-bold ${
                    r.delta > 0.0005
                      ? 'text-emerald-600'
                      : r.delta < -0.0005
                        ? 'text-rose-500'
                        : 'text-gray-400'
                  }`}
                >
                  ({r.delta >= 0 ? '+' : ''}
                  {(r.delta * 100).toFixed(1)})
                </span>
              </span>
            </div>
            {/* 当前权重（黄） */}
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-200/70 dark:bg-white/10">
              <div
                className="h-full rounded-full bg-[#FFD233] transition-all"
                style={{ width: `${widthPct(r.current, maxW)}%` }}
              />
            </div>
            {/* 基准权重（灰） */}
            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-gray-200/40 dark:bg-white/5">
              <div
                className="h-full rounded-full bg-gray-400/60"
                style={{ width: `${widthPct(r.base, maxW)}%` }}
              />
            </div>
          </div>
        ))}
        <p className="pt-1 text-[11px] text-gray-400">
          {t('evaluation.preference.footnote', '黄条 = 当前权重（回灌后），灰条 = 默认基准。该权重直接进入人才市场 matchScore 的 userFit 项——下一次市场排序即体现你的口味。')}
        </p>
      </div>
    </div>
  );
}

export default PreferenceInsightPanel;
