/**
 * 多 Agent 闭环编排器（最小可跑闭环）
 * --------------------------------------------------------------------------
 * 把 roleCard.ts 的角色定义接进真实评估中心能力，跑通端到端 8 步闭环：
 *   任务输入(input) → 任务拆解(decompose) → 上下文传递(context) → 工具调用(tool)
 *   → 结果验证(verify) → 执行证据沉淀(evidence) → 审批与回滚(approve) → 经验沉淀(precipitate)
 *
 * 设计要点：
 *  - 本文件**零 Electron / IPC 副作用**：只 import 真实评估中心的纯函数
 *    （aggregateRadars / majorityVerdict / passK / auditJudgeBias）。
 *  - 评委（judge）**可注入**：真实 judgeClient 或 mock 均可，网关不可用时降级 mock，
 *    保证闭环在沙箱/离线态也能跑通并可被 vitest 验证（eval-in-the-loop 实证）。
 *  - 审批(approve)与经验沉淀(precipitate)由 **boss_review Skill** 产出
 *    （而非内联逻辑）；Skill 降级时本地纯函数兜底同一语义，闭环不中断。
 *  - 每个阶段产出都带 `phase` 标签（关键步骤另带 `skill` 标签），
 *    构成八步闭环与「Skill 真实被调用」的可核对证据。
 *
 * 这是「Agent 准入治理」的最小可运行闭环：
 * boss（决策）→ recruiter（基线测试）→ evaluator（能力评估）→ boss（拍板）。
 */
import type { RadarScore, RadarDim, Verdict, BossProfile } from '@/types/evaluation';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import { aggregateRadars } from '@/services/judgeEnsemble';
import { passK, type PassKResult } from '@/engine/evaluation/passK';
import { auditJudgeBias, type JudgeBiasAudit } from '@/services/judgeClient';
import type { RoleCard, ClosedLoopPhase } from '@/engine/agents/roleCard';
import { ROLE_CARD_BY_ID } from '@/engine/agents/roleCard';
import { runSkill } from './skills/registry';
import { latestRule } from './skills/experienceStore';
import {
  registerBuiltinSkills,
  bossReviewDecision,
  type PrecipitatedRule,
  type BossReviewOutput,
  type InterviewReport,
  type CapabilityAssessment,
  type ReliabilityAudit,
} from './skills/handlers';

/** 注入式评委：真实 judgeClient 或 mock 都实现此签名。 */
export interface JudgeFnInput {
  /** 被评候选 Agent 的 id */
  agentId: string;
  /** 面试转录（被评对象） */
  transcript: string;
  /** 维度顺序旋转变体（k 次 ensemble 各传不同值 → 平均位置偏差） */
  variant: number;
  /** 老板原型（个性化评估上下文） */
  bossProfile?: BossProfile | null;
}
export interface JudgeFnOutput {
  radar: RadarScore;
  verdict: Verdict;
  confidence: number;
  evidence: string[];
}
export type JudgeFn = (input: JudgeFnInput) => Promise<JudgeFnOutput | null>;

export interface ClosedLoopRequest {
  /** 来自 boss 的任务输入（招聘/评估需求） */
  requirement: string;
  candidateId: string;
  candidateName: string;
  /** 候选 Agent 的 persona（HR 面试官据此拆解维度） */
  candidatePersona: string;
  /** recruiter 收集到的面试转录（评估中心评分对象） */
  transcript: string;
  bossProfile?: BossProfile | null;
  /** ensemble 重复次数（默认 3） */
  k?: number;
  /** pass^k 单维通过阈值（默认 3.5） */
  threshold?: number;
  /** 注入的评委（真实或 mock） */
  judge: JudgeFn;
}

/** 单步轨迹（执行证据 = Trace，供可观测与复盘） */
export interface LoopStep {
  phase: ClosedLoopPhase;
  agentRole: RoleCard['role'];
  agentName: string;
  /** 该步实际调用的 Skill id（Skill 被真实调用的证据） */
  skill?: string;
  summary: string;
  payload?: unknown;
  ts: number;
}

export type BossAction = 'hire' | 'observe' | 'reject' | 'rollback';

