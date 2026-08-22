"""
偏好回灌（scoring.preference）单测 —— 产品核心路径专项覆盖。

覆盖范围（只读源码、不改源码）：

- aggregate_preference
    · 空信号：返回默认 ownerId=default、空 pairwiseWins / dimLift、信号回显
    · 方向处理：仅 direction=="up" 计入 pairwiseWins 与 dimLift；down 不污染
    · 最强 craft 维 → 经 registry.craft_links 映射 → dimLift 累加
    · 信号缺失 craftScores 时回退到 craft_scores_by_agent 参数
    · ownerId 取自首个信号；无信号时回落 "default"
- apply_to_user_preference
    · 回灌数值正确性：w'[d]=w*(1+α·dimLift[d]/N)，再归一 Σ=1
    · R1 门控：N<3 原样返回（不产生新对象值，引用语义由 dict 相等覆盖）
    · 极端 dimLift 下归一化保证 0<=w<=1 且 Σ=1（数值稳定性边界）
    · 空 dimLift / 零 lift 时不崩溃且 Σ=1

运行方式（在 model-service 目录下）：
    python -m pytest tests/test_preference.py -q
"""
from __future__ import annotations

import math
import os
import sys

# 让测试能 import app 包（命名空间包，无 __init__.py），与既有测试约定一致
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.scoring.preference import aggregate_preference, apply_to_user_preference  # noqa: E402
from app.schemas import PreferenceSignal, WeightVector  # noqa: E402


# ----------------------------------------------------------------------
# 小工具
# ----------------------------------------------------------------------
def _up(agent_id: str, craft: dict | None = None, ts: str = "t", owner: str = "default") -> dict:
    """构造一个方向为 up 的偏好信号（以 dict 形式，验证 dict/对象双兼容）。"""
    return {
        "agentId": agent_id,
        "jobType": "code",
        "direction": "up",
        "craftScores": craft,
        "ts": ts,
        "ownerId": owner,
    }


def _down(agent_id: str) -> dict:
    return {"agentId": agent_id, "jobType": "code", "direction": "down", "ts": "t"}


def _weight() -> dict:
    """WeightVector 默认通用六维权重的副本（Σ=1）。"""
    return dict(WeightVector().model_dump())


# ======================================================================
# aggregate_preference —— 偏好信号聚合
# ======================================================================
def test_aggregate_empty_signals_returns_default_profile():
    """空信号：ownerId 回落 default，pairwiseWins / dimLift 皆空，信号原样回显。"""
    profile = aggregate_preference([])
    assert profile.ownerId == "default"
    assert profile.pairwiseWins == {}
    assert profile.dimLift == {}
    assert profile.signals == []
    assert profile.updatedAt  # 时间戳被填写


def test_aggregate_owner_id_taken_from_first_signal():
    """ownerId 取自首个信号。"""
    signals = [_up("a1", {"code_runnability": 5.0}, owner="alice")]
    profile = aggregate_preference(signals)
    assert profile.ownerId == "alice"
    # 回显的信号是 PreferenceSignal 对象
    assert isinstance(profile.signals[0], PreferenceSignal)


def test_aggregate_up_increments_pairwise_wins():
    """每个 up 信号使对应 agent 的 pairwiseWins +1。"""
    signals = [
        _up("a1", {"code_runnability": 5.0}),
        _up("a1", {"code_runnability": 4.0}),
        _up("a2", {"code_security": 5.0}),
    ]
    profile = aggregate_preference(signals)
    assert profile.pairwiseWins == {"a1": 2, "a2": 1}


def test_aggregate_down_does_not_pollute_wins_or_lift():
    """down 信号不计入 pairwiseWins，也不产生 dimLift。"""
    signals = [
        _down("a1"),
        _down("a1"),
        _up("a2", {"code_runnability": 5.0}),
    ]
    profile = aggregate_preference(signals)
    assert profile.pairwiseWins == {"a2": 1}  # a1 未出现
    # a1 的 down 信号不应贡献任何通用维提升；仅 a2 的 code_runnability
    # → [task, reliability] 两个通用维各 +1，合计 2
    assert profile.pairwiseWins.get("a1") is None
    assert sum(profile.dimLift.values()) == 2.0


