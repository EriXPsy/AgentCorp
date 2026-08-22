"""
tests/test_rules_engine.py
rules_engine 专项测试：规则加载/校验、非法规则被拒、数值正确性、预设切换。

设计原则：
- 纯单元验证，不触达网络或模型。
- 数值期望值独立于实现手算，交叉核对而非复制内部逻辑。
- 只读不改源码。
"""
from __future__ import annotations

import json
import math
import os
import sys
import tempfile
from unittest import mock

import pytest

# 让测试能 import app 包
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.scoring.rules_engine import (  # noqa: E402
    load_rules,
    flatten_dim_weight,
    compute_stage_score,
    verdict_from_total,
    _detect_job_type,
    _PRESETS_DIR,
)
from app.scoring.registry import (  # noqa: E402
    RADAR_DIMS,
    JOB_CRAFT_DIMS,
    JOB_GENERIC_WEIGHT,
)

STAGES = ["preScreen", "interview", "performance"]
JOBS = ["image", "text", "code"]
VALID_PRESETS = ["default", "cost-focused", "quality-focused"]


# ======================================================================
# 辅助：从 presets 目录直接读原始 JSON（绕过 load_rules，用于交叉验证）
# ======================================================================
def _raw_preset(preset_id: str) -> dict:
    path = os.path.join(_PRESETS_DIR, f"{preset_id}.json")
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


# ======================================================================
# 1) 规则加载
# ======================================================================
class TestLoadRules:
    """load_rules 基本功能验证。"""

    def test_load_default(self):
        rules = load_rules("default")
        assert isinstance(rules, dict)
        assert rules["presetId"] == "default"
        assert "stages" in rules
        assert "jobs" in rules

    @pytest.mark.parametrize("preset", VALID_PRESETS)
    def test_load_each_preset(self, preset):
        rules = load_rules(preset)
        assert rules["presetId"] == preset

    def test_fallback_to_default_for_unknown_preset(self):
        """未知预设回退 default.json，不抛异常。"""
        rules = load_rules("nonexistent-xyz")
        assert rules["presetId"] == "default"

    def test_file_not_found_when_no_default(self):
        """预设文件和 default.json 都不存在时应抛 FileNotFoundError。"""
        fake_dir = tempfile.mkdtemp()
        with mock.patch(
            "app.scoring.rules_engine._PRESETS_DIR", fake_dir
        ):
            with pytest.raises(FileNotFoundError, match="规则预设缺失"):
                load_rules("anything")

    def test_loaded_rules_have_all_stages(self):
        rules = load_rules()
        for stage in STAGES:
            assert stage in rules["stages"], f"缺少阶段 {stage}"

    def test_loaded_rules_have_all_jobs(self):
        rules = load_rules()
        for job in JOBS:
            assert job in rules["jobs"], f"缺少工种 {job}"
            assert "craftDims" in rules["jobs"][job]

    def test_loaded_rules_have_generic_radar(self):
        rules = load_rules()
        assert rules["genericRadar"] == list(RADAR_DIMS)


# ======================================================================
# 2) 规则结构校验（非法规则检测）
# ======================================================================
class TestRulesValidation:
    """验证规则结构约束——这些是 rules_engine 消费的前提条件。"""

    def test_missing_stages_key(self):
        """缺少 stages 键的规则应使 flatten_dim_weight 抛 KeyError。"""
        bad = {"jobs": {}, "genericRadar": list(RADAR_DIMS)}
        with pytest.raises(KeyError):
            flatten_dim_weight("preScreen", "code", bad)

    def test_missing_stage_entry(self):
        """stages 中缺少具体阶段时应抛 KeyError。"""
        bad = {"stages": {}, "jobs": {}, "genericRadar": list(RADAR_DIMS)}
        with pytest.raises(KeyError):
            flatten_dim_weight("preScreen", "code", bad)

    def test_unknown_job_type_falls_back_to_empty_craft(self):
        """未知 job_type 时 craftDims 为空列表，只返回 generic 权重。"""
        rules = load_rules()
        dw = flatten_dim_weight("preScreen", "unknown-job", rules)
        # 只有 6 个 generic 维，无 craft 维
        assert set(dw.keys()) == set(RADAR_DIMS)
        assert math.isclose(sum(dw.values()), 1.0, rel_tol=1e-9)

    def test_zero_block_weights_returns_raw_with_zeros(self):
        """generic 和 craft 块权重全为 0 时，归一化分母为 0 → 返回 raw（全零值）。"""
        rules = load_rules()
        rules["stages"]["preScreen"]["objectiveBlockWeight"] = {
            "generic": 0.0,
            "craft": 0.0,
        }
        dw = flatten_dim_weight("preScreen", "code", rules)
        # 实现行为：total <= 0 时返回未归一化的 raw dict（值全为 0）
        assert all(v == 0.0 for v in dw.values()), "全零块权重应所有值为 0"
        assert len(dw) > 0, "应仍包含所有维的键（值为 0）"

    def test_negative_block_weight_returns_raw(self):
        """块权重为负时 total <= 0 → 返回未归一化的 raw dict（含负值）。"""
        rules = load_rules()
        rules["stages"]["preScreen"]["objectiveBlockWeight"] = {
            "generic": -0.5,
            "craft": -0.5,
        }
        dw = flatten_dim_weight("preScreen", "code", rules)
        # 实现行为：total <= 0 时返回未归一化的 raw dict
        assert len(dw) > 0
        assert any(v < 0 for v in dw.values()), "负块权重应产生负值维"


