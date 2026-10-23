#!/bin/bash
# [quic-proto Android] QA REAL do cliente chatyy-net (o MESMO código da .so) contra a instância QA PARALELA do leaf
# (mesmo esquema do /root/quic-noise-2026-10-23/leaf/qa/qa-worker.sh: worker NJ 10.8.0.12:4443/udp só pela WG, upstream
# = hub US real, relay puro). Contas: apitest (allowlist) e qa2 (fora → 4001). Só auth + ping: NENHUMA mensagem criada.
# Rodar NO US: bash native/chatyy-net/ci/qa-real.sh   (QA_BIN/QA_MD5 = binário combinado; PROBE = examples/probe)
set -uo pipefail
K=/root/quic-noise-2026-10-23/leaf; RQ=/root/ack-sem-master-2026-10-23/qa; W=10.8.0.12; BRH=10.8.0.2; API=chatyy.com.br
QB=${QA_BIN:-$K/combo-pmr/chatyy-hub-regional.qnpmr-$(cut -c1-8 $K/combo-pmr/QNPMR.md5).new}; QM=${QA_MD5:-$(cat $K/combo-pmr/QNPMR.md5)}
PROBE=${PROBE:?caminho do examples/probe (linux x86_64)}
O=$(mktemp -d /root/qa-chatyy-net-XXXX); chmod 700 $O
S() { ssh -o BatchMode=yes -o ConnectTimeout=8 root@$1 "${@:2}"; }
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a $O/qa.txt; }
U=chatyy-hub-regional-qnqa; D=/opt/chatyy-hub-regional-qa; SD=/var/lib/chatyy-hub-regional-qnqa; FL=/etc/chatyy-hub-regional-qnqa-flags.env
PUB=$(python3 -c "import json;print(json.load(open('/root/quic-noise-2026-10-23/keys/region-TESTE.key'))['pub'])")
PINS=7T92loM6w7GMhwkyu25bQOwbGoVMJdk7u6nm48Jp51g=,QhTxrbi7wfzD+EEgmN7jpO2JOGa09wxQYBGullgQQP4=
P="/root/.cnqa/probe api-us2.chatyy.com.br $W 4443 us2 t1 $PUB --dev QTESTANDROID"
cleanup() {
  S $W "systemctl stop $U 2>/dev/null; systemctl reset-failed $U 2>/dev/null; rm -rf /root/.cnqa" 2>/dev/null
  S $BRH "rm -rf /root/.cnqa" 2>/dev/null
  for t in tokA tokB; do [ -f $O/$t ] && (cd $RQ && python3 -I rq.py logout $API $O/$t >/dev/null 2>&1); done
  rm -f $O/tok* $O/auth*
  log "saída em $O"
}
trap cleanup EXIT
[ "$(S $W "systemctl is-active $U")" = active ] && { echo "instância QA já em uso (outro agente)"; exit 3; }
(cd $RQ && python3 -I rq.py login $API apitest@onemundo.com.br APITEST_PASSWORD $O/tokA >/dev/null && python3 -I rq.py login $API qa2@chatyy.com.br QA2_PASSWORD $O/tokB >/dev/null) || { log "login falhou"; exit 2; }
for x in A B; do python3 -c "import json,sys;print(json.dumps({'type':'auth','token':open('$O/tok$x').read().strip(),'client':'native-core','instance_id':'cnqa'}))" > $O/auth$x; done
chmod 600 $O/auth*
S $W "mkdir -p $D $SD/phptmp /root/.cnqa && chmod 700 $SD /root/.cnqa"
scp -q $QB root@$W:$D/chatyy-hub-regional-qn
S $W "[ \"\$(md5sum < $D/chatyy-hub-regional-qn | cut -c1-32)\" = $QM ] && echo md5 ok $QM" | tee -a $O/qa.txt
for h in $W $BRH; do S $h "mkdir -p /root/.cnqa && chmod 700 /root/.cnqa"; scp -q $PROBE root@$h:/root/.cnqa/probe; scp -q $O/authA $O/authB root@$h:/root/.cnqa/; S $h "chmod 600 /root/.cnqa/auth*"; done
S $W "python3 - <<'PY'
import re
L=open('/etc/chatyy-hub-regional.env').read().splitlines()
ov={'LEAF_LISTEN':'127.0.0.1:8196','LEAF_STATE_DIR':'$SD','HUB_PHP_TMP_DIR':'$SD/phptmp','LEAF_MESH_LISTEN':'127.0.0.1:8198','LEAF_MESH_PEERS':'',
    'LEAF_SEQ_REGION':'us2-qnqa','LEAF_FLAGS_FILE':'$FL','GOMEMLIMIT':'300MiB','HUB_ROLE':'leaf'}
