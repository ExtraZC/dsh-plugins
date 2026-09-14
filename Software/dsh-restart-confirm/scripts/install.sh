#!/usr/bin/env bash
# Install dsh-restart-confirm into a DSH profile.
#
# Copies the package into `$DSH_HOME/profiles/<name>/node_modules/` and appends
# it to that profile's `dsh.profile.bundles` layer list — the same state
# `dsh plugin add` produces, without needing the registry or a lockfile update.
#
# Usage: scripts/install.sh [profile-name]
set -euo pipefail

PROFILE="${1:-web}"
PACKAGE="dsh-restart-confirm"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
TARGET="$PROFILE_DIR/node_modules/$PACKAGE"

if [[ ! -f "$PROFILE_DIR/package.json" ]]; then
  echo "install: no profile at $PROFILE_DIR (create it with: dsh --from-default-profile web --profile $PROFILE)" >&2
  exit 1
fi

echo "install: $SOURCE -> $TARGET"
mkdir -p "$TARGET"
# Replace the previous copy; `rsync --delete` keeps a stale file from surviving.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude node_modules \
    "$SOURCE/package.json" "$SOURCE/cordis.patch.yml" "$SOURCE/lib" "$SOURCE/src" "$SOURCE/README.md" \
    "$TARGET/"
else
  rm -rf "$TARGET"
  mkdir -p "$TARGET"
  cp -r "$SOURCE/package.json" "$SOURCE/cordis.patch.yml" "$SOURCE/lib" "$SOURCE/src" "$TARGET/"
  [[ -f "$SOURCE/README.md" ]] && cp "$SOURCE/README.md" "$TARGET/"
fi

# The profile hoists its dependencies, so the plugin's own dependency has to be
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

# Register the bundle layer. Python keeps this a real JSON edit instead of a
# fragile text patch.
python3 - "$PROFILE_DIR/package.json" "$PACKAGE" <<'PY'
import json, sys
path, package = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as handle:
    manifest = json.load(handle)
dsh = manifest.setdefault('dsh', {})
profile = dsh.setdefault('profile', {})
bundles = profile.setdefault('bundles', [])
if package in bundles:
    print(f'install: {package} is already in dsh.profile.bundles')
else:
    bundles.append(package)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write('\n')
    print(f'install: added {package} to dsh.profile.bundles')
PY

echo
echo "install: done. Restart the service to activate the plugin:"
echo "  systemctl restart dsh.service    # or exit the running dsh web process"
