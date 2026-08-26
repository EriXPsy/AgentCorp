"""
model-service/tests/test_security_scan_evaluator.py
SecurityScanEvaluator 的单测。

覆盖三件事：
1. 基本行为 —— 危险代码被检出、安全代码给出零发现证据
2. 注册 + 派发 —— JudgeRegistry 能 dispatch("security_scan")
3. 降级 —— 沙盒关闭时 evaluate 返回 degraded=True + 空 evidence
4. 对抗 —— AST 扫描能否抓到常见逃逸形态
"""
from __future__ import annotations

import pytest

from app.config import settings
from app.scoring.evaluator_protocol import EvaluatorInput
from app.scoring.judge_registry import JudgeRegistry
from app.scoring.evaluators.security_scan_evaluator import SecurityScanEvaluator


@pytest.fixture(autouse=True)
def _enable_sandbox(monkeypatch):
    """默认开启沙盒（安全扫描依赖 sandbox_enabled）。"""
    monkeypatch.setattr(settings, "sandbox_enabled", True, raising=False)


# ======================================================================
# 1) 基本行为
# ======================================================================
def test_dangerous_code_detected():
    """含 eval() 的代码 → verified_evidence 非空 + metadata.high >= 1。"""
    ev = SecurityScanEvaluator()
    inp = EvaluatorInput(
        agent_id="test",
        job_type="code",
        task_id="code_csv_merge",
        answer="```python\ndef run(cmd):\n    return eval(cmd)\n```",
    )
    out = ev.evaluate(inp)
    assert "code_security" in out.verified_evidence
    assert out.metadata["high"] >= 1
    assert not out.degraded


def test_safe_code_no_findings():
    """纯数据变换代码 → 零发现但仍有 verified_evidence（「扫过没扫出」也是证据）。"""
    ev = SecurityScanEvaluator()
    inp = EvaluatorInput(
        agent_id="test",
        job_type="code",
        task_id="code_csv_merge",
        answer="```python\ndef add(a, b):\n    return a + b\n\ndef test_add():\n    assert add(1, 2) == 3\n```",
    )
    out = ev.evaluate(inp)
    assert "code_security" in out.verified_evidence
    assert out.metadata["high"] == 0
    assert out.metadata["medium"] == 0
    assert not out.degraded


def test_no_code_returns_degraded():
    """无代码可扫 → degraded=True + 空 verified_evidence。"""
    ev = SecurityScanEvaluator()
    inp = EvaluatorInput(
        agent_id="test",
        job_type="code",
        task_id="code_csv_merge",
        answer="我会用 Python 写一个函数。",
    )
    out = ev.evaluate(inp)
    assert out.degraded is True
    assert out.verified_evidence == {}
    assert out.confidence == 0.0


def test_subprocess_shell_true_detected():
    """subprocess + shell=True → 高危检出。"""
    ev = SecurityScanEvaluator()
    inp = EvaluatorInput(
        agent_id="test",
        job_type="code",
        task_id="code_api_hardening",
        answer='```python\nimport subprocess\ndef run(cmd):\n    return subprocess.run(cmd, shell=True)\n```',
    )
    out = ev.evaluate(inp)
    assert out.metadata["high"] >= 1
    rules = {f["rule"] for f in out.metadata["findings"]}
    assert "subprocess-shell-true" in rules


def test_hardcoded_secret_detected():
    """硬编码 password → 高危检出。"""
    ev = SecurityScanEvaluator()
    inp = EvaluatorInput(
        agent_id="test",
        job_type="code",
        task_id="code_api_hardening",
        answer='```python\npassword = "supersecret123"\ndef auth(p):\n    return p == password\n```',
    )
    out = ev.evaluate(inp)
    assert out.metadata["high"] >= 1
    rules = {f["rule"] for f in out.metadata["findings"]}
    assert "hardcoded-secret" in rules


# ======================================================================
# 2) 注册 + 派发
# ======================================================================
def test_security_scan_registered():
    """SecurityScanEvaluator 注册后能被 JudgeRegistry.get 取到。"""
    reg = JudgeRegistry()
    reg.register(SecurityScanEvaluator())
    assert "security_scan" in reg.list_ids()
    ev = reg.get("security_scan")
    assert ev.evaluator_id == "security_scan"
    assert ev.applicable_jobs == ["code"]


def test_security_scan_dispatch():
    """经 registry dispatch 后返回正确结构。"""
    reg = JudgeRegistry()
    reg.register(SecurityScanEvaluator())
    out = reg.dispatch("security_scan", EvaluatorInput(
        agent_id="test",
        job_type="code",
        task_id="code_csv_merge",
        answer="```python\ndef add(a, b):\n    return a + b\n```",
    ))
    assert out.evaluator_id == "security_scan"
    assert "code_security" in out.verified_evidence


