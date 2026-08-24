"""
model-service/app/scoring/designer.py
SPADE Designer 角色：根据团队 StyleMemory（语义记忆）生成自适应可执行测试环境。

为什么不手工写题库：
- 固定题库所有人跑同样的题 → 高分段团队秒杀、低分段团队全挂，区分度为零
- SPADE 的核心发现：Designer 产出「刚好在能力前沿」的题目时学习效率最高
- 每个团队风格不同（前端重 UI 逻辑、后端重数据处理、安全重输入校验），
  通用题无法精准衡量各自的真实水平

Designer 的核心驱动力是 StyleMemory——不是固定指标（通过率/强弱维度），
而是 Designer 通过 reflection 涌现出的语义理解（current_understanding）。
每次评测后 Reflector 会写一条观察，每 3 条合成为综合理解，Designer 据此出题。

Designer 的产出：
- CraftTask：题面 + checkpoints + probes（LLM 裁判用）
- SandboxSpec：fixture 数据 + 断言脚本（沙箱可验）

降级契约：LLM 不可用时返回 degraded=True，不影响已有评测链路。
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from ..judge_backend import JudgeCompletion, JudgeUnavailable, get_backend
from ..sandbox.craft_tasks_sandbox import SandboxSpec
from ..sandbox.runner import SandboxResult, run_python_answer
from .craft_tasks import CraftTask
from .evaluator_protocol import EvaluatorHealth, EvaluatorInput, EvaluatorOutput
from .registry import JOB_CRAFT_DIMS
from .team_style import TeamStyleProfile

logger = logging.getLogger("designer")


# ======================================================================
# Designer 产出
# ======================================================================
@dataclass
class DesignedChallenge:
    """Designer 生成的一道自适应题目。"""

    task: CraftTask
    sandbox_spec: Optional[SandboxSpec] = None
    design_rationale: str = ""         # Designer 为什么出这道题
    target_dim: str = ""               # 目标维度
    difficulty: float = 0.5            # 0-1，Designer 自评难度

    @property
    def is_validated(self) -> bool:
        """是否有可执行的沙箱规格。"""
        return self.sandbox_spec is not None and bool(self.sandbox_spec.test_harness)


# ======================================================================
# Designer Prompt 模板
# ======================================================================
_DESIGNER_SYSTEM = """\
你是一个自适应测试环境设计师（Environment Designer）。

你的任务：根据 Designer 对团队的语义理解（来自多轮反思涌现），生成一道
**刚好在该团队能力前沿**的编程题。

你不是在看冷冰冰的数字（通过率、维度均分），而是在读一份「对团队风格的理解」。
这份理解告诉你：
- 团队偏爱的代码组织方式（优雅的？务实的？防御性的？）
- 他们在边界处理、错误处理、性能优化上的习惯和盲区
- 他们在哪些方面表现出「品味」（命名、结构、抽象层次）

要求：
1. 题目必须基于理解中的**盲区和风格特征**出题，而非固定指标
2. 如果理解中提到了团队忽视的边界情况，那道题就专门埋这些边界
3. 如果团队偏爱某种模式（如函数式 vs OOP），用他们熟悉的方式包装新约束
4. 题目必须是「纯输入→输出」的数据变换，可确定性断言（不要出设计/推理题）
5. 同时生成 test_harness（Python 断言脚本）—— 脚本从 `solution` 模块导入入口函数，
   对多组输入做断言，最后 print JSON {"total": N, "passed": N, "errors": [...]}

