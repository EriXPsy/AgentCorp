"""
model-service/tests/test_sandbox_hardening.py
「超级全面沙箱」加固项的单测——每一项都经本机真实子进程实测确认能生效，
而非「应该能行」（参考仓库「未验证前提纪律」）。

守的命题（对应 runner.py 的 5 项加固，编号与 runner 模块 docstring 对齐）：
1. 网络隔离：联网企图确定性失败——socket 桩（socket 可 import 时）与导入阻断
   （socket 在黑名单时）两条路都实测生效。
2. 导入黑名单：危险模块 import 即失败，且不误伤正常代码；名单可配置。
3. 输出上限：print 洪水被截断（output_capped=True），不撑爆内存；上限可配置。
4. 峰值内存：正常执行采集到 peak_mem_mb>0，关闭开关则为 None。
5. OOM 独立 outcome：内存超限归为 oom（reason="memory limit exceeded"），
   与 timeout/failed 区分；_is_oom 纯逻辑全覆盖。

关于真实子进程 OOM：本内存受限 Windows 机器上 300MB 分配有时成功（peak 308MB）、
有时 MemoryError——可用 commit 内存波动，真实 OOM 非确定。故 OOM 的 outcome 映射用
「单测 _is_oom + mock _spawn_and_wait」确定性覆盖，不依赖真实内存（见注释）。
"""
from __future__ import annotations

import io

import pytest

from app.config import settings
from app.sandbox.runner import (
    SandboxResult,
    _SpawnResult,
    _compose_harness,
    _drain_into,
    _is_oom,
    run_python_answer,
    verified_evidence_for,
)


@pytest.fixture(autouse=True)
def _hardening_defaults(monkeypatch):
    """加固项默认全开（与生产默认一致）。"""
    monkeypatch.setattr(settings, "sandbox_enabled", True, raising=False)
    monkeypatch.setattr(settings, "sandbox_timeout", 8.0, raising=False)
    monkeypatch.setattr(settings, "sandbox_mem_mb", 512, raising=False)
    monkeypatch.setattr(settings, "sandbox_network_isolation", True, raising=False)
    monkeypatch.setattr(settings, "sandbox_peak_mem", True, raising=False)
    monkeypatch.setattr(settings, "sandbox_max_output_bytes", 2_000_000, raising=False)
    monkeypatch.setattr(
        settings,
        "sandbox_blocked_imports",
        ["socket", "subprocess", "ctypes", "cffi", "multiprocessing", "pickle"],
        raising=False,
    )


# ======================================================================
# 1. 网络隔离
# ======================================================================
def test_socket_stub_blocks_connect_when_socket_importable(monkeypatch):
    """socket 移出阻断名单 → 桩生效：connect 抛 OSError('sandbox: network disabled')。

    这是 requirement #1 的明确要求（socket.socket 替换为子类桩），故必须让 socket
    可 import 才能触达桩；否则被导入阻断抢先拦截。
    """
    monkeypatch.setattr(
        settings,
        "sandbox_blocked_imports",
        ["subprocess", "ctypes", "cffi", "multiprocessing", "pickle"],
        raising=False,
    )
    r = run_python_answer(
        "import socket\n"
        "def test_net():\n"
        "    s = socket.socket()\n"
        "    s.connect(('1.2.3.4', 80))\n"
    )
    assert r.outcome == "failed"
    assert "network disabled" in r.output_tail


def test_default_config_blocks_socket_import(monkeypatch):
    """默认 blocked_imports 含 socket → import socket 即失败（网络禁用的导入级防线）。"""
    r = run_python_answer("import socket\ndef test_net():\n    socket.socket()\n")
    assert r.outcome == "failed"


def test_isolation_off_allows_real_socket(monkeypatch):
    """关闭网络隔离后 socket 是真类、能正常构造——证明开关被尊重、未误伤正常代码。"""
    monkeypatch.setattr(settings, "sandbox_network_isolation", False, raising=False)
    monkeypatch.setattr(
        settings,
        "sandbox_blocked_imports",
        ["subprocess", "ctypes", "cffi", "multiprocessing", "pickle"],
        raising=False,
    )
    r = run_python_answer(
        "import socket\n"
        "def test_real():\n"
        "    s = socket.socket()\n"
        "    assert s is not None\n"
    )
    assert r.outcome == "passed"


