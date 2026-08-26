"""
model-service/tests/test_prompt_evolver.py
PromptEvolver 的单测。

覆盖：
1. should_check 触发条件
2. check_and_evolve 端到端（mock LLM）
3. LLM 不可用 → 跳过进化
4. 进化后的 prompt 写入 StyleMemory
5. Reflector 集成：evolved prompt 被使用
6. hypothesis_history 正确记录
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from app.judge_backend import JudgeCompletion, JudgeUnavailable
from app.scoring.prompt_evolver import (
    _META_REVIEW_SYSTEM,
    _META_REVIEW_USER,
    PromptEvolver,
)
from app.scoring.style_memory import (
    REFLECTION_SYSTEM_PROMPT,
    HYPOTHESIZE_SYSTEM_PROMPT,
    Reflector,
    StyleMemory,
)


# ======================================================================
# 1) should_check 触发条件
# ======================================================================
def test_should_check_at_threshold():
    """reflection_count 是 evolve_every 的倍数时触发。"""
    mem = StyleMemory(team_id="t1", reflection_count=20, evolve_every=20)
    evolver = PromptEvolver()
    assert evolver.should_check(mem) is True


def test_should_not_check_below_threshold():
    """不足阈值不触发。"""
    mem = StyleMemory(team_id="t1", reflection_count=10, evolve_every=20)
    assert PromptEvolver().should_check(mem) is False


def test_should_check_zero_count():
    """reflection_count=0 不触发。"""
    mem = StyleMemory(team_id="t1", reflection_count=0, evolve_every=20)
    assert PromptEvolver().should_check(mem) is False


def test_should_check_custom_interval():
    """自定义 evolve_every=5 → 5, 10, 15 触发。"""
    evolver = PromptEvolver()
    for count in [4, 6, 9]:
        mem = StyleMemory(team_id="t", reflection_count=count, evolve_every=5)
        assert evolver.should_check(mem) is False
    for count in [5, 10, 15]:
        mem = StyleMemory(team_id="t", reflection_count=count, evolve_every=5)
        assert evolver.should_check(mem) is True


# ======================================================================
# 2) check_and_evolve 端到端
# ======================================================================
_GOOD_REVIEW = json.dumps({
    "quality_score": 0.3,
    "hypothesis_accuracy": 0.2,
    "template_ratio": 0.6,
    "evolve_reflection": True,
    "evolve_hypothesis": True,
    "new_reflection_constraints": "必须引用具体代码行号或变量名，禁止使用'代码整洁'这类泛泛评价",
    "new_hypothesis_constraints": "只对高信心假设（>70%）做预测，低于此阈值写' insufficient evidence'",
    "reasoning": "多数观察是泛泛而谈，假设命中率极低",
})

_EVOLVED_REFLECTION = (
    "You are an expert at analyzing team coding style and engineering taste.\n"
    "You observe a team's answer to a challenge and reflect on what their code\n"
    "reveals about their style, strengths, weaknesses, and aesthetic preferences.\n"
    "Be specific and evidence-based — cite actual patterns from the code.\n"
    "CRITICAL: You MUST cite specific variable names, function names, or line patterns. "
    "Generic praise like 'clean code' or 'well-structured' is strictly forbidden. "
    "Every observation must reference at least one concrete code element."
)

_EVOLVED_HYPOTHESIS = (
    "You are a challenge designer. Given what you know about a team's style "
    "and their performance history, you decide what the next challenge should "
    "target to stretch them and reveal more about their engineering taste.\n"
    "CONSERVATIVE MODE: Only make predictions you are >70% confident about. "
    "If evidence is insufficient, write 'insufficient evidence' instead of guessing."
)


@patch("app.scoring.prompt_evolver.get_backend")
def test_evolve_both_prompts(mock_get_backend):
    """质量低 + 命中率低 → 两个 prompt 都被进化。"""
    mock_backend = MagicMock()
    mock_backend.available = True
    # PromptEvolver 需要 3 次 LLM 调用：
    # 1. review（meta-review）
    # 2. evolve reflection prompt
    # 3. evolve hypothesis prompt
    mock_backend.complete.side_effect = [
        JudgeCompletion(text=_GOOD_REVIEW, backend="mock", model="test"),
        JudgeCompletion(text=_EVOLVED_REFLECTION, backend="mock", model="test"),
        JudgeCompletion(text=_EVOLVED_HYPOTHESIS, backend="mock", model="test"),
    ]
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(
        team_id="t1",
        reflection_count=20,
        evolve_every=20,
        observations=["代码整洁", "结构清晰", "总体不错"] + [f"obs{i}" for i in range(7)],
        hypothesis_history=["假设1", "假设2", "假设3"] + [f"hyp{i}" for i in range(7)],
        current_understanding="团队代码风格良好",
    )

    evolver = PromptEvolver()
    updated = evolver.check_and_evolve(mem)

    assert updated.evolved_reflection_system is not None
    assert "CRITICAL" in updated.evolved_reflection_system
    assert updated.evolved_hypothesis_system is not None
    assert "CONSERVATIVE" in updated.evolved_hypothesis_system
    assert updated.evolution_count == 2  # 两个 prompt 都进化了
    assert len(updated.reflection_quality_history) == 1
    assert len(updated.hypothesis_accuracy_history) == 1
    assert updated.reflection_quality_history[0] == 0.3
    assert updated.hypothesis_accuracy_history[0] == 0.2


@patch("app.scoring.prompt_evolver.get_backend")
def test_evolve_only_reflection(mock_get_backend):
    """只有 reflection 质量低 → 只进化 reflection。"""
    review = json.dumps({
        "quality_score": 0.3,
        "hypothesis_accuracy": 0.8,
        "template_ratio": 0.6,
        "evolve_reflection": True,
        "evolve_hypothesis": False,
        "new_reflection_constraints": "must cite code patterns",
        "new_hypothesis_constraints": "",
        "reasoning": "reflections too generic but hypotheses accurate",
    })

    mock_backend = MagicMock()
    mock_backend.available = True
    mock_backend.complete.side_effect = [
        JudgeCompletion(text=review, backend="mock", model="test"),
        JudgeCompletion(text=_EVOLVED_REFLECTION, backend="mock", model="test"),
    ]
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(
        team_id="t1",
        reflection_count=20,
        observations=["obs1"] * 10,
        hypothesis_history=["hyp1"] * 10,
    )

    evolver = PromptEvolver()
    updated = evolver.check_and_evolve(mem)

    assert updated.evolved_reflection_system is not None
    assert updated.evolved_hypothesis_system is None  # 没进化
    assert updated.evolution_count == 1


@patch("app.scoring.prompt_evolver.get_backend")
def test_no_evolve_when_quality_high(mock_get_backend):
    """质量高 → 不进化。"""
    review = json.dumps({
        "quality_score": 0.9,
        "hypothesis_accuracy": 0.85,
        "template_ratio": 0.1,
        "evolve_reflection": False,
        "evolve_hypothesis": False,
        "new_reflection_constraints": "",
        "new_hypothesis_constraints": "",
        "reasoning": "observations are specific and evidence-based",
    })

    mock_backend = MagicMock()
    mock_backend.available = True
    mock_backend.complete.return_value = JudgeCompletion(
        text=review, backend="mock", model="test",
    )
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(
        team_id="t1",
        reflection_count=20,
        observations=["具体观察：用了列表推导，但没有处理 None 输入"] * 10,
        hypothesis_history=["考查 None 边界"] * 10,
    )

    evolver = PromptEvolver()
    updated = evolver.check_and_evolve(mem)

    assert updated.evolved_reflection_system is None
    assert updated.evolved_hypothesis_system is None
    assert updated.evolution_count == 0
    assert updated.reflection_quality_history == [0.9]
    assert updated.hypothesis_accuracy_history == [0.85]


@patch("app.scoring.prompt_evolver.get_backend")
def test_evolve_llm_unavailable(mock_get_backend):
    """LLM 不可用 → 跳过进化，memory 不变。"""
    mock_backend = MagicMock()
    mock_backend.available = False
    mock_backend.complete.side_effect = JudgeUnavailable("down")
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(team_id="t1", reflection_count=20)
    evolver = PromptEvolver()
    updated = evolver.check_and_evolve(mem)

    assert updated.evolved_reflection_system is None
    assert updated.evolution_count == 0
    assert updated.reflection_quality_history == []


@patch("app.scoring.prompt_evolver.get_backend")
def test_evolve_invalid_json(mock_get_backend):
    """LLM 返回非法 JSON → 跳过进化。"""
    mock_backend = MagicMock()
    mock_backend.available = True
    mock_backend.complete.return_value = JudgeCompletion(
        text="I cannot evaluate this", backend="mock", model="test",
    )
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(
        team_id="t1",
        reflection_count=20,
        observations=["obs1"] * 5,
    )
    evolver = PromptEvolver()
    updated = evolver.check_and_evolve(mem)

    assert updated.evolved_reflection_system is None
    assert updated.evolution_count == 0


@patch("app.scoring.prompt_evolver.get_backend")
def test_evolve_short_prompt_discarded(mock_get_backend):
    """进化后的 prompt 太短 → 丢弃。"""
    review = json.dumps({
        "quality_score": 0.3,
        "hypothesis_accuracy": 0.2,
        "template_ratio": 0.6,
        "evolve_reflection": True,
        "evolve_hypothesis": False,
        "new_reflection_constraints": "be better",
        "new_hypothesis_constraints": "",
        "reasoning": "bad",
    })

    mock_backend = MagicMock()
    mock_backend.available = True
    mock_backend.complete.side_effect = [
        JudgeCompletion(text=review, backend="mock", model="test"),
        JudgeCompletion(text="too short", backend="mock", model="test"),  # < 50 chars
    ]
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(
        team_id="t1",
        reflection_count=20,
        observations=["obs"] * 5,
        hypothesis_history=["hyp"] * 5,
    )
    evolver = PromptEvolver()
    updated = evolver.check_and_evolve(mem)

    assert updated.evolved_reflection_system is None  # 太短被丢弃
    assert updated.evolution_count == 0


# ======================================================================
# 3) Reflector 集成：evolved prompt 被使用
# ======================================================================
@patch("app.scoring.prompt_evolver.get_backend")
@patch("app.scoring.style_memory.get_backend")
def test_reflector_uses_evolved_prompt(mock_style_backend, mock_evolver_backend):
    """Reflector 使用 StyleMemory 中的进化 prompt。"""
    # 模拟 StyleMemory 已有进化的 reflection prompt
    evolved = "CUSTOM EVOLVED REFLECTION PROMPT: cite specific variable names."

    # Reflector 的 LLM 调用（reflection + hypothesis）
    mock_style_backend.return_value.available = True
    mock_style_backend.return_value.complete.side_effect = [
        JudgeCompletion(text="观察：团队使用了变量 x 但没处理 None。", backend="mock", model="test"),
        JudgeCompletion(text="假设：考查 None 边界。", backend="mock", model="test"),
    ]

    mem = StyleMemory(
        team_id="t1",
        evolved_reflection_system=evolved,
    )

    reflector = Reflector()
    updated = reflector.reflect(
        task_prompt="写一个函数",
        answer="def f(x): return x + 1",
        scores={"code_runnability": 3.0},
        outcome="passed",
        memory=mem,
        task_id="task_1",
    )

    # 验证 evolved prompt 被传给了 LLM
    calls = mock_style_backend.return_value.complete.call_args_list
    first_call_messages = calls[0][0][0]  # 第一个位置参数是 messages list
    system_content = first_call_messages[0]["content"]
    assert "CUSTOM EVOLVED" in system_content


@patch("app.scoring.style_memory.get_backend")
def test_reflector_records_hypothesis_history(mock_get_backend):
    """reflect() 记录 hypothesis 到 history。"""
    mock_backend = MagicMock()
    mock_backend.available = True
    mock_backend.complete.side_effect = [
        JudgeCompletion(text="观察1", backend="mock", model="test"),
        JudgeCompletion(text="假设1：考查边界", backend="mock", model="test"),
    ]
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(team_id="t1")
    reflector = Reflector()
    updated = reflector.reflect("t", "a", {}, "passed", mem, task_id="task_1")

    assert len(updated.hypothesis_history) == 1
    assert "考查边界" in updated.hypothesis_history[0]


@patch("app.scoring.prompt_evolver.get_backend")
@patch("app.scoring.style_memory.get_backend")
def test_reflector_triggers_evolution_at_threshold(mock_style_backend, mock_evolver_backend):
    """reflection_count 达到 evolve_every → 触发 PromptEvolver。"""
    # 先设 reflection_count=19, 下一轮到 20 → 触发
    mem = StyleMemory(
        team_id="t1",
        reflection_count=19,
        evolve_every=20,
        observations=[f"obs{i}" for i in range(20)],
        hypothesis_history=[f"hyp{i}" for i in range(20)],
    )

    # Reflector 的 LLM mock
    style_backend = MagicMock()
    style_backend.available = True
    style_backend.complete.side_effect = [
        JudgeCompletion(text="观察20", backend="mock", model="test"),
        JudgeCompletion(text="假设20", backend="mock", model="test"),
    ]
    mock_style_backend.return_value = style_backend

    # PromptEvolver 的 LLM mock
    evolver_backend = MagicMock()
    evolver_backend.available = True
    review_json = json.dumps({
        "quality_score": 0.4,
        "hypothesis_accuracy": 0.2,
        "template_ratio": 0.5,
        "evolve_reflection": False,
        "evolve_hypothesis": False,
        "new_reflection_constraints": "",
        "new_hypothesis_constraints": "",
        "reasoning": "mediocre",
    })
    evolver_backend.complete.return_value = JudgeCompletion(
        text=review_json, backend="mock", model="test",
    )
    mock_evolver_backend.return_value = evolver_backend

    reflector = Reflector()
    updated = reflector.reflect("t", "a", {}, "passed", mem, task_id="task_20")

    assert updated.reflection_count == 20
    # PromptEvolver 的 review 应该被调用了
    assert len(updated.reflection_quality_history) == 1
    assert len(updated.hypothesis_accuracy_history) == 1


@patch("app.scoring.style_memory.get_backend")
def test_reflector_no_evolution_before_threshold(mock_get_backend):
    """reflection_count < evolve_every → 不触发进化。"""
    mock_backend = MagicMock()
    mock_backend.available = True
    mock_backend.complete.side_effect = [
        JudgeCompletion(text="观察1", backend="mock", model="test"),
        JudgeCompletion(text="假设1", backend="mock", model="test"),
    ]
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(team_id="t1", reflection_count=0, evolve_every=20)
    reflector = Reflector()
    updated = reflector.reflect("t", "a", {}, "passed", mem, task_id="task_1")

    assert updated.reflection_count == 1
    assert updated.reflection_quality_history == []  # 没触发
    assert updated.evolution_count == 0


@patch("app.scoring.style_memory.get_backend")
def test_reflector_uses_evolved_hypothesis_prompt(mock_get_backend):
    """Reflector 使用进化后的 hypothesis prompt。"""
    evolved_hyp = "CUSTOM HYPOTHESIS PROMPT: only predict if >70% confident."

    mock_backend = MagicMock()
    mock_backend.available = True
    mock_backend.complete.side_effect = [
        JudgeCompletion(text="观察1", backend="mock", model="test"),
        JudgeCompletion(text="假设1", backend="mock", model="test"),
    ]
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(
        team_id="t1",
        evolved_hypothesis_system=evolved_hyp,
    )
    reflector = Reflector()
    updated = reflector.reflect("t", "a", {}, "passed", mem, task_id="task_1")

    # 第二次 LLM 调用是 hypothesis，验证用了 evolved prompt
    calls = mock_backend.complete.call_args_list
    hyp_call_messages = calls[1][0][0]
    system_content = hyp_call_messages[0]["content"]
    assert "CUSTOM HYPOTHESIS" in system_content


# ======================================================================
# 4) Prompt 模板完整性
# ======================================================================
def test_meta_review_prompts_are_strings():
    assert isinstance(_META_REVIEW_SYSTEM, str)
    assert len(_META_REVIEW_SYSTEM) > 50
    assert "{observations}" in _META_REVIEW_USER
    assert "{hypotheses}" in _META_REVIEW_USER
    assert "{understanding}" in _META_REVIEW_USER


def test_meta_review_json_format():
    """meta-review 的 user prompt 包含 JSON 格式说明。"""
    assert "quality_score" in _META_REVIEW_USER
    assert "hypothesis_accuracy" in _META_REVIEW_USER
    assert "evolve_reflection" in _META_REVIEW_USER
    assert "evolve_hypothesis" in _META_REVIEW_USER


# ======================================================================
# 5) StyleMemory 序列化含进化字段
# ======================================================================
def test_style_memory_serialize_with_evolved_prompts():
    """进化后的 prompt 能正确序列化/反序列化。"""
    mem = StyleMemory(
        team_id="t1",
        evolved_reflection_system="evolved reflection prompt v2",
        evolved_hypothesis_system="evolved hypothesis prompt v2",
        reflection_quality_history=[0.3, 0.5, 0.7],
        hypothesis_accuracy_history=[0.2, 0.4, 0.6],
        hypothesis_history=["hyp1", "hyp2", "hyp3"],
        evolution_count=2,
        evolve_every=15,
    )
    data = mem.to_dict()
    restored = StyleMemory.from_dict(data)

    assert restored.evolved_reflection_system == "evolved reflection prompt v2"
    assert restored.evolved_hypothesis_system == "evolved hypothesis prompt v2"
    assert restored.reflection_quality_history == [0.3, 0.5, 0.7]
    assert restored.hypothesis_accuracy_history == [0.2, 0.4, 0.6]
    assert restored.hypothesis_history == ["hyp1", "hyp2", "hyp3"]
    assert restored.evolution_count == 2
    assert restored.evolve_every == 15


def test_style_memory_defaults_no_evolved_prompts():
    """新建 StyleMemory 的进化字段为默认值。"""
    mem = StyleMemory(team_id="t1")
    assert mem.evolved_reflection_system is None
    assert mem.evolved_hypothesis_system is None
    assert mem.reflection_quality_history == []
    assert mem.hypothesis_accuracy_history == []
    assert mem.hypothesis_history == []
    assert mem.evolution_count == 0
    assert mem.evolve_every == 20


# ======================================================================
# 6) PromptEvolver JSON 解析
# ======================================================================
def test_parse_json_clean():
    text = '{"quality_score": 0.5, "evolve_reflection": true}'
    result = PromptEvolver._parse_json(text)
    assert result["quality_score"] == 0.5
    assert result["evolve_reflection"] is True


def test_parse_json_with_markdown():
    text = '```json\n{"quality_score": 0.3}\n```'
    result = PromptEvolver._parse_json(text)
    assert result["quality_score"] == 0.3


def test_parse_json_invalid():
    assert PromptEvolver._parse_json("not json") is None
    assert PromptEvolver._parse_json("") is None
    assert PromptEvolver._parse_json(None) is None


# ======================================================================
# 7) 进化不污染原始 prompt
# ======================================================================
def test_default_prompts_unchanged():
    """进化只修改 StyleMemory 中的副本，不改模块级常量。"""
    original_reflection = REFLECTION_SYSTEM_PROMPT
    original_hypothesis = HYPOTHESIZE_SYSTEM_PROMPT

    mem = StyleMemory(
        team_id="t1",
        evolved_reflection_system="completely different prompt",
        evolved_hypothesis_system="another different prompt",
    )

    assert REFLECTION_SYSTEM_PROMPT == original_reflection
    assert HYPOTHESIZE_SYSTEM_PROMPT == original_hypothesis
