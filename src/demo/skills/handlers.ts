/**
 * 内建 Skill handlers
 * --------------------------------------------------------------------------
 * 把评估中心的纯函数能力封装为可被 AgentTeams 调用的 Skill handler：
 *   agent_interview        → 结构化面试报告（recruiter）
 *   capability_assessment  → k 次 ensemble 评分 + 聚合（evaluator）
 *   reliability_audit      → pass^k + 评委偏差审计（evaluator）
 *   boss_review            → 审批/回滚决策 + 结构化经验沉淀（boss）
 *   orchestrate            → 任务拆解 + 端到端闭环编排（dispatcher）
 *
 * 铁律：每个 handler 失败不抛——异常/依赖缺失一律降级返回
 * `{ ok:false, degraded:true, reason }`，即 Skill 契约声明的「失败处理机制」。
 * 模块加载时自动把 4 张角色卡上的 Skill 投影注册进 registry。
 */
import type { RadarScore, RadarDim, Verdict, BossProfile } from '@/types/evaluation';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import { aggregateRadars, majorityVerdict } from '@/services/judgeEnsemble';
import { passK, type PassKResult } from '@/engine/evaluation/passK';
import { auditJudgeBias, type JudgeBiasAudit } from '@/services/judgeClient';
import { ROLE_CARDS } from '@/engine/agents/roleCard';
import { ctx } from '../plugins/context';
import { projectSkill, type SkillResult } from './registry';
import { saveRule } from './experienceStore';
import type { JudgeFn, BossAction, ClosedLoopRequest, ClosedLoopResult } from '../closedLoop';

const VERDICT_LABEL: Record<Verdict, string> = {
  MVP: 'MVP（可留用）',
  OBSERVE: '待观察',
  FIRED: 'Not recommended',
};

/* ─────────────────────── agent_interview（recruiter） ─────────────────────── */

export interface InterviewReport {
  candidateId: string;
  transcriptLen: number;
  targetDims: RadarDim[];
  note: string;
}

export async function agentInterviewHandler(
  args: Record<string, unknown>,
): Promise<SkillResult<InterviewReport>> {
  const transcript = typeof args.transcript === 'string' ? args.transcript : '';
  const candidateId = typeof args.candidateId === 'string' ? args.candidateId : 'unknown';
  // 失败处理：转录为空 → 降级快照，不臆造答案
  if (!transcript.trim()) {
    return { ok: false, degraded: true, reason: '面试转录为空，按失败处理约定降级快照返回，不臆造答案。' };
  }
  return {
    ok: true,
    degraded: false,
    data: {
      candidateId,
      transcriptLen: transcript.length,
      targetDims: RADAR_DIMS,
      note: `基于候选 persona 完成结构化面试，转录长度 ${transcript.length} 字符，交接至评估中心。`,
    },
  };
}

/* ─────────────────── capability_assessment（evaluator） ─────────────────── */

export interface CapabilityAssessment {
  radars: RadarScore[];
  meanRadar: RadarScore;
  verdict: Verdict | null;
  confidence: number;
  evidence: string[];
  source: 'judge' | 'mixed' | 'degraded';
}

export async function capabilityAssessmentHandler(
  args: Record<string, unknown>,
): Promise<SkillResult<CapabilityAssessment>> {
  const judge = args.judge as JudgeFn | undefined;
  if (typeof judge !== 'function') {
    return { ok: false, degraded: true, reason: 'judge 未注入，无法执行多维评估（不造分）。' };
  }
  const candidateId = typeof args.candidateId === 'string' ? args.candidateId : 'unknown';
  const transcript = typeof args.transcript === 'string' ? args.transcript : '';
  const bossProfile = (args.bossProfile ?? null) as BossProfile | null;
  const k = Math.max(1, Number(args.k ?? 3) || 3);

  const radars: RadarScore[] = [];
  const verdicts: (Verdict | null)[] = [];
  const confidences: number[] = [];
  const evidence: string[] = [];
  for (let i = 0; i < k; i += 1) {
    // 每次 variant=i 旋转维度顺序（对抗位置偏差）
    const out = await judge({ agentId: candidateId, transcript, variant: i, bossProfile }).catch(
      () => null,
    );
    if (!out) continue;
    radars.push(out.radar);
    verdicts.push(out.verdict);
    confidences.push(out.confidence);
    evidence.push(...out.evidence);
  }

  // 失败处理：judge 全部失败 → degraded，不造分
  if (radars.length === 0) {
    return {
      ok: false,
      degraded: true,
      reason: `judge ${k} 次调用全部失败/为空，按降级路径返回零样本结果。`,
      data: {
        radars,
        meanRadar: aggregateRadars(radars),
        verdict: null,
        confidence: 0,
        evidence,
        source: 'degraded',
      },
    };
  }

  const confidence =
    Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100;
  return {
    ok: true,
    degraded: radars.length < k,
    data: {
      radars,
      meanRadar: aggregateRadars(radars),
      verdict: majorityVerdict(verdicts),
      confidence,
      evidence,
      source: radars.length === k ? 'judge' : 'mixed',
    },
  };
}

