#!/usr/bin/env bash
# android-device.sh — adb helpers for E2E test scenarios
#
# Reuses existing emulator infra (213.136.72.141, emulator-5554/5556).
# All functions take SERIAL as first arg ($1) so callers stay device-agnostic.
#
# Required env:
#   EMUL_HOST   default 213.136.72.141
#   EMUL_USER   default root
#   EMUL_SSH    default ssh -o StrictHostKeyChecking=no $EMUL_USER@$EMUL_HOST
#
# Usage:
#   source scripts/e2e/lib/android-device.sh
#   adv_login emulator-5554 duarte@chatyy.com.br 'Aleff2009@@'
#   adv_screencap emulator-5554 /tmp/dump.png
#   adv_logcat_grep emulator-5554 'call_invite' 30

set -u

: "${EMUL_HOST:=213.136.72.141}"
: "${EMUL_USER:=root}"
: "${EMUL_SSHKEY:=$HOME/.ssh/id_ed25519_emul}"

# Wrap a remote adb command. We shell into the emul host (no adb-over-WAN).
_adb() {
  local serial="$1"; shift
  # If SSHPASS is set, use sshpass; else rely on key in EMUL_SSHKEY or agent.
  if [ -n "${SSHPASS:-}" ]; then
    sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
      "${EMUL_USER}@${EMUL_HOST}" "adb -s ${serial} $*"
  elif [ -f "${EMUL_SSHKEY}" ]; then
    ssh -i "${EMUL_SSHKEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
      "${EMUL_USER}@${EMUL_HOST}" "adb -s ${serial} $*"
  else
    ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
      "${EMUL_USER}@${EMUL_HOST}" "adb -s ${serial} $*"
  fi
}

# Check device is online & boot completed
adv_ready() {
  local serial="$1"
  local state
  state="$(_adb "$serial" get-state 2>/dev/null | tr -d '\r\n')"
  [ "$state" = "device" ] || return 1
  local boot
  boot="$(_adb "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n')"
  [ "$boot" = "1" ]
}

# Force-stop the app (clean state per scenario)
adv_kill() {
  local serial="$1"
  _adb "$serial" shell am force-stop com.onemundo.mail 2>/dev/null || true
  _adb "$serial" shell am force-stop com.chatyy 2>/dev/null || true
}

# Foreground the app — tries both possible package names
adv_fg() {
  local serial="$1"
  _adb "$serial" shell monkey -p com.onemundo.mail -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 \
    || _adb "$serial" shell monkey -p com.chatyy -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 \
    || return 1
}

# Write QA credentials to /sdcard so the app picks them up on launch.
# App is expected to read /sdcard/qa_creds.json when E2E_MODE=1 (cooperative).
adv_login() {
  local serial="$1" email="$2" password="$3"
  local payload
  payload=$(printf '{"email":"%s","password":"%s","e2e":true,"ts":%s}' \
    "$email" "$password" "$(date +%s)")
  # Push via stdin to avoid scp dance
  _adb "$serial" shell "run-as com.onemundo.mail sh -c 'cat > /sdcard/qa_creds.json'" <<<"$payload" 2>/dev/null \
    || _adb "$serial" shell "echo '$payload' > /sdcard/qa_creds.json"
}

# Simple coordinate tap
adv_tap() {
  local serial="$1" x="$2" y="$3"
  _adb "$serial" shell input tap "$x" "$y"
}

