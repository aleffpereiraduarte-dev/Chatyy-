#!/bin/bash
# Copia o rtload (gzip, sha256 conferido) para /var/tmp/rtload/ dos edges. Uso: distribuir.sh [ip_final...]
set -u; D=/root/roteador-2026-10-22/carga
gzip -9 -k -f $D/rtload; SHA=$(sha256sum $D/rtload.gz | cut -c1-64)
for ip in ${@:-2 3 4 5 6 7 8 9 10 11}; do ( ssh -o ConnectTimeout=5 root@10.8.0.$ip 'mkdir -p /var/tmp/rtload' && scp -q $D/rtload.gz root@10.8.0.$ip:/var/tmp/rtload/rtload.gz && ssh root@10.8.0.$ip "echo '$SHA  /var/tmp/rtload/rtload.gz' | sha256sum -c --quiet - && gunzip -f /var/tmp/rtload/rtload.gz && chmod 755 /var/tmp/rtload/rtload && echo 10.8.0.$ip ok" ) & done; wait
