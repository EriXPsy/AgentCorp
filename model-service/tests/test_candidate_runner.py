"""
model-service/tests/test_candidate_runner.py

跑题通道（A2/A3）单测：
1. text 通道 —— 直接回传 answer；空 answer 抛 CandidateRunError
2. gateway 通道 —— 未配置时 available=False；未知通道抛错
3. run_candidate 分发 —— candidate.channel 覆盖全局配置
"""
import io
import json
import os
import sys
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from app.candidate_runner import (  # noqa: E402
    CandidateRunError,
    GatewayCandidateRunner,
    TextCandidateRunner,
    build_runner,
    run_candidate,
)


def test_text_runner_returns_answer():
    runner = TextCandidateRunner()
    assert runner.available is True
    result = runner.run("题面", {"answer": " 我是答案 "})
    assert result.text == "我是答案"
    assert result.channel == "text"


def test_text_runner_rejects_empty_answer():
    runner = TextCandidateRunner()
    with pytest.raises(CandidateRunError):
        runner.run("题面", {"answer": "   "})
    with pytest.raises(CandidateRunError):
        runner.run("题面", {})


def test_gateway_runner_available_requires_config():
    runner = GatewayCandidateRunner(base_url="", model="")
    assert runner.available is False
    runner2 = GatewayCandidateRunner(base_url="http://127.0.0.1:8000", model="m")
    assert runner2.available is True


def test_unknown_channel_raises():
    with pytest.raises(CandidateRunError):
        build_runner("nope")


def test_run_candidate_dispatches_by_channel():
    # candidate.channel 显式 text，即使全局默认是 gateway 也走 text
    result = run_candidate("题面", {"channel": "text", "answer": "ok"})
    assert result.channel == "text"


def test_gateway_runner_available_with_settings(monkeypatch):
    # 未配置 GATEWAY_BASE_URL 时，gateway 通道应报「不可用」
    monkeypatch.setattr("app.config.settings.candidate_channel", "gateway")
    monkeypatch.setattr("app.config.settings.gateway_base_url", "")
    monkeypatch.setattr("app.config.settings.gateway_model", "")
    with pytest.raises(CandidateRunError):
        run_candidate("题面", {"channel": "gateway"})


# ---------- 追加：未覆盖的错误路径 ----------


def test_text_empty_answer_error_message():
    """text 通道空 answer（空串 / 缺失键）均报错，且信息含「非空」。"""
    runner = TextCandidateRunner()
    with pytest.raises(CandidateRunError, match="非空"):
        runner.run("题面", {"answer": ""})
    with pytest.raises(CandidateRunError, match="非空"):
        runner.run("题面", {})


def test_gateway_run_rejects_missing_url_or_model():
    """gateway 通道缺 endpoint/model（或全局 base_url/model）时 run 报错。"""
    # 全局缺 base_url 且候选未给 endpoint → url 为空
    runner = GatewayCandidateRunner(base_url="", model="m")
    with pytest.raises(CandidateRunError, match="base_url"):
        runner.run("题面", {})
    # 全局缺 model 且候选未给 model
    runner2 = GatewayCandidateRunner(base_url="http://x", model="")
    with pytest.raises(CandidateRunError, match="model"):
        runner2.run("题面", {})
    # 候选引用也未补齐 → 仍报错
    with pytest.raises(CandidateRunError):
        runner2.run("题面", {"endpoint": "", "model": ""})


def test_gateway_run_http_error(monkeypatch):
    """gateway 上游返回非 2xx → CandidateRunError 带状态码。"""
    runner = GatewayCandidateRunner(base_url="http://x", model="m")

    def _raise(*a, **kw):
        raise urllib.error.HTTPError(
            "http://x/chat/completions",
            500,
            "boom",
            {},
            io.BytesIO(b'{"error": "upstream fail"}'),
        )

    monkeypatch.setattr("urllib.request.urlopen", _raise)
    with pytest.raises(CandidateRunError, match="500"):
        runner.run("题面", {})


def test_gateway_run_unreachable(monkeypatch):
    """gateway 网络不可达（URLError/TimeoutError/OSError）→ CandidateRunError。"""
    runner = GatewayCandidateRunner(base_url="http://x", model="m")

    for exc in (
        urllib.error.URLError("conn refused"),
        TimeoutError("timed out"),
        OSError("network down"),
    ):
        def _raise(*a, _e=exc, **kw):
            raise _e

        monkeypatch.setattr("urllib.request.urlopen", _raise)
        with pytest.raises(CandidateRunError, match="不可达"):
            runner.run("题面", {})


def test_gateway_run_malformed_response(monkeypatch):
    """gateway 响应缺 choices/message/content → CandidateRunError「结构异常」。"""
    runner = GatewayCandidateRunner(base_url="http://x", model="m")

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"unexpected": true}'

    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **kw: _Resp())
    with pytest.raises(CandidateRunError, match="结构异常"):
        runner.run("题面", {})


def test_gateway_run_success_parses_content(monkeypatch):
    """gateway 正常响应 → 解析 content、回填 channel 与 latency。"""
    runner = GatewayCandidateRunner(base_url="http://x", model="m")
    body = json.dumps(
        {"choices": [{"message": {"content": "候选答案"}}]}
    ).encode("utf-8")

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return body

    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **kw: _Resp())
    result = runner.run("题面", {})
    assert result.text == "候选答案"
    assert result.channel == "gateway"
    assert result.latency_ms >= 0.0


def test_channel_name_case_insensitive():
    """通道名大小写归一：build_runner / run_candidate 接受大写，与 SUPPORTED_CHANNELS 对齐。"""
    from app.routes.arena import SUPPORTED_CHANNELS

    assert SUPPORTED_CHANNELS == {"text", "gateway"}
    # build_runner 大写通道名
    assert isinstance(build_runner("TEXT"), TextCandidateRunner)
    assert isinstance(build_runner("Gateway"), GatewayCandidateRunner)
    # run_candidate 大写 channel 走 text
    result = run_candidate("题面", {"channel": "TEXT", "answer": "ok"})
    assert result.channel == "text"
    # 未知通道（归一化后）仍报错，且信息含归一化后的名字
    with pytest.raises(CandidateRunError, match="text2"):
        build_runner("TEXT2")


def test_candidate_run_error_messages():
    """CandidateRunError 信息可辨识：未知通道 / 通道不可用。"""
    # 未知通道信息含通道名
    with pytest.raises(CandidateRunError, match="未知跑题通道：nope"):
        build_runner("nope")
    # run_candidate 通道不可用信息含通道名
    with pytest.raises(CandidateRunError, match="不可用"):
        run_candidate("题面", {"channel": "gateway"})