export interface ClosedLoopResult {
  request: ClosedLoopRequest;
  /** dispatcher 拆解的任务计划（input → decompose） */
  plan: {
    jobType: 'image' | 'text' | 'code';
    targetDims: RadarDim[];
    steps: string[];
  };
  /** recruiter 产出的面试报告（context 上下文传递） */
  interviewReport: {
    candidateId: string;
    transcriptLen: number;
    targetDims: RadarDim[];
    note: string;
  };
  /** evaluator 评估中心结论（tool + verify） */
  evaluation: {
    radars: RadarScore[];
    meanRadar: RadarScore;
    verdict: Verdict | null;
    confidence: number;
    passK: PassKResult;
    biasAudit: JudgeBiasAudit;
    source: 'judge' | 'mixed' | 'degraded';
  };
  /** boss 拍板（approve：高风险动作需人工确认；由 boss_review Skill 产出） */
  bossDecision: {
    action: BossAction;
    reason: string;
    approvedBy: 'boss';
    requiresHumanAck: boolean;
    /** 决策来源：boss_review Skill 或本地降级兜底 */
    source: 'boss_review' | 'fallback';
  };
  /** 经验沉淀（precipitate：结构化可复用规则，由 boss_review Skill 产出） */
  precipitatedRule: PrecipitatedRule;
  /** 经验沉淀的人类可读文本（= precipitatedRule.rule，保留兼容旧 UI） */
  experience: string;
  /** 全链路轨迹（evidence：执行证据） */
  trace: LoopStep[];
}

const verdictLabel: Record<Verdict, string> = {
  MVP: 'MVP（可留用）',
  OBSERVE: '待观察',
  FIRED: 'Not recommended',
};
const phaseLabel: Record<ClosedLoopPhase, string> = {
  input: '任务输入',
  decompose: '任务拆解',
  context: '上下文传递',
  tool: '工具调用',
  verify: '结果验证',
  evidence: '证据沉淀',
  approve: '审批回滚',
  precipitate: '经验沉淀',
};

/**
 * 跑通端到端闭环。评委（judge）可注入；任意一次 judge 失败（返回 null）即降级 degraded，
 * 但闭环不中断，最终由 bias/confidence 体现不确定性。
 */
