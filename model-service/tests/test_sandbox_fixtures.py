"""
model-service/tests/test_sandbox_fixtures.py
5 道新增确定性夹具题的三态测试（正确 solution 通过 / 错误 solution 失败 / 缺入口函数失败）。

复用 test_sandbox.py 的 _enable_sandbox 夹具模式（sandbox_enabled=True, timeout=12, mem_mb=512）。
每道题验证：
1. 正确实现过夹具 → passed，产出可抬权的 verified_evidence
2. 错误实现过夹具 → failed，失败是负面证据绝不抬权
3. 缺入口函数 → failed（夹具契约未满足，非沙箱故障）
"""
from __future__ import annotations

import pytest

from app.config import settings
from app.sandbox import run_python_answer, verified_evidence_for


@pytest.fixture(autouse=True)
def _enable_sandbox(monkeypatch):
    """默认开启沙盒（生产默认关闭，测试里显式打开）。"""
    monkeypatch.setattr(settings, "sandbox_enabled", True, raising=False)
    monkeypatch.setattr(settings, "sandbox_timeout", 12.0, raising=False)
    monkeypatch.setattr(settings, "sandbox_mem_mb", 512, raising=False)


# ======================================================================
# 1. code_json_transform —— JSON 清洗归一化
# ======================================================================
_GOOD_JSON_TRANSFORM = '''\
import re

def _normalize_amount(raw):
    """清洗金额字段：去货币符号、千分位逗号，转 float；无法解析返回 None。"""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    # 去掉货币符号和千分位逗号
    s = re.sub(r'[￥¥$,]', '', s).strip()
    if not s:
        return None
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


def _normalize_status(raw):
    """统一状态为 bool：active/1/yes/true → True；inactive/0/no/false/"" → False。"""
    if raw is None:
        return False
    if isinstance(raw, bool):
        return raw
    s = str(raw).strip().lower()
    if s in ("active", "1", "yes", "true", "y"):
        return True
    return False


def transform(data):
    """清洗归一化嵌套 JSON。

    - 过滤无 id 的记录
    - 重复 id 保留最后出现的（后覆盖前）
    - amount 归一化为 float 或 None
    - status 统一为 bool
    - 缺字段补默认值
    """
    records = data.get("records", []) if isinstance(data, dict) else []
    cleaned = {}
    for rec in records:
        if not isinstance(rec, dict):
            continue
        rid = rec.get("id")
        if not rid:
            continue  # 过滤无 id 记录
        cleaned[str(rid)] = {
            "id": str(rid),
            "name": rec.get("name") or "Unknown",
            "amount": _normalize_amount(rec.get("amount")),
            "status": _normalize_status(rec.get("status")),
            "updated_at": rec.get("updated_at", ""),
        }
    return {"records": list(cleaned.values())}
'''

_BAD_JSON_TRANSFORM = '''\
def transform(data):
    """错误实现：不做任何清洗，直接返回原数据。"""
    return data
'''

_NO_ENTRY_JSON = '''\
def unrelated_function():
    return 42
'''


def test_json_transform_correct_passes():
    """正确实现过夹具 → passed + verified_evidence。"""
    result = run_python_answer(_GOOD_JSON_TRANSFORM, task_id="code_json_transform")
    assert result.outcome == "passed", f"expected passed, got {result.outcome}: {result.cases}"
    assert result.total == 12
    assert result.passed == 12
    assert result.failed == 0
    assert "code_runnability" in verified_evidence_for("code_json_transform", result)


def test_json_transform_wrong_fails():
    """不做清洗的实现过夹具 → failed，负面证据不抬权。"""
    result = run_python_answer(_BAD_JSON_TRANSFORM, task_id="code_json_transform")
    assert result.outcome == "failed"
    assert result.failed >= 1
    assert verified_evidence_for("code_json_transform", result) == {}


def test_json_transform_missing_entrypoint():
    """缺 transform 入口函数 → 夹具 import 失败 → failed。"""
    result = run_python_answer(_NO_ENTRY_JSON, task_id="code_json_transform")
    assert result.outcome == "failed"
    assert verified_evidence_for("code_json_transform", result) == {}


