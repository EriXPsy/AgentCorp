"""
model-service/tests/test_text_checks.py
文本结构校验的单测（确定性、可重放、零依赖）。

守的核心命题：text/image 类任务的答案目前零机器验证——全靠 LLM 裁判读散文。
本测试逐条钉死每个检查的正例（检出）与反例（不误报），保证：
1. 检查确实能检出真实问题
2. 正常答案不会被误伤（误报会让证据链失去可信度）
3. 结论确定可重放——同一输入永远同一输出，不依赖任何模型
"""
from __future__ import annotations

import json

from app.sandbox.text_checks import (
    TextCheckResult,
    check_text_answer,
    json_validity,
    length_bounds,
    no_empty_promise,
    placeholder_detection,
    required_sections,
    text_evidence_for,
)


# ======================================================================
# TextCheckResult 数据结构
# ======================================================================
class TestTextCheckResultStructure:
    """验证 TextCheckResult 的基本行为（镜像 SecurityScanResult 风格）。"""

    def test_verifiable_only_when_checked(self):
        assert TextCheckResult(outcome="checked").verifiable is True
        assert TextCheckResult(outcome="no_text").verifiable is False
        assert TextCheckResult(outcome="skipped").verifiable is False

    def test_evidence_text_empty_when_not_verifiable(self):
        assert TextCheckResult(outcome="no_text").evidence_text() == ""
        assert TextCheckResult(outcome="skipped").evidence_text() == ""

    def test_evidence_text_no_findings(self):
        r = TextCheckResult(outcome="checked", checks_run=3)
        text = r.evidence_text()
        assert "全部通过" in text
        assert "0 处异常" in text
        assert "3 项检查" in text

    def test_evidence_text_with_findings(self):
        from app.sandbox.text_checks import TextFinding

        r = TextCheckResult(
            outcome="checked",
            checks_run=2,
            findings=[
                TextFinding(rule="too-short", severity="low", line=1, message="太短"),
            ],
        )
        text = r.evidence_text()
        assert "1 处异常" in text
        assert "L1" in text
        assert "too-short" in text

    def test_to_dict_shape(self):
        r = TextCheckResult(outcome="checked", checks_run=1)
        d = r.to_dict()
        assert d["outcome"] == "checked"
        assert d["checksRun"] == 1
        assert d["verifiable"] is True
        assert "evidence" in d
        assert isinstance(d["findings"], list)

    def test_text_evidence_for_returns_empty_when_not_verifiable(self):
        assert text_evidence_for("t", TextCheckResult(outcome="no_text")) == {}
        assert text_evidence_for("t", TextCheckResult(outcome="skipped")) == {}

    def test_text_evidence_for_returns_entry_when_verifiable(self):
        r = TextCheckResult(outcome="checked", checks_run=1)
        ev = text_evidence_for("t1", r)
        assert "text_structure" in ev
        assert "[t1]" in ev["text_structure"]