/* ───────────────────── reliability_audit（evaluator） ───────────────────── */

export interface ReliabilityAudit {
  passK: PassKResult;
  biasAudit: JudgeBiasAudit;
}

export async function reliabilityAuditHandler(
  args: Record<string, unknown>,
): Promise<SkillResult<ReliabilityAudit>> {
  const radars = Array.isArray(args.radars) ? (args.radars as RadarScore[]) : [];
  // 失败处理：无有效样本 → degraded 不抛
  if (radars.length === 0) {
    return { ok: false, degraded: true, reason: '无有效雷达分样本，可靠性审计降级。' };
  }
  const threshold = Number(args.threshold ?? 3.5) || 3.5;
  return {
    ok: true,
    degraded: false,
    data: {
      passK: passK(radars, { k: radars.length, threshold }),
      biasAudit: auditJudgeBias(radars),
    },
  };
}

/* ─────────────────────── boss_review（boss） ─────────────────────── */

/** 结构化经验沉淀规则（precipitate 产出，可复用为 Skill 输入） */
export interface PrecipitatedRule {
  /** 最弱维 → 下一轮定向追问 / 训练重点 */
  weakestDim: RadarDim;
  /** 最强维 → 复用价值来源 */
  strongestDim: RadarDim;
  trainingFocus: string;
  reuseNote: string;
  /** 人类可读规则文本 */
  rule: string;
  source: 'boss_review';
  ts: number;
}

export interface BossReviewInput {
  passK: PassKResult;
  biasAudit: JudgeBiasAudit;
  verdict: Verdict | null;
  confidence: number;
  meanRadar: RadarScore;
  candidateName?: string;
  /** 评估来源；'degraded' 时决策照常产出，但不沉淀经验规则，避免低质量结论污染后续判断 */
  source?: 'judge' | 'mixed' | 'degraded';
}

export interface BossReviewOutput {
  action: BossAction;
  reason: string;
  requiresHumanAck: boolean;
  precipitatedRule: PrecipitatedRule;
}

/** 由均值雷达生成结构化经验沉淀规则（最弱维=训练重点，最强维=复用价值）。 */
export function buildPrecipitatedRule(meanRadar: RadarScore, candidateName: string): PrecipitatedRule {
  const weakest = RADAR_DIMS.reduce((a, b) => ((meanRadar[a] ?? 0) <= (meanRadar[b] ?? 0) ? a : b));
  const strongest = RADAR_DIMS.reduce((a, b) => ((meanRadar[a] ?? 0) >= (meanRadar[b] ?? 0) ? a : b));
  const trainingFocus = `最弱维「${weakest}」需在下一轮面试定向追问（pass^k 未全达标的维度=训练重点）。`;
  const reuseNote = `最强维「${strongest}」的能力证据可沉淀复用。`;
  return {
    weakestDim: weakest,
    strongestDim: strongest,
    trainingFocus,
    reuseNote,
    rule: `经验规则：对「${candidateName}」类候选，优先考察最强维「${strongest}」的复用价值；${trainingFocus}`,
    source: 'boss_review',
    ts: Date.now(),
  };
}