def test_aggregate_strongest_craft_maps_to_dim_lift():
    """被提升 agent 的最强 craft 维 → craft_links → dimLift 累加。

    code_runnability → [task, reliability]，故两个通用维各 +1。
    """
    signals = [_up("a1", {"code_runnability": 5.0, "code_security": 2.0})]
    profile = aggregate_preference(signals)
    assert profile.dimLift.get("task", 0.0) == 1.0
    assert profile.dimLift.get("reliability", 0.0) == 1.0


def test_aggregate_multiple_up_accumulate_dim_lift():
    """多个 up 信号的 dimLift 累加：两个不同 craft 维分别映射并求和。"""
    signals = [
        _up("a1", {"code_runnability": 5.0}),   # → task+1, reliability+1
        _up("a2", {"code_efficiency": 5.0}),    # → cost+1, quality+1
    ]
    profile = aggregate_preference(signals)
    assert profile.dimLift["task"] == 1.0
    assert profile.dimLift["reliability"] == 1.0
    assert profile.dimLift["cost"] == 1.0
    assert profile.dimLift["quality"] == 1.0


def test_aggregate_falls_back_to_craft_scores_by_agent():
    """信号缺 craftScores 时，回退到 craft_scores_by_agent[agent_id]。"""
    signals = [_up("a1", None)]  # 信号不带 craftScores
    by_agent = {"a1": {"code_security": 5.0}}  # code_security → [reliability, cost]
    profile = aggregate_preference(signals, craft_scores_by_agent=by_agent)
    assert profile.dimLift.get("reliability", 0.0) == 1.0
    assert profile.dimLift.get("cost", 0.0) == 1.0
    assert profile.pairwiseWins == {"a1": 1}


def test_aggregate_up_without_any_craft_does_not_pollute():
    """up 但信号与 craft_scores_by_agent 都无 craftScores：pairwiseWins 仍 +1，但 dimLift 不污染。"""
    signals = [_up("a1", None)]
    profile = aggregate_preference(signals, craft_scores_by_agent={})
    assert profile.pairwiseWins == {"a1": 1}
    assert profile.dimLift == {}


def test_aggregate_accepts_preferencesignal_objects():
    """入参可为 pydantic PreferenceSignal 对象（非仅 dict）。"""
    sig = PreferenceSignal(
        agentId="a1", jobType="code", direction="up",
        craftScores={"code_test_coverage": 5.0}, ts="t",  # → reliability+1, quality+1
    )
    profile = aggregate_preference([sig])
    assert profile.dimLift.get("reliability", 0.0) == 1.0
    assert profile.dimLift.get("quality", 0.0) == 1.0
    assert profile.signals[0] is sig  # 已是对象则原样保留


# ======================================================================
# apply_to_user_preference —— 权重回灌数值正确性
# ======================================================================
def test_apply_formula_matches_manual_computation():
    """w'[d]=w*(1+α·dimLift[d]/N) 再归一 Σ=1；逐维与手算一致。"""
    base = _weight()
    dim_lift = {"quality": 3.0, "task": 2.0}
    alpha, N = 0.15, 3

    new_w = apply_to_user_preference(base, dim_lift, alpha=alpha, N=N)
    assert math.isclose(sum(new_w.values()), 1.0, rel_tol=1e-9)

    # 手算未归一化的 w'，再归一
    raw = {d: base[d] * (1.0 + alpha * dim_lift.get(d, 0.0) / N) for d in base}
    s = sum(raw.values())
    expected = {d: raw[d] / s for d in base}
    for d in base:
        assert math.isclose(new_w[d], expected[d], rel_tol=1e-9), d


