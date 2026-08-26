"""Semantic style memory for the SPADE-inspired adaptive challenge system.

In SPADE (Self-Play through Adaptive DEsign), the Designer LLM does not merely
score a team's submission with fixed metrics. Instead it keeps a *semantic
memory* of each team's evolving coding style and engineering taste. After every
evaluation the Designer *reflects* on the submission, appends an evidence-based
observation to the team's memory, and periodically re-synthesizes those
observations into a coherent style description.

Why semantic memory beats fixed metrics
---------------------------------------
Fixed metrics (lint score, cyclomatic complexity, pass rate) are blind to
*aesthetic* and *structural* choices that recur across tasks but never trigger
a rule: a team that always writes 200-line single functions, or that reaches
for inheritance where composition would do, or that handles boundary errors
with silent defaults. A semantic memory captures these as prose that can be
reasoned about, challenged, and compared. The next challenge is then
*hypothesized* from the memory rather than sampled from a fixed pool, so the
system adapts to the team instead of re-measuring the same thing forever.

Reflection loop
---------------
    reflect(submission) -> observation -> append
         every 3 reflections -> _synthesize() -> current_understanding
         always              -> _hypothesize_next() -> next_challenge_hypothesis
    next challenge is generated from next_challenge_hypothesis
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from ..judge_backend import (  # noqa: E402
    JudgeCompletion,
    JudgeUnavailable,
    get_backend,
)

logger = logging.getLogger("style_memory")


# ---------------------------------------------------------------------------
# Reflection prompt templates
# ---------------------------------------------------------------------------

REFLECTION_SYSTEM_PROMPT = (
    "You are an expert at analyzing team coding style and engineering taste.\n"
    "You observe a team's answer to a challenge and reflect on what their code\n"
    "reveals about their style, strengths, weaknesses, and aesthetic preferences.\n"
    "Be specific and evidence-based — cite actual patterns from the code, not "
    "generic praise."
)

REFLECTION_USER_TEMPLATE = """\
You previously formed this understanding of the team (may be empty on first contact):
--- CURRENT UNDERSTANDING ---
{current_understanding}
-----------------------------

A challenge was issued:
--- CHALLENGE ---
{challenge}
----------------

The team submitted this answer:
--- ANSWER ---
{answer}
------------

The LLM judge assigned these scores (JSON):
{scores}

The sandbox outcome for the submission was: {outcome}

Reflect on what this submission reveals. Write a focused observation of 2-3 \
sentences that covers, where the evidence supports it:
  a) Style or structural patterns you did NOT notice before (or that recur /
     contradict your current understanding).
  b) What the code organization reveals about the team's aesthetic preferences.
  c) Which edge cases they handled versus ignored, and what that choice pattern
     suggests about their engineering priorities.

Do not restate the scores. Do not praise generically. Cite concrete patterns \
from the code. Return only the observation text, with no markdown formatting \
and no preamble like "Observation:".
"""

SYNTHESIZE_SYSTEM_PROMPT = (
    "You are an expert at synthesizing observations about a team's coding "
    "style into a coherent, evidence-based description. Be specific and "
    "grounded in the observations provided."
)

SYNTHESIZE_USER_TEMPLATE = """\
Below are recent observations about a team's coding style, oldest first:
--- OBSERVATIONS ---
{observations}
--------------------

The prior synthesized understanding (may be empty) was:
--- PRIOR UNDERSTANDING ---
{prior_understanding}
---------------------------

Synthesize these into a coherent description of the team's style in 3-5 \
sentences. Focus on durable, recurring patterns — aesthetic preferences, \
structural habits, how they treat edge cases, strengths, and weaknesses. \
Drop one-off details. Resolve contradictions by noting them explicitly. \
Return only the description, with no markdown formatting and no preamble.
"""

HYPOTHESIZE_SYSTEM_PROMPT = (
    "You are a challenge designer. Given what you know about a team's style "
    "and their performance history, you decide what the next challenge should "
    "target to stretch them and reveal more about their engineering taste."
)

HYPOTHESIZE_USER_TEMPLATE = """\
Current understanding of the team:
--- UNDERSTANDING ---
{understanding}
--------------------

Their performance log (most recent last), as JSON:
{performance_log}

Challenges already issued (avoid repeating these or near-duplicates):
{issued}