/** boss 审批决策（纯函数，closedLoop 与 handler 共用同一语义）。 */
export function bossReviewDecision(input: BossReviewInput): BossReviewOutput {
  const { passK: pk, biasAudit: bias, verdict, confidence, meanRadar, candidateName = '候选' } = input;
  const precipitatedRule = buildPrecipitatedRule(meanRadar, candidateName);

  if (bias.unstable) {
    return {
      action: 'rollback',
      reason: `评委离散度偏高（maxSpread=${bias.maxSpread} > 阈值）：结论不稳定，触发回滚并要求人工复核。`,
      requiresHumanAck: true,
      precipitatedRule,
    };
  }
  if (pk.allPass && verdict === 'MVP' && confidence >= 0.7) {
    return {
      action: 'hire',
      reason: `六维全达标（pass^k allPass=true）且判定为 ${VERDICT_LABEL.MVP}、置信度 ${confidence}：建议录用。`,
      requiresHumanAck: true, // 录用是高风险写动作，需人类二次确认
      precipitatedRule,
    };
  }
  if (pk.passRate >= 0.6 && (verdict === 'MVP' || verdict === 'OBSERVE')) {
    return {
      action: 'observe',
      reason: `通过率 ${pk.passRate}、判定 ${verdict ? VERDICT_LABEL[verdict] : '未知'}：暂观察，不立即录用。`,
      requiresHumanAck: false,
      precipitatedRule,
    };
  }
  return {
    action: 'reject',
    reason: `通过率 ${pk.passRate} 不足或其他未达标：执行 Not recommended。`,
    requiresHumanAck: false,
    precipitatedRule,
  };
}

export async function bossReviewHandler(
  args: Record<string, unknown>,
): Promise<SkillResult<BossReviewOutput>> {
  const evaluation = args.evaluation as Partial<BossReviewInput> | undefined;
  // 形状校验（不只查存在性）：垃圾输入 → 强制转人工，不带病决策
  const shapeOk =
    evaluation &&
    evaluation.passK &&
    typeof evaluation.passK === 'object' &&
    typeof evaluation.passK.passRate === 'number' &&
    typeof evaluation.passK.allPass === 'boolean' &&
    evaluation.biasAudit &&
    typeof evaluation.biasAudit === 'object' &&
    typeof evaluation.biasAudit.unstable === 'boolean' &&
    evaluation.meanRadar &&
    typeof evaluation.meanRadar === 'object' &&
    Number.isFinite(evaluation.confidence);
  if (!shapeOk) {
    // 失败处理：置信度/输入不足 → 强制转人工，不自动决策
    return {
      ok: false,
      degraded: true,
      reason: '评估输入不完整或形状非法（缺 passK/biasAudit/meanRadar/confidence），按安全边界强制转人工复核。',
    };
    }
  const input = evaluation as BossReviewInput;
  const output = bossReviewDecision({
    passK: input.passK,
    biasAudit: input.biasAudit,
    verdict: input.verdict ?? null,
    confidence: input.confidence,
    meanRadar: input.meanRadar,
    candidateName:
      typeof args.candidateName === 'string' ? args.candidateName : undefined,
  });
  // 决策产出即沉淀——结构化规则写入经验 Store，供下一次闭环复用注入。
  // 降级评估（judge 全失败等）不沉淀：避免把无意义规则注入后续候选。
  if (input.source !== 'degraded') {
    saveRule(typeof args.candidateId === 'string' ? args.candidateId : '_global', output.precipitatedRule);
  }
  return {
    ok: true,
    degraded: false,
    data: output,
  };
}

/* ─────────────────────── orchestrate（dispatcher） ─────────────────────── */

export async function orchestrateHandler(
  args: Record<string, unknown>,
): Promise<SkillResult<ClosedLoopResult>> {
  const request = args.request as ClosedLoopRequest | undefined;
  if (!request || typeof request.judge !== 'function') {
    return { ok: false, degraded: true, reason: '缺少闭环请求或 judge 注入，编排降级。' };
  }
  // 动态 import 避免与 closedLoop.ts 形成模块初始化环
  const { runClosedLoop } = await import('../closedLoop');
  const data = await runClosedLoop(request);
  return { ok: true, degraded: data.evaluation.source === 'degraded', data };
}

/* ─────────────────────── 注册（模块加载即生效） ─────────────────────── */

export const BUILTIN_HANDLERS = {
  agent_interview: agentInterviewHandler,
  capability_assessment: capabilityAssessmentHandler,
  reliability_audit: reliabilityAuditHandler,
  boss_review: bossReviewHandler,
  orchestrate: orchestrateHandler,
} as const;

/** 把 4 张角色卡上的全部 Skill 以真实 handler 投影注册（幂等，可重复调用）。
 *  不覆盖已注册项——测试/调用方后注入的 mock 优先（registry 语义：后注册覆盖先注册）。 */
export function registerBuiltinSkills(): void {
  for (const card of ROLE_CARDS) {
    for (const skill of card.skills) {
      const handler = BUILTIN_HANDLERS[skill.id as keyof typeof BUILTIN_HANDLERS];
      if (handler && !ctx.has(skill.id)) ctx.register(projectSkill(card, skill, handler));
    }
  }
}

registerBuiltinSkills();
