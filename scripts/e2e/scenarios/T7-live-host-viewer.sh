#!/usr/bin/env bash
# T7 — Live broadcast: host publishes video, viewer subscribes and sees frame.
#
# Pass criteria:
#   - LK `egressStarted` (or, for ingress-less setup, `trackPublished kind=video`
#     by host identity) within 8s of host action
#   - Viewer participantJoined to the host's room within 6s of opening watch
#   - Viewer receives first video frame (proxy: `trackSubscribed` in LK logs,
#     or for now: any `trackPublished` event observed FROM viewer side within
#     the wave window)
#
# Budget: 60s.
#
# Args / env match T1.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="$SCRIPT_DIR/../lib"
# shellcheck source=../lib/android-device.sh
source "$LIB/android-device.sh"
# shellcheck source=../lib/parse-lk-logs.sh
source "$LIB/parse-lk-logs.sh"
# shellcheck source=../lib/parse-cppws-logs.sh
source "$LIB/parse-cppws-logs.sh"

EVIDENCE_DIR="${1:-/tmp/e2e-T7-$$}"
export E2E_EVIDENCE_DIR="$EVIDENCE_DIR"
mkdir -p "$EVIDENCE_DIR"

: "${EMUL_HOST_SERIAL:=emulator-5554}"   # the LIVE host
: "${EMUL_VIEWER_SERIAL:=emulator-5556}" # the viewer
: "${T7_TIMEOUT:=60}"
: "${QA_HOST_EMAIL:=apitest@onemundo.com.br}"
: "${QA_HOST_PWD:=LBfypvbERr4cm1Hd1nZe3yT}"
: "${QA_VIEWER_EMAIL:=duarte@chatyy.com.br}"
: "${QA_VIEWER_PWD:=Aleff2009@@}"

emit() {
  local status="$1" failure_class="${2:-}" detail="${3:-}"
  local dur=$(( $(date +%s) - T0 ))
  cat > "$EVIDENCE_DIR/verdict.json" <<EOF
{
  "id": "T7",
  "name": "live-host-viewer",
  "status": "$status",
  "failure_class": "$failure_class",
  "detail": $(printf '%s' "$detail" | jq -Rs . 2>/dev/null || echo '""'),
  "duration_s": $dur,
  "host": "$QA_HOST_EMAIL",
  "viewer": "$QA_VIEWER_EMAIL",
  "evidence_dir": "$EVIDENCE_DIR"
}
EOF
  echo "[T7] $status ${failure_class}"
  if [ "$status" = "PASS" ]; then exit 0; else exit 1; fi
}

T0=$(date +%s)
echo "[T7] start t0=$T0 evidence=$EVIDENCE_DIR"

# Preflight ---------------------------------------------------------------
if ! adv_wave_preflight "$EMUL_HOST_SERIAL" "$EMUL_VIEWER_SERIAL"; then
  emit FAIL INFRA_FAILURE "emulator preflight failed"
fi

# Clean state -------------------------------------------------------------
adv_kill "$EMUL_HOST_SERIAL"
adv_kill "$EMUL_VIEWER_SERIAL"
sleep 1
adv_login "$EMUL_HOST_SERIAL"   "$QA_HOST_EMAIL"   "$QA_HOST_PWD"   || true
adv_login "$EMUL_VIEWER_SERIAL" "$QA_VIEWER_EMAIL" "$QA_VIEWER_PWD" || true
adv_fg "$EMUL_HOST_SERIAL"   || emit FAIL INFRA_FAILURE "fg host failed"
adv_fg "$EMUL_VIEWER_SERIAL" || emit FAIL INFRA_FAILURE "fg viewer failed"
sleep 4

# LK tail ------------------------------------------------------------------
LK_NDJSON="$EVIDENCE_DIR/lk-events.ndjson"
LK_TAIL_PID=$(lk_tail_bg "$LK_NDJSON" "$T0")
trap 'kill "$LK_TAIL_PID" 2>/dev/null || true' EXIT

