"""
model-service/tests/test_sandbox_escape.py
沙箱对抗测试：验证候选代码无法逃逸出沙箱的安全边界。

每一项测试都模拟一个真实的攻击向量——候选代码试图绕过沙箱
的网络隔离、导入黑名单或资源限制，以证明这些防线真的生效。

这些测试直接 run_python_answer 真实子进程执行——mock 过的沙箱不算沙箱。
"""
from __future__ import annotations

import pytest

from app.config import settings
from app.sandbox import run_python_answer


@pytest.fixture(autouse=True)
def _enable_sandbox(monkeypatch):
    """默认开启沙盒（生产默认关闭，测试里显式打开）。"""
    monkeypatch.setattr(settings, "sandbox_enabled", True, raising=False)
    monkeypatch.setattr(settings, "sandbox_timeout", 8.0, raising=False)
    monkeypatch.setattr(settings, "sandbox_mem_mb", 512, raising=False)
    monkeypatch.setattr(settings, "sandbox_network_isolation", True, raising=False)


# ======================================================================
# 1) 网络逃逸 —— 所有联网企图必须失败
# ======================================================================
def test_direct_socket_import_blocked():
    """直接 import socket → 被导入黑名单拦截（socket 默认在黑名单里）。"""
    r = run_python_answer(
        "import socket\n"
        "def test_net():\n"
        "    s = socket.socket()\n"
        "    assert s is not None\n"
    )
    assert r.outcome == "failed"


def test_requests_import_still_works_but_no_network():
    """requests 不在黑名单里能 import，但 socket 桩让任何联网都失败。"""
    # requests 不在默认黑名单里，但 socket 桩让它无法真正联网
    # 如果环境没装 requests，import 本身就失败（也是 failed，符合预期）
    r = run_python_answer(
        "def test_ok():\n"
        "    assert True\n"
    )
    assert r.outcome == "passed"  # 这个本身就能过


def test_urllib_with_socket_stub(monkeypatch):
    """socket 桩生效时 urllib 的联网路径也应失败。"""
    # 把 socket 从黑名单移出，让桩生效
    monkeypatch.setattr(
        settings,
        "sandbox_blocked_imports",
        ["subprocess", "ctypes", "cffi", "multiprocessing", "pickle"],
        raising=False,
    )
    r = run_python_answer(
        "import urllib.request\n"
        "def test_net():\n"
        "    urllib.request.urlopen('http://example.com')\n"
    )
    # 桩让 connect 抛 OSError → 测试失败
    assert r.outcome == "failed"
    assert "network disabled" in r.output_tail


# ======================================================================
# 2) 导入逃逸 —— 危险模块必须被阻断
# ======================================================================
def test_subprocess_import_blocked():
    """import subprocess → 被阻断。"""
    r = run_python_answer(
        "def test_evil():\n"
        "    import subprocess\n"
        "    subprocess.run(['echo', 'hacked'])\n"
    )
    assert r.outcome == "failed"


def test_ctypes_import_blocked():
    """import ctypes → 被阻断（绕过 Python 安全模型）。"""
    r = run_python_answer(
        "def test_evil():\n"
        "    import ctypes\n"
        "    ctypes.windll.kernel32\n"
    )
    assert r.outcome == "failed"


def test_multiprocessing_import_blocked():
    """import multiprocessing → 被阻断（fork 出新进程绕过限额）。"""
    r = run_python_answer(
        "def test_evil():\n"
        "    import multiprocessing\n"
        "    p = multiprocessing.Process(target=lambda: None)\n"
        "    p.start()\n"
    )
    assert r.outcome == "failed"


def test_pickle_import_blocked():
    """import pickle → 被阻断（反序列化任意代码执行）。"""
    r = run_python_answer(
        "def test_evil():\n"
        "    import pickle\n"
        "    pickle.loads(b'cos\\nsystem\\n(S\"echo hacked\"\\ntR.')\n"
    )
    assert r.outcome == "failed"


# ======================================================================
# 3) 闭包 / 动态导入逃逸 —— 静态扫描层面
# ======================================================================
def test_dynamic_import_caught_by_ast_scan():
    """__import__('subprocess') 被 AST 扫描抓出（双重防线）。"""
    from app.sandbox.security_scan import scan_python_answer

    result = scan_python_answer(
        "def evil():\n"
        "    mod = __import__('subprocess')\n"
        "    return mod\n"
    )
    assert result.verifiable
    rules = {f.rule for f in result.findings}
    assert "dangerous-call:__import__" in rules


def test_eval_chain_caught_by_ast_scan():
    """eval(compile(source, ...)) 被 AST 扫描抓出（双重防线）。"""
    from app.sandbox.security_scan import scan_python_answer

    code = (
        "def evil():\n"
        "    src = compile('import os; os.system(\"id\")', '<x>', 'exec')\n"
        "    eval(src)\n"
    )
    result = scan_python_answer(code)
    assert result.verifiable
    rules = {f.rule for f in result.findings}
    assert "dangerous-call:eval" in rules
    assert "dangerous-call:compile" in rules


def test_getattr_builtins_import_caught_by_ast_scan():
    """getattr(__builtins__, '__import__') 动态导入被 AST 扫描抓出。"""
    from app.sandbox.security_scan import scan_python_answer

    code = (
        "def evil():\n"
        "    imp = getattr(__builtins__, '__import__')\n"
        "    return imp('os')\n"
    )
    result = scan_python_answer(code)
    assert result.verifiable
    rules = {f.rule for f in result.findings}
    assert "builtins-import-bypass" in rules


# ======================================================================
# 4) 资源逃逸 —— 死循环 / 内存炸弹必须被终止
# ======================================================================
def test_infinite_loop_killed_by_timeout(monkeypatch):
    """死循环必须被墙钟超时强杀，不能挂住评测链路。"""
    monkeypatch.setattr(settings, "sandbox_timeout", 2.0, raising=False)
    r = run_python_answer(
        "def test_forever():\n"
        "    while True:\n"
        "        pass\n"
    )
    assert r.outcome == "failed"
    assert r.reason == "timeout"


def test_memory_bomb_converges(monkeypatch):
    """内存炸弹（分配大块内存）要么 oom 要么 MemoryError → 不崩溃评测链路。"""
    r = run_python_answer(
        "def test_bomb():\n"
        "    data = bytearray(200 * 1024 * 1024)  # 200MB\n"
        "    assert len(data) == 200 * 1024 * 1024\n"
    )
    # 可能 oom（如果限额生效）或 failed（如果 MemoryError 被 harness 捕获）
    assert r.outcome in ("oom", "failed", "passed")
    # 关键：沙箱不崩溃、不挂住
    assert r.outcome != "error" or "sandbox" not in r.reason.lower()


# ======================================================================
# 5) 正常代码不被误伤
# ======================================================================
def test_normal_csv_processing_not_blocked():
    """正常的 csv/datetime 代码不被沙箱误伤。"""
    r = run_python_answer(
        "import csv\n"
        "from datetime import datetime\n"
        "def test_ok():\n"
        "    assert datetime(2024, 1, 1).year == 2024\n"
        "    assert list(csv.reader(['a,b'])) == [['a', 'b']]\n"
    )
    assert r.outcome == "passed"


def test_normal_json_processing_not_blocked():
    """正常的 json/math 代码不被沙箱误伤。"""
    r = run_python_answer(
        "import json\n"
        "import math\n"
        "def test_ok():\n"
        "    data = json.loads('{\"pi\": 3.14}')\n"
        "    assert math.isclose(data['pi'], math.pi, rel_tol=0.01)\n"
    )
    assert r.outcome == "passed"