# ======================================================================
# 2. code_list_dedup_sort —— 列表去重（大小写不敏感保留首现）+ 排序
# ======================================================================
_GOOD_DEDUP_SORT = '''\
def dedup_sort(items):
    """大小写不敏感去重（保留首次出现的大小写），按小写字母序排序。"""
    seen = {}  # lowercase -> original (first occurrence)
    for item in items:
        key = item.lower()
        if key not in seen:
            seen[key] = item
    return sorted(seen.values(), key=lambda x: x.lower())
'''

_BAD_DEDUP_SORT = '''\
def dedup_sort(items):
    """错误实现：只排序不去重。"""
    return sorted(items)
'''

_NO_ENTRY_DEDUP = '''\
def unrelated():
    return []
'''


def test_list_dedup_sort_correct_passes():
    """正确实现过夹具 → passed + verified_evidence。"""
    result = run_python_answer(_GOOD_DEDUP_SORT, task_id="code_list_dedup_sort")
    assert result.outcome == "passed", f"expected passed, got {result.outcome}: {result.cases}"
    assert result.total == 7
    assert result.passed == 7
    assert result.failed == 0
    assert "code_runnability" in verified_evidence_for("code_list_dedup_sort", result)


def test_list_dedup_sort_wrong_fails():
    """只排序不去重的实现过夹具 → failed。"""
    result = run_python_answer(_BAD_DEDUP_SORT, task_id="code_list_dedup_sort")
    assert result.outcome == "failed"
    assert result.failed >= 1
    assert verified_evidence_for("code_list_dedup_sort", result) == {}


def test_list_dedup_sort_missing_entrypoint():
    """缺 dedup_sort 入口函数 → failed。"""
    result = run_python_answer(_NO_ENTRY_DEDUP, task_id="code_list_dedup_sort")
    assert result.outcome == "failed"
    assert verified_evidence_for("code_list_dedup_sort", result) == {}


# ======================================================================
# 3. code_log_parse —— 从混合日志中提取 ERROR 行并结构化
# ======================================================================
_GOOD_LOG_PARSE = '''\
import re

_LOG_RE = re.compile(
    r'^(?P<ts>\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})\\s+'
    r'(?P<level>\\w+)\\s+'
    r'(?P<msg>.+)$'
)

def parse_errors(text):
    """从多行日志中提取 ERROR 行，返回结构化列表。"""
    results = []
    for line in text.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        m = _LOG_RE.match(line)
        if m and m.group("level") == "ERROR":
            results.append({
                "level": "ERROR",
                "timestamp": m.group("ts"),
                "message": m.group("msg").strip(),
            })
    return results
'''

_BAD_LOG_PARSE = '''\
def parse_errors(text):
    """错误实现：返回所有行（不过滤非 ERROR）。"""
    return [{"level": "ALL", "timestamp": "", "message": line} for line in text.strip().splitlines() if line.strip()]
'''

_NO_ENTRY_LOG = '''\
def unrelated():
    return []
'''


def test_log_parse_correct_passes():
    """正确实现过夹具 → passed + verified_evidence。"""
    result = run_python_answer(_GOOD_LOG_PARSE, task_id="code_log_parse")
    assert result.outcome == "passed", f"expected passed, got {result.outcome}: {result.cases}"
    assert result.total == 11
    assert result.passed == 11
    assert result.failed == 0
    assert "code_runnability" in verified_evidence_for("code_log_parse", result)


def test_log_parse_wrong_fails():
    """不过滤非 ERROR 行的实现过夹具 → failed。"""
    result = run_python_answer(_BAD_LOG_PARSE, task_id="code_log_parse")
    assert result.outcome == "failed"
    assert result.failed >= 1
    assert verified_evidence_for("code_log_parse", result) == {}


