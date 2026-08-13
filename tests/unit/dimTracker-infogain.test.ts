/**
 * tests/unit/dimTracker-infogain.test.ts
 *
 * G1 缺口专项锁：题序「信息增益(EIG) 驱动」选题（路书 G1 / 熵收敛内核）。
 *
 * 本文件不重复 main dimTracker.test.ts 已覆盖的「覆盖度升序」旧语义，而是专门锁定：
 *   1. irt 引擎层：dimInformationGain 的「边际信息递减」与「夹逼后 EIG→0」性质；
 *   2. suggestFollowups 在 G1 重构后的可观察行为：
 *      - 零证据维 EIG 最大 → 永远最优先（即使其 coverage 也是 0）；
 *      - 已积累证据的维 EIG 递减 → 排在零证据维之后；
 *      - min 保底兜底保留（即使全部达标也有可点追问）。
 *
 * 运行：env -u NODE_OPTIONS npx vitest run tests/unit/dimTracker-infogain.test.ts
 */
import { describe, it, expect } from 'vitest';
import type { CraftDim, RadarDim } from '@/types/evaluation';
import type { InterviewTurn } from '@/types/interview';
import { dimInformationGain, type IrtResponse } from '@/engine/interview/irt';
import { suggestFollowups } from '@/engine/interview/dimTracker';

/** 强证据回答（命中全部四类信号）→ 证据强度满分 1 */
const RICH_REPLY = [
  '1. 首先明确交付物边界，例如接口契约（API schema）与字段格式，以及可验收的标准；',
  '2. 然后设计三类测试：单元测试、集成测试、回归测试，分支覆盖率目标 80% 以上，关键路径必须全部覆盖；',
  '3. 如果线上与本地行为不一致，则先回滚再定位，评估代价与风险之后再决定是否重新发布上线；',
  '4. 交付前我会给出一份检查清单，逐项勾选并标注最容易翻车的一项，涉及并发场景下的幂等处理，需要你逐条确认预期行为。',
].join('\n');

/** 弱证据回答（仅命中长度分）→ 0.15 */
const THIN_REPLY = '我会认真完成这个任务并且保证交付质量达到客户的要求';

/** 空回答 → 证据强度 0（视为作答错误/未达标） */
const EMPTY_REPLY = '';

function turnOf(over: Partial<InterviewTurn> & Pick<InterviewTurn, 'turn' | 'targetDims'>): InterviewTurn {
  return {
    qId: `q${over.turn}`,
    question: '题干',
    replyText: '',
    replyLatencyMs: null,
    tokensUsed: null,
    hrRatings: {},
    ts: '2026-08-13T00:00:00Z',
    ...over,
  };
}

/** 把一组「作答对错」序列包成 IRT 二项序列（统一默认 a/b，符合 dimResponses 的取法） */
function responsesOf(correctFlags: boolean[]): IrtResponse[] {
  return correctFlags.map((correct) => ({ correct, a: 1.0, b: 0 }));
}

describe('G1 · irt 引擎层 dimInformationGain（信息增益选题核心）', () => {
  it('★ 零证据维 EIG 最大（后验=先验，最不确定）→ 天然最优先', () => {
    const noEvidence = dimInformationGain([]);
    const oneCorrect = dimInformationGain(responsesOf([true]));
    expect(noEvidence).toBeGreaterThan(oneCorrect);
  });

  it('★ 边际信息递减：单条佐证 < 零证据；三条佐证 < 单条佐证', () => {
    const zero = dimInformationGain([]);
    const one = dimInformationGain(responsesOf([true]));
    const three = dimInformationGain(responsesOf([true, true, true]));
    expect(zero).toBeGreaterThan(one);
    expect(one).toBeGreaterThan(three);
  });

  it('★ 边际信息递减且残差为正：零证据 > 单条 > 夹逼（一正一反）；夹逼后 EIG 已很小但仍>0', () => {
    const zero = dimInformationGain([]);
    const one = dimInformationGain(responsesOf([true]));
    const bracketed = dimInformationGain(responsesOf([true, false]));
    // 严格单调递减（夹逼锁定当前能力，再问一题几乎无信息）
    expect(zero).toBeGreaterThan(one);
    expect(one).toBeGreaterThan(bracketed);
    // 默认宽先验下两条仍留少量残差（>0），但已严格小于单条佐证
    expect(bracketed).toBeGreaterThan(0);
    expect(bracketed).toBeLessThan(one);
  });

  it('★ 对称：单条「对」与单条「错」EIG 相等（2PL + 正态先验镜像对称）', () => {
    const oneCorrect = dimInformationGain(responsesOf([true]));
    const oneWrong = dimInformationGain(responsesOf([false]));
    expect(oneCorrect).toBeCloseTo(oneWrong, 6);
  });
});