输出格式（严格 JSON，不要 markdown 代码块）：
{
  "task_id": "adaptive_<简短英文名>",
  "title": "题目标题",
  "prompt": "题面文本（直接发给候选 agent）",
  "target_dims": ["维度1", "维度2"],
  "checkpoints": ["要点1", "要点2", ...],
  "probes": ["探针1", ...],
  "entry_function": "入口函数名",
  "test_harness": "Python 断言脚本源码",
  "design_rationale": "为什么出这道题（引用你对团队的理解）",
  "difficulty": 0.5
}
"""


def _build_designer_prompt(profile: TeamStyleProfile) -> str:
    """构建 Designer 的 user message。

    从 TeamStyleProfile 中提取语义信息。Profile 可能来自两种来源：
    1. 初始用户设定（declared_focus = 团队描述）
    2. StyleMemory 转换（declared_focus = current_understanding，
       experience_lessons = [understanding, next_hypothesis]）
    """
    available_dims = JOB_CRAFT_DIMS.get(profile.primary_job_type, [])

    lines = [
        "## 团队信息",
        f"- 团队 ID: {profile.team_id}",
        f"- 声明重点: {profile.declared_focus or '(未声明)'}",
        f"- 主攻工种: {profile.primary_job_type}",
        f"- 成员数: {profile.member_count}",
        f"- 评测次数: {profile.eval_count}",
    ]

    # StyleMemory 涌现的理解（如果有）
    if profile.experience_lessons:
        lines.append("")
        lines.append("## Designer 的当前理解（来自多轮反思）")
        for lesson in profile.experience_lessons:
            if lesson:
                lines.append(f"- {lesson}")

    lines.extend([
        "",
        f"## 可用 craft 维度（target_dims 必须是这些的子集）",
        ", ".join(available_dims),
        "",
        "## 出题约束",
        f"- job_type: {profile.primary_job_type}",
        "- 必须是确定性可断言的题（纯输入→输出）",
        "- test_harness 里用 `from solution import <入口函数>` 导入",
        "- 至少 6 个断言（含边界情况）",
        "- 难度 0.3-0.8 之间（太简单无区分度，太难无法完成）",
    ])

    if profile.task_types_seen:
        lines.append(f"- 避免重复已做过的题型：{', '.join(profile.task_types_seen[:5])}")

    return "\n".join(lines)


def _parse_designer_response(text: str) -> Optional[Dict]:
    """从 LLM 响应中提取 JSON（容忍 markdown 代码块包裹）。"""
    # 去掉 markdown 代码块
    cleaned = re.sub(r"```(?:json)?\s*", "", text)
    cleaned = re.sub(r"```\s*$", "", cleaned.strip())

    # 找第一段 {...}
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if not match:
        return None

    try:
        return json.loads(match.group())
    except json.JSONDecodeError:
        return None


# ======================================================================
# Designer 核心逻辑
# ======================================================================
def design_challenge(
    profile: TeamStyleProfile,
    *,
    validate: bool = True,
) -> DesignedChallenge:
    """根据团队风格画像生成一道自适应题目。

    Args:
        profile: 团队风格画像
        validate: 是否用沙箱验证生成的 harness 可执行（默认 True）

    Returns:
        DesignedChallenge — 可能 sandbox_spec=None（验证失败或 LLM 不可用）

    Raises:
        JudgeUnavailable: LLM 后端不可用
    """
    backend = get_backend()
    if not backend.available:
        raise JudgeUnavailable("Designer LLM 后端不可用")

    messages = [
        {"role": "system", "content": _DESIGNER_SYSTEM},
        {"role": "user", "content": _build_designer_prompt(profile)},
    ]

    completion: JudgeCompletion = backend.complete(
        messages,
        temperature=0.7,
        max_tokens=4096,
    )

    parsed = _parse_designer_response(completion.text)
    if not parsed:
        logger.warning("Designer 返回非法 JSON：%s", completion.text[:200])
        return DesignedChallenge(
            task=CraftTask(
                id=f"adaptive_fallback_{uuid.uuid4().hex[:6]}",
                job_type=profile.primary_job_type,
                title="Designer 输出解析失败",
                prompt="",
                target_dims=[],
            ),
            design_rationale="Designer LLM 输出无法解析为 JSON",
        )

    # 构建 CraftTask
    task = CraftTask(
        id=parsed.get("task_id", f"adaptive_{uuid.uuid4().hex[:6]}"),
        job_type=profile.primary_job_type,
        title=parsed.get("title", ""),
        prompt=parsed.get("prompt", ""),
        target_dims=parsed.get("target_dims", []),
        checkpoints=parsed.get("checkpoints", []),
        probes=parsed.get("probes", []),
    )

    # 构建 SandboxSpec
    harness = parsed.get("test_harness", "")
    spec = SandboxSpec(
        task_id=task.id,
        test_harness=harness,
        machine_verifiable_dims=task.target_dims[:2],  # 最多 2 个机验维度
    ) if harness else None

    # 验证 harness 可执行性
    if validate and spec and harness:
        # 用一个简单的正确实现测试 harness 本身没语法错误
        _validate_harness(spec, parsed.get("entry_function", "solve"))

    return DesignedChallenge(
        task=task,
        sandbox_spec=spec,
        design_rationale=parsed.get("design_rationale", ""),
        target_dim="",  # 由 StyleMemory 的 hypothesis 驱动，不再用固定 frontier
        difficulty=float(parsed.get("difficulty", 0.5)),
    )


def _validate_harness(spec: SandboxSpec, entry_function: str) -> bool:
    """用最小实现验证 harness 能正常执行（不报语法错误/导入错误）。

    用一个恒等函数作为 solution，harness 可能全部失败但不应该崩。
    如果 harness 本身有语法错误，沙箱会报 error——此时标记 spec 不可用。
    """
    # 生成一个最小 stub：入口函数存在但返回 None
    stub = f"def {entry_function}(*args, **kwargs):\n    return None\n"

    try:
        result: SandboxResult = run_python_answer(stub, task_id=spec.task_id)
        # harness 能跑完（即使断言全失败）就说明 harness 本身是合法的
        return result.outcome in ("passed", "failed")
    except Exception as exc:
        logger.warning("Designer harness 验证失败：%s", exc)
        return False


# ======================================================================
# DesignerEvaluator — 注册进 JudgeRegistry
# ======================================================================
class DesignerEvaluator:
    """SPADE Designer：消费 TeamStyleProfile，产出自适应题目。

    注册为 JudgeRegistry evaluator，可通过 dispatch("designer", ...) 调用。
    降级契约：LLM 不可用时返回 degraded=True + 空 evidence。
    """

    evaluator_id = "designer"
    applicable_jobs = ["code", "text", "image"]
    declared_dims: List[str] = []  # Designer 不自定维度

    def evaluate(self, inp: EvaluatorInput) -> EvaluatorOutput:
        # 从 input 重建 profile
        profile = self._profile_from_input(inp)
        if profile is None:
            return EvaluatorOutput(
                evaluator_id=self.evaluator_id,
                scores={},
                verified_evidence={},
                confidence=0.0,
                reasoning="无法从输入构建团队风格画像",
                degraded=True,
                degraded_reason="缺少 team_id 或评测历史",
            )

        try:
            challenge = design_challenge(profile)
        except JudgeUnavailable as exc:
            return EvaluatorOutput(
                evaluator_id=self.evaluator_id,
                scores={},
                verified_evidence={},
                confidence=0.0,
                reasoning=f"Designer LLM 不可用：{exc}",
                degraded=True,
                degraded_reason=str(exc),
            )

        if not challenge.task.prompt:
            return EvaluatorOutput(
                evaluator_id=self.evaluator_id,
                scores={},
                verified_evidence={},
                confidence=0.0,
                reasoning="Designer 输出无效",
                degraded=True,
                degraded_reason="LLM 输出无法解析",
            )

        # 证据：生成了一道可验证的自适应题目
        evidence_key = f"adaptive_challenge_{challenge.task.id}"
        evidence_text = (
            f"自适应出题：{challenge.task.title}，"
            f"目标维度={challenge.target_dim or '未指定'}，"
            f"难度={challenge.difficulty:.1f}"
        )
        if challenge.is_validated:
            evidence_text += "（harness 已验证可执行）"

        return EvaluatorOutput(
            evaluator_id=self.evaluator_id,
            scores={},
            verified_evidence={evidence_key: evidence_text},
            confidence=0.8 if challenge.is_validated else 0.4,
            reasoning=challenge.design_rationale,
            metadata={
                "taskId": challenge.task.id,
                "title": challenge.task.title,
                "prompt": challenge.task.prompt,
                "targetDims": challenge.task.target_dims,
                "checkpoints": challenge.task.checkpoints,
                "probes": challenge.task.probes,
                "difficulty": challenge.difficulty,
                "validated": challenge.is_validated,
            },
        )

    def health(self) -> EvaluatorHealth:
        backend = get_backend()
        if not backend.available:
            return EvaluatorHealth(
                evaluator_id=self.evaluator_id,
                status="degraded",
                reason="Designer LLM 后端不可用",
            )
        return EvaluatorHealth(evaluator_id=self.evaluator_id, status="healthy")

    @staticmethod
    def _profile_from_input(inp: EvaluatorInput) -> Optional[TeamStyleProfile]:
        """从 EvaluatorInput 重建 TeamStyleProfile。

        支持两种输入格式：
        1. options.profile 为 dict → 按字段重建
        2. options.style_memory 为 StyleMemory → 提取语义信息
        3. 只有 agent_id + job_type → 最小 profile
        """
        opts = inp.options or {}
        team_id = opts.get("team_id") or inp.agent_id
        if not team_id:
            return None

        # 从 options 里取 profile 数据
        profile_data = opts.get("profile")
        if profile_data and isinstance(profile_data, dict):
            return TeamStyleProfile(
                team_id=team_id,
                declared_focus=profile_data.get("declared_focus", ""),
                primary_job_type=profile_data.get("primary_job_type", inp.job_type),
                member_count=profile_data.get("member_count", 0),
                experience_lessons=profile_data.get("experience_lessons", []),
                eval_count=profile_data.get("eval_count", 0),
                task_types_seen=profile_data.get("task_types_seen", []),
            )

        # 从 StyleMemory 提取（route 层可能直接传 StyleMemory dict）
        memory_data = opts.get("style_memory")
        if memory_data and isinstance(memory_data, dict):
            lessons = []
            if memory_data.get("current_understanding"):
                lessons.append(memory_data["current_understanding"])
            if memory_data.get("next_challenge_hypothesis"):
                lessons.append(memory_data["next_challenge_hypothesis"])
            return TeamStyleProfile(
                team_id=team_id,
                declared_focus=memory_data.get("current_understanding", ""),
                primary_job_type=inp.job_type,
                member_count=0,
                experience_lessons=lessons,
                eval_count=memory_data.get("reflection_count", 0),
                task_types_seen=memory_data.get("challenges_issued", []),
            )

        # 降级：只有 agent_id 和 job_type，生成最小 profile
        return TeamStyleProfile(
            team_id=team_id,
            primary_job_type=inp.job_type,
            declared_focus=inp.requirement or "",
        )


# ======================================================================
# S1 初审：候选能力 × 团队需求 快速适配评分
# ======================================================================

_PRESCREEN_SYSTEM = """\
你是一个人才初审官。你的任务是根据候选 Agent 的能力描述和团队当前需求，
快速评估该候选在六个维度上的适配分数。