def test_apply_lifted_dim_increases_relative_share():
    """被提升维的相对权重占比上升，其余未提升维相对下降。"""
    base = _weight()
    new_w = apply_to_user_preference(base, {"quality": 3.0}, alpha=0.15, N=3)
    # quality 份额（占总重的比例）应上升
    assert new_w["quality"] / sum(new_w.values()) > base["quality"] / sum(base.values())
    # 未被提升的 creativity 绝对值应下降（被归一化稀释）
    assert new_w["creativity"] < base["creativity"]


def test_apply_r1_gating_returns_original_when_n_lt_3():
    """R1 门控：N<3 时原样返回原 weight（不回灌）。"""
    base = _weight()
    dim_lift = {"quality": 3.0}
    result = apply_to_user_preference(base, dim_lift, alpha=0.15, N=2)
    assert result == base


def test_apply_r1_gating_default_n_from_dim_lift_sum():
    """N 缺省时由 sum(dim_lift) 推导；总和 <3 则门控生效返回原 weight。"""
    base = _weight()
    dim_lift = {"quality": 1.0, "task": 1.0}  # sum=2 < 3
    result = apply_to_user_preference(base, dim_lift, alpha=0.15)  # N=None
    assert result == base


def test_apply_preserves_key_set():
    """回灌不增删通用六维的键集合。"""
    base = _weight()
    new_w = apply_to_user_preference(base, {"task": 3.0}, alpha=0.15, N=3)
    assert set(new_w.keys()) == set(base.keys())


# ======================================================================
# 数值稳定性 / 边界
# ======================================================================
def test_apply_extreme_lift_stays_normalized_and_bounded():
    """极端 dimLift（α 与 lift 都很大）下：归一化保证 0<=w<=1 且 Σ=1。

    注：源码 apply_to_user_preference 不做绝对权重裁剪（clamp），仅依赖
    归一化保证各维落入 (0,1) 且和为 1。本用例固化这一不变量，作为「合法范围」
    的边界契约：在此 R1 门控（N>=3）与归一化下，权重不会越界。
    """
    base = _weight()
    dim_lift = {"quality": 1000.0}
    alpha = 10.0
    new_w = apply_to_user_preference(base, dim_lift, alpha=alpha, N=3)
    assert math.isclose(sum(new_w.values()), 1.0, rel_tol=1e-9)
    for d, w in new_w.items():
        assert 0.0 <= w <= 1.0, f"{d}={w} 越界"
    # 极端提升后 quality 占绝对主导
    assert new_w["quality"] > 0.99


def test_apply_empty_dim_lift_with_n_ge_3_keeps_normalized():
    """dimLift 为空但显式 N>=3：各维 lift=0 → w'=w，归一后仍 Σ=1 且等于原 weight。"""
    base = _weight()
    new_w = apply_to_user_preference(base, {}, alpha=0.15, N=3)
    assert math.isclose(sum(new_w.values()), 1.0, rel_tol=1e-9)
    for d in base:
        assert math.isclose(new_w[d], base[d], rel_tol=1e-9)


def test_apply_zero_n_returns_original():
    """N=0（<3）门控生效，返回原 weight。"""
    base = _weight()
    assert apply_to_user_preference(base, {"quality": 1.0}, alpha=0.15, N=0) == base


def test_aggregate_then_apply_roundtrip_sums_to_one():
    """端到端：聚合真实信号 → dimLift → 回灌，最终 Σ=1 且被提升维上升。"""
    signals = [
        _up("a1", {"code_runnability": 5.0}),
        _up("a2", {"code_runnability": 4.0}),
        _up("a3", {"code_runnability": 3.0}),
    ]
    profile = aggregate_preference(signals)
    assert len(profile.signals) == 3
    base = _weight()
    new_w = apply_to_user_preference(base, profile.dimLift, alpha=0.15, N=3)
    assert math.isclose(sum(new_w.values()), 1.0, rel_tol=1e-9)
    assert new_w["task"] > base["task"]
    assert new_w["reliability"] > base["reliability"]


if __name__ == "__main__":
    for name in list(globals()):
        if name.startswith("test_"):
            globals()[name]()
    print("tests/test_preference.py 全部通过")
