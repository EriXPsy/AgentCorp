"""
model-service/tests/test_gold_reference.py
GoldReferenceEvaluator 单元测试。

覆盖：
- 注册完整性（register_all 包含 gold_reference）；
- declared_dims 不越界（code_test_coverage ⊆ registry 允许集）；
- 无金标准题目 → 空分、零置信；
- 金标准全绿 → 5.0 + confidence 1.0 + verified_evidence；
- 金标准部分通过 → pass_rate × 5 对齐 0.5 步进；
- 沙箱未启用（disabled）/ 无可执行用例（total==0）→ 空分、零置信、不覆盖 LLM 分。
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from app.scoring.evaluator_protocol import EvaluatorInput  # noqa: E402
from app.scoring.evaluators import register_all  # noqa: E402
from app.scoring.evaluators.gold_reference_evaluator import (  # noqa: E402
    GoldReferenceEvaluator,
)
from app.scoring.judge_registry import JudgeRegistry  # noqa: E402
from app.sandbox.runner import SandboxResult  # noqa: E402


def _patch_run(monkeypatch, result: SandboxResult) -> None:
    import app.scoring.evaluators.gold_reference_evaluator as m

    monkeypatch.setattr(m, "run_python_answer", lambda answer, task_id=None: result)


# ======================================================================
# 1. 注册与维度校验
# ======================================================================
def test_registered():
    reg = JudgeRegistry()
    register_all(reg)
    assert "gold_reference" in reg.list_ids()


def test_declared_dims_valid():
    assert GoldReferenceEvaluator.declared_dims == ["code_test_coverage"]


# ======================================================================
# 2. 无金标准 / 不适用
# ======================================================================
def test_no_gold_fixture_returns_empty():
    ev = GoldReferenceEvaluator()
    out = ev.evaluate(EvaluatorInput(
        agent_id="x", job_type="code",
        task_id="code_debug_race",  # 推理题，无确定性夹具
        answer="def f(): pass",
    ))
    assert out.scores == {}
    assert out.confidence == 0.0


def test_no_task_id_returns_empty():
    ev = GoldReferenceEvaluator()
    out = ev.evaluate(EvaluatorInput(agent_id="x", job_type="code", answer="x"))
    assert out.scores == {}


# ======================================================================
# 3. 金标准执行 → 客观分
# ======================================================================
def test_pass_rate_full(monkeypatch):
    ev = GoldReferenceEvaluator()
    _patch_run(monkeypatch, SandboxResult(
        outcome="passed", total=6, passed=6,
        cases=[("a", True, "")] * 6,
    ))
    out = ev.evaluate(EvaluatorInput(
        agent_id="x", job_type="code",
        task_id="code_csv_merge",  # 机器可验夹具题
        answer="def merge_orders(): pass",
    ))
    assert out.scores.get("code_test_coverage") == 5.0
    assert out.confidence == 1.0
    assert "code_test_coverage" in out.verified_evidence


def test_pass_rate_partial(monkeypatch):
    ev = GoldReferenceEvaluator()
    _patch_run(monkeypatch, SandboxResult(
        outcome="failed", total=4, passed=2, failed=2,
        cases=[("a", True, "")] * 2 + [("b", False, "")] * 2,
    ))
    out = ev.evaluate(EvaluatorInput(
        agent_id="x", job_type="code",
        task_id="code_json_transform",
        answer="x",
    ))
    # 2/4 × 5 = 2.5
    assert out.scores.get("code_test_coverage") == 2.5
    assert out.confidence == 1.0


def test_pass_rate_zero(monkeypatch):
    ev = GoldReferenceEvaluator()
    _patch_run(monkeypatch, SandboxResult(
        outcome="failed", total=3, passed=0, failed=3,
        cases=[("b", False, "")] * 3,
    ))
    out = ev.evaluate(EvaluatorInput(
        agent_id="x", job_type="code",
        task_id="code_list_dedup_sort",
        answer="x",
    ))
    assert out.scores.get("code_test_coverage") == 0.0


# ======================================================================
# 4. 沙箱未启用 / 夹具不可执行 → 不客观断言
# ======================================================================
def test_disabled_returns_empty(monkeypatch):
    ev = GoldReferenceEvaluator()
    _patch_run(monkeypatch, SandboxResult(outcome="disabled", reason="off"))
    out = ev.evaluate(EvaluatorInput(
        agent_id="x", job_type="code",
        task_id="code_csv_merge", answer="x",
    ))
    assert out.scores == {}
    assert out.confidence == 0.0


def test_no_executable_cases_returns_empty(monkeypatch):
    ev = GoldReferenceEvaluator()
    # 候选未提交代码 → outcome=no_code，total=0
    _patch_run(monkeypatch, SandboxResult(outcome="no_code", total=0, passed=0))
    out = ev.evaluate(EvaluatorInput(
        agent_id="x", job_type="code",
        task_id="code_csv_merge", answer="",
    ))
    assert out.scores == {}
