"""
model-service/tests/test_security_scan.py
静态安全扫描的单测。

守的核心命题：**功能正确 ≠ 安全**。
一段 eval(user_input) 可以通过所有单元测试，因此 code_security 必须有
一条与「跑测试」完全独立的证据链。这些用例逐条钉死规则表的行为，
保证「已扫描」不是一句注释。
"""
from __future__ import annotations

import pytest

from app.config import settings
from app.sandbox import (
    scan_python_answer,
    scan_source_ast,
    security_evidence_for,
)


@pytest.fixture(autouse=True)
def _enable(monkeypatch):
    monkeypatch.setattr(settings, "sandbox_enabled", True, raising=False)


def rules(src: str):
    return {f.rule for f in scan_source_ast(src).findings}


def test_eval_and_exec_are_high_severity():
    result = scan_source_ast("def f(s):\n    return eval(s)\n")
    assert result.outcome == "scanned"
    assert result.high == 1
    assert result.findings[0].rule == "dangerous-call:eval"
    assert result.findings[0].line == 2


def test_os_system_command_injection():
    assert "dangerous-call:os.system" in rules("import os\nos.system('ls ' + name)\n")


def test_subprocess_shell_true_flagged_but_shell_false_is_clean():
    assert "subprocess-shell-true" in rules(
        "import subprocess\nsubprocess.run(cmd, shell=True)\n"
    )
    # shell=False 是推荐写法，不该误报——误报会让扫描结论失去可信度
    assert "subprocess-shell-true" not in rules(
        "import subprocess\nsubprocess.run(['ls', '-l'], shell=False)\n"
    )
    assert "subprocess-shell-true" not in rules("import subprocess\nsubprocess.run(['ls'])\n")


def test_pickle_and_yaml_deserialization():
    assert "dangerous-call:pickle.loads" in rules("import pickle\npickle.loads(blob)\n")
    assert "dangerous-call:yaml.load" in rules("import yaml\nyaml.load(text)\n")


def test_tls_verify_disabled():
    assert "tls-verify-disabled" in rules("import requests\nrequests.get(url, verify=False)\n")


def test_hardcoded_secret():
    assert "hardcoded-secret" in rules('api_key = "sk-1234567890"\n')
    # 从环境变量读取是正确姿势，不得误报
    assert "hardcoded-secret" not in rules('import os\napi_key = os.getenv("API_KEY")\n')


def test_path_traversal_hint_on_variable_join():
    assert "path-join-unnormalized" in rules("import os\np = os.path.join(base, user_input)\n")
    # 全常量拼接没有穿越风险
    assert "path-join-unnormalized" not in rules("import os\np = os.path.join('a', 'b')\n")


def test_silent_except_is_low_severity():
    result = scan_source_ast("try:\n    risky()\nexcept Exception:\n    pass\n")
    assert [f.rule for f in result.findings] == ["silent-except"]
    assert result.high == 0


def test_clean_code_yields_zero_findings_but_still_counts_as_scanned():
    result = scan_source_ast("def add(a, b):\n    return a + b\n")
    assert result.outcome == "scanned"
    assert result.findings == []
    # 「零发现」也是证据：记录的是「扫过、没扫出高危」这个事实
    assert "0 处高危" in result.evidence_text()
    assert security_evidence_for("t", result) != {}


def test_findings_sorted_by_severity():
    src = "try:\n    pass\nexcept Exception:\n    pass\n\nresult = eval(x)\n"
    result = scan_source_ast(src)
    assert result.findings[0].severity == "high"


def test_syntax_error_gives_no_security_conclusion():
    """代码都解析不了，就不该冒充扫过——宁缺毋滥。"""
    result = scan_source_ast("def broken(:\n    pass\n")
    assert result.outcome == "syntax_error"
    assert result.verifiable is False
    assert security_evidence_for("t", result) == {}


def test_no_code_and_disabled_produce_no_evidence(monkeypatch):
    assert scan_python_answer("我会注意安全问题，做好鉴权和限流。").outcome == "no_code"
    monkeypatch.setattr(settings, "sandbox_enabled", False, raising=False)
    assert scan_python_answer("```python\nx = 1\n```").outcome == "disabled"


def test_scan_and_run_see_the_same_code():
    """扫的和跑的必须是同一段代码，否则两条证据链对不上号。"""
    answer = "```python\nimport os\n\ndef test_ok():\n    assert True\n\nos.system('echo hi')\n```"
    scan = scan_python_answer(answer)
    assert scan.outcome == "scanned"
    assert scan.high >= 1


