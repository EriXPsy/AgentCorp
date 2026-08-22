"""
model-service/app/scoring/evaluators/growth_evaluator.py
成长历程引擎的 Evaluator 适配器。

把 scoring/growth.compute_growth_trajectory 的产出（GrowthTrajectory）
包成统一的 EvaluatorOutput。成长引擎不跑 LLM，而是从历次雷达分/阶段评分卡里
用线性回归算出成长速度、阶段、里程碑、短板、成长分——是「纵向评估」的纯函数。
"""
from __future__ import annotations

from ..evaluator_protocol import EvaluatorInput, EvaluatorOutput
from .. import growth as _growth
from ..registry import RADAR_DIMS

# 成长引擎考量的六维（与 registry.RADAR_DIMS 一致，不自定维度）。
_DIMS = ["task", "quality", "comm", "creativity", "reliability", "cost"]


class GrowthEvaluator:
    """成长历程：纵向追踪 agent 各维度成长速度/阶段/里程碑/短板。"""

    evaluator_id = "growth"
    applicable_jobs = ["code", "text", "image"]
    # 产出维度 = 通用六维（纵向追踪）。
    # overall 成长分是汇总指标、非 registry 维度，放在 scores["overall"] 供画像但不参与维度校验。
    declared_dims = list(RADAR_DIMS)

    def evaluate(self, inp: EvaluatorInput) -> EvaluatorOutput:
        opts = inp.options or {}
        traj = _growth.compute_growth_trajectory(
            agent_id=inp.agent_id,
            radar_history=inp.radar_scores and [inp.radar_scores] or opts.get("radar_history", []),
            stage_scores=opts.get("stage_scores", []),
            job_type=inp.job_type,
            gap_threshold=opts.get("gap_threshold", 3.0),
        )
        # 把成长分折成 scores：overall + 逐维 velocity（仅作画像信号，不参与 Q6）
        scores = {d: traj.trends.get(d).current for d in _DIMS if d in traj.trends}
        scores["overall"] = traj.growth_score
        return EvaluatorOutput(
            evaluator_id=self.evaluator_id,
            scores=scores,
            confidence=1.0,  # 纯函数、确定性强
            reasoning=f"成长阶段={traj.growth_phase}，综合成长分={traj.growth_score}",
            metadata={
                "overallVelocity": traj.overall_velocity,
                "growthPhase": traj.growth_phase,
                "growthScore": traj.growth_score,
                "milestones": [m.__dict__ for m in traj.milestones],
                "skillGaps": [g.__dict__ for g in traj.skill_gaps],
                "totalEvaluations": traj.total_evaluations,
            },
        )
