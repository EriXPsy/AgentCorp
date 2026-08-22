"""
model-service/app/scoring/evaluator_protocol.py
Tier 2（主观评判层）评分模块的统一契约。

为什么需要它：此前 growth / enterpriseFit / arena_judge / craft_judge / sandbox
各自 import、各自被直接调用，未注册进任何统一契约——每加一个评分引擎就多一条
独立调用链，维度/权重/派发路径随之发散（「测量概念蔓延」）。本契约把所有主观评分
模块收口到同一份入参/出参/接口，让它们可被 JudgeRegistry 统一注册、校验、派发。

设计约束：
- 客观层（metricsEngine / roiEngine / convergence 等）不走这份契约，保持纯函数原样；
- 所有 Evaluator 产出的维度必须是 registry 允许维度的子集（CI 强制，见 test_registry）；
- 纯数据结构，无副作用、无外部依赖（只用 stdlib dataclass）。

学术依据：
- SWE-bench（arXiv:2310.06770）：评测应由「可复现的固定协议」驱动，而非各模块各自约定；
- HELM（Liang et al. 2022）：标准化多维度评测需要统一场景与统一度量口径。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Protocol, runtime_checkable


@dataclass
class EvaluatorInput:
    """所有 Evaluator 的统一入参（字段按需取用，不必全填）。"""

    agent_id: str
    job_type: str = "code"
    task_id: Optional[str] = None
    answer: Optional[str] = None            # 候选答案文本
    radar_scores: Optional[Dict[str, float]] = None
    craft_scores: Optional[Dict[str, float]] = None
    requirement: Optional[str] = None       # arena 需求文本
    verified_evidence: Optional[Dict[str, str]] = None
    options: Optional[Dict[str, Any]] = None


@dataclass
class EvaluatorOutput:
    """所有 Evaluator 的统一产出。"""

    evaluator_id: str                        # 注册名（如 "craft_judge"）
    scores: Dict[str, float] = field(default_factory=dict)        # {dim: 0–5}
    verified_evidence: Dict[str, str] = field(default_factory=dict)  # 机器可核验证据
    craft_evidence: Dict[str, str] = field(default_factory=dict)     # 裁判引文
    confidence: float = 0.0
    reasoning: str = ""                      # 思维链（供审计）
    metadata: Dict[str, Any] = field(default_factory=dict)        # 扩展字段
    #: 降级标记：Evaluator 无法产出真实分数（如 judge 后端不可用）但仍返回部分证据时为 True。
    #: 消费者据此展示「机器验证通过 / LLM 评分不可用」而非当作完整评测。
    degraded: bool = False
    degraded_reason: str = ""


@dataclass
class EvaluatorHealth:
    """单个 Evaluator 的健康状态（供注册表聚合 + /api/registry/status 展示）。"""

    evaluator_id: str
    #: healthy=可正常评分；degraded=能跑但能力受限；unavailable=依赖故障无法评分
    status: Literal["healthy", "degraded", "unavailable"] = "healthy"
    reason: str = ""


@runtime_checkable
class Evaluator(Protocol):
    """Tier 2 评分模块的统一契约。

    实现者须提供：
      evaluator_id:      全局唯一注册名
      applicable_jobs:   适用的工种列表（如 ["code"]）
      evaluate(inp):     把 EvaluatorInput 转为 EvaluatorOutput
    可选：
      health():          自报健康状态（默认 healthy）
    """

    evaluator_id: str
    applicable_jobs: List[str]

    def evaluate(self, inp: EvaluatorInput) -> EvaluatorOutput: ...


def allowed_dims_for(job_type: str) -> set:
    """某工种下 registry 允许的全部维度（通用六维 + 本工种 craft 维）。

    供 registry 注册时校验 Evaluator 产出维度不越界。
    """
    from .registry import JOB_CRAFT_DIMS, RADAR_DIMS

    dims = set(RADAR_DIMS)
    dims.update(JOB_CRAFT_DIMS.get(job_type, []))
    return dims


def merge_outputs(outputs: List[EvaluatorOutput]) -> EvaluatorOutput:
    """合并多个 EvaluatorOutput 为一个（供 dispatch_chain 使用）。

    合并规则：
    - scores / verified_evidence / craft_evidence：后写覆盖前写（同键后者优先）；
    - confidence：取最小值（链的置信度取决于最弱一环）；
    - reasoning：用换行拼接各 evaluator 的推理；
    - metadata：后者覆盖前者（同键）。
    """
    if not outputs:
        return EvaluatorOutput(evaluator_id="empty_chain")
    if len(outputs) == 1:
        return outputs[0]

    merged = EvaluatorOutput(
        evaluator_id="+".join(o.evaluator_id for o in outputs),
        scores={},
        verified_evidence={},
        craft_evidence={},
        confidence=min(o.confidence for o in outputs),
        reasoning="\n---\n".join(
            f"[{o.evaluator_id}] {o.reasoning}" for o in outputs if o.reasoning
        ),
        metadata={},
    )
    for o in outputs:
        merged.scores.update(o.scores)
        merged.verified_evidence.update(o.verified_evidence)
        merged.craft_evidence.update(o.craft_evidence)
        merged.metadata.update(o.metadata)
    return merged
