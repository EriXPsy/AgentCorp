"""
model-service/app/scoring/evaluators/enterprise_fit_evaluator.py
企业适配引擎的 Evaluator 适配器。

把 scoring/enterprise_fit.compute_enterprise_fit 的产出（EnterpriseFitResult）
包成统一的 EvaluatorOutput。回答「这个 agent 适不适合**我的**业务场景」——
匹配分 = 50% 量级达标率 + 30% 达标率 + 20% 方向余弦（已修正纯余弦的量级盲区）。
"""
from __future__ import annotations

from ..evaluator_protocol import EvaluatorInput, EvaluatorOutput
from .. import enterprise_fit as _efit
from ..registry import RADAR_DIMS, JOB_CRAFT_DIMS


# 企业适配可评的维度 = 通用六维 + 所有工种 craft 维的并集
_ALL_CRAFT_DIMS = sorted({d for dims in JOB_CRAFT_DIMS.values() for d in dims})


class EnterpriseFitEvaluator:
    """企业适配：按企业的维度权重偏好，算 agent 对某业务的匹配度。"""

    evaluator_id = "enterprise_fit"
    applicable_jobs = ["code", "text", "image"]
    # 产出维度 = 通用六维 + 全部 craft 维的并集（注册时校验 ⊆ registry 允许集）
    declared_dims = list(RADAR_DIMS) + _ALL_CRAFT_DIMS

    def evaluate(self, inp: EvaluatorInput) -> EvaluatorOutput:
        opts = inp.options or {}
        result = _efit.compute_enterprise_fit(
            agent_id=inp.agent_id,
            job_type=inp.job_type,
            radar_scores=inp.radar_scores or {},
            craft_scores=inp.craft_scores or {},
            enterprise_weights=opts.get("enterprise_weights"),
            radar_requirements=opts.get("radar_requirements"),
            craft_requirements=opts.get("craft_requirements"),
        )
        # scores 用逐维 actual，供 craft 雷达对比；metadata 装完整报告
        scores = {d: fit.actual for d, fit in result.dimension_fits.items()}
        return EvaluatorOutput(
            evaluator_id=self.evaluator_id,
            scores=scores,
            confidence=result.overall_fit / 100.0,
            reasoning=(
                f"就绪度={result.readiness}，综合匹配={result.overall_fit}，"
                f"radar_fit={result.radar_fit}，craft_fit={result.craft_fit}"
            ),
            metadata={
                "overallFit": result.overall_fit,
                "readiness": result.readiness,
                "radarFit": result.radar_fit,
                "craftFit": result.craft_fit,
                "strengths": result.strengths,
                "recommendations": [r.__dict__ for r in result.recommendations],
                "dimensionFits": {
                    d: {"actual": f.actual, "required": f.required,
                        "gap": f.gap, "status": f.status}
                    for d, f in result.dimension_fits.items()
                },
            },
        )
