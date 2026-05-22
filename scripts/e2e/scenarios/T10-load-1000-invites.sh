#!/usr/bin/env bash
# T10 — Load: 1000 invites / 60s via direct call_invite HTTP loop. STUB.
# TODO: scripted bearer-mint loop posting call_invite to chat.php,
#       assert C++ WS RSS stays <80MB, >99% delivered, p99 invite→ring <800ms.
set -u
EV="${1:-/tmp/e2e-T10-$$}"; mkdir -p "$EV"
cat > "$EV/verdict.json" <<EOF
{"id":"T10","name":"load-1000-invites","status":"SKIP","failure_class":"STUB","detail":"not implemented","duration_s":0,"evidence_dir":"$EV"}
EOF
echo "[T10] SKIP (stub)"
exit 0
