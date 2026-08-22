"""
model-service/app/sandbox/text_checks.py
文本/多模态答案的确定性结构校验（代码无关的客观结构事实）。

为什么需要它：沙箱目前只验 code 工种（可运行性 + 安全扫描），text/image 类任务
零机器验证——全靠 LLM 裁判读散文。本模块提供一条**确定性的、可重放的**结构证据链，
补上文本侧的空白。它不是要替代 LLM 裁判，而是提供「代码无关的客观结构事实」
（如「答案确实包含了要求的章节」「JSON 可解析」「长度达标」），和 LLM 裁判互补。

核心原则（与 security_scan.py 一致）：
- **绝不用 LLM 判断**。所有检查都是纯字符串/结构匹配，结论确定且可重放。
- **不声称「写得好不好」**。证据文本只陈述「检查了什么、结果如何」。
- **每条 finding 给行号 + 规则名**，方便人工复核与下游程序化消费。
- **零新增依赖**，只用标准库 re / json。

与 security_scan.py 的分工：
- security_scan → code 工种 → 代码的「危险构造」与「可运行性」
- text_checks   → text/image 工种 → 答案的「结构完整性」与「格式合规」
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional


# ======================================================================
# 数据结构（镜像 SecurityScanResult 风格）
# ======================================================================
@dataclass
class TextFinding:
    """一条文本结构校验发现（行号 + 规则 + 严重度，均可人工复核）。"""

    rule: str
    severity: str  # 'high' | 'medium' | 'low'
    line: int
    message: str


@dataclass
class TextCheckResult:
    """一次文本结构校验的结果。

    outcome 语义：
    - 'checked'  = 至少跑了一条检查，有结论
    - 'no_text'  = 答案为空或无意义（如只含空白），无法检查
    - 'skipped'  = spec 未要求任何检查，跳过
    """

    outcome: str  # 'checked' | 'no_text' | 'skipped'
    checks_run: int = 0
    findings: List[TextFinding] = field(default_factory=list)
    reason: str = ""

    @property
    def verifiable(self) -> bool:
        """只有真的跑过检查才算证据。空答案 / 未启用时不给结论。"""
        return self.outcome == "checked"

    def evidence_text(self) -> str:
        """人类可读的一句话证据摘要（陈述事实，不评价好坏）。"""
        if not self.verifiable:
            return ""
        if not self.findings:
            return f"文本结构校验（{self.checks_run} 项检查）：全部通过，0 处异常"
        top = self.findings[0]
        return (
            f"文本结构校验（{self.checks_run} 项检查）："
            f"{len(self.findings)} 处异常；"
            f"首条 L{top.line} {top.rule}：{top.message}"
        )

    def to_dict(self) -> Dict:
        return {
            "outcome": self.outcome,
            "checksRun": self.checks_run,
            "findings": [
                {
                    "rule": f.rule,
                    "severity": f.severity,
                    "line": f.line,
                    "message": f.message,
                }
                for f in self.findings
            ],
            "reason": self.reason,
            "verifiable": self.verifiable,
            "evidence": self.evidence_text(),
        }


# ======================================================================
# 工具函数
# ======================================================================
def _line_of(text: str, char_offset: int) -> int:
    """把字符偏移转为 1-based 行号。char_offset 越界时钳到末尾。"""
    if char_offset < 0:
        return 1
    # 计算 char_offset 之前有多少个换行符
    clamped = min(char_offset, len(text))
    return text[:clamped].count("\n") + 1


def _extract_code_blocks(text: str) -> List[str]:
    """抽取 ``` 代码块的内容（不含围栏本身）。"""
    pattern = re.compile(r"```[^\n]*\n(.*?)```", re.DOTALL)
    return pattern.findall(text)


# ======================================================================
# 检查 1：required_sections —— 答案是否包含所有要求的小节标题
# ======================================================================
def required_sections(
    answer: str, sections: List[str]
) -> TextCheckResult:
    """检查答案是否包含所有要求的小节标题。

    匹配规则（大小写不敏感）：
    - "## 标题" 或 "### 标题" 等 Markdown 标题行
    - "标题：" 或 "标题:" 的行首形式

    缺章节 → finding medium。
    """
    if not sections:
        return TextCheckResult(
            outcome="checked",
            checks_run=0,
            reason="未指定任何要求的小节，跳过",
        )

    findings: List[TextFinding] = []
    lines = answer.splitlines()

    for section in sections:
        # 规范化：去首尾空白，小写
        target = section.strip().lower()
        if not target:
            continue

        found = False
        for i, line in enumerate(lines):
            line_lower = line.strip().lower()
            # 匹配 "## 标题" 或 "### 标题" 等
            # 去掉 Markdown 标题前缀 # 号后比较
            heading_match = re.match(r"^#{1,6}\s+(.+)$", line_lower)
            if heading_match:
                heading_text = heading_match.group(1).strip()
                # 标题中包含目标关键词即算命中（宽松匹配）
                if target in heading_text or heading_text in target:
                    found = True
                    break
            # 匹配 "标题：" 或 "标题:" 行首形式
            colon_match = re.match(r"^(.+?)\s*[:：]\s*$", line_lower)
            if colon_match:
                prefix = colon_match.group(1).strip()
                if target in prefix or prefix in target:
                    found = True
                    break
            # 行内包含「标题：」形式
            if re.search(
                re.escape(target) + r"\s*[:：]", line_lower
            ):
                found = True
                break

        if not found:
            # 找最接近的行号用于定位（找不到就给 0）
            best_line = 0
            for i, line in enumerate(lines):
                if any(
                    word in line.lower()
                    for word in target.split()
                    if len(word) > 1
                ):
                    best_line = i + 1
                    break
            findings.append(
                TextFinding(
                    rule="missing-section",
                    severity="medium",
                    line=best_line,
                    message=f"缺少要求的小节「{section}」",
                )
            )

    return TextCheckResult(
        outcome="checked",
        checks_run=len(sections),
        findings=findings,
    )


# ======================================================================
# 检查 2：length_bounds —— 字符数是否在界内
# ======================================================================
def length_bounds(
    answer: str, min_len: int = 0, max_len: int = 0
) -> TextCheckResult:
    """检查答案字符数是否在 [min_len, max_len] 界内。

    max_len=0 表示不设上限；min_len=0 表示不设下限。
    超界 → finding low。
    """
    char_count = len(answer)
    findings: List[TextFinding] = []

    if min_len > 0 and char_count < min_len:
        findings.append(
            TextFinding(
                rule="too-short",
                severity="low",
                line=1,
                message=f"答案长度 {char_count} 字符，低于下限 {min_len}",
            )
        )

    if max_len > 0 and char_count > max_len:
        # 找超界位置所在行
        over_line = _line_of(answer, max_len)
        findings.append(
            TextFinding(
                rule="too-long",
                severity="low",
                line=over_line,
                message=f"答案长度 {char_count} 字符，超过上限 {max_len}",
            )
        )

    return TextCheckResult(
        outcome="checked",
        checks_run=1,
        findings=findings,
    )


# ======================================================================
# 检查 3：json_validity —— 答案中的 JSON 是否可解析
# ======================================================================
def json_validity(
    answer: str, expected: bool = True
) -> TextCheckResult:
    """若任务要求产出 JSON，抽取代码块/全文尝试 json.loads。

    策略（按优先级）：
    1. 尝试从 ```json 代码块中提取
    2. 尝试从任意 ``` 代码块中提取
    3. 尝试全文 json.loads

    expected=False 时跳过检查（任务不要求 JSON）。
    失败 → finding high（「声称给 JSON 但不可解析」）。
    """
    if not expected:
        return TextCheckResult(
            outcome="checked",
            checks_run=0,
            reason="题目未要求 JSON 输出，跳过",
        )

    candidates: List[str] = []

    # 1) ```json 代码块
    json_blocks = re.findall(
        r"```json\s*\n(.*?)```", answer, re.DOTALL
    )
    candidates.extend(json_blocks)

    # 2) 任意 ``` 代码块
    if not candidates:
        candidates.extend(_extract_code_blocks(answer))

    # 3) 全文兜底
    candidates.append(answer.strip())

    parse_errors: List[str] = []
    for candidate in candidates:
        candidate = candidate.strip()
        if not candidate:
            continue
        try:
            json.loads(candidate)
            # 解析成功 → 通过
            return TextCheckResult(
                outcome="checked",
                checks_run=1,
                findings=[],
            )
        except json.JSONDecodeError as exc:
            parse_errors.append(str(exc))

    # 全部尝试失败
    # 找第一个 { 或 [ 的位置作为行号提示
    first_brace = answer.find("{")
    first_bracket = answer.find("[")
    offsets = [x for x in [first_brace, first_bracket] if x >= 0]
    hint_line = _line_of(answer, min(offsets)) if offsets else 1

    findings = [
        TextFinding(
            rule="json-unparseable",
            severity="high",
            line=hint_line,
            message=f"声称给出 JSON 但不可解析（{parse_errors[-1] if parse_errors else '空内容'}）",
        )
    ]
    return TextCheckResult(
        outcome="checked",
        checks_run=1,
        findings=findings,
    )