describe('G1 · suggestFollowups（EIG 降序重排的可观察行为）', () => {
  it('★ 零证据维排在最前（G1 核心：最该问的是毫无信息的维）', () => {
    const turns: InterviewTurn[] = [
      turnOf({ turn: 1, targetDims: ['task', 'comm'], replyText: RICH_REPLY }),
      // quality / reliability 各被问过一次但证据偏薄；cost 从未被问（零证据）
      turnOf({ turn: 2, targetDims: ['quality'], replyText: THIN_REPLY }),
      turnOf({ turn: 3, targetDims: ['reliability'], replyText: THIN_REPLY }),
    ];
    const targetDims: (RadarDim | CraftDim)[] = ['task', 'comm', 'quality', 'reliability', 'cost'];
    const suggestions = suggestFollowups(turns, targetDims);
    // cost 零证据 → EIG 最大 → 必须排第一
    expect(suggestions[0].dim).toBe('cost');
    expect(suggestions[0].reason).toBe('尚未提问，零证据');
  });

  it('★ 强证据维（已高覆盖）不再被建议；其余零证据维按 EIG 优先', () => {
    const turns: InterviewTurn[] = [
      turnOf({ turn: 1, targetDims: ['task', 'comm'], replyText: RICH_REPLY }),
    ];
    const targetDims: (RadarDim | CraftDim)[] = ['task', 'comm', 'cost', 'quality'];
    const suggestions = suggestFollowups(turns, targetDims).map((s) => s.dim);
    // task / comm 已高覆盖（coverage=1≥0.8）→ 不出现；
    // 剩余 zero-evidence 的 cost / quality 进入建议（min=2 保底已满，不触发 fallback）
    expect(suggestions).not.toContain('task');
    expect(suggestions).not.toContain('comm');
    expect(suggestions).toHaveLength(2);
    expect(suggestions).toContain('cost');
    expect(suggestions).toContain('quality');
  });

  it('★ 边际递减可观察：同是薄弱维，证据更少者排在证据更多者之前', () => {
    // reliability：1 条薄弱证据（EIG 较大）；quality：3 条薄弱证据（EIG 较小）
    const turns: InterviewTurn[] = [
      turnOf({ turn: 1, targetDims: ['reliability'], replyText: THIN_REPLY }),
      turnOf({ turn: 2, targetDims: ['quality'], replyText: THIN_REPLY }),
      turnOf({ turn: 3, targetDims: ['quality'], replyText: THIN_REPLY }),
      turnOf({ turn: 4, targetDims: ['quality'], replyText: THIN_REPLY }),
    ];
    const targetDims: (RadarDim | CraftDim)[] = ['reliability', 'quality', 'cost'];
    const suggestions = suggestFollowups(turns, targetDims).map((s) => s.dim);
    // cost 零证据最前；其后 reliability（1 条证据）应排在 quality（3 条证据）之前
    expect(suggestions[0]).toBe('cost');
    expect(suggestions.indexOf('reliability')).toBeLessThan(suggestions.indexOf('quality'));
  });

  it('★ min 保底：即使全部维度均已高覆盖，仍保留最薄弱的 min 条（HR 始终有可点追问）', () => {
    const allCovered: InterviewTurn[] = [
      turnOf({ turn: 1, targetDims: ['task', 'comm'], replyText: RICH_REPLY }),
    ];
    const suggestions = suggestFollowups(allCovered, ['task', 'comm']);
    expect(suggestions).toHaveLength(2);
  });

  it('★ HR 评分路径（radar 维）：评分≥3 累积证据，证据更多者 EIG 更低、排得更后', () => {
    // quality：3 轮均 HR 给 4 分（≥3 → 全部正确）→ 证据充分、EIG 最低
    const qualityTurns: InterviewTurn[] = [1, 2, 3].map((t) =>
      turnOf({ turn: t, targetDims: ['quality'], replyText: EMPTY_REPLY, hrRatings: { quality: 4 } }),
    );
    // reliability：1 轮 HR 给 1 分（<3 → 错误）→ 仅 1 条证据、EIG 较高
    const reliabilityTurn = turnOf({
      turn: 4,
      targetDims: ['reliability'],
      replyText: EMPTY_REPLY,
      hrRatings: { reliability: 1 },
    });
    // cost 零证据
    const turns: InterviewTurn[] = [...qualityTurns, reliabilityTurn];
    const targetDims: (RadarDim | CraftDim)[] = ['quality', 'reliability', 'cost'];
    const suggestions = suggestFollowups(turns, targetDims).map((s) => s.dim);
    // cost 零证据最前；其后 reliability（1 条证据）排在 quality（3 条证据）之前
    expect(suggestions[0]).toBe('cost');
    expect(suggestions.indexOf('reliability')).toBeLessThan(suggestions.indexOf('quality'));
  });
});
