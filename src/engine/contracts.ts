/**
 * src/engine/contracts.ts
 * 主干契约违例（M2/M3 共享）
 * --------------------------------------------------------------------------
 * 任何绕过主干的行为——单入口（host-api）、留痕（traceEmitter）、高风险门
 * （approvalGate）、插件注册（RoleCard / Evaluator / ModelAdapter）、单一规则源
 * （scoring/registry）——都应抛 ContractViolation。M3-CI 的静态与运行时契约测试
 * 会捕获这类违例，使「局部最优改动」在 PR 阶段就红。
 *
 * 放在独立单文件，避免 judgeRegistry 与 modelAdapter 互相 import 造成循环依赖，
 * 也与本项目「单一规则源 / 单一契约」的治理主题一致。
 */
export class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractViolation";
  }
}
