#!/usr/bin/env python3
"""
Benchmark Experiment Runner — Code Generation Evaluation Pipeline.

Runs models against official benchmarks (HumanEval, MBPP) through AgentCorp's
existing sandbox pipeline, collecting:
  1. Pass@k metrics (machine-verified via sandbox execution)
  2. Per-problem structured results (model output, test outcome, latency)
  3. StyleMemory integration (Designer reflection + adaptive challenge evolution)
  4. Cross-model comparison data (for paper Table 2 / Figure 3)

Usage:
  # Run single model on HumanEval (10 problems for quick test)
  python scripts/run_benchmark.py --benchmark humaneval --model deepseek-chat --limit 10

  # Run 3 trials per problem with seed control
  python scripts/run_benchmark.py --benchmark humaneval --model deepseek-chat --trials 3

  # Full run (all 164 HumanEval problems × 3 trials)
  python scripts/run_benchmark.py --benchmark humaneval --model deepseek-chat --trials 3

  # Multiple models (comma-separated)
  python scripts/run_benchmark.py --benchmark humaneval --models deepseek-chat,gpt-4o,claude-sonnet-4-20250514

Environment:
  JUDGE_BACKEND=http
  JUDGE_BASE_URL=https://api.deepseek.com/v1   # or any OpenAI-compatible endpoint
  JUDGE_API_KEY=sk-...
  JUDGE_MODEL=deepseek-chat
  SANDBOX_ENABLED=true
  TEMPERATURE=0.0

Output:
  data/experiments/{benchmark}_{model}_{timestamp}.jsonl  — per-problem results
  data/experiments/{benchmark}_{model}_{timestamp}_summary.json  — aggregate stats
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# ── Ensure model-service is on sys.path ──────────────────────────────────
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

# ── Load .env from project root ──────────────────────────────────────────
try:
    from dotenv import load_dotenv
    _env_path = _ROOT.parent / ".env"
    if _env_path.exists():
        load_dotenv(_env_path)
        logger_pre = logging.getLogger("benchmark")
        logger_pre.info("Loaded .env from %s", _env_path)
except ImportError:
    pass

from app.config import settings  # noqa: E402
from app.judge_backend import get_backend, JudgeUnavailable  # noqa: E402
from app.sandbox.runner import SandboxResult, extract_python_blocks  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("benchmark")


# ── Paths ─────────────────────────────────────────────────────────────────
BENCHMARK_DIR = _ROOT / "data" / "benchmarks"
EXPERIMENT_DIR = _ROOT / "data" / "experiments"


def _strip_fences(text: str) -> str:
    """剥掉模型输出上的 markdown 代码围栏，只保留 Python 代码本身。

    复现性闸门（E0）确认的坑：glm-4-flash 等模型即使被 system prompt 明确要求
    「不要输出围栏」，仍经常用 ```python ... ``` 包裹答案。run_benchmark_answer 会把
    原始输出原样写进 solution.py，而 _make_benchmark_spec 的 harness 执行
    `from solution import entry_point`——首行是围栏就直接 ImportError，被判 failed，
    系统性压低 pass@k（正确的解被误杀）。

    复用 extract_python_blocks：优先取 ``` 围栏块；围栏不在时若整段像代码就整体保留。
    多块（少见）用空行拼接，保证 import/def 结构完整。
    """
    blocks = extract_python_blocks(text or "")
    return "\n\n".join(blocks) if blocks else (text or "")


# ══════════════════════════════════════════════════════════════════════════
# 1. Load benchmark problems
# ══════════════════════════════════════════════════════════════════════════

def load_benchmark(name: str) -> List[Dict[str, Any]]:
    """Load benchmark JSONL file. Returns list of problem dicts."""
    path = BENCHMARK_DIR / f"{name}.jsonl"
    if not path.exists():
        raise FileNotFoundError(
            f"Benchmark file not found: {path}\n"
            f"Run 'python scripts/download_benchmarks.py' first."
        )
    problems = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                problems.append(json.loads(line))
    return problems


# ══════════════════════════════════════════════════════════════════════════
# 2. Sandbox execution for benchmark problems
# ══════════════════════════════════════════════════════════════════════════

def _make_benchmark_spec(task_id: str, test_code: str, entry_point: str):
    """Create a SandboxSpec for a benchmark problem.

    Design:
    1. Import the candidate's entry_point from solution.py
    2. Run the benchmark's test code directly (indented into a try block)
    3. If the test code raises any exception → FAIL; if it completes → PASS

    HumanEval test code defines `check(candidate)` and calls `check(entry_point)`.
    MBPP test code has direct `assert` statements.
    Both work by being executed directly — the test code's own assertions
    determine pass/fail via Python's normal exception mechanism.
    """
    from app.sandbox.craft_tasks_sandbox import SandboxSpec

    # Indent test code for the try block (4 spaces per line)
    indented_test = "\n".join(
        "    " + line if line.strip() else line
        for line in test_code.split("\n")
    )

    harness = (
        '"""Benchmark test harness for ' + task_id + '. Auto-generated."""\n'
        'import sys\n'
        'import os\n'
        'import traceback\n'
        '\n'
        '# -I mode strips cwd from sys.path — restore it (sandbox sets cwd=workdir)\n'
        'sys.path.insert(0, os.getcwd())\n'
        '\n'
        '# Step 1: Import the candidate solution as a module, then expose ALL its\n'
        '# public names into this harness namespace.\n'
        '#\n'
        '# 为什么不能只 `from solution import {entry_point}`：HumanEval 的 test 经常\n'
        '# 直接调用 solution 里除 entry_point 之外的辅助函数（如 HumanEval/32 的 test\n'
        '# 调用 poly），这些名字只存在于 solution 模块。若只导入单个入口函数，test 里\n'
        '# 对辅助函数的裸名调用会 NameError → 正确的解被误判 failed。把 solution 的\n'
        '# 全部公开名注入 harness globals，test 的裸名解析才能命中。\n'
        'try:\n'
        '    import solution as _solution_module\n'
        '    for _n in dir(_solution_module):\n'
        '        if not _n.startswith(\"_\"):\n'
        '            globals()[_n] = getattr(_solution_module, _n)\n'
        'except ImportError as exc:\n'
        '    print("HARNESS_IMPORT_ERROR " + type(exc).__name__)\n'
        '    print("HARNESS_DONE total=0 failed=1")\n'
        '    sys.exit(3)\n'
        '\n'
        '# Step 2: Execute the benchmark test code.\n'
        '# HumanEval: defines check() then we call check(entry_point).\n'
        '# MBPP: direct assert statements (no check function).\n'
        'try:\n'
        f'{indented_test}\n'
        '\n'
        '    # HumanEval tests define check() but do not call it —\n'
        '    # we call it here with the imported entry_point.\n'
        f'    if "check" in dir():\n'
        f'        check({entry_point})\n'
        'except AssertionError as exc:\n'
        '    print(f"HARNESS_ASSERTION_ERROR: {exc}")\n'
        '    print("HARNESS_DONE total=1 failed=1")\n'
        '    sys.exit(1)\n'
        'except Exception as exc:\n'
        '    print(f"HARNESS_ERROR {type(exc).__name__}: {exc}")\n'
        '    print("HARNESS_DONE total=1 failed=1")\n'
        '    sys.exit(1)\n'
        '\n'
        '# Step 3: All tests passed (no exception raised)\n'
        'print("HARNESS_DONE total=1 failed=0")\n'
        'sys.exit(0)\n'
    )

    return SandboxSpec(
        task_id=task_id,
        fixture_files={},
        test_harness=harness,
        machine_verifiable_dims=["code_runnability"],
    )


def run_single_problem(
    problem: Dict[str, Any],
    model_name: str,
    trial: int,
    temperature: float,
) -> Dict[str, Any]:
    """Run a single benchmark problem through the full pipeline.

    Returns a structured result dict with model output, sandbox result, timing.
    """
    task_id = problem["task_id"]
    prompt = problem["prompt"]
    entry_point = problem["entry_point"]
    test_code = problem["test"]

    # ── 1. Get model completion ─────────────────────────────────────────
    backend = get_backend()
    messages = [
        {
            "role": "system",
            "content": (
                "You are an expert Python programmer. Complete the function below. "
                "Output ONLY the completed function code (no explanations, no markdown fences). "
                "Start directly with the function definition."
            ),
        },
        {
            "role": "user",
            "content": f"Complete this Python function:\n\n```python\n{prompt}\n```",
        },
    ]

    started = time.perf_counter()
    try:
        completion = backend.complete(
            messages,
            temperature=temperature,
            max_tokens=1024,
            model=model_name,
        )
        model_output = completion.text
        latency_ms = completion.latency_ms
    except JudgeUnavailable as exc:
        return {
            "task_id": task_id,
            "model": model_name,
            "trial": trial,
            "status": "model_error",
            "error": str(exc),
            "passed": False,
            "latency_ms": 0,
        }

    # ── 2. Build answer for sandbox ─────────────────────────────────────
    # 先剥围栏（E0 复现性闸门）：写进 solution.py 的绝不能含 ``` 代码围栏，
    # 否则 harness 的 `from solution import entry_point` 会 ImportError 误判 failed。
    model_output = _strip_fences(model_output)
    # The model is instructed to output the complete function.
    # If it only outputs the body (no def line), prepend the prompt.
    stripped = model_output.lstrip()
    if f"def {entry_point}" in stripped or f"def {entry_point}(" in stripped:
        # Model output already contains the function definition — use directly
        full_answer = model_output
    elif stripped.startswith("def ") or stripped.startswith("class "):
        # Model output is a complete function/module — use directly
        full_answer = model_output
    else:
        # Model output is just the function body — prepend prompt for the def line
        full_answer = prompt + model_output

    # ── 3. Run through sandbox ──────────────────────────────────────────
    # Enable sandbox for this execution
    original_sandbox = settings.sandbox_enabled
    settings.sandbox_enabled = True

    try:
        from app.sandbox import runner as sandbox_runner

        # Temporarily register this problem's spec
        spec = _make_benchmark_spec(task_id, test_code, entry_point)
        # Inject into the spec registry
        _inject_spec(spec)

        # Use run_benchmark_answer which writes solution.py directly
        # (bypasses extract_python_blocks which fails on indented-only code)
        result: SandboxResult = run_benchmark_answer(
            full_answer,
            task_id=task_id,
            timeout_s=30.0,
            mem_mb=512,
        )
    except Exception as exc:
        result = SandboxResult(
            outcome="error",
            reason=f"sandbox_exception: {exc}",
        )
    finally:
        settings.sandbox_enabled = original_sandbox

    elapsed_ms = (time.perf_counter() - started) * 1000.0

    # ── 4. Extract code preview for logging ─────────────────────────────
    extracted_code = full_answer[:500]

    return {
        "task_id": task_id,
        "model": model_name,
        "trial": trial,
        "temperature": temperature,
        "status": "completed",
        "passed": result.outcome == "passed",
        "outcome": result.outcome,
        "total_tests": result.total,
        "passed_tests": result.passed,
        "failed_tests": result.failed,
        "latency_ms": round(elapsed_ms, 1),
        "model_latency_ms": round(latency_ms, 1) if latency_ms else None,
        "code_bytes": result.code_bytes,
        "model_output_tokens": completion.usage.get("completion_tokens") if completion.usage else None,
        "prompt_tokens": completion.usage.get("prompt_tokens") if completion.usage else None,
        "evidence": result.evidence_text(),
        "code_preview": extracted_code[:500],
    }


