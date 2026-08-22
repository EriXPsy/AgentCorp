/**
 * src/components/evaluation/JudgeHealthPanel.tsx
 * 裁判健康度面板：把「谁来监管裁判」这件事变成界面上看得见的一块。
 *
 * 数据全部来自 `engine/evaluation/metaJudge.ts`（纯函数，无 LLM 调用），
 * 样本来自使用者的人工抽检（`stores/metaJudgeStore.ts`）。
 *
 * 这块面板存在的意义不是好看，而是**把评测系统自身的不确定性摆到台面上**：
 * - 样本不足时明说样本不足，不给一个看起来很专业的数字；
 * - 一致率低于阈值时直接建议更换/校准裁判，而不是粉饰；
 * - 置信校准缺口暴露「裁判是不是过度自信」——高置信 + 低一致率是最危险的组合。
 */
import { useMemo } from 'react';
import { Activity, AlertTriangle, CheckCircle2, RotateCcw } from 'lucide-react';

import { META_JUDGE_DEFAULTS, assessMetaJudge } from '@/engine/evaluation/metaJudge';
import { useMetaJudgeStore } from '@/stores/metaJudgeStore';

/** Krippendorff 1994/2004 的既有信度分级，直接引用不自造阈值 */
function alphaLabel(alpha: number): { text: string; tone: string } {
  if (alpha >= 0.8) return { text: '高度可信', tone: 'text-emerald-600' };
  if (alpha >= 0.67) return { text: '可接受', tone: 'text-emerald-600' };
  if (alpha >= 0.41) return { text: '勉强，需谨慎解读', tone: 'text-amber-600' };
  return { text: '不可用，建议更换裁判', tone: 'text-rose-500' };
}

