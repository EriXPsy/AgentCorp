"""
model-service/app/scoring/enterprise_fit.py
企业适配引擎。

为什么需要它：不同企业对同一工种的 agent 有不同侧重。一个做电商文案的团队需要
txt_factuality 和 txt_tone_fit 顶尖，而一个做技术文档的团队更看重 txt_coherence 和
txt_instruction_follow。单看 craft 维的绝对分数无法判断「这个 agent 适不适合**我的**
业务场景」。

本模块回答三个问题：
1. 这个 agent 在某个工种上的整体匹配度是多少？    → 综合匹配分（0–100）
2. 哪些维度达标、哪些不达标？                     → 逐维对比（actual vs required）
3. 企业应该重点培养他哪些能力？                    → 培训建议（按优先级排序）

设计约束：
- 纯函数、无副作用、无外部依赖；
- 复用 registry.JOB_CRAFT_DIMS，不新增维度体系；
- 企业的需求以「维度权重偏好」表达（而非硬阈值），更灵活。

论文依据：
- Persona-based Evaluation（Wang et al. 2025）：不同用户的偏好改变了「好」的定义；
- Competency Model（McClelland 1973 → 现代 AI agent 能力模型 2024）：
  能力 = 维度向量，适配度 = 需求向量 · 能力向量的余弦相似度。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .registry import JOB_CRAFT_DIMS, RADAR_DIMS


# ----------------------------------------------------------------------
# 数据结构
# ----------------------------------------------------------------------
@dataclass(frozen=True)
class DimensionFit:
    """单个维度的适配分析。"""
    dim: str
    actual: float                # agent 实际得分
    required: float              # 企业要求分数
    gap: float                   # required - actual（正 = 需要提升）
    status: str                  # "exceeds" / "meets" / "below" / "critical"


@dataclass(frozen=True)
class TrainingRecommendation:
    """培训建议。"""
    dim: str
    priority: int                # 1 = 最优先
    current_score: float
    target_score: float
    reason: str
    suggested_action: str        # 具体建议


@dataclass(frozen=True)
class EnterpriseFitResult:
    """企业适配综合报告。"""
    agent_id: str
    job_type: str
    overall_fit: float                                    # 0–100
    readiness: str                                        # "ready" / "developing" / "not_ready"
    dimension_fits: Dict[str, DimensionFit]               # 逐维适配
    strengths: List[str]                                  # 超出预期的维度
    recommendations: List[TrainingRecommendation]        # 培训建议
    radar_fit: float                                      # 通用六维匹配分（0–100）
    craft_fit: float                                      # craft 维匹配分（0–100）


# ----------------------------------------------------------------------
# 纯函数：余弦相似度
# ----------------------------------------------------------------------
def _cosine_similarity(a: Dict[str, float], b: Dict[str, float]) -> float:
    """计算两个权重向量的余弦相似度（0–1）。

    用于衡量「企业需求方向」与「agent 能力方向」的吻合程度。
    """
    keys = set(a.keys()) & set(b.keys())
    if not keys:
        return 0.0
    dot = sum(a[k] * b[k] for k in keys)
    norm_a = math.sqrt(sum(v * v for v in a.values()))
    norm_b = math.sqrt(sum(v * v for v in b.values()))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return max(0.0, min(1.0, dot / (norm_a * norm_b)))


# ----------------------------------------------------------------------
# 纯函数：逐维状态判定
# ----------------------------------------------------------------------
def _dim_status(actual: float, required: float) -> str:
    """判定单个维度的达标状态。"""
    diff = actual - required
    if diff >= 0.5:
        return "exceeds"    # 远超预期
    elif diff >= 0:
        return "meets"      # 达标
    elif diff >= -1.0:
        return "below"      # 略低
    return "critical"       # 严重不足


# ----------------------------------------------------------------------
# 纯函数：就绪度判定
# ----------------------------------------------------------------------
def _classify_readiness(overall_fit: float, critical_count: int) -> str:
    """根据综合匹配分和严重不足维度数判定就绪度。

    - ready:      fit ≥ 75 且无 critical 维度
    - developing: fit ≥ 50 或 critical ≤ 1
    - not_ready:  其余
    """
    if overall_fit >= 75 and critical_count == 0:
        return "ready"
    elif overall_fit >= 50 or critical_count <= 1:
        return "developing"
    return "not_ready"


# ----------------------------------------------------------------------
# 主入口：企业适配分析
# ----------------------------------------------------------------------
def compute_enterprise_fit(
    agent_id: str,
    job_type: str,
    radar_scores: Dict[str, float],
    craft_scores: Dict[str, float],
    enterprise_weights: Optional[Dict[str, float]] = None,
    radar_requirements: Optional[Dict[str, float]] = None,
    craft_requirements: Optional[Dict[str, float]] = None,
) -> EnterpriseFitResult:
    """计算 agent 对特定企业的适配度（纯函数）。

    参数：
      agent_id:            员工 ID
      job_type:            工种（image / text / code）
      radar_scores:        通用六维分数 {dim: 0–5}
      craft_scores:        craft 维分数 {dim: 0–5}
      enterprise_weights:  企业维度权重偏好（可选，缺省用 registry 默认权重）
      radar_requirements:  通用六维要求分数（可选，缺省默认 3.5）
      craft_requirements:  craft 维要求分数（可选，缺省默认 3.5）

    返回：EnterpriseFitResult 综合报告。
    """
    radar_requirements = radar_requirements or {}
    craft_requirements = craft_requirements or {}

    # —— 1) 获取工种 craft 维度 ——
    craft_dims = JOB_CRAFT_DIMS.get(job_type, [])

    # —— 2) 通用六维适配 ——
    radar_fits: Dict[str, DimensionFit] = {}
    for dim in RADAR_DIMS:
        actual = radar_scores.get(dim, 0)
        required = radar_requirements.get(dim, 3.5)
        radar_fits[dim] = DimensionFit(
            dim=dim,
            actual=actual,
            required=required,
            gap=round(required - actual, 2),
            status=_dim_status(actual, required),
        )

    # —— 3) craft 维适配 ——
    craft_fits: Dict[str, DimensionFit] = {}
    for dim in craft_dims:
        actual = craft_scores.get(dim, 0)
        required = craft_requirements.get(dim, 3.5)
        craft_fits[dim] = DimensionFit(
            dim=dim,
            actual=actual,
            required=required,
            gap=round(required - actual, 2),
            status=_dim_status(actual, required),
        )

    # 合并所有维度
    all_fits = {**radar_fits, **craft_fits}

    # —— 4) 综合匹配分（量级 + 方向混合） ——
    # ⚠️ 纯余弦相似度只看方向不看量级：全 1.0 向量和全 5.0 向量余弦=1.0，
    # 因此必须引入「加权达标率」作为量级分量。
    _weights = {d: enterprise_weights.get(d, 1.0) if enterprise_weights else 1.0 for d in all_fits}
    _w_actual = sum(fit.actual * _weights.get(d, 1.0) for d, fit in all_fits.items())
    _w_required = sum(fit.required * _weights.get(d, 1.0) for d, fit in all_fits.items())
    magnitude_ratio = min(1.0, _w_actual / _w_required) if _w_required > 0 else 0.0

    cosine = _cosine_similarity(
        {d: _weights.get(d, 1.0) for d in all_fits},
        {d: fit.actual for d, fit in all_fits.items()},
    )
    total_dims = len(all_fits)
    met_count = sum(1 for f in all_fits.values() if f.status in ("exceeds", "meets"))
    meet_rate = met_count / total_dims if total_dims > 0 else 0

    # 综合分 = 50% 量级达标率 + 30% 达标率 + 20% 方向余弦
    overall_fit = round((0.5 * magnitude_ratio + 0.3 * meet_rate + 0.2 * cosine) * 100, 1)

    # 分别计算 radar_fit 和 craft_fit
    _rw_actual = sum(radar_scores.get(d, 0) * _weights.get(d, 1.0) for d in RADAR_DIMS)
    _rw_required = sum(radar_requirements.get(d, 3.5) * _weights.get(d, 1.0) for d in RADAR_DIMS)
    radar_mag = min(1.0, _rw_actual / _rw_required) if _rw_required > 0 else 0.0
    radar_cosine = _cosine_similarity(
        {d: _weights.get(d, 1.0) for d in RADAR_DIMS},
        {d: radar_scores.get(d, 0) for d in RADAR_DIMS},
    )
    radar_met = sum(1 for f in radar_fits.values() if f.status in ("exceeds", "meets"))
    radar_fit = round((0.5 * radar_mag + 0.3 * (radar_met / len(RADAR_DIMS)) + 0.2 * radar_cosine) * 100, 1)

    craft_dims_count = len(craft_dims)
    if craft_dims_count > 0:
        _cw_actual = sum(craft_scores.get(d, 0) * _weights.get(d, 1.0) for d in craft_dims)
        _cw_required = sum(craft_requirements.get(d, 3.5) * _weights.get(d, 1.0) for d in craft_dims)
        craft_mag = min(1.0, _cw_actual / _cw_required) if _cw_required > 0 else 0.0
        craft_cosine = _cosine_similarity(
            {d: _weights.get(d, 1.0) for d in craft_dims},
            {d: craft_scores.get(d, 0) for d in craft_dims},
        )
        craft_met = sum(1 for f in craft_fits.values() if f.status in ("exceeds", "meets"))
        craft_fit = round((0.5 * craft_mag + 0.3 * (craft_met / craft_dims_count) + 0.2 * craft_cosine) * 100, 1)
    else:
        craft_fit = 0.0

    # —— 5) 优势维度（exceeds） ——
    strengths = [d for d, f in all_fits.items() if f.status == "exceeds"]

    # —— 6) 培训建议（按 gap × weight 降序排列）——
    recommendations: List[TrainingRecommendation] = []
    weak_dims = [
        (d, f) for d, f in all_fits.items()
        if f.status in ("below", "critical")
    ]
    # 按 gap 降序排序
    weak_dims.sort(key=lambda x: x[1].gap, reverse=True)

    action_templates = {
        "task": "加强任务理解与规划能力：多做端到端任务分解练习",
        "quality": "提升输出质量：注重细节打磨与交付标准",
        "comm": "改善沟通表达：练习面向不同受众的清晰传达",
        "creativity": "拓展创造性思维：尝试多种方案对比择优",
        "reliability": "增强可靠性：加强边界条件处理与异常恢复",
        "cost": "优化成本意识：减少冗余步骤、提升效率",
    }
    # craft 维的通用建议模板
    for prefix, label in [("img_", "图像"), ("txt_", "文本"), ("code_", "代码")]:
        for d, _ in [(k, v) for k, v in weak_dims if k.startswith(prefix)]:
            pass  # 下面统一处理

    for priority_idx, (dim, fit) in enumerate(weak_dims, 1):
        action = action_templates.get(dim, f"加强 {dim} 维度的专项训练")
        recommendations.append(TrainingRecommendation(
            dim=dim,
            priority=priority_idx,
            current_score=fit.actual,
            target_score=fit.required,
            reason=f"当前 {fit.actual:.1f}，要求 {fit.required:.1f}，差距 {fit.gap:.1f}",
            suggested_action=action,
        ))

    # —— 7) 就绪度 ——
    critical_count = sum(1 for f in all_fits.values() if f.status == "critical")
    readiness = _classify_readiness(overall_fit, critical_count)

    return EnterpriseFitResult(
        agent_id=agent_id,
        job_type=job_type,
        overall_fit=overall_fit,
        readiness=readiness,
        dimension_fits=all_fits,
        strengths=strengths,
        recommendations=recommendations,
        radar_fit=radar_fit,
        craft_fit=craft_fit,
    )
