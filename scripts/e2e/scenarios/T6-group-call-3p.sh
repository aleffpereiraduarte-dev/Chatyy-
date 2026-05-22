#!/usr/bin/env bash
# T6 — Group call with 3 participants. STUB.
# TODO: spin up a 3rd emulator (or use Mac 207 sim as #3), verify LK shows 3
#       participantJoined, each sees 2 remote video tiles.
set -u
EV="${1:-/tmp/e2e-T6-$$}"; mkdir -p "$EV"
cat > "$EV/verdict.json" <<EOF
{"id":"T6","name":"group-call-3p","status":"SKIP","failure_class":"STUB","detail":"needs 3rd device","duration_s":0,"evidence_dir":"$EV"}
EOF
echo "[T6] SKIP (stub)"
exit 0