# ══════════════════════════════════════════════════════════════════════════
# 3. Spec injection (avoid modifying the main spec registry permanently)
# ══════════════════════════════════════════════════════════════════════════

_injected_specs: Dict[str, Any] = {}

def _inject_spec(spec) -> None:
    """Temporarily inject a SandboxSpec for benchmark problems."""
    _injected_specs[spec.task_id] = spec


def _get_sandbox_spec_patched(task_id: str):
    """Patched version of get_sandbox_spec that checks injected specs first."""
    from app.sandbox.craft_tasks_sandbox import SandboxSpec, _SANDBOX_SPECS
    if task_id in _injected_specs:
        return _injected_specs[task_id]
    return _SANDBOX_SPECS.get(task_id)


# Monkey-patch for benchmark runs
from app.sandbox import craft_tasks_sandbox as _sandbox_mod
_original_get_sandbox_spec = _sandbox_mod.get_sandbox_spec


def _patched_get_sandbox_spec(task_id: str):
    if task_id in _injected_specs:
        return _injected_specs[task_id]
    return _original_get_sandbox_spec(task_id)


_sandbox_mod.get_sandbox_spec = _patched_get_sandbox_spec


def run_benchmark_answer(
    answer: str,
    *,
    task_id: str,
    timeout_s: float = 30.0,
    mem_mb: int = 512,
) -> "SandboxResult":
    """Run benchmark code through the sandbox.

    Unlike run_python_answer, this does NOT extract code blocks from the answer.
    Instead it writes the answer directly as solution.py — because benchmark
    completions are often just function bodies (indented code, no `def` line),
    which extract_python_blocks can't detect.

    The SandboxSpec (injected via _make_benchmark_spec) provides the test harness
    that imports from solution and runs the benchmark's assertions.
    """
    import os
    import sys
    import tempfile
    import time

    from app.sandbox.runner import (
        SandboxResult,
        _compose_harness,
        _sandbox_env,
        _spawn_and_wait,
        _preexec_limits,
        _decode,
        _is_oom,
    )

    if not settings.sandbox_enabled:
        return SandboxResult(
            outcome="disabled",
            reason="沙盒未启用（设置 SANDBOX_ENABLED=true 开启真实执行验证）",
        )

    spec = _patched_get_sandbox_spec(task_id)
    if not spec or not spec.test_harness:
        return SandboxResult(
            outcome="error",
            reason=f"未找到 {task_id} 的 SandboxSpec",
        )

    code_bytes = len(answer.encode("utf-8"))
    workdir = tempfile.mkdtemp(prefix="agentcorp-bench-")

    try:
        # Write solution.py directly — no extraction needed
        with open(os.path.join(workdir, "solution.py"), "w", encoding="utf-8") as fh:
            fh.write(answer)

        # Write any fixture files
        for fname, content in spec.fixture_files.items():
            with open(os.path.join(workdir, fname), "w", encoding="utf-8") as fh:
                fh.write(content)

        # Write and run the test harness
        harness_src = _compose_harness(spec.test_harness)
        harness_path = os.path.join(workdir, "_test_harness.py")
        with open(harness_path, "w", encoding="utf-8") as fh:
            fh.write(harness_src)

        started = time.perf_counter()
        spawn = _spawn_and_wait(
            [sys.executable, "-I", "-B", harness_path],
            cwd=workdir,
            env=_sandbox_env(),
            timeout=timeout_s,
            memory=mem_mb,
            preexec=_preexec_limits(int(timeout_s) + 1, mem_mb),
        )
        duration_ms = (time.perf_counter() - started) * 1000.0

        if spawn.timed_out:
            return SandboxResult(
                outcome="failed",
                total=1,
                passed=0,
                failed=1,
                duration_ms=timeout_s * 1000.0,
                cases=[("<timeout>", False, f"执行超过 {timeout_s:.0f}s")],
                reason="timeout",
                output_capped=spawn.output_capped,
                code_bytes=code_bytes,
            )

        combined = _decode(spawn.stdout) + "\n" + _decode(spawn.stderr)

        # OOM detection
        if _is_oom(spawn.returncode, "", combined):
            return SandboxResult(
                outcome="oom",
                duration_ms=duration_ms,
                output_tail=combined.strip()[-1200:],
                reason="memory limit exceeded",
                code_bytes=code_bytes,
            )

        # Parse HARNESS_DONE / CASE_PASS / CASE_FAIL from output
        total = 0
        passed = 0
        cases = []
        for line in combined.split("\n"):
            line = line.strip()
            if line.startswith("HARNESS_DONE"):
                # Parse: HARNESS_DONE total=N failed=M
                parts = line.split()
                for part in parts:
                    if part.startswith("total="):
                        total = int(part.split("=")[1])
                    elif part.startswith("failed="):
                        failed_count = int(part.split("=")[1])
                        passed = total - failed_count
            elif line.startswith("CASE_PASS "):
                name = line[len("CASE_PASS "):]
                cases.append((name, True, ""))
            elif line.startswith("CASE_FAIL "):
                rest = line[len("CASE_FAIL "):]
                if " :: " in rest:
                    name, detail = rest.split(" :: ", 1)
                else:
                    name, detail = rest, ""
                cases.append((name, False, detail))

        outcome = "passed" if spawn.returncode == 0 else "failed"
        return SandboxResult(
            outcome=outcome,
            total=total,
            passed=passed,
            failed=total - passed,
            duration_ms=duration_ms,
            cases=cases,
            output_tail=combined.strip()[-1200:],
            code_bytes=code_bytes,
            peak_mem_mb=spawn.peak_mem_mb,
            output_capped=spawn.output_capped,
        )

    except Exception as exc:
        return SandboxResult(
            outcome="error",
            reason=f"benchmark_sandbox_exception: {exc}",
        )
    finally:
        # Clean up temp directory
        import shutil
        try:
            shutil.rmtree(workdir, ignore_errors=True)
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════════════
# 4. Experiment runner
# ══════════════════════════════════════════════════════════════════════════

