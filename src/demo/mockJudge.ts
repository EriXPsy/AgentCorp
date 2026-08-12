/**
 * 确定性 mock 评委（离线 / 沙箱可验证版）。
 * 真实 judgeClient 网关（127.0.0.1:3210）不可达时，由本 mock 提供与真评委同构的
 * RadarScore + verdict + confidence，使闭环可跑通并被 vitest 验证。
 * 关键：k 次采样之间引入**可复现的小扰动**（基于 candidateId+variant 哈希），
 * 以便真实驱动 pass^k / 偏差审计逻辑（否则全相同样本会让审计失去意义）。
 */
import type { RadarScore, Verdict } from '@/types/evaluation';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import type { JudgeFn, JudgeFnInput, JudgeFnOutput } from './closedLoop';

/** FNV-1a 32bit 哈希（与 judgeClient.hashAgentId 同源思路，渲染层无 node:crypto 时自包含） */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export const mockJudge: JudgeFn = async (input: JudgeFnInput): Promise<JudgeFnOutput | null> => {
  const h = hash(`${input.agentId}#${input.variant}`);
  // 基线 3.0–4.4，按候选区分
  const base = 3.0 + ((h % 1000) / 1000) * 1.4;
  const radar = {} as RadarScore;
  for (let i = 0; i < RADAR_DIMS.length; i += 1) {
    const dim = RADAR_DIMS[i];
    // 每维独立小扰动 [-0.3, +0.3]，由哈希高位派生，保证同 (candidateId,variant) 可复现
    const jitter = (((h >>> (i * 3)) % 100) / 100) * 0.6 - 0.3;
    radar[dim] = Math.round(clamp(base + jitter, 0, 5) * 10) / 10;
  }
  const avg = RADAR_DIMS.reduce((s, d) => s + (radar[d] ?? 0), 0) / RADAR_DIMS.length;
  const verdict: Verdict = avg >= 4 ? 'MVP' : avg >= 2.5 ? 'OBSERVE' : 'FIRED';
  return {
    radar,
    verdict,
    confidence: Math.round((0.7 + ((h % 20) / 100)) * 100) / 100,
    evidence: [`mock 评委（离线回退）：candidateId=${input.agentId}, variant=${input.variant}`],
  };
};
