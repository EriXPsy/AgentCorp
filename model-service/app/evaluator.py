"""
model-service/app/evaluator.py
跨模态评估 pipeline。

pipeline：load_media → build_prompt → infer → parse → compute_fit → stream

设计要点：
- compute_user_fit 与前端 src/utils/radar.ts 严格一致（同一公式镜像）。
- MOCK_FIXTURES 与前端 src/mock/samples.ts 同源（同一批候选 id）。
- 无 NPU 时走 Mock 事件流，保证服务可运行、可测试（tests/test_evaluate.py）。
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
from typing import AsyncGenerator, Dict, List, Optional

from .config import settings
from .judge_backend import JudgeUnavailable, get_backend
from .model_loader import get_model, optional_import
from .prompt_templates import build_evaluation_messages
from .schemas import (
    Aesthetic,
    CandidateProfile,
    EvaluationRequest,
    JudgeRunRequest,
    RadarScore,
    RadarDim,
    UserPreference,
    Verdict,
)
from .tts import tts_bridge

logger = logging.getLogger("evaluator")

RADAR_DIMS: List[str] = [
    "task",
    "quality",
    "comm",
    "creativity",
    "reliability",
    "cost",
]

DIM_LABELS: Dict[str, str] = {
    "task": "任务完成",
    "quality": "产出质量",
    "comm": "沟通协作",
    "creativity": "创造泛化",
    "reliability": "稳定可靠",
    "cost": "性价比",
}

_VERDICT_LABELS: Dict[str, str] = {
    "MVP": "MVP",
    "OBSERVE": "待观察",
    "FIRED": "暂不录用",
}



# ======================================================================
# 1) 用户契合度计算（与前端 src/utils/radar.ts 严格一致）
# ======================================================================
def compute_user_fit(
    radar: RadarScore,
    preference: UserPreference,
    declared_budget: float,
    declared_tags: List[str],
    inferred_aesthetic: Optional[str] = None,
    subjective: Optional[Dict[str, float]] = None,
    cap_percent: float = 8.0,
    **kwargs,
) -> tuple[float, List[str]]:
    """
    user_fit = Σ(radar[dim]/5 × weight[dim]) × 100%
    叠加：预算硬约束（超预算则 cost 权重清零）、
         审美硬约束（不符 -8% / 相符 +2%）、技术栈加分（命中 ×1.5%，上限 6%）。
    结果裁剪至 [0,100]。

    可选的主观修正（向后兼容：不传 subjective 时行为完全不变）：
    若传入 subjective（{dim: 0-5}），按使用者口味叠加修正：
      delta = clamp( mean((score-3)/5 for score in subjective) , ±capPercent% )
      user_fit = user_fit × (1 + delta)    # 乘法形式，capPercent 默认 8 → ±0.08
    即主观分只做 ±8% 封顶的 owner 口味修正，不颠覆客观结论。
    cap_percent 可由规则 subjective.capPercent 传入（默认 8）。
    """
    weight = dict(preference.weight.model_dump())
    evidence: List[str] = []

    # 预算硬约束
    if declared_budget > preference.budget_max:
        weight["cost"] = 0.0
        evidence.append(
            f"声明预算 {declared_budget} 超过上限 {preference.budget_max}，"
            f"性价比维度权重清零"
        )

    # 加权基础分
    weighted = 0.0
    for dim in RADAR_DIMS:
        weighted += (getattr(radar, dim) / 5.0) * weight[dim]
    #  / ：Σ weight = 1，user_fit = Σ(radar/5 × weight) × 100%。
    # 不做归一化：超预算清零 cost 权重后总分自然 < 100（预算硬约束真正生效）。
    fit = weighted * 100.0

    # 审美硬约束/减分
    if preference.aesthetic.value != "neutral" and inferred_aesthetic:
        if inferred_aesthetic != preference.aesthetic.value:
            fit -= 8.0
            evidence.append("审美取向与偏好不符，扣 8%")
        else:
            fit += 2.0
            evidence.append("审美取向契合，加 2%")

    # 技术栈加分
    overlap = [t for t in declared_tags if t in preference.preferred_stack]
    if overlap:
        bonus = min(len(overlap) * 1.5, 6.0)
        fit += bonus
        evidence.append(
            f"技术栈命中 {len(overlap)} 项（{','.join(overlap)}），加 {bonus}%"
        )

    # 主观叠加（使用者口味修正，封顶 ±capPercent%，向后兼容）
    if subjective:
        cap = cap_percent / 100.0  # 8 → 0.08（±8%）
        vals = [float(v) for v in subjective.values()]
        if vals:
            # 各维偏离中性值 3 的差值归一（÷5），再取均值 → 分数（-0.6 ~ 0.4）
            avg_dev = sum((v - 3.0) / 5.0 for v in vals) / len(vals)
            delta = max(-cap, min(cap, avg_dev))  # clamp ±capPercent%
            fit = fit * (1.0 + delta)
            evidence.append(
                f"主观叠加(sub_avg_dev={avg_dev:.3f})→{delta:+.3f}（封顶 ±{cap_percent:.0f}%）"
            )

    fit = max(0.0, min(100.0, round(fit * 10) / 10))
    return fit, evidence


# ======================================================================
# 2) 结构化输出解析（缓解 R4 漂移，架构 D7）
# ======================================================================
def parse_output(raw: str) -> Dict:
    """
    从模型自由文本中抽取 JSON（容忍 ```json 代码块包裹与前后多余文本）。
    返回含 radar/verdict/confidence/evidence_trace/narration/audio_script 的 dict。
    """
    text = raw.strip()
    # 优先提取 ```json ... ``` 代码块
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if m:
        text = m.group(1)
    else:
        # 退路：截取首个 { 到末个 }
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            text = text[start : end + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"无法解析模型输出为 JSON：{exc}") from exc

    def _safe_float(value: object, default: float = 0.0) -> float:
        """
        真实模型输出的分数可能是文本/区间/嵌套对象，尽力提取数值：
        - 数字 → 直接用；
        - 字符串含数字（"4分" / "4/5" / "约3.5"）→ 取首个数值；
        - dict 含 score/value 键 → 取该键再递归；
        - 其余回退默认值。
        """
        if isinstance(value, dict):
            for key in ("score", "value"):
                if key in value:
                    return _safe_float(value[key], default)
            return default
        try:
            return float(value)  # type: ignore[arg-type]
        except (ValueError, TypeError):
            pass
        if isinstance(value, str):
            m = re.search(r"-?\d+(?:\.\d+)?", value)
            if m:
                return float(m.group(0))
        return default

    # 规整 radar（逐维安全转换 + 裁剪到 0–5，容忍量化模型的输出噪声）
    radar_raw = data.get("radar", {})
    if not isinstance(radar_raw, dict):
        radar_raw = {}
    radar = RadarScore(
        task=_clamp(_safe_float(radar_raw.get("task"))),
        quality=_clamp(_safe_float(radar_raw.get("quality"))),
        comm=_clamp(_safe_float(radar_raw.get("comm"))),
        creativity=_clamp(_safe_float(radar_raw.get("creativity"))),
        reliability=_clamp(_safe_float(radar_raw.get("reliability"))),
        cost=_clamp(_safe_float(radar_raw.get("cost"))),
    )
    # 量纲救援：小型量化模型常把 0-5 分输出成 0-1 小数——
    # 六维全部落在 (0,1] 时按比例 ×5（至少一维 >1 则认为量纲正确，不动）
    _vals = [float(getattr(radar, d)) for d in ("task", "quality", "comm", "creativity", "reliability", "cost")]
    if any(v > 0 for v in _vals) and all(v <= 1.0 for v in _vals):
        radar = RadarScore(
            task=_clamp(_vals[0] * 5),
            quality=_clamp(_vals[1] * 5),
            comm=_clamp(_vals[2] * 5),
            creativity=_clamp(_vals[3] * 5),
            reliability=_clamp(_vals[4] * 5),
            cost=_clamp(_vals[5] * 5),
        )
    # verdict 只接受合法枚举，其余回退 OBSERVE（真实模型可能输出意外文本）
    verdict_raw = str(data.get("verdict", "OBSERVE")).upper()
    verdict = Verdict(verdict_raw) if verdict_raw in {v.value for v in Verdict} else Verdict.OBSERVE
    confidence = max(0.0, min(1.0, _safe_float(data.get("confidence"), 0.5)))
    evidence = list(data.get("evidence_trace", []))
    narration = str(data.get("narration", ""))
    audio_script = str(data.get("audio_script", narration))

    # 工种专项维度解析（img_* / txt_* / code_*，0–5）。
    # 架构 R4：缺 craft 子对象时降级为空 dict + 标记，不抛异常（向后兼容）。
    craft_raw = data.get("craft")
    craft = craft_raw if isinstance(craft_raw, dict) else {}
    craft_missing = "craft" not in data

    return {
        "radar": radar,
        "verdict": verdict,
        "confidence": confidence,
        "evidence_trace": evidence,
        "narration": narration,
        "audio_script": audio_script,
        "craft": craft,
        "craft_missing": craft_missing,
    }


# ======================================================================
# 3) Mock fixture（与前端 src/mock/samples.ts 同源）
# ======================================================================
MOCK_FIXTURES: Dict[str, Dict] = {
    "candidate-01": {
        "radar": RadarScore(
            task=4.5, quality=5.0, comm=4.5, creativity=4.0, reliability=4.5, cost=4.0
        ),
        "verdict": Verdict.MVP,
        "confidence": 0.92,
        "inferred_aesthetic": "minimal",
        "narration": (
            "琳达的短视频 demo 完整演示了组件库搭建过程，与代码库内容一致。"
            "产出质量极高，设计稿专业且极简。语音自述逻辑清晰，沟通力强。"
            "创意上做了差异化定位，但仍有提升空间。综合来看是本月最值得签约的候选。"
        ),
        "audio_script": (
            "你好，我是 MiniCPM-o 全模态 HR 总监。下面为你讲解琳达的评估结果。"
            "琳达的短视频、代码与作品图高度一致，产出质量达到满分水准，审美也是你偏好的极简风。"
            "沟通和创意都很出色，预算也在你的上限之内。综合判定：本月 MVP。"
        ),
        "evidence_trace": [
            "视频 demo 展示的组件与 code_repo 中代码一致（claim=demo）",
            "作品图 design-tokens 体现极简审美，与偏好 aesthetic=minimal 契合",
            "语音自述结构清晰，信息密度高（表达沟通 4.5）",
            "预算 180 ≤ 200，性价比维度未触发硬约束",
        ],
    },
    "candidate-02": {
        "radar": RadarScore(
            task=4.0, quality=3.5, comm=3.0, creativity=2.5, reliability=4.5, cost=3.5
        ),
        "verdict": Verdict.OBSERVE,
        "confidence": 0.85,
        "inferred_aesthetic": "neutral",
        "narration": (
            "老张的 Python 后端代码稳定、可运行，可靠性强。但表达沟通偏薄弱，"
            "创意差异化不足，整体偏保守。预算 220 略微超出上限，性价比维度被约束。"
            "建议进入观察期，针对性培训沟通与创意。"
        ),
        "audio_script": (
            "接下来是老张的评估。他的后端代码很稳，可靠性突出，但表达与创意较弱，"
            "预算也略微超了一点。整体可用但非首选，判定为待观察，建议进入培训期。"
        ),
        "evidence_trace": [
            "code_repo 单元测试通过，逻辑稳定（可靠性 4.5）",
            "语音自述信息密度低，缺乏结构化（表达沟通 3.0）",
            "预算 220 > 200，性价比维度权重清零",
            "作品无明显差异化卖点（创意 2.5）",
        ],
    },
    "candidate-03": {
        "radar": RadarScore(
            task=3.0, quality=2.5, comm=2.5, creativity=3.5, reliability=1.5, cost=1.0
        ),
        "verdict": Verdict.FIRED,
        "confidence": 0.78,
        "inferred_aesthetic": "rich",
        "narration": (
            "阿强声明的预算高达 300，严重超支，性价比极低。视频中宣称的高并发能力"
            "在代码库里找不到对应实现，存在注水风险。可靠性差，沟通也一般。"
            "综合判定：暂不录用。"
        ),
        "audio_script": (
            "最后是阿强。他的预算高达 300，远超上限，性价比几乎为零。更关键的是，"
            "视频里吹的高并发，在代码里根本找不到对应实现，存在明显注水。"
            "可靠性也很差。综合判定：暂不录用。"
        ),
        "evidence_trace": [
            "声明预算 300 >> 200，性价比维度权重清零（cost=1.0）",
            "视频 claim 高并发，但 code_repo 无相关实现（claim≠demo，注水风险）",
            "多模态自相矛盾，一致性差（可靠性 1.5）",
            "审美 rich 与多数采购者偏好 minimal 不符",
        ],
    },
}


def _get_fixture(candidate: CandidateProfile) -> Dict:
    """取 Mock fixture；未知候选按声明数据生成一个确定性降级 fixture。"""
    if candidate.id in MOCK_FIXTURES:
        return MOCK_FIXTURES[candidate.id]
    # 未知候选：基于声明标签给出一个保守默认值（保证可演示）
    tags = candidate.declared_tags
    radar = RadarScore(
        task=3.5,
        quality=3.0,
        comm=3.0,
        creativity=3.0 if "UI" in tags or "React" in tags else 2.5,
        reliability=3.5,
        cost=2.0 if candidate.declared_budget > 200 else 3.5,
    )
    return {
        "radar": radar,
        "verdict": Verdict.OBSERVE,
        "confidence": 0.7,
        "inferred_aesthetic": "neutral",
        "narration": f"{candidate.name} 为基础候选，评估为待观察。",
        "audio_script": f"{candidate.name} 评估完成，判定为待观察。",
        "evidence_trace": ["使用兜底 fixture（未知候选 id）"],
    }


# ======================================================================
# 4) 媒体加载与推理（真实环境实现；骨架中为占位）
# ======================================================================
def _resolve_media_path(url: str) -> Optional[str]:
    """
    将媒体 URL 解析为本地文件路径：
    - "/uploads/..."（api/upload 落盘的静态前缀）→ settings.upload_dir 下；
    - http(s) 远程 URL → 不抓取，返回 None（记日志跳过）；
    - 其余按文件系统路径处理。
    """
    if not url:
        return None
    if url.startswith("http://") or url.startswith("https://"):
        logger.info("远程媒体 URL 不抓取（按本地部署约定）：%s", url[:80])
        return None
    if url.startswith("/uploads/"):
        return os.path.join(settings.upload_dir, url[len("/uploads/"):])
    return url


def _load_image(path: str) -> Optional[object]:
    """PIL 加载图像（RGB，最长边 ≤1024）；失败返回 None。"""
    pil_image = optional_import("PIL.Image")
    if pil_image is None:
        logger.warning("Pillow 未安装，跳过图像加载：%s", path)
        return None
    try:
        img = pil_image.open(path).convert("RGB")
        img.thumbnail((1024, 1024))
        return img
    except Exception as exc:  # noqa: BLE001
        logger.warning("图像加载失败（跳过）：%s：%s", path, exc)
        return None


def _load_audio(path: str) -> Optional[object]:
    """librosa 加载音频（16kHz mono numpy 波形，与官方用法一致）；失败返回 None。"""
    librosa = optional_import("librosa")
    if librosa is None:
        logger.warning("librosa 未安装，跳过音频加载：%s", path)
        return None
    try:
        y, _sr = librosa.load(path, sr=16000, mono=True)
        return y
    except Exception as exc:  # noqa: BLE001
        logger.warning("音频加载失败（跳过）：%s：%s", path, exc)
        return None


def _sample_video_frames(path: str, n_frames: int) -> List[object]:
    """opencv 均匀抽帧（BGR→RGB→PIL）；cv2 缺失或失败返回空列表。"""
    cv2 = optional_import("cv2")
    pil_image = optional_import("PIL.Image")
    if cv2 is None or pil_image is None:
        logger.warning("opencv-python 未安装，跳过视频抽帧：%s", path)
        return []
    cap = cv2.VideoCapture(path)
    try:
        if not cap.isOpened():
            logger.warning("视频无法打开（跳过）：%s", path)
            return []
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
        if total <= 0:
            return []
        n = max(1, min(n_frames, total))
        # 均匀抽帧：首尾对齐，索引确定性（复现性）
        indices = [round(i * (total - 1) / (n - 1)) if n > 1 else 0 for i in range(n)]
        frames = []
        for idx in indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, bgr = cap.read()
            if not ok:
                continue
            frames.append(pil_image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)))
        return frames
    except Exception as exc:  # noqa: BLE001
        logger.warning("视频抽帧失败（跳过）：%s：%s", path, exc)
        return []
    finally:
        cap.release()


def load_media(candidate: CandidateProfile) -> Dict:
    """
    加载并预处理多模态证据：
    - 视频：确定性均匀抽帧（settings.frame_sample，默认 8 帧）
    - 音频：重采样至 16kHz mono（librosa，numpy 波形）
    - 图像：最长边 ≤1024（PIL）

    返回真实载荷 dict：frames: List[PIL.Image]，audio: np.ndarray|None，
    images: List[PIL.Image]，code_lang: str。
    文件不存在 / 依赖缺失时优雅降级为空媒体 + warning 日志，不中断评估。
    """
    frames: List[object] = []
    video_path = _resolve_media_path(candidate.video_demo.url)
    if video_path:
        if os.path.isfile(video_path):
            frames = _sample_video_frames(video_path, settings.frame_sample)
        else:
            logger.warning("视频文件不存在（跳过）：%s", video_path)

    audio = None
    audio_path = _resolve_media_path(candidate.voice_intro.url)
    if audio_path:
        if os.path.isfile(audio_path):
            audio = _load_audio(audio_path)
        else:
            logger.warning("音频文件不存在（跳过）：%s", audio_path)

    images: List[object] = []
    for ref in candidate.artwork:
        img_path = _resolve_media_path(ref.url)
        if not img_path:
            continue
        if not os.path.isfile(img_path):
            logger.warning("作品图不存在（跳过）：%s", img_path)
            continue
        img = _load_image(img_path)
        if img is not None:
            images.append(img)

    logger.info(
        "load_media：候选=%s，帧=%d，音频=%s，图像=%d",
        candidate.id,
        len(frames),
        "已加载" if audio is not None else "无",
        len(images),
    )
    return {
        "frames": frames,
        "audio": audio,
        "images": images,
        "code_lang": candidate.code_repo.lang,
    }


def infer(multimodal: Dict, messages: List[dict]) -> str:
    """
    调用 MiniCPM-o 跨模态推理，返回自由文本（含 JSON）。

    推理后端由 JUDGE_BACKEND 选择（judge_backend.py）：
    http（OpenAI 兼容服务）/ local（本机 transformers）/ mock（不可用）。
    后端不可用时抛 JudgeUnavailable，由调用方降级，不返回伪造分数。
    """
    completion = get_backend().complete(messages)
    logger.info(
        "judge 推理完成：backend=%s ttft=%.0fms latency=%.0fms 媒体=%s",
        completion.backend,
        completion.ttft_ms or 0.0,
        completion.latency_ms,
        multimodal.get("frames"),
    )
    return completion.text


# ======================================================================
# 5) 事件流生成
# ======================================================================
def _encode_text(text: str) -> str:
    """文本 → base64（与前端 Mock 模式 audio 事件同字段语义）"""
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def judge_available() -> bool:
    """
    真实评测是否可用：judge 后端可用即可（http 后端不需要本地权重）。

    保留 model_loader 作为本地权重路径的旁路判断，两者任一可用即视为可评测。
    """
    try:
        if get_backend().available:
            return True
    except Exception:  # noqa: BLE001 —— 探测不应影响主流程
        pass
    return get_model().available


async def _stream_mock(req: EvaluationRequest) -> AsyncGenerator[Dict, None]:
    """Mock 事件流：雷达逐维点亮 → 讲解+语音 → 判定+语音 → done。"""
    candidate = req.candidate
    pref = req.preference
    fixture = _get_fixture(candidate)
    radar: RadarScore = fixture["radar"]

    # 1) 逐维点亮雷达
    for dim in RADAR_DIMS:
        await asyncio.sleep(0.4)
        yield {
            "type": "radar_update",
            "dim": dim,
            "score": float(getattr(radar, dim)),
            "confidence": fixture["confidence"],
            "evidence": (
                fixture["evidence_trace"][0]
                if fixture["evidence_trace"]
                else f"{dim} 由多模态证据推断"
            ),
        }

    # 2) 讲解（按句切分 delta）+ 语音（audio 事件，chunk=base64 文本）
    sentences = re.split(r"(?<=[。！？])", fixture["audio_script"])
    sentences = [s for s in sentences if s.strip()]
    for sent in sentences:
        yield {"type": "narration", "delta": sent, "is_final": False}
        await asyncio.sleep(0.3)
        yield {
            "type": "audio",
            "chunk": _encode_text(sent),
            "format": "wav",
            "sample_rate": 16000,
        }

    # 3) 计算 user_fit
    fit, evidence = compute_user_fit(
        radar,
        pref,
        candidate.declared_budget,
        candidate.declared_tags,
        fixture["inferred_aesthetic"],
    )
    await asyncio.sleep(0.3)
    yield {
        "type": "verdict",
        "verdict": fixture["verdict"].value,
        "user_fit": fit,
        "evidence_trace": fixture["evidence_trace"] + evidence,
        "confidence": fixture["confidence"],
    }

    # 4) 语音宣判
    verdict_text = (
        f"综合判定：{fixture['verdict'].value}。"
        f"{candidate.name} 的用户契合度为 {fit:.0f}%。"
    )
    yield {
        "type": "audio",
        "chunk": _encode_text(verdict_text),
        "format": "wav",
        "sample_rate": 16000,
    }

    await asyncio.sleep(0.2)
    yield {"type": "done", "evaluation_id": f"mock-{candidate.id}-{id(req)}"}


async def _stream_real(req: EvaluationRequest) -> AsyncGenerator[Dict, None]:
    """
    真实事件流（需 judge 后端可用）。
    后端不可用则抛出明确错误（不静默崩溃、不伪造分数）。
    """
    if not judge_available():
        raise JudgeUnavailable(
            "真实推理不可用：JUDGE_BACKEND=mock 或后端未就绪。"
            "请设置 JUDGE_BACKEND=http 并配置 JUDGE_BASE_URL，"
            "或在具备本机权重的环境设置 JUDGE_BACKEND=local。"
        )
    # —— 以下为真实 pipeline 骨架（模型可用时填充）——
    media = load_media(req.candidate)
    messages = build_evaluation_messages(req.candidate, req.preference)
    raw = infer(media, messages)
    parsed = parse_output(raw)

    for dim in RADAR_DIMS:
        yield {
            "type": "radar_update",
            "dim": dim,
            "score": float(getattr(parsed["radar"], dim)),
            "confidence": parsed["confidence"],
            "evidence": (
                parsed["evidence_trace"][0]
                if parsed["evidence_trace"]
                else f"{dim} 由多模态证据推断"
            ),
        }

    # 讲解逐句 + 语音合成
    for sent in re.split(r"(?<=[。！？])", parsed["narration"]):
        if not sent.strip():
            continue
        yield {"type": "narration", "delta": sent, "is_final": False}
        audio_bytes = tts_bridge.synthesize(sent)
        if audio_bytes:
            yield {
                "type": "audio",
                "chunk": base64.b64encode(audio_bytes).decode("ascii"),
                "format": "wav",
                "sample_rate": 16000,
            }

    fit, evidence = compute_user_fit(
        parsed["radar"],
        req.preference,
        req.candidate.declared_budget,
        req.candidate.declared_tags,
        None,
    )
    yield {
        "type": "verdict",
        "verdict": parsed["verdict"].value,
        "user_fit": fit,
        "evidence_trace": parsed["evidence_trace"] + evidence,
        "confidence": parsed["confidence"],
    }
    yield {"type": "done", "evaluation_id": f"real-{req.candidate.id}-{id(req)}"}


async def evaluate(
    req: EvaluationRequest, mode: str = "auto"
) -> AsyncGenerator[Dict, None]:
    """
    评估入口，产出 EvaluationEvent dict 流。

    mode:
      - "mock"：强制 Mock fixture 事件流（无 NPU 演示/测试）。
      - "real"：强制真实推理（模型不可用会抛错）。
      - "auto"（默认）：settings.mock 或模型不可用时走 Mock，否则走真实。
    """
    if mode == "mock":
        async for ev in _stream_mock(req):
            yield ev
        return
    if mode == "real":
        async for ev in _stream_real(req):
            yield ev
        return
    # auto
    if settings.mock or not judge_available():
        async for ev in _stream_mock(req):
            yield ev
        return
    async for ev in _stream_real(req):
        yield ev


# ======================================================================
# 6) 运行期裁判（api/evaluate-run）：transcript + usage → 同构 SSE 流
# ======================================================================
def _clamp(value: float, lo: float = 0.0, hi: float = 5.0) -> float:
    return max(lo, min(hi, value))


#: 无证据时的中性基线（0–5 量表中位）。不是「及格分」，而是「未知」。
NEUTRAL_SCORE = 2.5


def _transcript_signals(transcript: str) -> Dict[str, float]:
    """
    从 transcript 抽取可解释的弱信号（0–1），仅用于 judge 不可用时的降级。

    与 agent 身份完全无关——只看这一次运行实际产出了什么，
    因此个人上传的新 agent 不会因为「没有名气」而吃亏。
    """
    text = (transcript or "").strip()
    if not text:
        return {}
    lines = [ln for ln in text.split("\n") if ln.strip()]
    signals: Dict[str, float] = {}
    # 产出体量：以 400 字为饱和点。中文信息密度高，按英文长度校准会
    # 让实质产出被判成「过短」，反而低于「无证据」的中性基线。
    signals["volume"] = min(1.0, len(text) / 400.0)
    # 结构化：分点/编号说明在给方法
    signals["structure"] = min(
        1.0, (1.0 if re.search(r"(^|\n)\s*(\d+[.、)]|[-*·])", text) else 0.0) + len(lines) / 20.0
    )
    # 具体性：数字与标识符
    signals["specificity"] = min(
        1.0,
        (0.5 if re.search(r"\d", text) else 0.0) + (0.5 if re.search(r"[A-Za-z_]{3,}", text) else 0.0),
    )
    return signals


def _derive_run_radar(req: JudgeRunRequest) -> RadarScore:
    """
    降级派生（judge 后端不可用时）：只用本次运行的真实数据。

    成本维：由真实总花费折算（预算 1.0 USD 基准，越低越高分）。
    产出相关维：由 transcript 弱信号折算；无 transcript 时给中性基线 2.5
    并由调用方在 evidence_trace 中标注「不可评」。

    与旧实现的关键差异：**不再用 agent_id 哈希造分**。
    哈希派生会让分数只与 id 字符串有关、与实际表现无关，
    等于把随机数当评测结论，也让相同表现的 agent 因改名而分数变化。
    """
    usage = req.usage or []
    total_cost = sum(float(u.get("costUsd", 0) or 0) for u in usage)
    sig = _transcript_signals(req.transcript or "")

    if not sig:
        # 零证据：全维中性，不猜测
        base = {d: NEUTRAL_SCORE for d in RADAR_DIMS}
    else:
        volume = sig.get("volume", 0.0)
        structure = sig.get("structure", 0.0)
        specificity = sig.get("specificity", 0.0)
        base = {
            "task": 1.5 + 3.5 * volume,
            "quality": 1.5 + 3.5 * (0.5 * structure + 0.5 * specificity),
            "comm": 1.5 + 3.5 * structure,
            # 创意无法从体量/结构判断，保持中性而非编造
            "creativity": NEUTRAL_SCORE,
            "reliability": 1.5 + 3.5 * specificity,
            "cost": NEUTRAL_SCORE,
        }

    base["cost"] = 5.0 - total_cost * 5.0 if total_cost > 0 else NEUTRAL_SCORE

    return RadarScore(**{d: _clamp(base[d]) for d in RADAR_DIMS})


def _run_radar_evidence(req: JudgeRunRequest) -> List[str]:
    """降级派生的证据说明（让用户看见分数是怎么来的、哪些维不可评）。"""
    sig = _transcript_signals(req.transcript or "")
    usage = req.usage or []
    total_cost = sum(float(u.get("costUsd", 0) or 0) for u in usage)
    notes: List[str] = ["source=degraded（judge 后端不可用，未经模型评测）"]
    if not sig:
        notes.append("无 transcript：全部能力维为中性基线 2.5，不可评")
    else:
        notes.append(
            f"transcript 弱信号：体量={sig['volume']:.2f} "
            f"结构={sig['structure']:.2f} 具体性={sig['specificity']:.2f}"
        )
        notes.append("creativity 维无法由弱信号判断，保持中性 2.5")
    notes.append(
        f"cost 维由真实花费 ${total_cost:.4f} 折算"
        if total_cost > 0
        else "无花费数据：cost 维为中性基线 2.5"
    )
    return notes


def _verdict_from_radar(radar: RadarScore) -> Verdict:
    avg = sum(getattr(radar, d) for d in RADAR_DIMS) / len(RADAR_DIMS)
    if avg >= 4.0:
        return Verdict.MVP
    if avg >= 2.5:
        return Verdict.OBSERVE
    return Verdict.FIRED


def _default_pref() -> UserPreference:
    return UserPreference()


def _build_run_prompt(req: JudgeRunRequest) -> str:
    """将 transcript + usage + task 拼为模型推理提示词。"""
    usage = req.usage or []
    total_tokens = sum(int(u.get("totalTokens", 0) or 0) for u in usage)
    total_cost = sum(float(u.get("costUsd", 0) or 0) for u in usage)
    transcript = (req.transcript or "").strip()
    snippet = transcript[:4000] if transcript else "(无转录)"
    return (
        f"评估 agent：{req.agent_name or req.agent_id}\n"
        f"任务：{req.task.title}（{req.task.description}）\n"
        f"真实用量：tokens={total_tokens}，cost=${total_cost:.4f}，样本数={len(usage)}\n"
        f"转录片段：\n{snippet}\n\n"
        "请基于上述真实运行数据，输出 JSON（注意：radar 每个维度打 0 到 5 分，"
        "0 最差、5 最好，可保留一位小数，禁止使用 0 到 1 的小数；"
        "verdict 只能从 MVP、OBSERVE、FIRED 中选一个填入）："
        "{\"radar\":{\"task\":0-5,\"quality\":0-5,\"comm\":0-5,"
        "\"creativity\":0-5,\"reliability\":0-5,\"cost\":0-5},"
        "\"verdict\":\"MVP\",\"confidence\":0-1,"
        "\"evidence_trace\":[\"...\"],\"narration\":\"...\"}"
    )


def _build_run_narration(req: JudgeRunRequest, radar: RadarScore, verdict: Verdict) -> str:
    """由雷达 + 判定生成中文讲解稿（mock-run 语音闭环用）。"""
    name = req.agent_name or req.agent_id
    scores = {d: float(getattr(radar, d)) for d in RADAR_DIMS}
    strongest = max(scores, key=lambda d: scores[d])
    weakest = min(scores, key=lambda d: scores[d])
    return (
        f"{name} 的六维评估已完成。"
        f"最强维度是{DIM_LABELS[strongest]}（{scores[strongest]:.1f} 分），"
        f"最弱维度是{DIM_LABELS[weakest]}（{scores[weakest]:.1f} 分）。"
        f"综合判定为{_VERDICT_LABELS[verdict.value]}。"
    )

async def _stream_mock_run(req: JudgeRunRequest) -> AsyncGenerator[Dict, None]:
    """
    降级运行期裁判流：雷达逐维点亮 → 判定 → done。

    置信度显著低于真实评测（0.35 vs 模型给出值），
    且 evidence_trace 明确标注 source=degraded，
    前端据此可以把这类分数与真实评测区分展示。
    """
    radar = _derive_run_radar(req)
    notes = _run_radar_evidence(req)
    for dim in RADAR_DIMS:
        await asyncio.sleep(0.3)
        yield {
            "type": "radar_update",
            "dim": dim,
            "score": float(getattr(radar, dim)),
            "confidence": 0.35,
            "evidence": f"{dim}：降级派生，未经模型评测",
        }

    verdict = _verdict_from_radar(radar)
    avg = sum(getattr(radar, d) for d in RADAR_DIMS) / len(RADAR_DIMS)
    user_fit = round(avg * 20, 1)
    # 讲解（逐句 narration delta）+ 语音（audio 事件，chunk=base64 UTF-8 文本）
    # 注意：audio 必须先于本句 narration 发出——渲染层见到首个 audio 后才把
    # narration 降级为「只上屏不播报」，先发 narration 会导致首句被双播。
    narration = _build_run_narration(req, radar, verdict)
    sentences = [s for s in re.split(r"(?<=[。！？])", narration) if s.strip()]
    for sent in sentences:
        yield {
            "type": "audio",
            "chunk": _encode_text(sent),
            "format": "wav",
            "sample_rate": 16000,
        }
        await asyncio.sleep(0.2)
        yield {"type": "narration", "delta": sent, "is_final": False}
    yield {"type": "narration", "delta": "", "is_final": True}
    await asyncio.sleep(0.3)
    yield {
        "type": "verdict",
        "verdict": verdict.value,
        "user_fit": user_fit,
        "evidence_trace": [*notes, f"avg_radar={avg:.2f}"],
        "confidence": 0.35,
    }

    # 语音宣判（事件顺序：verdict 之后、done 之前；渲染层据此播报最终结论）
    verdict_text = (
        f"综合判定：{_VERDICT_LABELS[verdict.value]}。"
        f"用户契合度 {user_fit:.0f}%。"
    )
    yield {
        "type": "audio",
        "chunk": _encode_text(verdict_text),
        "format": "wav",
        "sample_rate": 16000,
    }

    await asyncio.sleep(0.2)
    yield {"type": "done", "evaluation_id": f"mock-run-{req.agent_id}-{id(req)}"}


async def _stream_real_run(req: JudgeRunRequest) -> AsyncGenerator[Dict, None]:
    """真实运行期裁判流（需 judge 后端可用）。"""
    if not judge_available():
        raise JudgeUnavailable(
            "真实推理不可用：请配置 JUDGE_BACKEND=http（含 JUDGE_BASE_URL）"
            "或在具备本机权重的环境使用 JUDGE_BACKEND=local。"
        )
    messages = [{"role": "user", "content": _build_run_prompt(req)}]
    media = {"transcript": req.transcript, "usage": req.usage}
    raw = infer(media, messages)
    parsed = parse_output(raw)

    # 一致性护栏：量化小模型的 verdict 可能与自身雷达矛盾
    # （如五维满分却判 FIRED）——以雷达推导的判定为准并留痕
    derived_verdict = _verdict_from_radar(parsed["radar"])
    if parsed["verdict"] != derived_verdict:
        parsed["evidence_trace"].append(
            f"一致性护栏：模型判定 {parsed['verdict'].value} 与雷达均值矛盾，"
            f"以雷达推导 {derived_verdict.value} 为准"
        )
        parsed["verdict"] = derived_verdict

    for dim in RADAR_DIMS:
        yield {
            "type": "radar_update",
            "dim": dim,
            "score": float(getattr(parsed["radar"], dim)),
            "confidence": parsed["confidence"],
            "evidence": (
                parsed["evidence_trace"][0]
                if parsed["evidence_trace"]
                else f"{dim} 由模型推断"
            ),
        }

    fit, evidence = compute_user_fit(parsed["radar"], _default_pref(), 200.0, [], None)
    yield {
        "type": "verdict",
        "verdict": parsed["verdict"].value,
        "user_fit": fit,
        "evidence_trace": parsed["evidence_trace"] + evidence,
        "confidence": parsed["confidence"],
    }
    yield {"type": "done", "evaluation_id": f"real-run-{req.agent_id}-{id(req)}"}


async def evaluate_run(
    req: JudgeRunRequest, mode: str = "auto"
) -> AsyncGenerator[Dict, None]:
    """
    运行期裁判入口，产出与 /api/evaluate 同构的 EvaluationEvent dict 流
    （radar_update ×6 + verdict + done）。

    mode：
      - "mock"：强制 Mock 派生（无 NPU 演示/测试）。
      - "real"：强制真实推理（模型不可用会抛错）。
      - "auto"（默认）：settings.mock 或模型不可用时走 Mock，否则走真实。
    """
    if mode == "mock":
        async for ev in _stream_mock_run(req):
            yield ev
        return
    if mode == "real":
        async for ev in _stream_real_run(req):
            yield ev
        return
    if settings.mock or not judge_available():
        async for ev in _stream_mock_run(req):
            yield ev
        return
    async for ev in _stream_real_run(req):
        yield ev
