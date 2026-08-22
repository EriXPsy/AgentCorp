"""上传端点：POST /api/upload（纯搬运自原 serve.py）。"""
from __future__ import annotations

import logging
import os
import uuid

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ..config import settings
from ..schemas import CandidateProfile, PersonaText

logger = logging.getLogger("serve")

router = APIRouter()

# 单文件大小上限（50MB）：超限在落盘前拒绝，避免无上限读入内存打爆进程（DoS）。
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
# 分块读取的块大小
_CHUNK = 64 * 1024

# 每个上传槽位允许的 MIME 类型前缀（小写前缀匹配，如 "video/" 匹配 "video/mp4"）。
# 注意：endpoint 会把附件重命名为固定名（video.mp4/voice.wav/code.zip），
# 因此「扩展名白名单」查的是重命名后的固定名、形同虚设；真正的控制点是
# 客户端声明的 content_type，故按 MIME 前缀校验。
_ALLOWED_MIME_PREFIXES = ("video/", "audio/", "application/zip", "application/x-zip")


def _save(file: UploadFile | None, fname: str, cdir: str) -> str:
    """落盘单个附件，带大小上限与 MIME 类型校验。

    分块读取并在累加字节数超过 MAX_UPLOAD_BYTES 时立即中止（413），
    避免一次性把整个上传读进内存。content_type 不在允许前缀则 415。
    """
    if not file:
        return ""
    ctype = (file.content_type or "").lower()
    if not any(ctype.startswith(p) for p in _ALLOWED_MIME_PREFIXES):
        raise HTTPException(
            status_code=415,
            detail=f"不支持的媒体类型：{ctype or '(空)'}（允许前缀：{list(_ALLOWED_MIME_PREFIXES)}）",
        )
    path = os.path.join(cdir, fname)
    total = 0
    try:
        with open(path, "wb") as f:
            while True:
                chunk = file.file.read(_CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    f.close()
                    os.remove(path)
                    raise HTTPException(
                        status_code=413,
                        detail=f"上传文件超过大小上限 {MAX_UPLOAD_BYTES} 字节",
                    )
                f.write(chunk)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("upload save failed: %s", exc)
        raise HTTPException(status_code=500, detail="文件落盘失败")
    return f"/uploads/{os.path.basename(cdir)}/{fname}"


@router.post("/api/upload")
async def api_upload(
    name: str = Form(...),
    declared_tags: str = Form(""),
    declared_budget: float = Form(200.0),
    persona_text: str = Form(""),
    video: UploadFile = File(None),
    voice: UploadFile = File(None),
    code: UploadFile = File(None),
) -> CandidateProfile:
    """
    P1 上传模式：接收多模态附件，落盘到 upload_dir，返回新 CandidateProfile。
    媒体以服务端 URL 提供（前端据此渲染）。
    """
    os.makedirs(settings.upload_dir, exist_ok=True)
    cid = f"upload-{uuid.uuid4().hex[:8]}"
    cdir = os.path.join(settings.upload_dir, cid)
    os.makedirs(cdir, exist_ok=True)

    video_url = _save(video, "video.mp4", cdir)
    voice_url = _save(voice, "voice.wav", cdir)
    code_url = _save(code, "code.zip", cdir)

    tags = [t.strip() for t in declared_tags.split(",") if t.strip()]
    profile = CandidateProfile(
        id=cid,
        name=name or cid,
        declared_tags=tags,
        declared_budget=declared_budget,
        persona_text=PersonaText(content=persona_text),
        video_demo={"type": "video/mp4", "url": video_url},
        voice_intro={"type": "audio/wav", "url": voice_url},
        artwork=[],
        code_repo={"type": "application/zip", "url": code_url, "lang": "unknown"},
    )
    return profile