# Tap by resource-id — dumps UI hierarchy, greps coords, taps midpoint
adv_tap_id() {
  local serial="$1" rid="$2"
  local dump bounds x1 y1 x2 y2 cx cy
  dump="$(_adb "$serial" exec-out uiautomator dump /dev/tty 2>/dev/null \
    | tr -d '\r' | tr '>' '\n' || true)"
  bounds=$(echo "$dump" | grep -m1 "resource-id=\"$rid\"" \
    | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' \
    | grep -oE '[0-9]+' || true)
  [ -z "$bounds" ] && return 1
  read -r x1 y1 x2 y2 <<<"$(echo "$bounds" | tr '\n' ' ')"
  cx=$(( (x1 + x2) / 2 ))
  cy=$(( (y1 + y2) / 2 ))
  _adb "$serial" shell input tap "$cx" "$cy"
}

# Screencap → local PNG file
adv_screencap() {
  local serial="$1" dest="$2"
  if [ -n "${SSHPASS:-}" ]; then
    sshpass -e ssh -o StrictHostKeyChecking=no "${EMUL_USER}@${EMUL_HOST}" \
      "adb -s ${serial} exec-out screencap -p" > "$dest"
  else
    ssh -o StrictHostKeyChecking=no "${EMUL_USER}@${EMUL_HOST}" \
      "adb -s ${serial} exec-out screencap -p" > "$dest"
  fi
  [ -s "$dest" ]
}

# Grep logcat for a pattern, with timeout. Returns 0 if found within $timeout s.
# Side-effect: appends the full slice to ${E2E_EVIDENCE_DIR}/logcat-<serial>.txt
adv_logcat_grep() {
  local serial="$1" pattern="$2" timeout="${3:-30}"
  local since
  since="$(date '+%m-%d %H:%M:%S.000')"
  local deadline=$(( $(date +%s) + timeout ))
  local out=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    out="$(_adb "$serial" logcat -d -t "$since" 2>/dev/null | grep -E "$pattern" || true)"
    if [ -n "$out" ]; then
      if [ -n "${E2E_EVIDENCE_DIR:-}" ]; then
        mkdir -p "${E2E_EVIDENCE_DIR}"
        echo "$out" >> "${E2E_EVIDENCE_DIR}/logcat-${serial}.txt"
      fi
      return 0
    fi
    sleep 1
  done
  return 1
}

# Dump full logcat since boot to evidence dir (for failure forensics)
adv_logcat_dump() {
  local serial="$1" dest="$2"
  _adb "$serial" logcat -d > "$dest" 2>/dev/null || true
}

# Wifi on/off (T9)
adv_wifi() {
  local serial="$1" state="$2"   # on|off
  if [ "$state" = "on" ]; then
    _adb "$serial" shell svc wifi enable
  else
    _adb "$serial" shell svc wifi disable
  fi
}

# Screen off / unlock (T3)
adv_screen_off() { _adb "$1" shell input keyevent 26; }
adv_unlock()     { _adb "$1" shell input keyevent 82; }

# Quick health check — both serials reachable + booted
adv_wave_preflight() {
  local serials=("$@")
  for s in "${serials[@]}"; do
    if ! adv_ready "$s"; then
      echo "PREFLIGHT_FAIL: $s not ready" >&2
      return 1
    fi
  done
  return 0
}

# Reset adb daemon on the emul host (call once at wave start)
adv_reset_adb() {
  if [ -n "${SSHPASS:-}" ]; then
    sshpass -e ssh -o StrictHostKeyChecking=no "${EMUL_USER}@${EMUL_HOST}" \
      "adb kill-server >/dev/null 2>&1; adb start-server >/dev/null 2>&1; sleep 2; adb devices"
  else
    ssh -o StrictHostKeyChecking=no "${EMUL_USER}@${EMUL_HOST}" \
      "adb kill-server >/dev/null 2>&1; adb start-server >/dev/null 2>&1; sleep 2; adb devices"
  fi
}

# Install APK (sync from local to emul host, then adb install -r)
adv_install_apk() {
  local serial="$1" local_apk="$2"
  local remote="/tmp/chatyy-e2e.apk"
  if [ -n "${SSHPASS:-}" ]; then
    sshpass -e scp -o StrictHostKeyChecking=no "$local_apk" \
      "${EMUL_USER}@${EMUL_HOST}:$remote"
  else
    scp -o StrictHostKeyChecking=no "$local_apk" \
      "${EMUL_USER}@${EMUL_HOST}:$remote"
  fi
  _adb "$serial" install -r "$remote"
}
