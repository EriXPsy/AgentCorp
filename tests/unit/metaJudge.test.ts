/**
 * tests/unit/metaJudge.test.ts
 * 元评估引擎行为锁定（对评委本身的评估）。
 *
 * 覆盖：
 * - agreement 一致率计算
 * - krippendorffAlpha 二值一致性（完全一致=1、随机=0、反向=-1）
 * - diagnoseByDim 逐维诊断（最弱维排序）
 * - driftCheck 漂移检测（improved/degraded/insufficient）
 * - assessMetaJudge 主入口（总体可接受性、置信校准缺口）
 */
import { describe, it, expect } from 'vitest';
import {
  agreement,
  krippendorffAlpha,
  diagnoseByDim,
  driftCheck,
  assessMetaJudge,
  reasoningPolarity,
  type MetaJudgeSample,
} from '@/engine/evaluation/metaJudge';

function sample(partial: Partial<MetaJudgeSample> & Pick<MetaJudgeSample, 'id' | 'gold' | 'judgeVerdict'>): MetaJudgeSample {
  return { judgeId: 'test-judge', ...partial };
}

describe('metaJudge · agreement', () => {
  it('全部一致 → accuracy=1', () => {
    const r = agreement([
      { gold: true, judgeVerdict: true },
      { gold: false, judgeVerdict: false },
    ]);
    expect(r.accuracy).toBe(1);
    expect(r.agree).toBe(2);
  });

  it('一半一致 → accuracy=0.5', () => {
    const r = agreement([
      { gold: true, judgeVerdict: true },
      { gold: false, judgeVerdict: true },
    ]);
    expect(r.accuracy).toBe(0.5);
  });

  it('空样本 → accuracy=0 不抛', () => {
    const r = agreement([]);
    expect(r.accuracy).toBe(0);
    expect(r.n).toBe(0);
  });
});

describe('metaJudge · krippendorffAlpha', () => {
  it('完全一致 → α=1', () => {
    const samples = [
      { gold: true, judgeVerdict: true },
      { gold: true, judgeVerdict: true },
      { gold: false, judgeVerdict: false },
      { gold: false, judgeVerdict: false },
    ];
    expect(krippendorffAlpha(samples)).toBe(1);
  });

  it('完全反向 → α=-1', () => {
    const samples = [
      { gold: true, judgeVerdict: false },
      { gold: true, judgeVerdict: false },
      { gold: false, judgeVerdict: true },
      { gold: false, judgeVerdict: true },
    ];
    expect(krippendorffAlpha(samples)).toBe(-1);
  });

  it('随机一致（对角无偏向）→ α 接近 0', () => {
    const samples = [
      { gold: true, judgeVerdict: true },
      { gold: true, judgeVerdict: false },
      { gold: false, judgeVerdict: true },
      { gold: false, judgeVerdict: false },
    ];
    expect(krippendorffAlpha(samples)).toBeCloseTo(0, 1);
  });

  it('样本不足 → 0', () => {
    expect(krippendorffAlpha([{ gold: true, judgeVerdict: true }])).toBe(0);
  });
});

describe('metaJudge · diagnoseByDim', () => {
  it('最弱维排最前，标注不可接受', () => {
    const samples = [
      sample({ id: '1', gold: true, judgeVerdict: true, dim: 'factuality' }),
      sample({ id: '2', gold: true, judgeVerdict: true, dim: 'factuality' }),
      sample({ id: '3', gold: true, judgeVerdict: true, dim: 'factuality' }),
      sample({ id: '4', gold: false, judgeVerdict: true, dim: 'logic' }), // logic 0%
      sample({ id: '5', gold: false, judgeVerdict: true, dim: 'logic' }),
    ];
    const byDim = diagnoseByDim(samples);
    expect(byDim[0].dim).toBe('logic');
    expect(byDim[0].accuracy).toBe(0);
    expect(byDim[0].acceptable).toBe(false);
    expect(byDim[1].dim).toBe('factuality');
    expect(byDim[1].acceptable).toBe(true);
  });

  it('无 dim → 归入 unspecified', () => {
    const byDim = diagnoseByDim([
      sample({ id: '1', gold: true, judgeVerdict: true }),
    ]);
    expect(byDim[0].dim).toBe('unspecified');
  });
});

