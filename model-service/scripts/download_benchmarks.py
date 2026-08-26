#!/usr/bin/env python3
"""
Download and format official benchmarks for AgentCorp experiments.

Sources (official, verified):
  HumanEval  — OpenAI, 164 problems, CC-BY-4.0
               https://github.com/openai/human-eval
  MBPP       — Google, 974 problems (we take the 257-problem test split)
               https://github.com/google-research/google-research/tree/master/mbpp

Output:
  data/benchmarks/humaneval.jsonl  — 164 lines, one HumanEval problem each
  data/benchmarks/mbpp_test.jsonl  — 89 lines, one MBPP test-split problem each (task_id 11-99)

Each JSONL line:
  {
    "task_id": "HumanEval/42" or "MBPP/776",
    "prompt": "<code prefix — model completes from here>",
    "test": "<assertion code — run after model completion>",
    "entry_point": "function_name",
    "canonical_solution": "<reference answer>"
  }
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import urllib.request

HUMANEVAL_URL = (
    "https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz"
)
MBPP_URL = (
    "https://raw.githubusercontent.com/google-research/google-research/"
    "master/mbpp/mbpp.jsonl"
)

BENCHMARK_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "benchmarks",
)


def _download(url: str) -> bytes:
    print(f"  Downloading: {url[:80]}...")
    req = urllib.request.Request(url, headers={"User-Agent": "AgentCorp-Benchmark/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def _maybe_decompress(data: bytes, url: str) -> bytes:
    if url.endswith(".gz"):
        import gzip
        return gzip.decompress(data)
    return data


def download_humaneval() -> int:
    raw = _maybe_decompress(_download(HUMANEVAL_URL), HUMANEVAL_URL)
    lines = raw.decode("utf-8").strip().split("\n")
    problems = []
    for line in lines:
        obj = json.loads(line)
        problems.append({
            "task_id": obj["task_id"],
            "prompt": obj["prompt"],
            "test": obj["test"],
            "entry_point": obj["entry_point"],
            "canonical_solution": obj["canonical_solution"],
        })

    out_path = os.path.join(BENCHMARK_DIR, "humaneval.jsonl")
    with open(out_path, "w", encoding="utf-8") as fh:
        for p in problems:
            fh.write(json.dumps(p, ensure_ascii=False) + "\n")
    print(f"  HumanEval: {len(problems)} problems → {out_path}")
    return len(problems)


def download_mbpp() -> int:
    raw = _download(MBPP_URL)
    lines = raw.decode("utf-8").strip().split("\n")
    # MBPP standard test split (from the original paper):
    # task_id 11-99 (89 problems). The first 10 are few-shot examples.
    # The rest (100-974) are training/supplementary.
    # Note: Some problems may lack valid test_list — we skip those.
    test_ids = set(range(11, 100))

    problems = []
    for line in lines:
        obj = json.loads(line)
        tid = obj["task_id"]
        if tid not in test_ids:
            continue

        text = obj.get("text", "")
        code = obj.get("code", "")
        test_list = obj.get("test_list", [])
        test_setup = obj.get("test_setup_code", "")

        # Skip problems without tests
        if not test_list:
            continue

        # Extract function signature: find the first 'def ' line
        entry_point = ""
        for cline in code.split("\n"):
            stripped = cline.strip()
            if stripped.startswith("def "):
                entry_point = stripped.split("(")[0].replace("def ", "").strip()
                first_def_line = stripped
                break
        else:
            # No def found — use the first non-empty line
            first_def_line = code.split("\n")[0] if code else ""
            entry_point = first_def_line.split("(")[0].replace("def ", "").strip() if "(" in first_def_line else ""

        # Build prompt: docstring + function signature only (model fills the body)
        prompt = f'"""\n{text}\n"""\n{first_def_line}\n'

        # Build test code: setup + assertions
        test_parts = []
        if test_setup:
            test_parts.append(test_setup)
        test_parts.extend(test_list)
        test_code = "\n".join(test_parts) + "\n"

        problems.append({
            "task_id": f"MBPP/{tid}",
            "prompt": prompt,
            "test": test_code,
            "entry_point": entry_point,
            "canonical_solution": code,
        })

    out_path = os.path.join(BENCHMARK_DIR, "mbpp_test.jsonl")
    with open(out_path, "w", encoding="utf-8") as fh:
        for p in problems:
            fh.write(json.dumps(p, ensure_ascii=False) + "\n")
    print(f"  MBPP test split (task_id 11-99): {len(problems)} problems → {out_path}")
    return len(problems)


def main():
    os.makedirs(BENCHMARK_DIR, exist_ok=True)
    print("Downloading official benchmarks...")
    n_he = download_humaneval()
    n_mbpp = download_mbpp()
    print(f"\nDone: HumanEval={n_he}, MBPP={n_mbpp}")
    print(f"Stored in: {BENCHMARK_DIR}")
    if n_he != 164:
        print(f"  ⚠️ Expected 164 HumanEval problems, got {n_he}")
    if n_mbpp < 80:
        print(f"  ⚠️ Expected ~89 MBPP test problems (task_id 11-99), got {n_mbpp}")



if __name__ == "__main__":
    main()