export async function runClosedLoop(req: ClosedLoopRequest): Promise<ClosedLoopResult> {
  registerBuiltinSkills(); // 幂等：确保 Skill 注册表就绪
  const trace: LoopStep[] = [];
  const role = (id: string): RoleCard =>
    ROLE_CARD_BY_ID[id] ?? ROLE_CARD_BY_ID.dispatcher!;
  const push = (phase: ClosedLoopPhase, agentId: string, summary: string, payload?: unknown, skill?: string) =>
    trace.push({ phase, agentRole: role(agentId).role, agentName: role(agentId).name, skill, summary, payload, ts: Date.now() });

  const k = req.k ?? 3;
  const threshold = req.threshold ?? 3.5;

  // ── Step 0 · input：boss 接收任务输入 ──
  push('input', 'boss', `老板接收招聘需求：${req.requirement.slice(0, 60)}…`);

  // ── Step 1 · decompose：dispatcher 拆解任务 ──
  const plan = {
    jobType: 'code' as const,
    targetDims: RADAR_DIMS,
    steps: ['recruiter:结构化面试', 'evaluator:六维评估+pass^k审计', 'boss:审批拍板'],
  };
  // 注：本步为编排器内联拆解，**未**经 runSkill 调用 `orchestrate` Skill，
  // 因此不打 skill 标签——trace 上的 skill 字段只标注「真实发生过的 Skill 调用」，
  // 不作宣传性标注（与 agentteams-adapter.ts 的同名步骤保持一致语义）。
  push('decompose', 'dispatcher', `编排主控拆解任务为 ${plan.steps.length} 步子任务，目标维度=${plan.targetDims.join('/')}`, plan);

  // ── Step 2 · context：recruiter → agent_interview Skill（降级则本地快照兜底） ──
  // 读回上一次闭环沉淀的经验规则，注入 interviewer/evaluator 上下文
  const priorRule = latestRule(req.candidateId);
  const interviewRes = await runSkill('agent_interview', {
    candidateId: req.candidateId,
    candidateName: req.candidateName,
    transcript: req.transcript,
    priorExperience: priorRule ?? undefined,
  });
  const interviewReport: InterviewReport = interviewRes.ok && interviewRes.data
    ? (interviewRes.data as InterviewReport)
    : {
        candidateId: req.candidateId,
        transcriptLen: req.transcript.length,
        targetDims: RADAR_DIMS,
        note: `agent_interview 降级（${interviewRes.reason ?? '未知'}），以原始转录快照交接。`,
      };
  push(
    'context',
    'recruiter',
    priorRule
      ? `${interviewReport.note}（已注入历史经验规则：训练重点=${priorRule.weakestDim}）`
      : interviewReport.note,
    { ...interviewReport, injectedRule: priorRule ?? undefined },
    'agent_interview',
  );

  // ── Step 3 · tool：evaluator → capability_assessment Skill（k 次 ensemble + 聚合） ──
  const assessRes = await runSkill('capability_assessment', {
    candidateId: req.candidateId,
    transcript: req.transcript,
    k,
    judge: req.judge,
    bossProfile: req.bossProfile ?? null,
    interviewReport,
  });
  const assess: CapabilityAssessment = (assessRes.data as CapabilityAssessment | undefined) ?? {
    radars: [],
    meanRadar: aggregateRadars([]),
    verdict: null,
    confidence: 0,
    evidence: [],
    source: 'degraded',
  };
  const { radars, meanRadar, verdict, confidence, source } = assess;

  push('tool', 'evaluator', `评估中心调用评委 ${radars.length}/${k} 次成功（source=${source}），逐维均值雷达已聚合`, {
    meanRadar,
  }, 'capability_assessment');

  // ── Step 3b · verify：evaluator → reliability_audit Skill（降级则本地复算） ──
  const auditRes = await runSkill('reliability_audit', { radars, threshold });
  const audit: ReliabilityAudit = auditRes.ok && auditRes.data
    ? (auditRes.data as ReliabilityAudit)
    : { passK: passK(radars, { k: radars.length, threshold }), biasAudit: auditJudgeBias(radars) };
  const pk = audit.passK;
  const bias = audit.biasAudit;
  push('verify', 'evaluator', `pass^k(allPass=${pk.allPass}, passRate=${pk.passRate})；偏差审计 unstable=${bias.unstable}(maxSpread=${bias.maxSpread})`, {
    passK: pk,
    biasAudit: bias,
  }, 'reliability_audit');

  // ── Step 4 · approve：boss 拍板——由 boss_review Skill 产出（高风险动作需人工确认）──
  const reviewRes = await runSkill('boss_review', {
    evaluation: { passK: pk, biasAudit: bias, verdict, confidence, meanRadar, source },
    candidateName: req.candidateName,
    candidateId: req.candidateId,
  });
  // 失败兜底：Skill 降级时本地纯函数复算同一语义，闭环不中断
  const review: BossReviewOutput = reviewRes.ok && reviewRes.data
    ? (reviewRes.data as BossReviewOutput)
    : bossReviewDecision({ passK: pk, biasAudit: bias, verdict, confidence, meanRadar, candidateName: req.candidateName });
  const reviewSource: 'boss_review' | 'fallback' = reviewRes.ok && reviewRes.data ? 'boss_review' : 'fallback';
  const { action, reason, requiresHumanAck } = review;
  push('approve', 'boss', `老板决策：${action.toUpperCase()}。${reason}（需人工确认=${requiresHumanAck}，来源=${reviewSource}）`, {
    action,
    requiresHumanAck,
    source: reviewSource,
  }, 'boss_review');

  // ── Step 5 · evidence：轨迹留痕（执行证据）──
  push('evidence', 'dispatcher', `已沉淀 ${trace.length} 步执行轨迹（Trace/Metrics），可供观测与复盘。`, {
    traceLen: trace.length,
  });

  // ── Step 6 · precipitate：经验沉淀（结构化可复用规则，由 boss_review Skill 产出）──
  const precipitatedRule = review.precipitatedRule;
  const experience = precipitatedRule.rule;
  push('precipitate', 'boss', experience, precipitatedRule, 'boss_review');

  return {
    request: req,
    plan,
    interviewReport,
    evaluation: { radars, meanRadar, verdict, confidence, passK: pk, biasAudit: bias, source },
    bossDecision: { action, reason, approvedBy: 'boss', requiresHumanAck, source: reviewSource },
    precipitatedRule,
    experience,
    trace,
  };
}

export { phaseLabel, verdictLabel };