def test_log_parse_missing_entrypoint():
    """缺 parse_errors 入口函数 → failed。"""
    result = run_python_answer(_NO_ENTRY_LOG, task_id="code_log_parse")
    assert result.outcome == "failed"
    assert verified_evidence_for("code_log_parse", result) == {}


# ======================================================================
# 4. code_word_frequency —— 分词统计 Top-N
# ======================================================================
_GOOD_WORD_FREQ = '''\
import re
from collections import Counter

_STOPWORDS = {
    "the", "a", "an", "is", "at", "was", "but", "too",
    "with", "and", "or", "in", "on", "of", "to", "for",
}

def top_words(text, n):
    """分词统计 Top-N（大小写归一、标点剥离、停用词过滤）。"""
    words = re.findall(r"[a-zA-Z]+", text.lower())
    filtered = [w for w in words if w not in _STOPWORDS]
    counts = Counter(filtered)
    return [word for word, _ in counts.most_common(n)]
'''

_BAD_WORD_FREQ = '''\
def top_words(text, n):
    """错误实现：不过滤停用词、不归一大小写。"""
    words = text.split()
    return words[:n]
'''

_NO_ENTRY_WORD = '''\
def unrelated():
    return []
'''


def test_word_frequency_correct_passes():
    """正确实现过夹具 → passed + verified_evidence。"""
    result = run_python_answer(_GOOD_WORD_FREQ, task_id="code_word_frequency")
    assert result.outcome == "passed", f"expected passed, got {result.outcome}: {result.cases}"
    assert result.total == 10
    assert result.passed == 10
    assert result.failed == 0
    assert "code_runnability" in verified_evidence_for("code_word_frequency", result)


def test_word_frequency_wrong_fails():
    """不过滤停用词的实现过夹具 → failed。"""
    result = run_python_answer(_BAD_WORD_FREQ, task_id="code_word_frequency")
    assert result.outcome == "failed"
    assert result.failed >= 1
    assert verified_evidence_for("code_word_frequency", result) == {}


def test_word_frequency_missing_entrypoint():
    """缺 top_words 入口函数 → failed。"""
    result = run_python_answer(_NO_ENTRY_WORD, task_id="code_word_frequency")
    assert result.outcome == "failed"
    assert verified_evidence_for("code_word_frequency", result) == {}


# ======================================================================
# 5. code_set_operations —— 两列表的差集与交集
# ======================================================================
_GOOD_SET_OPS = '''\
def diff_and_intersect(a, b):
    """返回两个列表的差集与交集。

    Returns:
        dict: {"only_a": [...], "only_b": [...], "both": [...]}
    """
    set_a = set(a)
    set_b = set(b)
    return {
        "only_a": sorted(set_a - set_b),
        "only_b": sorted(set_b - set_a),
        "both": sorted(set_a & set_b),
    }
'''

_BAD_SET_OPS = '''\
def diff_and_intersect(a, b):
    """错误实现：only_a 和 only_b 搞反了。"""
    set_a = set(a)
    set_b = set(b)
    return {
        "only_a": sorted(set_b - set_a),  # 故意搞反
        "only_b": sorted(set_a - set_b),  # 故意搞反
        "both": sorted(set_a & set_b),
    }
'''

_NO_ENTRY_SET = '''\
def unrelated():
    return {}
'''


def test_set_operations_correct_passes():
    """正确实现过夹具 → passed + verified_evidence。"""
    result = run_python_answer(_GOOD_SET_OPS, task_id="code_set_operations")
    assert result.outcome == "passed", f"expected passed, got {result.outcome}: {result.cases}"
    assert result.total == 10
    assert result.passed == 10
    assert result.failed == 0
    assert "code_runnability" in verified_evidence_for("code_set_operations", result)


def test_set_operations_wrong_fails():
    """差集搞反的实现过夹具 → failed。"""
    result = run_python_answer(_BAD_SET_OPS, task_id="code_set_operations")
    assert result.outcome == "failed"
    assert result.failed >= 1
    assert verified_evidence_for("code_set_operations", result) == {}


