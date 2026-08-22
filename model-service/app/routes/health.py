"""健康检查端点：GET /health（纯搬运自原 serve.py）。"""
from __future__ import annotations

import logging

from fastapi import APIRouter

from ..config import settings
from ..evaluator import judge_available
from ..model_loader import get_model

logger = logging.getLogger("serve")

router = APIRouter()


@router.get("/health")
def health() -> dict:
    model = get_model()
    return {
        "status": "ok",
        "mock": settings.mock,
        "model_available": model.available,
        "judge_available": judge_available(),
        "judge_backend": settings.judge_backend,
    }


@router.get("/api/registry/status")
def registry_status() -> dict:
    """JudgeRegistry 状态：已注册 Evaluator + 运行遥测。"""
    from ..scoring.judge_registry import get_registry
    reg = get_registry()
    return {
        "evaluators": reg.list_ids(),
        "stats": reg.stats(),
    }
