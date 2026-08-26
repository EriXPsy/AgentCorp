/**
 * src/components/designer/StyleMemoryPanel.tsx
 * StyleMemory 可视化面板：Designer 的语义记忆 + PromptEvolver 进化指标。
 *
 * 展示内容（均为后端涌现，非人工预设）：
 *   1. 当前综合理解 — Designer 每 3 次反思合成的语义摘要
 *   2. 下一步挑战假设 — Designer 认为该考什么
 *   3. 反思观察时间线 — 每次评估后的代码品味观察
 *   4. 进化指标 — quality_score / hypothesis_accuracy / evolution_count
 *   5. 自适应出题按钮 — 基于当前记忆请求 Designer 出新题
 *
 * 设计约束：所有数据来自 StyleMemory（后端），本组件只做展示。
 * 无数据时展示空态，不伪造内容。
 */
import { useCallback } from 'react';
import { Brain, Lightbulb, Activity, Target, TrendingUp, Loader2, Sparkles } from 'lucide-react';

import { useDesignerStore } from '@/stores/designerStore';

// ── 子组件：单条观察 ──────────────────────────────────────────────────
function ObservationItem({ text, index, total }: { text: string; index: number; total: number }) {
  return (
    <div className="flex gap-3">
      {/* 时间线轴 */}
      <div className="flex flex-col items-center">
        <div className="h-2.5 w-2.5 rounded-full bg-[#FFD233] ring-2 ring-[#FFD233]/20" />
        {index < total - 1 && <div className="w-px flex-1 bg-gray-200 dark:bg-white/10" />}
      </div>
      <div className="flex-1 pb-3">
        <p className="text-[10px] font-bold text-gray-400">观察 #{index + 1}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-[#1A1C1E] dark:text-white">{text}</p>
      </div>
    </div>
  );
}

// ── 子组件：进化指标卡 ────────────────────────────────────────────────
function EvolutionMetric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl bg-white/60 px-3 py-2 dark:bg-white/5" title={hint}>
      <p className="text-[10px] text-gray-400">{label}</p>
      <p className="text-lg font-bold tabular-nums text-[#1A1C1E] dark:text-white">{value}</p>
    </div>
  );
}

