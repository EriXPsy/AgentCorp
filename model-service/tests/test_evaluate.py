"""
model-service/tests/test_evaluate.py
验证评估契约与 user_fit 计算（不依赖真实模型。

运行（在 model-service 目录下）：
    pip install pytest
    MOCK=true python -m pytest tests/ -q
或（在无 NPU 环境，默认 auto 也会走 Mock）：
    python -m pytest tests/ -q
"""
from __future__ import annotations

import asyncio
import os
import sys

import pytest

# 让测试能 import app 包
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.evaluator import compute_user_fit, evaluate, parse_output  # noqa: E402
from app.schemas import (  # noqa: E402
    CandidateProfile,
    EvaluationRequest,
    RadarScore,
    UserPreference,
    Verdict,
)


def _collect(req: EvaluationRequest, mode: str = "mock") -> list:
    return [ev for ev in asyncio.run(_gen(req, mode))]


async def _gen(req: EvaluationRequest, mode: str) -> list:
    out = []
    async for ev in evaluate(req, mode=mode):
        out.append(ev)
    return out


def test_compute_user_fit_perfect():
    radar = RadarScore(
        task=5, quality=5, comm=5, creativity=5, reliability=5, cost=5
    )
    pref = UserPreference()  # 默认权重 + 中立审美 + 预算 200
    fit, evidence = compute_user_fit(
        radar, pref, declared_budget=100, declared_tags=["React"], inferred_aesthetic="neutral"
    )
    assert fit == 100.0, f"满分应得 100%，实际 {fit}"
    assert any("技术栈" in e for e in evidence)


def test_budget_overrun_zeros_cost():
    radar = RadarScore(
        task=5, quality=5, comm=5, creativity=5, reliability=5, cost=5
    )
    pref = UserPreference(budget_max=50)
    fit, evidence = compute_user_fit(
        radar, pref, declared_budget=200, declared_tags=[], inferred_aesthetic="neutral"
    )
    # 超预算 → cost 权重清零 → 低于满分
    assert fit < 100.0
    assert any("预算" in e for e in evidence)


def test_aesthetic_mismatch_penalty():
    radar = RadarScore(
        task=5, quality=5, comm=5, creativity=5, reliability=5, cost=5
    )
    pref = UserPreference(aesthetic=UserPreference().aesthetic.__class__("minimal"))
    fit, evidence = compute_user_fit(
        radar, pref, declared_budget=100, declared_tags=[], inferred_aesthetic="rich"
    )
    assert any("不符" in e for e in evidence)
    assert fit < 100.0


def test_parse_output_json_block():
    raw = (
        "```json\n"
        '{"radar":{"task":4,"quality":3,"comm":2,"creativity":5,"reliability":4,'
        '"cost":3},"verdict":"MVP","confidence":0.9,'
        '"evidence_trace":["a","b"],"narration":"x","audio_script":"y"}\n```'
    )
    data = parse_output(raw)
    assert data["radar"].task == 4.0
    assert data["verdict"] == Verdict.MVP
    assert data["confidence"] == 0.9
    assert len(data["evidence_trace"]) == 2


def test_parse_output_plain_json_no_fence():
    """无 ```json 代码块包裹的裸 JSON 也能解析（异常输入健壮性）"""
    raw = (
        '{"radar":{"task":3,"quality":4,"comm":2,"creativity":1,"reliability":5,'
        '"cost":2},"verdict":"OBSERVE","confidence":0.8,'
        '"evidence_trace":["x"],"narration":"n","audio_script":"a"}'
    )
    data = parse_output(raw)
    assert data["radar"].reliability == 5.0
    assert data["radar"].task == 3.0
    assert data["verdict"] == Verdict.OBSERVE
    assert data["confidence"] == 0.8


def test_parse_output_partial_radar_defaults():
    """radar 字段缺失时回落到 0.0（不崩）"""
    raw = '{"verdict":"FIRED","confidence":0.5}'
    data = parse_output(raw)
    assert data["radar"].task == 0.0
    assert data["radar"].cost == 0.0
    assert data["verdict"] == Verdict.FIRED


def test_parse_output_invalid_raises_value_error():
    """完全非 JSON / 空串输入应抛 ValueError（上层捕获，不静默崩溃）"""
    with pytest.raises(ValueError):
        parse_output("模型产出了一堆废话，没有任何 JSON 结构")
    with pytest.raises(ValueError):
        parse_output("")
    with pytest.raises(ValueError):
        parse_output("```json\n不是合法 json\n```")


