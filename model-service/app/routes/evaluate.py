"""评审端点：POST /api/evaluate 与 POST /api/evaluate-run（SSE 事件流，纯搬运自原 serve.py）。

/api/evaluate-run 的 SSE 序列：convergence_update ×N（可选）→ task_run（可选，
Task-Set 调度内嵌于此）→ 主裁判流（radar_update…）→ convergence_score（可选）。
"""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

from ..config import settings
from ..evaluator import evaluate as run_evaluate
from ..evaluator import evaluate_run as run_evaluate_run
from ..evaluator import judge_available
from ..schemas import (
    EvaluationRequest,
    JudgeRunRequest,
    to_event_dict,
)
from ..scoring.task_sets import get_task_set
from .convergence import (
    _TRACE_LOCK,
    _TRACE_STORE,
    _build_convergence_trace_from_run,
    _persist_convergence,
)

logger = logging.getLogger("serve")

router = APIRouter()


@router.post("/api/evaluate")
async def api_evaluate(req: EvaluationRequest):
    if not settings.mock and not judge_available():
        raise HTTPException(
            status_code=503,
            detail=(
                "评测后端不可用：请配置 JUDGE_BACKEND=http（含 JUDGE_BASE_URL），"
                "或在具备本机权重的环境配置 JUDGE_BACKEND=local；或设置 MOCK=true 走演示流。"
            ),
        )

    mode = "mock" if settings.mock else "auto"

    async def event_gen():
        try:
            async for ev in run_evaluate(req, mode=mode):
                yield {
                    "event": ev["type"],
                    "data": json.dumps(to_event_dict(_wrap(ev)), ensure_ascii=False),
                }
        except Exception as exc:  # noqa: BLE001
            logger.exception("/api/evaluate 事件流中断")
            yield {
                "event": "error",
                "data": json.dumps({"message": str(exc)}, ensure_ascii=False),
            }

    return EventSourceResponse(event_gen())


# 同源部署（统一算力环境 Web 形态）下的路径别名：前端统一以 /api/evaluate/run
# 调用；保留 /api/evaluate-run 兼容既有客户端（Electron Host API）。
@router.post("/api/evaluate-run")
@router.post("/api/evaluate/run")
async def api_evaluate_run(req: JudgeRunRequest):
    """
    运行期裁判端点：接收 JudgeRunInput（transcript + usage + task），
    产出与 /api/evaluate 同构的 SSE 事件流（radar_update ×6 + verdict + done）。
    无 NPU / MOCK=true 时走 Mock 派生；模型可用时走真实推理。
    """
    if not settings.mock and not judge_available():
        raise HTTPException(
            status_code=503,
            detail=(
                "评测后端不可用：请配置 JUDGE_BACKEND=http（含 JUDGE_BASE_URL），"
                "或在具备本机权重的环境配置 JUDGE_BACKEND=local；或设置 MOCK=true 走演示流。"
            ),
        )

    mode = "mock" if settings.mock else "auto"
    conv_cfg = req.convergence  # Layer3：可选收敛记录（None 则仅静默记录/不扩展）

    async def event_gen():
        eng = None
        trace = None
        if conv_cfg:  # 命中收敛字段 → 记录轨迹并发 convergence 事件
            trace, eng = _build_convergence_trace_from_run(req, conv_cfg)
            with _TRACE_LOCK:
                _TRACE_STORE[trace.run_id] = trace
            # 逐轮发 convergence_update（携带 TurnState）
            # 诚实标注：MVP 投影数据，payload 加 source/synthetic（仅加法，
            # 前端旧版消费方对未知字段安全忽略）
            for turn in trace.turns:
                turn_payload = turn.model_dump(mode="json")
                turn_payload["source"] = "projected"
                turn_payload["synthetic"] = True
                yield {
                    "event": "convergence_update",
                    "data": json.dumps(turn_payload, ensure_ascii=False),
                }
        # 可选任务集调度（向后兼容，缺省 usage_efficiency；不影响既有流程）
        task_set_id = req.task_set_id or "usage_efficiency"
        try:
            ts = get_task_set(task_set_id)
            if ts is not None:
                result = ts.run(req)
                yield {
                    "event": "task_run",
                    "data": json.dumps(result.model_dump(mode="json"), ensure_ascii=False),
                }
        except Exception as exc:  # noqa: BLE001
            logger.warning("TaskSet %s 运行失败（不影响主裁判流）：%s", task_set_id, exc)
        # 主裁判流：任何异常都兜底为 error 事件，避免 SSE 静默中断
        try:
            async for ev in run_evaluate_run(req, mode=mode):
                yield {
                    "event": ev["type"],
                    "data": json.dumps(to_event_dict(_wrap(ev)), ensure_ascii=False),
                }
        except Exception as exc:  # noqa: BLE001
            logger.exception("/api/evaluate-run 事件流中断")
            yield {
                "event": "error",
                "data": json.dumps({"message": str(exc)}, ensure_ascii=False),
            }
        if eng and trace:
            score = eng.compute_convergence_score(trace)
            persisted = _persist_convergence()
            score_payload = score.model_dump(mode="json")
            # 诚实标注：MVP 投影数据 + 落盘结果显式化（失败不再静默）
            score_payload["source"] = "projected"
            score_payload["synthetic"] = True
            score_payload["persisted"] = persisted
            yield {
                "event": "convergence_score",
                "data": json.dumps(score_payload, ensure_ascii=False),
            }

    return EventSourceResponse(event_gen())


def _wrap(ev: dict):
    """将事件 dict 包装为对应 Pydantic 模型以便序列化（枚举转字符串）。"""
    from .. import schemas as S

    mapping = {
        "radar_update": S.RadarUpdateEvent,
        "narration": S.NarrationEvent,
        "audio": S.AudioEvent,
        "verdict": S.VerdictEvent,
        "done": S.DoneEvent,
    }
    cls = mapping.get(ev["type"])
    return cls(**ev) if cls else ev