def test_security_scan_not_applicable_to_text():
    """security_scan 只适用于 code 工种。"""
    reg = JudgeRegistry()
    reg.register(SecurityScanEvaluator())
    with pytest.raises(ValueError, match="不适用于工种"):
        reg.dispatch("security_scan", EvaluatorInput(
            agent_id="test",
            job_type="text",
            answer="一些文本",
        ))


# ======================================================================
# 3) 降级（沙盒关闭）
# ======================================================================
def test_degraded_when_sandbox_disabled(monkeypatch):
    """沙盒关闭 → evaluate 返回 degraded=True。"""
    monkeypatch.setattr(settings, "sandbox_enabled", False, raising=False)
    ev = SecurityScanEvaluator()
    inp = EvaluatorInput(
        agent_id="test",
        job_type="code",
        task_id="code_csv_merge",
        answer="```python\ndef add(a, b):\n    return a + b\n```",
    )
    out = ev.evaluate(inp)
    assert out.degraded is True
    assert out.verified_evidence == {}
    assert "disabled" in out.degraded_reason.lower() or "未启用" in out.degraded_reason


def test_health_degraded_when_sandbox_disabled(monkeypatch):
    """沙盒关闭 → health() 报 degraded。"""
    monkeypatch.setattr(settings, "sandbox_enabled", False, raising=False)
    ev = SecurityScanEvaluator()
    h = ev.health()
    assert h.status == "degraded"
    assert "沙盒" in h.reason


def test_health_healthy_when_sandbox_enabled():
    """沙盒开启 → health() 报 healthy。"""
    ev = SecurityScanEvaluator()
    h = ev.health()
    assert h.status == "healthy"


# ======================================================================
# 4) 对抗 —— AST 扫描抓逃逸形态
# ======================================================================
def test_catches_dynamic_import():
    """__import__('os') 动态导入 → 中危检出。"""
    ev = SecurityScanEvaluator()
    inp = EvaluatorInput(
        agent_id="test",
        job_type="code",
        task_id="code_csv_merge",
        answer='```python\ndef load(mod):\n    return __import__(mod)\n```',
    )
    out = ev.evaluate(inp)
    rules = {f["rule"] for f in out.metadata["findings"]}
    assert "dangerous-call:__import__" in rules


def test_catches_exec():
    """exec(code) 执行任意语句 → 高危检出。"""
    ev = SecurityScanEvaluator()
    inp = EvaluatorInput(
        agent_id="test",
        job_type="code",
        task_id="code_csv_merge",
        answer='```python\ndef run(code):\n    exec(code)\n```',
    )
    out = ev.evaluate(inp)
    rules = {f["rule"] for f in out.metadata["findings"]}
    assert "dangerous-call:exec" in rules
    assert out.metadata["high"] >= 1


def test_catches_pickle_loads():
    """pickle.loads(untrusted) → 高危检出。"""
    ev = SecurityScanEvaluator()
    inp = EvaluatorInput(
        agent_id="test",
        job_type="code",
        task_id="code_csv_merge",
        answer='```python\nimport pickle\ndef load(data):\n    return pickle.loads(data)\n```',
    )
    out = ev.evaluate(inp)
    rules = {f["rule"] for f in out.metadata["findings"]}
    assert "dangerous-call:pickle.loads" in rules


def test_catches_os_system():
    """os.system(cmd) → 高危检出。"""
    ev = SecurityScanEvaluator()
    inp = EvaluatorInput(
        agent_id="test",
        job_type="code",
        task_id="code_csv_merge",
        answer='```python\nimport os\ndef run(cmd):\n    os.system(cmd)\n```',
    )
    out = ev.evaluate(inp)
    rules = {f["rule"] for f in out.metadata["findings"]}
    assert "dangerous-call:os.system" in rules


def test_catches_ctypes_ffi():
    """import ctypes → 高危检出（绕过 Python 安全模型）。"""
    ev = SecurityScanEvaluator()
    inp = EvaluatorInput(
        agent_id="test",
        job_type="code",
        task_id="code_csv_merge",
        answer='```python\nimport ctypes\ndef hack():\n    return ctypes.cast(0, ctypes.c_void_p)\n```',
    )
    out = ev.evaluate(inp)
    rules = {f["rule"] for f in out.metadata["findings"]}
    assert "ffi-usage" in rules
