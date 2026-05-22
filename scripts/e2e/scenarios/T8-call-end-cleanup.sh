#!/usr/bin/env bash
# T8 — Call end cleanup. STUB.
# TODO: run T1 inline, then hang up, assert call_end WS event both sides,
#       UI dismissed within 2s, LK participantLeft, PG chat_calls.ended_at populated.
set -u
EV="${1:-/tmp/e2e-T8-$$}"; mkdir -p "$EV"
cat > "$EV/verdict.json" <<EOF
{"id":"T8","name":"call-end-cleanup","status":"SKIP","failure_class":"STUB","detail":"not implemented","duration_s":0,"evidence_dir":"$EV"}
EOF
echo "[T8] SKIP (stub)"
exit 0
