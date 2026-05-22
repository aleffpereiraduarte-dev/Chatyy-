#!/usr/bin/env bash
# T4 — Android caller → iOS sim callee. STUB.
# TODO: boot Mac 207 iOS sim, install build, login, then dial from emul-A;
#       verify APNs VoIP push via simctl push log + CallKit UI via OCR.
set -u
EV="${1:-/tmp/e2e-T4-$$}"; mkdir -p "$EV"
cat > "$EV/verdict.json" <<EOF
{"id":"T4","name":"call-android-ios","status":"SKIP","failure_class":"STUB","detail":"requires Mac 207 sim integration","duration_s":0,"evidence_dir":"$EV"}
EOF
echo "[T4] SKIP (stub)"
exit 0
