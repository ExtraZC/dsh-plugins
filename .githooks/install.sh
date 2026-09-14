#!/usr/bin/env bash
# ==============================================================================
# .githooks/install.sh — 在本地 clone 中启用仓库钩子
#
# git 出于安全不会自动启用仓库内钩子，每个 clone 需要执行一次本脚本。
# 它只写入 **仓库级** 配置（core.hooksPath），不触碰全局配置。
#
#   bash .githooks/install.sh            # 启用
#   bash .githooks/install.sh --uninstall # 关闭
# ==============================================================================
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [[ "${1:-}" == "--uninstall" ]]; then
  git config --local --unset core.hooksPath 2>/dev/null || true
  echo "已关闭仓库钩子（core.hooksPath 已移除）。"
  exit 0
fi

chmod +x "$ROOT/.githooks/pre-commit" "$ROOT/.githooks/install.sh" 2>/dev/null || true
git config --local core.hooksPath .githooks

echo "✅ 已启用: core.hooksPath = .githooks"
echo "   生效钩子: $(ls -1 "$ROOT/.githooks" | grep -vE '\.(txt|md)$' | tr '\n' ' ')"
echo "   自检:     bash .githooks/pre-commit --scan-all"
echo "   关闭:     bash .githooks/install.sh --uninstall"