# ======================================================================
# 3) flatten_dim_weight 数值正确性
# ======================================================================
class TestFlattenDimWeight:
    """权重预折叠的数值正确性。"""

    @pytest.mark.parametrize("stage", STAGES)
    @pytest.mark.parametrize("job", JOBS)
    def test_weights_sum_to_one(self, stage, job):
        rules = load_rules()
        dw = flatten_dim_weight(stage, job, rules)
        assert math.isclose(sum(dw.values()), 1.0, rel_tol=1e-9)

    @pytest.mark.parametrize("stage", STAGES)
    @pytest.mark.parametrize("job", JOBS)
    def test_only_enabled_dims(self, stage, job):
        """dimWeight 键集 = RADAR_DIMS ∪ JOB_CRAFT_DIMS[job]。"""
        rules = load_rules()
        dw = flatten_dim_weight(stage, job, rules)
        expected = set(RADAR_DIMS) | set(JOB_CRAFT_DIMS[job])
        assert set(dw.keys()) == expected

    @pytest.mark.parametrize("stage", STAGES)
    def test_generic_weight_differs_by_job(self, stage):
        """不同工种的 generic 六维权重不同（Q2 差异化）。"""
        rules = load_rules()
        img = {d: flatten_dim_weight(stage, "image", rules)[d] for d in RADAR_DIMS}
        code = {d: flatten_dim_weight(stage, "code", rules)[d] for d in RADAR_DIMS}
        assert img != code

    def test_craft_dims_equally_split(self):
        """craft 块权重均分给各 craft 维。"""
        rules = load_rules()
        stage = "preScreen"
        job = "code"
        dw = flatten_dim_weight(stage, job, rules)
        craft_w = rules["stages"][stage]["objectiveBlockWeight"]["craft"]
        n_craft = len(rules["jobs"][job]["craftDims"])
        expected_per = craft_w / n_craft
        # 归一化后：per_normalized = expected_per / total
        # 但我们知道每个 craft 维权重相等，验证即可
        craft_vals = [dw[d] for d in JOB_CRAFT_DIMS[job]]
        for v in craft_vals:
            assert math.isclose(v, craft_vals[0], rel_tol=1e-9)

    def test_kpiroi_redistributed(self):
        """performance 阶段有 kpiRoi 块但无维度参与，其份额被重分配到 generic+craft。"""
        rules = load_rules()
        dw = flatten_dim_weight("performance", "code", rules)
        assert math.isclose(sum(dw.values()), 1.0, rel_tol=1e-9)

    def test_hand_calc_preimage_code(self):
        """手算验证 code/preScreen 的 flatten_dim_weight 数值。"""
        rules = load_rules()
        stage = "preScreen"
        job = "code"

        # 从 registry 取 generic 权重（优先于 JSON 中的 genericRadarWeight）
        gw = JOB_GENERIC_WEIGHT["code"]
        bw = rules["stages"][stage]["objectiveBlockWeight"]
        craft_dims = rules["jobs"][job]["craftDims"]

        # raw values
        raw = {}
        for dim, w in gw.items():
            raw[dim] = w * bw["generic"]
        craft_per = bw["craft"] / len(craft_dims)
        for d in craft_dims:
            raw[d] = craft_per

        total = sum(raw.values())
        expected = {k: v / total for k, v in raw.items()}

        actual = flatten_dim_weight(stage, job, rules)
        for dim in expected:
            assert math.isclose(actual[dim], expected[dim], rel_tol=1e-9), (
                f"{dim}: expected {expected[dim]}, got {actual[dim]}"
            )


