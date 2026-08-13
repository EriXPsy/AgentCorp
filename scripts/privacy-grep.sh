#!/usr/bin/env bash
# =============================================================================
# 隐私门禁（GOAI 参赛材料铁律 · 一票否决）
# -----------------------------------------------------------------------------
# 扫描可能随 PR / 参赛包外发的目录，命中任何隐私 token 即退出码 1，阻断提交/构建。
# 命中项（与 MEMORY.md「参赛/对外材料隐私铁律」同源）：
#   陈思丞 | C:/Users | /c/Users | .workbuddy | .trae
# 说明：
#   - 扫描范围刻意限定为会外发的源码与文档产物（src/demo、docs/artifacts、.workbuddy/artifacts），
#     不扫整个仓库，避免误伤 node_modules / dist-web 等噪声。
#   - 脚本自身位于 scripts/，不在扫描范围内；扫描目标目录经 grep -rIlE 实测零命中，
#     故脚本不会自匹配导致 false fail。
#   - 命中的行仅打印路径，不打印命中内容，避免把隐私 token 又回显到日志。
# =============================================================================
set -u

PATTERN='陈思丞|C:/Users|/c/Users|\.workbuddy|\.trae'

# 待扫描目录（存在才扫，缺失则跳过，不报错）
TARGETS=()
for d in src/demo docs/artifacts .workbuddy/artifacts; do
  if [ -d "$d" ]; then
    TARGETS+=("$d")
  fi
done

if [ ${#TARGETS[@]} -eq 0 ]; then
  echo "privacy:check: 无待扫描目录，跳过。"
  exit 0
fi

echo "privacy:check: 扫描 ${TARGETS[*]} 中的隐私 token ..."

# -r 递归 / -I 跳过二进制 / -l 仅列文件名 / -E ERE / -n 行号
HITS=$(grep -rIlnE "$PATTERN" "${TARGETS[@]}" 2>/dev/null || true)

if [ -n "$HITS" ]; then
  echo "❌ privacy:check FAILED —— 以下文件含隐私 token，须在提交/外发前清理："
  # 仅打印相对路径，避免回显命中内容
  printf '%s\n' "$HITS"
  exit 1
fi

echo "✅ privacy:check PASSED —— 未发现隐私 token。"
exit 0
