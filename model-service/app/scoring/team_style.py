"""
model-service/app/scoring/team_style.py
团队风格画像：从散落的原始数据合成结构化 profile，供 Designer 消费。

为什么需要：Team 类型本身只有 id/name/description/members，但「风格」是
一个涌现属性——成员的 jobType 分布、radar 强弱维、历史评测分、经验卡片、
沙箱通过率，合起来才说得清「这个团队擅长什么、薄弱在哪里、喜欢什么模式」。

本模块只做纯数据聚合（dataclass + 纯函数），不碰网络、不碰 LLM。
Designer（designer.py）消费这个 profile 生成自适应题目。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


# ======================================================================
# TeamStyleProfile — 团队风格画像
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
    """团队风格画像——Designer 的唯一输入。

    两个来源：
    1. 用户设定（declared_focus / primary_job_type）—— 初始画像
    2. 工作产出（strong_dims / weak_dims / pass_rate / patterns）—— 长出来的
    """

    team_id: str

    # ---- 用户初始设定 ----
    declared_focus: str = ""            # Team.description
    primary_job_type: str = "code"      # 成员 jobType 众数
    member_count: int = 0

    # ---- 从实际表现中长出来的 ----
    strong_dims: List[str] = field(default_factory=list)   # 稳定高分的维度
    weak_dims: List[str] = field(default_factory=list)      # 稳定低分的维度（能力前沿）
    avg_pass_rate: float = 0.0                             # 沙箱夹具通过率 0-1
    difficulty_ceiling: float = 0.0                       # 当前稳定通过的最高难度 0-1
    experience_lessons: List[str] = field(default_factory=list)  # 经验卡片摘要
    member_snapshots: List[MemberSnapshot] = field(default_factory=list)

    # ---- 元数据 ----
    eval_count: int = 0                 # 累积评测次数（profile 可信度）
    task_types_seen: List[str] = field(default_factory=list)  # 做过的题型

    @property
    def is_calibrated(self) -> bool:
        """profile 是否有足够数据支撑自适应出题（至少 3 次评测）。"""
        return self.eval_count >= 3

    @property
    def frontier_dim(self) -> Optional[str]:
        """能力前沿维度：weak_dims 里第一个，Designer 优先出这类题。"""
        return self.weak_dims[0] if self.weak_dims else None

    def to_prompt_context(self) -> str:
        """序列化为 Designer LLM 可读的上下文字符串。"""
        lines = [
            f"团队 ID：{self.team_id}",
            f"主攻方向：{self.primary_job_type}",
            f"声明重点：{self.declared_focus or '（未声明）'}",
            f"成员数：{self.member_count}",
            f"累积评测次数：{self.eval_count}",
        ]
        if self.strong_dims:
            lines.append(f"擅长维度：{', '.join(self.strong_dims)}")
        if self.weak_dims:
            lines.append(f"薄弱维度：{', '.join(self.weak_dims)}")
        if self.avg_pass_rate > 0:
            lines.append(f"沙箱通过率：{self.avg_pass_rate:.0%}")
        if self.difficulty_ceiling > 0:
            lines.append(f"难度上限：{self.difficulty_ceiling:.1f}/1.0")
        if self.task_types_seen:
            lines.append(f"做过的题型：{', '.join(self.task_types_seen)}")
        if self.experience_lessons:
            lines.append("团队经验：")
            for lesson in self.experience_lessons[:5]:
                lines.append(f"  - {lesson}")
        return "\n".join(lines)


# ======================================================================
# 纯函数：从原始数据合成 profile
# ======================================================================
def _dominant_job_type(members: List[MemberSnapshot]) -> str:
    """成员 jobType 的众数（无数据时默认 code）。"""
    counts: Dict[str, int] = {}
    for m in members:
        if m.job_type:
            counts[m.job_type] = counts.get(m.job_type, 0) + 1
    if not counts:
        return "code"
    return max(counts, key=counts.get)  # type: ignore[arg-type]


def _aggregate_dim_scores(evals: List[EvalSnapshot]) -> Dict[str, List[float]]:
    """按维度聚合所有评测分（供强弱判断）。"""
    dim_scores: Dict[str, List[float]] = {}
    for ev in evals:
        for dim, score in ev.dim_scores.items():
            dim_scores.setdefault(dim, []).append(score)
    return dim_scores


def _classify_dims(
    dim_scores: Dict[str, List[float]],
    strong_threshold: float = 3.5,
    weak_threshold: float = 2.5,
) -> tuple[List[str], List[str]]:
    """把维度分为强/弱两类。

    强：均分 >= strong_threshold 且至少 2 次采样
    弱：均分 < weak_threshold 且至少 1 次采样
    中间的不分类（既不强也不弱，Designer 不优先出这类题）。
    """
    strong: List[str] = []
    weak: List[str] = []
    for dim, scores in dim_scores.items():
        avg = sum(scores) / len(scores)
        if avg >= strong_threshold and len(scores) >= 2:
            strong.append(dim)
        elif avg < weak_threshold:
            weak.append(dim)
    # 弱维按均分升序排（最弱的在前 = 最优先出题）
    weak.sort(key=lambda d: sum(dim_scores[d]) / len(dim_scores[d]))
    strong.sort(key=lambda d: -sum(dim_scores[d]) / len(dim_scores[d]))
    return strong, weak


def synthesize_profile(
    team_id: str,
    *,
    description: str = "",
    members: Optional[List[MemberSnapshot]] = None,
    evals: Optional[List[EvalSnapshot]] = None,
    experience_lessons: Optional[List[str]] = None,
    sandbox_results: Optional[List[bool]] = None,
) -> TeamStyleProfile:
    """从原始数据合成团队风格画像（纯函数，无 I/O）。

    Args:
        team_id: 团队 ID
        description: 用户创建的团队描述
        members: 成员快照列表
        evals: 历史 craft 评测结果
        experience_lessons: 经验卡片文本列表
        sandbox_results: 沙箱通过/失败序列（True=pass, False=fail）

    Returns:
        TeamStyleProfile — 可能 is_calibrated=False（数据不足时）
    """
    members = members or []
    evals = evals or []
    experience_lessons = experience_lessons or []
    sandbox_results = sandbox_results or []

    # 主攻方向
    primary_job = _dominant_job_type(members)

    # 维度强弱
    dim_scores = _aggregate_dim_scores(evals)
    strong, weak = _classify_dims(dim_scores)

    # 沙箱通过率
    pass_rate = (
        sum(1 for r in sandbox_results if r) / len(sandbox_results)
        if sandbox_results
        else 0.0
    )

    # 难度上限：简化为通过率的倒数映射
    # 通过率 100% → ceiling 0.8（还能挑战更难的）
    # 通过率 50%  → ceiling 0.4（当前难度已是边界）
    # 通过率 0%   → ceiling 0.1（远超当前能力）
    if not sandbox_results:
        ceiling = 0.0
    else:
        ceiling = min(0.9, pass_rate * 0.8 + 0.1)

    # 做过的题型
    task_types_seen = list(dict.fromkeys(ev.task_id for ev in evals))

    return TeamStyleProfile(
        team_id=team_id,
        declared_focus=description,
        primary_job_type=primary_job,
        member_count=len(members),
        strong_dims=strong,
        weak_dims=weak,
        avg_pass_rate=pass_rate,
        difficulty_ceiling=ceiling,
        experience_lessons=experience_lessons,
        member_snapshots=members,
        eval_count=len(evals),
        task_types_seen=task_types_seen,
    )
