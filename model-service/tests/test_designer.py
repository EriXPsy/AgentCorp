"""
model-service/tests/test_designer.py
SPADE Designer 的单测。

覆盖：
1. Designer prompt 构建
2. LLM 响应解析（正常 JSON / markdown 包裹 / 非法输出）
3. design_challenge 端到端（mock LLM）
4. DesignerEvaluator evaluate（含降级路径 + StyleMemory 路径）
5. harness 验证逻辑
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from app.config import settings
from app.judge_backend import JudgeCompletion, JudgeUnavailable
from app.scoring.designer import (
    DesignerEvaluator,
    _build_designer_prompt,
    _parse_designer_response,
    _validate_harness,
    design_challenge,
)
from app.scoring.evaluator_protocol import EvaluatorInput
from app.scoring.team_style import TeamStyleProfile
from app.scoring.style_memory import StyleMemory


# ======================================================================
# 1) Prompt 构建
# ======================================================================
def test_build_prompt_includes_profile_info():
    """prompt 包含团队画像关键信息。"""
    profile = TeamStyleProfile(
        team_id="t1",
        declared_focus="后端数据处理",
        primary_job_type="code",
        member_count=3,
        eval_count=5,
        task_types_seen=["code_csv_merge", "code_json_transform"],
        experience_lessons=["善于处理数据清洗", "忽视了并发安全"],
    )
    prompt = _build_designer_prompt(profile)

    assert "后端数据处理" in prompt
    assert "t1" in prompt
    assert "code_csv_merge" in prompt
    assert "code_json_transform" in prompt
    assert "善于处理数据清洗" in prompt
    assert "忽视了并发安全" in prompt


def test_build_prompt_available_dims():
    """prompt 列出该 job_type 的可用维度。"""
    profile = TeamStyleProfile(team_id="t", primary_job_type="code")
    prompt = _build_designer_prompt(profile)

    assert "code_runnability" in prompt
    assert "code_security" in prompt


# ======================================================================
# 1c) route 层 _memory_to_profile：job_type 透传（防硬编码 "code" 回归）
# ======================================================================
def test_memory_to_profile_honors_job_type():
    """_memory_to_profile 必须把 job_type 透传给 TeamStyleProfile，不能硬编码 "code"。

    回归背景：原实现 primary_job_type="code" 硬编码，text/image 团队也会拿到 code 题。
    """
    from app.routes.designer_route import _memory_to_profile

    memory = StyleMemory(team_id="team-text")
    memory.current_understanding = "擅长文案"
    memory.next_challenge_hypothesis = "下次考结构化输出"

    for jt in ("code", "text", "image"):
        profile = _memory_to_profile(memory, job_type=jt)
        assert profile.primary_job_type == jt, f"job_type={jt} 未被透传"
        assert profile.team_id == "team-text"
        # 语义信息仍进入 experience_lessons
        assert "擅长文案" in profile.experience_lessons


def test_memory_to_profile_default_job_type_is_code():
    """缺省 job_type 仍为 code（向后兼容无 job_type 的旧调用方）。"""
    from app.routes.designer_route import _memory_to_profile

    memory = StyleMemory(team_id="t")
    assert _memory_to_profile(memory).primary_job_type == "code"


# ======================================================================
# 2) 响应解析
# ======================================================================
def test_parse_clean_json():
    """纯 JSON → 直接解析。"""
    text = '{"task_id": "test", "title": "Test"}'
    result = _parse_designer_response(text)
    assert result is not None
    assert result["task_id"] == "test"


def test_parse_markdown_wrapped():
    """markdown 代码块包裹的 JSON → 正确提取。"""
    text = '```json\n{"task_id": "test"}\n```'
    result = _parse_designer_response(text)
    assert result is not None
    assert result["task_id"] == "test"


def test_parse_invalid_returns_none():
    """非法文本 → None。"""
    assert _parse_designer_response("not json at all") is None
    assert _parse_designer_response("") is None


# ======================================================================
# 3) design_challenge 端到端（mock LLM）
# ======================================================================
_GOOD_DESIGNER_RESPONSE = json.dumps({
    "task_id": "adaptive_csv_filter",
    "title": "过滤异常订单",
    "prompt": "请写一个函数 filter_orders(orders, min_amount) -> list[dict]，"
              "过滤掉金额低于 min_amount 的订单。",
    "target_dims": ["code_runnability", "code_efficiency"],
    "checkpoints": ["正确过滤", "处理空列表", "不修改原列表"],
    "probes": ["声称处理了边界但无代码"],
    "entry_function": "filter_orders",
    "test_harness": (
        "import json, sys\n"
        "sys.path.insert(0, '.')\n"
        "from solution import filter_orders\n"
        "errors = []\npassed = 0\ntotal = 0\n"
        "def check(name, cond, detail=''):\n"
        "    global passed, total\n"
        "    total += 1\n"
        "    if cond: passed += 1\n"
        "    else: errors.append(f'{name}: {detail}')\n"
        "orders = [{'id': 1, 'amount': 100}, {'id': 2, 'amount': 50}]\n"
        "r = filter_orders(orders, 80)\n"
        "check('filters_low', len(r) == 1 and r[0]['id'] == 1, f'got {r}')\n"
        "check('empty_list', filter_orders([], 0) == [], 'empty not handled')\n"
        "check('no_mutation', orders == [{'id': 1, 'amount': 100}, {'id': 2, 'amount': 50}], 'original mutated')\n"
        "print(json.dumps({'total': total, 'passed': passed, 'errors': errors}))\n"
    ),
    "design_rationale": "考查列表推导 + 不可变性",
    "difficulty": 0.5,
})


@patch("app.scoring.designer.get_backend")
def test_design_challenge_success(mock_get_backend):
    """Designer 成功生成一道题。"""
    mock_backend = MagicMock()
    mock_backend.available = True
    mock_backend.complete.return_value = JudgeCompletion(
        text=_GOOD_DESIGNER_RESPONSE,
        backend="mock",
        model="test",
    )
    mock_get_backend.return_value = mock_backend

    # 关闭沙箱验证（避免真实执行）
    with patch.object(settings, "sandbox_enabled", False):
        profile = TeamStyleProfile(
            team_id="t1",
            primary_job_type="code",
            declared_focus="数据处理团队，善于清洗但忽视边界",
            experience_lessons=["总是忘记处理空列表", "命名清晰"],
            eval_count=5,
        )
        challenge = design_challenge(profile, validate=False)

    assert challenge.task.id == "adaptive_csv_filter"
    assert challenge.task.title == "过滤异常订单"
    assert challenge.task.prompt != ""
    assert challenge.task.target_dims == ["code_runnability", "code_efficiency"]
    assert challenge.difficulty == 0.5


@patch("app.scoring.designer.get_backend")
def test_design_challenge_invalid_json(mock_get_backend):
    """LLM 返回非法 JSON → 降级返回空题。"""
    mock_backend = MagicMock()
    mock_backend.available = True
    mock_backend.complete.return_value = JudgeCompletion(
        text="I don't know how to do this",
        backend="mock",
        model="test",
    )
    mock_get_backend.return_value = mock_backend

    profile = TeamStyleProfile(team_id="t1", primary_job_type="code")
    challenge = design_challenge(profile, validate=False)

    assert challenge.task.prompt == ""
    assert "无法解析" in challenge.design_rationale


@patch("app.scoring.designer.get_backend")
def test_design_challenge_unavailable(mock_get_backend):
    """LLM 不可用 → 抛 JudgeUnavailable。"""
    mock_backend = MagicMock()
    mock_backend.available = False
    mock_get_backend.return_value = mock_backend

    profile = TeamStyleProfile(team_id="t1")
    with pytest.raises(JudgeUnavailable):
        design_challenge(profile, validate=False)


# ======================================================================
# 4) DesignerEvaluator
# ======================================================================
@patch("app.scoring.designer.get_backend")
def test_evaluator_dispatch(mock_get_backend):
    """经 EvaluatorInput 调 Designer → 返回题目 metadata。"""
    mock_backend = MagicMock()
    mock_backend.available = True
    mock_backend.complete.return_value = JudgeCompletion(
        text=_GOOD_DESIGNER_RESPONSE,
        backend="mock",
        model="test",
    )
    mock_get_backend.return_value = mock_backend

    ev = DesignerEvaluator()
    inp = EvaluatorInput(
        agent_id="team_1",
        job_type="code",
        options={
            "team_id": "team_1",
            "profile": {
                "primary_job_type": "code",
                "declared_focus": "后端数据处理团队",
                "experience_lessons": ["忽视空列表边界"],
                "eval_count": 5,
                "task_types_seen": [],
            },
        },
    )

    with patch.object(settings, "sandbox_enabled", False):
        out = ev.evaluate(inp)

    assert out.evaluator_id == "designer"
    assert not out.degraded
    assert out.metadata["taskId"] == "adaptive_csv_filter"
    assert out.metadata["title"] == "过滤异常订单"
    assert out.confidence > 0


@patch("app.scoring.designer.get_backend")
def test_evaluator_dispatch_with_style_memory(mock_get_backend):
    """经 StyleMemory 调用 Designer → 语义理解传入出题。"""
    mock_backend = MagicMock()
    mock_backend.available = True
    mock_backend.complete.return_value = JudgeCompletion(
        text=_GOOD_DESIGNER_RESPONSE,
        backend="mock",
        model="test",
    )
    mock_get_backend.return_value = mock_backend

    ev = DesignerEvaluator()
    inp = EvaluatorInput(
        agent_id="team_1",
        job_type="code",
        options={
            "team_id": "team_1",
            "style_memory": {
                "current_understanding": "该团队偏爱函数式风格，但总是忘记异常处理",
                "next_challenge_hypothesis": "下一道题应该考查异常边界",
                "reflection_count": 6,
                "challenges_issued": ["code_csv_merge"],
            },
        },
    )

    with patch.object(settings, "sandbox_enabled", False):
        out = ev.evaluate(inp)

    assert out.evaluator_id == "designer"
    assert not out.degraded
    assert out.metadata["taskId"] == "adaptive_csv_filter"


def test_evaluator_missing_team_id():
    """无 team_id → degraded。"""
    ev = DesignerEvaluator()
    inp = EvaluatorInput(
        agent_id="",
        job_type="code",
        options={},
    )
    out = ev.evaluate(inp)
    assert out.degraded
    assert "team_id" in out.degraded_reason.lower() or "缺少" in out.degraded_reason


@patch("app.scoring.designer.get_backend")
def test_evaluator_degraded_when_llm_unavailable(mock_get_backend):
    """LLM 不可用 → degraded=True。"""
    mock_backend = MagicMock()
    mock_backend.available = False
    mock_get_backend.return_value = mock_backend

    ev = DesignerEvaluator()
    inp = EvaluatorInput(
        agent_id="team_1",
        job_type="code",
        options={"team_id": "team_1"},
    )
    out = ev.evaluate(inp)
    assert out.degraded
    assert "不可用" in out.degraded_reason


# ======================================================================
# 5) Health
# ======================================================================
@patch("app.scoring.designer.get_backend")
def test_health_healthy(mock_get_backend):
    mock_backend = MagicMock()
    mock_backend.available = True
    mock_get_backend.return_value = mock_backend

    ev = DesignerEvaluator()
    h = ev.health()
    assert h.status == "healthy"


@patch("app.scoring.designer.get_backend")
def test_health_degraded(mock_get_backend):
    mock_backend = MagicMock()
    mock_backend.available = False
    mock_get_backend.return_value = mock_backend

    ev = DesignerEvaluator()
    h = ev.health()
    assert h.status == "degraded"