# Host: start live -------------------------------------------------------
# Cooperative deep link: chatyy://e2e/live-start
HOST_URL="chatyy://e2e/live-start?title=e2e-t7&visibility=public"
ssh -o StrictHostKeyChecking=no "${EMUL_USER:-root}@${EMUL_HOST:-213.136.72.141}" \
  "adb -s ${EMUL_HOST_SERIAL} shell am start -a android.intent.action.VIEW -d '${HOST_URL}'" \
  >/dev/null 2>&1 || true

# Wait for host to publish video track ----------------------------------
if ! lk_wait_for "$LK_NDJSON" trackPublished "$QA_HOST_EMAIL" "" 12; then
  adv_screencap "$EMUL_HOST_SERIAL" "$EVIDENCE_DIR/screen-host-fail.png" || true
  adv_logcat_dump "$EMUL_HOST_SERIAL" "$EVIDENCE_DIR/logcat-host.txt"
  WS_LOG="$EVIDENCE_DIR/ws-cpp.log"; cppws_dump_since "$T0" "$WS_LOG"
  cppws_verdict_json "$WS_LOG" > "$EVIDENCE_DIR/cppws-verdict.json"
  emit FAIL LK_NO_PUBLISH "host never published video track within 12s"
fi

# Extract room id from the first participantJoined for host -------------
HOST_ROOM=$(grep -E '"event":"participantJoined"' "$LK_NDJSON" 2>/dev/null \
  | grep -E "\"identity\":\"${QA_HOST_EMAIL}\"" \
  | grep -oE '"room":"[^"]+"' | head -1 | cut -d'"' -f4)
echo "[T7] host_room=${HOST_ROOM}"

# Viewer: open watch screen --------------------------------------------
VIEW_URL="chatyy://e2e/live-watch?host=$(printf '%s' "$QA_HOST_EMAIL" | sed 's/@/%40/g')"
ssh -o StrictHostKeyChecking=no "${EMUL_USER:-root}@${EMUL_HOST:-213.136.72.141}" \
  "adb -s ${EMUL_VIEWER_SERIAL} shell am start -a android.intent.action.VIEW -d '${VIEW_URL}'" \
  >/dev/null 2>&1 || true

# Wait for viewer to join the room -------------------------------------
if ! lk_wait_for "$LK_NDJSON" participantJoined "$QA_VIEWER_EMAIL" "$HOST_ROOM" 8; then
  adv_screencap "$EMUL_VIEWER_SERIAL" "$EVIDENCE_DIR/screen-viewer-fail.png" || true
  adv_logcat_dump "$EMUL_VIEWER_SERIAL" "$EVIDENCE_DIR/logcat-viewer.txt"
  emit FAIL VIEWER_NO_JOIN "viewer never joined host's room within 8s"
fi

# First-frame proxy: viewer must remain in the room for >= 4s without leaving,
# AND we should see no FATAL crash. (Real first-frame OCR is added in Phase 2.)
sleep 5
if grep -E "\"event\":\"participantLeft\"" "$LK_NDJSON" 2>/dev/null \
   | grep -qE "\"identity\":\"${QA_VIEWER_EMAIL}\""; then
  adv_logcat_dump "$EMUL_VIEWER_SERIAL" "$EVIDENCE_DIR/logcat-viewer.txt"
  emit FAIL VIEWER_DROPPED "viewer left room within 5s — likely no subscribe / no frames"
fi

adv_logcat_dump "$EMUL_HOST_SERIAL"   "$EVIDENCE_DIR/logcat-host.txt"
adv_logcat_dump "$EMUL_VIEWER_SERIAL" "$EVIDENCE_DIR/logcat-viewer.txt"
adv_screencap   "$EMUL_VIEWER_SERIAL" "$EVIDENCE_DIR/screen-viewer-watching.png" || true

if grep -E 'AndroidRuntime.*FATAL' "$EVIDENCE_DIR/logcat-host.txt" "$EVIDENCE_DIR/logcat-viewer.txt" >/dev/null 2>&1; then
  emit FAIL CRASH "AndroidRuntime FATAL during live"
fi

WS_LOG="$EVIDENCE_DIR/ws-cpp.log"
cppws_dump_since "$T0" "$WS_LOG"
cppws_verdict_json "$WS_LOG" > "$EVIDENCE_DIR/cppws-verdict.json"

emit PASS "" "host published, viewer joined room=${HOST_ROOM}, stayed connected"