你不是在做完整的能力测试，而是在做「初步筛选」：
- 候选声明了什么能力 → 能兑现多少？
- 团队缺什么 → 这个候选能不能补上？
- 候选风格跟团队搭不搭？

六个维度（每个 0-5 分，0.5 步进）：
1. task_completion（任务完成度）：候选能力与团队任务类型的匹配程度
2. code_quality（代码质量）：候选声称的代码水平
3. communication（沟通协作）：候选描述中体现的协作/沟通能力
4. creativity（创造力）：候选是否展现创新思维
5. reliability（可靠性）：候选经验的深度和一致性
6. cost_efficiency（成本效率）：候选能力的性价比

输出格式（严格 JSON，不要 markdown 代码块）：
{
  "radar": {"task_completion": 0-5, "code_quality": 0-5, "communication": 0-5, "creativity": 0-5, "reliability": 0-5, "cost_efficiency": 0-5},
  "confidence": 0-1,
  "fit_summary": "一句话总结适配度",
  "strengths": ["强项1", "强项2"],
  "risks": ["风险1"],
  "recommendation": "hire" | "maybe" | "pass"
}
"""


def _build_prescreen_prompt(
    candidate_name: str,
    candidate_description: str,
    candidate_capabilities: List[str],
    team_understanding: str,
    team_weaknesses: List[str],
    team_strengths: List[str],
    next_hypothesis: str,
) -> str:
    """构建 S1 初审的 user message。"""
    caps = "\n".join(f"- {c}" for c in candidate_capabilities) if candidate_capabilities else "（未声明具体能力）"

    return f"""\