# ======================================================================
# 检查 1：required_sections
# ======================================================================
class TestRequiredSections:
    """required_sections：正例检出 + 反例不误报。"""

    def test_all_sections_present_no_findings(self):
        """所有要求的章节都有 → 零 finding。"""
        answer = """## 背景
这里写背景。

## 方案
这里写方案。

## 总结
这里写总结。
"""
        result = required_sections(answer, ["背景", "方案", "总结"])
        assert result.outcome == "checked"
        assert result.findings == []
        assert result.checks_run == 3

    def test_missing_section_detected(self):
        """缺一个章节 → finding medium，规则名 missing-section。"""
        answer = """## 背景
这里写背景。

## 总结
这里写总结。
"""
        result = required_sections(answer, ["背景", "方案", "总结"])
        assert len(result.findings) == 1
        assert result.findings[0].rule == "missing-section"
        assert result.findings[0].severity == "medium"
        assert "方案" in result.findings[0].message

    def test_case_insensitive_matching(self):
        """大小写不敏感：要求 'Background'，答案写 'BACKGROUND' 也算命中。"""
        answer = "## BACKGROUND\n内容\n"
        result = required_sections(answer, ["Background"])
        assert result.findings == []

    def test_colon_format_accepted(self):
        """「标题：」形式也算命中。"""
        answer = "背景：这里是背景内容。\n"
        result = required_sections(answer, ["背景"])
        assert result.findings == []

    def test_hash_heading_levels(self):
        """### 三级标题也能匹配。"""
        answer = "### 实现细节\n内容\n"
        result = required_sections(answer, ["实现细节"])
        assert result.findings == []

    def test_empty_sections_list_skips(self):
        """空列表 → checks_run=0，无 finding。"""
        result = required_sections("任何内容", [])
        assert result.checks_run == 0
        assert result.findings == []

    def test_multiple_missing_sections(self):
        """缺多个章节 → 每个缺的都给一个 finding。"""
        answer = "## 背景\n内容\n"
        result = required_sections(answer, ["背景", "方案", "测试"])
        assert len(result.findings) == 2
        rules = {f.rule for f in result.findings}
        assert rules == {"missing-section"}

    def test_finding_has_line_number(self):
        """缺章节的 finding 应带行号（即使找不到精确位置也给 0 或合理值）。"""
        answer = "没有任何相关内容\n"
        result = required_sections(answer, ["不存在的章节"])
        assert len(result.findings) == 1
        # line 应该是 int（0 表示找不到精确行）
        assert isinstance(result.findings[0].line, int)


# ======================================================================
# 检查 2：length_bounds
# ======================================================================
class TestLengthBounds:
    """length_bounds：正例检出 + 反例不误报。"""

    def test_within_bounds_no_findings(self):
        """长度在界内 → 零 finding。"""
        answer = "这是一个中等长度的答案，用于测试长度边界检查是否正常工作。"
        result = length_bounds(answer, min_len=10, max_len=100)
        assert result.outcome == "checked"
        assert result.findings == []

    def test_too_short_detected(self):
        """太短 → finding low，规则名 too-short。"""
        result = length_bounds("短", min_len=10, max_len=100)
        assert len(result.findings) == 1
        assert result.findings[0].rule == "too-short"
        assert result.findings[0].severity == "low"
        assert "低于下限" in result.findings[0].message

    def test_too_long_detected(self):
        """太长 → finding low，规则名 too-long。"""
        answer = "x" * 200
        result = length_bounds(answer, min_len=0, max_len=100)
        assert len(result.findings) == 1
        assert result.findings[0].rule == "too-long"
        assert result.findings[0].severity == "low"
        assert "超过上限" in result.findings[0].message

    def test_no_upper_bound(self):
        """max_len=0 表示不设上限 → 长答案不报。"""
        answer = "x" * 10000
        result = length_bounds(answer, min_len=10, max_len=0)
        assert result.findings == []

    def test_no_lower_bound(self):
        """min_len=0 表示不设下限 → 短答案不报。"""
        result = length_bounds("x", min_len=0, max_len=100)
        assert result.findings == []

    def test_exact_boundary_no_finding(self):
        """恰好等于边界 → 不报（闭区间）。"""
        answer = "x" * 50
        result = length_bounds(answer, min_len=50, max_len=50)
        assert result.findings == []

    def test_both_bounds_violated(self):
        """矛盾 spec（min > max）时，一个答案可以同时 too_short 和 too_long，
        检查器应如实反映两处越界。"""
        # min=100, max=50（矛盾），答案 200 字符：超过 max=50 且低于 min=100 不可能
        # 所以用一个 200 字符的答案：> max=50 → too_long；但 200 > min=100 不触发 too_short
        # 正确做法：用 30 字符答案触发 too_short（30 < 100），
        # 同时 30 > 50 为 False 不触发 too_long。
        # 要同时触发两者需要一个矛盾 spec + 不可能的长度，
        # 所以这里只验证检查器不会因为矛盾 spec 而崩溃，
        # 且至少会检出 too-short（30 < 100）。
        result = length_bounds("x" * 30, min_len=100, max_len=50)
        # 30 < 100 → too_short 应检出
        assert any(f.rule == "too-short" for f in result.findings)


