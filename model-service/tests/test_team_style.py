"""
model-service/tests/test_team_style.py
TeamStyleProfile 合成逻辑的单测。

覆盖：
1. 基本合成 — 成员 + 评测 → profile
2. 强弱维度分类
3. 沙箱通过率计算
4. 难度上限映射
5. 校准状态（is_calibrated）
6. 序列化为 Designer prompt
7. 边界：空数据、单成员、无评测
"""
from __future__ import annotations

import pytest

from app.scoring.team_style import (
    EvalSnapshot,
    MemberSnapshot,
    TeamStyleProfile,
    synthesize_profile,
)


# ======================================================================
# 1) 基本合成
# ======================================================================
def test_basic_synthesis():
    """3 个成员 + 5 次评测 → 完整 profile。"""
    members = [
        MemberSnapshot(agent_id="a1", job_type="code", tasks_completed=10),
        MemberSnapshot(agent_id="a2", job_type="code", tasks_completed=8),
        MemberSnapshot(agent_id="a3", job_type="text", tasks_completed=3),
    ]
    evals = [
        EvalSnapshot("code_csv_merge", "code", {"code_runnability": 4.5, "code_test_coverage": 4.0}),
        EvalSnapshot("code_csv_merge", "code", {"code_runnability": 4.0, "code_test_coverage": 3.5}),
        EvalSnapshot("code_json_transform", "code", {"code_runnability": 4.5, "code_maintainability": 3.0}),
        EvalSnapshot("code_list_dedup_sort", "code", {"code_runnability": 4.0, "code_efficiency": 2.0}),
        EvalSnapshot("code_word_frequency", "code", {"code_runnability": 3.5, "code_efficiency": 2.0}),
    ]
    profile = synthesize_profile(
        "team_1",
        description="数据处理团队",
        members=members,
        evals=evals,
        experience_lessons=["处理千分位时要先去掉货币符号", "CSV 空行要跳过"],
    )

    assert profile.team_id == "team_1"
    assert profile.primary_job_type == "code"  # 2 code vs 1 text
    assert profile.member_count == 3
    assert profile.eval_count == 5
    assert profile.is_calibrated  # >= 3 次评测


def test_empty_data_produces_minimal_profile():
    """无成员、无评测 → 最小 profile（未校准）。"""
    profile = synthesize_profile("team_empty")

    assert profile.team_id == "team_empty"
    assert profile.primary_job_type == "code"  # 默认
    assert profile.member_count == 0
    assert profile.eval_count == 0
    assert not profile.is_calibrated
    assert profile.strong_dims == []
    assert profile.weak_dims == []


# ======================================================================
# 2) 强弱维度分类
# ======================================================================
def test_strong_dims_classified():
    """稳定高分（>= 3.5 且 >= 2 次）→ strong。"""
    evals = [
        EvalSnapshot("t1", "code", {"code_runnability": 4.5}),
        EvalSnapshot("t2", "code", {"code_runnability": 4.0}),
        EvalSnapshot("t3", "code", {"code_runnability": 4.2}),
    ]
    profile = synthesize_profile("t", evals=evals)
    assert "code_runnability" in profile.strong_dims


def test_weak_dims_classified():
    """稳定低分（< 2.5）→ weak，按均分升序排。"""
    evals = [
        EvalSnapshot("t1", "code", {"code_security": 2.0, "code_efficiency": 1.5}),
        EvalSnapshot("t2", "code", {"code_security": 2.0, "code_efficiency": 2.0}),
    ]
    profile = synthesize_profile("t", evals=evals)
    assert "code_security" in profile.weak_dims
    assert "code_efficiency" in profile.weak_dims
    # code_efficiency 均分更低（1.75 < 2.0），应该排在前面
    assert profile.weak_dims.index("code_efficiency") < profile.weak_dims.index("code_security")


def test_middle_dims_not_classified():
    """中间分（2.5-3.5）既不强也不弱。"""
    evals = [
        EvalSnapshot("t1", "code", {"code_maintainability": 3.0}),
        EvalSnapshot("t2", "code", {"code_maintainability": 3.2}),
    ]
    profile = synthesize_profile("t", evals=evals)
    assert "code_maintainability" not in profile.strong_dims
    assert "code_maintainability" not in profile.weak_dims


