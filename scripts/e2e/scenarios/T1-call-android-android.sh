#!/usr/bin/env bash
# T1 — Android→Android call, both foreground.
#
# Pass criteria:
#   - LK `participantJoined` for BOTH identities within 5s of the tap
#   - LK `trackPublished` audio for BOTH within 10s
#   - C++ WS: no ENVELOPE_NOT_UNWRAPPED in the wave window
#   - No `AndroidRuntime FATAL` in either logcat
#
# Budget: 45s wall time. Times out → fail class WS_TIMEOUT or LK_NO_JOIN.
#
# Args:
#   $1  evidence dir (caller-provided, scenario-scoped)
# Env:
#   EMUL_A_SERIAL    default emulator-5554 (caller / apitest@onemundo)
#   EMUL_B_SERIAL    default emulator-5556 (callee / duarte@chatyy)
#   T1_TIMEOUT       default 45 (seconds)

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="$SCRIPT_DIR/../lib"
# shellcheck source=../lib/android-device.sh
source "$LIB/android-device.sh"
# shellcheck source=../lib/parse-lk-logs.sh
source "$LIB/parse-lk-logs.sh"
# shellcheck source=../lib/parse-cppws-logs.sh
source "$LIB/parse-cppws-logs.sh"

EVIDENCE_DIR="${1:-/tmp/e2e-T1-$$}"
export E2E_EVIDENCE_DIR="$EVIDENCE_DIR"
mkdir -p "$EVIDENCE_DIR"

: "${EMUL_A_SERIAL:=emulator-5554}"
: "${EMUL_B_SERIAL:=emulator-5556}"
: "${T1_TIMEOUT:=45}"
: "${QA_CALLER_EMAIL:=apitest@onemundo.com.br}"
: "${QA_CALLER_PWD:=LBfypvbERr4cm1Hd1nZe3yT}"
: "${QA_CALLEE_EMAIL:=duarte@chatyy.com.br}"
: "${QA_CALLEE_PWD:=Aleff2009@@}"

# JSON verdict writer
emit() {
  local status="$1" failure_class="${2:-}" detail="${3:-}"
  local dur=$(( $(date +%s) - T0 ))
  cat > "$EVIDENCE_DIR/verdict.json" <<EOF
{
  "id": "T1",
  "name": "call-android-android",
  "status": "$status",
  "failure_class": "$failure_class",
  "detail": $(printf '%s' "$detail" | jq -Rs . 2>/dev/null || echo '""'),
  "duration_s": $dur,
  "caller": "$QA_CALLER_EMAIL",
  "callee": "$QA_CALLEE_EMAIL",
  "evidence_dir": "$EVIDENCE_DIR"
}
EOF
  echo "[T1] $status ${failure_class}"
  if [ "$status" = "PASS" ]; then exit 0; else exit 1; fi
}

T0=$(date +%s)
echo "[T1] start t0=$T0 evidence=$EVIDENCE_DIR"

# Preflight ----------------------------------------------------------------
if ! adv_wave_preflight "$EMUL_A_SERIAL" "$EMUL_B_SERIAL"; then
  emit FAIL INFRA_FAILURE "emulator preflight failed"
fi
if ! cppws_health >/dev/null 2>&1; then
  echo "[T1] WARN: ws.chatyy.com.br/health not reachable, continuing"
fi

# Clean state -------------------------------------------------------------
adv_kill "$EMUL_A_SERIAL"
adv_kill "$EMUL_B_SERIAL"
sleep 1

# Login both sides (cooperative QA creds drop) -----------------------------
adv_login "$EMUL_A_SERIAL" "$QA_CALLER_EMAIL" "$QA_CALLER_PWD" || true
adv_login "$EMUL_B_SERIAL" "$QA_CALLEE_EMAIL" "$QA_CALLEE_PWD" || true

# Foreground both apps -----------------------------------------------------
adv_fg "$EMUL_A_SERIAL" || emit FAIL INFRA_FAILURE "fg A failed"
adv_fg "$EMUL_B_SERIAL" || emit FAIL INFRA_FAILURE "fg B failed"
sleep 4  # let JS bundle load + WS auth

# Start LK log tail (background) -------------------------------------------
LK_NDJSON="$EVIDENCE_DIR/lk-events.ndjson"
LK_TAIL_PID=$(lk_tail_bg "$LK_NDJSON" "$T0")
trap 'kill "$LK_TAIL_PID" 2>/dev/null || true' EXIT

# Screencap pre-tap --------------------------------------------------------
adv_screencap "$EMUL_A_SERIAL" "$EVIDENCE_DIR/screen-A-pre.png" || true
adv_screencap "$EMUL_B_SERIAL" "$EVIDENCE_DIR/screen-B-pre.png" || true

