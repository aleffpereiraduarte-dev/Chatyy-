#!/bin/bash
# [e2ee5 WP-18 2026-10-21] Regressão E2EE v5 ponta a ponta contra o e2ee5.php REAL, contas QA
# (apitest@onemundo.com.br = A, qa2@chatyy.com.br = B). Nunca usuários reais.
#   bash tests/e2ee/run.sh                    # compila (se preciso), loga as 2 contas QA, roda, grava resultado
#   E2EE_TEST_CONV=<id> bash tests/e2ee/run.sh  # + R5b (texto puro recusado) numa conversa QA JÁ cifrada
#   E2EE5_BASE=https://br.chatyy.com.br/api/email.php?action= bash tests/e2ee/run.sh   # outro host
# Resultado: /root/e2ee-2026-10-21/qa/resultados/<UTC>.json + .txt (sem conteúdo, sem chave, sem bearer).
# Saída != 0 = alguma linha FALHOU.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET=${CARGO_TARGET_DIR:-/var/tmp/e2ee5-qa-target}
SCR=${SCRATCH:-/var/tmp/e2ee5-qa-run}; mkdir -p "$SCR"; chmod 700 "$SCR"
OUT=/root/e2ee-2026-10-21/qa/resultados; mkdir -p "$OUT"
TS=$(date -u +%Y%m%dT%H%M%SZ)
BIN="$TARGET/release/e2ee5-qa-harness"
if [ ! -x "$BIN" ] || [ -n "$(find "$HERE/harness/src" "$HERE/harness/Cargo.toml" -newer "$BIN" 2>/dev/null)" ]; then
  ( cd "$HERE/harness" && systemd-run --scope -q -p CPUQuota=600% -p CPUWeight=20 nice -n 19 \
      env CARGO_TARGET_DIR="$TARGET" timeout 1800 cargo build --release -q ) || { echo "build falhou"; exit 2; }
fi
login() {  # $1 email  $2 chave do /etc/mail-api.env  $3 arquivo
  if [ -s "$3" ] && [ $(( $(date +%s) - $(stat -c %Y "$3") )) -lt 86400 ]; then
    c=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST -H "Authorization: Bearer $(cat "$3")" -H 'Content-Type: application/json' -d '{}' 'https://chatyy.com.br/api/email.php?action=e2ee5_status')
    [ "$c" = 200 ] && return 0
  fi
  ( cd /root/regional-qa && timeout 25 python3 -I rq.py login chatyy.com.br "$1" "$2" "$3" >/dev/null 2>&1 )
  chmod 600 "$3" 2>/dev/null; [ -s "$3" ]
}
login apitest@onemundo.com.br APITEST_PASSWORD "$SCR/tokA" || { echo "login A falhou"; exit 2; }
login qa2@chatyy.com.br QA2_PASSWORD "$SCR/tokB" || { echo "login B falhou"; exit 2; }
TOK_A="$SCR/tokA" TOK_B="$SCR/tokB" SCRATCH="$SCR" OUT_JSON="$OUT/$TS.json" "$BIN" 2>&1 | tee "$OUT/$TS.txt"
rc=${PIPESTATUS[0]}
ln -sf "$TS.json" "$OUT/ultimo.json"; ln -sf "$TS.txt" "$OUT/ultimo.txt"
echo "resultado gravado em $OUT/$TS.{json,txt} (rc=$rc)"
exit $rc
