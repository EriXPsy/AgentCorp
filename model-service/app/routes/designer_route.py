"""
model-service/app/routes/designer_route.py
SPADE Designer 路由：自适应出题 + 反思回写。

流程（事件驱动，实时演进）：
  POST /api/designer/challenge → 读取 StyleMemory → Designer 出题 → 返回题目
  POST /api/designer/reflect   → 读取 StyleMemory → Reflector 反思 → 更新记忆 → 返回观察

每次 reflect 后，Designer 的语义理解就会更新，下次出题自动读取最新记忆。
无需轮询、无需批处理——跟着团队成长，记忆也在成长。

持久化：
  StyleMemory 文件存储在 data/style_memory/{team_id}.json。
  内存缓存加速频繁读写，文件存储保证跨会话保留。
"""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..judge_backend import JudgeUnavailable
from ..scoring.designer import design_challenge
from ..scoring.team_style import TeamStyleProfile, build_initial_profile
from ..scoring.style_memory import AgentMemory, AgentReflector, Reflector, StyleMemory

logger = logging.getLogger("designer_route")

router = APIRouter(prefix="/api/designer", tags=["designer"])

# ---------------------------------------------------------------------------
# 持久化存储：内存缓存 + 文件存储
# ---------------------------------------------------------------------------
_MEMORY_DIR = Path(
    os.environ.get(
        "STYLE_MEMORY_DIR",
        str(Path(__file__).resolve().parent.parent.parent / "data" / "style_memory"),
    )
)
_memory_store: Dict[str, StyleMemory] = {}
_store_lock = threading.Lock()


def _ensure_dir() -> None:
    """确保存储目录存在。"""
    _MEMORY_DIR.mkdir(parents=True, exist_ok=True)


def _memory_path(team_id: str) -> Path:
    """团队 StyleMemory 的文件路径。"""
    # 清理 team_id 中的不安全字符
    safe_id = "".join(c if c.isalnum() or c in "-_." else "_" for c in team_id)
    return _MEMORY_DIR / f"{safe_id}.json"


def _load_memory(team_id: str) -> Optional[StyleMemory]:
    """读取团队的 StyleMemory；先查内存缓存，再查文件。"""
    # 内存缓存命中
    if team_id in _memory_store:
        return _memory_store[team_id]

    # 从文件加载
    path = _memory_path(team_id)
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            memory = StyleMemory.from_dict(data)
            _memory_store[team_id] = memory
            logger.debug("Loaded StyleMemory from file: %s", path)
            return memory
        except Exception as exc:
            logger.warning("Failed to load StyleMemory from %s: %s", path, exc)

    return None


def _save_memory(memory: StyleMemory) -> None:
    """持久化团队的 StyleMemory（内存 + 文件）。"""
    with _store_lock:
        _memory_store[memory.team_id] = memory
        _ensure_dir()
        path = _memory_path(memory.team_id)
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(memory.to_dict(), f, ensure_ascii=False, indent=2)
            logger.debug("Saved StyleMemory to file: %s", path)
        except Exception as exc:
            logger.error("Failed to save StyleMemory to %s: %s", path, exc)


# ---------------------------------------------------------------------------
# Agent 级别持久化（独立于团队）
# ---------------------------------------------------------------------------

_AGENT_MEMORY_DIR = _MEMORY_DIR / "agents"
_agent_memory_store: Dict[str, "AgentMemory"] = {}
_agent_store_lock = threading.Lock()


def _agent_memory_path(agent_id: str) -> Path:
    safe_id = "".join(c if c.isalnum() or c in "-_." else "_" for c in agent_id)
    return _AGENT_MEMORY_DIR / f"{safe_id}.json"


def _load_agent_memory(agent_id: str) -> Optional["AgentMemory"]:
    if agent_id in _agent_memory_store:
        return _agent_memory_store[agent_id]
    path = _agent_memory_path(agent_id)
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            memory = AgentMemory.from_dict(data)
            _agent_memory_store[agent_id] = memory
            return memory
        except Exception as exc:
            logger.warning("Failed to load AgentMemory from %s: %s", path, exc)
    return None


def _save_agent_memory(memory: "AgentMemory") -> None:
    with _agent_store_lock:
        _agent_memory_store[memory.agent_id] = memory
        _AGENT_MEMORY_DIR.mkdir(parents=True, exist_ok=True)
        path = _agent_memory_path(memory.agent_id)
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(memory.to_dict(), f, ensure_ascii=False, indent=2)
        except Exception as exc:
            logger.error("Failed to save AgentMemory to %s: %s", path, exc)