# Trigger the call ---------------------------------------------------------
# Strategy: navigate caller (emul-A) to the chat with callee, then tap the
# voice call icon. Cooperative: app deep-link `chatyy://e2e/call-start?to=...`
# triggers the same code path as the UI button.
echo "[T1] tap_call_invite t=$(( $(date +%s) - T0 ))"
CALL_URL="chatyy://e2e/call-start?to=$(printf '%s' "$QA_CALLEE_EMAIL" | sed 's/@/%40/g')&kind=audio"
ssh -o StrictHostKeyChecking=no "${EMUL_USER:-root}@${EMUL_HOST:-213.136.72.141}" \
  "adb -s ${EMUL_A_SERIAL} shell am start -a android.intent.action.VIEW -d '${CALL_URL}'" \
  >/dev/null 2>&1 || true

TAP_T=$(date +%s)

# Assert: BOTH participants joined LK within 5s --------------------------
ROOM_ID=""  # we don't know room id upfront, so wait_for ignores room
if ! lk_wait_for "$LK_NDJSON" participantJoined "$QA_CALLER_EMAIL" "" 8; then
  adv_screencap "$EMUL_A_SERIAL" "$EVIDENCE_DIR/screen-A-fail.png" || true
  adv_logcat_dump "$EMUL_A_SERIAL" "$EVIDENCE_DIR/logcat-A-full.txt"
  emit FAIL LK_NO_JOIN "caller never joined LK room within 8s"
fi
if ! lk_wait_for "$LK_NDJSON" participantJoined "$QA_CALLEE_EMAIL" "" 10; then
  adv_screencap "$EMUL_B_SERIAL" "$EVIDENCE_DIR/screen-B-fail.png" || true
  adv_logcat_dump "$EMUL_B_SERIAL" "$EVIDENCE_DIR/logcat-B-full.txt"
  # This is the envelope-bug fingerprint: caller joined but callee never got
  # call_invite, so they never tried to join.
  WS_LOG="$EVIDENCE_DIR/ws-cpp.log"
  cppws_dump_since "$T0" "$WS_LOG"
  if ! cppws_check_envelopes "$WS_LOG" 2>"$EVIDENCE_DIR/cppws-check.stderr"; then
    cppws_verdict_json "$WS_LOG" > "$EVIDENCE_DIR/cppws-verdict.json"
    emit FAIL ENVELOPE_NOT_UNWRAPPED "callee no-join AND envelope_in without envelope_unwrap"
  fi
  emit FAIL LK_NO_JOIN "callee never joined LK within 10s of caller join"
fi

# Assert: audio track published on both sides -----------------------------
if ! lk_wait_for "$LK_NDJSON" trackPublished "$QA_CALLER_EMAIL" "" 10; then
  emit FAIL NO_AUDIO_TRACK "caller never published audio track"
fi
if ! lk_wait_for "$LK_NDJSON" trackPublished "$QA_CALLEE_EMAIL" "" 10; then
  emit FAIL NO_AUDIO_TRACK "callee never published audio track"
fi

# Crash check --------------------------------------------------------------
sleep 2
adv_logcat_dump "$EMUL_A_SERIAL" "$EVIDENCE_DIR/logcat-A.txt"
adv_logcat_dump "$EMUL_B_SERIAL" "$EVIDENCE_DIR/logcat-B.txt"
if grep -E 'AndroidRuntime.*FATAL' "$EVIDENCE_DIR/logcat-A.txt" >/dev/null 2>&1; then
  emit FAIL CRASH "caller AndroidRuntime FATAL"
fi
if grep -E 'AndroidRuntime.*FATAL' "$EVIDENCE_DIR/logcat-B.txt" >/dev/null 2>&1; then
  emit FAIL CRASH "callee AndroidRuntime FATAL"
fi

# Final WS sanity check (even on PASS, dump the slice for diff vs last-green) -
WS_LOG="$EVIDENCE_DIR/ws-cpp.log"
cppws_dump_since "$T0" "$WS_LOG"
cppws_verdict_json "$WS_LOG" > "$EVIDENCE_DIR/cppws-verdict.json"
CPPWS_STATUS=$(jq -r .cppws_status "$EVIDENCE_DIR/cppws-verdict.json" 2>/dev/null || echo unknown)
if [ "$CPPWS_STATUS" != "clean" ]; then
  emit FAIL "$CPPWS_STATUS" "C++ WS verdict not clean"
fi

# Post screenshots ---------------------------------------------------------
adv_screencap "$EMUL_A_SERIAL" "$EVIDENCE_DIR/screen-A-post.png" || true
adv_screencap "$EMUL_B_SERIAL" "$EVIDENCE_DIR/screen-B-post.png" || true

emit PASS "" "both joined, both audio, ws clean"
