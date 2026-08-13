/**
 * Skill 运行时类型与注册表（GOAI 复赛必选项 · 2.1 全字段）。
 * --------------------------------------------------------------------------
 * 把 roleCard.ts 的 RoleCardSkill[]「数据」投影为可被真正调用的 SkillDefinition：
 *   - 直接拷贝 2.1 全字段（id/name/purpose/inputs/outputs/invokeCondition/
 *     dependsOn/failureHandling/securityBoundary/reuseValue/collaboration）
 *   - 绑定运行时 handler（来自 handlers.ts），使 Demo 能真实「调 Skill」。
 * 模块加载时即遍历 ROLE_CARDS 完成注册，无需手动 init。
 */
import { ROLE_CARDS } from '@/engine/agents/roleCard';
import {
  agentInterviewSkill,
  capabilityAssessmentSkill,
  reliabilityAuditSkill,
  bossReviewSkill,
  orchestrateSkill,
} from './handlers';
// SkillHandler 供本模块（SkillDefinition / HANDLERS / placeholder）使用；
// SkillResult / SkillHandler 由 handlers.ts 定义，这里 re-export 供调用方（如 adapter）消费
import type { SkillHandler } from './handlers';
export type { SkillResult, SkillHandler } from './handlers';

/** 可被调用的 Skill 定义：2.1 全字段 + 运行时 handler。 */
export interface SkillDefinition {
  id: string;
  name: string;
  purpose: string;
  inputs: string;
  outputs: string;
  invokeCondition: string;
  dependsOn: string[];
  failureHandling: string;
  securityBoundary: string;
  reuseValue: string;
  collaboration: string;
  handler: SkillHandler;
}

/** Skill 注册表（运行时单例 Map）。 */
const registry = new Map<string, SkillDefinition>();

/** 注册一个 Skill 定义。 */
export function registerSkill(def: SkillDefinition): void {
  registry.set(def.id, def);
}

/** 按 id 取 Skill 定义。 */
export function getSkill(id: string): SkillDefinition | undefined {
  return registry.get(id);
}

/** 列出所有已注册 Skill。 */
export function listSkills(): SkillDefinition[] {
  return Array.from(registry.values());
}

/** id → handler 绑定表（roleCard 的 Skill id 必须在此有对应实现）。 */
const HANDLERS: Record<string, SkillHandler> = {
  agent_interview: agentInterviewSkill,
  capability_assessment: capabilityAssessmentSkill,
  reliability_audit: reliabilityAuditSkill,
  boss_review: bossReviewSkill,
  orchestrate: orchestrateSkill,
};

/** 占位 handler：未绑定实现的 Skill 调用即降级返回，避免 handler 为 undefined。 */
const placeholderHandler: SkillHandler = async () =>
  ({ ok: false, degraded: true, reason: '该 Skill 暂无运行时 handler 实现。' });

/**
 * 模块加载时遍历所有角色卡的 Skill，投影成 SkillDefinition 并注册。
 * 重复 id 后者覆盖前者（Map 语义）；当前 4 张角色卡共 5 个唯一 Skill id。
 */
for (const card of ROLE_CARDS) {
  for (const sk of card.skills) {
    const def: SkillDefinition = {
      id: sk.id,
      name: sk.name,
      purpose: sk.purpose,
      inputs: sk.inputs,
      outputs: sk.outputs,
      invokeCondition: sk.invokeCondition,
      dependsOn: sk.dependsOn,
      failureHandling: sk.failureHandling,
      securityBoundary: sk.securityBoundary,
      reuseValue: sk.reuseValue,
      collaboration: sk.collaboration,
      handler: HANDLERS[sk.id] ?? placeholderHandler,
    };
    registerSkill(def);
  }
}
