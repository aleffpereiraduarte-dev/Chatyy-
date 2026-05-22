#!/usr/bin/env bash
# T2 — Callee app killed, FCM wake → IncomingCallActivity fires.
# STUB: implement after T1 is green in CI.
# TODO: am force-stop on emul-B, caller dials, verify FCM payload in logcat-B,
#       verify IncomingCallActivity fullScreenIntent, then LK joined within 12s.
set -u
EV="${1:-/tmp/e2e-T2-$$}"; mkdir -p "$EV"
cat > "$EV/verdict.json" <<EOF
{"id":"T2","name":"call-killed-fcm","status":"SKIP","failure_class":"STUB","detail":"not implemented","duration_s":0,"evidence_dir":"$EV"}
EOF
echo "[T2] SKIP (stub)"
exit 0