def test_set_operations_missing_entrypoint():
    """缺 diff_and_intersect 入口函数 → failed。"""
    result = run_python_answer(_NO_ENTRY_SET, task_id="code_set_operations")
    assert result.outcome == "failed"
    assert verified_evidence_for("code_set_operations", result) == {}


# ======================================================================
# 6. code_regex_extract —— 正则提取邮箱/URL/日期
# ======================================================================
_GOOD_REGEX_EXTRACT = (
    "import re\n"
    "\n"
    "def extract_entities(text):\n"
    "    emails = []\n"
    "    for m in re.finditer(r'[\\w.+-]+@[\\w-]+\\.[\\w.-]+', text):\n"
    "        email = m.group()\n"
    "        if '@' in email and '.' in email.split('@')[1]:\n"
    "            emails.append(email)\n"
    "    urls = re.findall(r'https?://\\S+', text)\n"
    "    dates = re.findall(r'\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2})?', text)\n"
    "    return {'emails': emails, 'urls': urls, 'dates': dates}\n"
)

_BAD_REGEX_EXTRACT = '''\
def extract_entities(text):
    """错误实现：把任何包含 @ 或 http 的片段都当作实体提取。"""
    return {"emails": ["user@"], "urls": ["htp://broken"], "dates": []}
'''

_NO_ENTRY_REGEX = '''\
def unrelated():
    return {}
'''


def test_regex_extract_correct_passes():
    """正确实现过夹具 → passed + verified_evidence。"""
    result = run_python_answer(_GOOD_REGEX_EXTRACT, task_id="code_regex_extract")
    assert result.outcome == "passed", f"expected passed, got {result.outcome}: {result.cases}"
    assert result.passed >= 8, f"expected >= 8 passed, got {result.passed}: {result.cases}"
    assert "code_runnability" in verified_evidence_for("code_regex_extract", result)


def test_regex_extract_wrong_fails():
    """提取了无效实体的实现过夹具 → failed。"""
    result = run_python_answer(_BAD_REGEX_EXTRACT, task_id="code_regex_extract")
    assert result.outcome == "failed"
    assert result.failed >= 1
    assert verified_evidence_for("code_regex_extract", result) == {}


def test_regex_extract_missing_entrypoint():
    """缺 extract_entities 入口函数 → failed。"""
    result = run_python_answer(_NO_ENTRY_REGEX, task_id="code_regex_extract")
    assert result.outcome == "failed"
    assert verified_evidence_for("code_regex_extract", result) == {}


# ======================================================================
# 7. code_data_validate —— 数据校验
# ======================================================================
_GOOD_DATA_VALIDATE = '''\
import re

def validate_record(record):
    """校验记录字段，返回 {field: error_message} dict。"""
    errors = {}

    # name：非空字符串
    name = record.get("name")
    if name is not None and (not isinstance(name, str) or not name.strip()):
        errors["name"] = "名称不能为空"

    # email：必须包含 @ 和 .
    email = record.get("email")
    if email is not None:
        if not isinstance(email, str) or "@" not in email or "." not in email.split("@")[-1]:
            errors["email"] = "邮箱格式无效"

    # age：0-150 的整数
    age = record.get("age")
    if age is not None:
        if not isinstance(age, int) or isinstance(age, bool) or age < 0 or age > 150:
            errors["age"] = "年龄必须在 0-150 之间"

    # url：必须以 http:// 或 https:// 开头
    url = record.get("url")
    if url is not None:
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            errors["url"] = "URL 格式无效（需以 http:// 或 https:// 开头）"

    return errors
'''

_BAD_DATA_VALIDATE = '''\
def validate_record(record):
    """错误实现：永远返回空 dict（不校验任何字段）。"""
    return {}
'''

_NO_ENTRY_VALIDATE = '''\
def unrelated():
    return {}
'''


