"""
model-service/tests/test_leaderboard.py

Leaderboard 端点单测（TestClient + 直注 _STAGE_STORE）：
- 客观榜按分降序、rank 从 1 开始
- tier 分级（MVP / NORMAL / BOTTOM）
- 主观榜拖拽序 + dragRank 与 objectiveRank 的发散计算
- 空输入回退 mock
- 响应结构完整性

设计说明：排序、rank 编号、tier 分级、delta 计算等核心逻辑
全部通过端点测试覆盖（注入 _STAGE_STORE → GET /api/leaderboard →
断言响应字段），无需单独写测试 Python 内置 sorted()/enumerate()
的纯逻辑用例——那测的是语言本身，不是我们的代码。

运行：python -m pytest tests/test_leaderboard.py -q
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from app.routes import leaderboard as lb_route  # noqa: E402


# ----------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------
def _client():
    from fastapi.testclient import TestClient
    from app.serve import app
    return TestClient(app)


def _inject_stage_scores(stage, job_type, agents):
    """直接向 _STAGE_STORE 注入 StageScore dict（绕过 POST 端点的 judge 门禁）。"""
    store = lb_route._STAGE_STORE.setdefault(stage, {}).setdefault(job_type, {})
    for aid, obj_score, sub_score in agents:
        store[aid] = {
            "agentId": aid,
            "stage": stage,
            "jobType": job_type,
            "objectiveScore": obj_score,
            "subjectiveScore": sub_score,
            "total": obj_score,
            "verdict": "MVP" if obj_score >= 78 else ("OBSERVE" if obj_score >= 50 else "FIRED"),
        }


def _clear_store():
    lb_route._STAGE_STORE.clear()


# ----------------------------------------------------------------------
# 端点测试（TestClient + 直注 _STAGE_STORE）
#
# 排序、rank 编号、tier 分级、delta 计算等核心逻辑全部通过端点覆盖，
# 不单独写测试 Python 内置函数的纯逻辑用例。
# ----------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _clean_store():
    """每个用例前后清空 _STAGE_STORE，避免进程内状态泄漏。"""
    _clear_store()
    yield
    _clear_store()


class TestEndpointObjectiveRanking:
    """GET /api/leaderboard 客观榜。"""

    def test_objective_sorted_by_score_descending(self):
        _inject_stage_scores("S1", "code", [
            ("agent-b", 74.5, 72.0),
            ("agent-a", 82.0, 80.0),
            ("agent-c", 61.0, 65.0),
        ])
        resp = _client().get("/api/leaderboard", params={"stage": "S1"})
        assert resp.status_code == 200
        obj = resp.json()["objective"]
        scores = [e["objectiveScore"] for e in obj]
        assert scores == sorted(scores, reverse=True)
        assert [e["agentId"] for e in obj] == ["agent-a", "agent-b", "agent-c"]

    def test_rank_starts_at_one(self):
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
            ("agent-b", 74.5, 72.0),
        ])
        resp = _client().get("/api/leaderboard", params={"stage": "S1"})
        ranks = [e["rank"] for e in resp.json()["objective"]]
        assert ranks == [1, 2]

    def test_tier_mvp_for_rank_one(self):
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
            ("agent-b", 74.5, 72.0),
            ("agent-c", 61.0, 65.0),
        ])
        resp = _client().get("/api/leaderboard", params={"stage": "S1"})
        assert resp.json()["objective"][0]["tier"] == "MVP"

    def test_tier_bottom_for_last_rank(self):
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
            ("agent-b", 74.5, 72.0),
            ("agent-c", 61.0, 65.0),
        ])
        resp = _client().get("/api/leaderboard", params={"stage": "S1"})
        assert resp.json()["objective"][-1]["tier"] == "BOTTOM"

    def test_tier_normal_for_middle(self):
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
            ("agent-b", 74.5, 72.0),
            ("agent-c", 61.0, 65.0),
        ])
        resp = _client().get("/api/leaderboard", params={"stage": "S1"})
        assert resp.json()["objective"][1]["tier"] == "NORMAL"

    def test_two_entries_second_is_bottom(self):
        """两条目时第二条也是 BOTTOM（rank == len）。"""
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
            ("agent-b", 74.5, 72.0),
        ])
        resp = _client().get("/api/leaderboard", params={"stage": "S1"})
        obj = resp.json()["objective"]
        assert obj[0]["tier"] == "MVP"
        assert obj[1]["tier"] == "BOTTOM"

    def test_single_entry_is_mvp(self):
        """单条目：rank==1 优先，tier=MVP。"""
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
        ])
        resp = _client().get("/api/leaderboard", params={"stage": "S1"})
        obj = resp.json()["objective"]
        assert len(obj) == 1
        assert obj[0]["rank"] == 1
        assert obj[0]["tier"] == "MVP"


class TestEndpointSubjectiveAndDivergence:
    """主观榜拖拽序 + 发散计算。"""

    def test_divergence_on_full_reverse(self):
        """完全倒序 [a,b,c]→[c,b,a]：agent-b 恰在中位不动，a/c 发散。"""
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
            ("agent-b", 74.5, 72.0),
            ("agent-c", 61.0, 65.0),
        ])
        drag_order = json.dumps(["agent-c", "agent-b", "agent-a"])
        resp = _client().get("/api/leaderboard", params={
            "stage": "S1",
            "subjective": drag_order,
        })
        body = resp.json()
        divs = {d["agentId"]: d for d in body["divergences"]}
        assert len(divs) == 2
        # agent-c: obj=3 → drag=1, delta=-2
        assert divs["agent-c"]["objectiveRank"] == 3
        assert divs["agent-c"]["dragRank"] == 1
        assert divs["agent-c"]["delta"] == -2
        # agent-b: obj=2 → drag=2, delta=0 → 不应在 divergences 中
        assert "agent-b" not in divs
        # agent-a: obj=1 → drag=3, delta=2
        assert divs["agent-a"]["objectiveRank"] == 1
        assert divs["agent-a"]["dragRank"] == 3
        assert divs["agent-a"]["delta"] == 2

    def test_no_divergence_when_same_order(self):
        """主观序 == 客观序 → 无 divergence。"""
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
            ("agent-b", 74.5, 72.0),
            ("agent-c", 61.0, 65.0),
        ])
        drag_order = json.dumps(["agent-a", "agent-b", "agent-c"])
        resp = _client().get("/api/leaderboard", params={
            "stage": "S1",
            "subjective": drag_order,
        })
        assert resp.json()["divergences"] == []

    def test_delta_always_equals_drag_minus_objective(self):
        """delta = dragRank - objectiveRank 对每个 divergence 成立。"""
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
            ("agent-b", 74.5, 72.0),
            ("agent-c", 61.0, 65.0),
        ])
        drag_order = json.dumps(["agent-c", "agent-a", "agent-b"])
        resp = _client().get("/api/leaderboard", params={
            "stage": "S1",
            "subjective": drag_order,
        })
        for d in resp.json()["divergences"]:
            assert d["delta"] == d["dragRank"] - d["objectiveRank"]

    def test_subjective_default_equals_objective_order(self):
        """不传 subjective 时，主观榜默认=客观序，dragRank==objectiveRank。"""
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
            ("agent-b", 74.5, 72.0),
            ("agent-c", 61.0, 65.0),
        ])
        resp = _client().get("/api/leaderboard", params={"stage": "S1"})
        body = resp.json()
        sub_ids = [s["agentId"] for s in body["subjective"]]
        obj_ids = [o["agentId"] for o in body["objective"]]
        assert sub_ids == obj_ids
        for s in body["subjective"]:
            assert s["dragRank"] == s["objectiveRank"]
        assert body["divergences"] == []

    def test_subjective_score_propagated(self):
        """subjectiveScore 正确传递到主观榜条目。"""
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
            ("agent-b", 74.5, 72.0),
            ("agent-c", 61.0, 65.0),
        ])
        resp = _client().get("/api/leaderboard", params={"stage": "S1"})
        sub = {s["agentId"]: s for s in resp.json()["subjective"]}
        assert sub["agent-a"]["subjectiveScore"] == 80.0
        assert sub["agent-b"]["subjectiveScore"] == 72.0
        assert sub["agent-c"]["subjectiveScore"] == 65.0

    def test_invalid_subjective_json_ignored(self):
        """subjective 非法 JSON → 静默回退客观序。"""
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
            ("agent-b", 74.5, 72.0),
        ])
        resp = _client().get("/api/leaderboard", params={
            "stage": "S1",
            "subjective": "not-valid-json",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert [s["agentId"] for s in body["subjective"]] == ["agent-a", "agent-b"]
        assert body["divergences"] == []

    def test_subjective_with_unknown_agent_filtered(self):
        """subjective 含未知 agent → 过滤掉，其余正常。"""
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
            ("agent-b", 74.5, 72.0),
        ])
        drag_order = json.dumps(["agent-b", "ghost-agent", "agent-a"])
        resp = _client().get("/api/leaderboard", params={
            "stage": "S1",
            "subjective": drag_order,
        })
        body = resp.json()
        sub_ids = [s["agentId"] for s in body["subjective"]]
        assert "ghost-agent" not in sub_ids
        assert set(sub_ids) == {"agent-a", "agent-b"}

    def test_partial_swap_two_of_three(self):
        """只交换前两名，第三名不变 → 两个 divergence。"""
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
            ("agent-b", 74.5, 72.0),
            ("agent-c", 61.0, 65.0),
        ])
        drag_order = json.dumps(["agent-b", "agent-a", "agent-c"])
        resp = _client().get("/api/leaderboard", params={
            "stage": "S1",
            "subjective": drag_order,
        })
        body = resp.json()
        divs = {d["agentId"]: d for d in body["divergences"]}
        assert len(divs) == 2
        assert "agent-c" not in divs  # 没动
        assert divs["agent-a"]["objectiveRank"] == 1
        assert divs["agent-a"]["dragRank"] == 2
        assert divs["agent-a"]["delta"] == 1
        assert divs["agent-b"]["objectiveRank"] == 2
        assert divs["agent-b"]["dragRank"] == 1
        assert divs["agent-b"]["delta"] == -1


class TestEndpointEmptyAndMock:
    """空输入 / mock 回退。"""

    def test_empty_store_falls_back_to_mock(self):
        """无 _STAGE_STORE 数据 → 回退 mock 三条目。"""
        resp = _client().get("/api/leaderboard", params={"stage": "S1"})
        assert resp.status_code == 200
        obj = resp.json()["objective"]
        assert len(obj) == 3
        assert obj[0]["agentId"] == "agent-a"
        assert obj[0]["objectiveScore"] == 82.0
        assert obj[0]["rank"] == 1
        assert obj[0]["tier"] == "MVP"
        assert obj[1]["agentId"] == "agent-b"
        assert obj[2]["agentId"] == "agent-c"
        assert obj[2]["tier"] == "BOTTOM"

    def test_unknown_stage_falls_back_to_mock(self):
        """查询不存在的 stage → 回退 mock。"""
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
        ])
        resp = _client().get("/api/leaderboard", params={"stage": "UNKNOWN"})
        assert resp.status_code == 200
        obj = resp.json()["objective"]
        # 回退 mock 返回 3 条，不是注入的 1 条
        assert len(obj) == 3
        assert obj[0]["agentId"] == "agent-a"  # mock 也有 agent-a


class TestEndpointResponseStructure:
    """响应结构完整性。"""

    def test_response_has_all_required_fields(self):
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
        ])
        resp = _client().get("/api/leaderboard", params={"stage": "S1"})
        body = resp.json()
        assert "stage" in body
        assert "jobType" in body
        assert "objective" in body
        assert "subjective" in body
        assert "divergences" in body
        assert "updatedAt" in body
        assert body["stage"] == "S1"

    def test_objective_entry_has_required_fields(self):
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
        ])
        resp = _client().get("/api/leaderboard", params={"stage": "S1"})
        entry = resp.json()["objective"][0]
        for field in ("agentId", "name", "jobType", "objectiveScore", "rank", "tier"):
            assert field in entry

    def test_subjective_entry_has_required_fields(self):
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
        ])
        resp = _client().get("/api/leaderboard", params={"stage": "S1"})
        entry = resp.json()["subjective"][0]
        for field in ("agentId", "name", "jobType", "subjectiveScore", "objectiveRank", "dragRank"):
            assert field in entry

    def test_divergence_entry_has_required_fields(self):
        _inject_stage_scores("S1", "code", [
            ("agent-a", 82.0, 80.0),
            ("agent-b", 74.5, 72.0),
        ])
        drag_order = json.dumps(["agent-b", "agent-a"])
        resp = _client().get("/api/leaderboard", params={
            "stage": "S1",
            "subjective": drag_order,
        })
        div = resp.json()["divergences"][0]
        for field in ("agentId", "objectiveRank", "dragRank", "delta"):
            assert field in div
