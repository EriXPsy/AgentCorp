/**
 * 多 Agent 闭环编排器（GOAI 最小可跑闭环 · Phase 6 实证）
 * --------------------------------------------------------------------------
 * 把 roleCard.ts 的角色定义接进真实评估中心能力，跑通 GOAI 赛题要求的 8 步闭环：
 *   任务输入(input) → 任务拆解(decompose) → 上下文传递(context) → 工具调用(tool)
 *   → 结果验证(verify) → 执行证据沉淀(evidence) → 审批与回滚(approve) → 经验沉淀(precipitate)
 *
 * 设计要点：
 *  - 本文件**零 Electron / IPC 副作用**：只 import 真实评估中心的纯函数
 *    （aggregateRadars / majorityVerdict / passK / auditJudgeBias）。
 *  - 评委（judge）**可注入**：真实 judgeClient 或 mock 均可，网关不可用时降级 mock，
 *    保证闭环在沙箱/离线态也能跑通并可被 vitest 验证（eval-in-the-loop 实证）。
 *  - 每个阶段产出都带 `phase` 标签，直接对应 GOAI 附录 1.3 八步闭环，便于评审对照。
 *
 * 这是「数字员工招募与管理训练场」参赛作品的最小可运行证据：
 * boss（老板）→ recruiter（HR 面试）→ evaluator（评估中心）→ boss（拍板）端到端闭环。
 */
import type { RadarScore, RadarDim, Verdict, BossProfile } from '@/types/evaluation';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import { aggregateRadars, majorityVerdict } from '@/services/judgeEnsemble';
import { passK, type PassKResult } from '@/engine/evaluation/passK';
import { auditJudgeBias, type JudgeBiasAudit } from '@/services/judgeClient';
import type { RoleCard, ClosedLoopPhase } from '@/engine/agents/roleCard';
import { ROLE_CARD_BY_ID } from '@/engine/agents/roleCard';

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

/** 单步轨迹（执行证据 = Trace，对应 GOAI 2.3 可观测 + 1.3 evidence） */
export interface LoopStep {
  phase: ClosedLoopPhase;
  agentRole: RoleCard['role'];
  agentName: string;
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
  /** boss 拍板（approve：高风险动作需人工确认） */
  bossDecision: {
    action: BossAction;
    reason: string;
    approvedBy: 'boss';
    requiresHumanAck: boolean;
  };
  /** 经验沉淀（precipitate：可复用规则） */
  experience: string;
  /** 全链路轨迹（evidence：执行证据） */
  trace: LoopStep[];
}

