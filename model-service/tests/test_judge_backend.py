"""
model-service/tests/test_judge_backend.py

推理后端单测（thinking-trace 采集）：
1. split_thinking —— 剥离 <think>...</think> 为 (content, reasoning) 的纯函数铁律
2. HttpJudgeBackend —— 从 message.reasoning_content 捕获思维链
3. LocalJudgeBackend —— 内联 <think> 段抽取为 reasoning，正文交下游解析
4. 链路 —— craft_judge.judge_craft_task 把 reasoning 透传到 CraftJudgement

运行：python -m pytest tests/test_judge_backend.py -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json  # noqa: E402

import pytest  # noqa: E402

from app.judge_backend import (  # noqa: E402
    HttpJudgeBackend,
    JudgeCompletion,
    LocalJudgeBackend,
    MockJudgeBackend,
    split_thinking,
)


# ----------------------------------------------------------------------
# 1) split_thinking 纯函数
# ----------------------------------------------------------------------
def test_split_thinking_no_block_returns_content_and_empty_reasoning():
    content, reasoning = split_thinking('{"dims": {}, "fit": 3.0}')
    assert content == '{"dims": {}, "fit": 3.0}'
    assert reasoning == ""


def test_split_thinking_separates_reasoning_from_json():
    raw = (
        "<think>我需要先看候选是否兑现了要点。</think>\n"
        '{"dims": {"code_runnability": 4.0}, "fit": 3.5, "confidence": 0.8}'
    )
    content, reasoning = split_thinking(raw)
    # 正文只剩 JSON，思考段被剥离
    assert content.startswith('{"dims"')
    assert "<think>" not in content
    assert "候选是否兑现" in reasoning


def test_split_thinking_empty_input():
    assert split_thinking("") == ("", "")
    assert split_thinking(None) == ("", "")  # type: ignore[arg-type]


def test_split_thinking_multiline_reasoning():
    raw = "<think>第一行\n第二行\n第三行</think>剩余正文"
    content, reasoning = split_thinking(raw)
    assert "第一行" in reasoning and "第三行" in reasoning
    assert content == "剩余正文"


# ----------------------------------------------------------------------
# 2) HttpJudgeBackend 捕获 reasoning_content
# ----------------------------------------------------------------------
class _FakeResp:
    """最小 urllib 响应替身：context manager + read()。"""

    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_http_backend_captures_reasoning_content(monkeypatch):
    payload = {
        "choices": [
            {
                "message": {
                    "content": '{"dims": {}, "fit": 3.0}',
                    "reasoning_content": "我先分析需求，再对照要点。",
                }
            }
        ],
        "usage": {"total_tokens": 42},
    }

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        return _FakeResp(json.dumps(payload).encode("utf-8"))

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    backend = HttpJudgeBackend(base_url="http://x", model="m")
    completion = backend.complete([{"role": "user", "content": "hi"}])

    assert completion.text == '{"dims": {}, "fit": 3.0}'
    assert completion.reasoning == "我先分析需求，再对照要点。"
    assert completion.usage == {"total_tokens": 42}


def test_http_backend_missing_reasoning_is_empty(monkeypatch):
    """无 reasoning_content（未启用思考 / 端点不支持）时规范为空串。"""
    payload = {"choices": [{"message": {"content": "ok"}}]}

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        return _FakeResp(json.dumps(payload).encode("utf-8"))

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    backend = HttpJudgeBackend(base_url="http://x", model="m")
    completion = backend.complete([{"role": "user", "content": "hi"}])
    assert completion.reasoning == ""


# ----------------------------------------------------------------------
# 3) LocalJudgeBackend 内联思考段抽取
# ----------------------------------------------------------------------
class _FakeLocalModel:
    """替身：模型把思考段内联在 chat() 返回值里（Qwen3 系常见形态）。"""

    def __init__(self, output: str) -> None:
        self._output = output
        self.last_kwargs: dict = {}

    def chat(self, **kwargs):
        self.last_kwargs = kwargs
        return self._output


def _local_backend(output: str) -> LocalJudgeBackend:
    backend = LocalJudgeBackend(model_path="/fake", device="cpu")
    backend._model = _FakeLocalModel(output)
    backend._tokenizer = object()
    return backend


def test_local_backend_extracts_inline_thinking():
    output = '<think>分析要点。</think>\n{"dims": {"x": 4.0}, "fit": 3.0}'
    backend = _local_backend(output)
    completion = backend.complete([{"role": "user", "content": "评分"}])

    # 正文交给下游 _extract_json：只剩 JSON
    assert completion.text == '{"dims": {"x": 4.0}, "fit": 3.0}'
    assert "分析要点" in completion.reasoning
    assert "<think>" not in completion.text


def test_local_backend_no_thinking_reasoning_empty():
    backend = _local_backend('{"dims": {}, "fit": 2.0}')
    completion = backend.complete([{"role": "user", "content": "评分"}])
    assert completion.text == '{"dims": {}, "fit": 2.0}'
    assert completion.reasoning == ""


def test_local_backend_tuple_output_takes_first():
    """部分模型 chat() 返回 (text, meta) 元组，取首元素再剥思考段。"""
    backend = _local_backend(("<think>想</think>正文", {"meta": 1}))
    completion = backend.complete([{"role": "user", "content": "x"}])
    assert completion.text == "正文"
    assert completion.reasoning == "想"


def test_mock_backend_never_fakes_reasoning():
    backend = MockJudgeBackend()
    assert backend.available is False
    with pytest.raises(RuntimeError):
        backend.complete([{"role": "user", "content": "x"}])


# ----------------------------------------------------------------------
# 4) 链路：craft_judge 把 reasoning 透传到 CraftJudgement
# ----------------------------------------------------------------------
def test_craft_judge_threads_reasoning(monkeypatch):
    from app import judge_backend as jb
    from app.scoring import craft_judge

    class _StubBackend:
        name = "stub"

        @property
        def available(self) -> bool:
            return True

        def complete(self, messages, *, temperature=None, max_tokens=None, model=None):
            return JudgeCompletion(
                text='{"dims": {"code_runnability": 4.0}, '
                '"checkpoints": [], "padding": {"detected": false, "note": ""}, '
                '"confidence": 0.9}',
                backend="stub",
                reasoning="裁判推理：候选兑现了可运行性要点。",
            )

    monkeypatch.setattr(craft_judge, "get_backend", lambda *a, **k: _StubBackend())
    # code_csv_merge 是 craft_tasks 里的真实题目（target_dims 含 code_runnability）
    result = craft_judge.judge_craft_task("code_csv_merge", "我会写可运行代码和测试")
    assert result.reasoning == "裁判推理：候选兑现了可运行性要点。"
    assert result.backend == "stub"
    assert result.dims.get("code_runnability") == 4.0