describe('metaJudge · driftCheck', () => {
  it('样本不足 → insufficient', () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      sample({ id: `s${i}`, gold: true, judgeVerdict: true, ts: `2026-01-0${(i % 9) + 1}00:00Z` }),
    );
    const drift = driftCheck(samples);
    expect(drift.direction).toBe('insufficient');
  });

  it('近期变差 → degraded', () => {
    const early = Array.from({ length: 12 }, (_, i) =>
      sample({ id: `e${i}`, gold: true, judgeVerdict: true, ts: `2026-01-01T00:0${i}:00Z` }),
    );
    const late = Array.from({ length: 12 }, (_, i) =>
      sample({ id: `l${i}`, gold: true, judgeVerdict: false, ts: `2026-02-01T00:0${i}:00Z` }),
    );
    const drift = driftCheck([...early, ...late]);
    expect(drift.direction).toBe('degraded');
    expect(drift.drifted).toBe(true);
    expect(drift.delta).toBeLessThan(0);
  });

  it('近期变好 → improved', () => {
    const early = Array.from({ length: 12 }, (_, i) =>
      sample({ id: `e${i}`, gold: true, judgeVerdict: false, ts: `2026-01-01T00:0${i}:00Z` }),
    );
    const late = Array.from({ length: 12 }, (_, i) =>
      sample({ id: `l${i}`, gold: true, judgeVerdict: true, ts: `2026-02-01T00:0${i}:00Z` }),
    );
    const drift = driftCheck([...early, ...late]);
    expect(drift.direction).toBe('improved');
  });

  it('稳定 → stable', () => {
    // 每半窗口恰好 2 个判错（一致率 10/12 ≈ 0.833），两半几乎无差异
    const makeHalf = (prefix: string, startDay: number) =>
      Array.from({ length: 12 }, (_, i) =>
        sample({
          id: `${prefix}${i}`,
          gold: true,
          judgeVerdict: i >= 10, // 后 2 个判错
          ts: `2026-01-${String(startDay + i).padStart(2, '0')}00:00Z`,
        }),
      );
    const drift = driftCheck([...makeHalf('e', 1), ...makeHalf('l', 15)]);
    expect(drift.direction).toBe('stable');
    expect(drift.drifted).toBe(false);
  });
});

describe('metaJudge · assessMetaJudge', () => {
  it('高质量评委 → overallAcceptable=true，无漂移，置信校准缺口小', () => {
    const samples = Array.from({ length: 30 }, (_, i) =>
      sample({
        id: `s${i}`,
        gold: true,
        judgeVerdict: true,
        confidence: 0.95,
        dim: 'factuality',
        ts: `2026-01-${String((i % 28) + 1).padStart(2, '0')}00:00Z`,
      }),
    );
    const report = assessMetaJudge(samples);
    expect(report.overallAcceptable).toBe(true);
    expect(report.accuracy).toBe(1);
    expect(report.drift.direction).toBe('stable');
    expect(report.calibrationGap).not.toBeNull();
    expect(report.byDim.length).toBe(1);
    expect(report.weakestDim?.dim).toBe('factuality');
  });

  it('低质量评委 → overallAcceptable=false，最弱维标注不可接受', () => {
    const samples = Array.from({ length: 20 }, (_, i) =>
      sample({
        id: `s${i}`,
        gold: true,
        judgeVerdict: false, // 全部判错
        confidence: 0.9, // 过度自信
        dim: 'logic',
      }),
    );
    const report = assessMetaJudge(samples);
    expect(report.overallAcceptable).toBe(false);
    expect(report.accuracy).toBe(0);
    expect(report.weakestDim?.acceptable).toBe(false);
    // 置信校准缺口 = |0.9 - 0| = 0.9 → 过度自信被检出
    expect(report.calibrationGap).toBeCloseTo(0.9, 1);
  });

  it('阈值可配置', () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      sample({ id: `s${i}`, gold: true, judgeVerdict: i % 5 === 0 ? false : true }),
    );
    // accuracy = 0.8；默认阈值 0.67 → 可接受；调高到 0.9 → 不可接受
    expect(assessMetaJudge(samples).overallAcceptable).toBe(true);
    expect(assessMetaJudge(samples, { acceptableThreshold: 0.9 }).overallAcceptable).toBe(false);
  });
});

