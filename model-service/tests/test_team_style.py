"""
model-service/tests/test_team_style.py
TeamStyleProfile 初始化的单测。

注意：维度强弱分类、通过率、难度上限等「涌现指标」不再在 team_style.py 计算，
而是由 StyleMemory（style_memory.py）通过 SPADE 反思涌现。本测试只覆盖初始画像构建。
"""
from __future__ import annotations

import pytest

from app.scoring.team_style import (
    MemberSnapshot,
    TeamStyleProfile,
    build_initial_profile,
)


# ======================================================================
# 1) 基本构建
# ======================================================================
def test_basic_build():
    """3 个成员 + 描述 → 完整 profile。"""
    members = [
        MemberSnapshot(agent_id="a1", job_type="code"),
        MemberSnapshot(agent_id="a2", job_type="code"),
        MemberSnapshot(agent_id="a3", job_type="text"),
    ]
    profile = build_initial_profile(
        "team_1",
        description="数据处理团队",
        members=members,
    )

    assert profile.team_id == "team_1"
    assert profile.primary_job_type == "code"  # 2 code vs 1 text
    assert profile.member_count == 3
    assert profile.declared_focus == "数据处理团队"
    assert profile.eval_count == 0  # 初始为零


def test_empty_data_produces_minimal_profile():
    """无成员、无描述 → 最小 profile。"""
    profile = build_initial_profile("team_empty")

    assert profile.team_id == "team_empty"
    assert profile.primary_job_type == "code"  # 默认
    assert profile.member_count == 0
    assert profile.declared_focus == ""
    assert profile.eval_count == 0
    assert profile.experience_lessons == []
    assert profile.member_snapshots == []
    assert profile.task_types_seen == []


def test_profile_with_experience_lessons():
    """经验卡片正确传递。"""
    lessons = ["处理千分位要先去掉货币符号", "CSV 空行要跳过"]
    profile = build_initial_profile(
        "t",
        experience_lessons=lessons,
    )
    assert profile.experience_lessons == lessons


def test_dominant_job_type():
    """成员数最多的 job_type 胜出。"""
    members = [
        MemberSnapshot(agent_id="a1", job_type="text"),
        MemberSnapshot(agent_id="a2", job_type="text"),
        MemberSnapshot(agent_id="a3", job_type="text"),
        MemberSnapshot(agent_id="a4", job_type="code"),
    ]
    profile = build_initial_profile("t", members=members)
    assert profile.primary_job_type == "text"


def test_no_members_defaults_to_code():
    """无成员时默认 code。"""
    profile = build_initial_profile("t", members=[])
    assert profile.primary_job_type == "code"


def test_members_without_job_type():
    """成员的 job_type 为 None 时不影响统计。"""
    members = [
        MemberSnapshot(agent_id="a1", job_type=None),
        MemberSnapshot(agent_id="a2", job_type="code"),
    ]
    profile = build_initial_profile("t", members=members)
    assert profile.primary_job_type == "code"


# ======================================================================
# 2) 字段独立性
# ======================================================================
def test_eval_count_starts_zero():
    """新建 profile 的 eval_count 为 0。"""
    profile = build_initial_profile("t")
    assert profile.eval_count == 0


def test_task_types_seen_starts_empty():
    """新建 profile 的 task_types_seen 为空。"""
    profile = build_initial_profile("t")
    assert profile.task_types_seen == []


def test_member_snapshots_stored():
    """成员快照正确保存。"""
    members = [
        MemberSnapshot(agent_id="a1", job_type="code", tasks_completed=10),
        MemberSnapshot(agent_id="a2", job_type="code", tasks_completed=5),
    ]
    profile = build_initial_profile("t", members=members)
    assert len(profile.member_snapshots) == 2
    assert profile.member_snapshots[0].tasks_completed == 10


# ======================================================================
# 3) 确认不再有旧字段（防止回退）
# ======================================================================
def test_no_strong_dims_field():
    """TeamStyleProfile 不应有 strong_dims（已移至 StyleMemory）。"""
    profile = build_initial_profile("t")
    assert not hasattr(profile, "strong_dims")


def test_no_weak_dims_field():
    """TeamStyleProfile 不应有 weak_dims（已移至 StyleMemory）。"""
    profile = build_initial_profile("t")
    assert not hasattr(profile, "weak_dims")


def test_no_difficulty_ceiling_field():
    """TeamStyleProfile 不应有 difficulty_ceiling（已移至 StyleMemory）。"""
    profile = build_initial_profile("t")
    assert not hasattr(profile, "difficulty_ceiling")


def test_no_synthesize_profile():
    """synthesize_profile 应已移除。"""
    import app.scoring.team_style as ts
    assert not hasattr(ts, "synthesize_profile")
