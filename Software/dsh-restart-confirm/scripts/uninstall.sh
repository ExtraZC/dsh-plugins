#!/usr/bin/env bash
# Remove dsh-restart-confirm from a DSH profile.
#
# Usage: scripts/uninstall.sh [profile-name]
set -euo pipefail

PROFILE="${1:-web}"
PACKAGE="dsh-restart-confirm"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
TARGET="$PROFILE_DIR/node_modules/$PACKAGE"

if [[ -f "$PROFILE_DIR/package.json" ]]; then
  python3 - "$PROFILE_DIR/package.json" "$PACKAGE" <<'PY'
import json, sys
path, package = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as handle:
    manifest = json.load(handle)
bundles = manifest.get('dsh', {}).get('profile', {}).get('bundles', [])
if package in bundles:
    bundles.remove(package)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write('\n')
    print(f'uninstall: removed {package} from dsh.profile.bundles')
else:
    print(f'uninstall: {package} was not in dsh.profile.bundles')
PY
fi

if [[ -d "$TARGET" ]]; then
  rm -rf "$TARGET"
  echo "uninstall: removed $TARGET"
fi

echo "uninstall: done. Restart the service to unload the plugin."
