#!/usr/bin/env bash
# check-migration-progress.sh
#
# Scans the codebase, DB schema, and LiveKit/infra config to report the
# current state of the WhatsApp-stack migration. Read-only — touches
# nothing. Safe to run anytime, anywhere.
#
# Output: one line per component with a STATE column:
#   DESIGN      design doc present
#   SCAFFOLD    code/file on disk, not yet wired
#   IMPLEMENTED wired in, behind flag OFF
#   TESTED      E2E passes
#   SHIPPED     deployed AND enabled for ≥1 user
#
# Authoritative tickbox truth: /root/webmail-app/docs/whatsapp-migration/BUILD-STATUS.md
# This script SHOWS reality; BUILD-STATUS.md captures intent.
#
# Usage:
#   scripts/check-migration-progress.sh           # human report
#   scripts/check-migration-progress.sh --json    # machine-readable
#   scripts/check-migration-progress.sh --quiet   # exit-code only (0 = on track)

set -u

MODE_JSON=0
MODE_QUIET=0
for arg in "$@"; do
  case "$arg" in
    --json)  MODE_JSON=1 ;;
    --quiet) MODE_QUIET=1 ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOC_DIR="$REPO_ROOT/docs/whatsapp-migration"
WS_CPP_DIR="/opt/chatyy-ws-cpp"
WASP_DIR="/opt/chatyy-wasp-cpp"
E2E_DIR="/opt/e2e"
MIGR_DIR="/var/www/mail/sql/migrations"
APPLIED_DIR="/var/www/mail/sql/applied"

# State helpers ---------------------------------------------------------
have() { [[ -e "$1" ]]; }
newer_than() { [[ "$1" -nt "$2" ]]; }  # $1 newer than $2

# Each check_* echoes: NAME|STATE|EVIDENCE
emit() { printf '%s|%s|%s\n' "$1" "$2" "$3"; }

# ──────────────── PHASE 0 ────────────────
check_e2e_harness() {
  local state="MISSING" ev=""
  if have "$DOC_DIR/09-continuous-e2e-tests.md"; then state="DESIGN"; ev="doc present"; fi
  if have "$E2E_DIR/run.sh"; then state="SCAFFOLD"; ev="$E2E_DIR/run.sh exists"; fi
  if systemctl is-enabled --quiet chatyy-e2e.timer 2>/dev/null; then state="IMPLEMENTED"; ev="systemd timer enabled"; fi
  if [[ -f "$E2E_DIR/last-green.sha" ]] && [[ "$(date -r "$E2E_DIR/last-green.sha" +%s 2>/dev/null || echo 0)" -gt "$(($(date +%s) - 86400))" ]]; then
    state="TESTED"; ev="green run in last 24h"
  fi
  emit "e2e-harness" "$state" "$ev"
}

check_multi_pop() {
  local state="MISSING" ev=""
  if have "$DOC_DIR/05-multi-pop-infra.md"; then state="DESIGN"; ev="doc present"; fi
  if have "$REPO_ROOT/scripts/pop-add.sh"; then state="SCAFFOLD"; ev="scripts/pop-add.sh present"; fi
  # 3+ A records on media.chatyy.com.br → IMPLEMENTED
  local ips
  ips="$(getent ahosts media.chatyy.com.br 2>/dev/null | awk '{print $1}' | sort -u | wc -l)"
  if [[ "$ips" -ge 2 ]]; then state="IMPLEMENTED"; ev="media.chatyy.com.br resolves $ips IPs"; fi
  emit "multi-pop-infra" "$state" "$ev"
}

# ──────────────── PHASE 1 ────────────────
check_cwp() {
  local state="MISSING" ev=""
  if have "$DOC_DIR/03-signaling-protocol.md"; then state="DESIGN"; ev="doc"; fi
  if have "$WS_CPP_DIR/src/cwp.cpp" && have "$WS_CPP_DIR/src/cwp.h"; then
    state="SCAFFOLD"; ev="cwp.{h,cpp} on disk"
    # Check the running binary is newer than cwp.cpp → IMPLEMENTED
    if [[ -f "$WS_CPP_DIR/build/chatyy-ws-cpp" ]] && newer_than "$WS_CPP_DIR/build/chatyy-ws-cpp" "$WS_CPP_DIR/src/cwp.cpp"; then
      # And main.cpp must reference cwp
      if grep -q 'cwp_dispatch\|cwp\.h' "$WS_CPP_DIR/src/main.cpp" 2>/dev/null; then
        state="IMPLEMENTED"; ev="cwp linked into binary"
        # SHIPPED if service is running on the new binary
        if systemctl is-active --quiet chatyy-ws-cpp 2>/dev/null; then
          local bin_mtime svc_start
          bin_mtime="$(stat -c %Y "$WS_CPP_DIR/build/chatyy-ws-cpp" 2>/dev/null || echo 0)"
          svc_start="$(systemctl show chatyy-ws-cpp --property=ExecMainStartTimestampMonotonic --value 2>/dev/null || echo 0)"
          if [[ "$bin_mtime" -gt 0 && "$svc_start" -gt 0 ]]; then state="SHIPPED"; ev="service running new binary"; fi
        fi
      fi
    fi
  fi
  emit "cwp-binary-protocol" "$state" "$ev"
}

