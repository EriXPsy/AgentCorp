"""
model-service/app/sandbox/craft_tasks_sandbox.py
craft 题的沙箱可验版本：为每道可机验的 craft 题定义 fixture + test harness。

为什么需要它：craft_tasks.py 只有题面和 rubric（文本），评分全靠 LLM 读散文。
本模块为可机验的题目补充「固定 fixture + 断言脚本」，让 harness 真跑代码、
真验结果，产出 machine_verified 证据。

接入方式：sandbox runner 拿到候选代码后，从本模块取该题的 SandboxSpec，
把 fixture 和 test_harness 写入沙箱目录，执行后得到 SandboxResult。

覆盖面（2026-08 实测）：9 道确定性夹具题，均为纯「输入→输出」的数据变换，
可确定性断言。
- code_csv_merge：合并两份 CSV，处理脏数据（千分位 / 货币符号 / 空串 / 无法解析）
- code_json_transform：清洗归一化嵌套 JSON（缺键补默认 / 类型错误 / null / 过滤无效项）
- code_list_dedup_sort：列表去重（大小写不敏感保留首现）+ 排序
- code_log_parse：从混合日志中提取 ERROR 行并结构化
- code_word_frequency：分词统计 Top-N（大小写归一 / 标点剥离 / 停用词过滤）
- code_set_operations：两列表的差集与交集运算
- code_regex_extract：正则提取邮箱/URL/日期（过滤无效格式）
- code_data_validate：记录字段校验（多规则同时检出）
- code_config_merge：多层配置深合并（嵌套 dict 递归 + 不可变性）

design/reasoning 题（code_debug_race、code_api_hardening、code_boss_system）
不由本模块覆盖——它们是推理题，应由 LLM 裁判按 rubric 打分。
扩大机器可验覆盖面靠「新增确定性题型」，而非给推理题硬塞夹具。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List


@dataclass
class SandboxSpec:
    """一道题的沙箱可验规格。"""
    task_id: str
    #: fixture 文件 {filename: content} —— 写入沙箱目录
    fixture_files: Dict[str, str] = field(default_factory=dict)
    #: 测试执行脚本（断言逻辑）—— 沙箱中用 python 运行
    test_harness: str = ""
    #: 该题可机验的 craft 维度（断言通过即 machine_verified）
    machine_verifiable_dims: List[str] = field(default_factory=list)


# ======================================================================
# code_csv_merge —— 合并 CSV 并处理脏数据（可机验）
# ======================================================================
_CSV_MERGE_FIXTURE_A = """order_id,amount,updated_at
1001,"1,234.50",2024-01-15T10:00:00
1002,"￥88",2024-01-15T11:00:00
1003,,2024-01-15T12:00:00
"""

_CSV_MERGE_FIXTURE_B = """order_id,amount,updated_at
1001,"999.00",2024-01-15T09:00:00
1002,"￥88",2024-01-14T08:00:00
1004,"abc",2024-01-15T13:00:00
"""

_CSV_MERGE_TEST_HARNESS = '''\
"""code_csv_merge 自动断言脚本。沙箱执行入口。"""
import json
import sys

sys.path.insert(0, ".")
from solution import merge_orders

errors = []
passed = 0
total = 0

def check(name, condition, detail=""):
    global passed, total
    total += 1
    if condition:
        passed += 1
    else:
        errors.append(f"{name}: {detail}")

# 1) 基本合并
result = merge_orders("fixture_a.csv", "fixture_b.csv")
check("returns_list", isinstance(result, list), f"got {type(result).__name__}")

if isinstance(result, list):
    # 按 order_id 索引
    by_id = {r["order_id"]: r for r in result}

    # 2) order_id=1001 两边都有 → 取 updated_at 较新的（A: 2024-01-15T10:00 > B: 2024-01-15T09:00 → 应取 A 的 1234.50）
    if "1001" in by_id:
        amt = by_id["1001"].get("amount")
        check("1001_takes_newer", amt == 1234.50, f"expected 1234.50, got {amt!r}")
    else:
        check("1001_exists", False, "order_id 1001 missing from result")

    # 3) 金额归一化：'1,234.50' → 1234.5, '￥88' → 88.0
    if "1002" in by_id:
        amt = by_id["1002"].get("amount")
        check("1002_normalize", amt == 88.0, f"expected 88.0, got {amt!r}")

    # 4) 空字符串 → None（不抛异常）
    if "1003" in by_id:
        amt = by_id["1003"].get("amount")
        check("1003_empty_to_none", amt is None, f"expected None, got {amt!r}")

    # 5) 无法解析 → None（1004 的 amount='abc'）
    if "1004" in by_id:
        amt = by_id["1004"].get("amount")
        check("1004_unparseable_to_none", amt is None, f"expected None, got {amt!r}")

    # 6) 覆盖完整性：4 个 order_id 都应在结果中
    expected_ids = {"1001", "1002", "1003", "1004"}
    actual_ids = set(by_id.keys())
    check("all_ids_present", expected_ids == actual_ids,
          f"expected {expected_ids}, got {actual_ids}")

print(json.dumps({"total": total, "passed": passed, "errors": errors}))
'''

# ======================================================================
# code_json_transform —— 清洗归一化嵌套 JSON（可机验）
# ======================================================================
# fixture 包含多种脏数据：缺键、类型错误（"abc" 金额）、null 值、
# 重复 ID（后出现的覆盖前者）、无 ID 记录（应过滤）、状态字段多样写法。
_JSON_TRANSFORM_INPUT = {
    "records": [
        {"id": "r1", "name": "Widget A", "amount": "￥1,234.50", "status": "active", "updated_at": "2024-01-01T10:00:00"},
        {"id": "r2", "name": "Gadget B", "amount": "88", "status": "1"},
        {"id": "r3", "name": "Doohickey C", "amount": None, "status": "yes"},
        {"id": "r4", "name": "Thingamajig D", "amount": "abc", "status": "0"},
        {"id": "r2", "name": "Gadget B v2", "amount": "￥2,000", "status": "active"},
        {"amount": "99", "status": "active"},
        {"id": "r5", "amount": "￥500.25", "status": ""},
    ]
}

_JSON_TRANSFORM_EXPECTED_KEYS = {"id", "name", "amount", "status", "updated_at"}

_JSON_TRANSFORM_HARNESS = '''\
"""code_json_transform 自动断言脚本。沙箱执行入口。"""
import json
import sys

sys.path.insert(0, ".")
from solution import transform

errors = []
passed = 0
total = 0

def check(name, condition, detail=""):
    global passed, total
    total += 1
    if condition:
        passed += 1
    else:
        errors.append(f"{name}: {detail}")

INPUT = {
    "records": [
        {"id": "r1", "name": "Widget A", "amount": "￥1,234.50", "status": "active", "updated_at": "2024-01-01T10:00:00"},
        {"id": "r2", "name": "Gadget B", "amount": "88", "status": "1"},
        {"id": "r3", "name": "Doohickey C", "amount": None, "status": "yes"},
        {"id": "r4", "name": "Thingamajig D", "amount": "abc", "status": "0"},
        {"id": "r2", "name": "Gadget B v2", "amount": "￥2,000", "status": "active"},
        {"amount": "99", "status": "active"},
        {"id": "r5", "amount": "￥500.25", "status": ""},
    ]
}

result = transform(INPUT)

# 1) 返回 dict 且含 records 键
check("returns_dict", isinstance(result, dict), f"got {type(result).__name__}")

if isinstance(result, dict):
    records = result.get("records", [])
    check("records_is_list", isinstance(records, list), f"got {type(records).__name__}")

    if isinstance(records, list):
        by_id = {r.get("id"): r for r in records if isinstance(r, dict)}

        # 2) 无 id 记录被过滤（只有 5 条有效记录：r1, r2 去重后留 1, r3, r4, r5）
        check("no_id_filtered", len(records) == 5,
              f"expected 5 records (filtered no-id + deduped r2), got {len(records)}")

        # 3) r1 金额归一化：￥1,234.50 → 1234.5
        r1 = by_id.get("r1")
        check("r1_amount", r1 is not None and r1.get("amount") == 1234.5,
              f"expected 1234.5, got {r1}")

        # 4) r1 状态 "active" → True
        check("r1_status", r1 is not None and r1.get("status") is True,
              f"expected True, got {r1.get('status') if r1 else 'N/A'}")

        # 5) r2 重复 → 后出现者覆盖：amount=￥2,000→2000.0, status="active"→True
        r2 = by_id.get("r2")
        check("r2_dedup_latest", r2 is not None and r2.get("amount") == 2000.0,
              f"expected 2000.0 (latest wins), got {r2}")

        # 6) r3 金额 None → None（不抛异常）
        r3 = by_id.get("r3")
        check("r3_null_amount", r3 is not None and r3.get("amount") is None,
              f"expected None, got {r3}")

        # 7) r3 状态 "yes" → True
        check("r3_status_yes", r3 is not None and r3.get("status") is True,
              f"expected True for 'yes', got {r3.get('status') if r3 else 'N/A'}")

        # 8) r4 金额 "abc" → None
        r4 = by_id.get("r4")
        check("r4_unparseable", r4 is not None and r4.get("amount") is None,
              f"expected None for 'abc', got {r4}")

        # 9) r4 状态 "0" → False
        check("r4_status_zero", r4 is not None and r4.get("status") is False,
              f"expected False for '0', got {r4.get('status') if r4 else 'N/A'}")

        # 10) r5 缺 name → 补默认值 "Unknown"（或非空字符串）
        r5 = by_id.get("r5")
        check("r5_default_name", r5 is not None and isinstance(r5.get("name"), str) and len(r5.get("name", "")) > 0,
              f"expected non-empty default name, got {r5}")

        # 11) r5 状态 "" → False
        check("r5_empty_status", r5 is not None and r5.get("status") is False,
              f"expected False for empty string, got {r5.get('status') if r5 else 'N/A'}")

print(json.dumps({"total": total, "passed": passed, "errors": errors}))
'''

# ======================================================================
# code_list_dedup_sort —— 列表去重（大小写不敏感保留首现）+ 排序（可机验）
# ======================================================================
_LIST_DEDUP_SORT_INPUT = ["banana", "Apple", "cherry", "apple", "Banana", "date", "Cherry", "apple", "Date"]
_LIST_DEDUP_SORT_EXPECTED = ["Apple", "banana", "cherry", "date"]

_LIST_DEDUP_SORT_HARNESS = '''\
"""code_list_dedup_sort 自动断言脚本。沙箱执行入口。"""
import json
import sys

sys.path.insert(0, ".")
from solution import dedup_sort

errors = []
passed = 0
total = 0

def check(name, condition, detail=""):
    global passed, total
    total += 1
    if condition:
        passed += 1
    else:
        errors.append(f"{name}: {detail}")

# 基本用例：大小写混杂 + 重复
items = ["banana", "Apple", "cherry", "apple", "Banana", "date", "Cherry", "apple", "Date"]
result = dedup_sort(items)

# 1) 返回 list
check("returns_list", isinstance(result, list), f"got {type(result).__name__}")

if isinstance(result, list):
    # 2) 去重后长度 = 4（Apple/banana/cherry/date）
    check("dedup_count", len(result) == 4, f"expected 4, got {len(result)}: {result}")

    # 3) 大小写不敏感保留首现："apple" 首次出现在 index 1 (Apple)，之后 "apple"/"Apple" 都跳过
    #    所以结果中应为 "Apple"（index 1 的首现），而非 "apple"（index 3）
    check("keeps_first_occurrence", "Apple" in result, f"expected 'Apple' in result, got {result}")

    # 4) 排序正确（小写字母序）
    expected = ["Apple", "banana", "cherry", "date"]
    check("correct_order", result == expected, f"expected {expected}, got {result}")

# 边界：空列表
result_empty = dedup_sort([])
check("empty_input", result_empty == [], f"expected [], got {result_empty}")

# 边界：全重复
result_dup = dedup_sort(["hello", "HELLO", "Hello", "hello"])
check("all_duplicates", result_dup == ["hello"], f"expected ['hello'], got {result_dup}")

# 边界：单元素
result_single = dedup_sort(["Zebra"])
check("single_element", result_single == ["Zebra"], f"expected ['Zebra'], got {result_single}")

print(json.dumps({"total": total, "passed": passed, "errors": errors}))
'''

# ======================================================================
# code_log_parse —— 从混合日志中提取 ERROR 行并结构化（可机验）
# ======================================================================
_LOG_PARSE_FIXTURE = """\
2024-03-15 08:00:01 INFO  Server started on port 8080
2024-03-15 08:05:22 WARN  Disk usage at 85%
2024-03-15 08:10:33 ERROR Failed to connect to database: timeout after 30s
2024-03-15 08:15:44 INFO  Request processed successfully
2024-03-15 08:20:55 ERROR NullPointerException in UserService.getProfile
2024-03-15 08:25:00 DEBUG Cache hit ratio: 0.95
2024-03-15 08:30:11 ERROR OutOfMemoryError: Java heap space
2024-03-15 08:35:22 INFO  Shutdown signal received
"""

_LOG_PARSE_HARNESS = '''\
"""code_log_parse 自动断言脚本。沙箱执行入口。"""
import json
import sys

sys.path.insert(0, ".")
from solution import parse_errors

errors = []
passed = 0
total = 0

def check(name, condition, detail=""):
    global passed, total
    total += 1
    if condition:
        passed += 1
    else:
        errors.append(f"{name}: {detail}")

LOG_TEXT = """2024-03-15 08:00:01 INFO  Server started on port 8080
2024-03-15 08:05:22 WARN  Disk usage at 85%
2024-03-15 08:10:33 ERROR Failed to connect to database: timeout after 30s
2024-03-15 08:15:44 INFO  Request processed successfully
2024-03-15 08:20:55 ERROR NullPointerException in UserService.getProfile
2024-03-15 08:25:00 DEBUG Cache hit ratio: 0.95
2024-03-15 08:30:11 ERROR OutOfMemoryError: Java heap space
2024-03-15 08:35:22 INFO  Shutdown signal received
"""

result = parse_errors(LOG_TEXT)

# 1) 返回 list
check("returns_list", isinstance(result, list), f"got {type(result).__name__}")

if isinstance(result, list):
    # 2) 恰好提取 3 条 ERROR（忽略 INFO/WARN/DEBUG）
    check("error_count", len(result) == 3, f"expected 3, got {len(result)}: {result}")

    # 3) 每条都包含 level/timestamp/message 三个键
    required_keys = {"level", "timestamp", "message"}
    for i, entry in enumerate(result):
        if isinstance(entry, dict):
            check(f"entry_{i}_has_keys", required_keys.issubset(set(entry.keys())),
                  f"missing keys: {required_keys - set(entry.keys())}")
        else:
            check(f"entry_{i}_is_dict", False, f"expected dict, got {type(entry).__name__}")

    # 4) 所有条目的 level 都是 "ERROR"
    all_error = all(isinstance(e, dict) and e.get("level") == "ERROR" for e in result)
    check("all_level_error", all_error, f"not all ERROR: {[e.get('level') if isinstance(e, dict) else type(e).__name__ for e in result]}")

    # 5) 第一条 ERROR 的时间戳正确
    if len(result) >= 1 and isinstance(result[0], dict):
        ts = result[0].get("timestamp", "")
        check("first_error_timestamp", "08:10:33" in str(ts),
              f"expected timestamp containing '08:10:33', got {ts!r}")

    # 6) 第一条 ERROR 的消息包含关键内容
    if len(result) >= 1 and isinstance(result[0], dict):
        msg = result[0].get("message", "")
        check("first_error_message", "timeout" in msg.lower(),
              f"expected 'timeout' in message, got {msg!r}")

    # 7) 第三条 ERROR 消息正确（冒号后的内容也要保留）
    if len(result) >= 3 and isinstance(result[2], dict):
        msg = result[2].get("message", "")
        check("third_error_message", "Java heap space" in msg,
              f"expected 'Java heap space', got {msg!r}")

# 边界：空输入
check("empty_input", parse_errors("") == [], f"expected [], got {parse_errors('')}")

# 边界：无 ERROR 行（用三引号避免转义问题）
no_err_text = (
    "2024-01-01 00:00:00 INFO ok" + chr(10) +
    "2024-01-01 00:00:01 WARN careful" + chr(10)
)
check("no_errors", parse_errors(no_err_text) == [], f"expected [], got {parse_errors(no_err_text)}")

print(json.dumps({"total": total, "passed": passed, "errors": errors}))
'''

# ======================================================================
# code_word_frequency —— 分词统计 Top-N（可机验）
# ======================================================================
_WORD_FREQ_FIXTURE = (
    "The quick brown python jumps over the lazy dog. "
    "The dog barked at the python, but the python was too quick. "
    "A quick brown python is always quicker than a lazy dog. "
    "Python is great. Python is simple. Python is powerful. "
    "Data science with Python is fun and practical."
)
_WORD_FREQ_STOPWORDS = {"the", "a", "an", "is", "at", "was", "but", "too", "with", "and", "or"}

_WORD_FREQ_HARNESS = '''\
"""code_word_frequency 自动断言脚本。沙箱执行入口。"""
import json
import sys

sys.path.insert(0, ".")
from solution import top_words

errors = []
passed = 0
total = 0

def check(name, condition, detail=""):
    global passed, total
    total += 1
    if condition:
        passed += 1
    else:
        errors.append(f"{name}: {detail}")

TEXT = (
    "The quick brown python jumps over the lazy dog. "
    "The dog barked at the python, but the python was too quick. "
    "A quick brown python is always quicker than a lazy dog. "
    "Python is great. Python is simple. Python is powerful. "
    "Data science with Python is fun and practical."
)

result = top_words(TEXT, 3)

# 1) 返回 list
check("returns_list", isinstance(result, list), f"got {type(result).__name__}")

if isinstance(result, list):
    # 2) Top-3 长度 = 3
    check("top3_length", len(result) == 3, f"expected 3, got {len(result)}")

    # 3) Top-1 是 "python"（出现 8 次）
    if len(result) >= 1:
        word0 = result[0] if isinstance(result[0], str) else (result[0][0] if isinstance(result[0], (list, tuple)) else None)
        check("top1_word", word0 == "python", f"expected 'python', got {word0!r}")

    # 4) Top-2 是 "quick"（出现 3 次）
    if len(result) >= 2:
        word1 = result[1] if isinstance(result[1], str) else (result[1][0] if isinstance(result[1], (list, tuple)) else None)
        check("top2_word", word1 == "quick", f"expected 'quick', got {word1!r}")

    # 5) Top-3 是 "dog"（出现 3 次）
    if len(result) >= 3:
        word2 = result[2] if isinstance(result[2], str) else (result[2][0] if isinstance(result[2], (list, tuple)) else None)
        check("top3_word", word2 == "dog", f"expected 'dog', got {word2!r}")

    # 6) 所有词都是小写
    all_lower = True
    for item in result:
        w = item if isinstance(item, str) else (item[0] if isinstance(item, (list, tuple)) and len(item) > 0 else "")
        if w != w.lower():
            all_lower = False
            break
    check("all_lowercase", all_lower, f"not all lowercase: {result}")

    # 7) 不含停用词（the/a/is 等不应出现）
    stopwords = {"the", "a", "an", "is", "at", "was", "but", "too", "with", "and", "or"}
    result_words = set()
    for item in result:
        w = item if isinstance(item, str) else (item[0] if isinstance(item, (list, tuple)) and len(item) > 0 else "")
        result_words.add(w)
    check("no_stopwords", len(result_words & stopwords) == 0,
          f"stopwords found: {result_words & stopwords}")

# 边界：空字符串
check("empty_text", top_words("", 3) == [], f"expected [], got {top_words('', 3)}")

# 边界：只有停用词
check("only_stopwords", top_words("the a an is at was but", 3) == [],
      f"expected [], got {top_words('the a an is at was but', 3)}")

# 边界：n 大于实际词数
check("n_exceeds", len(top_words("hello world", 10)) == 2,
      f"expected 2, got {len(top_words('hello world', 10))}")

print(json.dumps({"total": total, "passed": passed, "errors": errors}))
'''

# ======================================================================
# code_set_operations —— 两列表的差集与交集（可机验）
# ======================================================================
_SET_OPS_LIST_A = ["apple", "banana", "cherry", "date", "elderberry", "fig", "grape"]
_SET_OPS_LIST_B = ["banana", "date", "fig", "grape", "honeydew", "kiwi"]

_SET_OPS_HARNESS = '''\
"""code_set_operations 自动断言脚本。沙箱执行入口。"""
import json
import sys

sys.path.insert(0, ".")
from solution import diff_and_intersect

errors = []
passed = 0
total = 0

def check(name, condition, detail=""):
    global passed, total
    total += 1
    if condition:
        passed += 1
    else:
        errors.append(f"{name}: {detail}")

list_a = ["apple", "banana", "cherry", "date", "elderberry", "fig", "grape"]
list_b = ["banana", "date", "fig", "grape", "honeydew", "kiwi"]

result = diff_and_intersect(list_a, list_b)

# 1) 返回 dict
check("returns_dict", isinstance(result, dict), f"got {type(result).__name__}")

if isinstance(result, dict):
    # 2) 含 only_a / only_b / both 三个键
    required_keys = {"only_a", "only_b", "both"}
    check("has_required_keys", required_keys.issubset(set(result.keys())),
          f"missing keys: {required_keys - set(result.keys())}")

    only_a = set(result.get("only_a", []))
    only_b = set(result.get("only_b", []))
    both = set(result.get("both", []))

    # 3) only_a = {apple, cherry, elderberry}
    expected_only_a = {"apple", "cherry", "elderberry"}
    check("only_a_correct", only_a == expected_only_a,
          f"expected {expected_only_a}, got {only_a}")

    # 4) only_b = {honeydew, kiwi}
    expected_only_b = {"honeydew", "kiwi"}
    check("only_b_correct", only_b == expected_only_b,
          f"expected {expected_only_b}, got {only_b}")

    # 5) both = {banana, date, fig, grape}
    expected_both = {"banana", "date", "fig", "grape"}
    check("both_correct", both == expected_both,
          f"expected {expected_both}, got {both}")

    # 6) 三者不相交且覆盖全集
    all_items = set(list_a) | set(list_b)
    partitioned = only_a | only_b | both
    check("partition_complete", partitioned == all_items,
          f"partition {partitioned} != full set {all_items}")
    check("partition_disjoint", len(only_a & only_b) == 0 and len(only_a & both) == 0 and len(only_b & both) == 0,
          "partition sets overlap")

# 边界：两个空列表
r_empty = diff_and_intersect([], [])
check("empty_both", isinstance(r_empty, dict) and set(r_empty.get("only_a", [])) == set() and set(r_empty.get("both", [])) == set(),
      f"expected empty sets, got {r_empty}")

# 边界：a 为空
r_a_empty = diff_and_intersect([], ["x", "y"])
check("a_empty", set(r_a_empty.get("only_b", [])) == {"x", "y"} and set(r_a_empty.get("only_a", [])) == set(),
      f"got {r_a_empty}")

# 边界：完全不相交
r_disjoint = diff_and_intersect(["a", "b"], ["c", "d"])
check("disjoint", set(r_disjoint.get("only_a", [])) == {"a", "b"} and set(r_disjoint.get("only_b", [])) == {"c", "d"} and set(r_disjoint.get("both", [])) == set(),
      f"got {r_disjoint}")

print(json.dumps({"total": total, "passed": passed, "errors": errors}))
'''

# ======================================================================
# code_regex_extract —— 正则提取邮箱/URL/日期（可机验）
# ======================================================================
_REGEX_EXTRACT_HARNESS = '''\
"""code_regex_extract 自动断言脚本。沙箱执行入口。"""
import json
import sys

sys.path.insert(0, ".")
from solution import extract_entities

errors = []
passed = 0
total = 0

def check(name, condition, detail=""):
    global passed, total
    total += 1
    if condition:
        passed += 1
    else:
        errors.append(f"{name}: {detail}")

TEXT = (
    "联系我们：support@example.com 或 admin@test.org\\n"
    "访问 https://www.example.com/page?q=1 和 http://docs.test.org/v2/api\\n"
    "创建于 2024-01-15，更新于 2024-03-22T10:30:00\\n"
    "无效邮箱：user@（不完整）\\n"
    "无效 URL：htp://broken（协议错误）\\n"
)

result = extract_entities(TEXT)

# 1) 返回 dict
check("returns_dict", isinstance(result, dict), f"got {type(result).__name__}")

# 2) 提取到 2 个有效邮箱
emails = result.get("emails", [])
check("email_count", len(emails) == 2, f"expected 2, got {len(emails)}: {emails}")
email_set = set(emails)
check("email_support", "support@example.com" in email_set, f"missing support@example.com: {email_set}")
check("email_admin", "admin@test.org" in email_set, f"missing admin@test.org: {email_set}")

# 3) 提取到 2 个有效 URL（htp://broken 不应被提取）
urls = result.get("urls", [])
check("url_count", len(urls) == 2, f"expected 2, got {len(urls)}: {urls}")
url_set = set(urls)
check("url_https", any("https://www.example.com" in u for u in url_set), f"missing https URL: {url_set}")
check("url_http", any("http://docs.test.org" in u for u in url_set), f"missing http URL: {url_set}")

# 4) 提取到 2 个日期（2024-01-15 和 2024-03-22）
dates = result.get("dates", [])
check("date_count", len(dates) == 2, f"expected 2, got {len(dates)}: {dates}")
date_str = " ".join(str(d) for d in dates)
check("date_jan", "2024-01-15" in date_str, f"missing 2024-01-15: {date_str}")
check("date_mar", "2024-03-22" in date_str, f"missing 2024-03-22: {date_str}")

# 5) 不包含无效邮箱和 URL
all_values = " ".join(str(v) for v in emails + urls + dates)
check("no_invalid_email", "user@" not in all_values, "无效邮箱被误提取")
check("no_invalid_url", "htp://" not in all_values, "无效 URL 被误提取")

# 边界：空文本
check("empty_text", isinstance(extract_entities(""), dict), "空文本应返回 dict")
r_empty = extract_entities("")
check("empty_emails", len(r_empty.get("emails", [])) == 0, f"expected [], got {r_empty}")

print(json.dumps({"total": total, "passed": passed, "errors": errors}))
'''

# ======================================================================
# code_data_validate —— 数据校验（可机验）
# ======================================================================
_DATA_VALIDATE_HARNESS = '''\
"""code_data_validate 自动断言脚本。沙箱执行入口。"""
import json
import sys

sys.path.insert(0, ".")
from solution import validate_record

errors = []
passed = 0
total = 0

def check(name, condition, detail=""):
    global passed, total
    total += 1
    if condition:
        passed += 1
    else:
        errors.append(f"{name}: {detail}")

# 1) 有效记录 → 无错误
r1 = validate_record({"name": "张三", "email": "zhangsan@example.com", "age": 25, "url": "https://example.com"})
check("valid_record_no_errors", isinstance(r1, dict) and len(r1) == 0,
      f"expected empty dict for valid record, got {r1}")

# 2) 空名称 → 报错
r2 = validate_record({"name": "", "email": "lisi@test.org", "age": 30, "url": "https://test.org"})
check("empty_name_error", isinstance(r2, dict) and "name" in r2,
      f"expected error for empty name, got {r2}")

# 3) 无效邮箱 → 报错
r3 = validate_record({"name": "test", "email": "no-at-sign", "age": 20, "url": "https://a.com"})
check("invalid_email_error", isinstance(r3, dict) and "email" in r3,
      f"expected error for invalid email, got {r3}")

# 4) 负数年龄 → 报错
r4 = validate_record({"name": "test", "email": "a@b.com", "age": -1, "url": "https://a.com"})
check("negative_age_error", isinstance(r4, dict) and "age" in r4,
      f"expected error for negative age, got {r4}")

# 5) 超大年龄 → 报错
r5 = validate_record({"name": "test", "email": "a@b.com", "age": 200, "url": "https://a.com"})
check("extreme_age_error", isinstance(r5, dict) and "age" in r5,
      f"expected error for age > 150, got {r5}")

# 6) 无效 URL（无协议）→ 报错
r6 = validate_record({"name": "test", "email": "a@b.com", "age": 20, "url": "no-protocol"})
check("invalid_url_error", isinstance(r6, dict) and "url" in r6,
      f"expected error for invalid url, got {r6}")

# 7) 多条错误同时检出
r7 = validate_record({"name": "", "email": "bad", "age": -1, "url": "bad"})
check("multi_error_count", isinstance(r7, dict) and len(r7) >= 3,
      f"expected >= 3 errors, got {len(r7) if isinstance(r7, dict) else type(r7)}: {r7}")

# 8) 缺少字段不算错误（只校验存在的字段）
r8 = validate_record({"name": "test"})
check("missing_fields_ok", isinstance(r8, dict) and len(r8) == 0,
      f"expected no errors for record with only name, got {r8}")

# 9) 年龄边界：0 合法，150 合法
r9 = validate_record({"name": "test", "email": "a@b.com", "age": 0, "url": "https://a.com"})
check("age_zero_ok", "age" not in r9, f"age=0 should be valid, got {r9}")
r10 = validate_record({"name": "test", "email": "a@b.com", "age": 150, "url": "https://a.com"})
check("age_150_ok", "age" not in r10, f"age=150 should be valid, got {r10}")

print(json.dumps({"total": total, "passed": passed, "errors": errors}))
'''

# ======================================================================
# code_config_merge —— 多层配置合并（可机验）
# ======================================================================
_CONFIG_MERGE_HARNESS = '''\
"""code_config_merge 自动断言脚本。沙箱执行入口。"""
import json
import sys

sys.path.insert(0, ".")
from solution import deep_merge

errors = []
passed = 0
total = 0

def check(name, condition, detail=""):
    global passed, total
    total += 1
    if condition:
        passed += 1
    else:
        errors.append(f"{name}: {detail}")

# 1) 基本合并：两层浅键
base = {"host": "localhost", "port": 8080}
override = {"port": 9090, "debug": True}
result = deep_merge(base, override)
check("basic_merge", result == {"host": "localhost", "port": 9090, "debug": True},
      f"got {result}")

# 2) 原字典不被修改（不可变性）
base2 = {"a": 1}
deep_merge(base2, {"b": 2})
check("immutability", base2 == {"a": 1}, f"base mutated: {base2}")

# 3) 深合并：嵌套 dict 递归合并而非覆盖
base3 = {"db": {"host": "localhost", "port": 5432, "pool": 10}}
override3 = {"db": {"port": 6432, "ssl": True}}
r3 = deep_merge(base3, override3)
expected3 = {"db": {"host": "localhost", "port": 6432, "pool": 10, "ssl": True}}
check("deep_merge", r3 == expected3, f"expected {expected3}, got {r3}")

# 4) 列表不是深合并——后者覆盖前者
base4 = {"tags": ["a", "b"]}
override4 = {"tags": ["c"]}
r4 = deep_merge(base4, override4)
check("list_override", r4 == {"tags": ["c"]}, f"expected list override, got {r4}")

# 5) None 值覆盖非 None 值
base5 = {"val": "original"}
override5 = {"val": None}
r5 = deep_merge(base5, override5)
check("none_override", r5 == {"val": None}, f"expected None override, got {r5}")

# 6) 多层嵌套（3 层）
base6 = {"a": {"b": {"c": 1, "d": 2}}}
override6 = {"a": {"b": {"d": 3, "e": 4}}}
r6 = deep_merge(base6, override6)
expected6 = {"a": {"b": {"c": 1, "d": 3, "e": 4}}}
check("triple_nest", r6 == expected6, f"expected {expected6}, got {r6}")

# 7) 空 dict 合并
r7 = deep_merge({}, {"x": 1})
check("empty_base", r7 == {"x": 1}, f"got {r7}")
r8 = deep_merge({"x": 1}, {})
check("empty_override", r8 == {"x": 1}, f"got {r8}")

# 8) 类型不匹配：base 是 dict，override 是 str → override 胜出
r9 = deep_merge({"a": {"nested": True}}, {"a": "flat"})
check("type_conflict", r9 == {"a": "flat"}, f"expected override wins on type conflict, got {r9}")

print(json.dumps({"total": total, "passed": passed, "errors": errors}))
'''

# ======================================================================
# 注册表：task_id → SandboxSpec
# ======================================================================
_SANDBOX_SPECS: Dict[str, SandboxSpec] = {
    "code_csv_merge": SandboxSpec(
        task_id="code_csv_merge",
        fixture_files={
            "fixture_a.csv": _CSV_MERGE_FIXTURE_A,
            "fixture_b.csv": _CSV_MERGE_FIXTURE_B,
        },
        test_harness=_CSV_MERGE_TEST_HARNESS,
        machine_verifiable_dims=["code_runnability"],
    ),
    "code_json_transform": SandboxSpec(
        task_id="code_json_transform",
        test_harness=_JSON_TRANSFORM_HARNESS,
        machine_verifiable_dims=["code_runnability", "code_test_coverage"],
    ),
    "code_list_dedup_sort": SandboxSpec(
        task_id="code_list_dedup_sort",
        test_harness=_LIST_DEDUP_SORT_HARNESS,
        machine_verifiable_dims=["code_runnability", "code_test_coverage"],
    ),
    "code_log_parse": SandboxSpec(
        task_id="code_log_parse",
        test_harness=_LOG_PARSE_HARNESS,
        machine_verifiable_dims=["code_runnability", "code_test_coverage"],
    ),
    "code_word_frequency": SandboxSpec(
        task_id="code_word_frequency",
        test_harness=_WORD_FREQ_HARNESS,
        machine_verifiable_dims=["code_runnability", "code_test_coverage"],
    ),
    "code_set_operations": SandboxSpec(
        task_id="code_set_operations",
        test_harness=_SET_OPS_HARNESS,
        machine_verifiable_dims=["code_runnability", "code_test_coverage"],
    ),
    "code_regex_extract": SandboxSpec(
        task_id="code_regex_extract",
        test_harness=_REGEX_EXTRACT_HARNESS,
        machine_verifiable_dims=["code_runnability", "code_maintainability"],
    ),
    "code_data_validate": SandboxSpec(
        task_id="code_data_validate",
        test_harness=_DATA_VALIDATE_HARNESS,
        machine_verifiable_dims=["code_runnability", "code_security"],
    ),
    "code_config_merge": SandboxSpec(
        task_id="code_config_merge",
        test_harness=_CONFIG_MERGE_HARNESS,
        machine_verifiable_dims=["code_runnability", "code_maintainability"],
    ),
}


def get_sandbox_spec(task_id: str) -> SandboxSpec:
    """取一道题的沙箱规格。未知题目返回空规格（不可机验）。"""
    return _SANDBOX_SPECS.get(task_id, SandboxSpec(task_id=task_id))


def is_machine_verifiable(task_id: str) -> bool:
    """该题是否有沙箱可验规格。"""
    return task_id in _SANDBOX_SPECS


def all_verifiable_task_ids() -> List[str]:
    """所有可机验的题目 id。"""
    return list(_SANDBOX_SPECS.keys())
