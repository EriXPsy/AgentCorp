"""
model-service/app/scoring/evaluators/gold_reference_evaluator.py
GoldReference：面试 code 题的「金标准正确性」客观评分器。

定位：把「候选代码对金标准夹具的通过率」转成 craft 维（code_test_coverage）的
0–5 客观分，与 LLM-as-judge 的主观分形成「客观校准 + 主观补充」的双轨。

为什么需要它：
- 既有 SandboxEvaluator 只产 verified_evidence（且仅全绿抬 code_runnability 降权），
  不赋分；CraftJudgeEvaluator 用 LLM 主观给 code_test_coverage；
  二者都没有「按金标准正确性客观打分」这一环 —— 这正是本模块的职责。
- 金标准（gold）来自 sandbox 的确定性夹具题（craft_tasks_sandbox 的
  _SANDBOX_SPECS）：人工核验、纯输入→输出断言、可复现。对这类题目，
  候选代码的「正确性」应由机器断言给出，而非模型复述。

计分口径：
- 仅对 machine_verifiable 的题目（is_machine_verifiable）产出 code_test_coverage；
  其余题型无金标准，按「未覆盖维度不打分」原则返回空分，绝不外推。
- pass_rate = passed / total（total>0）；score = clamp(pass_rate × 5)，对齐 0–5 0.5 步进。
- 沙箱未启用（outcome=disabled）或夹具无法执行（no_code/no_tests/error 等
  total==0）→ 不客观断言，返回空分 + 低置信，由 LLM 分兜底。
- passed/failed（total>0）→ 客观分 + confidence=1.0 + verified_evidence。

学术依据：
- SWE-bench（arXiv:2310.06770）：以固定测试夹具做 pass/fail 判定，验证的是
  「既有测试能否通过」，而非候选自写测试 —— 本模块消费的就是这种 curated 夹具。
- 与对照基准校准（Tu et al., 2026，arXiv:2604.24955）方向一致：用 gold reference
  抑制「自证合格」失真，让客观正确性结论可被机器复核。
"""
from __future__ import annotations

from ..evaluator_protocol import EvaluatorInput, EvaluatorOutput
from ...sandbox import run_python_answer
from ...sandbox.craft_tasks_sandbox import is_machine_verifiable


def _clamp_half_step(value: float) -> float:
    """夹到 [0,5] 并对齐 0.5 步进（与主观打分同口径）。"""
    clamped = max(0.0, min(5.0, float(value)))
    return round(clamped * 2) / 2


class GoldReferenceEvaluator:
    """金标准正确性评分器：把 gold 夹具通过率转成 code_test_coverage 客观分。

    只评单题（task_id + answer）。多题聚合由调用方循环后 aggregate。
    """

    evaluator_id = "gold_reference"
    applicable_jobs = ["code"]
    # 仅声明本模块实际产出的维度，且 ⊆ registry 允许集（code 工种的 code_test_coverage）
    declared_dims = ["code_test_coverage"]

    def evaluate(self, inp: EvaluatorInput) -> EvaluatorOutput:
        task_id = inp.task_id
        # 无 task_id 或无金标准夹具 → 不参与打分（原则：未覆盖维度不打分）
        if not task_id or not is_machine_verifiable(task_id):
            return EvaluatorOutput(
                evaluator_id=self.evaluator_id,
                scores={},
                confidence=0.0,
                reasoning="该题无金标准夹具，gold 校准不适用",
            )

        # 真实执行候选代码（复用 sandbox runner，确定性、可复现）
        result = run_python_answer(inp.answer or "", task_id=task_id)
        total = result.total
        passed = result.passed

        # 沙箱未启用 → 不客观断言，由 LLM 分兜底
        if result.outcome == "disabled":
            return EvaluatorOutput(
                evaluator_id=self.evaluator_id,
                scores={},
                confidence=0.0,
                reasoning="沙箱未启用（SANDBOX_ENABLED=false），gold 校准跳过客观打分",
                metadata={"outcome": result.outcome, "total": total, "passed": passed},
            )
        # 夹具无法执行（无候选代码 / 无用例 / 导入错误等 total==0）→ 不客观断言
        if total <= 0:
            return EvaluatorOutput(
                evaluator_id=self.evaluator_id,
                scores={},
                confidence=0.0,
                reasoning=(
                    f"金标准夹具无法执行（outcome={result.outcome}），"
                    f"不客观断言 code_test_coverage"
                ),
                metadata={"outcome": result.outcome, "total": total, "passed": passed},
            )

        # 金标准通过率 → 0–5 客观分
        pass_rate = passed / total if total > 0 else 0.0
        score = _clamp_half_step(pass_rate * 5.0)

        return EvaluatorOutput(
            evaluator_id=self.evaluator_id,
            scores={"code_test_coverage": score},
            verified_evidence={
                "code_test_coverage": (
                    f"[{task_id}] 金标准通过率 {passed}/{total}（{score:.1f}/5）"
                )
            },
            confidence=1.0 if result.verifiable else 0.0,
            reasoning=(
                f"金标准校验：{passed}/{total} 用例通过，"
                f"code_test_coverage={score:.1f}/5"
                + ("" if result.verifiable else "（执行未产出确定结论，置信度降为 0）")
            ),
            metadata={
                "outcome": result.outcome,
                "total": total,
                "passed": passed,
                "failed": result.failed,
                "passRate": round(pass_rate, 3),
                "score": score,
                "durationMs": round(result.duration_ms, 1),
            },
        )
