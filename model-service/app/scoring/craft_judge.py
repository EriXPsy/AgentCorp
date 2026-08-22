"""
model-service/app/scoring/craft_judge.py
工种试做题的 LLM-as-judge 评分（HR 面试的客观评测核心）。

流程：候选答案 + 题面 rubric → MiniCPM-o → 逐维分数 + 逐条要点判定。

关键设计（都是为了「客观」二字）：
1. 同题同 rubric —— 所有候选做同一道题，按同一份 checkpoints 判定，
   分数不受 star 数、雇佣数、仓库年龄影响。个人上传的 agent 与
   头部开源项目在这里起点完全一致。
2. 逐条要点判定 —— 裁判必须对每条 checkpoint 输出 hit/miss + 引用原文位置，
   而不是直接给一个总分。没有引用的判定视为无效证据。
3. 未覆盖维度不打分 —— 题库没考到的 craft 维返回 None 并标注不可评，
   绝不用其他维度的分数外推。
4. 温度 0 + 固定题面 —— 保证效果可验证、结论可复现。

学术依据：
- Rulers: From Rubrics to Reliable Scores（arXiv:2601.08654）提出把人类 rubric
  转成稳定可审计评分的三阶段框架：① 锁定任务级 rubric（防执行漂移）② 清单式逐条
  判定 + 证据类型标注 + 逐字引文校验（闭合「不可核验打分」）③ 事后校准对齐人类分。
  本模块的「逐 checkpoint hit+quote」「无 quote 即降 miss」「参考答案锚定天花板」
  分别对应其阶段 ② 的引文校验与阶段 ③ 的锚定校准。
- LLM-Rubric（arXiv:2501.00274）：多维校准融合多评委分布，较未校准基线 RMS
  误差减半。本模块目前为单评委温度 0；多评委校准时可接入其 per-judge 融合思路。
- Craft 证据与机器验证解耦（stage_scorer Q6）：裁判引文 craft_evidence 不具备
  解除降权资格，只有机器 verified_evidence 可解除——避免「被监管方自证合格」。

零新增依赖。推理走 judge_backend，不可用时抛 JudgeUnavailable 由调用方降级。
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from ..judge_backend import JudgeCompletion, JudgeUnavailable, get_backend
from .evaluator_protocol import EvaluatorInput, EvaluatorOutput
from .craft_tasks import CraftTask, get_reference, get_task
from .registry import JOB_CRAFT_DIMS

logger = logging.getLogger("craft_judge")


@dataclass
class CheckpointVerdict:
    """单条 rubric 要点的判定。"""

    checkpoint: str
    hit: bool
    #: 支持该判定的答案原文片段；空串视为无证据
    quote: str = ""


@dataclass
class CraftJudgement:
    """一道题的评分结果。"""

    task_id: str
    job_type: str
    #: craft 维 → 分数（0–5）。仅包含本题 target_dims。
    dims: Dict[str, float] = field(default_factory=dict)
    #: 未被本题覆盖、因此不可评的维度
    unscored_dims: List[str] = field(default_factory=list)
    checkpoints: List[CheckpointVerdict] = field(default_factory=list)
    #: 注水判定：题面探针命中即为 True
    padding_detected: bool = False
    padding_note: str = ""
    #: 是否采用了参考答案锚定（B：天花板缓解）
    reference_used: bool = False
    confidence: float = 0.0
    #: 性能指标（TTFT / 端到端延迟口径）
    ttft_ms: Optional[float] = None
    latency_ms: float = 0.0
    backend: str = ""
    #: 裁判思维链（chain-of-thought）：思考模型的推理全程（可能为空串）。
    #: 供 metaJudge 做「reasoning 是否与结论一致」的一致性审计，与最终分数一并展示。
    reasoning: str = ""


SYSTEM_PROMPT = """你是 AgentCorp 的工种能力裁判，由 MiniCPM-o 4.5 驱动。
你的任务：依据给定的评分要点（rubric），对候选 agent 的试做答案逐维打分。

铁律（违反即为无效评分）：
1. 只依据答案实际内容判定，不猜测候选的意图、不因表述自信而加分。
2. 每条评分要点必须给出 hit（是否兑现）与 quote（答案中的原文片段，
   最多 40 字）。找不到原文支撑的要点，hit 必须为 false，quote 留空。
3. 只对「本题考查维度」打分。未列出的维度一律不要出现在 dims 中。
4. 空口承诺（如「已充分测试」「保证专业」）但无具体内容的，
   必须在 padding 中标注，并压低相关维度分数。
