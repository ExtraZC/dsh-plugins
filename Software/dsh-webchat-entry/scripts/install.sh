#!/usr/bin/env bash
# Install dsh-webchat-entry into a DSH profile.
#
# Two steps, both chosen so the plugin can go live WITHOUT restarting the
# service that is serving this session:
#
#   1. Copy the package into `$DSH_HOME/profiles/<name>/node_modules/`.
#   2. Append a marked `insert:` row to that profile's `cordis.patch.yml`.
#
# Step 2 is what activates it: the profile sets `dsh.profile.patchReload: live`,
# so the boot code watches this file through Cordis HMR and transactionally
# reapplies the composed patch tree when it changes. The row is therefore picked
# up in-process; only the browser needs a refresh to fetch the new client bundle.
#
# The row is registered in the patch layer rather than in `dsh.profile.bundles`
# on purpose. Bundles are read once at boot, so a bundles entry would need a
# restart — and adding both would insert the same row twice, which the loader
# rejects as a duplicate entry id.
#
# Usage: scripts/install.sh [profile-name]
set -euo pipefail

PROFILE="${1:-web}"
PACKAGE="dsh-webchat-entry"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
TARGET="$PROFILE_DIR/node_modules/$PACKAGE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

BEGIN_MARKER="# >>> $PACKAGE >>>"
END_MARKER="# <<< $PACKAGE <<<"

if [[ ! -f "$PROFILE_DIR/package.json" ]]; then
  echo "install: no profile at $PROFILE_DIR (create it with: dsh --from-default-profile web --profile $PROFILE)" >&2
  exit 1
fi

echo "install: $SOURCE -> $TARGET"
mkdir -p "$TARGET"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules \
    "$SOURCE/package.json" "$SOURCE/cordis.patch.yml" "$SOURCE/lib" "$SOURCE/src" \
    "$TARGET/"
else
  rm -rf "$TARGET"
  mkdir -p "$TARGET"
  cp -r "$SOURCE/package.json" "$SOURCE/cordis.patch.yml" "$SOURCE/lib" "$SOURCE/src" "$TARGET/"
fi
[[ -f "$SOURCE/README.md" ]] && cp "$SOURCE/README.md" "$TARGET/"

# The profile hoists its dependencies, so the host half's own import has to be
# resolvable next to it. A profile created from the shipped Web template already
# has schemastery; link the installation copy otherwise.
if [[ ! -e "$PROFILE_DIR/node_modules/@deepseek-ai/schemastery" ]]; then
  SCHEMASTERY="$(node -e "console.log(require.resolve('@deepseek-ai/schemastery/package.json'))" 2>/dev/null \
    || echo /home/user/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery/package.json)"
  if [[ -f "$SCHEMASTERY" ]]; then
    mkdir -p "$PROFILE_DIR/node_modules/@deepseek-ai"
    ln -sfn "$(dirname "$SCHEMASTERY")" "$PROFILE_DIR/node_modules/@deepseek-ai/schemastery"
    echo "install: linked @deepseek-ai/schemastery"
  else
    echo "install: warning: @deepseek-ai/schemastery was not found; the plugin needs it at activation" >&2
  fi
fi

# Register the insert row in the user patch layer, idempotently. The markers make
# removal exact, so uninstall never has to parse the rest of the file.
if [[ ! -f "$PATCH_FILE" ]]; then
  printf '# dsh profile user patch layer.\n[]\n' > "$PATCH_FILE"
fi

if grep -qF "$BEGIN_MARKER" "$PATCH_FILE"; then
  echo "install: $PACKAGE is already registered in $PATCH_FILE"
else
  {
    printf '\n%s\n' "$BEGIN_MARKER"
    printf '# DeepSeek 网页对话入口：侧边栏 footer action，点击在新标签页打开 chat.deepseek.com。\n'
    printf '# 免重启生效（profile 设置了 patchReload: live，本文件变更会热加载）。\n'
    printf -- '- insert:\n'
    printf -- '    - id: webchat-entry\n'
    printf -- '      name: %s\n' "$PACKAGE"
    printf '%s\n' "$END_MARKER"
  } >> "$PATCH_FILE"
  echo "install: appended the $PACKAGE row to $PATCH_FILE"
fi

echo
echo "install: done. The patch layer reloads live, so the host half should load now."
echo "  Refresh http://127.0.0.1:30500 to fetch the client bundle."
echo "  If it does not appear, restart the service: systemctl restart dsh.service"