# ======================================================================
# 2. 导入黑名单
# ======================================================================
def test_blocked_import_subprocess_fails_at_import(monkeypatch):
    """import subprocess 在 import 阶段被阻断（CASE_FAIL 带阻断原因）。"""
    r = run_python_answer("def test_sub():\n    import subprocess\n")
    assert r.outcome == "failed"
    assert any("subprocess" in (c[2] or "") for c in r.cases)


def test_blocked_imports_is_configurable(monkeypatch):
    """把 urllib 加入黑名单 → import urllib 被阻断（名单确由配置驱动）。

    为什么不用 os：os 被 importlib._bootstrap_external 等基础设施依赖，阻断它会
    连带搞崩 harness 自身（实测：阻断 os 时 harness 在 import importlib.util 阶段即
    崩溃，outcome=error）。故可配置性用不伤基础设施的 urllib 演示。
    """
    monkeypatch.setattr(settings, "sandbox_blocked_imports", ["urllib"], raising=False)
    r = run_python_answer("def test_u():\n    import urllib\n")
    assert r.outcome == "failed"
    assert any("urllib" in (c[2] or "") for c in r.cases)


def test_blocked_imports_does_not_break_normal_code(monkeypatch):
    """正常代码（csv/datetime）不被黑名单误伤。"""
    r = run_python_answer(
        "import csv\n"
        "from datetime import datetime\n"
        "def test_ok():\n"
        "    assert datetime(2024, 1, 1).year == 2024\n"
    )
    assert r.outcome == "passed"


def test_compose_harness_renders_prologue_and_respects_switches(monkeypatch):
    """prologue 被注入、占位符被正确渲染、网络关闭时桩段被跳过。"""
    monkeypatch.setattr(settings, "sandbox_network_isolation", False, raising=False)
    monkeypatch.setattr(settings, "sandbox_blocked_imports", ["evilmod"], raising=False)
    monkeypatch.setattr(settings, "sandbox_peak_mem", True, raising=False)
    src = _compose_harness("print('BASE_MARKER')\n")
    assert "BASE_MARKER" in src
    assert "frozenset({'evilmod'})" in src
    assert "if False:" in src  # 网络关闭 → socket 桩段被 False 跳过


def test_compose_harness_filters_dirty_blocked_names(monkeypatch):
    """脏名单项（数字开头 / 带点 / 空串）被丢弃，绝不注入任意代码。"""
    monkeypatch.setattr(
        settings,
        "sandbox_blocked_imports",
        ["ok", "123bad", "has.dot", "", "also_ok"],
        raising=False,
    )
    src = _compose_harness("")
    assert "'ok'" in src and "'also_ok'" in src
    assert "123bad" not in src and "has.dot" not in src


# ======================================================================
# 3. 输出上限
# ======================================================================
def test_output_cap_truncates_flood(monkeypatch):
    """候选 print 洪水（夹具路径，输出直达 proc.stdout）被截断，output_capped=True。"""
    flood = 'def merge_orders(a, b):\n    print("X" * (5 * 1024 * 1024))\n    return []\n'
    r = run_python_answer(flood, task_id="code_csv_merge")
    assert r.output_capped is True


def test_output_cap_off_for_normal_output(monkeypatch):
    r = run_python_answer("def test_ok():\n    print('small')\n    assert True\n")
    assert r.output_capped is False


def test_output_cap_is_configurable(monkeypatch):
    """把上限调到 1024，夹具路径 5000 字节输出即被截断。"""
    monkeypatch.setattr(settings, "sandbox_max_output_bytes", 1024, raising=False)
    flood = 'def merge_orders(a, b):\n    print("X" * 5000)\n    return []\n'
    r = run_python_answer(flood, task_id="code_csv_merge")
    assert r.output_capped is True


def test_drain_into_caps_at_limit():
    """_drain_into 单流读到上限即停，超出部分丢弃。"""
    pipe = io.BytesIO(b"X" * 10000)
    holder: list = []
    _drain_into(pipe, 1024, holder)
    out, capped = holder[0]
    assert len(out) == 1024
    assert capped is True


