#!/usr/bin/env bash
# End-to-end check of the plugin against a disposable DSH web instance.
#
# Builds an isolated `$DSH_HOME` with a stock `web` profile, installs this
# package into it, boots `dsh web` on its own port, drives the restart-confirm
# HTTP flow, and verifies that a confirmed restart actually re-executes the
# process. Nothing in the caller's real profile is touched.
#
# Usage: scripts/e2e.sh [port]
set -uo pipefail

PORT="${1:-30999}"
BASE="http://127.0.0.1:$PORT"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_HOME="$(mktemp -d)"
PROFILE_DIR="$E2E_HOME/profiles/e2e"
WATCHED="$PROFILE_DIR/cordis.patch.yml"
LOG="$E2E_HOME/boot.log"
FAILURES=0

cleanup() {
  if [[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$E2E_HOME"
}
trap cleanup EXIT

check() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "ok   - $label"
  else
    echo "FAIL - $label: got '$actual', want '$expected'"
    FAILURES=$((FAILURES + 1))
  fi
}

state_field() {
  curl -s "$BASE/__restart-confirm/state" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$1'))" 2>/dev/null
}

echo "e2e: preparing an isolated profile in $E2E_HOME"
DSH_HOME="$E2E_HOME" dsh --from-default-profile web --profile e2e --dump-config >/dev/null 2>&1
if [[ ! -d "$PROFILE_DIR" ]]; then
  echo "FAIL - could not initialize an isolated web profile"
  exit 1
fi
DSH_HOME="$E2E_HOME" "$SOURCE/scripts/install.sh" e2e

echo "e2e: booting dsh web on port $PORT"
DSH_HOME="$E2E_HOME" nohup dsh --profile e2e --no-open --host 127.0.0.1 --port "$PORT" >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 90); do
  if curl -s -o /dev/null "$BASE/__restart-confirm/state"; then break; fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "FAIL - the instance exited during boot"; tail -25 "$LOG"; exit 1
  fi
  sleep 1
done

check "state route answers" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/__restart-confirm/state")" "200"
check "no change is pending at boot" "$(state_field pending)" "False"
check "the profile dir is detected" "$(state_field profileDir)" "$PROFILE_DIR"

# --- a profile change arms the bar ------------------------------------------

# A real plugin operation rewrites the file, so append a comment. A pure touch
# is deliberately not a change: nothing would differ after a restart.
printf '\n# e2e %s\n' "$(date +%s)" >>"$WATCHED"
for _ in $(seq 1 25); do
  [[ "$(state_field pending)" == "True" ]] && break
  sleep 1
done
check "a profile change arms the bar" "$(state_field pending)" "True"
check "the bar carries a reason" "$(state_field reason)" "profile files changed"

# --- "later" defers and stays deferred ---------------------------------------

check "later is accepted" \
  "$(curl -s -X POST "$BASE/__restart-confirm/respond" -H 'content-type: application/json' -d '{"action":"later"}' | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok"))')" \
  "True"
sleep 4
check "later survives the next poll cycle" "$(state_field pending)" "False"

# --- the confirmed restart re-executes the process ---------------------------

echo "e2e: requesting a restart through the plugin"
curl -s -o /dev/null -X POST "$BASE/__restart-confirm/restart"
for _ in $(seq 1 30); do
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 1
done
if kill -0 "$PID" 2>/dev/null; then
  echo "FAIL - the instance did not exit after a confirmed restart"
  FAILURES=$((FAILURES + 1))
else
  echo "ok   - the instance exited so a supervisor can restart it"
fi

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "e2e: all checks passed"
else
  echo "e2e: $FAILURES check(s) failed"
fi
exit "$FAILURES"
