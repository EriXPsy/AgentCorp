"""
model-service/app/scoring/team_style.py
团队初始画像：只保存用户创建团队时设定的初始数据。

为什么需要：Team 类型本身只有 id/name/description/members，但 Designer 出题
需要一个结构化的「初始画像」作为起点。本模块只承载**用户设定**的初始信息
（声明重点、成员、经验卡片），不做任何从评测/产出中合成的固定指标判断。

演化的风格理解（维度强弱、通过率、难度上限、能力前沿等）不在这里计算，
而是交给 StyleMemory（style_memory.py）通过 SPADE 风格的语义记忆 + Designer
反思来涌现。本模块只做纯数据容器（dataclass + 一个纯函数），不碰网络、不碰 LLM。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


# ======================================================================
# TeamStyleProfile — 团队初始画像
# ======================================================================
@dataclass
class MemberSnapshot:
    """单个成员的能力快照（从 RoutingCandidate 投影）。"""
    agent_id: str
    job_type: Optional[str] = None        # "code" / "text" / "image"
    radar: Optional[Dict[str, float]] = None  # 6 维 {dim: 0-5}
    tasks_completed: int = 0
    approval_rate: float = 0.0
    avg_rounds: float = 0.0


@dataclass
class EvalSnapshot:
    """一次 craft 评测结果的快照。"""
    task_id: str
    job_type: str
    dim_scores: Dict[str, float]       # {dim: 0-5}
    passed_sandbox: Optional[bool] = None  # None = 未跑沙箱


@dataclass
class TeamStyleProfile:
    """团队初始画像——Designer 出题的起点。

    本结构只承载用户设定：声明重点、主攻方向、成员、经验卡片，以及一些
    累积元数据（评测次数、做过的题型）。所有「擅长/薄弱/通过率/难度上限」
    等涌现指标不在此处，由 StyleMemory 在运行中通过反思维护。
    """

    team_id: str

    # ---- 用户初始设定 ----
    declared_focus: str = ""            # Team.description
    primary_job_type: str = "code"      # 成员 jobType 众数
    member_count: int = 0

    # ---- 用户设定 / 历史积累 ----
    experience_lessons: List[str] = field(default_factory=list)  # 经验卡片摘要
    member_snapshots: List[MemberSnapshot] = field(default_factory=list)

    # ---- 元数据 ----
    eval_count: int = 0                 # 累积评测次数
    task_types_seen: List[str] = field(default_factory=list)  # 做过的题型


# ======================================================================
# 纯函数：构建初始 profile
# ======================================================================
def build_initial_profile(
    team_id: str,
    *,
    description: str = "",
    members: Optional[List[MemberSnapshot]] = None,
    experience_lessons: Optional[List[str]] = None,
) -> TeamStyleProfile:
    """构建团队初始画像（仅用户设定，不含评测数据）。"""
    members = members or []
    primary = "code"
    if members:
        counts: Dict[str, int] = {}
        for m in members:
            if m.job_type:
                counts[m.job_type] = counts.get(m.job_type, 0) + 1
        if counts:
            primary = max(counts, key=counts.get)
    return TeamStyleProfile(
        team_id=team_id,
        declared_focus=description,
        primary_job_type=primary,
        member_count=len(members),
        experience_lessons=experience_lessons or [],
        member_snapshots=members,
    )