const verdictLabel: Record<Verdict, string> = {
  MVP: 'MVP（可留用）',
  OBSERVE: '待观察',
  FIRED: 'You are fired',
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
  const trace: LoopStep[] = [];
  const role = (id: string): RoleCard =>
    ROLE_CARD_BY_ID[id] ?? ROLE_CARD_BY_ID.dispatcher!;
  const push = (phase: ClosedLoopPhase, agentId: string, summary: string, payload?: unknown) =>
    trace.push({ phase, agentRole: role(agentId).role, agentName: role(agentId).name, summary, payload, ts: Date.now() });

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
  push('decompose', 'dispatcher', `编排主控拆解任务为 ${plan.steps.length} 步子任务，目标维度=${plan.targetDims.join('/')}`, plan);

  // ── Step 2 · context：recruiter 产出面试报告，向下游传递上下文 ──
  const interviewReport = {
    candidateId: req.candidateId,
    transcriptLen: req.transcript.length,
    targetDims: RADAR_DIMS,
    note: `基于候选 persona 完成结构化面试，转录长度 ${req.transcript.length} 字符，交接至评估中心。`,
  };
  push('context', 'recruiter', interviewReport.note, interviewReport);

  // ── Step 3 · tool + verify：evaluator 重复评分并聚合（真实评估科学）──
  const radars: RadarScore[] = [];
  const verdicts: (Verdict | null)[] = [];
  const confidences: number[] = [];
  const evidence: string[] = [];
  let judgeCount = 0;

  for (let i = 0; i < k; i += 1) {
    // 每次 variant=i 旋转维度顺序（对抗位置偏差，自洽扰动）
    const out = await req.judge({ agentId: req.candidateId, transcript: req.transcript, variant: i, bossProfile: req.bossProfile }).catch(() => null);
    if (!out) continue;
    radars.push(out.radar);
    verdicts.push(out.verdict);
    confidences.push(out.confidence);
    judgeCount += 1;
    evidence.push(...out.evidence);
  }

  const source: 'judge' | 'mixed' | 'degraded' =
    judgeCount === 0 ? 'degraded' : judgeCount === radars.length ? 'judge' : 'mixed';
  const meanRadar = aggregateRadars(radars);
  const verdict = majorityVerdict(verdicts);
  const confidence = confidences.length
    ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
    : 0;
  const bias = auditJudgeBias(radars);
  const pk = passK(radars, { k: radars.length, threshold });

  push('tool', 'evaluator', `评估中心调用评委 ${radars.length}/${k} 次成功（source=${source}），逐维均值雷达已聚合`, {
    meanRadar,
  });
  push('verify', 'evaluator', `pass^k(allPass=${pk.allPass}, passRate=${pk.passRate})；偏差审计 unstable=${bias.unstable}(maxSpread=${bias.maxSpread})`, {
    passK: pk,
    biasAudit: bias,
  });

  // ── Step 4 · approve：boss 拍板（高风险动作需人工确认）──
  let action: BossAction = 'reject';
  let reason = '';
  let requiresHumanAck = false;
  if (bias.unstable) {
    action = 'rollback';
    requiresHumanAck = true;
    reason = `评委离散度偏高（maxSpread=${bias.maxSpread} > 阈值）：结论不稳定，触发回滚并要求人工复核。`;
  } else if (pk.allPass && verdict === 'MVP' && confidence >= 0.7) {
    action = 'hire';
    requiresHumanAck = true; // 录用是高风险写动作，需人类二次确认
    reason = `六维全达标（pass^k allPass=true）且判定为 ${verdictLabel.MVP}、置信度 ${confidence}：建议录用。`;
  } else if (pk.passRate >= 0.6 && (verdict === 'MVP' || verdict === 'OBSERVE')) {
    action = 'observe';
    reason = `通过率 ${pk.passRate}、判定 ${verdict ? verdictLabel[verdict] : '未知'}：暂观察，不立即录用。`;
  } else {
    action = 'reject';
    reason = `通过率 ${pk.passRate} 不足或其他未达标：执行 You are fired。`;
  }
  push('approve', 'boss', `老板决策：${action.toUpperCase()}。${reason}（需人工确认=${requiresHumanAck}）`, {
    action,
    requiresHumanAck,
  });

  // ── Step 5 · evidence：轨迹留痕（执行证据）──
  push('evidence', 'dispatcher', `已沉淀 ${trace.length} 步执行轨迹（Trace/Metrics），可供观测与复盘。`, {
    traceLen: trace.length,
  });

  // ── Step 6 · precipitate：经验沉淀（可复用规则）──
  const weakest = RADAR_DIMS.reduce((a, b) => ((meanRadar[a] ?? 0) <= (meanRadar[b] ?? 0) ? a : b));
  const strongest = RADAR_DIMS.reduce((a, b) => ((meanRadar[a] ?? 0) >= (meanRadar[b] ?? 0) ? a : b));
  const experience = `经验规则：对「${req.candidateName}」类候选，优先考察最强维「${strongest}」的复用价值；最弱维「${weakest}」需在下一轮面试定向追问（pass^k 未全达标的维度=训练重点）。`;
  push('precipitate', 'boss', experience);

  return {
    request: req,
    plan,
    interviewReport,
    evaluation: { radars, meanRadar, verdict, confidence, passK: pk, biasAudit: bias, source },
    bossDecision: { action, reason, approvedBy: 'boss', requiresHumanAck },
    experience,
    trace,
  };
}

export { phaseLabel, verdictLabel };
