#!/usr/bin/env bash
# Uninstall dsh-webchat-entry from a DSH profile.
#
# Reverses install.sh exactly: removes the marked patch-layer block (using the
# markers, so surrounding user patches are untouched) and deletes the package
# directory. Like the install, the patch-file edit reloads live — the entry
# disappears on the next page refresh without a service restart.
#
# Usage: scripts/uninstall.sh [profile-name]
set -euo pipefail

PROFILE="${1:-web}"
PACKAGE="dsh-webchat-entry"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
TARGET="$PROFILE_DIR/node_modules/$PACKAGE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

BEGIN_MARKER="# >>> $PACKAGE >>>"
END_MARKER="# <<< $PACKAGE <<<"

if [[ -f "$PATCH_FILE" ]] && grep -qF "$BEGIN_MARKER" "$PATCH_FILE"; then
  python3 - "$PATCH_FILE" "$BEGIN_MARKER" "$END_MARKER" <<'PY'
import sys

path, begin, end = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding='utf-8') as handle:
    lines = handle.readlines()

kept, dropping, removed = [], False, 0
for line in lines:
    if line.rstrip('\n') == begin:
        dropping = True
    if dropping:
        removed += 1
        if line.rstrip('\n') == end:
            dropping = False
        continue
    kept.append(line)

if dropping:
    raise SystemExit(f'uninstall: unterminated {begin} block in {path}')

# Collapse the blank separator install.sh wrote in front of the block.
while len(kept) >= 2 and kept[-1].strip() == '' and kept[-2].strip() == '':
    kept.pop()

with open(path, 'w', encoding='utf-8') as handle:
    handle.writelines(kept)

print(f'uninstall: removed {removed} line(s) from {path}')
PY
else
  echo "uninstall: no $PACKAGE block in $PATCH_FILE"
fi

if [[ -d "$TARGET" ]]; then
  rm -rf "$TARGET"
  echo "uninstall: removed $TARGET"
else
  echo "uninstall: $TARGET was not present"
fi

echo
echo "uninstall: done. Refresh http://127.0.0.1:30500 to drop the client bundle."
