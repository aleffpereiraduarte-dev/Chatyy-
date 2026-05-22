#!/usr/bin/env bash
# run-wave.sh — orchestrate one E2E wave (T1..T10).
#
# Strategy: tests T1..T5 share emulators (sequential within pool 1), T6..T10
# in pool 2. Pools run in parallel. Each scenario gets its own evidence dir.
# At the end we aggregate into verdict.json and (optionally) upload dumps to
# R2 + ping Slack on any FAIL.
#
# Usage:
#   scripts/e2e/run-wave.sh [--out /tmp/e2e-run-<sha>] [--scenarios T1,T7]
#                           [--apk /tmp/chatyy.apk] [--sha $GITHUB_SHA]
#                           [--no-upload] [--no-slack]
#
# Env:
#   R2_BUCKET           default chatyy-e2e
#   R2_ENDPOINT         default https://<account>.r2.cloudflarestorage.com
#   AWS_ACCESS_KEY_ID   R2 access key
#   AWS_SECRET_ACCESS_KEY
#   SLACK_E2E_WEBHOOK   slack incoming webhook for alerts
#   EMUL_HOST, EMUL_USER, EMUL_SSHKEY (see android-device.sh)
#
# Exit codes:
#   0   all scenarios PASS (SKIP doesn't count as FAIL)
#   1   one or more scenarios FAIL
#   2   infra failure (couldn't even start)

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCEN_DIR="$SCRIPT_DIR/scenarios"
LIB_DIR="$SCRIPT_DIR/lib"

# --- Args ----------------------------------------------------------------
OUT_DIR=""
SCENARIOS_SEL=""
APK=""
SHA="${GITHUB_SHA:-$(date +%Y%m%d-%H%M%S)}"
DO_UPLOAD=1
DO_SLACK=1
MAX_WAVE_SECONDS="${MAX_WAVE_SECONDS:-600}"

while [ $# -gt 0 ]; do
  case "$1" in
    --out)        OUT_DIR="$2"; shift 2;;
    --scenarios)  SCENARIOS_SEL="$2"; shift 2;;
    --apk)        APK="$2"; shift 2;;
    --sha)        SHA="$2"; shift 2;;
    --no-upload)  DO_UPLOAD=0; shift;;
    --no-slack)   DO_SLACK=0; shift;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

OUT_DIR="${OUT_DIR:-/tmp/e2e-run-${SHA}}"
mkdir -p "$OUT_DIR"
echo "[wave] out=$OUT_DIR sha=$SHA"

# --- Pool definitions ----------------------------------------------------
# Pool 1: emulator-5554 + emulator-5556  (the existing AVDs)
POOL1=(T1 T2 T3 T8 T9)
# Pool 2: would use a third device for T6/T4/T5, plus headless for T10. We run
# T7 here because it reuses the same pair after pool 1 finishes (sequential
# within the pool — pool 2 starts after pool 1 to avoid emul contention until
# we add a 3rd device).
POOL2=(T7 T4 T5 T6 T10)

# Apply --scenarios filter
filter_pool() {
  local sel="$1"; shift
  local -a in=("$@") out=()
  if [ -z "$sel" ]; then
    printf '%s\n' "${in[@]}"; return
  fi
  IFS=',' read -ra want <<<"$sel"
  for t in "${in[@]}"; do
    for w in "${want[@]}"; do [ "$t" = "$w" ] && out+=("$t"); done
  done
  printf '%s\n' "${out[@]}"
}

mapfile -t P1 < <(filter_pool "$SCENARIOS_SEL" "${POOL1[@]}")
mapfile -t P2 < <(filter_pool "$SCENARIOS_SEL" "${POOL2[@]}")
echo "[wave] pool1: ${P1[*]:-<empty>}"
echo "[wave] pool2: ${P2[*]:-<empty>}"

# --- Preflight: reset adb daemon, optional APK install -------------------
# shellcheck source=lib/android-device.sh
source "$LIB_DIR/android-device.sh"

echo "[wave] preflight: reset adb on emul host"
adv_reset_adb || { echo "[wave] adb reset failed" >&2; exit 2; }

if [ -n "$APK" ] && [ -f "$APK" ]; then
  echo "[wave] installing APK on both emuls: $APK"
  adv_install_apk emulator-5554 "$APK" &
  adv_install_apk emulator-5556 "$APK" &
  wait
fi

if ! adv_wave_preflight emulator-5554 emulator-5556; then
  echo "[wave] preflight FAILED — emulators not ready" >&2
  cat > "$OUT_DIR/verdict.json" <<EOF
{"sha":"$SHA","status":"INFRA_FAILURE","reason":"emulator preflight failed","scenarios":[]}
EOF
  exit 2
fi

# --- Run a scenario sequentially -------------------------------------
run_one() {
  local t="$1"
  local script="$SCEN_DIR/${t}-"*.sh
  # Glob expansion → first match
  for s in $script; do
    if [ -x "$s" ] || [ -r "$s" ]; then
      local ev="$OUT_DIR/${t}"
      mkdir -p "$ev"
      echo "[wave] >> $t starting (ev=$ev)"
      bash "$s" "$ev" > "$ev/stdout.log" 2> "$ev/stderr.log"
      local rc=$?
      echo "[wave] << $t finished rc=$rc"
      return $rc
    fi
  done
  echo "[wave] $t: no script found" >&2
  return 127
}