def test_single_eval_not_classified_as_strong():
    """只有 1 次高分不判为强（样本不足）。"""
    evals = [
        EvalSnapshot("t1", "code", {"code_runnability": 5.0}),
    ]
    profile = synthesize_profile("t", evals=evals)
    assert "code_runnability" not in profile.strong_dims  # 只 1 次，不够


# ======================================================================
# 3) 沙箱通过率
# ======================================================================
def test_pass_rate_calculation():
    """7 过 3 败 → 0.7。"""
    results = [True] * 7 + [False] * 3
    profile = synthesize_profile("t", sandbox_results=results)
    assert abs(profile.avg_pass_rate - 0.7) < 1e-9


def test_no_sandbox_results():
    """无沙箱数据 → pass_rate=0。"""
    profile = synthesize_profile("t")
    assert profile.avg_pass_rate == 0.0


# ======================================================================
# 4) 难度上限映射
# ======================================================================
def test_difficulty_ceiling_high_pass_rate():
    """通过率 100% → ceiling 高（还能挑战更难的）。"""
    profile = synthesize_profile("t", sandbox_results=[True] * 10)
    assert profile.difficulty_ceiling >= 0.8


def test_difficulty_ceiling_low_pass_rate():
    """通过率 20% → ceiling 低（远超当前能力）。"""
    results = [True, True] + [False] * 8
    profile = synthesize_profile("t", sandbox_results=results)
    assert profile.difficulty_ceiling < 0.4


# ======================================================================
# 5) 校准状态
# ======================================================================
def test_is_calibrated_threshold():
    """< 3 次评测 → 未校准。"""
    evals = [
        EvalSnapshot("t1", "code", {"code_runnability": 4.0}),
        EvalSnapshot("t2", "code", {"code_runnability": 3.5}),
    ]
    profile = synthesize_profile("t", evals=evals)
    assert not profile.is_calibrated

    evals.append(EvalSnapshot("t3", "code", {"code_runnability": 4.0}))
    profile = synthesize_profile("t", evals=evals)
    assert profile.is_calibrated


# ======================================================================
# 6) frontier_dim
# ======================================================================
def test_frontier_dim_is_first_weak():
    """frontier_dim 返回 weak_dims 的第一个（最弱的）。"""
    evals = [
        EvalSnapshot("t1", "code", {"code_security": 2.0, "code_efficiency": 1.5}),
        EvalSnapshot("t2", "code", {"code_security": 2.0, "code_efficiency": 2.0}),
    ]
    profile = synthesize_profile("t", evals=evals)
    assert profile.frontier_dim == "code_efficiency"  # 最弱的


def test_frontier_dim_none_when_no_weak():
    """无弱项时 frontier_dim 为 None。"""
    evals = [
        EvalSnapshot("t1", "code", {"code_runnability": 4.5}),
        EvalSnapshot("t2", "code", {"code_runnability": 4.0}),
    ]
    profile = synthesize_profile("t", evals=evals)
    assert profile.frontier_dim is None


# ======================================================================
# 7) to_prompt_context
# ======================================================================
def test_to_prompt_context_includes_key_info():
    """序列化包含关键信息。"""
    members = [
        MemberSnapshot(agent_id="a1", job_type="code"),
        MemberSnapshot(agent_id="a2", job_type="code"),
    ]
    evals = [
        EvalSnapshot("t1", "code", {"code_runnability": 4.5, "code_security": 1.5}),
        EvalSnapshot("t2", "code", {"code_runnability": 4.0, "code_security": 2.0}),
        EvalSnapshot("t3", "code", {"code_runnability": 4.2, "code_security": 1.8}),
    ]
    profile = synthesize_profile(
        "team_1",
        description="全栈开发团队",
        members=members,
        evals=evals,
        experience_lessons=["要处理边界情况"],
        sandbox_results=[True, True, True, False],
    )
    ctx = profile.to_prompt_context()

    assert "team_1" in ctx
    assert "全栈开发团队" in ctx
    assert "code" in ctx
    assert "code_runnability" in ctx  # 强项
    assert "code_security" in ctx     # 弱项
    assert "75%" in ctx               # 通过率 3/4=75%
    assert "要处理边界情况" in ctx      # 经验


def test_to_prompt_context_empty_profile():
    """空 profile 序列化不崩。"""
    profile = synthesize_profile("empty")
    ctx = profile.to_prompt_context()
    assert "empty" in ctx
    assert "未声明" in ctx