What should the NEXT challenge target? Describe, in 2-3 sentences, the skill, "
"blind spot, or aesthetic preference it should probe and why, given the "
"evidence above. Do not propose a concrete task spec — propose a *target*. "
"Return only the target description, with no markdown formatting and no preamble.
"""


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class StyleMemory:
    """Semantic memory of one team's evolving coding style.

    Attributes:
        team_id: Identifier of the team this memory belongs to.
        observations: One evidence-based reflection per evaluation, in order.
        current_understanding: Synthesized prose description, refreshed every
            ``synthesize_every`` reflections.
        next_challenge_hypothesis: The Designer's current belief about what the
            team should be challenged on next.
        challenges_issued: Task IDs already issued, so challenges are not
            repeated.
        performance_log: Per-task records of outcome and scores.
        reflection_count: Number of reflections appended so far.
        synthesize_every: How many reflections between re-syntheses.
    """

    team_id: str
    observations: List[str] = field(default_factory=list)
    current_understanding: str = ""
    next_challenge_hypothesis: str = ""
    challenges_issued: List[str] = field(default_factory=list)
    performance_log: List[Dict] = field(default_factory=list)
    reflection_count: int = 0
    synthesize_every: int = 3

    # ---- 持续优化：Prompt 自我进化 ----
    #: 进化后的 reflection system prompt（None = 用模块默认值）
    evolved_reflection_system: Optional[str] = None
    #: 进化后的 hypothesis system prompt（None = 用模块默认值）
    evolved_hypothesis_system: Optional[str] = None
    #: 反思质量评分历史（每次 evolve_check 追加一条 0-1 分数）
    reflection_quality_history: List[float] = field(default_factory=list)
    #: 假设命中率历史
    hypothesis_accuracy_history: List[float] = field(default_factory=list)
    #: 历史假设列表（与 observations 一一对应，供准确率审查）
    hypothesis_history: List[str] = field(default_factory=list)
    #: 累计进化次数
    evolution_count: int = 0
    #: 每多少次反思触发一次 prompt 审查
    evolve_every: int = 20

    def to_dict(self) -> Dict:
        """Serialize to a JSON-friendly dict."""
        return {
            "team_id": self.team_id,
            "observations": list(self.observations),
            "current_understanding": self.current_understanding,
            "next_challenge_hypothesis": self.next_challenge_hypothesis,
            "challenges_issued": list(self.challenges_issued),
            "performance_log": list(self.performance_log),
            "reflection_count": self.reflection_count,
            "synthesize_every": self.synthesize_every,
            "evolved_reflection_system": self.evolved_reflection_system,
            "evolved_hypothesis_system": self.evolved_hypothesis_system,
            "reflection_quality_history": list(self.reflection_quality_history),
            "hypothesis_accuracy_history": list(self.hypothesis_accuracy_history),
            "hypothesis_history": list(self.hypothesis_history),
            "evolution_count": self.evolution_count,
            "evolve_every": self.evolve_every,
        }

    @classmethod
    def from_dict(cls, data: Dict) -> "StyleMemory":
        """Rehydrate from a dict produced by :meth:`to_dict`."""
        return cls(
            team_id=data["team_id"],
            observations=list(data.get("observations", [])),
            current_understanding=data.get("current_understanding", ""),
            next_challenge_hypothesis=data.get("next_challenge_hypothesis", ""),
            challenges_issued=list(data.get("challenges_issued", [])),
            performance_log=list(data.get("performance_log", [])),
            reflection_count=int(data.get("reflection_count", 0)),
            synthesize_every=int(data.get("synthesize_every", 3)),
            evolved_reflection_system=data.get("evolved_reflection_system"),
            evolved_hypothesis_system=data.get("evolved_hypothesis_system"),
            reflection_quality_history=list(data.get("reflection_quality_history", [])),
            hypothesis_accuracy_history=list(data.get("hypothesis_accuracy_history", [])),
            hypothesis_history=list(data.get("hypothesis_history", [])),
            evolution_count=int(data.get("evolution_count", 0)),
            evolve_every=int(data.get("evolve_every", 20)),
        )


# ---------------------------------------------------------------------------
# Reflector
# ---------------------------------------------------------------------------


class Reflector:
    """Drives the SPADE reflection loop for a team's :class:`StyleMemory`.

    The reflector calls the judge LLM backend at temperature 0.3 (more
    deterministic than the Designer's generation temperature) so reflections
    stay grounded in evidence rather than drifting.
    """

    def __init__(self, temperature: float = 0.3, max_tokens: int = 1024):
        self.temperature = temperature
        self.max_tokens = max_tokens
        # PromptEvolver 延迟导入（避免循环依赖）
        self._evolver = None

    # -- public API ---------------------------------------------------------

    def reflect(
        self,
        task_prompt: str,
        answer: str,
        scores: Dict,
        outcome: str,
        memory: StyleMemory,
        task_id: Optional[str] = None,
        timestamp: Optional[str] = None,
    ) -> StyleMemory:
        """Reflect on one submission and update ``memory`` in place.

        Appends an evidence-based observation, refreshes the synthesized
        understanding every ``memory.synthesize_every`` reflections, records
        the hypothesis, and triggers prompt evolution every ``evolve_every``
        reflections. Returns the updated memory.
        """
        # 使用进化后的 prompt（如果有）否则用默认值
        reflection_system = memory.evolved_reflection_system or REFLECTION_SYSTEM_PROMPT

        # Call the LLM for a reflection observation.
        try:
            raw = self._call_llm(
                system=reflection_system,
                user=self._build_reflection_user(
                    memory=memory,
                    challenge=task_prompt,
                    answer=answer,
                    scores=scores,
                    outcome=outcome,
                ),
            )
        except JudgeUnavailable:
            logger.warning(
                "Judge backend unavailable during reflection for team %s; "
                "memory left unchanged",
                memory.team_id,
            )
            return memory
        except Exception:  # noqa: BLE001 - defensive: never let reflection crash
            logger.exception(
                "Unexpected error reflecting for team %s", memory.team_id
            )
            return memory

        observation = self._parse_reflection(raw)
        if not observation:
            logger.warning(
                "Reflection for team %s produced no usable observation; "
                "skipping append (raw length=%d)",
                memory.team_id,
                len(raw) if raw else 0,
            )
            return memory

        # Append the observation and bump the counter.
        memory.observations.append(observation)
        memory.reflection_count += 1

        # Track the challenge as issued.
        if task_id and task_id not in memory.challenges_issued:
            memory.challenges_issued.append(task_id)

        # Record performance (only once we have a real observation to attach
        # it to, so the log stays paired with reflections).
        memory.performance_log.append(
            {
                "task_id": task_id,
                "outcome": outcome,
                "scores": dict(scores) if isinstance(scores, dict) else scores,
                "timestamp": timestamp,
            }
        )

        # Periodically re-synthesize the coherent understanding.
        if memory.reflection_count % max(1, memory.synthesize_every) == 0:
            synthesized = self._synthesize(memory)
            if synthesized:
                memory.current_understanding = synthesized

        # Always re-hypothesize the next challenge target.
        hypothesis = self._hypothesize_next(memory)
        if hypothesis:
            memory.next_challenge_hypothesis = hypothesis
            # 记录假设历史（供 PromptEvolver 审查准确率）
            memory.hypothesis_history.append(hypothesis)

        # 定期触发 prompt 进化（每 evolve_every 次反思）
        self._maybe_evolve(memory)

        logger.debug(
            "Reflected for team %s (count=%d, understanding_len=%d, evolutions=%d)",
            memory.team_id,
            memory.reflection_count,
            len(memory.current_understanding),
            memory.evolution_count,
        )
        return memory

    # -- LLM calls ----------------------------------------------------------

    def _call_llm(self, system: str, user: str) -> str:
        """Call the judge backend and return the raw text completion.

        Raises :class:`JudgeUnavailable` if the backend cannot be reached, so
        the caller can degrade gracefully.
        """
        backend = get_backend()
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        completion: JudgeCompletion = backend.complete(
            messages,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
        )
        text = getattr(completion, "text", None)
        if text is None and isinstance(completion, dict):
            text = completion.get("text") or completion.get("content")
        return text or ""

    def _build_reflection_user(
        self,
        memory: StyleMemory,
        challenge: str,
        answer: str,
        scores: Dict,
        outcome: str,
    ) -> str:
        understanding = memory.current_understanding.strip() or "(none yet)"
        try:
            scores_text = json.dumps(scores, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            scores_text = str(scores)
        return REFLECTION_USER_TEMPLATE.format(
            current_understanding=understanding,
            challenge=challenge,
            answer=answer,
            scores=scores_text,
            outcome=outcome,
        )

    # -- reflection / synthesis / hypothesis --------------------------------

    def _synthesize(self, memory: StyleMemory) -> str:
        """Synthesize the last observations into a coherent style description.

        Returns an empty string on failure so the caller can skip the update.
        """
        # Use the last 5-10 observations plus the prior understanding.
        recent = memory.observations[-10:]
        if not recent:
            return ""
        observations_block = "\n".join(
            f"{i + 1}. {obs}" for i, obs in enumerate(recent)
        )
        user = SYNTHESIZE_USER_TEMPLATE.format(
            observations=observations_block,
            prior_understanding=memory.current_understanding.strip()
            or "(none yet)",
        )
        try:
            raw = self._call_llm(system=SYNTHESIZE_SYSTEM_PROMPT, user=user)
        except JudgeUnavailable:
            logger.warning(
                "Judge backend unavailable during synthesis for team %s",
                memory.team_id,
            )
            return ""
        except Exception:  # noqa: BLE001
            logger.exception("Synthesis failed for team %s", memory.team_id)
            return ""
        cleaned = self._parse_reflection(raw)
        return cleaned or ""

    def _hypothesize_next(self, memory: StyleMemory) -> str:
        """Predict what the next challenge should target. Returns '' on failure."""
        hypothesis_system = memory.evolved_hypothesis_system or HYPOTHESIZE_SYSTEM_PROMPT
        user = HYPOTHESIZE_USER_TEMPLATE.format(
            understanding=memory.current_understanding.strip() or "(none yet)",
            performance_log=_format_performance_log(memory.performance_log),
            issued=_format_issued(memory.challenges_issued),
        )
        try:
            raw = self._call_llm(system=hypothesis_system, user=user)
        except JudgeUnavailable:
            logger.warning(
                "Judge backend unavailable during hypothesis for team %s",
                memory.team_id,
            )
            return ""
        except Exception:  # noqa: BLE001
            logger.exception("Hypothesis failed for team %s", memory.team_id)
            return ""
        cleaned = self._parse_reflection(raw)
        return cleaned or ""

    # -- prompt evolution ---------------------------------------------------

    def _get_evolver(self):
        """延迟初始化 PromptEvolver（避免循环依赖）。"""
        if self._evolver is None:
            from .prompt_evolver import PromptEvolver
            self._evolver = PromptEvolver()
        return self._evolver

    def _maybe_evolve(self, memory: StyleMemory) -> None:
        """检查是否该触发 prompt 进化，如果是则调用 PromptEvolver。

        进化失败不影响反思主流程（best-effort）。
        """
        try:
            evolver = self._get_evolver()
            if evolver.should_check(memory):
                logger.info(
                    "Triggering prompt evolution for team %s (reflection #%d)",
                    memory.team_id, memory.reflection_count,
                )
                evolver.check_and_evolve(memory)
        except Exception:  # noqa: BLE001 — 进化失败不应拖垮反思
            logger.exception(
                "Prompt evolution failed for team %s (non-fatal)",
                memory.team_id,
            )

    # -- parsing helpers ----------------------------------------------------

    @staticmethod
    def _parse_reflection(text: str) -> str:
        """Extract a clean observation from an LLM response.

        Strips markdown code fences, ``<thinking>``/``<thought>`` blocks,
        common preambles, and surrounding whitespace. Returns an empty string
        if nothing substantive remains, so callers can treat it as garbage.
        """
        if not text:
            return ""

        cleaned = text

        # Remove <thinking>...</thinking> or <thought>...</thought> blocks.
        cleaned = re.sub(
            r"<\s*(?:thinking|thought)\b[^>]*>.*?<\s*/\s*(?:thinking|thought)\s*>",
            "",
            cleaned,
            flags=re.IGNORECASE | re.DOTALL,
        )
        # Remove any other stray XML-ish tags.
        cleaned = re.sub(r"</?[a-zA-Z][^>\n]*>", "", cleaned)

        # Remove markdown code fences, keeping inner content if present.
        cleaned = re.sub(r"```[a-zA-Z0-9_-]*\n?", "", cleaned)
        cleaned = cleaned.replace("```", "")

        # Strip common preambles the model might add despite instructions.
        cleaned = re.sub(
            r"^\s*(?:observation|reflection|analysis)\s*[:\-–—]\s*",
            "",
            cleaned,
            count=1,
            flags=re.IGNORECASE,
        )

        # Collapse excessive blank lines and trim.
        cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
        cleaned = cleaned.strip()

        return cleaned


# ---------------------------------------------------------------------------
# Agent-level growth memory
# ---------------------------------------------------------------------------

AGENT_REFLECTION_SYSTEM_PROMPT = (
    "You are an expert at analyzing individual AI agent performance and growth.\n"
    "You observe one agent's answer to a challenge and reflect on their individual\n"
    "coding style, strengths, weaknesses, and improvement trajectory.\n"
    "Be specific and evidence-based — cite actual patterns from the code."
)

AGENT_REFLECTION_USER_TEMPLATE = """\
Agent identity: {agent_id} (team: {team_id})
Prior observations about this agent:
{prior_observations}

The task they attempted:
--- TASK ---
{task_prompt}
-----------

Their submission:
--- ANSWER ---
{answer}
------------

Scores (JSON): {scores}
Outcome: {outcome}

Write a 2-3 sentence observation about THIS AGENT's individual style:
  a) Patterns unique to this agent (vs what you'd expect from the team).
  b) Skills demonstrated or lacking in this specific submission.
  c) Growth signals — are they improving, plateauing, or regressing?

