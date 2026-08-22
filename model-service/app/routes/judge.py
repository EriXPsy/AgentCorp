"""HR 面试 S2 评测端点（LLM-as-judge 试做题 + 对话评分）。

- GET  /api/craft-tasks   公开题库（**不含参考答案**，防刷题）
- POST /api/craft-judge   一道试做题评分：answer（A3 直传）或 candidate 引用（A2 跑题）
                          code 工种会附带真实执行验证（sandbox），产出 verifiedEvidence
- POST /api/craft-verify  只跑沙盒不评分（调试/复核用：同一份答案的执行结果可独立复现）
- POST /api/chat-judge    面试对话整段评分（C）：judge 可用 source=judge，否则降级 source=degraded

与 routes/evaluate.py 的职责边界：evaluate.py 负责跨模态评估与运行期裁判的 SSE 流；
本模块负责 HR 面试的「客观试做题」与「对话证据评分」两个新入口，全部返回 JSON。
"""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger("serve")

router = APIRouter()


class CraftJudgeRequest(BaseModel):
    """试做题评分入参：answer（A3 直传）或 candidate 引用（A2 跑题后评分）。"""

    task_id: str
    answer: Optional[str] = None
    candidate: Optional[dict] = None
    #: 是否对 code 工种执行真实沙盒验证（默认开；沙盒本身另有 SANDBOX_ENABLED 总开关）
    verify: bool = True


class CraftVerifyRequest(BaseModel):
    """只执行不评分：用于人工复核「这段代码到底能不能跑」。"""

    task_id: str = ""
    answer: str


class ChatJudgeRequest(BaseModel):
    """对话逐轮/整段评分入参（C：live 面试证据 → 模型评测，降级返回 source=degraded）。"""

    agent_id: str
    agent_name: str = ""
    transcript: str = ""
    usage: List[dict] = Field(default_factory=list)
    task: Optional[dict] = None
    #: ensemble 第几次采样。0 = 基准（温度 0，可复现）；>0 = 扰动采样
    #: （温度 JUDGE_ENSEMBLE_TEMPERATURE，模型按 JUDGE_MODELS 轮转）。
    #: 后端决定用哪个模型/温度，凭据与模型池不下发渲染层。
    variant: int = 0


@router.get("/api/craft-tasks")
def api_craft_tasks() -> list:
    """公开题库列表。安全边界：**不返回参考答案**（防刷题），只给题面/rubric/探针。"""
    from ..scoring.craft_tasks import all_task_ids, get_task

    out = []
    for tid in all_task_ids():
        task = get_task(tid)
        if task is None:
            continue
        out.append(
            {
                "id": task.id,
                "job_type": task.job_type,
                "title": task.title,
                "prompt": task.prompt,
                "target_dims": task.target_dims,
                "checkpoints": task.checkpoints,
            }
        )
    return out


