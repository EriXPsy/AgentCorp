#!/usr/bin/env bash
# scripts/e2e_ascend.sh
# 国产算力统一环境部署后的端到端冒烟验证（部署 runbook 见 docs/ascend-adaptation-plan.md §7）。
#
# 前置：docker compose -f model-service/docker-compose.ascend.yml up --build 已起。
# 用法：./scripts/e2e_ascend.sh [BASE_URL]   （默认 http://127.0.0.1:8000）
#
# 验证项：
#   1) GET  /health        → 200 且 model_available=true（真实模式已加载权重）
#   2) POST /api/evaluate  → SSE 冒烟，事件流含 event: done
#   3) model-service 测试套件（MOCK=true，不依赖 NPU）
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8000}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> [1/3] /health（$BASE_URL）"
health="$(curl -fsS "$BASE_URL/health")"
echo "$health"
echo "$health" | grep -q '"model_available": *true' \
  || { echo "FAIL: model_available 不为 true（权重未加载或 MOCK=true）" >&2; exit 1; }

echo "==> [2/3] /api/evaluate SSE 冒烟"
sse="$(curl -fsS -N -X POST "$BASE_URL/api/evaluate" \
  -H 'Content-Type: application/json' \
  -d '{"candidate":{"id":"e2e-ascend","name":"e2e"},"preference":{}}')"
echo "$sse" | grep -q 'event: done' \
  || { echo "FAIL: SSE 事件流未收到 done 事件" >&2; echo "$sse" >&2; exit 1; }
echo "SSE 冒烟通过（含 event: done）"

echo "==> [3/3] model-service 测试套件（MOCK=true）"
cd "$REPO_ROOT/model-service"
MOCK=true python3 -m pytest tests/ -q

echo "PASS: 国产算力统一环境端到端验证通过 ✅"