Do not restate scores. Do not praise generically. Return only the observation.
"""


@dataclass
class AgentMemory:
    """Semantic memory of one agent's individual growth within a team.

    Lighter than team StyleMemory — no synthesis or prompt evolution,
    because individual agents have fewer samples and the team Designer
    drives challenge design. This captures the agent's personal trajectory.
    """

    agent_id: str
    team_id: str = ""
    observations: List[str] = field(default_factory=list)
    performance_log: List[Dict] = field(default_factory=list)
    submission_count: int = 0
    pass_count: int = 0
    #: 维度分数轨迹 {dim: [score1, score2, ...]}
    score_trajectory: Dict[str, List[float]] = field(default_factory=dict)
    #: 综合成长描述（每 5 次反思刷新一次）
    growth_summary: str = ""
    #: 专长方向（从高分维度推断）
    strengths: List[str] = field(default_factory=list)
    #: 薄弱方向（从低分维度推断）
    weaknesses: List[str] = field(default_factory=list)

    @property
    def pass_rate(self) -> float:
        return self.pass_count / max(1, self.submission_count)

    @property
    def avg_scores(self) -> Dict[str, float]:
        """每个维度的平均分。"""
        result = {}
        for dim, scores in self.score_trajectory.items():
            if scores:
                result[dim] = round(sum(scores) / len(scores), 2)
        return result

    @property
    def smoothed_scores(self, window: int = 10) -> Dict[str, float]:
        """最近 N 次提交的移动平均，平滑单次波动。"""
        result = {}
        for dim, scores in self.score_trajectory.items():
            recent = scores[-window:] if len(scores) > window else scores
            if recent:
                result[dim] = round(sum(recent) / len(recent), 2)
        return result

    def to_dict(self) -> Dict:
        return {
            "agent_id": self.agent_id,
            "team_id": self.team_id,
            "observations": list(self.observations),
            "performance_log": list(self.performance_log),
            "submission_count": self.submission_count,
            "pass_count": self.pass_count,
            "score_trajectory": {k: list(v) for k, v in self.score_trajectory.items()},
            "growth_summary": self.growth_summary,
            "strengths": list(self.strengths),
            "weaknesses": list(self.weaknesses),
            "pass_rate": self.pass_rate,
            "avg_scores": self.avg_scores,
        }

    @classmethod
    def from_dict(cls, data: Dict) -> "AgentMemory":
        return cls(
            agent_id=data["agent_id"],
            team_id=data.get("team_id", ""),
            observations=list(data.get("observations", [])),
            performance_log=list(data.get("performance_log", [])),
            submission_count=int(data.get("submission_count", 0)),
            pass_count=int(data.get("pass_count", 0)),
            score_trajectory={k: list(v) for k, v in data.get("score_trajectory", {}).items()},
            growth_summary=data.get("growth_summary", ""),
            strengths=list(data.get("strengths", [])),
            weaknesses=list(data.get("weaknesses", [])),
        )


class AgentReflector:
    """Drives individual agent growth reflection.

    Simpler than team Reflector — no synthesis or prompt evolution.
    Just: observe → record → update trajectory.
    """

    def __init__(self, temperature: float = 0.3, max_tokens: int = 512):
        self.temperature = temperature
        self.max_tokens = max_tokens

    def reflect(
        self,
        agent_id: str,
        team_id: str,
        task_prompt: str,
        answer: str,
        scores: Dict,
        outcome: str,
        memory: AgentMemory,
        timestamp: Optional[str] = None,
    ) -> AgentMemory:
        """Reflect on one agent's submission and update their memory."""
        # 更新性能日志和分数轨迹
        memory.submission_count += 1
        if outcome == "passed":
            memory.pass_count += 1

        if isinstance(scores, dict):
            for dim, score in scores.items():
                if dim not in memory.score_trajectory:
                    memory.score_trajectory[dim] = []
                memory.score_trajectory[dim].append(float(score))

        memory.performance_log.append({
            "task_id": task_prompt[:60],  # 截取前 60 字符作为 ID
            "outcome": outcome,
            "scores": dict(scores) if isinstance(scores, dict) else scores,
            "timestamp": timestamp,
        })

        # LLM 反思
        try:
            prior = "\n".join(
                f"{i+1}. {obs}" for i, obs in enumerate(memory.observations[-5:])
            ) if memory.observations else "(first submission)"

            raw = self._call_llm(
                AGENT_REFLECTION_USER_TEMPLATE.format(
                    agent_id=agent_id,
                    team_id=team_id,
                    prior_observations=prior,
                    task_prompt=task_prompt,
                    answer=answer,
                    scores=json.dumps(scores, ensure_ascii=False),
                    outcome=outcome,
                ),
            )
            observation = self._parse(raw)
            if observation:
                memory.observations.append(observation)
        except JudgeUnavailable:
            logger.debug("Judge unavailable for agent %s reflection", agent_id)
        except Exception:  # noqa: BLE001
            logger.exception("Agent reflection failed for %s", agent_id)

        # 每 5 次反思更新优劣势推断
        if memory.submission_count % 5 == 0:
            self._update_strengths_weaknesses(memory)

        return memory

    def _call_llm(self, user: str) -> str:
        backend = get_backend()
        messages = [
            {"role": "system", "content": AGENT_REFLECTION_SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ]
        completion = backend.complete(
            messages,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
        )
        text = getattr(completion, "text", None)
        if text is None and isinstance(completion, dict):
            text = completion.get("text") or completion.get("content")
        return text or ""

    @staticmethod
    def _parse(text: str) -> str:
        """复用 Reflector 的清洗逻辑。"""
        return Reflector._parse_reflection(text)

    @staticmethod
    def _update_strengths_weaknesses(memory: AgentMemory) -> None:
        """从分数轨迹推断专长和薄弱方向。"""
        avgs = memory.avg_scores
        if not avgs:
            return
        sorted_dims = sorted(avgs.items(), key=lambda x: x[1], reverse=True)
        memory.strengths = [d for d, s in sorted_dims[:3] if s >= 3.5]
        memory.weaknesses = [d for d, s in sorted_dims[-3:] if s < 3.0]
        # 生成简短成长总结
        recent_obs = memory.observations[-3:]
        memory.growth_summary = (
            f"Agent {memory.agent_id}: {memory.submission_count} submissions, "
            f"{memory.pass_rate:.0%} pass rate. "
            f"Strong in: {', '.join(memory.strengths) or 'none yet'}. "
            f"Weak in: {', '.join(memory.weaknesses) or 'none yet'}."
        )


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def _format_performance_log(performance_log: List[Dict]) -> str:
    """Render the performance log as compact JSON for prompts."""
    if not performance_log:
        return "(no prior tasks)"
    recent = performance_log[-10:]
    try:
        return json.dumps(recent, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        return str(recent)


def _format_issued(challenges_issued: List[str]) -> str:
    """Render the list of issued task IDs for prompts."""
    if not challenges_issued:
        return "(none)"
    return "\n".join(f"- {tid}" for tid in challenges_issued)
