#!/usr/bin/env bash
# 发布前隐私 grep 门禁。
# 命中任一受限 token（用户名、本机绝对路径、AI 工具目录）即 exit 1。
# 用法：bash scripts/privacy-grep.sh [额外目录...]
set -u

PATTERN='陈思丞|C:/Users|/c/Users|\.workbuddy|\.trae|/Users/|/home/'
TARGETS=(
  "README.md"
  "package.json"
  "index.html"
  "electron-builder.yml"
  "src"
  "electron"
  "model-service/app"
  "docs"
)
if [ "$#" -gt 0 ]; then
  TARGETS=("$@")
fi

status=0
for t in "${TARGETS[@]}"; do
  if [ ! -e "$t" ]; then
    echo "privacy-grep: 警告——目标不存在，跳过: ${t}" >&2
    continue
  fi
  grep -rEn --binary-files=without-match "$PATTERN" "$t"
  rc=$?
  if [ "$rc" -eq 1 ]; then
    : # 无命中
  elif [ "$rc" -eq 0 ]; then
    echo "privacy-grep: 命中受限 token（目录: ${t}）" >&2
    status=1
  else
    echo "privacy-grep: grep 自身出错（rc=${rc}，目录: ${t}），按失败处理" >&2
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "privacy-grep: CLEAN"
fi
exit "$status"
