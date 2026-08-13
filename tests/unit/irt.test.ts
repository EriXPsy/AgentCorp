/**
 * IRT 信息增益模块单测（G1）。
 * 覆盖 2PL / Fisher 信息量 / 后验熵 / EAP / 期望信息增益(EIG) 的基本数学性质，
 * 确保「信息增益选题」的排序语义正确：零证据最该问、信息边际递减、
 * 多题夹逼（易题答对+难题答错）才能把能力估计收敛成峰。
 */
import { describe, it, expect } from 'vitest';
import {
  irt2pl,
  fisherInfo,
  posteriorEntropy,
  priorDistribution,
  bayesUpdate,
  eapAbility,
  dimInformationGain,
  thetaGrid,
  DEFAULT_ITEM_A,
  DEFAULT_ITEM_B,
} from '@/engine/interview/irt';

const GRID = thetaGrid();

describe('irt2pl 基本性质', () => {
  it('输出恒在 (0,1) 且单调递增于 θ', () => {
    const a = 1.2;
    const b = 0.3;
    let prev = -1;
    for (let t = -3; t <= 3; t += 0.5) {
      const p = irt2pl(t, a, b);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = p;
    }
  });

  it('在 θ=b 处恰为 0.5（难度点）', () => {
    expect(irt2pl(0.3, 1.2, 0.3)).toBeCloseTo(0.5, 6);
    expect(irt2pl(-1, 0.8, -1)).toBeCloseTo(0.5, 6);
  });

  it('更高能力 θ 给出更高正确率', () => {
    expect(irt2pl(2, 1, 0)).toBeGreaterThan(irt2pl(-2, 1, 0));
  });
});

describe('fisherInfo 基本性质', () => {
  it('在 θ=b 处取最大值（P=0.5），两端趋于 0', () => {
    const a = 1.0;
    const b = 0.5;
    const atPeak = fisherInfo(b, a, b);
    expect(atPeak).toBeCloseTo((a * a) / 4, 6); // a²·0.25
    expect(fisherInfo(b - 3, a, b)).toBeLessThan(atPeak);
    expect(fisherInfo(b + 3, a, b)).toBeLessThan(atPeak);
  });

  it('区分度 a 越大，峰值信息量越大', () => {
    expect(fisherInfo(0, 2, 0)).toBeGreaterThan(fisherInfo(0, 1, 0));
  });
});

describe('后验熵 / EAP（2PL 语义正确性）', () => {
  it('无作答时后验=先验，熵达到最大（最不确定）', () => {
    const prior = priorDistribution({ thetaGrid: GRID });
    const h = posteriorEntropy(prior);
    expect(h).toBeGreaterThan(3.0); // ln(41)≈3.71
  });

  it('多题夹逼（易题答对+难题答错）收敛成峰，熵显著压低且定位能力', () => {
    const prior = priorDistribution({ thetaGrid: GRID });
    // 8 道高区分度题夹逼：易题(θ<-0.5)全对 + 难题(θ>0.5)全错 → 能力被圈定在 0 附近成峰
    const peaking = [
      { correct: true, a: 20, b: -3 },
      { correct: true, a: 20, b: -2 },
      { correct: true, a: 20, b: -1 },
      { correct: true, a: 20, b: -0.5 },
      { correct: false, a: 20, b: 0.5 },
      { correct: false, a: 20, b: 1 },
      { correct: false, a: 20, b: 2 },
      { correct: false, a: 20, b: 3 },
    ];
    const posterior = bayesUpdate(prior, GRID, peaking);
    const uniform = posteriorEntropy(priorDistribution({ thetaGrid: GRID }));
    const concentrated = posteriorEntropy(posterior);
    expect(concentrated).toBeLessThan(uniform);
    expect(concentrated).toBeLessThan(uniform * 0.8); // 显著更确定（相对均匀先验）
    expect(concentrated).toBeLessThan(2.6);
    expect(Math.abs(eapAbility(posterior, GRID))).toBeLessThan(0.5); // 定位于 0 附近
  });

  it('EAP 随高难度答对右移', () => {
    const prior = priorDistribution({ thetaGrid: GRID });
    const before = bayesUpdate(prior, GRID, []);
    const after = bayesUpdate(prior, GRID, [
      { correct: true, a: 5, b: 1 },
      { correct: true, a: 5, b: 1.5 },
    ]);
    expect(eapAbility(after, GRID)).toBeGreaterThan(eapAbility(before, GRID));
  });
});

describe('dimInformationGain（EIG）信息增益语义', () => {
  const oneCorrect: { correct: boolean; a: number; b: number }[] = [
    { correct: true, a: DEFAULT_ITEM_A, b: DEFAULT_ITEM_B },
  ];
  const threeCorrect: { correct: boolean; a: number; b: number }[] = [
    { correct: true, a: DEFAULT_ITEM_A, b: DEFAULT_ITEM_B },
    { correct: true, a: DEFAULT_ITEM_A, b: DEFAULT_ITEM_B },
    { correct: true, a: DEFAULT_ITEM_A, b: DEFAULT_ITEM_B },
  ];
  // 多题夹逼成峰：能力已高度确定 → 再问几乎无增益
  const peaking: { correct: boolean; a: number; b: number }[] = [
    { correct: true, a: 20, b: -3 },
    { correct: true, a: 20, b: -2 },
    { correct: true, a: 20, b: -1 },
    { correct: true, a: 20, b: -0.5 },
    { correct: false, a: 20, b: 0.5 },
    { correct: false, a: 20, b: 1 },
    { correct: false, a: 20, b: 2 },
    { correct: false, a: 20, b: 3 },
  ];

  it('零证据维 EIG 最大（最该问）', () => {
    expect(dimInformationGain([])).toBeGreaterThan(dimInformationGain(oneCorrect));
  });

  it('边际信息递减：多答对一维的增益 < 少答对一维', () => {
    expect(dimInformationGain(oneCorrect)).toBeGreaterThan(dimInformationGain(threeCorrect));
  });

  it('能力已被夹逼确定后 EIG 趋近 0（不再有增益）', () => {
    expect(dimInformationGain(peaking)).toBeLessThan(0.05);
  });
});
