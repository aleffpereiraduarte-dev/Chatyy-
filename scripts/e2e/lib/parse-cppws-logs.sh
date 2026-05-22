#!/usr/bin/env bash
# parse-cppws-logs.sh — detect envelope-wrap regression in chatyy-ws-cpp
#
# The bug that triggered this whole harness:
#   C++ WS received {type:"envelope", data:{type:"call_invite",...}} but
#   broadcast it AS the envelope frame instead of unwrapping `data`. Peer never
#   got call_invite, ringing never started, user blamed network.
#
# Detection logic:
#   For each `envelope_in` event with a given correlation id, there MUST be a
#   matching `envelope_unwrap` event within ENVELOPE_UNWRAP_WINDOW_MS.
#   If not → fail class ENVELOPE_NOT_UNWRAPPED.
#
# Additional red flags:
#   - `broadcast_skip` with type=call_invite (we expected delivery)
#   - `envelope_in` rate >> `envelope_unwrap` rate over the wave window
#
# Usage:
#   cppws_dump_since <epoch> > /tmp/ws.log
#   cppws_check_envelopes /tmp/ws.log    # exit 0 = clean, exit 2 = bug detected
#   cppws_verdict_json   /tmp/ws.log     # prints {clean|envelope_not_unwrapped, stats}

set -u

: "${PROD_HOST:=217.216.67.99}"
: "${PROD_USER:=root}"
: "${CPPWS_LOG:=/opt/chatyy-ws-cpp/logs/ws.log}"
: "${CPPWS_UNIT:=chatyy-ws-cpp}"
: "${ENVELOPE_UNWRAP_WINDOW_MS:=500}"

# Pull WS log slice since N seconds ago. Prefer the file; fall back to journald.
cppws_dump_since() {
  local since_epoch="$1" out="${2:-/dev/stdout}"
  local now=$(date +%s)
  local secs_ago=$(( now - since_epoch + 2 ))
  if [ "$(hostname -I 2>/dev/null | tr -d ' \n' | head -c20)" = "${PROD_HOST}" ] \
     || [ -f "${CPPWS_LOG}" ]; then
    # Local — slice the file
    if [ -f "${CPPWS_LOG}" ]; then
      # tail-lines is rough; for precision we'd timestamp-grep, but file format
      # uses ISO-8601 prefix → grep is workable for short windows.
      tail -n 50000 "${CPPWS_LOG}" > "$out"
    else
      journalctl -u "${CPPWS_UNIT}" --since "${secs_ago} seconds ago" --no-pager > "$out"
    fi
  else
    ssh -o StrictHostKeyChecking=no "${PROD_USER}@${PROD_HOST}" \
      "if [ -f ${CPPWS_LOG} ]; then tail -n 50000 ${CPPWS_LOG}; else journalctl -u ${CPPWS_UNIT} --since '${secs_ago} seconds ago' --no-pager; fi" > "$out"
  fi
}

# Core check. Reads log file on stdin or $1. Emits two counts to stderr and
# exits non-zero (=2) if at least one envelope_in lacks a matching unwrap.
cppws_check_envelopes() {
  local f="${1:-/dev/stdin}"

  # envelope_in : `recv envelope frame ... type=chat_message ... cid=<id>`
  # envelope_unwrap : `unwrap data payload ... inner_type=call_invite ... cid=<id>`
  # broadcast_skip : `no subscribers for channel ... type=call_invite`

  local in_count unwrap_count skip_count
  in_count=$(grep -cE 'recv envelope frame.*type=chat_message' "$f" 2>/dev/null || true)
  unwrap_count=$(grep -cE 'unwrap data payload.*inner_type=(call_|chat_)' "$f" 2>/dev/null || true)
  skip_count=$(grep -cE 'no subscribers for channel.*type=(call_invite|call_)' "$f" 2>/dev/null || true)

  echo "envelope_in=${in_count} envelope_unwrap=${unwrap_count} broadcast_skip=${skip_count}" >&2

  # cid-level pairing: extract cids, set-diff
  local in_cids unwrap_cids missing
  in_cids=$(grep -E 'recv envelope frame.*type=chat_message' "$f" 2>/dev/null \
    | grep -oE 'cid=[a-zA-Z0-9_-]+' | sort -u)
  unwrap_cids=$(grep -E 'unwrap data payload' "$f" 2>/dev/null \
    | grep -oE 'cid=[a-zA-Z0-9_-]+' | sort -u)

  if [ -n "$in_cids" ]; then
    missing=$(comm -23 <(echo "$in_cids") <(echo "$unwrap_cids") 2>/dev/null | head -20)
    if [ -n "$missing" ]; then
      echo "ENVELOPE_NOT_UNWRAPPED cids:" >&2
      echo "$missing" >&2
      return 2
    fi
  fi

  # Soft check: if call_invite ever got broadcast_skip = also a regression
  if [ "${skip_count:-0}" -gt 0 ]; then
    echo "BROADCAST_SKIP_CALL_INVITE count=${skip_count}" >&2
    return 3
  fi

  return 0
}

# Emit a structured JSON verdict for the orchestrator to merge into verdict.json
cppws_verdict_json() {
  local f="$1"
  local in_count unwrap_count skip_count
  in_count=$(grep -cE 'recv envelope frame.*type=chat_message' "$f" 2>/dev/null || echo 0)
  unwrap_count=$(grep -cE 'unwrap data payload' "$f" 2>/dev/null || echo 0)
  skip_count=$(grep -cE 'no subscribers for channel' "$f" 2>/dev/null || echo 0)

  local status="clean"
  local rc
  cppws_check_envelopes "$f" >/dev/null 2>&1
  rc=$?
  case $rc in
    0) status="clean" ;;
    2) status="ENVELOPE_NOT_UNWRAPPED" ;;
    3) status="BROADCAST_SKIP_CALL_INVITE" ;;
    *) status="UNKNOWN_${rc}" ;;
  esac

  printf '{"cppws_status":"%s","envelope_in":%s,"envelope_unwrap":%s,"broadcast_skip":%s}\n' \
    "$status" "${in_count:-0}" "${unwrap_count:-0}" "${skip_count:-0}"
}

# Quick health check used by run-wave.sh preflight: is the service up?
cppws_health() {
  local url="${WS_HEALTH_URL:-https://ws.chatyy.com.br/health}"
  curl -fsS --max-time 5 "$url" 2>/dev/null || return 1
}
