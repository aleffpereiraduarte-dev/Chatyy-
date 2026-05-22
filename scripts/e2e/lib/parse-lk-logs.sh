#!/usr/bin/env bash
# parse-lk-logs.sh — extract LiveKit lifecycle events from docker logs
#
# LK self-hosted runs in container `livekit`. We pull logs since a wave-start
# timestamp (epoch seconds) and emit one JSON line per matched event to stdout
# so callers can `jq` it.
#
# Events emitted:
#   participantJoined { identity, room, t }
#   participantLeft   { identity, room, t }
#   trackPublished    { participant, kind, sid, t }
#   iceRestart        { participant, t }
#   egressStarted     { roomName, egressId, t }
#
# Usage:
#   lk_dump_since <epoch_seconds> > /tmp/lk-raw.log
#   lk_extract /tmp/lk-raw.log > /tmp/lk-events.ndjson
#   lk_wait_for /tmp/lk-events.ndjson participantJoined "duarte@chatyy.com.br" 5
#
# All functions assume the prod box (or ssh shim to it). PROD_HOST overridable.

set -u

: "${PROD_HOST:=217.216.67.99}"
: "${PROD_USER:=root}"
: "${LK_CONTAINER:=livekit}"

# Pull container logs since N seconds ago (uses --since, NOT --tail, for slicing)
lk_dump_since() {
  local since_epoch="$1" out="${2:-/dev/stdout}"
  local now=$(date +%s)
  local secs_ago=$(( now - since_epoch + 2 ))
  # Run docker on prod (or local if we already are prod)
  if [ "$(hostname -I 2>/dev/null | tr -d ' \n')" = "${PROD_HOST}" ] \
     || [ -S /var/run/docker.sock ]; then
    docker logs --since "${secs_ago}s" "${LK_CONTAINER}" 2>&1 > "$out" || true
  else
    ssh -o StrictHostKeyChecking=no "${PROD_USER}@${PROD_HOST}" \
      "docker logs --since ${secs_ago}s ${LK_CONTAINER} 2>&1" > "$out" || true
  fi
}

# Parse a raw LK log file into NDJSON events. LK logs are JSON-lines already;
# we use regex (not jq) to be tolerant of mid-line truncation.
lk_extract() {
  local raw="$1"
  # participantJoined  — match "participantJoined" with identity + room
  grep -E '"(msg|message)":"participant joined"|participantJoined' "$raw" 2>/dev/null \
    | while IFS= read -r line; do
        local ident room ts
        ident=$(echo "$line" | grep -oE '"identity":"[^"]+"' | head -1 | cut -d'"' -f4)
        room=$(echo "$line"  | grep -oE '"room":"[^"]+"'     | head -1 | cut -d'"' -f4)
        ts=$(echo "$line"    | grep -oE '"(time|ts)":"[^"]+"' | head -1 | cut -d'"' -f4)
        [ -z "$ident" ] && continue
        printf '{"event":"participantJoined","identity":"%s","room":"%s","t":"%s"}\n' \
          "$ident" "$room" "$ts"
      done

  grep -E '"(msg|message)":"participant left"|participantLeft' "$raw" 2>/dev/null \
    | while IFS= read -r line; do
        local ident room ts
        ident=$(echo "$line" | grep -oE '"identity":"[^"]+"' | head -1 | cut -d'"' -f4)
        room=$(echo "$line"  | grep -oE '"room":"[^"]+"'     | head -1 | cut -d'"' -f4)
        ts=$(echo "$line"    | grep -oE '"(time|ts)":"[^"]+"' | head -1 | cut -d'"' -f4)
        [ -z "$ident" ] && continue
        printf '{"event":"participantLeft","identity":"%s","room":"%s","t":"%s"}\n' \
          "$ident" "$room" "$ts"
      done

  grep -E '"(msg|message)":"track published"|trackPublished' "$raw" 2>/dev/null \
    | while IFS= read -r line; do
        local part kind sid ts
        part=$(echo "$line" | grep -oE '"(participant|identity)":"[^"]+"' | head -1 | cut -d'"' -f4)
        kind=$(echo "$line" | grep -oE '"kind":"[^"]+"' | head -1 | cut -d'"' -f4)
        sid=$(echo "$line"  | grep -oE '"(sid|trackID)":"[^"]+"' | head -1 | cut -d'"' -f4)
        ts=$(echo "$line"   | grep -oE '"(time|ts)":"[^"]+"' | head -1 | cut -d'"' -f4)
        [ -z "$part" ] && continue
        printf '{"event":"trackPublished","participant":"%s","kind":"%s","sid":"%s","t":"%s"}\n' \
          "$part" "$kind" "$sid" "$ts"
      done

  grep -E 'iceRestart|"ICE restart"' "$raw" 2>/dev/null \
    | while IFS= read -r line; do
        local part ts
        part=$(echo "$line" | grep -oE '"(participant|identity)":"[^"]+"' | head -1 | cut -d'"' -f4)
        ts=$(echo "$line"   | grep -oE '"(time|ts)":"[^"]+"' | head -1 | cut -d'"' -f4)
        printf '{"event":"iceRestart","participant":"%s","t":"%s"}\n' "$part" "$ts"
      done

  grep -E 'egressStarted|"egress started"' "$raw" 2>/dev/null \
    | while IFS= read -r line; do
        local room eid ts
        room=$(echo "$line" | grep -oE '"roomName":"[^"]+"' | head -1 | cut -d'"' -f4)
        eid=$(echo "$line"  | grep -oE '"egressID":"[^"]+"' | head -1 | cut -d'"' -f4)
        ts=$(echo "$line"   | grep -oE '"(time|ts)":"[^"]+"' | head -1 | cut -d'"' -f4)
        printf '{"event":"egressStarted","roomName":"%s","egressId":"%s","t":"%s"}\n' \
          "$room" "$eid" "$ts"
      done
}

# Wait for an event matching (event, identity, [room]) to appear in an NDJSON
# file that is being appended to. Polls every 0.5s.
#
# Args: ndjson_file event_name identity [room] timeout_seconds
# Returns 0 if found, 1 on timeout.
lk_wait_for() {
  local file="$1" ev="$2" ident="$3" room="${4:-}" timeout="${5:-10}"
  local deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -f "$file" ]; then
      if [ -n "$room" ]; then
        grep -E "\"event\":\"${ev}\"" "$file" 2>/dev/null \
          | grep -E "\"(identity|participant)\":\"${ident}\"" \
          | grep -qE "\"room(Name)?\":\"${room}\"" && return 0
      else
        grep -E "\"event\":\"${ev}\"" "$file" 2>/dev/null \
          | grep -qE "\"(identity|participant)\":\"${ident}\"" && return 0
      fi
    fi
    sleep 0.5
  done
  return 1
}

# Continuous tail+extract — runs in background, appends to NDJSON file.
# Caller is responsible for killing the PID (returned on stdout).
lk_tail_bg() {
  local out_ndjson="$1" since_epoch="$2"
  local raw="${out_ndjson}.raw"
  : > "$out_ndjson"
  (
    while true; do
      lk_dump_since "$since_epoch" "$raw"
      lk_extract "$raw" >> "$out_ndjson"
      sleep 2
    done
  ) &
  echo $!
}
