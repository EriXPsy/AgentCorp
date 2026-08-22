"""
model-service/tests/test_arena.py

Arena 后端单测：
1. elo.py 纯函数 —— expected/update/clamp/subjective_actual/objective_actual/update_pair
2. arena_templates —— 确定性 + 工种分支 + 空需求报错
3. arena_judge —— prompt 构造、解析铁律（越界维丢弃、hit 需 quote、fit）
4. 端点（TestClient + mock judge）—— compare 幂等去重、user-pick 双轨 Elo、
   409 重复 pick、422 非法值、404 未知 match、503 judge 不可用

运行：python -m pytest tests/test_arena.py -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from app.scoring import elo  # noqa: E402
from app.scoring import arena_judge, arena_templates  # noqa: E402
from app.scoring.arena_judge import (  # noqa: E402
    build_arena_messages,
    judge_pairwise,
    judge_pairwise_robust,
    objective_total,
    parse_arena_output,
    parse_pairwise_output,
)


# ----------------------------------------------------------------------
# 1) elo.py 纯函数
# ----------------------------------------------------------------------
def test_expected_symmetric_and_bounded():
    assert elo.expected(1000, 1000) == pytest.approx(0.5)
    assert elo.expected(1200, 1000) > 0.5
    assert elo.expected(1000, 1200) < 0.5
    assert 0 < elo.expected(3000, 100) < 1


def test_update_moves_toward_actual():
    # 高 rating 对低 rating 输了（actual=0），rating 下降
    new = elo.update(1200, elo.expected(1200, 1000), 0.0, elo.SUBJECTIVE_K)
    assert new < 1200
    # 赢了上升
    new2 = elo.update(1000, elo.expected(1000, 1200), 1.0, elo.SUBJECTIVE_K)
    assert new2 > 1000


def test_clamp_rating_bounds():
    assert elo.clamp_rating(50) == elo.MIN_RATING
    assert elo.clamp_rating(5000) == elo.MAX_RATING
    assert elo.clamp_rating(1500) == 1500


def test_subjective_actual_mapping():
    assert elo.subjective_actual("a1", "a1", "a2") == 1.0
    assert elo.subjective_actual("a2", "a1", "a2") == 0.0
    assert elo.subjective_actual("draw", "a1", "a2") == 0.5
    assert elo.subjective_actual("none", "a1", "a2") is None
    assert elo.subjective_actual("unknown", "a1", "a2") is None


def test_objective_actual_score():
    # 分差大 → 胜率接近 1；分差 0 → 0.5；分差小 → 不硬判
    assert elo.objective_actual(5.0, 1.0) > 0.9
    assert elo.objective_actual(2.5, 2.5) == pytest.approx(0.5)
    assert elo.objective_actual(3.0, 2.8) < 0.6


def test_update_pair_keeps_sum_delta_zero():
    r_a, r_b = 1000.0, 1000.0
    new_a, new_b = elo.update_pair(r_a, r_b, 1.0, elo.SUBJECTIVE_K)
    assert (new_a - r_a) + (new_b - r_b) == pytest.approx(0.0)
    assert new_a > r_a
    assert new_b < r_b


def test_update_pair_draw_small_movement():
    r_a, r_b = 1000.0, 1000.0
    new_a, new_b = elo.update_pair(r_a, r_b, 0.5, elo.SUBJECTIVE_K)
    assert new_a == pytest.approx(1000.0)
    assert new_b == pytest.approx(1000.0)


def test_apply_user_weight():
    assert elo.apply_user_weight(16.0, 1.0) == 16.0
    assert elo.apply_user_weight(16.0, 0.5) == 8.0
    # 防御：0 权重视为 1.0
    assert elo.apply_user_weight(16.0, 0.0) == 16.0


def test_resolve_winner():
    assert elo.resolve_winner("a1", {"a1": 1.0, "a2": 2.0}) == "a1"
    assert elo.resolve_winner("draw", {"a1": 1.0, "a2": 2.0}) == "draw"
    assert elo.resolve_winner("none", {"a1": 1.0, "a2": 2.0}) is None
    assert elo.resolve_winner("zzz", {"a1": 1.0, "a2": 2.0}) is None


# ----------------------------------------------------------------------
# 2) arena_templates 确定性
# ----------------------------------------------------------------------
def test_build_task_prompt_deterministic():
    a = arena_templates.build_task_prompt("要一个稳定的后端 agent", "code")
    b = arena_templates.build_task_prompt("要一个稳定的后端 agent", "code")
    assert a == b
    assert "要一个稳定的后端 agent" in a
    assert "核心代码/伪代码" in a


def test_build_task_prompt_per_job():
    text_prompt = arena_templates.build_task_prompt("写一段种草文案", "text")
    image_prompt = arena_templates.build_task_prompt("做一张海报", "image")
    assert "文案初稿" in text_prompt
    assert "构图/色板/光线" in image_prompt


def test_build_task_prompt_rejects_empty():
    with pytest.raises(ValueError):
        arena_templates.build_task_prompt("  ", "code")


def test_build_task_prompt_rejects_unknown_job():
    with pytest.raises(ValueError):
        arena_templates.build_task_prompt("x", "ops")


# ----------------------------------------------------------------------
# 3) arena_judge 解析铁律
# ----------------------------------------------------------------------
def test_build_arena_messages_no_reference_anchor():
    msgs = build_arena_messages("需求", "题面", "code", "答案")
    assert msgs[0]["role"] == "system"
    # 不包含 craft_judge 的参考答案锚定规则（「若题面附有【参考答案】…满分基准」）
    assert "满分基准" not in msgs[0]["content"]
    assert "【参考答案（人工验证的满分基准" not in msgs[0]["content"]
    assert "fit" in msgs[1]["content"]


def test_parse_arena_output_drops_out_of_range_dims():
    raw = (
        '{"dims": {"code_runnability": 4.0, "hack_dim": 5.0}, '
        '"checkpoints": [{"checkpoint": "c1", "hit": true, "quote": "原文"}], '
        '"padding": {"detected": false, "note": ""}, "fit": 3.5, "confidence": 0.8}'
    )
    out = parse_arena_output(raw, "code")
    assert out["dims"] == {"code_runnability": 4.0}
    assert "hack_dim" not in out["dims"]


def test_parse_arena_output_hit_requires_quote():
    raw = (
        '{"dims": {"code_runnability": 4.0}, '
        '"checkpoints": [{"checkpoint": "c1", "hit": true, "quote": ""}], '
        '"padding": {"detected": false, "note": ""}, "fit": 3.5, "confidence": 0.8}'
    )
    out = parse_arena_output(raw, "code")
    assert out["checkpoints"][0]["hit"] is False


def test_parse_arena_output_fit_and_unscored():
    raw = (
        '{"dims": {"code_runnability": 4.0}, "checkpoints": [], '
        '"padding": {"detected": true, "note": "空话"}, "fit": 2.0, "confidence": 0.7}'
    )
    out = parse_arena_output(raw, "code")
    assert out["fit"] == 2.0
    assert out["padding_detected"] is True
    assert "code_efficiency" in out["unscored_dims"]


def test_objective_total_weighted():
    judgement = {"dims": {"code_runnability": 4.0, "code_efficiency": 5.0}, "fit": 3.0}
    total = objective_total(judgement)
    # 0.6 * 4.5 + 0.4 * 3.0 = 2.7 + 1.2 = 3.9
    assert total == pytest.approx(3.9)


# ----------------------------------------------------------------------
# 4) 端点（TestClient + mock judge）
# ----------------------------------------------------------------------
def _client():
    from fastapi.testclient import TestClient

    from app.serve import app

    return TestClient(app)


@pytest.fixture()
def mock_judge(monkeypatch):
    """把 arena_judge.judge_arena_answer 替换为确定性假裁判（避免真实推理）。"""

    def fake_judge(requirement_text, task_prompt, job_type, answer):
        dims = {d: 4.0 for d in _dims_for(job_type)}
        return {
            "dims": dims,
            "unscored_dims": [],
            "checkpoints": [{"checkpoint": "c1", "hit": True, "quote": answer[:20]}],
            "padding_detected": False,
            "padding_note": "",
            "fit": 3.5,
            "confidence": 0.9,
            "backend": "mock",
            "ttft_ms": 1.0,
            "latency_ms": 2.0,
            "objective_total": 4.0,
        }

    monkeypatch.setattr(arena_judge, "judge_arena_answer", fake_judge)
    # 清空进程内状态，避免用例间污染
    from app.routes import arena as arena_route

    arena_route._MATCHES.clear()
    arena_route._SUBJECTIVE_RATINGS.clear()
    arena_route._OBJECTIVE_RATINGS.clear()
    arena_route._DAILY_PARTICIPATION.clear()


def _dims_for(job_type: str):
    return {
        "code": ["code_runnability", "code_efficiency", "code_test_coverage", "code_maintainability", "code_security"],
        "text": ["txt_factuality", "txt_coherence", "txt_tone_fit", "txt_info_density", "txt_instruction_follow"],
        "image": ["img_composition", "img_style_fit", "img_fidelity", "img_aesthetic_consistency", "img_multimodal_follow"],
    }[job_type]


def _compare_payload():
    return {
        "requirementText": "要一个稳定的后端 agent",
        "jobType": "code",
        "candidates": [
            {"agentId": "a1", "agentName": "甲", "channel": "text", "answer": "我会写稳定代码和测试"},
            {"agentId": "a2", "agentName": "乙", "channel": "text", "answer": "我会做后端 API 和文档"},
        ],
    }


def test_compare_returns_pending_match(mock_judge):
    resp = _client().post("/api/arena/compare", json=_compare_payload())
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "pending"
    assert body["userPick"] is None
    assert body["matchId"].startswith("am-")
    assert body["objectiveLeader"] in ("a1", "a2")
    assert len(body["candidates"]) == 2
    assert body["candidates"][0]["objectiveTotal"] == 4.0
    assert "judgement" in body["candidates"][0]


def test_compare_idempotent_same_requirement_and_candidates(mock_judge):
    client = _client()
    first = client.post("/api/arena/compare", json=_compare_payload()).json()
    second = client.post("/api/arena/compare", json=_compare_payload()).json()
    assert first["matchId"] == second["matchId"]
    assert second["status"] == "pending"


def test_compare_422_empty_requirement(mock_judge):
    payload = _compare_payload()
    payload["requirementText"] = "  "
    resp = _client().post("/api/arena/compare", json=payload)
    assert resp.status_code == 422


def test_compare_422_unknown_job(mock_judge):
    payload = _compare_payload()
    payload["jobType"] = "ops"
    resp = _client().post("/api/arena/compare", json=payload)
    assert resp.status_code == 422


def test_compare_422_single_candidate(mock_judge):
    payload = _compare_payload()
    payload["candidates"] = [payload["candidates"][0]]
    resp = _client().post("/api/arena/compare", json=payload)
    assert resp.status_code == 422


def test_compare_502_run_failure(monkeypatch):
    from app.candidate_runner import CandidateRunError

    def fail_run(task_prompt, candidate):
        raise CandidateRunError("text 通道需要 candidate.answer 非空")

    monkeypatch.setattr("app.routes.arena.run_candidate", fail_run)
    payload = _compare_payload()
    payload["candidates"][0].pop("answer")
    resp = _client().post("/api/arena/compare", json=payload)
    assert resp.status_code == 502


def test_compare_404_unknown_channel(mock_judge):
    """契约 §1.3：候选通道未知 → 404（区别于调用失败 502）。"""
    payload = _compare_payload()
    payload["candidates"][0]["channel"] = "nope"
    resp = _client().post("/api/arena/compare", json=payload)
    assert resp.status_code == 404
    assert "候选通道未知/不支持" in resp.json()["detail"]


def test_compare_404_unknown_channel_any_candidate(mock_judge):
    """任一候选通道非法即 404（即便其余候选合法）。"""
    payload = _compare_payload()
    payload["candidates"][1]["channel"] = "ftp"
    resp = _client().post("/api/arena/compare", json=payload)
    assert resp.status_code == 404


def test_compare_404_unknown_channel_uppercase_normalized(mock_judge):
    """通道名校验与 candidate_runner 一致：先小写再比对白名单。"""
    payload = _compare_payload()
    payload["candidates"][0]["channel"] = "TEXT"
    resp = _client().post("/api/arena/compare", json=payload)
    assert resp.status_code == 200


def test_compare_503_judge_unavailable(monkeypatch):
    from app.judge_backend import JudgeUnavailable
    from app.routes import arena as arena_route

    # 本用例不依赖 mock_judge fixture（需要覆盖 judge），需自清进程内状态，
    # 避免前面 mock_judge 用例遗留的 pending match 触发幂等去重（200）。
    arena_route._MATCHES.clear()
    arena_route._SUBJECTIVE_RATINGS.clear()
    arena_route._OBJECTIVE_RATINGS.clear()
    arena_route._DAILY_PARTICIPATION.clear()

    def unavailable(*args, **kwargs):
        raise JudgeUnavailable("后端不可用")

    monkeypatch.setattr(arena_judge, "judge_arena_answer", unavailable)
    resp = _client().post("/api/arena/compare", json=_compare_payload())
    assert resp.status_code == 503


def test_user_pick_updates_elo_and_ratings(mock_judge):
    client = _client()
    match = client.post("/api/arena/compare", json=_compare_payload()).json()
    resp = client.post(
        "/api/arena/user-pick", json={"matchId": match["matchId"], "pick": "a1"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "picked"
    assert body["userPick"] == "a1"
    assert body["winner"] == "a1"
    assert body["eloDelta"]["a1"] > 0
    assert body["eloDelta"]["a2"] < 0
    assert body["subjectiveRatings"]["a1"] == pytest.approx(
        1000.0 + body["eloDelta"]["a1"]
    )
    assert body["objectiveRatings"]["a1"] > 0


def test_user_pick_draw_symmetric(mock_judge):
    client = _client()
    match = client.post("/api/arena/compare", json=_compare_payload()).json()
    resp = client.post(
        "/api/arena/user-pick", json={"matchId": match["matchId"], "pick": "draw"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["winner"] == "draw"
    # 平局主观 Elo 双方小幅变化（互为相反数）
    assert body["eloDelta"]["a1"] == pytest.approx(-body["eloDelta"]["a2"])


def test_user_pick_none_no_elo(mock_judge):
    client = _client()
    match = client.post("/api/arena/compare", json=_compare_payload()).json()
    resp = client.post(
        "/api/arena/user-pick", json={"matchId": match["matchId"], "pick": "none"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "abandoned"
    assert body["winner"] is None
    assert body["eloDelta"] == {}


def test_user_pick_409_duplicate(mock_judge):
    client = _client()
    match = client.post("/api/arena/compare", json=_compare_payload()).json()
    first = client.post(
        "/api/arena/user-pick", json={"matchId": match["matchId"], "pick": "a1"}
    )
    assert first.status_code == 200
    second = client.post(
        "/api/arena/user-pick", json={"matchId": match["matchId"], "pick": "a2"}
    )
    assert second.status_code == 409


def test_user_pick_404_unknown_match(mock_judge):
    resp = _client().post("/api/arena/user-pick", json={"matchId": "nope", "pick": "a1"})
    assert resp.status_code == 404


def test_user_pick_422_invalid_pick(mock_judge):
    client = _client()
    match = client.post("/api/arena/compare", json=_compare_payload()).json()
    resp = client.post(
        "/api/arena/user-pick", json={"matchId": match["matchId"], "pick": "zzz"}
    )
    assert resp.status_code == 422


# ----------------------------------------------------------------------
# 5) pairwise 鲁棒比较（位置 swap 消位置偏差）
# ----------------------------------------------------------------------
def test_parse_pairwise_output_normalizes_winner():
    assert parse_pairwise_output('{"winner": "a", "confidence": 0.7}')["winner"] == "A"
    assert parse_pairwise_output('{"winner": "b"}')["winner"] == "B"
    assert parse_pairwise_output('{"winner": "TIE"}')["winner"] == "TIE"
    # 脏值回退到 tie，confidence 夹到 [0,1]
    bad = parse_pairwise_output('{"winner": "maybe", "confidence": 9}')
    assert bad["winner"] == "TIE"
    assert bad["confidence"] == 1.0


def test_pairwise_robust_consistent_picks_stronger(monkeypatch):
    """answer_a 更好：原序判 A、交换序判 B（a 在 B 位），两次映射到同一实际候选 → 一致。"""

    def fake_pairwise(_req, _tp, _job, answer_a, _answer_b):
        # 谁排在前面（answer_a 参数位）就判谁赢 → 模拟「始终判实际更强的 a」
        return {"winner": "A", "confidence": 0.9, "reasoning": "a 更强"}

    monkeypatch.setattr(arena_judge, "judge_pairwise", fake_pairwise)
    # a 更好：fake 始终判参数位 A。r1(a,b)→A；r2(b,a)→A（b 在参数位 A）。
    # 映射：r1 A(未swap)→first(a)；r2 A(swap)→second(b)。→ 反转 → uncertain。
    # 所以「始终判参数位 A」其实是位置偏差。换成「判实际内容更强」的 fake：
    def fake_by_content(_req, _tp, _job, answer_a, answer_b):
        winner = "A" if "STRONG" in answer_a else "B"
        return {"winner": winner, "confidence": 0.85, "reasoning": "内容更强"}

    monkeypatch.setattr(arena_judge, "judge_pairwise", fake_by_content)
    res = arena_judge.judge_pairwise_robust("需求", "题面", "code", "STRONG 方案", "普通 方案")
    assert res["winner"] == "first"
    assert res["consistent"] is True
    assert res["position_bias"] is False
    assert res["confidence"] == pytest.approx(0.85)


def test_pairwise_robust_detects_position_bias(monkeypatch):
    """两次都判「呈现序首位 A」→ 位置偏差，结论降级为 uncertain。"""

    def always_a(_req, _tp, _job, _a, _b):
        return {"winner": "A", "confidence": 0.9, "reasoning": ""}

    monkeypatch.setattr(arena_judge, "judge_pairwise", always_a)
    res = arena_judge.judge_pairwise_robust("需求", "题面", "code", "甲", "乙")
    assert res["position_bias"] is True
    assert res["winner"] == "uncertain"
    assert res["consistent"] is False


def test_pairwise_robust_tie(monkeypatch):
    def always_tie(_req, _tp, _job, _a, _b):
        return {"winner": "TIE", "confidence": 0.6, "reasoning": "相当"}

    monkeypatch.setattr(arena_judge, "judge_pairwise", always_tie)
    res = arena_judge.judge_pairwise_robust("需求", "题面", "code", "甲", "乙")
    assert res["winner"] == "tie"
    assert res["consistent"] is False


def test_compare_two_candidates_populates_pairwise(mock_judge, monkeypatch):
    """双候选 compare 应产出 pairwise 字段，winner_agent_id 映射到实际 agent。"""

    def fake_pairwise(_req, _tp, _job, answer_a, _answer_b):
        winner = "A" if "稳定" in answer_a else "B"
        return {"winner": winner, "confidence": 0.8, "reasoning": "更贴合需求"}

    monkeypatch.setattr(arena_judge, "judge_pairwise", fake_pairwise)
    payload = _compare_payload()
    # a1 答案含「稳定」→ 原序判 A、交换序判 B，两次映射到 a1 → 一致
    body = _client().post("/api/arena/compare", json=payload).json()
    assert body["pairwise"] is not None
    # pairwise 是 dict 透传字段，键不做驼峰（与 judgement.objective_total 同口径）
    assert body["pairwise"]["winner_agent_id"] == "a1"
    assert body["pairwise"]["position_bias"] is False


def test_compare_degrades_when_judge_unavailable(mock_judge, monkeypatch):
    """judge 不可用时 pairwise 降级为 None，但对决本身仍成功（mock_judge 保绝对分）。"""
    from app.judge_backend import JudgeUnavailable

    def raise_unavailable(*_a, **_k):
        raise JudgeUnavailable("no backend")

    monkeypatch.setattr(arena_judge, "judge_pairwise_robust", raise_unavailable)
    body = _client().post("/api/arena/compare", json=_compare_payload()).json()
    assert body["status"] == "pending"
    assert body["pairwise"] is None
