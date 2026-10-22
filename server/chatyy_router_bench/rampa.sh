#!/bin/bash
# Rampa de carga distribuída do roteador BEAM (só edges; o US só orquestra por ssh).
# Uso: rampa.sh <run_id> "<total1> <total2> ..." [regiões]   ex.: rampa.sh r1 "1000 2000 5000 10000"
# Env: DUR=60 DRAIN=30 CONVS=1500 DEVS=1 BAN=sg:br2 HOMES=<regiões casa> POLL_S=4 EXTRA="" (flags extras p/ rtload)
# Pré-requisitos: 1ª linha de STATUS = "carga: liberado" e chatyy-router ativo há > 10 min em todos (senão não roda).
# Para tudo na hora: touch nos arquivos stop (o próprio script faz se algum nó disparar limite).
set -uo pipefail
K=/root/roteador-2026-10-22
D=$K/carga
RUN=$1; STEPS=($2); REGS=${3:-br,br2,scl,mia,mex,usw,sg,in,eu,mad}
DUR=${DUR:-60}; DRAIN=${DRAIN:-30}; CONVS=${CONVS:-1500}; DEVS=${DEVS:-1}; BAN=${BAN:-sg:br2}; EXTRA=${EXTRA:-}; HOMES=${HOMES:-}; POLL=${POLL_S:-4}; DSTS=${DSTS:-}; NOSEND=${NOSEND:-}
declare -A IP=([br]=10.8.0.2 [eu]=10.8.0.3 [usw]=10.8.0.4 [sg]=10.8.0.5 [in]=10.8.0.6 [br2]=10.8.0.7 [mia]=10.8.0.8 [mex]=10.8.0.9 [mad]=10.8.0.10 [scl]=10.8.0.11)
IFS=, read -ra R <<< "$REGS"; N=${#R[@]}
# com HOMES de 1 região só, ela não envia (casa != origem): divide a taxa pelos outros
NS=$N; if [ -n "$HOMES" ] && [[ "$HOMES" != *,* ]] && [[ ",$REGS," == *",$HOMES,"* ]]; then NS=$((N-1)); fi
[ -n "$HOMES" ] && EXTRA="$EXTRA -homes $HOMES"
[ -n "$DSTS" ] && EXTRA="$EXTRA -dsts $DSTS"
# NOSEND: regiões que só monitoram (taxa ~0), p/ proteger a produção delas mesmo fora da carga
for x in ${NOSEND//,/ }; do NS=$((NS-1)); done
SSH="ssh -o ConnectTimeout=5 -o BatchMode=yes"
OUT=$D/runs/$RUN; mkdir -p $OUT
log(){ echo "$(date -u +%T) $*" | tee -a $OUT/rampa.log; }

preflight(){
  local first; first=$(head -1 $K/STATUS)
  [ "$first" = "carga: liberado" ] || { log "STATUS = '$first' -> não rodo"; return 1; }
  local now; now=$(date +%s)
  for r in "${R[@]}"; do
    local ts; ts=$($SSH root@${IP[$r]} 'systemctl show -p ActiveEnterTimestamp --value chatyy-router; systemctl is-active chatyy-router' | tr '\n' '|')
    local st=${ts#*|}; st=${st%|}; local t=${ts%%|*}
    local up=$(( now - $(date -d "$t" +%s) ))
    [ "$st" = active ] && [ $up -gt 600 ] || { log "$r: chatyy-router $st uptime ${up}s (<600) -> não rodo"; return 1; }
  done
  return 0
}

status_line(){ # linha própria no STATUS, sem mexer na 1ª linha do outro agente
  local msg="$1"
  python3 - "$K/STATUS" "$msg" <<'EOF'
import sys
p,msg=sys.argv[1],sys.argv[2]
ls=[l for l in open(p).read().splitlines() if not l.startswith('# carga-agente:')]
ls.append('# carga-agente: '+msg)
open(p,'w').write('\n'.join(ls)+'\n')
EOF
}

preflight || exit 3
status_line "EM CURSO run=$RUN desde $(date -u +%FT%TZ) (passos ${STEPS[*]} msg/s, ${DUR}s cada). Não reiniciar nós; ao terminar escrevo 'concluída'. Parada de emergência: touch /var/tmp/rtload/$RUN/*/stop nos edges"
trap 'status_line "concluída run=$RUN em $(date -u +%FT%TZ) (nós livres)"' EXIT

step=0
for total in "${STEPS[@]}"; do
  step=$((step+1))
  [ $step -gt 1 ] && { preflight || { log "preflight falhou antes do passo $step"; break; }; }
  rate=$(python3 -c "print(round($total/$NS,2))")
  at=$(( $(date +%s) + 25 ))
  [ $step -eq 1 ] && at=$(( at + 75 ))   # 1º passo: assign das casas + aquecimento antes
  log "passo $step: total $total msg/s ($rate/nó × $NS remetentes, $N nós${HOMES:+, casas=$HOMES}), início $(date -u -d @$at +%T)"
  for r in "${R[@]}"; do
    o=/var/tmp/rtload/$RUN/$step; rr=$rate; [[ ",$NOSEND," == *",$r,"* ]] && rr=0.01
    $SSH root@${IP[$r]} "mkdir -p $o && systemd-run -q --unit=rtload-$RUN-$step -p CPUQuota=150% -p MemoryMax=1G -p Nice=15 --collect \
      sh -c '/var/tmp/rtload/rtload step -run $RUN -step $step -me $r -regions $REGS -ban $BAN -rate $rr -dur ${DUR}s -drain ${DRAIN}s -convs $CONVS -devs $DEVS -at $at -out $o $EXTRA 2>$o/log'" &
  done; wait
  deadline=$(( at + DUR + DRAIN + 90 )); stopped=0
  while :; do
    sleep $POLL
    done_n=0; trips=""; tmp=$(mktemp -d)
    for r in "${R[@]}"; do
      timeout 6 $SSH root@${IP[$r]} "test -s /var/tmp/rtload/$RUN/$step/summary.json && echo DONE; cat /var/tmp/rtload/$RUN/$step/state.json 2>/dev/null" > $tmp/$r 2>/dev/null &
    done; wait
    for r in "${R[@]}"; do
      s=$(cat $tmp/$r)
      [[ "$s" == DONE* ]] && done_n=$((done_n+1))
      t=$(echo "$s" | grep -o '"trip":"[^"]*"' | head -1 | cut -d'"' -f4)
      [ -n "$t" ] && [ "$t" != stop_externo ] && trips+="$r:$t; "
    done; rm -rf $tmp
    if [ -n "$trips" ] && [ $stopped = 0 ]; then
      log "PARADA: $trips"; stopped=1
      for r in "${R[@]}"; do $SSH root@${IP[$r]} "touch /var/tmp/rtload/$RUN/$step/stop" & done; wait
    fi
    [ $done_n -eq $N ] && break
    [ $(date +%s) -gt $deadline ] && { log "timeout esperando summary (done $done_n/$N)"; for r in "${R[@]}"; do $SSH root@${IP[$r]} "touch /var/tmp/rtload/$RUN/$step/stop; systemctl stop rtload-$RUN-$step 2>/dev/null" & done; wait; sleep 5; break; }
  done
  mkdir -p $OUT/$step
  for r in "${R[@]}"; do
    $SSH root@${IP[$r]} "gzip -c /var/tmp/rtload/$RUN/$step/summary.json 2>/dev/null" > $OUT/$step/$r.json.gz &
    $SSH root@${IP[$r]} "cat /var/tmp/rtload/$RUN/$step/log 2>/dev/null; chronyc tracking 2>/dev/null | grep 'System time'" > $OUT/$step/$r.log &
  done; wait
  python3 $D/analisar.py $OUT/$step "$total" | tee -a $OUT/rampa.log
  verdict=$(tail -1 $OUT/$step/verdict.txt 2>/dev/null)
  if [ "$verdict" != OK ]; then log "rampa encerrada no passo $step ($total msg/s): $verdict"; break; fi
  sleep 10
done
log "fim da rampa $RUN"
