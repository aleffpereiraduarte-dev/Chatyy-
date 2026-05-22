#!/usr/bin/env bash
# T3 — Callee screen locked. STUB.
# TODO: input keyevent 26 on emul-B, verify wake lock + call UI on top of keyguard.
set -u
EV="${1:-/tmp/e2e-T3-$$}"; mkdir -p "$EV"
cat > "$EV/verdict.json" <<EOF
{"id":"T3","name":"call-screen-locked","status":"SKIP","failure_class":"STUB","detail":"not implemented","duration_s":0,"evidence_dir":"$EV"}
EOF
echo "[T3] SKIP (stub)"
exit 0