def test_data_validate_correct_passes():
    """正确实现过夹具 → passed + verified_evidence。"""
    result = run_python_answer(_GOOD_DATA_VALIDATE, task_id="code_data_validate")
    assert result.outcome == "passed", f"expected passed, got {result.outcome}: {result.cases}"
    assert result.passed >= 8, f"expected >= 8 passed, got {result.passed}: {result.cases}"
    assert "code_runnability" in verified_evidence_for("code_data_validate", result)


def test_data_validate_wrong_fails():
    """不校验任何字段的实现过夹具 → failed。"""
    result = run_python_answer(_BAD_DATA_VALIDATE, task_id="code_data_validate")
    assert result.outcome == "failed"
    assert result.failed >= 1
    assert verified_evidence_for("code_data_validate", result) == {}


def test_data_validate_missing_entrypoint():
    """缺 validate_record 入口函数 → failed。"""
    result = run_python_answer(_NO_ENTRY_VALIDATE, task_id="code_data_validate")
    assert result.outcome == "failed"
    assert verified_evidence_for("code_data_validate", result) == {}


# ======================================================================
# 8. code_config_merge —— 多层配置合并
# ======================================================================
_GOOD_CONFIG_MERGE = '''\
import copy

def deep_merge(base, override):
    """深合并两个字典：嵌套 dict 递归合并，其他类型后者覆盖前者。不修改原字典。"""
    result = copy.deepcopy(base)
    for key, val in override.items():
        if (
            key in result
            and isinstance(result[key], dict)
            and isinstance(val, dict)
        ):
            result[key] = deep_merge(result[key], val)
        else:
            result[key] = copy.deepcopy(val)
    return result
'''

_BAD_CONFIG_MERGE = '''\
def deep_merge(base, override):
    """错误实现：浅合并（覆盖而非递归）。"""
    result = dict(base)
    result.update(override)
    return result
'''

_NO_ENTRY_MERGE = '''\
def unrelated():
    return {}
'''


def test_config_merge_correct_passes():
    """正确实现过夹具 → passed + verified_evidence。"""
    result = run_python_answer(_GOOD_CONFIG_MERGE, task_id="code_config_merge")
    assert result.outcome == "passed", f"expected passed, got {result.outcome}: {result.cases}"
    assert result.passed >= 7, f"expected >= 7 passed, got {result.passed}: {result.cases}"
    assert "code_runnability" in verified_evidence_for("code_config_merge", result)


def test_config_merge_wrong_fails():
    """浅合并的实现过夹具 → failed（嵌套 dict 被覆盖而非递归合并）。"""
    result = run_python_answer(_BAD_CONFIG_MERGE, task_id="code_config_merge")
    assert result.outcome == "failed"
    assert result.failed >= 1
    assert verified_evidence_for("code_config_merge", result) == {}


def test_config_merge_missing_entrypoint():
    """缺 deep_merge 入口函数 → failed。"""
    result = run_python_answer(_NO_ENTRY_MERGE, task_id="code_config_merge")
    assert result.outcome == "failed"
    assert verified_evidence_for("code_config_merge", result) == {}


# ======================================================================
# 注册表完整性
# ======================================================================
def test_all_new_specs_registered():
    """8 道新题都已注册到 _SANDBOX_SPECS。"""
    from app.sandbox.craft_tasks_sandbox import _SANDBOX_SPECS
    expected_ids = {
        "code_json_transform",
        "code_list_dedup_sort",
        "code_log_parse",
        "code_word_frequency",
        "code_set_operations",
        "code_regex_extract",
        "code_data_validate",
        "code_config_merge",
    }
    assert expected_ids.issubset(set(_SANDBOX_SPECS.keys())), (
        f"missing specs: {expected_ids - set(_SANDBOX_SPECS.keys())}"
    )


def test_all_specs_have_machine_verifiable_dims():
    """每道题都至少声明了 code_runnability 维度。"""
    from app.sandbox.craft_tasks_sandbox import _SANDBOX_SPECS
    for tid, spec in _SANDBOX_SPECS.items():
        assert "code_runnability" in spec.machine_verifiable_dims, (
            f"{tid} missing code_runnability in machine_verifiable_dims"
        )