5. 分数为 0–5，0.5 步进。参照锚点：
   0–1 未作答或完全偏离；1.5–2 只有方向没有可执行内容；
   2.5–3 部分要点兑现；3.5–4 多数要点兑现且具体；
   4.5–5 全部要点兑现且给出可核验细节。
6. 若题面附有【参考答案】：它是人工验证过的满分基准（=5.0 锚点）。
   候选答案必须达到参考的同等水平、且给出可核验细节，才允许 4.5–5；
   明显弱于参考答案的，压到 2.5 以下。严禁因为「答了」就给高分，
   也严禁照抄参考句式冒充作答。

严格按以下 JSON 输出，不要输出 JSON 以外的任何内容：
{
  "dims": {"<维度键>": 0.0},
  "checkpoints": [{"checkpoint": "原文照抄要点", "hit": true, "quote": "答案片段"}],
  "padding": {"detected": false, "note": ""},
  "confidence": 0.0
}"""


def build_craft_messages(task: CraftTask, answer: str) -> List[dict]:
    """构造评分消息（题面 + rubric + 参考答案锚定 + 候选答案）。"""
    checkpoint_block = "\n".join(f"{i + 1}. {c}" for i, c in enumerate(task.checkpoints))
    probe_block = "\n".join(f"- {p}" for p in task.probes) or "-（本题无探针）"
    dim_block = "\n".join(f"- {d}" for d in task.target_dims)
    reference = get_reference(task.id)
    reference_block = (
        f"\n【参考答案（人工验证的满分基准，仅用于校准尺度，勿照抄句式）】\n{reference}\n"
        if reference
        else "\n（本题无参考答案，按绝对锚点打分）\n"
    )

    user_text = (
        f"【题目】{task.title}（id={task.id}，工种={task.job_type}）\n"
        f"题面原文：\n{task.prompt}\n\n"
        f"【本题考查维度（dims 只能包含这些键）】\n{dim_block}\n\n"
        f"【评分要点 rubric（逐条判定 hit + quote）】\n{checkpoint_block}\n\n"
        f"【反注水探针（命中则在 padding 中标注）】\n{probe_block}\n\n"
        f"{reference_block}"
        f"【候选答案】\n{answer.strip() or '(候选未作答)'}\n\n"
        "请按系统提示的 JSON 结构输出评分。"
    )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_text},
    ]


def _extract_json(raw: str) -> dict:
    """从模型输出抽取 JSON（容忍代码块包裹与前后赘余文本）。"""
    text = (raw or "").strip()
    matched = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if matched:
        text = matched.group(1)
    else:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            text = text[start : end + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"裁判输出无法解析为 JSON：{exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("裁判输出的顶层结构不是对象")
    return data


def _clamp_half_step(value: float) -> float:
    """夹到 [0,5] 并对齐 0.5 步进（与主观打分同口径）。"""
    clamped = max(0.0, min(5.0, float(value)))
    return round(clamped * 2) / 2


def parse_craft_output(raw: str, task: CraftTask) -> CraftJudgement:
    """
    解析裁判输出为 CraftJudgement。

    越界维度（不在 task.target_dims 中）一律丢弃，防止裁判自行扩维；
    缺失的目标维度记入 unscored_dims，不补默认分。
    """
    data = _extract_json(raw)

    dims: Dict[str, float] = {}
    raw_dims = data.get("dims")
    if isinstance(raw_dims, dict):
        for key, value in raw_dims.items():
            if key not in task.target_dims:
                logger.warning("裁判输出越界维度 %s，已丢弃（题 %s）", key, task.id)
                continue
            try:
                dims[key] = _clamp_half_step(value)
            except (TypeError, ValueError):
                logger.warning("维度 %s 分数非法（%r），已丢弃", key, value)

    verdicts: List[CheckpointVerdict] = []
    raw_cps = data.get("checkpoints")
    if isinstance(raw_cps, list):
        for item in raw_cps:
            if not isinstance(item, dict):
                continue
            quote = str(item.get("quote", "")).strip()
            # 铁律 2：无原文支撑的 hit 一律降为 miss
            hit = bool(item.get("hit")) and bool(quote)
            verdicts.append(
                CheckpointVerdict(
                    checkpoint=str(item.get("checkpoint", "")).strip(),
                    hit=hit,
                    quote=quote,
                )
            )

    padding = data.get("padding")
    padding_detected = False
    padding_note = ""
    if isinstance(padding, dict):
        padding_detected = bool(padding.get("detected"))
        padding_note = str(padding.get("note", "")).strip()

    try:
        confidence = max(0.0, min(1.0, float(data.get("confidence", 0.0))))
    except (TypeError, ValueError):
        confidence = 0.0

    return CraftJudgement(
        task_id=task.id,
        job_type=task.job_type,
        dims=dims,
        unscored_dims=[d for d in task.target_dims if d not in dims],
        checkpoints=verdicts,
        padding_detected=padding_detected,
        padding_note=padding_note,
        confidence=confidence,
    )


def judge_craft_task(task_id: str, answer: str) -> CraftJudgement:
    """
    对一道试做题的答案评分（需 judge 后端可用）。

    后端不可用时抛 JudgeUnavailable —— 不返回伪造分数，
    由调用方决定是降级标注还是直接报错。
    """
    task = get_task(task_id)
    if task is None:
        raise ValueError(f"未知题目 id：{task_id}")

    backend = get_backend()
    if not backend.available:
        raise JudgeUnavailable(
            f"craft 评分需要可用的 judge 后端（当前 {backend.name} 不可用）。"
            "请配置 JUDGE_BACKEND=http 或 local。"
        )

    completion: JudgeCompletion = backend.complete(build_craft_messages(task, answer))
    result = parse_craft_output(completion.text, task)
    result.reference_used = bool(get_reference(task.id))
    result.ttft_ms = completion.ttft_ms
    result.latency_ms = completion.latency_ms
    result.backend = completion.backend
    result.reasoning = completion.reasoning
    return result


def aggregate_craft_dims(
    judgements: List[CraftJudgement],
    job_type: str,
) -> tuple[Dict[str, float], List[str]]:
    """
    多题结果聚合为该工种的 craft 维分数。

    同一维度被多题考查时取均值。未被任何题目评到的维度进入 unscored，
    调用方（stage_scorer）应据此标注不可评，而不是补 0 或补中性分——
    补分会让「没考到」看起来像「考了但不好」。
    """
    buckets: Dict[str, List[float]] = {}
    for judgement in judgements:
        for dim, score in judgement.dims.items():
            buckets.setdefault(dim, []).append(score)

    dims = {
        dim: round(sum(values) / len(values) * 2) / 2
        for dim, values in buckets.items()
        if values
    }
    unscored = [d for d in JOB_CRAFT_DIMS.get(job_type, []) if d not in dims]
    return dims, unscored


# ======================================================================
# Evaluator 契约适配 —— craft_judge 作为 JudgeRegistry 注册成员
# ======================================================================


class CraftJudgeEvaluator:
    """craft 试做题的 LLM-as-judge 评分，受 JudgeRegistry 统一派发约束。

    只评单题（task_id + answer）。多题聚合由调用方自行循环后 aggregate。
    """

    evaluator_id = "craft_judge"
    applicable_jobs = ["code", "text", "image"]
    # 产出维度 = 全部工种 craft 维的并集（每道题只用 target_dims 子集）
    declared_dims = sorted({d for dims in JOB_CRAFT_DIMS.values() for d in dims})

    def evaluate(self, inp: EvaluatorInput) -> EvaluatorOutput:
        if not inp.task_id:
            raise ValueError("craft_judge.evaluate 需要 task_id")
        if not inp.answer:
            return EvaluatorOutput(
                evaluator_id=self.evaluator_id,
                scores={},
                confidence=0.0,
                reasoning="候选未作答",
            )
        try:
            j = judge_craft_task(inp.task_id, inp.answer)
        except JudgeUnavailable:
            raise  # 向上抛，让 Registry 调用方决定降级策略
        # craft_evidence = 有 quote 的 checkpoint（供审计，非 machine-verified）
        craft_ev = {
            f"cp{i}": v.quote
            for i, v in enumerate(j.checkpoints)
            if v.quote
        }
        return EvaluatorOutput(
            evaluator_id=self.evaluator_id,
            scores=dict(j.dims),
            craft_evidence=craft_ev,
            confidence=j.confidence,
            reasoning=j.reasoning,
            metadata={
                "jobType": j.job_type,
                "unscoredDims": j.unscored_dims,
                "paddingDetected": j.padding_detected,
                "paddingNote": j.padding_note,
                "referenceUsed": j.reference_used,
                "backend": j.backend,
                "latencyMs": j.latency_ms,
            },
        )
