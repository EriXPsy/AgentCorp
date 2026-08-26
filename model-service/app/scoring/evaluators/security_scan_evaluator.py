"""
model-service/app/scoring/evaluators/security_scan_evaluator.py
AST 静态安全扫描的 Evaluator 适配器。

把 sandbox/security_scan.scan_python_answer 的产出（SecurityScanResult）
包成统一的 EvaluatorOutput，注册进 JudgeRegistry。

为何单独成文件：security_scan.py 是独立的安全扫描模块，不应反向依赖
evaluator_protocol。适配层在此桥接，保持 security_scan.py 职责单一。

与 SandboxEvaluator 的关系：
- SandboxEvaluator 跑代码 → 产 code_runnability 证据
- SecurityScanEvaluator 扫代码 → 产 code_security 证据
两条独立证据链，互不代偿（功能正确 ≠ 安全）。

降级契约：scan_python_answer 依赖 sandbox_enabled 开关。开关关闭时
返回 outcome=disabled 的 SecurityScanResult，此时 health() 报 degraded，
evaluate() 返回空 evidence + degraded=True。
"""
from __future__ import annotations

from ..evaluator_protocol import EvaluatorHealth, EvaluatorInput, EvaluatorOutput
from ...config import settings
from ...sandbox.security_scan import (
    SecurityScanResult,
    scan_python_answer,
    security_evidence_for,
)


class SecurityScanEvaluator:
    """AST 静态安全扫描：找危险构造，产出 code_security 机器证据。"""

    evaluator_id = "security_scan"
    applicable_jobs = ["code"]
    declared_dims: list = ["code_security"]

    def evaluate(self, inp: EvaluatorInput) -> EvaluatorOutput:
        result = scan_python_answer(inp.answer or "")
        evidence = security_evidence_for(inp.task_id or "adhoc", result)

        # 基础 metadata（无论是否 verifiable 都透出，与 to_dict() 对齐）
        base_meta = {
            "outcome": result.outcome,
            "scanner": result.scanner,
            "rulesChecked": result.rules_checked,
            "high": result.high,
            "medium": result.medium,
            "findings": [
                {"rule": f.rule, "severity": f.severity, "line": f.line, "message": f.message}
                for f in result.findings
            ],
            "reason": result.reason,
            "verifiable": result.verifiable,
            "evidence": result.evidence_text(),
        }

        if not result.verifiable:
            return EvaluatorOutput(
                evaluator_id=self.evaluator_id,
                scores={},
                verified_evidence={},
                confidence=0.0,
                reasoning=result.reason or "扫描未执行（无代码 / 语法错误 / 沙盒未启用）",
                degraded=True,
                degraded_reason=f"安全扫描未产出有效证据：{result.outcome}",
                metadata=base_meta,
            )

        # confidence：高危越多 → 越低（证据越强 → 对低分候选越有信心）
        conf = 1.0
        if result.high > 0:
            conf = max(0.5, 1.0 - result.high * 0.1)

        return EvaluatorOutput(
            evaluator_id=self.evaluator_id,
            scores={},
            verified_evidence=evidence,
            confidence=conf,
            reasoning=result.evidence_text(),
            metadata=base_meta,
        )

    def health(self) -> EvaluatorHealth:
        if not getattr(settings, "sandbox_enabled", False):
            return EvaluatorHealth(
                evaluator_id=self.evaluator_id,
                status="degraded",
                reason="沙盒未启用（SANDBOX_ENABLED=true），安全扫描不可用",
            )
        return EvaluatorHealth(evaluator_id=self.evaluator_id, status="healthy")
