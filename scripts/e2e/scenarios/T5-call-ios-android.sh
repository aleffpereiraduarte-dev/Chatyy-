#!/usr/bin/env bash
# T5 — iOS sim caller → Android callee. STUB.
# TODO: reverse of T4.
set -u
EV="${1:-/tmp/e2e-T5-$$}"; mkdir -p "$EV"
cat > "$EV/verdict.json" <<EOF
{"id":"T5","name":"call-ios-android","status":"SKIP","failure_class":"STUB","detail":"requires Mac 207 sim integration","duration_s":0,"evidence_dir":"$EV"}
EOF
echo "[T5] SKIP (stub)"
exit 0
