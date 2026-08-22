"""
model-service/tests/test_registry.py
JudgeRegistry 注册完整性测试。

CI 强制：
1. 所有已知 Evaluator 都已注册（新增必登记）；
2. 重名注册报错（防静默覆盖）；
3. Evaluator 产出维度必须是 registry 允许维度的子集（防自定维度）；
4. 派发校验工种适用性。

运行：python -m pytest tests/test_registry.py -q
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from app.scoring.evaluator_protocol import (  # noqa: E402
    EvaluatorInput,
)
from app.scoring.judge_registry import JudgeRegistry, get_registry  # noqa: E402
from app.scoring.evaluators import register_all  # noqa: E402


# ======================================================================
# 1. 注册完整性 —— 所有已知 Evaluator 都已注册
# ======================================================================
class TestAllEvaluatorsRegistered:
    """CI 强制：新增 Evaluator 必须在 evaluators/__init__.py 登记。"""

    def test_register_all_succeeds(self):
        reg = JudgeRegistry()
        register_all(reg)

    def test_known_evaluators_present(self):
        reg = JudgeRegistry()
        register_all(reg)
        ids = set(reg.list_ids())
        for expected in ("craft_judge", "arena_judge", "sandbox", "growth", "enterprise_fit"):
            assert expected in ids, f"Evaluator '{expected}' 未注册"

    def test_at_least_five_registered(self):
        reg = JudgeRegistry()
        register_all(reg)
        assert len(reg.list_ids()) >= 5


# ======================================================================
# 2. 重名保护
# ======================================================================
class TestDuplicateRegistration:
    """重名注册必须报错——防止静默覆盖。"""

    def test_duplicate_id_raises(self):
        reg = JudgeRegistry()
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        reg.register(SandboxEvaluator())
        with pytest.raises(ValueError, match="已注册"):
            reg.register(SandboxEvaluator())

    def test_missing_id_raises(self):
        reg = JudgeRegistry()

        class _Bad:
            applicable_jobs = ["code"]
            def evaluate(self, inp): ...

        with pytest.raises(ValueError, match="evaluator_id"):
            reg.register(_Bad())

    def test_missing_applicable_jobs_raises(self):
        reg = JudgeRegistry()

        class _Bad:
            evaluator_id = "bad"
            def evaluate(self, inp): ...

        with pytest.raises(ValueError, match="applicable_jobs"):
            reg.register(_Bad())


# ======================================================================
# 3. 维度子集校验
# ======================================================================
class TestDimensionSubset:
    """Evaluator 声明维度不得越界。"""

    def test_sandbox_declared_dims_empty(self):
        """sandbox 不产分数，declared_dims 为空列表。"""
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        ev = SandboxEvaluator()
        assert ev.declared_dims == []

    def test_get_unregistered_raises_keyerror(self):
        reg = JudgeRegistry()
        with pytest.raises(KeyError, match="未注册"):
            reg.get("nonexistent")


# ======================================================================
# 4. 派发校验
# ======================================================================
class TestDispatch:
    """dispatch 校验工种适用性。"""

    def test_dispatch_wrong_job_raises(self):
        reg = JudgeRegistry()
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        reg.register(SandboxEvaluator())
        with pytest.raises(ValueError, match="不适用于工种"):
            reg.dispatch("sandbox", EvaluatorInput(
                agent_id="x", job_type="text",
            ))

    def test_dispatch_sandbox_no_code_returns_empty(self):
        reg = JudgeRegistry()
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        reg.register(SandboxEvaluator())
        out = reg.dispatch("sandbox", EvaluatorInput(
            agent_id="x", job_type="code", answer="",
        ))
        assert out.evaluator_id == "sandbox"
        assert out.scores == {}
        assert out.confidence == 0.0


# ======================================================================
# 5. 全局单例
# ======================================================================
class TestSingleton:
    """get_registry() 返回全局单例。"""

    def test_singleton_identity(self):
        assert get_registry() is get_registry()


# ======================================================================
# 6. 遥测
# ======================================================================
class TestTelemetry:
    """dispatch 后 stats() 应反映调用次数和错误数。"""

    def test_stats_after_dispatch(self):
        reg = JudgeRegistry()
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        reg.register(SandboxEvaluator())

        # 跑一次 dispatch（空答案 → confidence=0 但不算 error）
        reg.dispatch("sandbox", EvaluatorInput(
            agent_id="x", job_type="code", answer="",
        ))
        st = reg.stats()
        assert "sandbox" in st
        assert st["sandbox"]["calls"] == 1
        assert st["sandbox"]["errors"] == 0
        assert st["sandbox"]["totalMs"] >= 0

    def test_stats_error_counted(self):
        """派发不存在的 evaluator → KeyError，stats 不更新（get 阶段就失败）。"""
        reg = JudgeRegistry()
        with pytest.raises(KeyError):
            reg.dispatch("nonexistent", EvaluatorInput(agent_id="x", job_type="code"))
        # 不存在的 evaluator 不应出现在 stats 中
        assert "nonexistent" not in reg.stats()

    def test_stats_avg_ms(self):
        reg = JudgeRegistry()
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        reg.register(SandboxEvaluator())
        for _ in range(3):
            reg.dispatch("sandbox", EvaluatorInput(
                agent_id="x", job_type="code", answer="",
            ))
        st = reg.stats()["sandbox"]
        assert st["calls"] == 3
        assert st["avgMs"] >= 0


# ======================================================================
# 7. 异步派发
# ======================================================================
class TestAsyncDispatch:
    """dispatch_async 能处理同步 Evaluator（run_in_executor 包装）。"""

    @pytest.mark.anyio
    async def test_dispatch_async_sync_evaluator(self):
        reg = JudgeRegistry()
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        reg.register(SandboxEvaluator())
        out = await reg.dispatch_async("sandbox", EvaluatorInput(
            agent_id="x", job_type="code", answer="",
        ))
        assert out.evaluator_id == "sandbox"
        # 异步派发也应记录遥测
        st = reg.stats()["sandbox"]
        assert st["calls"] == 1

    @pytest.mark.anyio
    async def test_dispatch_async_wrong_job_raises(self):
        reg = JudgeRegistry()
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        reg.register(SandboxEvaluator())
        with pytest.raises(ValueError, match="不适用于工种"):
            await reg.dispatch_async("sandbox", EvaluatorInput(
                agent_id="x", job_type="text",
            ))


# ======================================================================
# 8. declared_dims 静态校验
# ======================================================================
class TestDeclaredDims:
    """declared_dims 在注册时校验 ⊆ registry 允许集。"""

    def test_sandbox_declared_empty(self):
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        assert SandboxEvaluator.declared_dims == []

    def test_growth_declared_dims(self):
        from app.scoring.evaluators.growth_evaluator import GrowthEvaluator
        from app.scoring.registry import RADAR_DIMS
        declared = set(GrowthEvaluator.declared_dims)
        # 通用六维（纵向追踪）；overall 是汇总指标，不参与维度校验
        assert declared == set(RADAR_DIMS)

    def test_enterprise_fit_declared_dims(self):
        from app.scoring.evaluators.enterprise_fit_evaluator import EnterpriseFitEvaluator
        from app.scoring.registry import RADAR_DIMS, JOB_CRAFT_DIMS
        declared = set(EnterpriseFitEvaluator.declared_dims)
        assert set(RADAR_DIMS).issubset(declared)
        all_craft = {d for dims in JOB_CRAFT_DIMS.values() for d in dims}
        assert all_craft.issubset(declared)

    def test_craft_judge_declared_dims(self):
        from app.scoring.craft_judge import CraftJudgeEvaluator
        from app.scoring.registry import JOB_CRAFT_DIMS
        declared = set(CraftJudgeEvaluator.declared_dims)
        all_craft = {d for dims in JOB_CRAFT_DIMS.values() for d in dims}
        assert all_craft.issubset(declared)

    def test_arena_judge_no_declared_dims(self):
        """arena_judge 产出含 fit（非 registry 维），跳过静态校验。"""
        from app.scoring.arena_judge import ArenaJudgeEvaluator
        assert not hasattr(ArenaJudgeEvaluator, "declared_dims")


# ======================================================================
# 9. merge_outputs
# ======================================================================
class TestMergeOutputs:
    """merge_outputs 合并多个 EvaluatorOutput。"""

    def test_merge_empty(self):
        from app.scoring.evaluator_protocol import merge_outputs
        out = merge_outputs([])
        assert out.evaluator_id == "empty_chain"

    def test_merge_single(self):
        from app.scoring.evaluator_protocol import merge_outputs, EvaluatorOutput
        o = EvaluatorOutput(evaluator_id="a", scores={"x": 1})
        assert merge_outputs([o]) is o

    def test_merge_two_scores_combined(self):
        from app.scoring.evaluator_protocol import merge_outputs, EvaluatorOutput
        o1 = EvaluatorOutput(evaluator_id="a", scores={"x": 1, "y": 2})
        o2 = EvaluatorOutput(evaluator_id="b", scores={"y": 3, "z": 4})
        merged = merge_outputs([o1, o2])
        assert merged.scores == {"x": 1, "y": 3, "z": 4}
        assert merged.evaluator_id == "a+b"

    def test_merge_confidence_min(self):
        from app.scoring.evaluator_protocol import merge_outputs, EvaluatorOutput
        o1 = EvaluatorOutput(evaluator_id="a", confidence=0.8)
        o2 = EvaluatorOutput(evaluator_id="b", confidence=0.5)
        assert merge_outputs([o1, o2]).confidence == 0.5

    def test_merge_evidence_combined(self):
        from app.scoring.evaluator_protocol import merge_outputs, EvaluatorOutput
        o1 = EvaluatorOutput(evaluator_id="a", verified_evidence={"k1": "v1"})
        o2 = EvaluatorOutput(evaluator_id="b", verified_evidence={"k2": "v2"})
        merged = merge_outputs([o1, o2])
        assert merged.verified_evidence == {"k1": "v1", "k2": "v2"}


# ======================================================================
# 10. dispatch_chain
# ======================================================================
class TestDispatchChain:
    """dispatch_chain 链式派发。"""

    def test_chain_passes_evidence(self):
        """前一个 evaluator 的 verified_evidence 自动传给下一个。"""
        from app.scoring.evaluator_protocol import (
            EvaluatorInput, EvaluatorOutput,
        )

        class _EvidenceProducer:
            evaluator_id = "producer"
            applicable_jobs = ["code"]
            def evaluate(self, inp):
                return EvaluatorOutput(
                    evaluator_id="producer",
                    verified_evidence={"run": "passed"},
                )

        class _EvidenceConsumer:
            evaluator_id = "consumer"
            applicable_jobs = ["code"]
            def __init__(self):
                self.received_evidence = None
            def evaluate(self, inp):
                self.received_evidence = inp.verified_evidence
                return EvaluatorOutput(
                    evaluator_id="consumer",
                    scores={"q": 4},
                )

        reg = JudgeRegistry()
        consumer = _EvidenceConsumer()
        reg.register(_EvidenceProducer())
        reg.register(consumer)

        merged = reg.dispatch_chain(
            ["producer", "consumer"],
            EvaluatorInput(agent_id="x", job_type="code"),
        )
        assert consumer.received_evidence == {"run": "passed"}
        assert merged.scores == {"q": 4}
        assert merged.verified_evidence == {"run": "passed"}

    def test_chain_stop_on_error(self):
        """stop_on_error=True 时，链中断。"""
        class _Fail:
            evaluator_id = "fail"
            applicable_jobs = ["code"]
            def evaluate(self, inp):
                raise RuntimeError("boom")

        reg = JudgeRegistry()
        reg.register(_Fail())
        with pytest.raises(RuntimeError, match="boom"):
            reg.dispatch_chain(
                ["fail"],
                EvaluatorInput(agent_id="x", job_type="code"),
            )

    def test_chain_preserves_all_fields(self):
        """链式透传时 radar_scores / craft_scores / requirement 不丢。"""
        from app.scoring.evaluator_protocol import (
            EvaluatorInput, EvaluatorOutput,
        )

        class _EvidenceProducer:
            evaluator_id = "producer"
            applicable_jobs = ["code"]
            def evaluate(self, inp):
                return EvaluatorOutput(
                    evaluator_id="producer",
                    verified_evidence={"k": "v"},
                )

        class _FieldChecker:
            evaluator_id = "checker"
            applicable_jobs = ["code"]
            def __init__(self):
                self.received = None
            def evaluate(self, inp):
                self.received = inp
                return EvaluatorOutput(evaluator_id="checker")

        reg = JudgeRegistry()
        checker = _FieldChecker()
        reg.register(_EvidenceProducer())
        reg.register(checker)

        reg.dispatch_chain(
            ["producer", "checker"],
            EvaluatorInput(
                agent_id="a1",
                job_type="code",
                radar_scores={"task": 4},
                craft_scores={"code_eff": 3},
                requirement="test req",
            ),
        )
        r = checker.received
        assert r.radar_scores == {"task": 4}
        assert r.craft_scores == {"code_eff": 3}
        assert r.requirement == "test req"
        assert r.verified_evidence == {"k": "v"}

    def test_chain_rejects_async_evaluator(self):
        """同步 dispatch_chain 遇到异步 Evaluator → TypeError。"""
        class _AsyncEv:
            evaluator_id = "async_ev"
            applicable_jobs = ["code"]
            async def aevaluate(self, inp):
                return EvaluatorOutput(evaluator_id="async_ev")

        reg = JudgeRegistry()
        reg.register(_AsyncEv())
        with pytest.raises(TypeError, match="异步 Evaluator"):
            reg.dispatch_chain(
                ["async_ev"],
                EvaluatorInput(agent_id="x", job_type="code"),
            )


# ======================================================================
# 10b. dispatch_chain_async
# ======================================================================
class TestDispatchChainAsync:
    """dispatch_chain_async 异步链式派发。"""

    @pytest.mark.anyio
    async def test_async_chain_passes_evidence(self):
        """异步链：evidence 正确透传。"""
        from app.scoring.evaluator_protocol import (
            EvaluatorInput, EvaluatorOutput,
        )

        class _Producer:
            evaluator_id = "producer"
            applicable_jobs = ["code"]
            def evaluate(self, inp):
                return EvaluatorOutput(
                    evaluator_id="producer",
                    verified_evidence={"run": "passed"},
                )

        class _Consumer:
            evaluator_id = "consumer"
            applicable_jobs = ["code"]
            def __init__(self):
                self.received_evidence = None
            def evaluate(self, inp):
                self.received_evidence = inp.verified_evidence
                return EvaluatorOutput(
                    evaluator_id="consumer",
                    scores={"q": 4},
                )

        reg = JudgeRegistry()
        consumer = _Consumer()
        reg.register(_Producer())
        reg.register(consumer)

        merged = await reg.dispatch_chain_async(
            ["producer", "consumer"],
            EvaluatorInput(agent_id="x", job_type="code"),
        )
        assert consumer.received_evidence == {"run": "passed"}
        assert merged.scores == {"q": 4}
        assert merged.verified_evidence == {"run": "passed"}

    @pytest.mark.anyio
    async def test_async_chain_with_async_evaluator(self):
        """异步链能正确处理真正异步的 Evaluator（aevaluate）。"""
        from app.scoring.evaluator_protocol import (
            EvaluatorInput, EvaluatorOutput,
        )

        class _AsyncProducer:
            evaluator_id = "async_producer"
            applicable_jobs = ["code"]
            async def aevaluate(self, inp):
                return EvaluatorOutput(
                    evaluator_id="async_producer",
                    verified_evidence={"async": "yes"},
                )

        class _SyncConsumer:
            evaluator_id = "sync_consumer"
            applicable_jobs = ["code"]
            def __init__(self):
                self.received_evidence = None
            def evaluate(self, inp):
                self.received_evidence = inp.verified_evidence
                return EvaluatorOutput(
                    evaluator_id="sync_consumer",
                    scores={"score": 5},
                )

        reg = JudgeRegistry()
        consumer = _SyncConsumer()
        reg.register(_AsyncProducer())
        reg.register(consumer)

        merged = await reg.dispatch_chain_async(
            ["async_producer", "sync_consumer"],
            EvaluatorInput(agent_id="x", job_type="code"),
        )
        assert consumer.received_evidence == {"async": "yes"}
        assert merged.scores == {"score": 5}
        assert merged.verified_evidence == {"async": "yes"}

    @pytest.mark.anyio
    async def test_async_chain_stop_on_error(self):
        """异步链 stop_on_error=True 时中断。"""
        class _Fail:
            evaluator_id = "fail"
            applicable_jobs = ["code"]
            async def aevaluate(self, inp):
                raise RuntimeError("async boom")

        reg = JudgeRegistry()
        reg.register(_Fail())
        with pytest.raises(RuntimeError, match="async boom"):
            await reg.dispatch_chain_async(
                ["fail"],
                EvaluatorInput(agent_id="x", job_type="code"),
            )

    @pytest.mark.anyio
    async def test_async_chain_continue_on_error(self):
        """stop_on_error=False 时跳过失败的 evaluator 继续。"""
        from app.scoring.evaluator_protocol import (
            EvaluatorInput, EvaluatorOutput,
        )

        class _Fail:
            evaluator_id = "fail"
            applicable_jobs = ["code"]
            def evaluate(self, inp):
                raise RuntimeError("skip me")

        class _Ok:
            evaluator_id = "ok"
            applicable_jobs = ["code"]
            def evaluate(self, inp):
                return EvaluatorOutput(
                    evaluator_id="ok",
                    scores={"q": 3},
                )

        reg = JudgeRegistry()
        reg.register(_Fail())
        reg.register(_Ok())

        merged = await reg.dispatch_chain_async(
            ["fail", "ok"],
            EvaluatorInput(agent_id="x", job_type="code"),
            stop_on_error=False,
        )
        assert merged.scores == {"q": 3}
