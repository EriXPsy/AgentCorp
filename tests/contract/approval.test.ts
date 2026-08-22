/**
 * tests/contract/approval.test.ts
 * M3b 主干契约 · 高风险门不可绕过（运行时）
 * --------------------------------------------------------------------------
 * 守住「高风险动作（录用 / 解雇 / 回滚）必须经 approvalGate，不得 bypass」：
 *   - 高风险（requiresApproval=true）提交后动作**不执行**，闭环挂起。
 *   - 低风险自动放行并登记审计（仍可追溯）。
 * 直接调用 governed.apply() 而绕开 submitForApproval 即为「旁路」——
 * 主干要求所有高风险写操作都从此门进入，本测试断言门确实拦得住。
 */
import { describe, it, expect } from "vitest";
import {
  submitForApproval,
  resetApprovals,
  type GovernedAction,
} from "../../src/engine/governance/approvalGate";

describe("M3b 主干契约 · 高风险门不可绕过", () => {
  it("高风险动作（requiresApproval=true）未经审批绝不执行", async () => {
    resetApprovals();
    let executed = false;
    const governed: GovernedAction = {
      apply: async () => {
        executed = true;
        return "done";
      },
    };
    const out = await submitForApproval({
      runId: "run-contract-test",
      requestedBy: "boss",
      action: "hire",
      targetId: "agent-x",
      summary: "契约自检：高风险录用须经审批",
      riskLevel: "high",
      requiresApproval: true,
      governed,
    });
    expect(out.gated).toBe(true);
    expect(out.executed).toBe(false);
    expect(executed).toBe(false); // 关键断言：门拦住了，动作未生效
  });

  it("低风险动作自动放行并登记审计", async () => {
    resetApprovals();
    let executed = false;
    const governed: GovernedAction = {
      apply: async () => {
        executed = true;
        return "done";
      },
    };
    const out = await submitForApproval({
      runId: "run-contract-test-low",
      requestedBy: "recruiter",
      action: "observe",
      targetId: "agent-y",
      summary: "契约自检：低风险观察",
      riskLevel: "low",
      requiresApproval: false,
      governed,
    });
    expect(out.gated).toBe(false);
    expect(out.executed).toBe(true);
    expect(executed).toBe(true);
  });
});
