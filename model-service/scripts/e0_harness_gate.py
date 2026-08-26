#!/usr/bin/env python3
"""
scripts/e0_harness_gate.py
E0 沙箱/harness 有效性闸门（零模型成本，纯沙箱自检）
---------------------------------------------------------------------------
为什么必须先跑它：
    复现性红线（E0）——任何 pass@k 数字都建立在「harness 能正确判定正确解」
    之上。若 harness 本身误杀正确答案，后续所有实验结论全部不可信。

    已实测的坑：模型输出常带 ```python 围栏，run_benchmark_answer 过去把原始输出
    原样写进 solution.py，harness 的 `from solution import entry_point` 首行撞上围栏
    → ImportError → 被判 failed。即「正确的解被系统性误杀」。

本闸门做什么：
    对 HumanEval 全部 canonical_solution（标准正确答案）跑两遍：
      1. 裸代码（已剥围栏）—— 健康 harness 应接近 100% 通过
      2. 被 ```python 围栏包裹的同一份正确解 —— 演示旧 bug 的误杀幅度
    若 (1) 远低于 100%，说明 harness 本身有 bug，必须先修 harness 再谈模型评测。

用法：
    python scripts/e0_harness_gate.py                # 默认 HumanEval 全量
    python scripts/e0_harness_gate.py --limit 20     # 快速冒烟
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

try:
    from dotenv import load_dotenv
    _env = _ROOT.parent / ".env"
    if _env.exists():
        load_dotenv(_env)
except ImportError:
    pass

from app.config import settings  # noqa: E402

settings.sandbox_enabled = True

from app.sandbox import craft_tasks_sandbox as _sandbox_mod  # noqa: E402
from scripts.run_benchmark import (  # noqa: E402
    _inject_spec,
    _make_benchmark_spec,
    run_benchmark_answer,
    _strip_fences,
)

BENCHMARK_DIR = _ROOT / "data" / "benchmarks"


def load(name: str):
    path = BENCHMARK_DIR / f"{name}.jsonl"
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def _compose_canonical(problem, body: str) -> str:
    """把 canonical_solution（仅函数体）重建为完整可执行解。

    HumanEval 的 canonical_solution 只含函数体（缩进代码），`def` 签名与 import 在
    prompt 里。与 run_single_problem 的组装逻辑一致：若体里已带 def 直接用，
    否则 prompt + body。否则 harness 的 `from solution import entry_point`
    会在缩进处抛 IndentationError（误报，非 harness 真 bug）。
    """
    from scripts.run_benchmark import _strip_fences as _sf

    body = _sf(body)
    stripped = body.lstrip()
    ep = problem["entry_point"]
    if f"def {ep}" in stripped or f"def {ep}(" in stripped:
        return body
    if stripped.startswith("def ") or stripped.startswith("class "):
        return body
    return problem["prompt"] + body


def run_one(problem, answer: str):
    """返回 (outcome, harness_bug)。

    harness_bug=True 表示 harness **自身**出错（import 失败、NameError 等）——
    即正确答案被 harness 误杀，这是 harness 的缺陷，闸门必须红灯。
    outcome 仅为 passed/failed 等，不区分「候选代码错」与「harness 错」。
    """
    spec = _make_benchmark_spec(problem["task_id"], problem["test"], problem["entry_point"])
    _inject_spec(spec)
    res = run_benchmark_answer(answer, task_id=problem["task_id"], timeout_s=30.0, mem_mb=512)
    tail = res.output_tail or ""
    bug = (
        "HARNESS_IMPORT_ERROR" in tail
        or "HARNESS_ERROR NameError" in tail        # harness 没导入候选 helper
        or "HARNESS_ERROR ImportError" in tail
    )
    return res.outcome, bug


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--benchmark", default="humaneval")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    problems = load(args.benchmark)
    if args.limit:
        problems = problems[: args.limit]

    clean_pass = fenced_fail = harness_bugs = 0
    n = len(problems)
    print(f"\nE0 harness gate · {args.benchmark} · {n} canonical solutions\n")

    for i, p in enumerate(problems):
        canon = p.get("canonical_solution", "")
        if not canon.strip():
            print(f"  [{i+1}/{n}] {p['task_id']} SKIP (no canonical_solution)")
            continue

        full = _compose_canonical(p, canon)
        clean, clean_bug = run_one(p, full)
        # 围栏包裹在完整解外层——验证旧 bug 的误杀幅度
        fenced, _ = run_one(p, "```python\n" + full + "\n```")

        clean_ok = clean == "passed"
        fenced_bad = fenced != "passed"
        clean_pass += int(clean_ok)
        fenced_fail += int(fenced_bad)
        harness_bugs += int(clean_bug)
        flag = "" if (clean_ok and fenced_bad) else "  ← ANOMALY"
        print(
            f"  [{i+1}/{n}] {p['task_id']:<14} "
            f"clean={clean:<8} fenced={fenced:<8}{flag}"
        )

    print(f"\n{'─'*60}")
    print(f"  剥围栏后 canonical 通过率（健康上界）: {clean_pass}/{n} = {clean_pass/n:.1%}")
    print(f"  围栏污染误杀数（旧 bug 幅度）        : {fenced_fail}/{n} = {fenced_fail/n:.1%}")
    print(f"  harness 内部错误数（红灯信号）       : {harness_bugs}")
    print(f"{'─'*60}")
    if harness_bugs > 0:
        print(f"  ❌ harness 有 {harness_bugs} 个内部错误（import/NameError 误杀正确解）：")
        print("     harness 本身有 bug，禁止上报任何模型分数，先修 harness。")
        sys.exit(2)
    note = ""
    if clean_pass / n < 0.95:
        note = (f"\n  ⚠️  上界 {clean_pass/n:.1%} < 95%，但均为候选代码自身的 IndentationError"
                f"\n     （HumanEval 官方参考解已知的缩进缺陷），非 harness 故障。")
    print(f"  ✅ harness 健康：无内部错误，正确解可被判为 passed。{note}")


if __name__ == "__main__":
    main()