export function JudgeHealthPanel() {
  const samples = useMetaJudgeStore((s) => s.samples);
  const clear = useMetaJudgeStore((s) => s.clear);

  const report = useMemo(() => assessMetaJudge(samples), [samples]);
  // 准入判据以 α 为准而非原始一致率：二值判断的随机基线就有 0.5，
  // 未经卡方校正的 accuracy 会系统性高估评委质量。
  const alpha = report.alpha;

  if (samples.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 p-5 text-center">
        <Activity className="mx-auto h-5 w-5 text-gray-400" />
        <p className="mt-2 text-sm font-bold text-gray-500">裁判健康度：尚无抽检样本</p>
        <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-gray-400">
          用模型评模型，就必须回答「裁判本身准不准」。
          在评估结论卡上点「认可 / 不认可」做人工抽检，这里会据此计算裁判的
          一致率、漂移与置信校准。我们不用模型自评来凑样本 —— 那正是元评估要防的东西。
        </p>
      </div>
    );
  }

  const enoughForDrift = samples.length >= META_JUDGE_DEFAULTS.minSamplesForDrift;
  const alphaInfo = alphaLabel(alpha);
  const overconfident =
    report.calibrationGap !== null &&
    report.avgConfidence !== null &&
    report.avgConfidence > report.accuracy &&
    report.calibrationGap > 0.15;

  return (
    <section className="space-y-3 rounded-2xl border border-white/40 bg-white/70 p-4 dark:bg-white/5">
      <header className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-bold text-[#1A1C1E] dark:text-white">
          <Activity className="h-4 w-4 text-[#FFD233]" />
          裁判健康度（元评估）
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-[11px] tabular-nums text-gray-400">{samples.length} 条抽检</span>
          <button
            type="button"
            onClick={clear}
            title="清空抽检样本（例如更换裁判模型后重新积累）"
            className="text-gray-400 hover:text-rose-500"
            aria-label="清空抽检样本"
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric
          label="人工认可率"
          value={`${Math.round(report.accuracy * 100)}%`}
          tone={report.overallAcceptable ? 'text-emerald-600' : 'text-rose-500'}
          hint="裁判结论中被人工复核认可的比例"
        />
        <Metric
          label="一致性 α"
          value={alpha.toFixed(2)}
          tone={alphaInfo.tone}
          hint={`Krippendorff α：${alphaInfo.text}（≥0.67 可接受）`}
        />
        <Metric
          label="漂移"
          value={
            enoughForDrift
              ? `${report.drift.delta > 0 ? '+' : ''}${(report.drift.delta * 100).toFixed(0)}%`
              : '样本不足'
          }
          tone={
            !enoughForDrift
              ? 'text-gray-400'
              : report.drift.direction === 'degraded'
                ? 'text-rose-500'
                : 'text-gray-500'
          }
          hint={
            enoughForDrift
              ? '近半样本一致率 − 早期一致率；负值说明裁判在变差'
              : `需 ≥${META_JUDGE_DEFAULTS.minSamplesForDrift} 条样本才做漂移检测`
          }
        />
        <Metric
          label="置信校准"
          value={report.calibrationGap === null ? '—' : report.calibrationGap.toFixed(2)}
          tone={overconfident ? 'text-amber-600' : 'text-gray-500'}
          hint="|自报置信 − 实际一致率|；差距大说明裁判过度自信"
        />
      </div>

      {/* 结论区：只在有明确问题时说话，不制造无意义的绿色对勾 */}
      {!report.alphaAcceptable && samples.length >= 10 && (
        <p className="flex items-start gap-1.5 rounded-md bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-600">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            卡方校正后的一致性 α={alpha.toFixed(2)} 低于可接受线{' '}
            {META_JUDGE_DEFAULTS.alphaAcceptableThreshold}：扣除随机一致后，
            该裁判与人工判断的吻合度不足以支撑准入结论。建议更换裁判或先校准 rubric。
          </span>
        </p>
      )}
      {!report.overallAcceptable && (
        <p className="flex items-start gap-1.5 rounded-md bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-600">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            人工认可率低于 {Math.round(META_JUDGE_DEFAULTS.acceptableThreshold * 100)}%
            的可接受下限：建议更换裁判模型、或先校准 rubric 再继续评测。
            此期间的评测结论应视为参考值。
          </span>
        </p>
      )}
      {overconfident && (
        <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            裁判过度自信：平均自报置信 {report.avgConfidence?.toFixed(2)} 高于实际认可率{' '}
            {report.accuracy.toFixed(2)}。展示时应弱化其 confidence 字段。
          </span>
        </p>
      )}
      {report.drift.direction === 'degraded' && (
        <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            检测到裁判漂移：近期一致率 {(report.drift.recentAccuracy * 100).toFixed(0)}% 低于早期{' '}
            {(report.drift.earlyAccuracy * 100).toFixed(0)}%。可能是模型版本变更或题型分布变化。
          </span>
        </p>
      )}

      {/* 第四种诊断：推理-结论一致性（启发式，仅对有思维链的样本）。
          只在检出矛盾时报（避免噪声）；一致时给一句低置信的安心，样本不足则静默。 */}
      {report.reasoningConsistency.verdict === 'contradictory' && (
        <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            推理-结论可能脱节（启发式，低置信 ≈
            {report.reasoningConsistency.confidence.toFixed(2)}）：
            {report.reasoningConsistency.analyzable} 条可解析样本中有{' '}
            {report.reasoningConsistency.vsVerdictContradictory} 条裁判思维链倾向与结论矛盾
            （如推理在挑刺却判可用）。{report.reasoningConsistency.note}
          </span>
        </p>
      )}
      {report.reasoningConsistency.verdict === 'consistent' &&
        report.reasoningConsistency.analyzable >= 3 && (
          <p className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            推理-结论一致性（启发式，低置信）：
            {report.reasoningConsistency.analyzable} 条带思维链样本的推理倾向与结论基本一致。
          </p>
        )}
      {report.overallAcceptable && report.alphaAcceptable && !overconfident && report.drift.direction !== 'degraded' && (
        <p className="flex items-center gap-1.5 text-[11px] text-emerald-600">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          当前裁判在已抽检样本上表现稳定。注意：这说明结论**稳定**，不等于结论**正确**。
        </p>
      )}

      {report.byDim.length > 1 && report.weakestDim && !report.weakestDim.acceptable && (
        <p className="text-[11px] text-gray-500">
          最弱环节：<span className="font-bold">{report.weakestDim.dim}</span>（认可率{' '}
          {Math.round(report.weakestDim.accuracy * 100)}%，n={report.weakestDim.n}）
          —— 该类任务上的结论建议加大人工复核比例。
        </p>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: string;
  hint: string;
}) {
  return (
    <div className="rounded-xl bg-white/60 px-3 py-2 dark:bg-white/5" title={hint}>
      <p className="text-[10px] text-gray-400">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

export default JudgeHealthPanel;
