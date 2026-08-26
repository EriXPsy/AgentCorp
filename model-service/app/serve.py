"""
model-service/app/serve.py
FastAPI 入口——仅应用装配。

路由按域拆分在 app/routes/ 包（APIRouter，纯搬运，行为不变）：
  samples.py      GET  /api/samples
  evaluate.py     POST /api/evaluate、POST /api/evaluate-run（SSE 事件流，
                        含收敛事件段与内嵌 Task-Set 调度）
  upload.py       POST /api/upload（multipart → CandidateProfile）
  convergence.py  /api/convergence/{trace,score,anchor} + 引擎进程内状态
                  （_TRACE_STORE / _TRACE_LOCK / _persist_convergence）
  leaderboard.py  POST /api/evaluate-stage、GET/PUT /api/rules、
                  GET /api/leaderboard、POST /api/preference
  health.py       GET  /health

设计：前后端彻底解耦，契约见 schemas.py 与前端 src/types/index.ts。
无 NPU 时若 MOCK=true 仍可运行；否则 /api/evaluate 返回 503 明确错误。
"""
from __future__ import annotations

import logging
import os

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import settings
from .routes import arena, convergence, designer_route, evaluate, growth, health, judge, leaderboard, samples, upload

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("serve")

app = FastAPI(title="AgentCorp Evaluation Service", version="0.1.0")

# JudgeRegistry 启动注册：所有 Tier 2 主观评分模块在此收口。
# 新增 Evaluator 必须登记到 evaluators/__init__.py，否则 CI 强制失败。
from .scoring.evaluators import register_all as _register_evaluators
from .scoring.judge_registry import get_registry as _get_registry

_register_evaluators(_get_registry())
logger.info("JudgeRegistry: 已注册 %d 个 Evaluator", len(_get_registry().list_ids()))

# CORS 收敛为本地 dev 白名单：正常调用方是 Electron 主进程的 Host API 代理
# （server-to-server，不需要 CORS）；浏览器直连只发生在本地 web 预览。
# 需要对外暴露时通过 CORS_ORIGINS 环境变量显式给出白名单（逗号分隔）。
_cors_origins = [
    o.strip()
    for o in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,"
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# /api/upload 落盘目录同时以 /uploads 静态挂载（前端据返回 URL 渲染媒体）
os.makedirs(settings.upload_dir, exist_ok=True)
app.mount(
    "/uploads",
    StaticFiles(directory=settings.upload_dir),
    name="uploads",
)

app.include_router(samples.router)
app.include_router(evaluate.router)
app.include_router(upload.router)
app.include_router(convergence.router)
app.include_router(leaderboard.router)
app.include_router(judge.router)
app.include_router(growth.router)
app.include_router(health.router)
app.include_router(arena.router)
app.include_router(designer_route.router)


class SPAStaticFiles(StaticFiles):
    """SPA 静态托管：未命中的前端路由回退到 index.html。

    用于昇腾统一环境 Web 形态（服务端同源托管 dist-web 构建产物）。
    /api 与 /uploads 前缀不回退——它们的 404 应如实返回，避免把 API 错误
    静默吞成 HTML 页面。
    """

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            full_path = scope.get("path", "")
            if exc.status_code == 404 and not full_path.startswith(("/api", "/uploads")):
                index = os.path.join(self.directory, "index.html")
                if os.path.isfile(index):
                    return FileResponse(index)
            raise


def mount_web_root(fastapi_app: FastAPI, web_root: str) -> bool:
    """web_root 指向有效目录时在 / 上挂载 SPA 静态站点；返回是否已挂载。"""
    if web_root and os.path.isdir(web_root):
        fastapi_app.mount(
            "/",
            SPAStaticFiles(directory=web_root, html=True),
            name="web",
        )
        return True
    return False


# Web 静态托管挂载放在所有路由之后：API 路由优先匹配，仅兜底前端资源。
mount_web_root(app, settings.web_root)


if __name__ == "__main__":
    uvicorn.run(app, host=settings.host, port=settings.port)