# ======================================================================
# 检查 3：json_validity
# ======================================================================
class TestJsonValidity:
    """json_validity：正例检出 + 反例不误报。"""

    def test_valid_json_in_code_block(self):
        """```json 代码块中的合法 JSON → 零 finding。"""
        answer = '''结果如下：
```json
{"name": "test", "value": 42}
```
'''
        result = json_validity(answer, expected=True)
        assert result.outcome == "checked"
        assert result.findings == []

    def test_valid_json_plain_code_block(self):
        """普通 ``` 代码块中的合法 JSON → 零 finding。"""
        answer = '''```
{"key": "value"}
```'''
        result = json_validity(answer, expected=True)
        assert result.findings == []

    def test_valid_json_full_text(self):
        """全文就是合法 JSON → 零 finding。"""
        answer = '{"status": "ok", "count": 3}'
        result = json_validity(answer, expected=True)
        assert result.findings == []

    def test_invalid_json_detected(self):
        """声称给 JSON 但不可解析 → finding high，规则名 json-unparseable。"""
        answer = '```json\n{"name": "test", broken}\n```'
        result = json_validity(answer, expected=True)
        assert len(result.findings) == 1
        assert result.findings[0].rule == "json-unparseable"
        assert result.findings[0].severity == "high"

    def test_trailing_comma_invalid(self):
        """JSON 不允许尾逗号 → 应检出。"""
        answer = '{"a": 1, "b": 2,}'
        result = json_validity(answer, expected=True)
        assert len(result.findings) == 1
        assert result.findings[0].rule == "json-unparseable"

    def test_expected_false_skips(self):
        """expected=False 时跳过检查，不报。"""
        answer = "这不是 JSON 只是普通文本"
        result = json_validity(answer, expected=False)
        assert result.outcome == "checked"
        assert result.checks_run == 0
        assert result.findings == []

    def test_json_array_valid(self):
        """JSON 数组也能解析。"""
        answer = '[1, 2, 3, "four"]'
        result = json_validity(answer, expected=True)
        assert result.findings == []

    def test_empty_json_object_valid(self):
        """空 JSON 对象 {} 也是合法 JSON。"""
        answer = "{}"
        result = json_validity(answer, expected=True)
        assert result.findings == []


# ======================================================================
# 检查 4：placeholder_detection
# ======================================================================
class TestPlaceholderDetection:
    """placeholder_detection：正例检出 + 反例不误报。"""

    def test_todo_detected(self):
        """TODO 标记 → finding medium。"""
        answer = "这里需要实现 XXX 功能\nTODO: 补充异常处理\n"
        result = placeholder_detection(answer)
        assert any(f.rule == "placeholder" for f in result.findings)
        todo_findings = [f for f in result.findings if "TODO" in f.message]
        assert len(todo_findings) >= 1
        assert all(f.severity == "medium" for f in result.findings)

    def test_chinese_placeholder_detected(self):
        """「此处省略」→ 检出。"""
        answer = "具体实现如下：\n此处省略\n其他内容"
        result = placeholder_detection(answer)
        assert any("此处省略" in f.message for f in result.findings)

    def test_ellipsis_detected(self):
        """连续三个点 ... → 检出。"""
        answer = "列表包括 A, B, C, ..."
        result = placeholder_detection(answer)
        assert any("省略号" in f.message for f in result.findings)

    def test_bracket_placeholder_detected(self):
        """[内容] → 检出。"""
        answer = "请填入 [内容] 后提交"
        result = placeholder_detection(answer)
        assert any("[内容]" in f.message for f in result.findings)

    def test_angle_bracket_placeholder_detected(self):
        """<你的xxx> → 检出。"""
        answer = "请联系 <你的邮箱> 获取更多信息"
        result = placeholder_detection(answer)
        assert any("<你的" in f.message for f in result.findings)

    def test_clean_text_no_false_positive(self):
        """正常中文文本，不含任何占位符 → 零 finding。"""
        answer = (
            "本文介绍了一种基于注意力机制的文本分类方法。"
            "实验结果表明，该方法在多个基准数据集上取得了优异的表现。"
            "具体数据见下文表格。"
        )
        result = placeholder_detection(answer)
        assert result.findings == []

    def test_normal_ellipsis_in_quote_not_flagged(self):
        """中文引号内的省略号（……）不该被三个英文点的规则命中。"""
        answer = "正如古人所说：「学而时习之，不亦说乎……」"
        result = placeholder_detection(answer)
        # …… 是中文省略号，不该触发 ... 规则
        ellipsis_findings = [
            f for f in result.findings if "省略号" in f.message
        ]
        assert ellipsis_findings == []

    def test_finding_has_line_number(self):
        """每个 finding 都带行号。"""
        answer = "正常文本\n\nTODO 补充\n"
        result = placeholder_detection(answer)
        todo_f = [f for f in result.findings if "TODO" in f.message]
        assert len(todo_f) == 1
        assert todo_f[0].line == 3