## 候选 Agent
- 名称：{candidate_name}
- 描述：{candidate_description}
- 声明能力：
{caps}

## 团队现状
- Designer 理解：{team_understanding or '（尚无评估记录）'}
- 团队强项：{', '.join(team_strengths) if team_strengths else '（未知）'}
- 团队弱项：{', '.join(team_weaknesses) if team_weaknesses else '（未知）'}
- 下一轮出题方向：{next_hypothesis or '（未设定）'}

请根据以上信息，对该候选做 S1 初审打分。重点关注：候选能力能否补上团队的弱项。
"""


def prescreen_candidate(
    candidate_name: str,
    candidate_description: str,
    candidate_capabilities: List[str],
    team_understanding: str = "",
    team_weaknesses: Optional[List[str]] = None,
    team_strengths: Optional[List[str]] = None,
    next_hypothesis: str = "",
) -> Dict[str, Any]:
    """S1 初审：用 Designer LLM 对候选做六维适配评分。

    Returns:
        dict with keys: radar, confidence, fit_summary, strengths, risks, recommendation
        degraded=True 时返回空 radar + 降级原因
    """
    from ..judge_backend import get_backend

    backend = get_backend()
    if not backend.available:
        return {
            "radar": {},
            "confidence": 0,
            "fit_summary": "评测后端不可用",
            "strengths": [],
            "risks": ["LLM 后端未配置"],
            "recommendation": "pass",
            "degraded": True,
            "degraded_reason": "Judge backend unavailable",
        }

    messages = [
        {"role": "system", "content": _PRESCREEN_SYSTEM},
        {"role": "user", "content": _build_prescreen_prompt(
            candidate_name, candidate_description, candidate_capabilities,
            team_understanding, team_weaknesses or [], team_strengths or [], next_hypothesis,
        )},
    ]

    try:
        completion: JudgeCompletion = backend.complete(
            messages,
            temperature=0.3,
            max_tokens=1024,
        )
        parsed = _parse_prescreen_response(completion.text)
        if parsed:
            return parsed
        return {
            "radar": {},
            "confidence": 0,
            "fit_summary": "初审输出解析失败",
            "strengths": [],
            "risks": ["LLM 输出格式异常"],
            "recommendation": "maybe",
            "degraded": True,
            "degraded_reason": f"Parse failed: {completion.text[:100]}",
        }
    except Exception as exc:
        return {
            "radar": {},
            "confidence": 0,
            "fit_summary": f"初审异常：{exc}",
            "strengths": [],
            "risks": [str(exc)],
            "recommendation": "pass",
            "degraded": True,
            "degraded_reason": str(exc),
        }


def _parse_prescreen_response(text: str) -> Optional[Dict[str, Any]]:
    """解析初审 LLM 输出为 dict。"""
    # 尝试提取 JSON
    cleaned = text.strip()
    if cleaned.startswith("```"):
        # 去掉 markdown 代码块
        lines = cleaned.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        cleaned = "\n".join(lines)

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        # 尝试正则提取 JSON 块
        m = re.search(r'\{.*\}', cleaned, re.DOTALL)
        if m:
            try:
                data = json.loads(m.group())
            except json.JSONDecodeError:
                return None
        else:
            return None

    radar = data.get("radar", {})
    # 确保所有值在 [0, 5]
    for k in radar:
        radar[k] = max(0, min(5, float(radar[k])))

    return {
        "radar": radar,
        "confidence": float(data.get("confidence", 0.5)),
        "fit_summary": data.get("fit_summary", ""),
        "strengths": data.get("strengths", []),
        "risks": data.get("risks", []),
        "recommendation": data.get("recommendation", "maybe"),
        "degraded": False,
    }
