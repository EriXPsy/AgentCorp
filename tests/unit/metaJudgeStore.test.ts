// @vitest-environment jsdom
/**
 * tests/unit/metaJudgeStore.test.ts
 *
 * 元评估样本库：把「人工抽检」正确地翻译成 metaJudge 需要的 gold/judgeVerdict 对。
 *
 * 这层翻译看似简单，错了却会让整块元评估反向：
 * 「不认可一个 FIRED 判定」意味着人认为该 agent **可用**，
 * 若写成 gold=false，裁判越准反而一致率越低。
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { assessMetaJudge } from '@/engine/evaluation/metaJudge';
import { toSample, useMetaJudgeStore } from '@/stores/metaJudgeStore';

beforeEach(() => {
  localStorage.clear();
  useMetaJudgeStore.setState({ samples: [] });
});

describe('toSample · 抽检语义翻译', () => {
  it('认可 MVP → 裁判说可用、人也说可用', () => {
    const s = toSample({ agentId: 'a', verdict: 'MVP', agreed: true });
    expect(s.judgeVerdict).toBe(true);
    expect(s.gold).toBe(true);
  });

  it('不认可 MVP → 裁判说可用、人说不可用', () => {
    const s = toSample({ agentId: 'a', verdict: 'MVP', agreed: false });
    expect(s.judgeVerdict).toBe(true);
    expect(s.gold).toBe(false);
  });

  it('认可 FIRED → 裁判说不可用、人也说不可用（双 false 仍是一致）', () => {
    const s = toSample({ agentId: 'a', verdict: 'FIRED', agreed: true });
    expect(s.judgeVerdict).toBe(false);
    expect(s.gold).toBe(false);
  });

  it('不认可 FIRED → 人认为该 agent 其实可用（关键：不能写成 gold=false）', () => {
    const s = toSample({ agentId: 'a', verdict: 'FIRED', agreed: false });
    expect(s.judgeVerdict).toBe(false);
    expect(s.gold).toBe(true);
  });

  it('OBSERVE 归入「可用」一侧（元评估问的是准入结论靠不靠谱）', () => {
    expect(toSample({ agentId: 'a', verdict: 'OBSERVE', agreed: true }).judgeVerdict).toBe(true);
  });

  it('带上工种作为诊断维度与置信度用于校准分析', () => {
    const s = toSample({ agentId: 'a', verdict: 'MVP', agreed: true, dim: 'code', confidence: 0.9 });
    expect(s.dim).toBe('code');
    expect(s.confidence).toBe(0.9);
    expect(s.ts).toBeTruthy();
  });

  it('推理思维链透传进样本（供第四种诊断：推理-结论一致性）', () => {
    const s = toSample({
      agentId: 'a',
      verdict: 'MVP',
      agreed: true,
      reasoning: '候选兑现了可运行性要点，全部达标。',
    });
    expect(s.reasoning).toBe('候选兑现了可运行性要点，全部达标。');
  });

  it('未提供 reasoning → 样本里为 null（不影响既有语义）', () => {
    const s = toSample({ agentId: 'a', verdict: 'MVP', agreed: true });
    expect(s.reasoning).toBeNull();
  });

  it('recordReview 把 reasoning 一并存入样本库', () => {
    useMetaJudgeStore.getState().recordReview({
      agentId: 'a',
      verdict: 'MVP',
      agreed: true,
      reasoning: '整体正确，满足要求。',
    });
    const stored = useMetaJudgeStore.getState().samples[0];
    expect(stored?.reasoning).toBe('整体正确，满足要求。');
  });
});

describe('端到端：抽检 → 元评估报告', () => {
  it('全部认可 → 认可率 100%', () => {
    const store = useMetaJudgeStore.getState();
    for (let i = 0; i < 5; i += 1) {
      store.recordReview({ agentId: `a${i}`, verdict: 'MVP', agreed: true });
    }
    const report = assessMetaJudge(useMetaJudgeStore.getState().samples);
    expect(report.sampleCount).toBe(5);
    expect(report.accuracy).toBe(1);
    expect(report.overallAcceptable).toBe(true);
  });

  it('半数不认可 → 认可率跌破可接受阈值，面板据此建议更换裁判', () => {
    const store = useMetaJudgeStore.getState();
    for (let i = 0; i < 4; i += 1) {
      store.recordReview({ agentId: `a${i}`, verdict: 'MVP', agreed: i % 2 === 0 });
    }
    const report = assessMetaJudge(useMetaJudgeStore.getState().samples);
    expect(report.accuracy).toBe(0.5);
    expect(report.overallAcceptable).toBe(false);
  });

  it('样本持久化到 localStorage（刷新后抽检记录不丢）', () => {
    useMetaJudgeStore.getState().recordReview({ agentId: 'a', verdict: 'MVP', agreed: true });
    const raw = localStorage.getItem('agentcorp.metaJudge.samples');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toHaveLength(1);
  });

  it('clear 清空样本（换裁判后重新积累）', () => {
    const store = useMetaJudgeStore.getState();
    store.recordReview({ agentId: 'a', verdict: 'MVP', agreed: true });
    store.clear();
    expect(useMetaJudgeStore.getState().samples).toEqual([]);
  });

  it('按工种分组诊断：能指出裁判在哪类任务上更不准', () => {
    const store = useMetaJudgeStore.getState();
    // code 全对，image 全错
    for (let i = 0; i < 3; i += 1) {
      store.recordReview({ agentId: `c${i}`, verdict: 'MVP', agreed: true, dim: 'code' });
      store.recordReview({ agentId: `i${i}`, verdict: 'MVP', agreed: false, dim: 'image' });
    }
    const report = assessMetaJudge(useMetaJudgeStore.getState().samples);
    expect(report.weakestDim?.dim).toBe('image');
    expect(report.weakestDim?.acceptable).toBe(false);
  });
});