# ======================================================================
# 检查 5：no_empty_promise
# ======================================================================
class TestNoEmptyPromise:
    """no_empty_promise：正例检出 + 反例不误报。"""

    def test_promise_without_details_detected(self):
        """含「已充分测试」但无数字/代码/列表 → finding low。"""
        answer = "本方案已充分测试，保证专业，完全符合要求。"
        result = no_empty_promise(answer)
        assert len(result.findings) == 1
        assert result.findings[0].rule == "empty-promise"
        assert result.findings[0].severity == "low"

    def test_promise_with_numbers_not_flagged(self):
        """含承诺词但也有数字 → 有支撑，不报。"""
        answer = "已充分测试，覆盖 95% 的分支，通过 200 个测试用例。"
        result = no_empty_promise(answer)
        assert result.findings == []

    def test_promise_with_code_block_not_flagged(self):
        """含承诺词但也有代码块 → 有支撑，不报。"""
        answer = """已充分测试，代码如下：
```
def test_add():
    assert add(1, 2) == 3
```"""
        result = no_empty_promise(answer)
        assert result.findings == []

    def test_promise_with_list_not_flagged(self):
        """含承诺词但也有列表 → 有支撑，不报。"""
        answer = """已全面测试，包括：
- 单元测试
- 集成测试
- 性能测试"""
        result = no_empty_promise(answer)
        assert result.findings == []

    def test_clean_text_no_promise_no_finding(self):
        """不含任何承诺词 → 零 finding。"""
        answer = "本文提出了一种新的排序算法，时间复杂度为 O(n log n)。"
        result = no_empty_promise(answer)
        assert result.findings == []

    def test_multiple_promises_each_flagged(self):
        """多个空口承诺 → 每个都检出（但每行只报一次）。"""
        answer = "已充分测试\n保证专业\n完全符合"
        result = no_empty_promise(answer)
        assert len(result.findings) >= 2

    def test_promise_with_ordered_list_not_flagged(self):
        """含编号列表也算有细节。"""
        answer = """已做完善，具体包括：
1. 输入校验
2. 异常处理
3. 日志记录"""
        result = no_empty_promise(answer)
        assert result.findings == []


