/**
 * src/pages/Evaluation/LifecyclePanel.tsx
 * 生命周期治理面板：展示当前 lifecycle 状态，提供
 * 「移出在岗名单」与「回岗（Reactivate）」治理动作。
 *
 * 软退休为「逻辑淘汰」：仅将 lifecycle 置为 RETIRED，不物理删除档案
 * （与 src/types/lifecycle.ts 的软退休约定一致）。回岗置 ACTIVE。
 *
 * i18n：五态标签改走 common:evaluation.lifecycle.states.*（不再直接渲染
 * engine/strategyEngine 的 LIFECYCLE_LABELS 中文常量）。
 */
import { useTranslation } from 'react-i18next';

import type { LifecycleState } from '@/types/evaluation';
import { LIFECYCLE_ORDER } from '@/engine/strategyEngine';

export interface LifecyclePanelProps {
  agentId: string | null;
  state: LifecycleState | null;
  onSoftRetire: (agentId: string) => void;
  onReactivate: (agentId: string) => void;
  busy?: boolean;
}

const STATE_STYLE: Record<LifecycleState, string> = {
  ONBOARDING: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
  ACTIVE: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
  TRAINING: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300',
  MAINTENANCE: 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300',
  RETIRED: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300',
};

/** 五态 zh 默认标签（i18n defaultValue，与 strategyEngine.LIFECYCLE_LABELS 同口径） */
const STATE_DEFAULTS: Record<LifecycleState, string> = {
  ONBOARDING: '入职',
  ACTIVE: '在岗',
  TRAINING: '培训(PIP)',
  MAINTENANCE: '替补',
  RETIRED: '已淘汰',
};

export function LifecyclePanel({ agentId, state, onSoftRetire, onReactivate, busy }: LifecyclePanelProps) {
  const { t } = useTranslation('common');

  if (!agentId) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">
        {t('evaluation.lifecycle.empty', '选择一个 agent 以查看生命周期。')}
      </div>
    );
  }

  const current = state ?? 'ONBOARDING';
  const stateLabel = (s: LifecycleState) =>
    t(`evaluation.lifecycle.states.${s}`, STATE_DEFAULTS[s]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className={`rounded-full px-3 py-1 text-[12px] font-bold ${STATE_STYLE[current]}`}>
          {stateLabel(current)}
        </span>
        <span className="text-[12px] text-gray-400">{agentId}</span>
      </div>

      {/* 状态机视图 */}
      <div className="flex flex-wrap gap-1.5">
        {LIFECYCLE_ORDER.map((s) => (
          <span
            key={s}
            className={
              s === current
                ? 'rounded-full bg-[#1A1C1E] px-2.5 py-1 text-[11px] font-bold text-white dark:bg-white dark:text-[#1A1C1E]'
                : 'rounded-full bg-white/60 px-2.5 py-1 text-[11px] text-gray-400 dark:bg-white/5'
            }
          >
            {stateLabel(s)}
          </span>
        ))}
      </div>

      {/* 治理动作 */}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={busy || current === 'RETIRED'}
          onClick={() => onSoftRetire(agentId)}
          className="flex-1 rounded-full bg-rose-500 px-4 py-2 text-[13px] font-bold text-white shadow-sm transition-all hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('evaluation.lifecycle.fired', 'Remove from active roster')}
        </button>
        <button
          type="button"
          disabled={busy || current === 'ACTIVE'}
          onClick={() => onReactivate(agentId)}
          className="flex-1 rounded-full bg-emerald-500 px-4 py-2 text-[13px] font-bold text-white shadow-sm transition-all hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('evaluation.lifecycle.reactivate', '回岗 Reactivate')}
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-gray-400">
        {t('evaluation.lifecycle.softRetireNote', '软退休为逻辑淘汰：仅变更生命周期状态，档案与历史评估保留，可经「回岗」恢复。')}
      </p>
    </div>
  );
}

export default LifecyclePanel;
