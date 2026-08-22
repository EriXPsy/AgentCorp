"""
model-service/tests/test_upload.py
POST /api/upload 的输入校验契约：
  1) 正常 multipart 上传可落盘并返回 CandidateProfile（含媒体 URL）；
  2) 超 MAX_UPLOAD_BYTES 的文件 → 413；
  3) 扩展名不在白名单 → 415。

不依赖真实模型。upload_dir 指向系统临时目录（与 test_http.py 同理）。
"""
from __future__ import annotations

import os
import sys
import tempfile

# 先设 UPLOAD_DIR，再导入 app（serve.py import 期会 makedirs + 挂 StaticFiles）
os.environ.setdefault("UPLOAD_DIR", os.path.join(tempfile.gettempdir(), "agentcorp-test-uploads"))
# 放大上限便于构造“正常”用例；超限用例用很小的 env 另起进程不现实，改为直接喂超大字节
os.environ.setdefault("MAX_UPLOAD_BYTES", str(50 * 1024 * 1024))

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import settings  # noqa: E402

settings.upload_dir = os.environ["UPLOAD_DIR"]

from app.serve import app  # noqa: E402


def _client() -> TestClient:
    return TestClient(app)


def _files(video=("video.mp4", b"\x00\x00\x00\x1cftypisom" + b"\x00" * 64, "video/mp4"),
           voice=("voice.wav", b"RIFF" + b"\x00" * 40, "audio/wav"),
           code=("code.zip", b"PK\x03\x04" + b"\x00" * 32, "application/zip")):
    return [
        ("video", video),
        ("voice", voice),
        ("code", code),
    ]


def test_upload_happy_path():
    with _client() as client:
        resp = client.post(
            "/api/upload",
            data={"name": "琳达", "declared_tags": "code,text", "declared_budget": "200"},
            files=_files(),
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "琳达"
    assert body["id"].startswith("upload-")
    assert body["video_demo"]["url"].startswith("/uploads/upload-")
    assert body["code_repo"]["url"].endswith("code.zip")
    # 三个媒体 URL 非空
    assert body["video_demo"]["url"]
    assert body["voice_intro"]["url"]
    assert body["code_repo"]["url"]


def test_upload_rejects_disallowed_extension():
    bad = [("code", ("evil.exe", b"MZ" + b"\x00" * 32, "application/octet-stream"))]
    with _client() as client:
        resp = client.post(
            "/api/upload",
            data={"name": "x"},
            files=bad,
        )
    assert resp.status_code == 415, resp.text


def test_upload_rejects_oversize(monkeypatch):
    # 把上限压到 1KB，再上传超过该值的文件
    import app.routes.upload as upload_mod
    monkeypatch.setattr(upload_mod, "MAX_UPLOAD_BYTES", 1024)
    big = [("video", ("video.mp4", b"\x00" * 4096, "video/mp4"))]
    with _client() as client:
        resp = client.post(
            "/api/upload",
            data={"name": "x"},
            files=big,
        )
    assert resp.status_code == 413, resp.text
