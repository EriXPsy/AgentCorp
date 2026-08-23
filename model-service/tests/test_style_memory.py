"""
model-service/tests/test_style_memory.py
StyleMemory 核心模块的单测。

覆盖：
1. StyleMemory 数据类（创建、序列化、反序列化）
2. Reflector.reflect() 端到端（mock LLM）
3. 反思观察解析（_parse_reflection）
4. 合成触发逻辑（每 3 次 synthesize）
5. 降级路径（LLM 不可用、空输出）
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from app.judge_backend import JudgeCompletion, JudgeUnavailable
from app.scoring.style_memory import (
    Reflector,
    StyleMemory,
    HYPOTHESIZE_SYSTEM_PROMPT,
    HYPOTHESIZE_USER_TEMPLATE,
    REFLECTION_SYSTEM_PROMPT,
    REFLECTION_USER_TEMPLATE,
    SYNTHESIZE_SYSTEM_PROMPT,
    SYNTHESIZE_USER_TEMPLATE,
)


# ======================================================================
# 1) StyleMemory 数据类
# ======================================================================
def test_create_empty_memory():
    """创建空记忆。"""
    mem = StyleMemory(team_id="t1")
    assert mem.team_id == "t1"
    assert mem.observations == []
    assert mem.current_understanding == ""
    assert mem.next_challenge_hypothesis == ""
    assert mem.challenges_issued == []
    assert mem.performance_log == []
    assert mem.reflection_count == 0
    assert mem.synthesize_every == 3


def test_serialize_roundtrip():
    """to_dict → from_dict 保持数据完整。"""
    mem = StyleMemory(
        team_id="t1",
        observations=["obs1", "obs2"],
        current_understanding="团队偏爱函数式",
        next_challenge_hypothesis="考查异常处理",
        challenges_issued=["task_1", "task_2"],
        performance_log=[{"task_id": "task_1", "outcome": "passed", "scores": {}}],
        reflection_count=2,
    )
    data = mem.to_dict()
    restored = StyleMemory.from_dict(data)

    assert restored.team_id == mem.team_id
    assert restored.observations == mem.observations
    assert restored.current_understanding == mem.current_understanding
    assert restored.next_challenge_hypothesis == mem.next_challenge_hypothesis
    assert restored.challenges_issued == mem.challenges_issued
    assert restored.performance_log == mem.performance_log
    assert restored.reflection_count == mem.reflection_count


def test_from_dict_defaults():
    """from_dict 缺少字段时用默认值。"""
    mem = StyleMemory.from_dict({"team_id": "t1"})
    assert mem.team_id == "t1"
    assert mem.observations == []
    assert mem.reflection_count == 0
    assert mem.synthesize_every == 3


# ======================================================================
# 2) Reflector.reflect() 端到端
# ======================================================================
@patch("app.scoring.style_memory.get_backend")
def test_reflect_appends_observation(mock_get_backend):
    """reflect() 成功 → 观察被追加，计数 +1。"""
    mock_backend = MagicMock()
    mock_backend.available = True
    # reflect 需要 2 次 LLM 调用：一次 reflection，一次 hypothesis
    # 第 1 次不是 synthesize 触发点（count=1, 1%3≠0）
    mock_backend.complete.side_effect = [
        JudgeCompletion(text="团队使用了列表推导，代码简洁但缺少空输入处理。", backend="mock", model="test"),
        JudgeCompletion(text="下一道题应考查空输入和类型边界。", backend="mock", model="test"),
    ]
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(team_id="t1")
    reflector = Reflector()
    updated = reflector.reflect(
        task_prompt="写一个过滤函数",
        answer="def f(x): return [i for i in x if i > 0]",
        scores={"code_runnability": 4.0},
        outcome="passed",
        memory=mem,
        task_id="task_1",
    )

    assert updated.reflection_count == 1
    assert len(updated.observations) == 1
    assert "列表推导" in updated.observations[0]
    assert "task_1" in updated.challenges_issued
    assert len(updated.performance_log) == 1
    assert updated.performance_log[0]["task_id"] == "task_1"


@patch("app.scoring.style_memory.get_backend")
def test_reflect_triggers_synthesis_every_3(mock_get_backend):
    """每 3 次反思触发一次合成。"""
    mock_backend = MagicMock()
    mock_backend.available = True

    # 模拟 3 轮反思：每轮 2 次 LLM（reflection + hypothesis），第 3 轮多 1 次（synthesize）
    # Round 1: reflection + hypothesis
    # Round 2: reflection + hypothesis
    # Round 3: reflection + synthesize + hypothesis = 3 calls
    mock_backend.complete.side_effect = [
        # Round 1
        JudgeCompletion(text="观察1：偏爱函数式。", backend="mock", model="test"),
        JudgeCompletion(text="假设1：考查异常。", backend="mock", model="test"),
        # Round 2
        JudgeCompletion(text="观察2：命名规范。", backend="mock", model="test"),
        JudgeCompletion(text="假设2：考查边界。", backend="mock", model="test"),
        # Round 3
        JudgeCompletion(text="观察3：忽视类型安全。", backend="mock", model="test"),
        # synthesize (因为 count=3, 3%3==0)
        JudgeCompletion(text="综合理解：团队偏爱函数式、命名规范，但忽视类型安全和异常处理。", backend="mock", model="test"),
        # hypothesis
        JudgeCompletion(text="假设3：考查类型边界 + 异常处理。", backend="mock", model="test"),
    ]
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(team_id="t1")
    reflector = Reflector()

    for i in range(3):
        mem = reflector.reflect(
            task_prompt=f"题目{i}",
            answer=f"def f(): pass  # 答案{i}",
            scores={"code_runnability": 3.5},
            outcome="passed",
            memory=mem,
            task_id=f"task_{i}",
        )

    assert mem.reflection_count == 3
    assert len(mem.observations) == 3
    # 第 3 次应该触发了合成
    assert "函数式" in mem.current_understanding
    assert "类型安全" in mem.current_understanding or "异常处理" in mem.current_understanding


@patch("app.scoring.style_memory.get_backend")
def test_reflect_llm_unavailable(mock_get_backend):
    """LLM 不可用 → memory 不变。"""
    mock_backend = MagicMock()
    mock_backend.available = False
    mock_backend.complete.side_effect = JudgeUnavailable("backend down")
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(team_id="t1")
    reflector = Reflector()
    updated = reflector.reflect(
        task_prompt="题目",
        answer="def f(): pass",
        scores={},
        outcome="passed",
        memory=mem,
    )

    assert updated.reflection_count == 0
    assert len(updated.observations) == 0


@patch("app.scoring.style_memory.get_backend")
def test_reflect_empty_response(mock_get_backend):
    """LLM 返回空内容 → 跳过观察。"""
    mock_backend = MagicMock()
    mock_backend.available = True
    mock_backend.complete.return_value = JudgeCompletion(
        text="", backend="mock", model="test",
    )
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(team_id="t1")
    reflector = Reflector()
    updated = reflector.reflect(
        task_prompt="题目",
        answer="def f(): pass",
        scores={},
        outcome="passed",
        memory=mem,
    )

    assert updated.reflection_count == 0
    assert len(updated.observations) == 0


# ======================================================================
# 3) 观察解析
# ======================================================================
def test_parse_clean_text():
    """纯文本直接返回。"""
    result = Reflector._parse_reflection("团队偏爱函数式风格。")
    assert result == "团队偏爱函数式风格。"


def test_parse_strips_thinking_blocks():
    """剥离 <think>...</think> 段。"""
    text = "<think>分析中...</think>团队代码简洁优雅。"
    result = Reflector._parse_reflection(text)
    assert "思考" not in result
    assert "团队代码简洁" in result


def test_parse_strips_markdown_fences():
    """剥离 markdown 代码块。"""
    text = '```\n观察：团队使用列表推导\n```'
    result = Reflector._parse_reflection(text)
    assert "```" not in result
    assert "列表推导" in result


def test_parse_strips_preamble():
    """剥离 'Observation:' 前缀。"""
    text = "Observation: 团队忽视边界处理。"
    result = Reflector._parse_reflection(text)
    assert result == "团队忽视边界处理。"


def test_parse_empty_returns_empty():
    """空输入 → 空输出。"""
    assert Reflector._parse_reflection("") == ""
    assert Reflector._parse_reflection(None) == ""


def test_parse_removes_xml_tags():
    """剥离 XML 标签。"""
    text = "<observation>团队代码风格简洁</observation>"
    result = Reflector._parse_reflection(text)
    assert "<observation>" not in result
    assert "团队代码风格简洁" in result


# ======================================================================
# 4) 多次反思的累积效果
# ======================================================================
@patch("app.scoring.style_memory.get_backend")
def test_multiple_reflections_accumulate(mock_get_backend):
    """多次反思 → 观察列表增长，计数值正确。"""
    mock_backend = MagicMock()
    mock_backend.available = True
    # 每次 reflect: reflection + hypothesis (不触发 synthesize，因为 count=1,2,4,5 不整除 3)
    mock_backend.complete.side_effect = [
        JudgeCompletion(text="观察1", backend="mock", model="test"),
        JudgeCompletion(text="假设1", backend="mock", model="test"),
        JudgeCompletion(text="观察2", backend="mock", model="test"),
        JudgeCompletion(text="假设2", backend="mock", model="test"),
    ]
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(team_id="t1")
    reflector = Reflector()

    mem = reflector.reflect("t1", "a1", {}, "passed", mem, task_id="task_1")
    mem = reflector.reflect("t2", "a2", {}, "failed", mem, task_id="task_2")

    assert mem.reflection_count == 2
    assert len(mem.observations) == 2
    assert len(mem.challenges_issued) == 2
    assert len(mem.performance_log) == 2
    assert mem.current_understanding == ""  # 没到 3 次，不合成


@patch("app.scoring.style_memory.get_backend")
def test_challenges_issued_no_duplicates(mock_get_backend):
    """同一个 task_id 不重复记录到 challenges_issued。"""
    mock_backend = MagicMock()
    mock_backend.available = True
    mock_backend.complete.side_effect = [
        JudgeCompletion(text="观察1", backend="mock", model="test"),
        JudgeCompletion(text="假设1", backend="mock", model="test"),
    ]
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(team_id="t1", challenges_issued=["task_1"])
    reflector = Reflector()
    updated = reflector.reflect("t", "a", {}, "passed", mem, task_id="task_1")

    assert updated.challenges_issued.count("task_1") == 1


# ======================================================================
# 5) Prompt 模板完整性
# ======================================================================
def test_reflection_prompts_are_strings():
    """所有 prompt 模板都是非空字符串。"""
    assert isinstance(REFLECTION_SYSTEM_PROMPT, str)
    assert len(REFLECTION_SYSTEM_PROMPT) > 50
    assert isinstance(REFLECTION_USER_TEMPLATE, str)
    assert "{current_understanding}" in REFLECTION_USER_TEMPLATE
    assert "{challenge}" in REFLECTION_USER_TEMPLATE
    assert "{answer}" in REFLECTION_USER_TEMPLATE
    assert "{scores}" in REFLECTION_USER_TEMPLATE
    assert "{outcome}" in REFLECTION_USER_TEMPLATE


def test_synthesize_prompts_are_strings():
    assert isinstance(SYNTHESIZE_SYSTEM_PROMPT, str)
    assert "{observations}" in SYNTHESIZE_USER_TEMPLATE
    assert "{prior_understanding}" in SYNTHESIZE_USER_TEMPLATE


def test_hypothesize_prompts_are_strings():
    assert isinstance(HYPOTHESIZE_SYSTEM_PROMPT, str)
    assert "{understanding}" in HYPOTHESIZE_USER_TEMPLATE
    assert "{performance_log}" in HYPOTHESIZE_USER_TEMPLATE
    assert "{issued}" in HYPOTHESIZE_USER_TEMPLATE


# ======================================================================
# 6) 自定义 synthesize_every
# ======================================================================
@patch("app.scoring.style_memory.get_backend")
def test_custom_synthesize_every(mock_get_backend):
    """synthesize_every=2 → 每 2 次触发合成。"""
    mock_backend = MagicMock()
    mock_backend.available = True
    mock_backend.complete.side_effect = [
        # Round 1
        JudgeCompletion(text="观察1", backend="mock", model="test"),
        # synthesize (count=1, 1%2≠0, 不触发)
        JudgeCompletion(text="假设1", backend="mock", model="test"),
        # Round 2
        JudgeCompletion(text="观察2", backend="mock", model="test"),
        # synthesize (count=2, 2%2==0, 触发!)
        JudgeCompletion(text="综合：团队稳定进步。", backend="mock", model="test"),
        # hypothesis
        JudgeCompletion(text="假设2", backend="mock", model="test"),
    ]
    mock_get_backend.return_value = mock_backend

    mem = StyleMemory(team_id="t1", synthesize_every=2)
    reflector = Reflector()

    mem = reflector.reflect("t1", "a1", {}, "passed", mem, task_id="task_1")
    assert mem.current_understanding == ""  # 第 1 次不合成

    mem = reflector.reflect("t2", "a2", {}, "passed", mem, task_id="task_2")
    assert "稳定进步" in mem.current_understanding  # 第 2 次合成了
