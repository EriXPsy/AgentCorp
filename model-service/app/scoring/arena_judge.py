"""
model-service/app/scoring/arena_judge.py
Arena 个性化对决的 LLM-as-judge 裁判。

与 craft_judge 的边界：
- 题源：用户需求（开卷个性化）而非题库闭卷题；
- **无参考答案锚定**（不 import craft_judge.SYSTEM_PROMPT，不读 reference）；
- 评分语义：需求贴合度（craft 维 + fit 需求贴合维）而非标准化能力；
- 共享设施：judge_backend（唯一推理入口/门禁）、_extract_json 解析铁律、
  越界维丢弃、未覆盖维不进分、hit 必须 quote。

客观分汇总（objective_total，供展示与客观 Elo 辅榜）：
    dims 均值（JOB_CRAFT_DIMS 子集，0–5）与 fit（0–5）加权，
    规则：objective_total = round(0.6 * mean(dims) + 0.4 * fit, 1)
    （权重偏客观维，fit 为需求贴合辅助维，体现「个性化但以能力为本」）。

学术依据（现状缺口与升级方向）：
- 本模块当前为「绝对打分 + 单次调用」，存在两类已被文献充分记录的偏差：
  ① 位置偏差（position bias）—— 候选呈现顺序影响打分；
  ② 自我偏好 / 冗长偏差（verbosity bias）—— 偏袒更长、更像模型的输出。
- Chatbot Arena（arXiv:2403.04132）：用**配对比较**（pairwise）+ 随机交换 A/B
  位置再判一次，用对称化消位置偏差，是更鲁棒的相对排序范式。当前绝对打分应升级
  为 pairwise + 位置 swap，El Bradley-Terry 出相对序。
- D3 / Debate-Deliberate-Decide（arXiv:2410.04663）：对抗式多 agent（平行辩手 +
  裁判 + 可选陪审团），可证明地降低位置与冗长偏差。
- MADRAG（arXiv:2606.06754）：Advocate-Skeptic-Judge 辩论 + rubric 对齐的 exemplar
  检索做无训练校准；消融显示「检索驱动校准增益，辩论改善高层特质推理」。
  以上为 arena 从「单次绝对分」迈向「鲁棒相对序」的落地路线。

已落地：pairwise + 位置 swap（见 judge_pairwise / judge_pairwise_robust）。绝对分
（objective_total）仍保留作展示与客观辅榜；当正好两个候选时，compare 端点会额外跑
一次 robust pairwise，其结果记入 ArenaMatch.pairwise，供 UI 展示更鲁棒的相对序。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Dict, List, Optional

from ..judge_backend import JudgeCompletion, JudgeUnavailable, get_backend
from .evaluator_protocol import EvaluatorInput, EvaluatorOutput
from .registry import JOB_CRAFT_DIMS

logger = logging.getLogger("arena_judge")

FIT_WEIGHT = 0.4
DIMS_WEIGHT = 0.6


# 新的裁判 prompt：维度限定 JOB_CRAFT_DIMS[job_type] 子集 + fit 维；
# 同需求对所有 agent 用同一份 rubric 文本（不按答案个性化）。
SYSTEM_PROMPT = """你是 AgentCorp 的 Arena 个性化对决裁判，由 MiniCPM-o 4.5 驱动。
你的任务：针对用户的原始需求，对候选 agent 的实施方案（按工种产出）评判需求贴合度。

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
6. 本场景【无参考答案】：这是用户的个性化需求，没有标准答案。
   评分依据是「该方案对该需求的贴合程度」+「工种可执行性」，
   严禁照抄任何外部模板句式冒充作答。