describe('metaJudge · reasoningPolarity（推理文本情感极性）', () => {
  it('负向词占优 → negative', () => {
    expect(reasoningPolarity('该方案未跑通，存在错误，不可运行。')).toBe('negative');
  });

  it('正向词占优 → positive', () => {
    expect(reasoningPolarity('候选兑现了要点，满足要求，结果正确。')).toBe('positive');
  });

  it('无任何倾向词 → neutral', () => {
    expect(reasoningPolarity('这是一段没有任何倾向关键词的纯描述文本。')).toBe('neutral');
  });

  it('否定前缀不被误判为正向：「不符合」因含「符合」却应判负', () => {
    // 关键防误判：若只做子串匹配，「不符合」会同时命中正向「符合」。
    // 实现先挖掉负向短语再数正向，故此处必须判负。
    expect(reasoningPolarity('该交付不符合要求，存在偏差。')).toBe('negative');
  });

  it('正负数量打平 → neutral（不强行归类）', () => {
    // 「正确」(正) 与 「错误」(负) 各一次 → 打平 → neutral
    expect(reasoningPolarity('整体正确但有一处错误。')).toBe('neutral');
  });

  // ── 否定前缀 + 正向词：deny-list 穷举 + 否定窗口双重覆盖 ──
  it('「未能实现」→ negative（deny-list 命中 4 字连续负向短语）', () => {
    expect(reasoningPolarity('候选未能实现要点，整体偏差。')).toBe('negative');
  });

  it('「未能兑现」→ negative', () => {
    expect(reasoningPolarity('未能兑现承诺，存在错误。')).toBe('negative');
  });

  it('「不能满足」→ negative', () => {
    expect(reasoningPolarity('不能满足需求，有缺陷。')).toBe('negative');
  });

  it('「不能达到」→ negative', () => {
    expect(reasoningPolarity('不能达到预期，不可靠。')).toBe('negative');
  });

  it('「没完成」→ negative', () => {
    expect(reasoningPolarity('该方案没完成核心功能，存在缺陷。')).toBe('negative');
  });

  it('「没跑通」→ negative', () => {
    expect(reasoningPolarity('代码没跑通，有报错。')).toBe('negative');
  });

  // ── 危险逆否：「不会出现错误」语义正面，但含「错误」cue → 正确结果应为 positive ──
  it('「不会出现错误」+ 正向上下文 → positive（危险逆否：错误 cue 不压过正向多数）', () => {
    // 关键防误判：若简单计数，「错误」(负) 会让结果偏负。
    // 但「准确」「通过」两个正向 cue 应压过单个「错误」，结果仍为 positive。
    expect(reasoningPolarity('交付不会出现错误，结果准确，通过验证。')).toBe('positive');
  });

  // ── 否定窗口：deny-list 未枚举的否定前缀 + 正向词组合 ──
  it('「未能对齐」中「对齐」被否定窗口否决（deny-list 无此 4 字条目）', () => {
    // deny-list 有「未对齐」(3字)，不含「未能对齐」(4字)。
    // 但「未」在「对齐」前 2 格内 → 否定窗口否决「对齐」的正向计数。
    // 加上「偏差」(非 cue) 无正向 → neutral（无负向 cue 命中）。
    // 注：此例意在验证窗口不产生假阳性——「未能对齐」不含明确负向 cue，
    // 故判 neutral 而非 negative（窗口只否决正向，不创造负向计数）。
    expect(reasoningPolarity('方案未能对齐预期。')).toBe('neutral');
  });
});

describe('metaJudge · 推理-结论一致性诊断', () => {
  it('推理在挑刺却判可用 → 矛盾', () => {
    const samples = Array.from({ length: 4 }, (_, i) =>
      sample({
        id: `s${i}`,
        gold: true,
        judgeVerdict: true, // 裁判说可用
        reasoning: '该实现未跑通，存在明显错误，不可运行，未达标。',
      }),
    );
    const rc = assessMetaJudge(samples).reasoningConsistency;
    expect(rc.verdict).toBe('contradictory');
    expect(rc.vsVerdictContradictory).toBe(4);
    expect(rc.contradictionRate).toBe(1);
    // 启发式：置信度有上限，绝不假装精确
    expect(rc.confidence).toBeGreaterThan(0);
    expect(rc.confidence).toBeLessThanOrEqual(0.6);
  });

  it('推理与结论同向 → 一致', () => {
    const samples = Array.from({ length: 4 }, (_, i) =>
      sample({
        id: `s${i}`,
        gold: true,
        judgeVerdict: true,
        reasoning: '候选兑现了要点，满足要求，结果准确，全部通过。',
      }),
    );
    const rc = assessMetaJudge(samples).reasoningConsistency;
    expect(rc.verdict).toBe('consistent');
    expect(rc.vsVerdictContradictory).toBe(0);
    expect(rc.contradictionRate).toBe(0);
  });

  it('样本不足 → 判 insufficient，矛盾率为 null，绝不凑数', () => {
    // 仅 1 条带推理，不足 3 条门槛
    const samples = [
      sample({ id: 's0', gold: true, judgeVerdict: true, reasoning: '未跑通，错误。' }),
      sample({ id: 's1', gold: true, judgeVerdict: true }), // 无推理
    ];
    const rc = assessMetaJudge(samples).reasoningConsistency;
    expect(rc.verdict).toBe('insufficient');
    expect(rc.contradictionRate).toBeNull();
    expect(rc.confidence).toBe(0);
  });

  it('全员无推理 → withReasoning=0，判 insufficient', () => {
    const samples = Array.from({ length: 5 }, (_, i) =>
      sample({ id: `s${i}`, gold: true, judgeVerdict: true }),
    );
    const rc = assessMetaJudge(samples).reasoningConsistency;
    expect(rc.withReasoning).toBe(0);
    expect(rc.verdict).toBe('insufficient');
  });
});
