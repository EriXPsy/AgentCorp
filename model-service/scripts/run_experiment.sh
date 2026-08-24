#!/bin/bash
# Quick-start script for running benchmark experiments.
#
# Prerequisites:
#   1. Download benchmarks:  python scripts/download_benchmarks.py
#   2. Set environment variables (see .env.example below)
#   3. Run:  bash scripts/run_experiment.sh [model] [benchmark] [limit]
#
# Examples:
#   bash scripts/run_experiment.sh deepseek-chat humaneval 10
#   bash scripts/run_experiment.sh gpt-4o mbpp_test 50
#   bash scripts/run_experiment.sh claude-sonnet-4-20250514 humaneval 164

set -e
cd "$(dirname "$0")/.."

MODEL="${1:-deepseek-chat}"
BENCHMARK="${2:-humaneval}"
LIMIT="${3:-10}"

echo "═══════════════════════════════════════════════════════════════"
echo "  AgentCorp Benchmark Experiment"
echo "  Model:     $MODEL"
echo "  Benchmark: $BENCHMARK"
echo "  Limit:     $LIMIT problems"
echo "  Trials:    3 (for pass@3)"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Check benchmarks exist
if [ ! -f "data/benchmarks/${BENCHMARK}.jsonl" ]; then
    echo "❌ Benchmark not found. Run: python scripts/download_benchmarks.py"
    exit 1
fi

# Run experiment
SANDBOX_ENABLED=true \
TEMPERATURE=0.0 \
python scripts/run_benchmark.py \
    --benchmark "$BENCHMARK" \
    --model "$MODEL" \
    --trials 3 \
    --limit "$LIMIT"

echo ""
echo "Results saved to: data/experiments/"
echo "View latest: ls -lt data/experiments/ | head -5"