def run_experiment(
    benchmark_name: str,
    model_name: str,
    trials: int = 1,
    limit: Optional[int] = None,
    temperature: float = 0.0,
) -> Dict[str, Any]:
    """Run a full benchmark experiment for one model.

    Returns aggregate summary with pass@k metrics.
    """
    problems = load_benchmark(benchmark_name)
    if limit:
        problems = problems[:limit]

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    model_slug = model_name.replace("/", "_").replace(":", "_")

    print(f"\n{'='*70}")
    print(f"  Benchmark: {benchmark_name}")
    print(f"  Model: {model_name}")
    print(f"  Problems: {len(problems)}")
    print(f"  Trials per problem: {trials}")
    print(f"  Temperature: {temperature}")
    print(f"{'='*70}\n")

    # ── Per-problem results ─────────────────────────────────────────────
    all_results: List[Dict[str, Any]] = []

    for i, problem in enumerate(problems):
        task_id = problem["task_id"]
        for trial in range(trials):
            result = run_single_problem(
                problem=problem,
                model_name=model_name,
                trial=trial,
                temperature=temperature,
            )
            all_results.append(result)

            status = "✅ PASS" if result.get("passed") else "❌ FAIL"
            outcome = result.get("outcome", result.get("status", "?"))
            print(
                f"  [{i+1}/{len(problems)}] {task_id} "
                f"trial={trial} {status} ({outcome}) "
                f"{result.get('latency_ms', 0):.0f}ms"
            )

    # ── Compute aggregate metrics ───────────────────────────────────────
    summary = compute_metrics(all_results, benchmark_name, model_name)

    # ── Save results ────────────────────────────────────────────────────
    EXPERIMENT_DIR.mkdir(parents=True, exist_ok=True)

    results_path = EXPERIMENT_DIR / f"{benchmark_name}_{model_slug}_{timestamp}.jsonl"
    with open(results_path, "w", encoding="utf-8") as fh:
        for r in all_results:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    summary_path = EXPERIMENT_DIR / f"{benchmark_name}_{model_slug}_{timestamp}_summary.json"
    with open(summary_path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)

    print(f"\n{'─'*70}")
    print(f"  Results saved to: {results_path}")
    print(f"  Summary saved to: {summary_path}")
    print(f"{'─'*70}")
    print(f"\n  Aggregate Metrics:")
    print(f"    Pass@1:        {summary['pass_at_1']:.1%}")
    if trials > 1:
        print(f"    Pass@{trials}:        {summary.get(f'pass_at_{trials}', 0):.1%}")
    print(f"    Total trials:  {summary['total_trials']}")
    print(f"    Total passed:  {summary['total_passed']}")
    print(f"    Avg latency:   {summary['avg_latency_ms']:.0f}ms")
    print(f"    Error rate:    {summary['error_rate']:.1%}")
    print()

    return summary


