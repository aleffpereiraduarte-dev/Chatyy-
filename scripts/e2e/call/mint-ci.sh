#!/bin/bash
# [2026-10-11] Login das contas QA para o teste de ligação no CI (e2e-call-tests.yml).
# Senhas vêm de env (GitHub secrets QA_APITEST_PASSWORD / QA_QA2_PASSWORD); grava
# bearers.json com umask 077. NUNCA imprime senha nem token (só o tamanho).
# Equivalente a /root/ligacao-melhorias/testes/mint.sh (que lê /etc/mail-api.env).
set -euo pipefail
OUT=${1:?uso: mint-ci.sh <saida/bearers.json>}
: "${QA_APITEST_PASSWORD:?secret QA_APITEST_PASSWORD ausente}"
: "${QA_QA2_PASSWORD:?secret QA_QA2_PASSWORD ausente}"
API=${CHATYY_API:-https://chatyy.com.br/api/email.php}
EA=${QA_EMAIL_A:-apitest@onemundo.com.br}
EB=${QA_EMAIL_B:-qa2@chatyy.com.br}
CONV=${QA_CONV:-971}
login() { # $1=email, senha via env $2 (nome da variável) → token em stdout
  python3 -c 'import json,os,sys;print(json.dumps({"email":sys.argv[1],"password":os.environ[sys.argv[2]],"device_id":"qa-calltest-ci"}))' "$1" "$2" \
    | curl -sS --max-time 20 -X POST -H 'Content-Type: application/json' -H 'User-Agent: chatyy-e2e-ci' --data-binary @- "$API?action=login" \
    | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
print((d.get("data") or {}).get("token") or d.get("token") or "")'
}
TA=$(login "$EA" QA_APITEST_PASSWORD); TB=$(login "$EB" QA_QA2_PASSWORD)
[ -n "$TA" ] && [ -n "$TB" ] || { echo "login falhou (len a=${#TA} b=${#TB})" >&2; exit 1; }
umask 077
python3 -c 'import json,sys;json.dump({"a":sys.argv[1],"b":sys.argv[2],"ea":sys.argv[3],"eb":sys.argv[4],"conv":int(sys.argv[5])},open(sys.argv[6],"w"))' "$TA" "$TB" "$EA" "$EB" "$CONV" "$OUT"
echo "ok len a=${#TA} b=${#TB}"