out=[l for l in L if not any(re.match(r'\s*'+k+r'\s*=',l) for k in ov)]+[k+'='+v for k,v in ov.items()]
open('$SD/env','w').write('\n'.join(out)+'\n')
PY
chmod 600 $SD/env
printf 'LEAF_FAST=0\nLEAF_NATIVE_SEND=0\nLEAF_LOCAL_SEQ=0\nLEAF_MESH=0\nLEAF_SEQ_POLICY=0\nLEAF_CONN_HINT=0\nLEAF_PUSH_REGIONAL=0\nLEAF_UP_SURVIVE=0\nLEAF_ACK_MESH=0\nLEAF_ACK_ENTER_FIRST=0\nLEAF_ACK_LOCAL=0\nLEAF_RT_FANOUT=0\nHUB_E2EE5=0\nLEAF_QUIC=1\nLEAF_QUIC_ADDR=$W:4443\nLEAF_QUIC_ALLOW=apitest@onemundo.com.br\nLEAF_QUIC_0RTT=1\nLEAF_NOISE=1\nLEAF_NOISE_0RTT=1\nLEAF_NOISE_KEY_FILE=/root/qn-keys/region-TESTE.key\nLEAF_NOISE_DEV_FILE=$SD/devices-TESTE.json\nLEAF_QUIC_PIN=1\nLEAF_QUIC_PIN_CERT=/root/qn-keys/quic-TESTE.crt\nLEAF_QUIC_PIN_KEYF=/root/qn-keys/quic-TESTE.key\n' > $FL
systemd-run --unit=$U --description='Chatyy leaf QA quic-noise (cliente Android chatyy-net)' -p EnvironmentFile=$SD/env -p RuntimeMaxSec=900 -p MemoryMax=400M -p CPUWeight=20 -p Nice=10 \
  -p StandardOutput=append:/var/log/chatyy-hub-regional-qnqa.log -p StandardError=append:/var/log/chatyy-hub-regional-qnqa.log $D/chatyy-hub-regional-qn >/dev/null 2>&1"
for i in $(seq 30); do sleep 1; S $W "ss -ulpn | grep -q '$W:4443 '" && break; done
S $W "ss -ulpn | grep -q '$W:4443 '" || { log "listener não subiu"; exit 1; }
log "instância QA no ar (4443/udp)"
R() { local name=$1 host=$2; shift 2; S $host "$P $*" > $O/$name.txt 2>&1; grep RESULT $O/$name.txt | sed "s/^/$name /" | tee -a $O/qa.txt; }
log "RTT BR→worker: $(S $BRH "ping -c5 -q $W | tail -1 | cut -d/ -f5") ms"
R br-v2-frio $BRH --auth-file /root/.cnqa/authA --pins $PINS --rounds 4 --secs 2
R br-v1 $BRH --auth-file /root/.cnqa/authA --rounds 3 --secs 2
R nj-v2-migra $W --auth-file /root/.cnqa/authA --pins $PINS --secs 4 --migrate 2; grep -c "MIGRATE Ok" $O/nj-v2-migra.txt | sed 's/^/migrate_ok=/' | tee -a $O/qa.txt
R br-v2-pin-errado $BRH --auth-file /root/.cnqa/authA --pins AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= --secs 2
R br-v2-fora-allowlist $BRH --auth-file /root/.cnqa/authB --pins $PINS --secs 3; grep -o "code: 4001[^}]*" $O/br-v2-fora-allowlist.txt | head -1 | tee -a $O/qa.txt
up=$(S $W "curl -s -m3 127.0.0.1:8196/health" | python3 -c 'import json,sys; print(int(float(json.load(sys.stdin)["quic"]["uptime_s"])))'); [ "$up" -lt 130 ] && { log "aquecimento do anti-replay ($up s)"; sleep $((130-up)); }
R br-v2-retomada $BRH --auth-file /root/.cnqa/authA --pins $PINS --resume --rounds 3 --secs 2
S $W "curl -s -m3 127.0.0.1:8196/health" | python3 -c 'import json,sys; q=json.load(sys.stdin)["quic"]; print("health", json.dumps({k:q.get(k) for k in ["hs","authed","migrations","gate_go_ws","v2","0rtt","zero_rtt"]}), json.dumps({k:q["noise"].get(k) for k in ["hs_ok","hs_fail","early_ok","early_refused"]}))' | tee -a $O/qa.txt