def _memory_to_profile(memory: StyleMemory) -> TeamStyleProfile:
    """从 StyleMemory 构建 minimal TeamStyleProfile，供 Designer 出题用。

    将语义记忆中的涌现信息喂回 Designer，让它基于「理解」而非固定指标出题。
    """
    # 从 performance_log 估算通过率
    outcomes = [p.get("outcome", "") for p in memory.performance_log if p.get("outcome")]
    pass_count = sum(1 for o in outcomes if o == "passed")
    pass_rate = pass_count / len(outcomes) if outcomes else 0.0

    return TeamStyleProfile(
        team_id=memory.team_id,
        declared_focus=memory.current_understanding,  # 用涌现理解替代用户声明
        primary_job_type="code",  # 目前只支持 code；后续可从 memory 推断
        member_count=0,           # route 层不直接知道成员数
        eval_count=memory.reflection_count,
        task_types_seen=list(memory.challenges_issued),
        # 将语义信息塞进 experience_lessons（Designer 会消费它）
        experience_lessons=[
            memory.current_understanding,
            memory.next_challenge_hypothesis,
        ] if memory.current_understanding else [],
    )


# ---------------------------------------------------------------------------
# 请求/响应模型
# ---------------------------------------------------------------------------
class ChallengeRequest(BaseModel):
    team_id: str = Field(..., description="团队 ID")
    job_type: str = Field("code", description="工种")
    description: str = Field("", description="团队描述（首次出题时用）")
    member_count: int = Field(0, description="成员数量")


class ChallengeResponse(BaseModel):
    task_id: str
    title: str
    prompt: str
    target_dims: List[str]
    checkpoints: List[str]
    difficulty: float
    design_rationale: str


class ReflectRequest(BaseModel):
    team_id: str = Field(..., description="团队 ID")
    task_id: str = Field(..., description="被反思的题目 ID")
    answer: str = Field(..., description="团队提交的代码")
    scores: Dict[str, float] = Field(default_factory=dict, description="LLM 裁判分数")
    outcome: str = Field("unknown", description="沙箱结果: passed/failed/timeout/oom/error")


class ReflectResponse(BaseModel):
    observation: str = Field(..., description="本次反思的新观察")
    reflection_count: int = Field(..., description="累计反思次数")
    current_understanding: str = Field(..., description="当前综合理解")
    next_hypothesis: str = Field(..., description="Designer 认为下一步该挑战什么")


# ── Agent 级别请求/响应模型 ──────────────────────────────────────────

class AgentReflectRequest(BaseModel):
    agent_id: str = Field(..., description="Agent ID")
    team_id: str = Field(..., description="所属团队 ID")
    task_id: str = Field(..., description="任务 ID")
    answer: str = Field(..., description="Agent 提交的代码")
    scores: Dict[str, float] = Field(default_factory=dict)
    outcome: str = Field("unknown")


class AgentReflectResponse(BaseModel):
    agent_id: str
    observation: str
    submission_count: int
    pass_rate: float
    strengths: List[str]
    weaknesses: List[str]
    growth_summary: str


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------
@router.post("/challenge", response_model=ChallengeResponse)
async def create_challenge(req: ChallengeRequest) -> ChallengeResponse:
    """生成一道自适应题目。

    读取团队的 StyleMemory，让 Designer 基于当前理解出题。
    如果是首次调用，创建一个空的 StyleMemory。
    """
    # 读取或初始化 StyleMemory
    memory = _load_memory(req.team_id)
    if memory is None:
        memory = StyleMemory(team_id=req.team_id)

    # 从记忆构建 profile
    profile = _memory_to_profile(memory)
    if req.description and not memory.current_understanding:
        profile.declared_focus = req.description
    if req.member_count:
        profile.member_count = req.member_count

    # Designer 出题
    try:
        challenge = design_challenge(profile, validate=False)
    except JudgeUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Designer LLM 不可用：{exc}",
        ) from exc

    if not challenge.task.prompt:
        raise HTTPException(
            status_code=502,
            detail="Designer 输出了无效题目",
        )

    # 记录已出题
    if challenge.task.id not in memory.challenges_issued:
        memory.challenges_issued.append(challenge.task.id)
    _save_memory(memory)

    logger.info(
        "Designer 出题: team=%s task=%s difficulty=%.2f",
        req.team_id, challenge.task.id, challenge.difficulty,
    )

    return ChallengeResponse(
        task_id=challenge.task.id,
        title=challenge.task.title,
        prompt=challenge.task.prompt,
        target_dims=challenge.task.target_dims,
        checkpoints=challenge.task.checkpoints,
        difficulty=challenge.difficulty,
        design_rationale=challenge.design_rationale,
    )


