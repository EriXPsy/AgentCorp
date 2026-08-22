"""
model-service/tests/test_sandbox_config.py
「超级全面沙箱」配置项的单测。

守的命题：配置契约（字段名 + 默认值 + 解析方式）必须被钉死，因为 runner.py
通过 getattr(settings, name, default) 按名字消费这些字段 —— 改名、默认值漂移、
或脏输入让 Settings() 构造崩溃，都会静默破坏沙箱加固。
"""
from __future__ import annotations

import os

import pytest

from app.config import Settings


def _fresh(**env) -> Settings:
    """用给定环境变量构造一个全新的 Settings（覆盖现有 os.environ 键）。

    注意：不清理未涉及的键 —— 各用例只断言自己关心的字段，
    其余字段沿用宿主机既有环境即可，避免互相干扰。
    """
    for k, v in env.items():
        os.environ[k] = v
    return Settings()


def _clear(*keys) -> None:
    for k in keys:
        os.environ.pop(k, None)


# ---------- 1. sandbox_network_isolation ----------


def test_network_isolation_default_true():
    _clear("SANDBOX_NETWORK_ISOLATION")
    s = _fresh()
    assert s.sandbox_network_isolation is True


@pytest.mark.parametrize("val", ["false", "0", "no", "FALSE", "No"])
def test_network_isolation_env_disables(val):
    s = _fresh(SANDBOX_NETWORK_ISOLATION=val)
    assert s.sandbox_network_isolation is False


@pytest.mark.parametrize("val", ["true", "1", "yes", "TRUE"])
def test_network_isolation_env_enables(val):
    s = _fresh(SANDBOX_NETWORK_ISOLATION=val)
    assert s.sandbox_network_isolation is True


# ---------- 2. sandbox_max_output_bytes ----------


def test_max_output_bytes_default():
    _clear("SANDBOX_MAX_OUTPUT_BYTES")
    s = _fresh()
    assert s.sandbox_max_output_bytes == 2_000_000


def test_max_output_bytes_env_override():
    s = _fresh(SANDBOX_MAX_OUTPUT_BYTES="4096")
    assert s.sandbox_max_output_bytes == 4096


# ---------- 3. sandbox_blocked_imports ----------


def test_blocked_imports_default_list():
    _clear("SANDBOX_BLOCKED_IMPORTS")
    s = _fresh()
    assert s.sandbox_blocked_imports == [
        "socket",
        "subprocess",
        "ctypes",
        "cffi",
        "multiprocessing",
        "pickle",
    ]


def test_blocked_imports_env_parses_and_strips():
    s = _fresh(SANDBOX_BLOCKED_IMPORTS=" socket , os ,  sys ")
    assert s.sandbox_blocked_imports == ["socket", "os", "sys"]


def test_blocked_imports_empty_string_falls_back_to_default():
    # 空字符串 → 回退默认（安全白名单不能被清空成 []）
    s = _fresh(SANDBOX_BLOCKED_IMPORTS="")
    assert s.sandbox_blocked_imports == [
        "socket",
        "subprocess",
        "ctypes",
        "cffi",
        "multiprocessing",
        "pickle",
    ]


def test_blocked_imports_dirty_input_degrades_to_default():
    # 脏输入：只有逗号/空白 → 回退默认，不崩溃
    s = _fresh(SANDBOX_BLOCKED_IMPORTS=" , , ,  ")
    assert s.sandbox_blocked_imports == [
        "socket",
        "subprocess",
        "ctypes",
        "cffi",
        "multiprocessing",
        "pickle",
    ]


def test_blocked_imports_returns_list_not_alias():
    # 返回的是独立 list，修改它不会污染默认常量
    _clear("SANDBOX_BLOCKED_IMPORTS")
    s = _fresh()
    s.sandbox_blocked_imports.append("evil")
    s2 = _fresh()
    assert "evil" not in s2.sandbox_blocked_imports


# ---------- 4. sandbox_peak_mem ----------


def test_peak_mem_default_true():
    _clear("SANDBOX_PEAK_MEM")
    s = _fresh()
    assert s.sandbox_peak_mem is True


def test_peak_mem_env_disables():
    s = _fresh(SANDBOX_PEAK_MEM="false")
    assert s.sandbox_peak_mem is False


# ---------- 5. sandbox_per_task_timeout ----------


def test_per_task_timeout_default_empty_dict():
    _clear("SANDBOX_TASK_TIMEOUTS")
    s = _fresh()
    assert s.sandbox_per_task_timeout == {}


def test_per_task_timeout_env_parses_dict():
    s = _fresh(SANDBOX_TASK_TIMEOUTS="task_a:30,task_b:60")
    assert s.sandbox_per_task_timeout == {"task_a": 30, "task_b": 60}


def test_per_task_timeout_strips_whitespace():
    s = _fresh(SANDBOX_TASK_TIMEOUTS=" task_a : 30 , task_b:60 ")
    assert s.sandbox_per_task_timeout == {"task_a": 30, "task_b": 60}


def test_per_task_timeout_dirty_input_degrades():
    # 脏条目（缺冒号 / value 非整数 / 空 key）被跳过，合法条目保留，不崩溃
    s = _fresh(SANDBOX_TASK_TIMEOUTS="good:10,badpair,no_colon,:,x:abc, ok : 5 ")
    assert s.sandbox_per_task_timeout == {"good": 10, "ok": 5}


def test_per_task_timeout_empty_string_is_empty_dict():
    s = _fresh(SANDBOX_TASK_TIMEOUTS="")
    assert s.sandbox_per_task_timeout == {}


# ---------- 6. sandbox_windows_job_mem_mb ----------


def test_windows_job_mem_default_tracks_sandbox_mem_mb():
    _clear("SANDBOX_WIN_JOB_MEM_MB")
    _clear("SANDBOX_MEM_MB")
    s = _fresh()
    assert s.sandbox_windows_job_mem_mb == s.sandbox_mem_mb == 512


def test_windows_job_mem_default_tracks_overridden_sandbox_mem():
    # 未显式设 WIN_JOB_MEM_MB 时，跟随 sandbox_mem_mb 的取值
    _clear("SANDBOX_WIN_JOB_MEM_MB")
    s = _fresh(SANDBOX_MEM_MB="1024")
    assert s.sandbox_mem_mb == 1024
    assert s.sandbox_windows_job_mem_mb == 1024


def test_windows_job_mem_explicit_overrides_default():
    _clear("SANDBOX_MEM_MB")
    s = _fresh(SANDBOX_WIN_JOB_MEM_MB="256")
    assert s.sandbox_windows_job_mem_mb == 256