严格按以下 JSON 输出，不要输出 JSON 以外的任何内容：
{
  "dims": {"<维度键>": 0.0},
  "checkpoints": [{"checkpoint": "原文照抄要点", "hit": true, "quote": "答案片段"}],
  "padding": {"detected": false, "note": ""},
  "fit": 0.0,
  "confidence": 0.0
}"""


def build_arena_messages(
    requirement_text: str,
    task_prompt: str,
    job_type: str,
    answer: str,
) -> List[dict]:
    """构造评分消息（需求 + 题面 + 工种维度 rubric + 候选答案，无参考答案）。"""
    dims = JOB_CRAFT_DIMS.get(job_type, [])
    dim_block = "\n".join(f"- {d}" for d in dims) or "-（工种无维度定义）"
    user_text = (
        f"【用户原始需求】\n{requirement_text.strip() or '(空)'}\n\n"
        f"【题面（需求 + 工种模板）】\n{task_prompt.strip()}\n\n"
        f"【本题考查维度（dims 只能包含这些键 + fit）】\n{dim_block}\n- fit（需求贴合度）\n\n"
        f"【候选答案】\n{answer.strip() or '(候选未作答)'}\n\n"
        "请按系统提示的 JSON 结构输出评分。"
    )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_text},
    ]


def _extract_json(raw: str) -> dict:
    """从模型输出抽取 JSON（与 craft_judge 同铁律：容忍代码块包裹与前后赘余）。"""
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
    """夹到 [0,5] 并对齐 0.5 步进。"""
    clamped = max(0.0, min(5.0, float(value)))
    return round(clamped * 2) / 2


def parse_arena_output(raw: str, job_type: str) -> dict:
    """
    解析裁判输出。越界维度丢弃；缺失目标维记 unscored_dims；hit 必须带 quote。
    返回 dict（可直接并入 ArenaCandidateAnswer.judgement）。
    """
    data = _extract_json(raw)
    allowed = set(JOB_CRAFT_DIMS.get(job_type, []))

    dims: Dict[str, float] = {}
    raw_dims = data.get("dims")
    if isinstance(raw_dims, dict):
        for key, value in raw_dims.items():
            if key not in allowed:
                logger.warning("裁判输出越界维度 %s，已丢弃（工种 %s）", key, job_type)
                continue
            try:
                dims[key] = _clamp_half_step(value)
            except (TypeError, ValueError):
                logger.warning("维度 %s 分数非法（%r），已丢弃", key, value)

    checkpoints: List[dict] = []
    raw_cps = data.get("checkpoints")
    if isinstance(raw_cps, list):
        for item in raw_cps:
            if not isinstance(item, dict):
                continue
            quote = str(item.get("quote", "")).strip()
            hit = bool(item.get("hit")) and bool(quote)
            checkpoints.append(
                {
                    "checkpoint": str(item.get("checkpoint", "")).strip(),
                    "hit": hit,
                    "quote": quote,
                }
            )

    padding = data.get("padding")
    padding_detected = False
    padding_note = ""
    if isinstance(padding, dict):
        padding_detected = bool(padding.get("detected"))
        padding_note = str(padding.get("note", "")).strip()

    try:
        fit = _clamp_half_step(data.get("fit", 0.0))
    except (TypeError, ValueError):
        fit = 0.0
    try:
        confidence = max(0.0, min(1.0, float(data.get("confidence", 0.0))))
    except (TypeError, ValueError):
        confidence = 0.0

    return {
        "dims": dims,
        "unscored_dims": [d for d in sorted(allowed) if d not in dims],
        "checkpoints": checkpoints,
        "padding_detected": padding_detected,
        "padding_note": padding_note,
        "fit": fit,
        "confidence": confidence,
    }


def objective_total(judgement: dict) -> float:
    """客观分汇总：dims 均值 + fit 加权（0.6/0.4），保留 1 位小数。"""
    dims = judgement.get("dims") or {}
    values = [float(v) for v in dims.values() if isinstance(v, (int, float))]
    mean_dims = sum(values) / len(values) if values else 0.0
    fit = float(judgement.get("fit") or 0.0)
    return round(DIMS_WEIGHT * mean_dims + FIT_WEIGHT * fit, 1)


def judge_arena_answer(
    requirement_text: str,
    task_prompt: str,
    job_type: str,
    answer: str,
) -> dict:
    """
    对单个候选答案做 Arena 客观评判（需 judge 后端可用）。

    后端不可用时抛 JudgeUnavailable —— 调用方（routes/arena.py）映射 503。
    """
    backend = get_backend()
    if not backend.available:
        raise JudgeUnavailable(
            f"Arena 客观评判需要可用的 judge 后端（当前 {backend.name} 不可用）。"
            "请配置 JUDGE_BACKEND=http 或 local。"
        )
    completion: JudgeCompletion = backend.complete(
        build_arena_messages(requirement_text, task_prompt, job_type, answer)
    )
    judgement = parse_arena_output(completion.text, job_type)
    judgement["backend"] = completion.backend
    judgement["ttft_ms"] = completion.ttft_ms
    judgement["latency_ms"] = completion.latency_ms
    judgement["objective_total"] = objective_total(judgement)
    # 裁判思维链（供 metaJudge 一致性审计 / UI 展示推理过程）；未启用思考模式时为空串。
    judgement["reasoning"] = completion.reasoning
    return judgement


# ======================================================================
# Pairwise 相对比较（Chatbot Arena 范式：配对 + 位置 swap 消位置偏差）
# ======================================================================
#: 匿名标签：两份方案只标 A/B，裁判看不到 agent 身份，避免名气/冗长偏差渗入。
_PAIRWISE_SYSTEM_PROMPT = """你是 AgentCorp 的 Arena 配对裁判，由 MiniCPM-o 4.5 驱动。
你的任务：针对同一需求，比较两份候选方案（A 与 B），判断哪一份更贴合需求且可执行。

