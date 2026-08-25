"""
model-service/app/scoring/evaluators/__init__.py
Tier 2 Evaluator 的注册引导。

新增 Evaluator 必须在此登记。CI 测试（test_registry.py）强制检查所有已知
Evaluator 都已注册、维度不越界、不重复注册。
"""
from __future__ import annotations

from ..judge_registry import JudgeRegistry


def register_all(registry: JudgeRegistry) -> None:
    """启动时注册所有 Tier 2 Evaluator。

    新增 Evaluator 必须在此 import + 注册，否则 CI 强制失败。
    """
    from .sandbox_evaluator import SandboxEvaluator
    from .growth_evaluator import GrowthEvaluator
    from .enterprise_fit_evaluator import EnterpriseFitEvaluator
    from ..craft_judge import CraftJudgeEvaluator
    from ..arena_judge import ArenaJudgeEvaluator
    from .gold_reference_evaluator import GoldReferenceEvaluator

    for ev in [
        SandboxEvaluator(),
        GrowthEvaluator(),
        EnterpriseFitEvaluator(),
        CraftJudgeEvaluator(),
        ArenaJudgeEvaluator(),
        GoldReferenceEvaluator(),
    ]:
        registry.register(ev)