@router.post("/api/craft-judge")
async def api_craft_judge(req: CraftJudgeRequest) -> dict:
    """对一道试做题评分：候选答案（A3）或 candidate 引用跑题后评分（A2）。

    流程：
    1. 获取答案（直接答案 或 跑候选）
    2. 机器验证（sandbox / security scan / text checks）
    3. LLM 裁判评分（经 JudgeRegistry 派发）
    """
    from ..candidate_runner import CandidateRunError, run_candidate
    from ..judge_backend import JudgeUnavailable
    from ..scoring.craft_tasks import get_task
    from ..scoring.evaluator_protocol import EvaluatorInput
    from ..scoring.judge_registry import get_registry

    task = get_task(req.task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"未知题目 id：{req.task_id}")

    if req.answer is not None:
        answer = req.answer
    elif req.candidate:
        try:
            answer = run_candidate(task.prompt, req.candidate).text
        except CandidateRunError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    else:
        raise HTTPException(status_code=422, detail="需提供 answer 或 candidate 引用")

    # —— 机器验证（sandbox + security scan + text checks）——
    # 与评分完全解耦：机器证据不影响裁判分数，只作为 verifiedEvidence
    # 影响 stage_scorer 的 Q6 降权（「没考到」≠「考过了」）。
    sandbox_payload = None
    verified_evidence: dict = {}
    scan_payload = None

    # 先跑 sandbox（经 registry dispatch，自动获得遥测 + 维度校验）
    gold_out = None
    gold_scores: dict = {}
    if req.verify and task.job_type == "code":
        sandbox_out = get_registry().dispatch("sandbox", EvaluatorInput(
            agent_id=req.task_id,  # sandbox 不需要 agent_id，用 task_id 代替
            job_type="code",
            task_id=task.id,
            answer=answer,
        ))
        sandbox_payload = sandbox_out.metadata
        verified_evidence = dict(sandbox_out.verified_evidence)

        # 安全扫描（经 SecurityScanEvaluator 派发，独立证据链：执行验「能不能跑」，扫描验「危不危险」）
        scan_out = get_registry().dispatch("security_scan", EvaluatorInput(
            agent_id=req.task_id,
            job_type="code",
            task_id=task.id,
            answer=answer,
        ))
        scan_payload = scan_out.metadata
        if scan_out.verified_evidence:
            verified_evidence.update(scan_out.verified_evidence)

        # 金标准校准（GoldReference）：对 code 工种按 gold 正确性客观打分，
        # 复用 sandbox runner 跑同一道金标准夹具，结果覆盖 LLM 对该维的主观分。
        try:
            gold_out = get_registry().dispatch("gold_reference", EvaluatorInput(
                agent_id=req.task_id,
                job_type="code",
                task_id=task.id,
                answer=answer,
            ))
            gold_scores = dict(gold_out.scores or {})
            if gold_out.verified_evidence:
                verified_evidence.update(gold_out.verified_evidence)
        except Exception as exc:  # noqa: BLE001 —— 校准失败不阻断主评分流程
            logger.warning("gold_reference 校准失败，降级跳过：%s", exc)
            gold_out = None
            gold_scores = {}

    elif req.verify and task.job_type in ("text", "image") and task.text_spec:
        # 文本/多模态工种：无沙箱可跑，用确定性结构校验提供机器证据。
        from ..sandbox.text_checks import check_text_answer, text_evidence_for

        text_result = check_text_answer(answer, task.text_spec)
        verified_evidence.update(text_evidence_for(task.id, text_result))

    # —— LLM 裁判评分（经 registry dispatch）——
    # 降级契约：judge 后端不可用时**不抛 503**，而是返回 200 + degraded，
    # 把已收集的机器证据（sandbox / scan / text checks）原样透出——
    # 机器证据是 judge 故障时唯一还能拿到的真实信号，不应被一并丢弃。
    # 诚实：dims 留空、confidence=0，前端据此展示「机器验证通过 / LLM 评分不可用」。
    craft_out = None
    degraded_reason = ""
    try:
        craft_out = get_registry().dispatch("craft_judge", EvaluatorInput(
            agent_id=req.task_id,
            job_type=task.job_type,
            task_id=task.id,
            answer=answer,
            verified_evidence=verified_evidence,
        ))
    except JudgeUnavailable as exc:
        degraded_reason = f"craft 评测后端不可用：{exc}"
        logger.info("craft-judge 降级：%s", degraded_reason)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if craft_out is not None and not craft_out.degraded:
        # 正常路径：完整 LLM 评分
        j_meta = craft_out.metadata or {}
        return {
            "task_id": req.task_id,
            "job_type": j_meta.get("jobType", task.job_type),
            "dims": craft_out.scores,
            "unscored_dims": j_meta.get("unscoredDims", []),
            "checkpoints": [
                {"checkpoint": k, "hit": True, "quote": v}
                for k, v in craft_out.craft_evidence.items()
            ],
            "padding_detected": j_meta.get("paddingDetected", False),
            "padding_note": j_meta.get("paddingNote", ""),
            "confidence": craft_out.confidence,
            "reference_used": j_meta.get("referenceUsed", False),
            "ttft_ms": j_meta.get("ttftMs"),
            "latency_ms": j_meta.get("latencyMs", 0),
            "backend": j_meta.get("backend", ""),
            "reasoning": craft_out.reasoning,
            "verified_evidence": verified_evidence,
            "sandbox": sandbox_payload,
            "security_scan": scan_payload,
        }

    # 降级路径：judge 不可用，诚实返回机器证据 + 空分
    reason = degraded_reason or (craft_out.degraded_reason if craft_out else "judge 不可用")
    return {
        "task_id": req.task_id,
        "job_type": task.job_type,
        "dims": {},
        "unscored_dims": [],
        "checkpoints": [],
        "padding_detected": False,
        "padding_note": "",
        "confidence": 0,
        "reference_used": False,
        "ttft_ms": None,
        "latency_ms": 0,
        "backend": "",
        "reasoning": "",
        "degraded": True,
        "degraded_reason": reason,
        "verified_evidence": verified_evidence,
        "sandbox": sandbox_payload,
        "security_scan": scan_payload,
    }

    # 从 EvaluatorOutput 重建响应（保持 API 兼容）
    j_meta = craft_out.metadata or {}
    # 金标准校准覆盖：对机器可验维度用客观 gold 分替换 LLM 主观分
    dims = dict(craft_out.scores or {})
    for _d, _v in (gold_scores or {}).items():
        dims[_d] = _v
    return {
        "task_id": req.task_id,
        "job_type": j_meta.get("jobType", task.job_type),
        "dims": dims,
        "unscored_dims": j_meta.get("unscoredDims", []),
        "checkpoints": [
            {"checkpoint": k, "hit": True, "quote": v}
            for k, v in craft_out.craft_evidence.items()
        ],
        "padding_detected": j_meta.get("paddingDetected", False),
        "padding_note": j_meta.get("paddingNote", ""),
        "confidence": craft_out.confidence,
        "reference_used": j_meta.get("referenceUsed", False),
        "ttft_ms": j_meta.get("ttftMs"),
        "latency_ms": j_meta.get("latencyMs", 0),
        "backend": j_meta.get("backend", ""),
        "reasoning": craft_out.reasoning,
        "verified_evidence": verified_evidence,
        "sandbox": sandbox_payload,
        "security_scan": scan_payload,
        "gold_calibration": (
            None
            if gold_out is None
            else {
                "evaluator_id": gold_out.evaluator_id,
                "scores": gold_scores,
                "outcome": (gold_out.metadata or {}).get("outcome"),
                "total": (gold_out.metadata or {}).get("total"),
                "passed": (gold_out.metadata or {}).get("passed"),
                "passRate": (gold_out.metadata or {}).get("passRate"),
            }
        ),
    }