def test_evaluate_stream_schema():
    cand = CandidateProfile(
        id="candidate-01",
        name="琳达",
        declared_budget=180,
        declared_tags=["React", "UI"],
    )
    pref = UserPreference()
    req = EvaluationRequest(candidate=cand, preference=pref)
    events = _collect(req, mode="mock")

    types = [e["type"] for e in events]
    assert "radar_update" in types
    assert "narration" in types
    assert "audio" in types
    assert "verdict" in types
    assert "done" in types

    # 六维逐维点亮
    radar_dims = [e["dim"] for e in events if e["type"] == "radar_update"]
    assert set(radar_dims) == {
        "task",
        "quality",
        "comm",
        "creativity",
        "reliability",
        "cost",
    }

    # verdict 字段校验
    verdict_ev = [e for e in events if e["type"] == "verdict"][0]
    assert verdict_ev["verdict"] == "MVP"
    assert 0 <= verdict_ev["user_fit"] <= 100
    assert isinstance(verdict_ev["evidence_trace"], list)

    # done 事件含 evaluation_id
    done_ev = [e for e in events if e["type"] == "done"][0]
    assert done_ev["evaluation_id"]


def test_evaluate_unknown_candidate_fallback():
    cand = CandidateProfile(id="upload-xyz", name="临时", declared_budget=120, declared_tags=[])
    pref = UserPreference()
    req = EvaluationRequest(candidate=cand, preference=pref)
    events = _collect(req, mode="mock")
    assert any(e["type"] == "verdict" for e in events)


# ======================================================================
# 以下为 /api/evaluate 与 /api/evaluate-run HTTP 端点契约补测。
# 既有用例只打到 evaluator 生成器（mode="mock"），从未经 TestClient 走 HTTP 层，
# 因此 422 输入校验、503 judge 不可用硬拒、正常 SSE 返回结构三个分支全缺。
# 本段补上这三块；mock 裁判走 conftest 默认 MOCK=true（不触达模型/网络）。
# ======================================================================
import json  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

from app.config import settings  # noqa: E402
from app.routes import evaluate as evaluate_routes  # noqa: E402
from app.serve import app  # noqa: E402


def _client() -> TestClient:
    return TestClient(app)


def _eval_payload(candidate_id: str = "candidate-01") -> dict:
    """最小可用的 /api/evaluate 载荷（candidate 必填 id；preference 可空）。"""
    return {
        "candidate": {"id": candidate_id, "name": "琳达", "declared_budget": 180},
        "preference": {},
    }


def _run_payload(agent_id: str = "agent-eval-http") -> dict:
    """最小可用的 /api/evaluate-run 载荷（agent_id 必填，camelCase 别名）。"""
    return {
        "agentId": agent_id,
        "agentName": "琳达",
        "task": {"title": "Build dashboard", "description": "d", "weight": 1.0},
        "transcript": "user: build a chart\nagent: done",
        "usage": [
            {
                "timestamp": "2025-01-01T00:00:00Z",
                "sessionId": "sess-1",
                "agentId": agent_id,
                "inputTokens": 1000,
                "outputTokens": 500,
                "totalTokens": 1500,
                "costUsd": 0.0,
            }
        ],
    }


def _parse_sse(resp) -> tuple:
    """把 TestClient.stream 响应解析为 (event_names, data_dicts)。

    事件序列形如 ``event: radar_update\\ndata: {...}\\n\\n``。
    """
    events: list = []
    payloads: list = []
    for raw in resp.iter_lines():
        line = raw if isinstance(raw, str) else raw.decode("utf-8")
        if line.startswith("event:"):
            events.append(line.split(":", 1)[1].strip())
        elif line.startswith("data:"):
            blob = line.split(":", 1)[1].strip()
            if blob.startswith("{"):
                payloads.append(json.loads(blob))
    return events, payloads


# ----------------------------------------------------------------------
# 1) 输入校验：缺必填字段 → 422（FastAPI/Pydantic 层）
# ----------------------------------------------------------------------
def test_evaluate_422_missing_candidate():
    """缺 candidate / preference → 422，而非进事件流。"""
    resp = _client().post("/api/evaluate", json={})
    assert resp.status_code == 422
    # Pydantic 报错定位在 candidate 字段
    locs = [tuple(e["loc"]) for e in resp.json()["detail"]]
    assert any("candidate" in loc for loc in locs)