# ======================================================================
# 检查 4：placeholder_detection —— 检测空话占位符
# ======================================================================
# 常见的「我没写完」占位符模式
_PLACEHOLDER_PATTERNS = [
    (re.compile(r"TODO", re.IGNORECASE), "TODO 标记（未完成内容）"),
    (re.compile(r"此处省略"), "「此处省略」占位符"),
    (re.compile(r"以下省略"), "「以下省略」占位符"),
    (re.compile(r"\.{3,}"), "连续省略号（可能为未展开内容）"),
    (re.compile(r"\[内容\]"), "「[内容]」占位符"),
    (re.compile(r"\[待补[充全]?\]"), "「[待补充]」占位符"),
    (re.compile(r"<你的.{0,20}>"), "「<你的xxx>」模板占位符"),
    (re.compile(r"<请填[写充].{0,20}>"), "「<请填写>」模板占位符"),
    (re.compile(r"\{填入.{0,20}\}"), "「{填入xxx}」模板占位符"),
    (re.compile(r"\.\.\.\s*（.{0,30}）"), "省略号加括号注释（可疑的留白）"),
]


def placeholder_detection(answer: str) -> TextCheckResult:
    """检测空话占位符（确定性版本，与 craft_judge 的 padding 思路一致）。

    命中占位符 → finding medium。
    """
    findings: List[TextFinding] = []
    lines = answer.splitlines()

    for pattern, desc in _PLACEHOLDER_PATTERNS:
        for i, line in enumerate(lines):
            if pattern.search(line):
                findings.append(
                    TextFinding(
                        rule="placeholder",
                        severity="medium",
                        line=i + 1,
                        message=f"检测到占位符：{desc}",
                    )
                )
                break  # 每种模式只报一次（首次出现）

    return TextCheckResult(
        outcome="checked",
        checks_run=len(_PLACEHOLDER_PATTERNS),
        findings=findings,
    )


