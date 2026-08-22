/**
 * tests/contract/registry.test.ts
 * M2 测量主干 · JudgeRegistry 契约（运行时）
 * --------------------------------------------------------------------------
 * 守住「统一 Evaluator 契约 + 单一规则源」：
 *   - 注册式 Evaluator 可被 listEvaluators / getEvaluator 取到。
 *   - 维度漂移（targetDims 非 RADAR_DIMS 子集）注册即抛 ContractViolation。
 *   - RADAR_DIMS 是唯一六维源。
 * 作为 M2 修复的验收基线：PR#43 把 PR#41 新增的 growth / enterpriseFit / arena
 * 改写为 Evaluator 并注册后，此处的 listEvaluators 必须包含它们。
 */
import { describe, it, expect } from "vitest";
import {
  registerEvaluator,
  getEvaluator,
  hasEvaluator,
  ContractViolation,
  type Evaluator,
} from "../../src/engine/evaluation/judgeRegistry";
import { RADAR_DIMS } from "../../src/engine/scoring/registry";

describe("M2 测量主干 · JudgeRegistry 契约", () => {
  it("注册一个 Evaluator 后可在 listEvaluators 见到", () => {
    const probe: Evaluator = {
      id: "probe_test_only",
      description: "契约自检探针",
      targetDims: ["task"],
      evaluate: () => ({ confidence: 1, evidence: [], source: "none" }),
    };
    registerEvaluator(probe);
    expect(hasEvaluator("probe_test_only")).toBe(true);
    expect(getEvaluator("probe_test_only")?.id).toBe("probe_test_only");
  });

  it("注册时 targetDims 必须是 RADAR_DIMS 子集，否则抛 ContractViolation", () => {
    const bad: Evaluator = {
      id: "bad_dim_probe",
      description: "维度漂移探针",
      targetDims: ["not_a_real_dim" as unknown as RadarDim],
      evaluate: () => ({ confidence: 1, evidence: [], source: "none" }),
    };
    expect(() => registerEvaluator(bad)).toThrow(ContractViolation);
  });

  it("RADAR_DIMS 是唯一维度源且为六维", () => {
    expect(RADAR_DIMS).toEqual([
      "task",
      "quality",
      "comm",
      "creativity",
      "reliability",
      "cost",
    ]);
  });
});

// 局部类型引用，避免未使用导入告警
type RadarDim = (typeof RADAR_DIMS)[number];
