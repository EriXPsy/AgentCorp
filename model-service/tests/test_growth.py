"""
model-service/tests/test_growth.py
成长历程引擎单测。

覆盖：
1. 空 / 单点 / 多点数据的边界行为
2. 线性回归斜率的正确性
3. 成长阶段判定（rapid / steady / plateau / decline）
4. 里程碑检测（首获 MVP / 维度突破 / 一致性连胜 / 低谷恢复）
5. 短板识别
6. 综合成长分

运行：python -m pytest tests/test_growth.py -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from app.scoring.growth import (  # noqa: E402
    DimensionTrend,
    GrowthMilestone,
    GrowthTrajectory,
    SkillGap,
    _classify_direction,
    _classify_phase,
    _compute_consistency,
    _detect_milestones,
    _growth_score,
    _linreg_slope,
    compute_growth_trajectory,
)

from app.scoring.enterprise_fit import (  # noqa: E402
    DimensionFit,
    EnterpriseFitResult,
    TrainingRecommendation,
    _cosine_similarity,
    _dim_status,
    compute_enterprise_fit,
)


# ----------------------------------------------------------------------
# 线性回归
# ----------------------------------------------------------------------
def test_linreg_slope_perfect_linear():
    """完美线性增长 → 斜率 = 1.0"""
    assert _linreg_slope([1, 2, 3, 4, 5]) == pytest.approx(1.0, abs=0.01)


def test_linreg_slope_flat():
    """水平线 → 斜率 = 0"""
    assert _linreg_slope([3, 3, 3, 3]) == pytest.approx(0.0, abs=0.01)


def test_linreg_slope_declining():
    """下降 → 负斜率"""
    assert _linreg_slope([5, 4, 3, 2, 1]) == pytest.approx(-1.0, abs=0.01)


def test_linreg_slope_single_point():
    """单点 → 0（无趋势可言）"""
    assert _linreg_slope([4.0]) == 0.0


def test_linreg_slope_empty():
    """空序列 → 0"""
    assert _linreg_slope([]) == 0.0


# ----------------------------------------------------------------------
# 方向分类
# ----------------------------------------------------------------------
def test_classify_direction_improving():
    assert _classify_direction(0.2) == "improving"


def test_classify_direction_declining():
    assert _classify_direction(-0.3) == "declining"


def test_classify_direction_stable():
    assert _classify_direction(0.01) == "stable"


def test_classify_direction_boundary():
    """恰好在阈值边界"""
    assert _classify_direction(0.05) == "stable"  # 不大于 threshold
    assert _classify_direction(0.051) == "improving"


# ----------------------------------------------------------------------
# 成长阶段
# ----------------------------------------------------------------------
def test_classify_phase_rapid():
    assert _classify_phase(0.2, 0.6) == "rapid"


def test_classify_phase_steady():
    assert _classify_phase(0.1, 0.4) == "steady"


def test_classify_phase_plateau():
    assert _classify_phase(0.02, 0.8) == "plateau"


def test_classify_phase_decline():
    assert _classify_phase(-0.1, 0.5) == "decline"


# ----------------------------------------------------------------------
# 一致性
# ----------------------------------------------------------------------
def test_consistency_perfect():
    """完全不变 → 一致性 = 1.0"""
    assert _compute_consistency([3, 3, 3, 3, 3]) == pytest.approx(1.0, abs=0.01)


def test_consistency_large_swings():
    """剧烈波动 → 一致性接近 0"""
    c = _compute_consistency([1, 5, 1, 5, 1, 5])
    assert c < 0.3


def test_consistency_insufficient_data():
    """不足 3 个点 → 中性 0.5"""
    assert _compute_consistency([3, 4]) == 0.5


# ----------------------------------------------------------------------
# 成长分
# ----------------------------------------------------------------------
def test_growth_score_range():
    """成长分必须在 0–100 范围内"""
    score = _growth_score(
        trends={}, overall_velocity=0.3, consistency=0.8, peak_avg=4.0
    )
    assert 0 <= score <= 100


def test_growth_score_high_for_fast_growth():
    """快速成长 → 高分"""
    score = _growth_score(
        trends={}, overall_velocity=0.5, consistency=0.9, peak_avg=5.0
    )
    assert score >= 85


def test_growth_score_low_for_decline():
    """退步 → 低分"""
    score = _growth_score(
        trends={}, overall_velocity=-0.3, consistency=0.2, peak_avg=2.0
    )
    assert score < 30


# ----------------------------------------------------------------------
# 余弦相似度
# ----------------------------------------------------------------------
def test_cosine_identical():
    """相同向量 → 1.0"""
    assert _cosine_similarity({"a": 1, "b": 1}, {"a": 1, "b": 1}) == pytest.approx(1.0)


def test_cosine_orthogonal():
    """正交向量 → 0"""
    assert _cosine_similarity({"a": 1, "b": 0}, {"a": 0, "b": 1}) == pytest.approx(0.0)


def test_cosine_empty():
    """无交集 → 0"""
    assert _cosine_similarity({"a": 1}, {"b": 1}) == pytest.approx(0.0)


# ----------------------------------------------------------------------
# compute_growth_trajectory 集成
# ----------------------------------------------------------------------
def _make_radar_history(n: int, base: float = 3.0, step: float = 0.2) -> list:
    """生成模拟雷达历史（六维同步线性增长）。"""
    history = []
    for i in range(n):
        score = min(5.0, base + step * i)
        history.append({d: score for d in [
            "task", "quality", "comm", "creativity", "reliability", "cost"
        ]})
    return history


def test_empty_history():
    """空历史 → 无趋势、无里程碑"""
    result = compute_growth_trajectory("agent-x", [])
    assert result.total_evaluations == 0
    assert result.time_span_label == "尚无评估记录"
    assert result.milestones == []
    assert result.skill_gaps != []  # 全 0 分都是短板


def test_single_evaluation():
    """单次评估 → 有趋势但无斜率"""
    history = _make_radar_history(1)
    result = compute_growth_trajectory("agent-x", history)
    assert result.total_evaluations == 1
    assert result.time_span_label == "1 次评估"
    for t in result.trends.values():
        assert t.velocity == 0.0


def test_growing_agent():
    """持续进步 → improving 方向"""
    history = _make_radar_history(8, base=2.5, step=0.25)
    result = compute_growth_trajectory("agent-x", history)
    assert result.overall_velocity > 0
    assert result.growth_phase in ("rapid", "steady")
    assert result.growth_score > 30


def test_declining_agent():
    """持续退步 → decline 阶段"""
    history = _make_radar_history(6, base=4.5, step=-0.2)
    result = compute_growth_trajectory("agent-x", history)
    assert result.overall_velocity < 0
    assert result.growth_phase == "decline"


def test_plateau_agent():
    """持平 → plateau 阶段"""
    history = _make_radar_history(5, base=3.5, step=0.0)
    result = compute_growth_trajectory("agent-x", history)
    assert result.growth_phase == "plateau"


# ----------------------------------------------------------------------
# 里程碑检测
# ----------------------------------------------------------------------
def test_milestone_first_mvp():
    """阶段评分中出现 MVP → 检测到首获 MVP 里程碑"""
    radar = _make_radar_history(3)
    stages = [
        {"stage": "preScreen", "verdict": "OBSERVE", "total": 55},
        {"stage": "interview", "verdict": "MVP", "total": 82},
    ]
    result = compute_growth_trajectory("agent-x", radar, stages)
    kinds = [m.kind for m in result.milestones]
    assert "first_mvp" in kinds


def test_milestone_dimension_breakthrough():
    """维度从 < 4.0 跳到 ≥ 4.0 → 突破里程碑"""
    # 第一轮全 3.0，最后一轮 task=4.5
    history = [
        {d: 3.0 for d in ["task", "quality", "comm", "creativity", "reliability", "cost"]},
        {d: 3.2 for d in ["task", "quality", "comm", "creativity", "reliability", "cost"]},
        {"task": 4.5, "quality": 3.3, "comm": 3.3, "creativity": 3.3, "reliability": 3.3, "cost": 3.3},
    ]
    result = compute_growth_trajectory("agent-x", history)
    breakthroughs = [m for m in result.milestones if m.kind == "dimension_breakthrough"]
    assert len(breakthroughs) == 1
    assert breakthroughs[0].dimension == "task"


def test_milestone_consistency_streak():
    """连续 4 次不退步 → 一致性连胜里程碑"""
    history = _make_radar_history(5, base=3.0, step=0.1)
    result = compute_growth_trajectory("agent-x", history)
    streaks = [m for m in result.milestones if m.kind == "consistency_streak"]
    assert len(streaks) >= 1


def test_milestone_recovery():
    """从 FIRED 恢复 → recovery 里程碑"""
    radar = _make_radar_history(3)
    stages = [
        {"stage": "preScreen", "verdict": "FIRED", "total": 40},
        {"stage": "interview", "verdict": "OBSERVE", "total": 60},
    ]
    result = compute_growth_trajectory("agent-x", radar, stages)
    recoveries = [m for m in result.milestones if m.kind == "recovery"]
    assert len(recoveries) == 1


# ----------------------------------------------------------------------
# 短板识别
# ----------------------------------------------------------------------
def test_skill_gaps_below_threshold():
    """低于 3.0 的维度应被识别为短板"""
    history = [
        {"task": 2.0, "quality": 4.0, "comm": 2.5, "creativity": 3.5, "reliability": 1.5, "cost": 3.0},
    ]
    result = compute_growth_trajectory("agent-x", history, gap_threshold=3.0)
    gap_dims = {g.dim for g in result.skill_gaps}
    assert "task" in gap_dims
    assert "comm" in gap_dims
    assert "reliability" in gap_dims
    assert "quality" not in gap_dims
    assert "creativity" not in gap_dims


def test_skill_gaps_sorted_by_priority():
    """短板应按 gap × weight 降序排列"""
    history = [
        {"task": 1.0, "quality": 2.0, "comm": 2.5, "creativity": 2.8, "reliability": 2.9, "cost": 2.0},
    ]
    result = compute_growth_trajectory("agent-x", history, gap_threshold=3.0)
    if len(result.skill_gaps) >= 2:
        for i in range(len(result.skill_gaps) - 1):
            a = result.skill_gaps[i]
            b = result.skill_gaps[i + 1]
            assert a.gap * a.weight >= b.gap * b.weight


# ----------------------------------------------------------------------
# compute_enterprise_fit 集成
# ----------------------------------------------------------------------
def test_enterprise_fit_perfect_match():
    """所有维度满分 → fit = 100, ready"""
    radar = {d: 5.0 for d in ["task", "quality", "comm", "creativity", "reliability", "cost"]}
    craft = {d: 5.0 for d in ["code_runnability", "code_efficiency", "code_test_coverage", "code_maintainability", "code_security"]}
    result = compute_enterprise_fit("agent-x", "code", radar, craft)
    assert result.overall_fit >= 90
    assert result.readiness == "ready"


def test_enterprise_fit_poor_match():
    """所有维度低分 → fit 低, not_ready"""
    radar = {d: 1.0 for d in ["task", "quality", "comm", "creativity", "reliability", "cost"]}
    craft = {d: 1.0 for d in ["code_runnability", "code_efficiency", "code_test_coverage", "code_maintainability", "code_security"]}
    result = compute_enterprise_fit("agent-x", "code", radar, craft)
    assert result.overall_fit < 50
    assert result.readiness == "not_ready"


def test_enterprise_fit_custom_requirements():
    """自定义要求 → 低于要求的维度报 below/critical"""
    radar = {"task": 4.0, "quality": 3.0, "comm": 2.0, "creativity": 3.0, "reliability": 3.5, "cost": 3.0}
    craft = {"txt_factuality": 2.0, "txt_coherence": 4.0, "txt_tone_fit": 2.5, "txt_info_density": 3.5, "txt_instruction_follow": 3.0}
    result = compute_enterprise_fit(
        "agent-x", "text", radar, craft,
        craft_requirements={"txt_factuality": 4.0, "txt_tone_fit": 3.5},
    )
    factuality_fit = result.dimension_fits["txt_factuality"]
    assert factuality_fit.status in ("below", "critical")
    assert factuality_fit.gap > 0


def test_enterprise_fit_strengths():
    """超标的维度应进入 strengths"""
    radar = {d: 3.0 for d in ["task", "quality", "comm", "creativity", "reliability", "cost"]}
    craft = {"txt_factuality": 5.0, "txt_coherence": 4.5, "txt_tone_fit": 4.0, "txt_info_density": 3.5, "txt_instruction_follow": 3.0}
    result = compute_enterprise_fit("agent-x", "text", radar, craft)
    assert "txt_factuality" in result.strengths


def test_enterprise_fit_recommendations_sorted():
    """培训建议应按差距降序排列"""
    radar = {d: 2.0 for d in ["task", "quality", "comm", "creativity", "reliability", "cost"]}
    craft = {d: 2.0 for d in ["code_runnability", "code_efficiency", "code_test_coverage", "code_maintainability", "code_security"]}
    result = compute_enterprise_fit("agent-x", "code", radar, craft)
    if len(result.recommendations) >= 2:
        for i in range(len(result.recommendations) - 1):
            a = result.recommendations[i]
            b = result.recommendations[i + 1]
            gap_a = a.target_score - a.current_score
            gap_b = b.target_score - b.current_score
            assert gap_a >= gap_b


def test_dim_status_classification():
    """维度状态分类正确"""
    assert _dim_status(4.5, 3.5) == "exceeds"   # 差 +1.0 ≥ 0.5
    assert _dim_status(3.5, 3.5) == "meets"       # 差 = 0
    assert _dim_status(3.0, 3.5) == "below"       # 差 = -0.5
    assert _dim_status(2.0, 3.5) == "critical"    # 差 = -1.5


def test_enterprise_fit_radar_and_craft_split():
    """radar_fit 和 craft_fit 应分别计算"""
    radar = {d: 4.0 for d in ["task", "quality", "comm", "creativity", "reliability", "cost"]}
    craft = {d: 2.0 for d in ["code_runnability", "code_efficiency", "code_test_coverage", "code_maintainability", "code_security"]}
    result = compute_enterprise_fit("agent-x", "code", radar, craft)
    assert result.radar_fit > result.craft_fit, "radar 高 craft 低 → radar_fit > craft_fit"
