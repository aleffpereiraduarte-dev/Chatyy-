#!/usr/bin/env bash
# T9 — Network drop + reconnect during call. STUB.
# TODO: run T1 setup, then adv_wifi off on emul-A for 10s, re-enable;
#       assert WS reconnect, LK iceRestart, call resumes within 30s.
set -u
EV="${1:-/tmp/e2e-T9-$$}"; mkdir -p "$EV"
cat > "$EV/verdict.json" <<EOF
{"id":"T9","name":"network-drop","status":"SKIP","failure_class":"STUB","detail":"not implemented","duration_s":0,"evidence_dir":"$EV"}
EOF
echo "[T9] SKIP (stub)"
exit 0