// ── 主面板 ────────────────────────────────────────────────────────────
export function StyleMemoryPanel() {
  const memory = useDesignerStore((s) => s.memory);
  const currentChallenge = useDesignerStore((s) => s.currentChallenge);
  const lastReflection = useDesignerStore((s) => s.lastReflection);
  const loading = useDesignerStore((s) => s.loading);
  const error = useDesignerStore((s) => s.error);
  const fetchMemory = useDesignerStore((s) => s.fetchMemory);
  const requestChallengeAction = useDesignerStore((s) => s.requestChallenge);
  const clearError = useDesignerStore((s) => s.clearError);

  const teamId = useDesignerStore((s) => s.teamId);

  const handleRequestChallenge = useCallback(() => {
    if (!teamId) return;
    void requestChallengeAction(teamId);
  }, [teamId, requestChallengeAction]);

  const handleRefresh = useCallback(() => {
    if (!teamId) return;
    void fetchMemory(teamId, { force: true });
  }, [teamId, fetchMemory]);

  // ── 无 teamId 时展示引导 ────────────────────────────────────────────
  if (!teamId) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 p-5 text-center">
        <Brain className="mx-auto h-5 w-5 text-gray-400" />
        <p className="mt-2 text-sm font-bold text-gray-500">Style Memory：未选择团队</p>
        <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-gray-400">
          从左侧选择一位员工后，Designer 的语义记忆将在此展示。
          每次评估后 Reflector 会自动观察代码风格并更新记忆。
        </p>
      </div>
    );
  }

  // ── 加载中 ──────────────────────────────────────────────────────────
  if (loading && !memory) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-white/40 bg-white/70 p-8 dark:bg-white/5">
        <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
        <span className="text-sm text-gray-400">加载 StyleMemory…</span>
      </div>
    );
  }

  // ── 无 memory（初始状态：还没出过题）────────────────────────────────
  if (!memory) {
    return (
      <div className="space-y-4 rounded-2xl border border-white/40 bg-white/70 p-5 dark:bg-white/5">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-[#FFD233]" />
          <h3 className="text-sm font-bold text-[#1A1C1E] dark:text-white">Style Memory</h3>
        </div>
        <p className="text-[12px] text-gray-400">
          该团队尚无评估记录。运行一次评估后，Designer 会自动观察代码风格、积累语义记忆，
          并据此生成自适应挑战。
        </p>
        <button
          type="button"
          onClick={handleRequestChallenge}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-full bg-[#1A1C1E] px-4 py-2 text-[12px] font-bold text-white transition-all hover:bg-[#FF6B4A] disabled:opacity-50 dark:bg-white dark:text-[#1A1C1E]"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          请求 Designer 出题
        </button>
        {error && (
          <p className="text-[11px] text-rose-500">{error}</p>
        )}
      </div>
    );
  }

  // ── 有 memory：完整展示 ─────────────────────────────────────────────
  const recentObs = memory.observations.slice(-5).reverse();
  const lastQuality = memory.reflection_quality_history.at(-1);
  const lastAccuracy = memory.hypothesis_accuracy_history.at(-1);

  return (
    <div className="space-y-4">
      {/* 错误条 */}
      {error && (
        <div className="flex items-center justify-between rounded-xl bg-rose-500/10 px-3 py-2 text-[11px] text-rose-600">
          <span>{error}</span>
          <button type="button" onClick={clearError} className="hover:underline">关闭</button>
        </div>
      )}

      {/* 1. 当前综合理解 */}
      {memory.current_understanding && (
        <section className="space-y-2 rounded-2xl border border-white/40 bg-white/70 p-4 dark:bg-white/5">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-[#1A1C1E] dark:text-white">
            <Brain className="h-4 w-4 text-[#FFD233]" />
            当前综合理解
            <span className="ml-auto text-[10px] font-normal text-gray-400">
              每 {memory.synthesize_every} 次反思合成一次
            </span>
          </h3>
          <p className="text-[12px] leading-relaxed text-[#1A1C1E] dark:text-white">
            {memory.current_understanding}
          </p>
        </section>
      )}

      {/* 2. 下一步挑战假设 */}
      {memory.next_challenge_hypothesis && (
        <section className="space-y-2 rounded-2xl border border-white/40 bg-white/70 p-4 dark:bg-white/5">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-[#1A1C1E] dark:text-white">
            <Target className="h-4 w-4 text-[#FF6B4A]" />
            下一步挑战假设
          </h3>
          <p className="text-[12px] leading-relaxed text-[#1A1C1E] dark:text-white">
            {memory.next_challenge_hypothesis}
          </p>
        </section>
      )}

      {/* 3. 进化指标 */}
      {memory.evolution_count > 0 && (
        <section className="space-y-2 rounded-2xl border border-white/40 bg-white/70 p-4 dark:bg-white/5">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-[#1A1C1E] dark:text-white">
            <TrendingUp className="h-4 w-4 text-emerald-500" />
            Prompt 进化指标
            <span className="ml-auto text-[10px] font-normal text-gray-400">
              每 {memory.evolve_every} 次反思审查一次
            </span>
          </h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <EvolutionMetric
              label="进化次数"
              value={String(memory.evolution_count)}
              hint="PromptEvolver 自动改写 prompt 的总次数"
            />
            {lastQuality !== undefined && (
              <EvolutionMetric
                label="最近质量分"
                value={lastQuality.toFixed(2)}
                hint="PromptEvolver 对最近 10 条反思的质量评估（0=模板化, 1=高质量）"
              />
            )}
            {lastAccuracy !== undefined && (
              <EvolutionMetric
                label="假设命中率"
                value={lastAccuracy.toFixed(2)}
                hint="Designer 的挑战假设被后续反思证实的比例"
              />
            )}
          </div>
          {/* 质量趋势 */}
          {memory.reflection_quality_history.length >= 2 && (
            <div className="flex items-end gap-1 pt-1">
              {memory.reflection_quality_history.map((q, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-t"
                  style={{
                    height: `${Math.max(4, q * 40)}px`,
                    backgroundColor: q >= 0.5 ? '#10b981' : q >= 0.3 ? '#f59e0b' : '#ef4444',
                    opacity: 0.6 + (i / memory.reflection_quality_history.length) * 0.4,
                  }}
                  title={`第 ${i + 1} 次审查：${q.toFixed(2)}`}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* 4. 反思观察时间线 */}
      {recentObs.length > 0 && (
        <section className="space-y-1 rounded-2xl border border-white/40 bg-white/70 p-4 dark:bg-white/5">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-[#1A1C1E] dark:text-white">
            <Activity className="h-4 w-4 text-sky-500" />
            最近反思
            <span className="ml-auto text-[10px] font-normal text-gray-400">
              共 {memory.reflection_count} 次
            </span>
          </h3>
          <div className="mt-2">
            {recentObs.map((obs, i) => (
              <ObservationItem
                key={`${memory.reflection_count - i}`}
                text={obs}
                index={memory.reflection_count - i}
                total={memory.reflection_count}
              />
            ))}
          </div>
        </section>
      )}

      {/* 5. 最近出题结果 */}
      {currentChallenge && (
        <section className="space-y-2 rounded-2xl border border-white/40 bg-white/70 p-4 dark:bg-white/5">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-[#1A1C1E] dark:text-white">
            <Lightbulb className="h-4 w-4 text-amber-500" />
            Designer 最新出题
          </h3>
          <div className="space-y-1 text-[12px]">
            <p className="font-bold text-[#1A1C1E] dark:text-white">{currentChallenge.title}</p>
            <p className="text-gray-500">{currentChallenge.prompt}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <span className="rounded-full bg-[#FFD233]/20 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                难度 {currentChallenge.difficulty.toFixed(1)}
              </span>
              {currentChallenge.target_dims.map((dim) => (
                <span key={dim} className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-600 dark:bg-sky-500/20 dark:text-sky-300">
                  {dim}
                </span>
              ))}
            </div>
            {currentChallenge.design_rationale && (
              <p className="pt-1 text-[11px] italic text-gray-400">{currentChallenge.design_rationale}</p>
            )}
          </div>
        </section>
      )}

      {/* 6. 最近反思结果 */}
      {lastReflection && (
        <section className="space-y-2 rounded-2xl border border-white/40 bg-white/70 p-4 dark:bg-white/5">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-[#1A1C1E] dark:text-white">
            <Activity className="h-4 w-4 text-emerald-500" />
            最近一次反思
          </h3>
          <p className="text-[12px] leading-relaxed text-[#1A1C1E] dark:text-white">
            {lastReflection.observation}
          </p>
        </section>
      )}

      {/* 操作栏 */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleRequestChallenge}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-full bg-[#1A1C1E] px-4 py-2 text-[12px] font-bold text-white transition-all hover:bg-[#FF6B4A] disabled:opacity-50 dark:bg-white dark:text-[#1A1C1E]"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          请求 Designer 出题
        </button>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-full border border-gray-200 px-4 py-2 text-[12px] font-bold text-gray-500 transition-all hover:border-[#FFD233] hover:text-[#1A1C1E] disabled:opacity-50 dark:border-white/20 dark:text-gray-400"
        >
          刷新记忆
        </button>
      </div>
    </div>
  );
}

export default StyleMemoryPanel;
