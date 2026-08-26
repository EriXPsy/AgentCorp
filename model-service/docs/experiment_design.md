# Experiment Design for AgentCorp Evaluation Paper

## Target Venue

AAMAS 2026 Workshop on Adaptive Learning Agents (ALA) or
NeurIPS 2026 Workshop on LLM Evaluation.

## Core Research Questions

1. **RQ1**: Does the SPADE adaptive challenge loop (Designer + Reflector + PromptEvolver)
   produce better team differentiation than fixed benchmarks?
2. **RQ2**: Does semantic memory (StyleMemory) outperform metric-based profiling for
   predicting team performance on novel challenges?
3. **RQ3**: How does the JudgeRegistry + multi-evaluator architecture affect evaluation
   reliability compared to single-judge approaches?

## Benchmarks

| Benchmark | Source | Problems | Format | License |
|-----------|--------|----------|--------|---------|
| HumanEval | OpenAI | 164 | JSONL | MIT |
| MBPP (test) | Google | 89 | JSONL | CC-BY-4.0 |

Download: `python scripts/download_benchmarks.py`

## Experiment Plan

### Experiment 1: Cross-Model Pass@k Baseline (Week 1)

**Purpose**: Establish baseline performance across models on standard benchmarks.

**Setup**:
- Models: DeepSeek-V3, GPT-4o, Claude-Sonnet-4, Qwen-72B, Llama-3.1-70B (5 models)
- Benchmarks: HumanEval (164) + MBPP (89) = 253 problems
- Trials: 3 per problem (temperature=0.7 for diversity)
- Total: 5 × 253 × 3 = 3,795 trials

**Metrics**:
- pass@1, pass@3 (machine-verified via sandbox)
- Mean latency (model_latency_ms)
- Token usage (prompt_tokens, completion_tokens)

**Command**:
```bash
python scripts/run_benchmark.py --benchmark humaneval --models deepseek-chat,gpt-4o,claude-sonnet-4-20250514 --trials 3
```

### Experiment 2: SPADE Adaptive Challenge vs Fixed (Week 2-3)

**Purpose**: Compare adaptive challenges (Designer-generated) vs fixed HumanEval problems.

**Setup**:
- For each model, run BOTH:
  - (A) Fixed: HumanEval problems as-is
  - (B) Adaptive: Designer generates challenges based on StyleMemory from HumanEval performance
- After each evaluation, Reflector writes an observation
- Every 3 reflections → StyleMemory synthesizes understanding
- Every 20 reflections → PromptEvolver evolves prompts
- Compare: does adaptive testing achieve better team differentiation (variance in scores)?

**Metrics**:
- Score variance across teams (higher = better differentiation)
- Correlation between StyleMemory understanding and subsequent performance
- Evolution count + reflection quality over time

### Experiment 3: JudgeRegistry Reliability (Week 3-4)

**Purpose**: Measure evaluation reliability with multi-evaluator ensemble.

**Setup**:
- Same model outputs evaluated by:
  - (A) Single judge (one LLM)
  - (B) Ensemble (3 LLMs, majority vote)
  - (C) Machine verification only (sandbox pass/fail)
- Measure inter-judge agreement (Cohen's κ)

**Metrics**:
- Inter-annotator agreement (Cohen's κ, Fleiss' κ)
- Pass@k stability across judge configurations
- Evaluation latency and cost

## Data Collection Pipeline

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│  Benchmark   │────▶│  LLM Generate │────▶│   Sandbox    │────▶│   Results    │
│  (JSONL)     │     │  (code)       │     │  (execute)   │     │   (JSONL)    │
└─────────────┘     └──────────────┘     └─────────────┘     └──────────────┘
                           │                                         │
                           ▼                                         ▼
                    ┌──────────────┐                          ┌──────────────┐
                    │  StyleMemory  │◀────── Reflection ──────│  Designer     │
                    │  (semantic)   │                          │  (adaptive)   │
                    └──────────────┘                          └──────────────┘
```

## Output Format

### Per-problem results (`humaneval_deepseek-chat_20260818_120000.jsonl`)
```json
{"task_id": "HumanEval/0", "model": "deepseek-chat", "trial": 0, "passed": true, "outcome": "passed", "latency_ms": 1234.5, ...}
```

### Aggregate summary (`humaneval_deepseek-chat_20260818_120000_summary.json`)
```json
{"benchmark": "humaneval", "model": "deepseek-chat", "pass_at_1": 0.72, "pass_at_3": 0.85, ...}
```

## Reproducibility

- All results include: model name, temperature, timestamp, sandbox outcome
- Sandbox uses isolated subprocess with resource limits
- Canonical solutions included in benchmark data for reference
- Random seeds logged for temperature > 0 runs

## Estimated Cost

| Item | Estimate |
|------|----------|
| HumanEval × 5 models × 3 trials | ~$15 (DeepSeek) / ~$75 (GPT-4o) |
| MBPP × 5 models × 3 trials | ~$8 / ~$40 |
| Designer challenges (adaptive) | ~$20 (extra LLM calls) |
| **Total** | **~$50-150** |
