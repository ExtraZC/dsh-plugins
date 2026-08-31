#!/usr/bin/env bash
# Generate the repository-root README.md by embedding every plugin's README.
#
# Usage: bash scripts/build-readme.sh
# Re-run after adding a plugin directory (dsh-*/README.md) or editing any
# plugin README. The generated README.md is committed; GitHub renders it as
# the repository main page.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=README.md
mapfile -t READMES < <(compgen -G 'dsh-*/README.md' | sort)

{
  cat <<'HEADER'
# dsh-plugins

dsh（DeepSeek Harness）插件集合。每个插件位于独立目录，各自维护自己的 `README.md`；
本主页由 [`scripts/build-readme.sh`](scripts/build-readme.sh) 自动汇总生成——修改任一插件 README 后请重新运行该脚本并提交。

## 插件列表

HEADER

  for f in "${READMES[@]}"; do
    plugin=${f%/README.md}
    desc=$(grep -m1 '"description"' "$plugin/package.json" 2>/dev/null |
      sed -E 's/.*"description"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
    echo "- **[$plugin](#$plugin)**：$desc"
  done

  for f in "${READMES[@]}"; do
    plugin=${f%/README.md}
    echo
    echo "---"
    echo
    # Demote every heading one level (plugin H1 becomes page H2) and prefix
    # relative markdown links so they resolve from the repository root.
    sed -E -e 's/^(#+)/#\1/' -e "s|\]\(([^)#:]+)\)|]($plugin/\1)|g" "$f"
    echo
  done
} > "$OUT"

echo "wrote $OUT ($(wc -l < "$OUT") lines, $(wc -c < "$OUT") bytes)"