# ======================================================================
# 检查 5：no_empty_promise —— 检测空口承诺但无具体细节
# ======================================================================
# 空口承诺关键词（声称「已做好」但可能没有实际内容）
_PROMISE_WORDS = [
    "已充分测试",
    "已全面测试",
    "充分测试",
    "全面测试",
    "经过严格测试",
    "保证专业",
    "保证质量",
    "完全符合",
    "完全满足",
    "确保无误",
    "确保正确",
    "零错误",
    "零缺陷",
    "无任何问题",
    "已经完善",
    "已做完善",
]


def no_empty_promise(answer: str) -> TextCheckResult:
    """检测「已充分测试/保证专业/完全符合」等空口承诺但无具体细节。

    确定性启发式：含承诺词却无数字、无代码块、无列表 → 可能是空话。
    → finding low。

    注意：这不是「判断写得好不好」，只是「检测到一个结构模式：
    声称做好了但没有给出支撑细节」。
    """
    findings: List[TextFinding] = []

    # 是否有具体细节（数字、代码块、列表项）
    has_numbers = bool(re.search(r"\d+", answer))
    has_code_block = bool(_extract_code_blocks(answer))
    has_list_items = bool(
        re.search(r"^\s*[-*]\s+", answer, re.MULTILINE)
    ) or bool(re.search(r"^\s*\d+\.\s+", answer, re.MULTILINE))
    has_details = has_numbers or has_code_block or has_list_items

    if not has_details:
        lines = answer.splitlines()
        for i, line in enumerate(lines):
            for promise in _PROMISE_WORDS:
                if promise in line:
                    findings.append(
                        TextFinding(
                            rule="empty-promise",
                            severity="low",
                            line=i + 1,
                            message=(
                                f"含承诺「{promise}」但答案中无数字/代码块/"
                                f"列表等具体细节支撑"
                            ),
                        )
                    )
                    break  # 每行只报一次

    return TextCheckResult(
        outcome="checked",
        checks_run=1,
        findings=findings,
    )