@router.post("/api/craft-verify")
async def api_craft_verify(req: CraftVerifyRequest) -> dict:
    """
    只跑沙盒不评分。

    存在意义：评审现场要能独立复现「这段代码通过了几个用例」，
    而不必连带跑一次裁判推理（后者要花钱、要联网、且结果可能漂移）。
    """
    from ..sandbox import (
        run_python_answer,
        scan_python_answer,
        security_evidence_for,
        verified_evidence_for,
    )

    task_id = req.task_id or "adhoc"
    result = run_python_answer(req.answer, task_id=req.task_id)
    scan = scan_python_answer(req.answer)
    evidence = verified_evidence_for(task_id, result)
    evidence.update(security_evidence_for(task_id, scan))
    return {
        "sandbox": result.to_dict(),
        "security_scan": scan.to_dict(),
        "verified_evidence": evidence,
    }


@router.post("/api/chat-judge")
async def api_chat_judge(req: ChatJudgeRequest) -> dict:
    """
    对话逐轮/整段评分（C）。

    judge 可用 → source=judge（模型六维 + evidence）；
    judge 不可用 → source=degraded（transcript 弱信号派生，confidence=0.35），
    前端据此决定是否优先展示模型分，避免把启发式当真实评测。
    """
    from ..evaluator import (
        _build_run_prompt,
        _derive_run_radar,
        _run_radar_evidence,
        _verdict_from_radar,
        judge_available,
        parse_output,
    )
    from ..judge_backend import JudgeUnavailable, get_backend, resolve_ensemble_run
    from ..schemas import JudgeRunRequest

    jreq = JudgeRunRequest(
        agent_id=req.agent_id,
        agent_name=req.agent_name,
        transcript=req.transcript,
        usage=req.usage,
    )

    def degraded() -> dict:
        radar = _derive_run_radar(jreq)
        return {
            "source": "degraded",
            "radar": radar.model_dump(),
            "verdict": _verdict_from_radar(radar).value,
            "confidence": 0.35,
            "evidence_trace": _run_radar_evidence(jreq),
        }

    if not judge_available():
        return degraded()

    messages = [{"role": "user", "content": _build_run_prompt(jreq)}]
    # ensemble 扰动：第 0 次用温度 0 的可复现基准，之后每次换温度（并在配置了
    # 跨家族模型池时换模型）。真实重复采样才让 pass^k / 离散度审计有统计意义。
    model, temperature = resolve_ensemble_run(req.variant)
    try:
        completion = get_backend().complete(messages, temperature=temperature, model=model)
        parsed = parse_output(completion.text)
    except JudgeUnavailable:
        return degraded()
    except Exception as exc:  # noqa: BLE001 —— 解析失败按降级处理，不 500
        logger.warning("chat-judge 解析失败，降级：%s", exc)
        return degraded()

    radar = parsed["radar"]
    return {
        "source": "judge",
        "radar": radar.model_dump(),
        "verdict": parsed["verdict"].value,
        "confidence": parsed["confidence"],
        "evidence_trace": parsed["evidence_trace"],
        # 采样透明化：这一票由哪个模型、在什么温度下给出，必须可追溯。
        # 否则「跨家族交叉验证」只是一句无法核对的声明。
        "judge_model": completion.model,
        "temperature": temperature,
        "variant": req.variant,
        "ttft_ms": completion.ttft_ms,
        "latency_ms": completion.latency_ms,
        # 裁判思维链（供 metaJudge 一致性审计 / UI 展示推理过程）；未启用思考模式时为空串。
        "reasoning": completion.reasoning,
    }
