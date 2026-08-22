"""
model-service/app/scoring/evaluators/sandbox_evaluator.py
沙箱执行器的 Evaluator 适配器。

把 sandbox/runner.run_python_answer 的产出（SandboxResult）包成统一的
EvaluatorOutput。沙箱本身不直接打分，只产出 verified_evidence——
它是 Q6 抬权（code_runnability / code_security）的唯一合法来源。

为何单独成文件：runner.py 是独立的安全执行模块，不应反向依赖 evaluator_protocol，
适配层在此桥接，保持 runner.py 职责单一。
"""
from __future__ import annotations

from ..evaluator_protocol import EvaluatorInput, EvaluatorOutput
from ...sandbox.runner import (
    run_python_answer,
    verified_evidence_for,
)


class SandboxEvaluator:
    """沙箱执行器：跑候选代码，产出机器可核验证据。"""

    evaluator_id = "sandbox"
    applicable_jobs = ["code"]
    # 沙箱不直接打分，只产 verified_evidence
    declared_dims: list = []

    def evaluate(self, inp: EvaluatorInput) -> EvaluatorOutput:
        result = run_python_answer(inp.answer or "", task_id=inp.task_id)
        evidence = verified_evidence_for(inp.task_id, result)
        return EvaluatorOutput(
            evaluator_id=self.evaluator_id,
            scores={},  # 沙箱不直接打分，证据交给 stage_scorer 消费
            verified_evidence=evidence,
            confidence=1.0 if result.outcome == "passed" else 0.0,
            reasoning=result.evidence_text(),
            metadata={
                "outcome": result.outcome,
                "total": result.total,
                "passed": result.passed,
                "failed": result.failed,
                "durationMs": round(result.duration_ms, 1),
                "peakMemMb": result.peak_mem_mb,
                "outputCapped": result.output_capped,
                "codeBytes": result.code_bytes,
            },
        )