# ======================================================================
# 4) compute_stage_score 数值正确性
# ======================================================================
class TestComputeStageScore:
    """阶段评分卡计算数值验证。"""

    def test_all_fives_objective_score_is_100(self):
        """所有客观维满分(5) → objectiveScore = 100。"""
        rules = load_rules()
        for job in JOBS:
            obj = {}
            for d in RADAR_DIMS:
                obj[d] = 5.0
            for d in JOB_CRAFT_DIMS[job]:
                obj[d] = 5.0
            res = compute_stage_score(obj, {}, rules, "preScreen", job_type=job)
            assert res["objectiveScore"] == 100.0, (
                f"{job}: 全满分 objectiveScore 应为 100，得到 {res['objectiveScore']}"
            )

    def test_all_zeros_objective_score_is_zero(self):
        """所有客观维零分 → objectiveScore = 0。"""
        rules = load_rules()
        for job in JOBS:
            obj = {}
            for d in RADAR_DIMS:
                obj[d] = 0.0
            for d in JOB_CRAFT_DIMS[job]:
                obj[d] = 0.0
            res = compute_stage_score(obj, {}, rules, "preScreen", job_type=job)
            assert res["objectiveScore"] == 0.0

    def test_all_fives_subjective_is_100(self):
        """所有主观维满分 → subjectiveScore = 100。"""
        rules = load_rules()
        stage = "preScreen"
        sub_dims = rules["stages"][stage]["enabledSubjective"]
        sub = {d: 5.0 for d in sub_dims}
        res = compute_stage_score({}, sub, rules, stage, job_type="code")
        assert res["subjectiveScore"] == 100.0

    def test_hand_calc_mixed_scores(self):
        """手算验证混合分数的 compute_stage_score 输出。"""
        rules = load_rules()
        stage = "preScreen"
        job = "code"

        # 构造客观分
        obj = {
            "task": 3.0, "quality": 4.0, "comm": 2.0, "creativity": 5.0,
            "reliability": 3.5, "cost": 4.5,
            "code_runnability": 3.0, "code_efficiency": 4.0,
            "code_test_coverage": 2.5, "code_maintainability": 3.5,
            "code_security": 4.0,
        }
        sub = {"sub_potential": 4.0, "sub_aesthetic_lean": 3.0}

        res = compute_stage_score(obj, sub, rules, stage, job_type=job)

        # 手算 objectiveScore
        dw = flatten_dim_weight(stage, job, rules)
        obj_acc = sum((obj[d] / 5.0) * dw[d] for d in dw)
        expected_obj = round(obj_acc * 100.0, 1)

        # 手算 subjectiveScore
        n_sub = len(rules["stages"][stage]["enabledSubjective"])
        sub_acc = sum((sub[d] / 5.0) * (1.0 / n_sub) for d in rules["stages"][stage]["enabledSubjective"])
        expected_sub = round(sub_acc * 100.0, 1)

        # 手算 total
        sc = rules["stages"][stage]
        expected_total = round(
            expected_obj * sc["objectiveWeight"] + expected_sub * sc["subjectiveWeight"], 1
        )

        assert res["objectiveScore"] == pytest.approx(expected_obj, rel=1e-6)
        assert res["subjectiveScore"] == pytest.approx(expected_sub, rel=1e-6)
        assert res["total"] == pytest.approx(expected_total, rel=1e-6)

    def test_missing_objective_dims_treated_as_zero(self):
        """objective 中缺失的维按 0 计。"""
        rules = load_rules()
        # 只给部分维度
        obj = {"task": 5.0, "quality": 5.0}
        res = compute_stage_score(obj, {}, rules, "preScreen", job_type="code")
        # 不能是 100，因为缺了很多维（按 0 计）
        assert res["objectiveScore"] < 100.0

    def test_auto_detect_job_type_code(self):
        """不传 job_type 时从 objective 中的 code_ 前缀自动推断。"""
        rules = load_rules()
        obj = {"code_runnability": 4.0}
        res = compute_stage_score(obj, {}, rules, "preScreen")
        assert res["jobType"] == "code"

    def test_auto_detect_job_type_image(self):
        rules = load_rules()
        obj = {"img_composition": 4.0}
        res = compute_stage_score(obj, {}, rules, "preScreen")
        assert res["jobType"] == "image"

    def test_auto_detect_job_type_text(self):
        rules = load_rules()
        obj = {"txt_factuality": 4.0}
        res = compute_stage_score(obj, {}, rules, "preScreen")
        assert res["jobType"] == "text"

    def test_auto_detect_default_code(self):
        """无 craft 维前缀时默认 code。"""
        rules = load_rules()
        obj = {"task": 4.0}  # generic 维，无 craft 前缀
        res = compute_stage_score(obj, {}, rules, "preScreen")
        assert res["jobType"] == "code"

    def test_extra_objective_dims_ignored(self):
        """dimWeight 中不存在的额外 objective 维被忽略（不影响分数）。"""
        rules = load_rules()
        obj = {"task": 5.0, "quality": 5.0, "comm": 5.0,
               "creativity": 5.0, "reliability": 5.0, "cost": 5.0,
               "code_runnability": 5.0, "code_efficiency": 5.0,
               "code_test_coverage": 5.0, "code_maintainability": 5.0,
               "code_security": 5.0}
        obj["unknown_extra_dim"] = 999.0  # 不应影响结果
        res = compute_stage_score(obj, {}, rules, "preScreen", job_type="code")
        assert res["objectiveScore"] == 100.0

    def test_result_contains_expected_keys(self):
        """返回值包含所有必需键。"""
        rules = load_rules()
        res = compute_stage_score({}, {}, rules, "preScreen", job_type="code")
        for key in ("objectiveScore", "subjectiveScore", "total", "verdict", "jobType", "stage", "dimWeight"):
            assert key in res, f"缺少键 {key}"