@router.post("/reflect", response_model=ReflectResponse)
async def reflect_on_submission(req: ReflectRequest) -> ReflectResponse:
    """对团队提交进行反思，更新 StyleMemory。

    每次 craft 评测完成后调用，Designer 会观察代码、写一条观察、
    定期合成综合理解。下次出题时自动读取最新记忆。
    """
    memory = _load_memory(req.team_id)
    if memory is None:
        raise HTTPException(
            status_code=404,
            detail=f"团队 {req.team_id} 的 StyleMemory 不存在，请先调用 /challenge",
        )

    reflector = Reflector()
    updated = reflector.reflect(
        task_prompt=req.task_id,
        answer=req.answer,
        scores=req.scores,
        outcome=req.outcome,
        memory=memory,
        task_id=req.task_id,
    )
    _save_memory(updated)

    latest_obs = updated.observations[-1] if updated.observations else ""

    logger.info(
        "Designer 反思: team=%s task=%s count=%d",
        req.team_id, req.task_id, updated.reflection_count,
    )

    return ReflectResponse(
        observation=latest_obs,
        reflection_count=updated.reflection_count,
        current_understanding=updated.current_understanding,
        next_hypothesis=updated.next_challenge_hypothesis,
    )


@router.get("/memory/{team_id}")
async def get_memory(team_id: str) -> Dict[str, Any]:
    """查看团队的 StyleMemory（调试/展示用）。"""
    memory = _load_memory(team_id)
    if memory is None:
        raise HTTPException(
            status_code=404,
            detail=f"团队 {team_id} 的 StyleMemory 不存在",
        )
    return memory.to_dict()


# ---------------------------------------------------------------------------
# Agent 级别路由：个人成长追踪
# ---------------------------------------------------------------------------

@router.post("/agent-reflect", response_model=AgentReflectResponse)
async def reflect_on_agent(req: AgentReflectRequest) -> AgentReflectResponse:
    """对单个 Agent 的提交进行反思，更新其个人成长档案。

    与团队反思不同：只记录个体观察和分数轨迹，不做 synthesis/prompt 进化。
    """
    memory = _load_agent_memory(req.agent_id)
    if memory is None:
        memory = AgentMemory(agent_id=req.agent_id, team_id=req.team_id)

    reflector = AgentReflector()
    updated = reflector.reflect(
        agent_id=req.agent_id,
        team_id=req.team_id,
        task_prompt=req.task_id,
        answer=req.answer,
        scores=req.scores,
        outcome=req.outcome,
        memory=memory,
    )
    _save_agent_memory(updated)

    latest_obs = updated.observations[-1] if updated.observations else ""

    logger.info(
        "Agent 反思: agent=%s team=%s submissions=%d pass_rate=%.0f%%",
        req.agent_id, req.team_id, updated.submission_count, updated.pass_rate * 100,
    )

    return AgentReflectResponse(
        agent_id=req.agent_id,
        observation=latest_obs,
        submission_count=updated.submission_count,
        pass_rate=round(updated.pass_rate, 3),
        strengths=updated.strengths,
        weaknesses=updated.weaknesses,
        growth_summary=updated.growth_summary,
    )


@router.get("/agent-memory/{agent_id}")
async def get_agent_memory(agent_id: str) -> Dict[str, Any]:
    """查看单个 Agent 的成长档案。"""
    memory = _load_agent_memory(agent_id)
    if memory is None:
        raise HTTPException(
            status_code=404,
            detail=f"Agent {agent_id} 的成长档案不存在",
        )
    return memory.to_dict()


@router.get("/agent-memory/team/{team_id}")
async def get_team_agents_memory(team_id: str) -> Dict[str, Any]:
    """查看一个团队下所有 Agent 的成长档案汇总。"""
    _AGENT_MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    agents = {}
    for path in _AGENT_MEMORY_DIR.glob("*.json"):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("team_id") == team_id:
                agent_id = data["agent_id"]
                agents[agent_id] = {
                    "submission_count": data.get("submission_count", 0),
                    "pass_rate": data.get("pass_rate", 0),
                    "strengths": data.get("strengths", []),
                    "weaknesses": data.get("weaknesses", []),
                    "growth_summary": data.get("growth_summary", ""),
                }
        except Exception as exc:
            logger.warning("Failed to read agent memory %s: %s", path, exc)

    return {"team_id": team_id, "agents": agents, "count": len(agents)}