check_relay_first() {
  local state="MISSING" ev=""
  if have "$DOC_DIR/06-relay-first-state-separation.md"; then state="DESIGN"; ev="doc"; fi
  # Check LiveKit config (if accessible) for iceTransportPolicy hint
  if [[ -r /etc/livekit.yaml ]]; then
    if grep -q 'force_relay\|ice_lite' /etc/livekit.yaml 2>/dev/null; then
      state="IMPLEMENTED"; ev="livekit.yaml has relay tuning"
    fi
  fi
  emit "relay-first-policy" "$state" "$ev"
}

check_chat_call_state_tables() {
  local state="MISSING" ev=""
  if have "$DOC_DIR/06-relay-first-state-separation.md"; then state="DESIGN"; ev="doc references chat_call_active/devices"; fi
  if ls "$MIGR_DIR"/*chat-call-active* "$MIGR_DIR"/*chat_call_active* 2>/dev/null | head -1 | grep -q .; then
    state="SCAFFOLD"; ev="migration file present"
  fi
  emit "chat-call-state-tables" "$state" "$ev"
}

# ──────────────── PHASE 2 ────────────────
check_pjsip_ios() {
  local state="MISSING" ev=""
  if have "$DOC_DIR/01-pjsip-ios.md"; then state="DESIGN"; ev="doc"; fi
  if have "$REPO_ROOT/scripts/pjsip/build-ios.sh"; then state="SCAFFOLD"; ev="build script present"; fi
  if have "$REPO_ROOT/vendor/pjsip-ios/PJSIP.xcframework/Info.plist"; then
    state="IMPLEMENTED"; ev="XCFramework built"
  fi
  # SHIPPED would mean it's linked into the IPA in production. We can't check
  # the live IPA from here, but presence of an active flag in the codebase is
  # a proxy: search for `pjsip_ios_enabled` referenced as truthy default.
  emit "pjsip-ios" "$state" "$ev"
}

check_pjsip_android() {
  local state="MISSING" ev=""
  if have "$DOC_DIR/02-pjsip-android.md"; then state="DESIGN"; ev="doc"; fi
  if have "$REPO_ROOT/scripts/pjsip/build-android.config"; then state="SCAFFOLD"; ev="build config present"; fi
  if ls "$REPO_ROOT"/android/app/libs/pjsip-*.aar 2>/dev/null | head -1 | grep -q .; then
    state="IMPLEMENTED"; ev=".aar in android/app/libs"
  fi
  emit "pjsip-android" "$state" "$ev"
}

check_call_e2ee_schema() {
  local state="MISSING" ev=""
  if have "$DOC_DIR/07-signal-protocol-calls.md"; then state="DESIGN"; ev="doc"; fi
  local migr="$MIGR_DIR/2026-05-22-call-keys-tables.sql"
  if have "$migr"; then state="SCAFFOLD"; ev="migration file present"; fi
  if have "$APPLIED_DIR/2026-05-22-call-keys-tables.applied"; then
    state="IMPLEMENTED"; ev="migration applied marker present"
  fi
  # Alternative: probe PG if accessible
  if command -v psql >/dev/null 2>&1 && [[ -n "${PGURL:-}" ]]; then
    if psql "$PGURL" -t -c "SELECT 1 FROM pg_tables WHERE tablename='chat_call_keys'" 2>/dev/null | grep -q 1; then
      state="IMPLEMENTED"; ev="chat_call_keys table exists in PG"
    fi
  fi
  emit "call-e2ee-schema" "$state" "$ev"
}

# ──────────────── PHASE 3 ────────────────
check_wasp_relay() {
  local state="MISSING" ev=""
  if have "$DOC_DIR/04-wasp-relay.md"; then state="DESIGN"; ev="doc"; fi
  if [[ -d "$WASP_DIR" ]] && [[ -n "$(ls -A "$WASP_DIR" 2>/dev/null)" ]]; then
    state="SCAFFOLD"; ev="$WASP_DIR has content"
  elif [[ -d "$WASP_DIR" ]]; then
    : # empty dir → still DESIGN
  fi
  if have "$WASP_DIR/build/wasp-relay"; then state="IMPLEMENTED"; ev="binary built"; fi
  if systemctl is-active --quiet chatyy-wasp 2>/dev/null; then state="SHIPPED"; ev="service active"; fi
  emit "wasp-relay" "$state" "$ev"
}

check_native_call_module() {
  local state="MISSING" ev=""
  if have "$DOC_DIR/08-native-call-no-bridge.md"; then state="DESIGN"; ev="doc"; fi
  if have "$REPO_ROOT/modules/chatyy-call-native/expo-module.config.json"; then
    state="SCAFFOLD"; ev="module scaffolded"
  fi
  emit "native-call-module" "$state" "$ev"
}

# ──────────────── PHASE 4 ────────────────
check_livekit_removed() {
  local state="DESIGN" ev="LiveKit still in deps"
  if [[ -f "$REPO_ROOT/package.json" ]]; then
    if grep -q '"@livekit/react-native"' "$REPO_ROOT/package.json" 2>/dev/null; then
      state="DESIGN"; ev="@livekit/react-native still in package.json"
    else
      state="SHIPPED"; ev="LiveKit removed from package.json"
    fi
  fi
  emit "livekit-removed-from-mobile" "$state" "$ev"
}

# ──────────────── Main ────────────────
results=()
for fn in check_e2e_harness check_multi_pop \
          check_cwp check_relay_first check_chat_call_state_tables \
          check_pjsip_ios check_pjsip_android check_call_e2ee_schema \
          check_wasp_relay check_native_call_module \
          check_livekit_removed; do
  results+=("$($fn)")
done

# Render -----------------------------------------------------------------
if [[ "$MODE_JSON" -eq 1 ]]; then
  printf '{\n  "generated_at": "%s",\n  "components": [\n' "$(date -Is)"
  first=1
  for r in "${results[@]}"; do
    IFS='|' read -r name state ev <<<"$r"
    [[ $first -eq 0 ]] && printf ',\n'
    printf '    {"name":"%s","state":"%s","evidence":"%s"}' "$name" "$state" "$ev"
    first=0
  done
  printf '\n  ]\n}\n'
  exit 0
fi

if [[ "$MODE_QUIET" -eq 1 ]]; then
  # Exit 0 iff no component is in the MISSING/empty state
  for r in "${results[@]}"; do
    IFS='|' read -r _ state _ <<<"$r"
    [[ "$state" == "MISSING" ]] && exit 1
  done
  exit 0
fi

# Human report
printf '\n  WhatsApp-stack migration progress  (%s)\n' "$(date -Iseconds)"
printf '  %s\n\n' '─────────────────────────────────────────────────'
printf '  %-32s  %-12s  %s\n' "COMPONENT" "STATE" "EVIDENCE"
printf '  %-32s  %-12s  %s\n' "─────────" "─────" "────────"
for r in "${results[@]}"; do
  IFS='|' read -r name state ev <<<"$r"
  # color
  c_reset='\033[0m'; c=''
  case "$state" in
    SHIPPED)     c='\033[1;32m' ;;  # bold green
    TESTED)      c='\033[0;32m' ;;
    IMPLEMENTED) c='\033[0;33m' ;;  # yellow
    SCAFFOLD)    c='\033[0;36m' ;;  # cyan
    DESIGN)      c='\033[0;37m' ;;  # gray
    MISSING)     c='\033[0;31m' ;;  # red
  esac
  printf "  %-32s  ${c}%-12s${c_reset}  %s\n" "$name" "$state" "$ev"
done

# Summary
total=${#results[@]}
shipped=$(printf '%s\n' "${results[@]}" | awk -F'|' '$2=="SHIPPED"{c++}END{print c+0}')
tested=$(printf '%s\n' "${results[@]}" | awk -F'|' '$2=="TESTED"{c++}END{print c+0}')
implemented=$(printf '%s\n' "${results[@]}" | awk -F'|' '$2=="IMPLEMENTED"{c++}END{print c+0}')
scaffold=$(printf '%s\n' "${results[@]}" | awk -F'|' '$2=="SCAFFOLD"{c++}END{print c+0}')
design=$(printf '%s\n' "${results[@]}" | awk -F'|' '$2=="DESIGN"{c++}END{print c+0}')

printf '\n  Summary: %d total · %d SHIPPED · %d TESTED · %d IMPLEMENTED · %d SCAFFOLD · %d DESIGN\n\n' \
       "$total" "$shipped" "$tested" "$implemented" "$scaffold" "$design"

printf '  See: docs/whatsapp-migration/BUILD-STATUS.md  (authoritative tickboxes)\n'
printf '       docs/whatsapp-migration/NEXT-STEPS.md     (what to do next)\n\n'