铁律：
1. 只依据方案实际内容判定，不猜测、不因表述自信加分。
2. A/B 只是呈现标签，不代表任何优劣；两份可能是同一作者的不同版本。
3. 若两份质量实质相当，判 tie，不要硬分高下。
4. 必须给出 ≤80 字的核心理由，且引用双方各自的依据（找得到原文才作数）。

严格按以下 JSON 输出，不要输出 JSON 以外的任何内容：
{"winner": "A", "confidence": 0.0, "reasoning": "..."}
winner 只能是 "A" / "B" / "tie" 三者之一。"""


def build_pairwise_messages(
    requirement_text: str,
    task_prompt: str,
    job_type: str,
    answer_a: str,
    answer_b: str,
) -> List[dict]:
    """构造配对比较消息（A 与 B 匿名并列，供位置 swap 复用）。"""
    user_text = (
        f"【用户原始需求】\n{requirement_text.strip() or '(空)'}\n\n"
        f"【题面】\n{task_prompt.strip()}\n\n"
        f"【工种】{job_type}\n\n"
        f"【方案 A】\n{answer_a.strip() or '(A 未作答)'}\n\n"
        f"【方案 B】\n{answer_b.strip() or '(B 未作答)'}\n\n"
        "请按系统提示的 JSON 输出谁更优（A / B / tie）。"
    )
    return [
        {"role": "system", "content": _PAIRWISE_SYSTEM_PROMPT},
        {"role": "user", "content": user_text},
    ]


def parse_pairwise_output(raw: str) -> dict:
    """解析配对裁判输出 → {winner, confidence, reasoning}。winner 归一为 A/B/tie。"""
    data = _extract_json(raw)
    winner = str(data.get("winner", "tie")).strip().upper()
    if winner not in ("A", "B", "TIE"):
        winner = "TIE"
    else:
        winner = "A" if winner == "A" else ("B" if winner == "B" else "TIE")
    try:
        confidence = max(0.0, min(1.0, float(data.get("confidence", 0.5))))
    except (TypeError, ValueError):
        confidence = 0.5
    return {
        "winner": winner,
        "confidence": round(confidence, 3),
        "reasoning": str(data.get("reasoning", "")).strip()[:200],
    }


def judge_pairwise(
    requirement_text: str,
    task_prompt: str,
    job_type: str,
    answer_a: str,
    answer_b: str,
) -> dict:
    """单次配对比较（后端不可用抛 JudgeUnavailable）。"""
    backend = get_backend()
    if not backend.available:
        raise JudgeUnavailable(
            f"Arena 配对比较需要可用的 judge 后端（当前 {backend.name} 不可用）。"
        )
    completion: JudgeCompletion = backend.complete(
        build_pairwise_messages(requirement_text, task_prompt, job_type, answer_a, answer_b)
    )
    result = parse_pairwise_output(completion.text)
    result["backend"] = completion.backend
    result["latency_ms"] = completion.latency_ms
    return result


def judge_pairwise_robust(
    requirement_text: str,
    task_prompt: str,
    job_type: str,
    answer_a: str,
    answer_b: str,
) -> dict:
    """
    鲁棒配对比较：跑两次（原序 + A/B 交换），用对称化消位置偏差。

    返回：
      winner        —— 归一化到实际候选的结论：'first' | 'second' | 'tie' | 'uncertain'
      consistent    —— 两次判定是否一致（不一致通常意味着位置偏差或实质接近）
      position_bias —— 两次都偏向「呈现顺序上的前者」→ 强烈提示位置偏差
      confidence    —— 两次置信的均值
      reasoning     —— 采纳的那一次理由
      runs          —— 两次原始结果（审计用）

    判定逻辑（关键）：把「呈现标签 A/B」映射回「实际候选 first/second」。
    - 原序：A=first, B=second；
    - 交换序：A=second, B=first（因为物理上把两份对调了）。
    若两次映射后指向同一实际候选 → 一致（consistent）；否则 → uncertain。
    若两次都判「呈现序前者」赢（raw 都是 A）→ position_bias（裁判只认位置）。
    """
    r1 = judge_pairwise(requirement_text, task_prompt, job_type, answer_a, answer_b)
    # 交换：物理上把两份对调，看裁判是否还给同一个实际候选
    r2 = judge_pairwise(requirement_text, task_prompt, job_type, answer_b, answer_a)

    # 把 raw A/B 映射到实际候选
    def to_actual(raw_winner: str, swapped: bool) -> str:
        if raw_winner == "TIE":
            return "tie"
        # 未交换：A→first, B→second；已交换：A→second, B→first
        if not swapped:
            return "first" if raw_winner == "A" else "second"
        return "second" if raw_winner == "A" else "first"

    a1 = to_actual(r1["winner"], swapped=False)
    a2 = to_actual(r2["winner"], swapped=True)

    position_bias = r1["winner"] == "A" and r2["winner"] == "A"  # 两次都认呈现序首位
    consistent = (a1 == a2) and a1 != "tie"

    if position_bias:
        winner, note = "uncertain", "两次均偏向呈现序首位，疑似位置偏差，结论降级为不确定"
    elif consistent:
        winner, note = a1, "两次交换位置后结论一致"
    elif a1 == "tie" or a2 == "tie":
        winner, note = "tie", "至少一次判为实质相当"
    else:
        winner, note = "uncertain", "交换位置后结论反转，疑似位置偏差或实质接近"

    confidence = round((r1["confidence"] + r2["confidence"]) / 2, 3)
    # 采纳与结论同向那一次的理由；不确定/平局用说明文字兜底
    if winner == "first":
        reasoning = r1["reasoning"] or note
    elif winner == "second":
        reasoning = r2["reasoning"] or note
    else:
        reasoning = note
    return {
        "winner": winner,
        "consistent": consistent,
        "position_bias": position_bias,
        "confidence": confidence,
        "reasoning": reasoning,
        "runs": [r1, r2],
    }


# ======================================================================
# Evaluator 契约适配 —— arena_judge 作为 JudgeRegistry 注册成员
# ======================================================================


class ArenaJudgeEvaluator:
    """Arena 个性化需求贴合度评分，受 JudgeRegistry 统一派发约束。

    评单候选（requirement + task_prompt + job_type + answer）。

    不声明 declared_dims：arena 产出包含 craft 维 + fit（需求贴合辅助维），
    fit 不在 registry 维度体系内（属「个性化偏好」信号，由消费者 stage_scorer
    特殊处理）。静态校验会误报，故跳过，改为运行期由消费者过滤。
    """

    evaluator_id = "arena_judge"
    applicable_jobs = ["code", "text", "image"]

    def evaluate(self, inp: EvaluatorInput) -> EvaluatorOutput:
        opts = inp.options or {}
        requirement = inp.requirement or opts.get("requirement_text", "")
        task_prompt = opts.get("task_prompt", "")
        if not requirement:
            raise ValueError("arena_judge.evaluate 需要 requirement（EvaluatorInput.requirement）")
        if not inp.answer:
            return EvaluatorOutput(
                evaluator_id=self.evaluator_id,
                scores={},
                confidence=0.0,
                reasoning="候选未作答",
            )
        judgement = judge_arena_answer(
            requirement_text=requirement,
            task_prompt=task_prompt,
            job_type=inp.job_type,
            answer=inp.answer,
        )
        # craft_evidence = 有 quote 的 checkpoint
        craft_ev = {
            f"cp{i}": cp["quote"]
            for i, cp in enumerate(judgement.get("checkpoints", []))
            if cp.get("quote")
        }
        return EvaluatorOutput(
            evaluator_id=self.evaluator_id,
            scores=dict(judgement.get("dims", {})),
            craft_evidence=craft_ev,
            confidence=judgement.get("confidence", 0.0),
            reasoning=judgement.get("reasoning", ""),
            metadata={
                "fit": judgement.get("fit", 0.0),
                "objectiveTotal": judgement.get("objective_total", 0.0),
                "unscoredDims": judgement.get("unscored_dims", []),
                "paddingDetected": judgement.get("padding_detected", False),
                "paddingNote": judgement.get("padding_note", ""),
                "backend": judgement.get("backend", ""),
                "latencyMs": judgement.get("latency_ms", 0.0),
            },
        )
