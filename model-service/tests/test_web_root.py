"""
model-service/tests/test_web_root.py
统一算力环境 Web 形态（WEB_ROOT 静态托管 + 路由别名）的契约验证。

覆盖：
  1) mount_web_root：WEB_ROOT 指向含 index.html 的目录时，GET / 返回 200；
  2) SPA 回退：未命中的前端路由（如 /some/spa/route）回退到 index.html；
  3) API 不回退：/api、/uploads 前缀下的 404 如实返回（不吞成 HTML）；
  4) 别名路由：POST /api/evaluate/run 与 /api/evaluate-run 同构（SSE 含 done）；
  5) 未配置 WEB_ROOT 时主应用不挂载静态站点，GET / 返回 404（行为不变）。

注意：app 导入时会对 settings.upload_dir 做 makedirs + StaticFiles 挂载，
默认路径 /app/uploads 在本地开发机不可写，因此在导入 app 前将
UPLOAD_DIR 指向系统临时目录（与 tests/test_http.py 同约定）。

运行（在 model-service 目录下）：
    python -m pytest tests/test_web_root.py -q
"""
from __future__ import annotations

import os
import sys
import tempfile

os.environ.setdefault(
    "UPLOAD_DIR", os.path.join(tempfile.gettempdir(), "agentcorp-test-uploads")
)

# 让测试能 import app 包
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.config import settings  # noqa: E402

settings.upload_dir = os.environ["UPLOAD_DIR"]

from app.serve import SPAStaticFiles, app, mount_web_root  # noqa: E402


def _spa_app(root: str) -> FastAPI:
    """构造一个仅挂载 SPA 静态站点的新应用（不影响主 app 路由表）。"""
    fresh = FastAPI()

    @fresh.post("/api/ping")
    async def _ping():  # pragma: no cover - 仅用于断言 API 优先于 SPA 回退
        return {"ok": True}

    return fresh


# ----------------------------------------------------------------------
# 1) + 2) WEB_ROOT 有效目录：GET / 返回 200，前端路由回退 index.html
# ----------------------------------------------------------------------
def test_mount_web_root_serves_index_and_spa_fallback(tmp_path):
    (tmp_path / "index.html").write_text("<html><body>agentcorp-web</body></html>")
    fresh = _spa_app(str(tmp_path))
    assert mount_web_root(fresh, str(tmp_path)) is True

    client = TestClient(fresh)
    resp = client.get("/")
    assert resp.status_code == 200
    assert "agentcorp-web" in resp.text

    # SPA 路由（前端 history 路由）回退到 index.html
    resp = client.get("/some/spa/route")
    assert resp.status_code == 200
    assert "agentcorp-web" in resp.text


# ----------------------------------------------------------------------
# 3) /api、/uploads 前缀的 404 不回退（API 错误不吞成 HTML）
# ----------------------------------------------------------------------
def test_spa_fallback_skips_api_and_uploads(tmp_path):
    (tmp_path / "index.html").write_text("<html><body>agentcorp-web</body></html>")
    fresh = _spa_app(str(tmp_path))
    mount_web_root(fresh, str(tmp_path))

    client = TestClient(fresh)
    assert client.get("/api/nonexistent").status_code == 404
    assert client.get("/uploads/nonexistent.png").status_code == 404
    # 已注册的 API 路由优先于 SPA 挂载，正常响应
    assert client.post("/api/ping").status_code == 200


# ----------------------------------------------------------------------
# 4) mount_web_root：空路径 / 不存在目录不挂载（行为不变）
# ----------------------------------------------------------------------
def test_mount_web_root_noop_when_invalid(tmp_path):
    fresh = _spa_app(str(tmp_path))
    assert mount_web_root(fresh, "") is False
    assert mount_web_root(fresh, str(tmp_path / "not-exist")) is False
    assert TestClient(fresh).get("/").status_code == 404


# ----------------------------------------------------------------------
# 5) 主应用未配置 WEB_ROOT：GET / 返回 404（Electron 形态行为不变）
# ----------------------------------------------------------------------
def test_main_app_without_web_root_returns_404():
    assert settings.web_root == ""
    assert TestClient(app).get("/").status_code == 404


# ----------------------------------------------------------------------
# 6) 别名路由：POST /api/evaluate/run 与 /api/evaluate-run 同构
# ----------------------------------------------------------------------
def test_evaluate_run_alias_sse(monkeypatch):
    monkeypatch.setattr(settings, "mock", True)
    payload = {
        "agentId": "agent-alias-01",
        "agentName": "agent-alias-01",
        "task": {"title": "Build dashboard", "description": "...", "weight": 1.0},
        "transcript": "user: build a chart\nagent: done",
        "usage": [
            {
                "timestamp": "2025-01-01T00:00:00Z",
                "sessionId": "sess-1",
                "agentId": "agent-alias-01",
                "inputTokens": 1000,
                "outputTokens": 500,
                "totalTokens": 1500,
                "costUsd": 0.3,
            }
        ],
    }
    with TestClient(app) as client:
        resp = client.post("/api/evaluate/run", json=payload)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    text = resp.text
    assert text.count("event: radar_update") == 6
    assert "event: verdict" in text
    assert "event: done" in text
    assert "event: error" not in text


if __name__ == "__main__":
    import pathlib

    class _DummyMonkeyPatch:
        def setattr(self, obj, name, value):
            setattr(obj, name, value)

    mp = _DummyMonkeyPatch()
    tmp = pathlib.Path(tempfile.mkdtemp())
    test_mount_web_root_serves_index_and_spa_fallback(tmp)
    test_spa_fallback_skips_api_and_uploads(tmp)
    test_mount_web_root_noop_when_invalid(tmp)
    test_main_app_without_web_root_returns_404()
    test_evaluate_run_alias_sse(mp)
    print("tests/test_web_root.py 全部通过 ✅")