def test_evaluate_run_422_missing_agent_id():
    """JudgeRunRequest.agent_id 必填（camelCase agentId）；缺之 → 422。"""
    resp = _client().post("/api/evaluate-run", json={"agentName": "无名氏"})
    assert resp.status_code == 422
    locs = [e["loc"] for e in resp.json()["detail"]]
    # 别名校验字段落点与 camelCase 别名对应
    assert any("agentId" in l or "agent_id" in l for l in locs)


def test_evaluate_accepts_snake_case_alias():
    """向后兼容：缺省路径时 snake_case（agent_id）亦被接受，不报 422。"""
    body = {
        "agent_id": "agent-snake-ok",
        "agent_name": "蛇形",
        "transcript": "user: hi",
    }
    resp = _client().post("/api/evaluate-run", json=body)
    assert resp.status_code == 200


# ----------------------------------------------------------------------
# 2) judge 不可用降级：非 mock + judge_available()=False → 503 硬拒
# ----------------------------------------------------------------------
def test_evaluate_503_when_judge_unavailable(monkeypatch):
    """非 mock 且 judge 不可用 → 503（不启动 SSE，文案提示 JUDGE_BACKEND/MOCK）。"""
    monkeypatch.setattr(settings, "mock", False)
    monkeypatch.setattr(evaluate_routes, "judge_available", lambda: False)

    resp = _client().post("/api/evaluate", json=_eval_payload())
    assert resp.status_code == 503
    detail = resp.json().get("detail", "")
    assert "JUDGE_BACKEND" in detail
    assert "MOCK=true" in detail


def test_evaluate_run_503_when_judge_unavailable(monkeypatch):
    """/api/evaluate-run 与 /api/evaluate 同构：503 硬拒，不启动 SSE。"""
    monkeypatch.setattr(settings, "mock", False)
    monkeypatch.setattr(evaluate_routes, "judge_available", lambda: False)

    resp = _client().post("/api/evaluate-run", json=_run_payload())
    assert resp.status_code == 503
    detail = resp.json().get("detail", "")
    assert "JUDGE_BACKEND" in detail


# ----------------------------------------------------------------------
# 3) 正常路径返回结构（MOCK=true 走演示流，产出完整 SSE 序列）
# ----------------------------------------------------------------------
def test_evaluate_normal_path_sse_structure():
    """POST /api/evaluate 正常返回：200 SSE，含 radar_update×6 + verdict + done。"""
    # conftest 默认 MOCK=true → mock 分支放行，不触达模型；此处锁定该前提。
    assert settings.mock is True

    client = _client()
    with client.stream("POST", "/api/evaluate", json=_eval_payload()) as resp:
        assert resp.status_code == 200
        events, payloads = _parse_sse(resp)

    radar = [e for e in events if e == "radar_update"]
    assert len(radar) == 6, f"六维雷达应恰好 6 个，实际 {len(radar)}"
    assert "verdict" in events
    assert "done" in events

    # verdict 载荷结构
    verdict_obj = next(p for p in payloads if "user_fit" in p)
    assert verdict_obj["verdict"] in {"MVP", "OBSERVE", "FIRED"}
    assert 0.0 <= verdict_obj["user_fit"] <= 100.0
    assert isinstance(verdict_obj["evidence_trace"], list)

    # done 载荷含 evaluation_id
    done_obj = next(p for p in payloads if "evaluation_id" in p)
    assert done_obj["evaluation_id"]


def test_evaluate_run_normal_path_sse_structure():
    """POST /api/evaluate-run 正常返回：200 SSE，含 task_run(可选) + radar×6 + verdict + done。"""
    client = _client()
    with client.stream("POST", "/api/evaluate-run", json=_run_payload()) as resp:
        assert resp.status_code == 200
        events, payloads = _parse_sse(resp)

    radar = [e for e in events if e == "radar_update"]
    assert len(radar) == 6, f"六维雷达应恰好 6 个，实际 {len(radar)}"
    assert "verdict" in events
    assert "done" in events

    # verdict 结构
    verdict_obj = next(p for p in payloads if "user_fit" in p)
    assert verdict_obj["verdict"] in {"MVP", "OBSERVE", "FIRED"}
    assert 0.0 <= verdict_obj["user_fit"] <= 100.0

    done_obj = next(p for p in payloads if "evaluation_id" in p)
    assert done_obj["evaluation_id"]


if __name__ == "__main__":
    # 简易直接运行入口（python tests/test_evaluate.py）
    for name in dir():
        if name.startswith("test_"):
            globals()[name]()
    print("tests/test_evaluate.py 全部通过 ✅")