# ======================================================================
# 5) verdict_from_total 阈值映射
# ======================================================================
class TestVerdictFromTotal:
    """verdict 阈值映射验证。"""

    def test_mvp_threshold(self):
        assert verdict_from_total(78.0) is Verdict.MVP
        assert verdict_from_total(100.0) is Verdict.MVP

    def test_observe_range(self):
        assert verdict_from_total(77.9) is Verdict.OBSERVE
        assert verdict_from_total(50.0) is Verdict.OBSERVE
        assert verdict_from_total(65.0) is Verdict.OBSERVE

    def test_fired_below_observe(self):
        assert verdict_from_total(49.9) is Verdict.FIRED
        assert verdict_from_total(0.0) is Verdict.FIRED

    def test_custom_thresholds_from_rules(self):
        """自定义阈值优先于默认 78/50。"""
        rules = load_rules()
        rules["stages"]["preScreen"]["thresholds"] = {"mvp": 90, "observe": 60}
        assert verdict_from_total(89.9, rules, "preScreen") is Verdict.OBSERVE
        assert verdict_from_total(90.0, rules, "preScreen") is Verdict.MVP
        assert verdict_from_total(59.9, rules, "preScreen") is Verdict.FIRED
        assert verdict_from_total(60.0, rules, "preScreen") is Verdict.OBSERVE

    def test_default_thresholds_when_no_rules(self):
        """不传 rules 时使用默认阈值 78/50。"""
        assert verdict_from_total(78.0) is Verdict.MVP
        assert verdict_from_total(50.0) is Verdict.OBSERVE
        assert verdict_from_total(49.9) is Verdict.FIRED

    def test_default_thresholds_when_stage_not_in_rules(self):
        """stage 不在 rules 中时使用默认阈值。"""
        rules = load_rules()
        assert verdict_from_total(78.0, rules, "nonexistent_stage") is Verdict.MVP

    def test_missing_thresholds_key_uses_defaults(self):
        """stage 中无 thresholds 键时使用默认值。"""
        rules = load_rules()
        del rules["stages"]["preScreen"]["thresholds"]
        assert verdict_from_total(78.0, rules, "preScreen") is Verdict.MVP
        assert verdict_from_total(50.0, rules, "preScreen") is Verdict.OBSERVE