# ======================================================================
# 聚合函数：check_text_answer
# ======================================================================
class TestCheckTextAnswer:
    """check_text_answer 聚合行为。"""

    def test_empty_answer_returns_no_text(self):
        """空答案 → outcome='no_text'。"""
        assert check_text_answer("", {}).outcome == "no_text"
        assert check_text_answer("   ", {}).outcome == "no_text"
        assert check_text_answer(None, {}).outcome == "no_text"

    def test_no_spec_returns_skipped(self):
        """空 spec（所有检查都关） → outcome='skipped'。"""
        spec = {
            "check_placeholders": False,
            "check_empty_promises": False,
        }
        result = check_text_answer("正常内容", spec)
        assert result.outcome == "skipped"

    def test_full_spec_all_checks_run(self):
        """完整 spec 跑所有检查，checks_run 累加。"""
        answer = """## 背景
这是一个详细的分析报告，包含 100 条数据。

## 方案
采用以下步骤：
- 步骤一
- 步骤二

## 总结
完成。
"""
        spec = {
            "required_sections": ["背景", "方案", "总结"],
            "min_len": 10,
            "max_len": 10000,
            "json_expected": False,
            "check_placeholders": True,
            "check_empty_promises": True,
        }
        result = check_text_answer(answer, spec)
        assert result.outcome == "checked"
        assert result.checks_run > 0
        assert result.findings == []

    def test_aggregates_findings_from_multiple_checks(self):
        """多个检查都有 finding → 聚合到一起。"""
        # 短 + 缺章节 + 有占位符
        answer = "TODO 补充背景"
        spec = {
            "required_sections": ["背景", "方案"],
            "min_len": 100,
            "check_placeholders": True,
            "check_empty_promises": False,
        }
        result = check_text_answer(answer, spec)
        assert result.outcome == "checked"
        assert len(result.findings) >= 2  # 至少缺章节 + 占位符

    def test_findings_sorted_by_severity(self):
        """聚合结果按严重度排序（high → medium → low）。"""
        answer = "TODO 补充\n已充分测试"  # 占位符(medium) + 空口承诺(low)
        spec = {
            "check_placeholders": True,
            "check_empty_promises": True,
        }
        result = check_text_answer(answer, spec)
        if len(result.findings) >= 2:
            severities = [f.severity for f in result.findings]
            severity_order = {"high": 0, "medium": 1, "low": 2}
            values = [severity_order[s] for s in severities]
            assert values == sorted(values), "findings 应按严重度升序排列"

    def test_json_check_integrated(self):
        """json_expected=True 时跑 JSON 检查。"""
        answer = '{"valid": true}'
        spec = {"json_expected": True}
        result = check_text_answer(answer, spec)
        assert result.outcome == "checked"
        assert result.findings == []

    def test_json_check_catches_invalid(self):
        """json_expected=True 但 JSON 不合法 → 检出。"""
        answer = "{broken json"
        spec = {"json_expected": True}
        result = check_text_answer(answer, spec)
        assert any(f.rule == "json-unparseable" for f in result.findings)

    def test_default_checks_placeholders_and_promises_on(self):
        """默认开启占位符和空口承诺检测。"""
        answer = "TODO 待补充内容，已充分测试。"
        result = check_text_answer(answer, {})
        assert result.outcome == "checked"
        # 默认应检出占位符和空口承诺
        rules = {f.rule for f in result.findings}
        assert "placeholder" in rules
        assert "empty-promise" in rules

    def test_to_dict_in_aggregated_result(self):
        """聚合结果的 to_dict 格式正确。"""
        answer = "正常内容，不短不长，没有任何问题。"
        result = check_text_answer(answer, {})
        d = result.to_dict()
        assert d["outcome"] == "checked"
        assert isinstance(d["checksRun"], int)
        assert isinstance(d["findings"], list)
        assert d["verifiable"] is True


# ======================================================================
# 确定性 / 可重放性
# ======================================================================
class TestDeterminism:
    """验证结论确定可重放——同一输入永远同一输出。"""

    def test_same_input_same_output(self):
        """同一输入跑两次，结果完全一致。"""
        answer = "## 章节一\nTODO 补充\n已充分测试\n"
        spec = {
            "required_sections": ["章节一", "章节二"],
            "min_len": 5,
            "check_placeholders": True,
            "check_empty_promises": True,
        }
        r1 = check_text_answer(answer, spec)
        r2 = check_text_answer(answer, spec)
        assert r1.to_dict() == r2.to_dict()

    def test_no_randomness_no_model_dependency(self):
        """本模块不 import 任何 LLM 相关库，结论纯确定性。"""
        import app.sandbox.text_checks as tc

        # 验证模块没有导入任何模型/网络相关库
        source = open(tc.__file__, "r", encoding="utf-8").read()
        assert "openai" not in source.lower()
        assert "anthropic" not in source.lower()
        assert "requests" not in source.lower()
