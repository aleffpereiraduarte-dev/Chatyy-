#!/usr/bin/env bash
# [e2ee5 WP-04] Teste headless do host web NO EDGE (nunca no US): export privado em
# /opt/chatyy-qa/app-wp04 (não mexe no /opt/chatyy-qa/app compartilhado) + Playwright contra e2ee5.php.
# Pré: bearers QA de curta duração em $TOKDIR/tok_apitest e $TOKDIR/tok_qa2 (apagar depois).
# Uso: TOKDIR=/caminho vendor/chatyy-crypto-wasm/qa/run.sh [OUT]
set -euo pipefail
Q="$(cd "$(dirname "$0")" && pwd)"; APP="$(cd "$Q/../../.." && pwd)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
cp "$Q"/e2ee5-web-host.pw.js "$Q"/wp04-run.js "$Q"/e2ee5-qa.route.js "$TOKDIR"/tok_apitest "$TOKDIR"/tok_qa2 "$W"/
cp "$APP"/services/crypto/index.web.js "$APP"/services/crypto/worker/client.web.js "$APP"/services/crypto/worker/workerBundle.generated.js "$APP"/vendor/chatyy-crypto-wasm/chatyy_crypto_bg.wasm "$W"/
( cd "$APP" && md5sum services/crypto/index.web.js services/crypto/worker/client.web.js services/crypto/worker/workerBundle.generated.js vendor/chatyy-crypto-wasm/chatyy_crypto_bg.wasm ) > "$W/expected.md5"
cd "$W" && chatyy-qa-remote run wp04-run.js --files e2ee5-web-host.pw.js e2ee5-qa.route.js expected.md5 tok_apitest tok_qa2 index.web.js client.web.js workerBundle.generated.js chatyy_crypto_bg.wasm --out "${1:-/var/tmp/chatyy-qa/wp04-$(date +%s)}" --timeout 1800
