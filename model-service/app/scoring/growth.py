"""
model-service/app/scoring/growth.py
员工成长历程引擎。

为什么需要它：AgentCorp 里每个 agent 都是一名「员工」，会经历多轮评估（S1→S2→S3）
并随时间推移产出 radarHistory / stageScores。但这些数据只是累积的快照，**没有任何代码
把它们翻译成「这个员工这段时间是在进步、停滞还是退步」**——成长轨迹一片空白。

本模块回答四个问题：
1. 这个员工每个维度的进步速度是多少？ → 维度速度（最小二乘线性回归斜率）
2. 他整体处于什么成长阶段？         → 成长阶段（rapid / steady / plateau / decline）
3. 他有哪些值得标记的里程碑？        → 里程碑检测（首获 MVP、维度突破 4.0、连续达标等）
4. 哪些维度是短板、需要优先补？       → 短板识别（低于阈值 + 权重高的维优先）

设计约束：
- 纯函数、无副作用、无外部依赖（只用标准库 math），可直接单测；
- 只消费已有数据（radarHistory / stageScores / craftLatest），不发网络、不调 LLM；
- 与 registry.RADAR_DIMS / JOB_CRAFT_DIMS 同源，不新增维度体系。

论文依据：
- HELM（Liang et al. 2022）：多维度纵向评估而非单点快照；
- 成长型思维在 Agent 评测中的迁移（Dweck 2006 → LLM agent growth tracking 2024）：
  把「能力」建模为可变的轨迹而非固定特质。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from .registry import RADAR_DIMS, JOB_CRAFT_DIMS


# ----------------------------------------------------------------------
# 数据结构
# ----------------------------------------------------------------------
@dataclass(frozen=True)
class DimensionTrend:
    """单个维度的成长趋势。"""
    dim: str
    values: List[float]          # 按时间顺序的分数序列
    velocity: float              # 线性回归斜率（每评估周期的分数变化）
    direction: str               # "improving" / "declining" / "stable"
    peak: float                  # 历史最高分
    current: float               # 最新分数
    delta: float                 # 最新 - 最早（总变化量）


@dataclass(frozen=True)
class GrowthMilestone:
    """成长历程中的里程碑事件。"""
    kind: str                    # "first_mvp" / "dimension_breakthrough" / "consistency_streak" / "recovery"
    dimension: Optional[str]     # 相关维度（None = 整体）
    description: str             # 人类可读描述
    score_before: float          # 事件前分数
    score_after: float           # 事件后分数


@dataclass(frozen=True)
class SkillGap:
    """短板维度。"""
    dim: str
    current: float
    threshold: float             # 短板阈值（默认 3.0）
    gap: float                   # threshold - current
    weight: float                # 该维在评分中的权重（用于排序优先级）


@dataclass(frozen=True)
class GrowthTrajectory:
    """员工成长轨迹（综合报告）。"""
    agent_id: str
    total_evaluations: int                                # 雷达历史长度
    time_span_label: str                                  # "3 次评估" 等人文标签
    trends: Dict[str, DimensionTrend]                     # 六维趋势
    overall_velocity: float                               # 加权平均速度
    growth_phase: str                                     # "rapid" / "steady" / "plateau" / "decline"
    growth_score: float                                   # 0–100 综合成长分
    milestones: List[GrowthMilestone]                     # 里程碑列表
    strengths: List[str]                                  # 最强维度（top 3 by current score）
    weaknesses: List[str]                                 # 最弱维度（bottom 3 by current score）
    skill_gaps: List[SkillGap]                            # 短板列表（按优先级排序）


# ----------------------------------------------------------------------
# 纯函数：最小二乘线性回归
# ----------------------------------------------------------------------
def _linreg_slope(values: Sequence[float]) -> float:
    """计算最小二乘线性回归斜率（纯函数）。

    x = [0, 1, 2, ..., n-1]，y = values。
    返回斜率 b = Σ((x-x̄)(y-ȳ)) / Σ((x-x̄)²)。
    数据点不足 2 个时返回 0。
    """
    n = len(values)
    if n < 2:
        return 0.0
    x_mean = (n - 1) / 2.0
    y_mean = sum(values) / n
    num = sum((i - x_mean) * (v - y_mean) for i, v in enumerate(values))
    den = sum((i - x_mean) ** 2 for i in range(n))
    if den == 0:
        return 0.0
    return num / den


def _classify_direction(velocity: float, threshold: float = 0.05) -> str:
    """根据速度分类方向。

    threshold 默认 0.05：每周期变化超过 0.05 分才算「有方向」，
    避免噪声级波动被误判为趋势。
    """
    if velocity > threshold:
        return "improving"
    elif velocity < -threshold:
        return "declining"
    return "stable"


# ----------------------------------------------------------------------
# 纯函数：成长阶段判定
# ----------------------------------------------------------------------
def _classify_phase(overall_velocity: float, consistency: float) -> str:
    """根据整体速度和一致性判定成长阶段。

    - rapid:   速度 > 0.15 且一致性 > 0.5（快速进步）
    - steady:  速度 > 0.05 且一致性 > 0.3（稳步提升）
    - plateau: |速度| ≤ 0.05（停滞）
    - decline: 速度 < -0.05（退步）
    """
    if overall_velocity > 0.15 and consistency > 0.5:
        return "rapid"
    elif overall_velocity > 0.05 and consistency > 0.3:
        return "steady"
    elif overall_velocity < -0.05:
        return "decline"
    return "plateau"


def _compute_consistency(values: Sequence[float]) -> float:
    """计算分数序列的一致性（0–1）。

    用连续差分标准差的倒数变换：波动越小一致性越高。
    至少需要 3 个数据点；不足时返回 0.5（中性）。
    """
    if len(values) < 3:
        return 0.5
    diffs = [values[i + 1] - values[i] for i in range(len(values) - 1)]
    mean_diff = sum(abs(d) for d in diffs) / len(diffs)
    # 平均绝对变化量越小越一致；0→1, 1+→0
    return max(0.0, min(1.0, 1.0 - mean_diff))


# ----------------------------------------------------------------------
# 纯函数：成长分计算
# ----------------------------------------------------------------------
def _growth_score(
    trends: Dict[str, DimensionTrend],
    overall_velocity: float,
    consistency: float,
    peak_avg: float,
) -> float:
    """计算综合成长分（0–100）。

    公式：growth_score = 40 × velocity_component
                     + 30 × level_component
                     + 30 × consistency_component

    三个分量各贡献 0–1 的子分：
    - velocity: 速度归一化到 [0, 1]（velocity=0.5 → 1.0）
    - level:    当前均分归一化到 [0, 1]（peak_avg=5 → 1.0）
    - consistency: 直接使用
    """
    velocity_comp = min(1.0, max(0.0, overall_velocity / 0.5))
    level_comp = min(1.0, max(0.0, peak_avg / 5.0))
    consistency_comp = consistency
    raw = 40 * velocity_comp + 30 * level_comp + 30 * consistency_comp
    return round(min(100.0, max(0.0, raw)), 1)


# ----------------------------------------------------------------------
# 纯函数：里程碑检测
# ----------------------------------------------------------------------
def _detect_milestones(
    radar_history: List[Dict[str, float]],
    stage_scores: List[dict],
) -> List[GrowthMilestone]:
    """从雷达历史和阶段评分中检测里程碑事件。"""
    milestones: List[GrowthMilestone] = []

    # 1) 首获 MVP
    for i, ss in enumerate(stage_scores):
        verdict = ss.get("verdict", "")
        if verdict == "MVP":
            total = ss.get("total", 0)
            milestones.append(GrowthMilestone(
                kind="first_mvp" if i == 0 or all(
                    stage_scores[j].get("verdict") != "MVP" for j in range(i)
                ) else "mvp_renewal",
                dimension=None,
                description=f"阶段 {ss.get('stage', '?')} 获评 MVP（总分 {total:.1f}）",
                score_before=0,
                score_after=total,
            ))
            break  # 只记录首次

    # 2) 维度突破 4.0（从低于 4.0 跳到 ≥ 4.0）
    if len(radar_history) >= 2:
        for dim in RADAR_DIMS:
            prev = radar_history[0].get(dim, 0)
            curr = radar_history[-1].get(dim, 0)
            if prev < 4.0 <= curr:
                milestones.append(GrowthMilestone(
                    kind="dimension_breakthrough",
                    dimension=dim,
                    description=f"维度 {dim} 突破 4.0（{prev:.1f} → {curr:.1f}）",
                    score_before=prev,
                    score_after=curr,
                ))

    # 3) 一致性连胜（连续 3 次评估无退步）
    if len(radar_history) >= 3:
        streak = 0
        max_streak = 0
        for i in range(1, len(radar_history)):
            prev_avg = sum(radar_history[i - 1].get(d, 0) for d in RADAR_DIMS) / len(RADAR_DIMS)
            curr_avg = sum(radar_history[i].get(d, 0) for d in RADAR_DIMS) / len(RADAR_DIMS)
            if curr_avg >= prev_avg:
                streak += 1
                max_streak = max(max_streak, streak)
            else:
                streak = 0
        if max_streak >= 3:
            milestones.append(GrowthMilestone(
                kind="consistency_streak",
                dimension=None,
                description=f"连续 {max_streak} 次评估无退步",
                score_before=0,
                score_after=0,
            ))

    # 4) 低谷恢复（从 FIRED 到非 FIRED）
    for i in range(1, len(stage_scores)):
        prev_v = stage_scores[i - 1].get("verdict", "")
        curr_v = stage_scores[i].get("verdict", "")
        if prev_v == "FIRED" and curr_v != "FIRED":
            milestones.append(GrowthMilestone(
                kind="recovery",
                dimension=None,
                description=f"从 FIRED 恢复到 {curr_v}",
                score_before=stage_scores[i - 1].get("total", 0),
                score_after=stage_scores[i].get("total", 0),
            ))

    return milestones


# ----------------------------------------------------------------------
# 主入口：计算完整成长轨迹
# ----------------------------------------------------------------------
def compute_growth_trajectory(
    agent_id: str,
    radar_history: List[Dict[str, float]],
    stage_scores: Optional[List[dict]] = None,
    job_type: str = "code",
    gap_threshold: float = 3.0,
) -> GrowthTrajectory:
    """计算员工的完整成长轨迹（纯函数）。

    参数：
      agent_id:      员工 ID
      radar_history: 按时间顺序的六维雷达分数列表
      stage_scores:  阶段评分卡列表（可选，用于里程碑检测）
      job_type:      工种（用于获取 craft 维权重）
      gap_threshold: 短板阈值（默认 3.0）

    返回：GrowthTrajectory 综合报告。
    """
    stage_scores = stage_scores or []
    n = len(radar_history)

    # —— 1) 每维度趋势 ——
    trends: Dict[str, DimensionTrend] = {}
    all_currents: List[float] = []
    all_velocities: List[float] = []

    for dim in RADAR_DIMS:
        values = [rh.get(dim, 0) for rh in radar_history]
        velocity = round(_linreg_slope(values), 4)
        direction = _classify_direction(velocity)
        peak = max(values) if values else 0
        current = values[-1] if values else 0
        delta = round(current - values[0], 2) if len(values) >= 2 else 0
        trends[dim] = DimensionTrend(
            dim=dim,
            values=values,
            velocity=velocity,
            direction=direction,
            peak=peak,
            current=current,
            delta=delta,
        )
        if values:
            all_currents.append(current)
            all_velocities.append(velocity)

    # —— 2) 整体速度 & 一致性 ——
    overall_velocity = round(
        sum(all_velocities) / len(all_velocities), 4
    ) if all_velocities else 0.0

    # 一致性：各维度一致性的加权平均
    consistencies = [_compute_consistency(trends[d].values) for d in RADAR_DIMS]
    avg_consistency = round(
        sum(consistencies) / len(consistencies), 4
    ) if consistencies else 0.5

    # —— 3) 成长阶段 ——
    growth_phase = _classify_phase(overall_velocity, avg_consistency)

    # —— 4) 成长分 ——
    peak_avg = sum(t.peak for t in trends.values()) / len(trends) if trends else 0
    growth_score = _growth_score(trends, overall_velocity, avg_consistency, peak_avg)

    # —— 5) 里程碑 ——
    milestones = _detect_milestones(radar_history, stage_scores)

    # —— 6) 优势 / 弱势维度 ——
    sorted_by_current = sorted(trends.values(), key=lambda t: t.current, reverse=True)
    strengths = [t.dim for t in sorted_by_current[:3] if t.current > 0]
    weaknesses = [t.dim for t in sorted_by_current[-3:] if t.current > 0]
    weaknesses.reverse()  # 最弱的在前

    # —— 7) 短板识别 ——
    # 获取工种通用权重
    from .rules_engine import load_rules, flatten_dim_weight
    try:
        rules = load_rules("default")
        weights = flatten_dim_weight("preScreen", job_type, rules)
    except Exception:
        weights = {d: 1.0 / len(RADAR_DIMS) for d in RADAR_DIMS}

    skill_gaps: List[SkillGap] = []
    for dim in RADAR_DIMS:
        current = trends[dim].current
        if current < gap_threshold:
            skill_gaps.append(SkillGap(
                dim=dim,
                current=current,
                threshold=gap_threshold,
                gap=round(gap_threshold - current, 2),
                weight=weights.get(dim, 0),
            ))
    # 按 gap × weight 降序排列（权重高的大短板最优先补）
    skill_gaps.sort(key=lambda g: g.gap * g.weight, reverse=True)

    # —— 人文标签 ——
    if n == 0:
        time_label = "尚无评估记录"
    elif n == 1:
        time_label = "1 次评估"
    else:
        time_label = f"{n} 次评估"

    return GrowthTrajectory(
        agent_id=agent_id,
        total_evaluations=n,
        time_span_label=time_label,
        trends=trends,
        overall_velocity=overall_velocity,
        growth_phase=growth_phase,
        growth_score=growth_score,
        milestones=milestones,
        strengths=strengths,
        weaknesses=weaknesses,
        skill_gaps=skill_gaps,
    )