# ======================================================================
# 4. 峰值内存
# ======================================================================
def test_peak_mem_collected_on_normal_run():
    r = run_python_answer("def test_ok():\n    assert sum(range(1000)) == 499500\n")
    assert r.outcome == "passed"
    assert r.peak_mem_mb is not None
    assert r.peak_mem_mb > 0


def test_peak_mem_none_when_disabled(monkeypatch):
    monkeypatch.setattr(settings, "sandbox_peak_mem", False, raising=False)
    r = run_python_answer("def test_ok():\n    assert True\n")
    assert r.peak_mem_mb is None


def test_to_dict_includes_new_fields():
    r = run_python_answer("def test_ok():\n    assert True\n")
    d = r.to_dict()
    assert "peakMemMb" in d
    assert "outputCapped" in d
    assert d["outputCapped"] is False


# ======================================================================
# 5. OOM 独立 outcome
# ======================================================================
def test_is_oom_posix_sigkill_with_memoryerror():
    """POSIX：被信号杀（rc<0）且 stderr 带 MemoryError → oom。"""
    assert _is_oom(-9, "", "Traceback (most recent call last):\nMemoryError") is True


def test_is_oom_posix_sigkill_empty_output():
    """POSIX：被信号杀且无任何输出（RLIMIT_AS 强杀常不留 traceback）→ oom。"""
    assert _is_oom(-9, "", "") is True


def test_is_oom_sigkill_with_normal_output_is_not_oom():
    """被信号杀但输出是普通断言错误 → 不算 oom（归 failed/error）。"""
    assert _is_oom(-11, "", "AssertionError: boom") is False


def test_is_oom_caught_memoryerror_is_not_oom():
    """被 harness 捕获成 CASE_FAIL 的 MemoryError 是普通失败，不是 oom。"""
    assert _is_oom(1, "done", "CASE_FAIL t :: MemoryError: out of memory") is False


def test_is_oom_import_memoryerror_is_oom():
    """导入期未捕获的 MemoryError → 进程没跑完就因内存挂了 → oom。"""
    assert _is_oom(3, "import_error", "HARNESS_IMPORT_ERROR MemoryError") is True


def test_is_oom_clean_exit_is_not_oom():
    assert _is_oom(0, "done", "HARNESS_DONE total=1 failed=0") is False


def test_oom_outcome_mapped_from_spawn(monkeypatch):
    """mock _spawn_and_wait 返回 OOM 特征 → run_python_answer 归为 oom（确定性端到端）。

    为何 mock 而非真实分配：本机可用 commit 内存波动，真实 300MB 分配时而成功
    时而 MemoryError，非确定；_is_oom 逻辑已由上面单测钉死，这里只验 outcome 映射。
    """
    import app.sandbox.runner as runner_mod

    def fake_spawn(*_a, **_k):
        return _SpawnResult(
            returncode=-9, stdout=b"", stderr=b"MemoryError\n",
            peak_mem_mb=None, timed_out=False, output_capped=False,
        )

    monkeypatch.setattr(runner_mod, "_spawn_and_wait", fake_spawn)
    r = run_python_answer("def test_never():\n    assert False\n")
    assert r.outcome == "oom"
    assert r.reason == "memory limit exceeded"
    # oom 是负面事实，绝不抬权
    assert verified_evidence_for("t", r) == {}


def test_timeout_is_distinct_from_oom(monkeypatch):
    """超时归 failed/timeout，绝不误判为 oom。"""
    import app.sandbox.runner as runner_mod

    def fake_spawn(*_a, **_k):
        return _SpawnResult(
            returncode=None, stdout=b"", stderr=b"",
            peak_mem_mb=None, timed_out=True, output_capped=False,
        )

    monkeypatch.setattr(runner_mod, "_spawn_and_wait", fake_spawn)
    r = run_python_answer("while True:\n    pass\ndef test_never():\n    assert True\n")
    assert r.outcome == "failed"
    assert r.reason == "timeout"
    assert r.outcome != "oom"