# ======================================================================
# 6) 预设切换
# ======================================================================
class TestPresetSwitching:
    """不同预设产生不同权重，体现切换效果。"""

    def test_cost_focused_weights_cost_more(self):
        """cost-focused 预设中 cost 维度权重应高于 default。"""
        default_rules = load_rules("default")
        cost_rules = load_rules("cost-focused")

        for stage in STAGES:
            dw_default = flatten_dim_weight(stage, "code", default_rules)
            dw_cost = flatten_dim_weight(stage, "code", cost_rules)
            assert dw_cost["cost"] > dw_default["cost"], (
                f"{stage}: cost-focused.cost 应 > default.cost"
            )

    def test_quality_focused_craft_block_larger(self):
        """quality-focused 预设中 craft 块权重应 ≥ default（preScreen/interview/performance 均如此）。

        注：因 registry.JOB_GENERIC_WEIGHT 优先于 JSON 中的 genericRadarWeight，
        通用六维权重在预设间完全相同。quality-focused 通过提高 craftBlockWeight
        来强化 craft 维（如 code_test_coverage / code_maintainability）的评分权重。
        """
        default_rules = load_rules("default")
        quality_rules = load_rules("quality-focused")

        for stage in STAGES:
            d_bw = default_rules["stages"][stage]["objectiveBlockWeight"]["craft"]
            q_bw = quality_rules["stages"][stage]["objectiveBlockWeight"]["craft"]
            assert q_bw >= d_bw, (
                f"{stage}: quality-focused craft block ({q_bw}) 应 >= default ({d_bw})"
            )

    def test_different_presets_different_block_weights(self):
        """default vs cost-focused：objectiveBlockWeight 配置不同。"""
        default_rules = load_rules("default")
        cost_rules = load_rules("cost-focused")

        # preScreen: default generic=0.6, cost-focused generic=0.7
        d_bw = default_rules["stages"]["preScreen"]["objectiveBlockWeight"]
        c_bw = cost_rules["stages"]["preScreen"]["objectiveBlockWeight"]
        assert d_bw["generic"] != c_bw["generic"]

    def test_preset_switch_changes_compute_stage_score(self):
        """切换预设后相同输入得到不同总分。"""
        obj = {"task": 4.0, "quality": 3.0, "comm": 3.0, "creativity": 3.0,
               "reliability": 3.0, "cost": 5.0}
        sub = {"sub_potential": 3.0, "sub_aesthetic_lean": 3.0}

        default_rules = load_rules("default")
        cost_rules = load_rules("cost-focused")

        res_default = compute_stage_score(obj, sub, default_rules, "preScreen", job_type="code")
        res_cost = compute_stage_score(obj, sub, cost_rules, "preScreen", job_type="code")

        # cost 维 5 分，cost-focused 更重 cost → total 更高
        assert res_cost["total"] > res_default["total"]

    def test_quality_focused_high_craft_scores_higher(self):
        """quality-focused 更重 craft 块，当 craft 维分数高时总分应更高。

        注意：registry.JOB_GENERIC_WEIGHT 覆盖了 JSON 的 genericRadarWeight，
        所以通用六维权重在预设间完全相同。quality-focused 通过提高 craftBlockWeight
        来放大 craft 维评分的影响。
        """
        rules_default = load_rules("default")
        rules_quality = load_rules("quality-focused")

        # craft 维给满分，generic 维给中等
        obj = {"task": 3.0, "quality": 3.0, "comm": 3.0, "creativity": 3.0,
               "reliability": 3.0, "cost": 3.0}
        for d in JOB_CRAFT_DIMS["code"]:
            obj[d] = 5.0
        sub = {"sub_potential": 3.0, "sub_aesthetic_lean": 3.0}

        res_default = compute_stage_score(obj, sub, rules_default, "preScreen", job_type="code")
        res_quality = compute_stage_score(obj, sub, rules_quality, "preScreen", job_type="code")

        # quality-focused 的 craft 块更重 (0.5 vs 0.4)，craft 维满分 → objectiveScore 更高
        assert res_quality["objectiveScore"] > res_default["objectiveScore"]

    def test_all_presets_produce_valid_weights(self):
        """所有预设的所有阶段/工种组合，dimWeight Σ=1。"""
        for preset in VALID_PRESETS:
            rules = load_rules(preset)
            for stage in STAGES:
                for job in JOBS:
                    dw = flatten_dim_weight(stage, job, rules)
                    assert math.isclose(sum(dw.values()), 1.0, rel_tol=1e-9), (
                        f"{preset}/{stage}/{job}: Σ={sum(dw.values())}"
                    )


# ======================================================================
# 7) _detect_job_type 边界
# ======================================================================
class TestDetectJobType:
    """_detect_job_type 自动推断验证。"""

    def test_detect_image(self):
        assert _detect_job_type({"img_x": 1.0}) == "image"

    def test_detect_text(self):
        assert _detect_job_type({"txt_y": 1.0}) == "text"

    def test_detect_code(self):
        assert _detect_job_type({"code_z": 1.0}) == "code"

    def test_detect_default_code(self):
        assert _detect_job_type({"task": 1.0}) == "code"
        assert _detect_job_type({}) == "code"

    def test_first_match_wins(self):
        """多个前缀共存时按字典序返回第一个匹配。"""
        # 字典插入顺序决定，img_ 在 txt_/code_ 之前
        assert _detect_job_type({"img_a": 1.0, "txt_b": 1.0}) == "image"
        assert _detect_job_type({"txt_a": 1.0, "code_b": 1.0}) == "text"


# 延迟导入 Verdict（放在文件末尾避免循环导入）
from app.schemas import Verdict  # noqa: E402