def test_evidence_text_is_human_checkable():
    result = scan_source_ast("x = eval(s)\n")
    text = result.evidence_text()
    assert "静态扫描" in text and "高危" in text and "L1" in text


# ----------------------------------------------------------------------
# 新增规则：每条至少一个正例（检出）+ 一个反例（不误报）
# ----------------------------------------------------------------------
def test_direct_socket_import_is_medium():
    assert "direct-socket" in rules("import socket\ns = socket.socket()\n")
    # from socket import ... 同样算裸 socket 使用
    assert "direct-socket" in rules("from socket import socket, AF_INET\n")
    # 不碰 socket 就不该报
    assert "direct-socket" not in rules("import sockets\n")  # 别的模块
    assert "direct-socket" not in rules("def add(a, b):\n    return a + b\n")


def test_weak_hash_md5_and_sha1_are_medium():
    assert "weak-hash:md5" in rules("import hashlib\nhashlib.md5(data)\n")
    assert "weak-hash:sha1" in rules("import hashlib\nhashlib.sha1(data)\n")
    # 强哈希不误报
    assert "weak-hash:sha1" not in rules("import hashlib\nhashlib.sha256(data)\n")
    assert "weak-hash:md5" not in rules("import hashlib\nhashlib.sha256(data)\n")
    # hashlib 仅导入、未调用弱哈希，不误报
    assert "weak-hash:md5" not in rules("import hashlib\nx = hashlib.sha256\n")


def test_file_write_variable_path_is_medium():
    assert "file-write-variable-path" in rules("open(user_path, 'w')\n")
    assert "file-write-variable-path" in rules("open(user_path, 'a')\n")
    # 常量路径写文件没有穿越风险，不误报
    assert "file-write-variable-path" not in rules("open('/tmp/out.txt', 'w')\n")
    # 只读模式即便路径是变量也不报
    assert "file-write-variable-path" not in rules("open(user_path, 'r')\n")


def test_ffi_usage_is_high():
    assert "ffi-usage" in rules("import ctypes\n")
    assert "ffi-usage" in rules("import cffi\n")
    assert "ffi-usage" in rules("from ctypes import cdll\n")
    # 普通模块不误报
    assert "ffi-usage" not in rules("import math\n")


def test_assert_on_tuple_is_high():
    # 非空元组恒真，assert 永不触发
    result = scan_source_ast("def f(a, b):\n    assert (a, b)\n")
    assert "assert-on-tuple" in {f.rule for f in result.findings}
    assert result.high >= 1
    # 正常断言不误报（括号只是分组，不是元组）
    assert "assert-on-tuple" not in rules("assert (a > 0)\n")
    assert "assert-on-tuple" not in rules("assert x is not None\n")


def test_bare_except_continued_is_low():
    src = "for i in items:\n    try:\n        f(i)\n    except Exception:\n        continue\n"
    result = scan_source_ast(src)
    assert "bare-except-continued" in {f.rule for f in result.findings}
    assert result.high == 0  # 仍是 low
    # return 版本同理
    assert "bare-except-continued" in rules(
        "def g():\n    try:\n        f()\n    except Exception:\n        return\n"
    )
    # except: pass 走 silent-except，不被重复判为 bare-except-continued
    assert "bare-except-continued" not in rules("try:\n    f()\nexcept Exception:\n    pass\n")
    # 带日志的 except 不误报（这里用显式 pass + 注释外的语句，只要不是单跳转就不报）
    assert "bare-except-continued" not in rules(
        "try:\n    f()\nexcept Exception:\n    logger.error('x')\n"
    )


def test_rule_count_matches_declared_rules():
    """规则表新增后，RULE_COUNT 必须与实际规则块数一致（证据文本可核对）。"""
    from app.sandbox.security_scan import RULE_COUNT

    # 每条新规则至少触发一次，确保 rules_checked 里都数到了
    src = (
        "import socket\n"
        "import ctypes\n"
        "import hashlib\n"
        "def f(a, b):\n"
        "    assert (a, b)\n"
        "    open(p, 'w')\n"
        "    hashlib.md5(b'')\n"
        "    hashlib.sha1(b'')\n"
        "for i in x:\n"
        "    try:\n"
        "        pass\n"
        "    except Exception:\n"
        "        continue\n"
    )
    result = scan_source_ast(src)
    assert result.outcome == "scanned"
    assert result.rules_checked == RULE_COUNT
    # 新规则名都应出现
    got = {f.rule for f in result.findings}
    assert {
        "direct-socket",
        "ffi-usage",
        "weak-hash:md5",
        "weak-hash:sha1",
        "file-write-variable-path",
        "assert-on-tuple",
        "bare-except-continued",
    } <= got