def compute_metrics(
    results: List[Dict[str, Any]],
    benchmark_name: str,
    model_name: str,
) -> Dict[str, Any]:
    """Compute pass@1, pass@k, and other aggregate metrics."""
    total = len(results)
    if total == 0:
        return {"error": "no results"}

    passed = sum(1 for r in results if r.get("passed"))
    errors = sum(1 for r in results if r.get("status") == "model_error")
    latencies = [r.get("latency_ms", 0) for r in results if r.get("latency_ms")]

    # Group by task_id for pass@k
    by_task: Dict[str, List[bool]] = {}
    for r in results:
        tid = r["task_id"]
        if tid not in by_task:
            by_task[tid] = []
        by_task[tid].append(r.get("passed", False))

    # pass@k = fraction of problems where at least one trial passed
    max_k = max(len(v) for v in by_task.values()) if by_task else 1
    pass_at_k = {}
    for k in range(1, max_k + 1):
        any_passed = sum(
            1 for trials in by_task.values()
            if any(trials[:k])
        )
        pass_at_k[f"pass_at_{k}"] = any_passed / len(by_task) if by_task else 0

    # Per-problem breakdown
    problem_results = {}
    for tid, trials in by_task.items():
        problem_results[tid] = {
            "trials": len(trials),
            "passed": sum(trials),
            "pass_rate": sum(trials) / len(trials) if trials else 0,
        }

    return {
        "benchmark": benchmark_name,
        "model": model_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total_problems": len(by_task),
        "total_trials": total,
        "total_passed": passed,
        "total_errors": errors,
        "pass_at_1": pass_at_k.get("pass_at_1", 0),
        "error_rate": errors / total if total else 0,
        "avg_latency_ms": sum(latencies) / len(latencies) if latencies else 0,
        "p50_latency_ms": sorted(latencies)[len(latencies) // 2] if latencies else 0,
        "p95_latency_ms": sorted(latencies)[int(len(latencies) * 0.95)] if latencies else 0,
        "pass_at_k": pass_at_k,
        "per_problem": problem_results,
    }


# ══════════════════════════════════════════════════════════════════════════
# 5. Multi-model comparison runner
# ══════════════════════════════════════════════════════════════════════════

def run_comparison(
    benchmark_name: str,
    models: List[str],
    trials: int = 1,
    limit: Optional[int] = None,
    temperature: float = 0.0,
) -> List[Dict[str, Any]]:
    """Run benchmark against multiple models for comparison."""
    summaries = []
    for model in models:
        logger.info("Running model: %s", model)
        summary = run_experiment(
            benchmark_name=benchmark_name,
            model_name=model,
            trials=trials,
            limit=limit,
            temperature=temperature,
        )
        summaries.append(summary)

    # Print comparison table
    print(f"\n{'='*70}")
    print(f"  Comparison: {benchmark_name}")
    print(f"{'='*70}")
    print(f"  {'Model':<40} {'Pass@1':>8} {'Pass@k':>8} {'Errors':>8}")
    print(f"  {'─'*40} {'─'*8} {'─'*8} {'─'*8}")
    for s in summaries:
        print(
            f"  {s['model']:<40} "
            f"{s['pass_at_1']:>7.1%} "
            f"{s.get('pass_at_k', {}).get(f'pass_at_{trials}', 0):>7.1%} "
            f"{s['total_errors']:>8}"
        )
    print()

    return summaries


# ══════════════════════════════════════════════════════════════════════════
# 6. CLI
# ══════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Run benchmark experiments through AgentCorp's evaluation pipeline"
    )
    parser.add_argument(
        "--benchmark", "-b",
        choices=["humaneval", "mbpp_test"],
        default="humaneval",
        help="Benchmark dataset (default: humaneval)",
    )
    parser.add_argument(
        "--model", "-m",
        default=None,
        help="Single model name (e.g., deepseek-chat)",
    )
    parser.add_argument(
        "--models",
        default=None,
        help="Comma-separated model names for comparison",
    )
    parser.add_argument(
        "--trials", "-k",
        type=int,
        default=1,
        help="Number of trials per problem (for pass@k, default: 1)",
    )
    parser.add_argument(
        "--limit", "-n",
        type=int,
        default=None,
        help="Limit number of problems (for quick testing)",
    )
    parser.add_argument(
        "--temperature", "-t",
        type=float,
        default=0.0,
        help="Sampling temperature (default: 0.0)",
    )

    args = parser.parse_args()

    # Determine models to run
    if args.models:
        models = [m.strip() for m in args.models.split(",") if m.strip()]
    elif args.model:
        models = [args.model]
    else:
        # Use default from settings
        models = [settings.judge_model]
        print(f"Using default model from settings: {models[0]}")

    # Check sandbox
    if not settings.sandbox_enabled:
        print("⚠️  SANDBOX_ENABLED is False. Enabling for benchmark run.")
        settings.sandbox_enabled = True

    if settings.mock:
        print("⚠️  MOCK mode is enabled. Results will be simulated, not real.")
        print("   Set MOCK=false and configure JUDGE_BACKEND=http for real experiments.")

    # Run
    if len(models) == 1:
        run_experiment(
            benchmark_name=args.benchmark,
            model_name=models[0],
            trials=args.trials,
            limit=args.limit,
            temperature=args.temperature,
        )
    else:
        run_comparison(
            benchmark_name=args.benchmark,
            models=models,
            trials=args.trials,
            limit=args.limit,
            temperature=args.temperature,
        )


if __name__ == "__main__":
    main()