# ======================================================================
# 聚合函数：check_text_answer
# ======================================================================
def check_text_answer(answer: str, spec: dict) -> TextCheckResult:
    """按 spec 开关跑所有文本结构检查，聚合为一个 TextCheckResult。

    spec 支持的键：
    - required_sections: list[str]  —— 要求包含的小节标题
    - min_len: int                   —— 最小字符数（0 = 不设下限）
    - max_len: int                   —— 最大字符数（0 = 不设上限）
    - json_expected: bool            —— 是否要求 JSON 输出
    - check_placeholders: bool       —— 是否检测占位符（默认 True）
    - check_empty_promises: bool     —— 是否检测空口承诺（默认 True）

    返回聚合结果：合并所有子检查的 findings，累加 checks_run。
    """
    # 空答案 → 无法检查
    if not answer or not answer.strip():
        return TextCheckResult(
            outcome="no_text",
            reason="答案为空或只含空白，无法执行结构校验",
        )

    all_findings: List[TextFinding] = []
    total_checks = 0
    any_ran = False

    # 1) 要求的小节
    sections = spec.get("required_sections")
    if sections:
        result = required_sections(answer, sections)
        all_findings.extend(result.findings)
        total_checks += result.checks_run
        any_ran = True

    # 2) 长度边界
    min_len = spec.get("min_len", 0)
    max_len = spec.get("max_len", 0)
    if min_len or max_len:
        result = length_bounds(answer, min_len, max_len)
        all_findings.extend(result.findings)
        total_checks += result.checks_run
        any_ran = True

    # 3) JSON 有效性
    json_expected = spec.get("json_expected", False)
    if json_expected:
        result = json_validity(answer, expected=True)
        all_findings.extend(result.findings)
        total_checks += result.checks_run
        any_ran = True

    # 4) 占位符检测（默认开）
    if spec.get("check_placeholders", True):
        result = placeholder_detection(answer)
        all_findings.extend(result.findings)
        total_checks += result.checks_run
        any_ran = True

    # 5) 空口承诺检测（默认开）
    if spec.get("check_empty_promises", True):
        result = no_empty_promise(answer)
        all_findings.extend(result.findings)
        total_checks += result.checks_run
        any_ran = True

    if not any_ran:
        return TextCheckResult(
            outcome="skipped",
            reason="spec 未要求任何检查项",
        )

    # 按严重度排序（high → medium → low），同严重度按行号
    order = {"high": 0, "medium": 1, "low": 2}
    all_findings.sort(key=lambda f: (order.get(f.severity, 9), f.line))

    return TextCheckResult(
        outcome="checked",
        checks_run=total_checks,
        findings=all_findings,
    )


def text_evidence_for(task_id: str, result: TextCheckResult) -> Dict[str, str]:
    """映射为 verified_evidence 条目（与 security_evidence_for 对称）。

    只对 verifiable 的结果产出证据，空答案 / 跳过不给结论。
    """
    if not result.verifiable:
        return {}
    return {"text_structure": f"[{task_id}] {result.evidence_text()}"}
