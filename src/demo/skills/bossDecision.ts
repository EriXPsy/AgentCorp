/**
 * boss_review Skill 的唯一真源决策逻辑（GOAI 复赛必选项 · Skill 运行时）。
 * --------------------------------------------------------------------------
 * 本文件是「老板审批/回滚」决策的**单一真源**：closedLoop.ts（approve 阶段）
 * 与 skills/handlers.ts（bossReviewSkill）都调用 reviewBossDecision，
 * 不在两处重复 if/else，保证复赛评审计分一致、可单测。
 *
 * 零业务依赖：只 import 类型，避免循环依赖（架构铁律）。
 */
import type { Verdict, BossProfile } from '@/types/evaluation';

/** boss 审批动作（与 closedLoop.BossAction 同源）。 */
export type BossAction = 'hire' | 'observe' | 'reject' | 'rollback';

/** boss_review Skill 入参（来自评估中心终评 + 老板原型）。 */
export interface BossReviewInput {
  evaluation: {
    passK: { allPass: boolean; passRate: number };
    biasAudit: { unstable: boolean; maxSpread: number };
    verdict: Verdict | null;
    confidence: number;
  };
  bossProfile?: BossProfile | null;
}

/** boss_review Skill 输出（决策 + 理由 + 是否需人工确认）。 */
export interface BossReviewOutput {
  action: BossAction;
  reason: string;
  requiresHumanAck: boolean;
}

/**
 * 老板评审与审批决策（唯一真源）。
 * 把闭环 approve 阶段的 if/else 逻辑集中于此，closedLoop 与 handler 共用。
 */
export function reviewBossDecision(input: BossReviewInput): BossReviewOutput {
  const bias = input.evaluation.biasAudit;
  const pk = input.evaluation.passK;
  const verdict = input.evaluation.verdict;
  const confidence = input.evaluation.confidence;

  let action: BossAction = 'reject';
  let reason = '';
  let requiresHumanAck = false;

  if (bias.unstable) {
    action = 'rollback';
    requiresHumanAck = true;
    reason = `评委离散度偏高（maxSpread=${bias.maxSpread} > 阈值）：结论不稳定，触发回滚并要求人工复核。`;
  } else if (pk.allPass && verdict === 'MVP' && confidence >= 0.7) {
    action = 'hire';
    requiresHumanAck = true;
    reason = `六维全达标（pass^k allPass=true）且判定为 MVP（可留用）、置信度 ${confidence}：建议录用。`;
  } else if (pk.passRate >= 0.6 && (verdict === 'MVP' || verdict === 'OBSERVE')) {
    action = 'observe';
    reason = `通过率 ${pk.passRate}、判定 ${verdict ? '可留用/待观察/已解雇' : '未知'}：暂观察，不立即录用。`;
  } else {
    action = 'reject';
    reason = `通过率 ${pk.passRate} 不足或其他未达标：执行 You are fired。`;
  }

  return { action, reason, requiresHumanAck };
}
