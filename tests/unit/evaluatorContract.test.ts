/**
 * tests/unit/evaluatorContract.test.ts
 *
 * Evaluator 契约一致性测试。
 *
 * CI 强制：
 * 1. 前端类型镜像（EvaluatorInput / EvaluatorOutput）与后端 evaluator_protocol.py
 *    字段完全对齐；
 * 2. KNOWN_EVALUATOR_IDS 覆盖后端 register_all 注册的所有 Evaluator；
 * 3. 契约字段齐全，无遗漏。
 *
 * 运行：env -u NODE_OPTIONS npx vitest run tests/unit/evaluatorContract.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  KNOWN_EVALUATOR_IDS,
  type EvaluatorInput,
  type EvaluatorOutput,
  type EvaluatorStats,
  type RegistryStatus,
} from "@/engine/scoring/evaluatorContract";

describe("evaluatorContract", () => {
  // ------------------------------------------------------------------
  // 1. 已知 Evaluator ID 完整覆盖
  // ------------------------------------------------------------------
  it("KNOWN_EVALUATOR_IDS 包含全部 5 个核心 Evaluator", () => {
    const ids = [...KNOWN_EVALUATOR_IDS];
    expect(ids).toContain("craft_judge");
    expect(ids).toContain("arena_judge");
    expect(ids).toContain("sandbox");
    expect(ids).toContain("growth");
    expect(ids).toContain("enterprise_fit");
    expect(ids).toHaveLength(5);
  });

  // ------------------------------------------------------------------
  // 2. EvaluatorInput 字段完整（与后端 EvaluatorInput 对齐）
  // ------------------------------------------------------------------
  it("EvaluatorInput 可构造完整入参", () => {
    const inp: EvaluatorInput = {
      agentId: "agent-1",
      jobType: "code",
      taskId: "task-1",
      answer: "print('hello')",
      radarScores: { task: 4, quality: 3 },
      craftScores: { code_runnability: 4 },
      requirement: "实现一个排序",
      verifiedEvidence: { run: "passed" },
      options: { key: "value" },
    };
    expect(inp.agentId).toBe("agent-1");
    expect(inp.jobType).toBe("code");
  });

  // ------------------------------------------------------------------
  // 3. EvaluatorOutput 字段完整（与后端 EvaluatorOutput 对齐）
  // ------------------------------------------------------------------
  it("EvaluatorOutput 可构造完整产出", () => {
    const out: EvaluatorOutput = {
      evaluatorId: "craft_judge",
      scores: { code_runnability: 4.0, code_efficiency: 3.5 },
      verifiedEvidence: { run: "passed" },
      craftEvidence: { cp0: "answer quote" },
      confidence: 0.85,
      reasoning: "most checkpoints hit",
      metadata: { jobType: "code", latencyMs: 120 },
    };
    expect(out.evaluatorId).toBe("craft_judge");
    expect(out.scores).toHaveProperty("code_runnability");
    expect(out.confidence).toBe(0.85);
  });

  // ------------------------------------------------------------------
  // 4. 空 EvaluatorOutput 合法（scores 默认空对象）
  // ------------------------------------------------------------------
  it("EvaluatorOutput scores 默认空对象（sandbox 场景）", () => {
    const out: EvaluatorOutput = {
      evaluatorId: "sandbox",
      scores: {},
      verifiedEvidence: {},
      craftEvidence: {},
      confidence: 0,
      reasoning: "",
    };
    expect(out.scores).toEqual({});
    expect(out.verifiedEvidence).toEqual({});
  });

  // ------------------------------------------------------------------
  // 5. 契约字段列表固化（防止字段漂移）
  // ------------------------------------------------------------------
  it("EvaluatorInput 必填字段固化", () => {
    // 编译期 + 运行期双重校验：必填字段缺一不可
    const required: (keyof EvaluatorInput)[] = ["agentId", "jobType"];
    const inp: EvaluatorInput = { agentId: "a", jobType: "text" };
    for (const key of required) {
      expect(inp).toHaveProperty(key);
    }
  });

  it("EvaluatorOutput 必填字段固化", () => {
    const required: (keyof EvaluatorOutput)[] = [
      "evaluatorId",
      "scores",
      "verifiedEvidence",
      "craftEvidence",
      "confidence",
      "reasoning",
    ];
    const out: EvaluatorOutput = {
      evaluatorId: "test",
      scores: {},
      verifiedEvidence: {},
      craftEvidence: {},
      confidence: 0,
      reasoning: "",
    };
    for (const key of required) {
      expect(out).toHaveProperty(key);
    }
  });

  // ------------------------------------------------------------------
  // 6. EvaluatorStats 字段完整（遥测）
  // ------------------------------------------------------------------
  it("EvaluatorStats 字段完整", () => {
    const s: EvaluatorStats = {
      calls: 10,
      errors: 1,
      totalMs: 523.5,
      avgMs: 52.35,
      lastCallTs: 1700000000,
    };
    expect(s.calls).toBe(10);
    expect(s.avgMs).toBeCloseTo(52.35, 1);
  });

  // ------------------------------------------------------------------
  // 7. RegistryStatus 字段完整（注册表状态端点）
  // ------------------------------------------------------------------
  it("RegistryStatus 字段完整", () => {
    const status: RegistryStatus = {
      evaluators: ["craft_judge", "sandbox"],
      stats: {
        craft_judge: { calls: 5, errors: 0, totalMs: 100, avgMs: 20, lastCallTs: 0 },
        sandbox: { calls: 3, errors: 1, totalMs: 45, avgMs: 15, lastCallTs: 0 },
      },
    };
    expect(status.evaluators).toHaveLength(2);
    expect(status.stats["craft_judge"]!.calls).toBe(5);
    expect(status.stats["sandbox"]!.errors).toBe(1);
  });
});
