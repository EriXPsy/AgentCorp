"""
model-service/app/scoring/judge_registry.py
Tier 2 评分模块的注册表 + 单一派发点（JudgeRegistry）。

职责：
- register(ev)      注册一个 Evaluator，重名报错，维度越界报错；
- get(id)           取单个 Evaluator；
- list_ids()        列出已注册 id；
- dispatch(id, inp) 单一派发：校验工种适用性后转交 evaluate()（同步/异步自适应）；
- stats()           派发遥测：调用次数、错误次数、累计耗时。

为什么不用 import 直连：此前各评分模块各自 import、各自被直接调用，新增一个引擎
就多一条独立调用链，维度/派发路径随之发散。收口到 Registry 后，所有主观评分只经
dispatch() 一个入口，CI 用测试强制「新增必注册」（见 tests/test_registry.py）。

单一规则源：注册时校验 Evaluator 产出维度 ⊆ registry 允许维度，杜绝 Evaluator 自定维度。

零新增依赖。
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Union

import anyio

from .evaluator_protocol import (
    Evaluator,
    EvaluatorHealth,
    EvaluatorInput,
    EvaluatorOutput,
    allowed_dims_for,
    merge_outputs,
)

logger = logging.getLogger("serve")

# dispatch 返回值可能是同步或异步的（Evaluator 可定义 evaluate 或 aevaluate）
_DispatchResult = Union[EvaluatorOutput, Awaitable[EvaluatorOutput]]


@dataclass
class _EvalStats:
    """单个 Evaluator 的运行时遥测。"""

    calls: int = 0
    errors: int = 0
    total_ms: float = 0.0
    last_call_ts: float = 0.0

    @property
    def avg_ms(self) -> float:
        return self.total_ms / self.calls if self.calls > 0 else 0.0


class JudgeRegistry:
    """Tier 2 评分模块注册表 + 单一派发点。"""

    def __init__(self) -> None:
        self._evaluators: Dict[str, Evaluator] = {}
        self._stats: Dict[str, _EvalStats] = {}

    def register(self, ev: Evaluator) -> None:
        """注册一个 Evaluator。

        两道校验：
        1. 重名即报错——防止静默覆盖已有 Evaluator；
        2. 产出维度必须是 registry 允许维度的子集——杜绝 Evaluator 自定维度。
           （craft 维仅在对应工种下合法，故按 applicable_jobs 逐一校验。）
        """
        eid = getattr(ev, "evaluator_id", None)
        if not eid or not isinstance(eid, str):
            raise ValueError("Evaluator 必须提供非空字符串 evaluator_id")
        if eid in self._evaluators:
            raise ValueError(f"Evaluator '{eid}' 已注册，禁止重复注册")
        jobs = list(getattr(ev, "applicable_jobs", []) or [])
        if not jobs:
            raise ValueError(f"Evaluator '{eid}' 未声明 applicable_jobs")
        # 维度越界校验：Evaluator 不得自定 registry 以外的维度。
        # 声明维度集合（若 Evaluator 暴露 declared_dims 则用之，否则跳过静态校验，
        # 改为运行期由 dispatch 后消费者核对）。
        declared = getattr(ev, "declared_dims", None)
        if declared is not None:
            allowed: set = set()
            for jt in jobs:
                allowed |= allowed_dims_for(jt)
            extra = set(declared) - allowed
            if extra:
                raise ValueError(
                    f"Evaluator '{eid}' 声明了越界维度 {sorted(extra)}，"
                    f"不在 registry 允许集内"
                )
        self._evaluators[eid] = ev
        self._stats[eid] = _EvalStats()
        logger.info("JudgeRegistry: 注册 Evaluator '%s'（工种 %s）", eid, jobs)

    def get(self, evaluator_id: str) -> Evaluator:
        if evaluator_id not in self._evaluators:
            raise KeyError(f"未注册的 Evaluator: '{evaluator_id}'")
        return self._evaluators[evaluator_id]

    def list_ids(self) -> List[str]:
        return list(self._evaluators.keys())

    def dispatch(self, evaluator_id: str, inp: EvaluatorInput) -> _DispatchResult:
        """单一派发点：校验工种适用性后转交 evaluate()。

        若 Evaluator 实现了 ``aevaluate``（async），返回 Awaitable；
        否则同步执行 ``evaluate`` 并直接返回 EvaluatorOutput。
        调用方在 async 上下文中应用 ``await`` 或 ``asyncio.ensure_future`` 包裹。
        """
        ev = self.get(evaluator_id)
        if inp.job_type not in getattr(ev, "applicable_jobs", []):
            raise ValueError(
                f"Evaluator '{evaluator_id}' 不适用于工种 '{inp.job_type}'"
            )
        # 异步优先：有 aevaluate 则返回协程
        if hasattr(ev, "aevaluate") and callable(getattr(ev, "aevaluate")):
            return ev.aevaluate(inp)  # type: ignore[attr-defined]
        return self._dispatch_sync(evaluator_id, ev, inp)

    def _dispatch_sync(
        self, evaluator_id: str, ev: Evaluator, inp: EvaluatorInput
    ) -> EvaluatorOutput:
        """同步派发 + 遥测记录。"""
        stats = self._stats[evaluator_id]
        t0 = time.perf_counter()
        try:
            out = ev.evaluate(inp)
            stats.calls += 1
            stats.last_call_ts = t0
            return out
        except Exception:
            stats.errors += 1
            stats.calls += 1
            raise
        finally:
            stats.total_ms += (time.perf_counter() - t0) * 1000

    async def dispatch_async(
        self, evaluator_id: str, inp: EvaluatorInput
    ) -> EvaluatorOutput:
        """异步派发包装：自动处理同步/异步 Evaluator + 遥测。

        在 async 路由中应使用此方法而非 dispatch()，避免阻塞事件循环。
        """
        ev = self.get(evaluator_id)
        if inp.job_type not in getattr(ev, "applicable_jobs", []):
            raise ValueError(
                f"Evaluator '{evaluator_id}' 不适用于工种 '{inp.job_type}'"
            )
        stats = self._stats[evaluator_id]
        t0 = time.perf_counter()
        try:
            if hasattr(ev, "aevaluate") and callable(getattr(ev, "aevaluate")):
                out = await ev.aevaluate(inp)  # type: ignore[attr-defined]
            else:
                # 用 anyio.to_thread.run_sync() 把同步 Evaluator 丢进线程池：
                # - 后端无关——不管底层是 asyncio 还是 trio（pytest-anyio 默认 trio）
                #   都不依赖「当前有 asyncio loop」，避免 get_event_loop()/get_running_loop()
                #   在 trio 下抛 RuntimeError；
                # - anyio 已是 FastAPI/Starlette 的传递依赖，零新增依赖。
                out = await anyio.to_thread.run_sync(ev.evaluate, inp)
            stats.calls += 1
            stats.last_call_ts = t0
            return out
        except Exception:
            stats.errors += 1
            stats.calls += 1
            raise
        finally:
            stats.total_ms += (time.perf_counter() - t0) * 1000

    def stats(self) -> Dict[str, Dict[str, Any]]:
        """返回所有 Evaluator 的运行时遥测（供 /api/registry/status 展示）。"""
        return {
            eid: {
                "calls": s.calls,
                "errors": s.errors,
                "totalMs": round(s.total_ms, 1),
                "avgMs": round(s.avg_ms, 1),
                "lastCallTs": s.last_call_ts,
            }
            for eid, s in self._stats.items()
        }

    def health(self) -> Dict[str, Any]:
        """聚合所有 Evaluator 的健康状态（供 /api/registry/status 展示）。

        Evaluator 若实现 health() 则用之，否则默认 healthy。
        返回 {evaluator_id: {status, reason}} + 顶层 overall。
        """
        per: Dict[str, Dict[str, str]] = {}
        worst = "healthy"
        for eid, ev in self._evaluators.items():
            h: EvaluatorHealth
            if hasattr(ev, "health") and callable(getattr(ev, "health")):
                try:
                    h = ev.health()
                except Exception as exc:  # noqa: BLE001 —— 健康自报自身不应拖垮注册表
                    h = EvaluatorHealth(
                        evaluator_id=eid,
                        status="unavailable",
                        reason=f"health() 自报异常：{exc}",
                    )
            else:
                h = EvaluatorHealth(evaluator_id=eid, status="healthy")
            per[eid] = {"status": h.status, "reason": h.reason}
            if h.status == "unavailable":
                worst = "unavailable"
            elif h.status == "degraded" and worst == "healthy":
                worst = "degraded"
        return {"overall": worst, "evaluators": per}

    def dispatch_chain(
        self,
        evaluator_ids: List[str],
        inp: EvaluatorInput,
        *,
        stop_on_error: bool = True,
    ) -> EvaluatorOutput:
        """同步链式派发：依次运行多个同步 Evaluator，前一个的 verified_evidence 自动传给下一个。

        典型用途：craft_judge 路由先跑 sandbox（产 evidence）再跑 craft_judge（用 evidence）。

        注意：仅支持同步 Evaluator。链中含异步 Evaluator 请用 dispatch_chain_async()。
        """
        outputs: List[EvaluatorOutput] = []
        current_inp = inp
        accumulated_evidence: Dict[str, str] = dict(inp.verified_evidence or {})
        for eid in evaluator_ids:
            # 预检：同步链不接受异步 Evaluator
            ev = self.get(eid)
            if hasattr(ev, "aevaluate") and callable(getattr(ev, "aevaluate")):
                raise TypeError(
                    f"dispatch_chain 遇到异步 Evaluator '{eid}'，请改用 dispatch_chain_async()"
                )
            try:
                out = self.dispatch(eid, current_inp)
            except Exception:
                if stop_on_error:
                    raise
                continue
            outputs.append(out)
            # 把当前产出透传给下一个 evaluator（保留所有原始字段）
            if out.verified_evidence:
                accumulated_evidence.update(out.verified_evidence)
                current_inp = EvaluatorInput(
                    agent_id=inp.agent_id,
                    job_type=inp.job_type,
                    task_id=inp.task_id,
                    answer=inp.answer,
                    radar_scores=inp.radar_scores,
                    craft_scores=inp.craft_scores,
                    requirement=inp.requirement,
                    verified_evidence=dict(accumulated_evidence),
                    options=inp.options,
                )
        return merge_outputs(outputs)

    async def dispatch_chain_async(
        self,
        evaluator_ids: List[str],
        inp: EvaluatorInput,
        *,
        stop_on_error: bool = True,
    ) -> EvaluatorOutput:
        """异步链式派发：自动处理同步/异步 Evaluator + evidence 透传。

        与 dispatch_chain 的区别：
        - 用 dispatch_async() 代替 dispatch()，同步 Evaluator 经 run_in_executor 包装；
        - 链中含异步 Evaluator 时正确 await；
        - 遥测自动记录。
        """
        outputs: List[EvaluatorOutput] = []
        current_inp = inp
        accumulated_evidence: Dict[str, str] = dict(inp.verified_evidence or {})
        for eid in evaluator_ids:
            try:
                out = await self.dispatch_async(eid, current_inp)
            except Exception:
                if stop_on_error:
                    raise
                continue
            outputs.append(out)
            if out.verified_evidence:
                accumulated_evidence.update(out.verified_evidence)
                current_inp = EvaluatorInput(
                    agent_id=inp.agent_id,
                    job_type=inp.job_type,
                    task_id=inp.task_id,
                    answer=inp.answer,
                    radar_scores=inp.radar_scores,
                    craft_scores=inp.craft_scores,
                    requirement=inp.requirement,
                    verified_evidence=dict(accumulated_evidence),
                    options=inp.options,
                )
        return merge_outputs(outputs)


# 全局单例 ---------------------------------------------------------------
_REGISTRY = JudgeRegistry()


def get_registry() -> JudgeRegistry:
    """取全局 JudgeRegistry 单例。"""
    return _REGISTRY
