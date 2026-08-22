"""成长历程 + 企业适配端点。

GET  /api/growth/{agent_id}           → 成长轨迹报告
POST /api/enterprise-fit/{agent_id}   → 企业适配分析
"""
from __future__ import annotations

import logging
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..scoring.evaluator_protocol import EvaluatorInput
from ..scoring.judge_registry import get_registry
from ._common import datetime_now_iso

logger = logging.getLogger("serve")

router = APIRouter()

# ======================================================================
# 进程内存储（零新增依赖）：
#   _RADAR_HISTORY[agentId] = list[dict]   历次六维雷达分（按时间升序）
#   _STAGE_SCORES[agentId]  = list[dict]   历次阶段评分卡
# ======================================================================
_RADAR_HISTORY: Dict[str, List[dict]] = {}
_STAGE_SCORES_STORE: Dict[str, List[dict]] = {}


def _ensure_agent(agent_id: str) -> None:
    """校验 agent 存在；不存在则 404。"""
    if agent_id not in _RADAR_HISTORY and agent_id not in _STAGE_SCORES_STORE:
        raise HTTPException(status_code=404, detail=f"agent '{agent_id}' not found")


# ======================================================================
# 请求 / 响应 schema
# ======================================================================
class RadarHistoryEntry(BaseModel):
    """六维雷达分（一次评估的六个维度分数）。"""
    task: float = 0.0
    quality: float = 0.0
    comm: float = 0.0
    creativity: float = 0.0
    reliability: float = 0.0
    cost: float = 0.0


class AppendRadarRequest(BaseModel):
    """追加一条雷达历史（供内部调用 / 测试）。"""
    model_config = {"populate_by_name": True}
    radar: RadarHistoryEntry


class AppendStageRequest(BaseModel):
    """追加一条阶段评分卡（供内部调用 / 测试）。"""
    model_config = {"populate_by_name": True}
    stage: str = ""
    job_type: str = "code"
    objective: Dict[str, float] = Field(default_factory=dict)
    subjective: Dict[str, float] = Field(default_factory=dict)
    craft_evidence: Dict[str, str] = Field(default_factory=dict)
    verified_evidence: Dict[str, str] = Field(default_factory=dict)
    scored_by: str = "owner"


class EnterpriseFitRequest(BaseModel):
    """POST /api/enterprise-fit/{agent_id} 入参。"""
    model_config = {"populate_by_name": True}
    job_type: str = "code"
    radar_scores: RadarHistoryEntry = Field(default_factory=RadarHistoryEntry)
    craft_scores: Dict[str, float] = Field(default_factory=dict)
    enterprise_weights: Optional[Dict[str, float]] = None
    radar_requirements: Optional[Dict[str, float]] = None
    craft_requirements: Optional[Dict[str, float]] = None


# ======================================================================
# 端点
# ======================================================================
@router.post("/api/growth/{agent_id}/radar")
async def append_radar(agent_id: str, body: AppendRadarRequest):
    """追加一条雷达历史记录（供上游评分卡落库后调用）。"""
    _RADAR_HISTORY.setdefault(agent_id, []).append(body.radar.model_dump())
    return {"ok": True, "count": len(_RADAR_HISTORY[agent_id])}


@router.post("/api/growth/{agent_id}/stage")
async def append_stage(agent_id: str, body: AppendStageRequest):
    """追加一条阶段评分卡记录。"""
    _STAGE_SCORES_STORE.setdefault(agent_id, []).append({
        "stage": body.stage,
        "jobType": body.job_type,
        "objective": body.objective,
        "subjective": body.subjective,
        "craftEvidence": body.craft_evidence,
        "verifiedEvidence": body.verified_evidence,
        "scoredBy": body.scored_by,
        "ts": datetime_now_iso(),
    })
    return {"ok": True, "count": len(_STAGE_SCORES_STORE[agent_id])}


@router.get("/api/growth/{agent_id}")
async def get_growth(agent_id: str, job_type: str = "code"):
    """查询 agent 的成长轨迹报告。"""
    radar_history = _RADAR_HISTORY.get(agent_id, [])
    stage_scores = _STAGE_SCORES_STORE.get(agent_id, [])

    out = get_registry().dispatch("growth", EvaluatorInput(
        agent_id=agent_id,
        job_type=job_type,
        options={
            "radar_history": radar_history,
            "stage_scores": stage_scores,
        },
    ))
    return out.metadata


@router.post("/api/enterprise-fit/{agent_id}")
async def post_enterprise_fit(agent_id: str, body: EnterpriseFitRequest):
    """计算 agent 对某企业的适配度。"""
    out = get_registry().dispatch("enterprise_fit", EvaluatorInput(
        agent_id=agent_id,
        job_type=body.job_type,
        radar_scores=body.radar_scores.model_dump(),
        craft_scores=body.craft_scores,
        options={
            "enterprise_weights": body.enterprise_weights,
            "radar_requirements": body.radar_requirements,
            "craft_requirements": body.craft_requirements,
        },
    ))
    return out.metadata


@router.get("/api/growth/health")
async def growth_health():
    """健康检查：确认成长引擎可用。"""
    return {"status": "ok", "agents_tracked": len(_RADAR_HISTORY)}
