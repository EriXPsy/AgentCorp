/**
 * 5 个 Skill handler 实现（GOAI 复赛必选项 · Skill 调用入口 + 失败降级）。
 * --------------------------------------------------------------------------
 * 每个 handler 都是可被 Skill 注册表（registry.ts）绑定的可调用入口；
 * 统一返回 SkillResult：成功 { ok:true, data }，异常/降级 { ok:false, degraded:true, reason }。
 * 失败降级铁律：任意 handler 抛错都不冒泡到调用方，统一返回 degraded 结果，
 * 保证赛道「调用 Skill」可被真实驱动且永不 panic。
 */
import { reviewBossDecision } from './bossDecision';
import {
  runClosedLoop,
  type JudgeFn,
  type ClosedLoopResult,
} from '../closedLoop';
import { aggregateRadars, majorityVerdict } from '@/services/judgeEnsemble';
import { passK } from '@/engine/evaluation/passK';
import { auditJudgeBias } from '@/services/judgeClient';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import type { RadarScore, Verdict, BossProfile } from '@/types/evaluation';

/** Skill 调用统一返回结构（成功 / 失败降级）。 */
export interface SkillResult {
  ok: boolean;
  degraded?: boolean;
  reason?: string;
  data?: unknown;
}

/** Skill handler 签名：任意入参 → 异步返回 SkillResult。 */
export type SkillHandler = (args: any) => Promise<SkillResult>;

/**
 * agent_interview：HR 结构化面试简报（纯计算，无外部调用）。
 * 返回 InterviewReport：候选 id / 转录长度 / 目标维度 / 交接说明。
 */
export async function agentInterviewSkill(args: {
  candidateId: string;
  transcript: string;
  candidateName?: string;
}): Promise<SkillResult> {
  try {
    const note = `基于候选 persona 完成结构化面试，转录长度 ${args.transcript.length} 字符，交接至评估中心。`;
    const data = {
      candidateId: args.candidateId,
      transcriptLen: args.transcript.length,
      targetDims: RADAR_DIMS,
      note,
    };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, degraded: true, reason: `agent_interview 失败：${String(e)}` };
  }
}

/**
 * capability_assessment：k 次 ensemble 评分 + 聚合 + pass^k + 偏差审计。
 * 与闭环 evaluator 的 tool/verify 阶段同构；judge 全部返回 null → 降级返回（不抛）。
 */
export async function capabilityAssessmentSkill(args: {
  agentId: string;
  transcript: string;
  judge: JudgeFn;
  k?: number;
  threshold?: number;
}): Promise<SkillResult> {
  try {
    const k = args.k ?? 3;
    const threshold = args.threshold ?? 3.5;
    const radars: RadarScore[] = [];
    const verdicts: (Verdict | null)[] = [];
    const confidences: number[] = [];
    let judgeCount = 0;

    for (let i = 0; i < k; i += 1) {
      // 每次 variant=i 旋转维度顺序（对抗位置偏差，自洽扰动），与闭环 ensemble 同构
      const out = await args
        .judge({ agentId: args.agentId, transcript: args.transcript, variant: i, bossProfile: null })
        .catch(() => null);
      if (!out) continue;
      radars.push(out.radar);
      verdicts.push(out.verdict);
      confidences.push(out.confidence);
      judgeCount += 1;
    }

    // judge 全 null → 降级返回（不能抛）
    if (judgeCount === 0) {
      return {
        ok: false,
        degraded: true,
        reason: 'capability_assessment：评委（judge）全部返回 null，无法产出评估，降级返回。',
      };
    }

    const meanRadar = aggregateRadars(radars);
    const verdict = majorityVerdict(verdicts);
    const confidence = confidences.length
      ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
      : 0;
    const biasAudit = auditJudgeBias(radars);
    const pk = passK(radars, { k: radars.length, threshold });
    const source: 'judge' | 'mixed' | 'degraded' =
      judgeCount === 0 ? 'degraded' : judgeCount === radars.length ? 'judge' : 'mixed';

    const data = {
      radars,
      meanRadar,
      verdict,
      confidence,
      passK: pk,
      biasAudit,
      source,
    };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, degraded: true, reason: `capability_assessment 失败：${String(e)}` };
  }
}

/**
 * reliability_audit：基于已有雷达做 pass^k + 偏差审计（去偏 / 可靠性）。
 * radars 为空 → 降级返回（不抛）。
 */
export async function reliabilityAuditSkill(args: {
  radars: RadarScore[];
  threshold?: number;
}): Promise<SkillResult> {
  try {
    if (!args.radars || args.radars.length === 0) {
      return {
        ok: false,
        degraded: true,
        reason: 'reliability_audit：radars 为空，无法审计，降级返回。',
      };
    }
    const threshold = args.threshold ?? 3.5;
    const pk = passK(args.radars, { k: args.radars.length, threshold });
    const biasAudit = auditJudgeBias(args.radars);
    return { ok: true, data: { passK: pk, biasAudit } };
  } catch (e) {
    return { ok: false, degraded: true, reason: `reliability_audit 失败：${String(e)}` };
  }
}

/**
 * boss_review：调用 boss_review Skill 的唯一真源决策逻辑（reviewBossDecision）。
 * evaluation 缺失 → 降级返回（不抛）。
 */
export async function bossReviewSkill(args: {
  evaluation: {
    passK: { allPass: boolean; passRate: number };
    biasAudit: { unstable: boolean; maxSpread: number };
    verdict: Verdict | null;
    confidence: number;
  };
  bossProfile?: BossProfile | null;
}): Promise<SkillResult> {
  try {
    if (!args.evaluation) {
      return {
        ok: false,
        degraded: true,
        reason: 'boss_review：evaluation 缺失，无法评审，降级返回。',
      };
    }
    const data = reviewBossDecision(args);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, degraded: true, reason: `boss_review 失败：${String(e)}` };
  }
}

/**
 * orchestrate：编排端到端闭环（薄委托 runClosedLoop）。
 * candidatePersona 置空（persona 由面试转录体现），其余来自入参。
 */
export async function orchestrateSkill(args: {
  requirement: string;
  candidateId: string;
  candidateName: string;
  transcript: string;
  bossProfile?: BossProfile | null;
  k?: number;
  threshold?: number;
  judge: JudgeFn;
}): Promise<SkillResult> {
  try {
    const req = {
      requirement: args.requirement,
      candidateId: args.candidateId,
      candidateName: args.candidateName,
      candidatePersona: '',
      transcript: args.transcript,
      bossProfile: args.bossProfile ?? null,
      k: args.k ?? 3,
      threshold: args.threshold ?? 3.5,
      judge: args.judge,
    };
    const result: ClosedLoopResult = await runClosedLoop(req);
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, degraded: true, reason: `orchestrate 失败：${String(e)}` };
  }
}