# Run a pool sequentially in the background; print PID
run_pool_bg() {
  local pool_name="$1"; shift
  local -a items=("$@")
  (
    echo "[wave] pool=$pool_name start"
    for t in "${items[@]}"; do
      run_one "$t" || echo "[wave] pool=$pool_name $t non-zero"
    done
    echo "[wave] pool=$pool_name done"
  ) &
  echo $!
}

WAVE_START=$(date +%s)

PID1=""
PID2=""
if [ "${#P1[@]}" -gt 0 ]; then
  PID1=$(run_pool_bg pool1 "${P1[@]}")
fi
if [ "${#P2[@]}" -gt 0 ]; then
  # Stagger so pool2 doesn't fight pool1 for the same emul pair until we have
  # dedicated devices for pool2. For now: serialize the pools.
  ( wait "$PID1" 2>/dev/null; ) || true
  PID2=$(run_pool_bg pool2 "${P2[@]}")
fi

# Wave-level deadline guard
( sleep "$MAX_WAVE_SECONDS"; \
  [ -n "$PID1" ] && kill "$PID1" 2>/dev/null; \
  [ -n "$PID2" ] && kill "$PID2" 2>/dev/null; \
  echo "[wave] WAVE TIMED OUT at ${MAX_WAVE_SECONDS}s" >&2 ) &
WATCHDOG=$!

[ -n "$PID1" ] && wait "$PID1" 2>/dev/null || true
[ -n "$PID2" ] && wait "$PID2" 2>/dev/null || true
kill "$WATCHDOG" 2>/dev/null || true

WAVE_END=$(date +%s)
WAVE_DUR=$(( WAVE_END - WAVE_START ))

# --- Aggregate verdicts ----------------------------------------------
echo "[wave] aggregating verdicts (duration=${WAVE_DUR}s)"
ALL_PASS=1
HAS_FAIL=0
SCEN_JSON=""
for t in "${P1[@]}" "${P2[@]}"; do
  ev="$OUT_DIR/$t"
  vj="$ev/verdict.json"
  if [ -f "$vj" ]; then
    SCEN_JSON="${SCEN_JSON}$(cat "$vj"),"
    status=$(jq -r .status "$vj" 2>/dev/null || echo UNKNOWN)
    case "$status" in
      PASS)  : ;;
      SKIP)  : ;;
      *)     HAS_FAIL=1; ALL_PASS=0 ;;
    esac
  else
    SCEN_JSON="${SCEN_JSON}{\"id\":\"$t\",\"status\":\"MISSING\"},"
    HAS_FAIL=1; ALL_PASS=0
  fi
done
SCEN_JSON="[${SCEN_JSON%,}]"

OVERALL="PASS"
[ "$HAS_FAIL" -eq 1 ] && OVERALL="FAIL"

cat > "$OUT_DIR/verdict.json" <<EOF
{
  "sha": "$SHA",
  "status": "$OVERALL",
  "duration_s": $WAVE_DUR,
  "started_at": $WAVE_START,
  "scenarios": $SCEN_JSON
}
EOF
echo "[wave] verdict: $OVERALL"
cat "$OUT_DIR/verdict.json"

# --- Upload dumps + slack on FAIL ----------------------------------
if [ "$HAS_FAIL" -eq 1 ] && [ "$DO_UPLOAD" -eq 1 ] && [ -n "${R2_BUCKET:-}" ]; then
  DATE=$(date +%Y-%m-%d)
  if command -v aws >/dev/null 2>&1; then
    echo "[wave] uploading dumps to r2://${R2_BUCKET}/${DATE}/${SHA}/"
    aws s3 cp --recursive \
      --endpoint-url "${R2_ENDPOINT:-https://r2.cloudflarestorage.com}" \
      "$OUT_DIR/" "s3://${R2_BUCKET}/${DATE}/${SHA}/" || \
      echo "[wave] R2 upload failed (non-fatal)" >&2
  fi
fi

if [ "$HAS_FAIL" -eq 1 ] && [ "$DO_SLACK" -eq 1 ] && [ -n "${SLACK_E2E_WEBHOOK:-}" ]; then
  # Build a compact summary
  SUMMARY=$(jq -r '.scenarios[] | "\(.id): \(.status) \(.failure_class // "")"' "$OUT_DIR/verdict.json" 2>/dev/null | tr '\n' ' | ')
  curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"E2E wave FAIL on \`${SHA:0:7}\`\nDuration ${WAVE_DUR}s — ${SUMMARY}\nDumps: r2://${R2_BUCKET:-?}/${DATE:-today}/${SHA}/\"}" \
    "$SLACK_E2E_WEBHOOK" >/dev/null 2>&1 || true
fi

# --- Last-green pointer (optional, used by ship.sh in Phase 1) ----
if [ "$ALL_PASS" -eq 1 ]; then
  if [ -w /var/lib/e2e ] || mkdir -p /var/lib/e2e 2>/dev/null; then
    echo "$SHA" > /var/lib/e2e/last_green.txt 2>/dev/null || true
  fi
fi

[ "$HAS_FAIL" -eq 1 ] && exit 1 || exit 0
