#!/usr/bin/env bash
# Wave D deploy — backend + WS server + OTA.
# Run from /root/webmail-app:
#     bash patches-wave-d/deploy.sh
#
# Idempotent: re-running won't double-apply (patchers detect markers).
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== Wave D backend deploy =="

# 1) Patch /var/www/mail/api/chat.php
echo "-> patching chat.php"
python3 patches-wave-d/apply_chat_php.py /var/www/mail/api/chat.php

# 2) Patch /opt/chatyy-ws-go/main.go and rebuild
echo "-> patching main.go"
python3 patches-wave-d/apply_main_go.py /opt/chatyy-ws-go/main.go

echo "-> rebuilding chatyy-ws-go"
cd /opt/chatyy-ws-go
go build -o chatyy-ws-go .
systemctl restart chatyy-ws-go
sleep 1
systemctl is-active chatyy-ws-go || { echo "WS server failed to restart"; journalctl -u chatyy-ws-go --no-pager -n 30; exit 4; }
cd - >/dev/null

# 3) Reload PHP-FPM so chat.php picks up changes
echo "-> reloading chatyy-php-fpm"
docker restart chatyy-php-fpm
sleep 2
docker exec chatyy-php-fpm php -l /var/www/mail/api/chat.php > /tmp/wave_d_php_lint.log 2>&1 \
    || { echo "chat.php php -l failed"; cat /tmp/wave_d_php_lint.log; exit 5; }

# 4) Smoke test: WS server still answers + chat.php still routes.
echo "-> smoke tests"
curl -s -o /dev/null -w 'WS health %{http_code}\n' https://ws.chatyy.com.br/healthz || true
curl -s -o /dev/null -w 'chat.php OPTIONS %{http_code}\n' https://chatyy.com.br/api/chat.php || true

# Internal-auth check: ws_call_event needs a valid MAIL_WS_KEY header.
MAIL_WS_KEY=$(grep '^MAIL_WS_KEY=' /etc/mail-api.env | cut -d= -f2)
curl -s -X POST https://chatyy.com.br/api/chat.php?action=ws_call_event \
    -H 'Content-Type: application/json' \
    -H "X-WS-Internal: ${MAIL_WS_KEY}" \
    -d '{"action":"ws_call_event","event":"cancel","call_id":"smoke-test-callid","caller_email":"smoke@test","callee_email":"smoke@test"}' \
    | head -c 400 && echo

# 5) OTA ship — JS changes (services/websocket.js + components/IncomingCallListener.js)
echo "== Wave D OTA =="
cd /root/webmail-app
bash scripts/ship.sh ota "feat(#1139): Wave D multi-device fanout + reconnect WhatsApp-grade"

echo "== Wave D deploy COMPLETE =="
