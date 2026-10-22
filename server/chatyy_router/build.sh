#!/bin/sh
# uso (no US): server/chatyy_router/build.sh "<comando mix>"  -> roda no BR2 (host de build), nunca no US
set -e
cd "$(dirname "$0")"
rsync -a --delete --exclude _build --exclude deps --exclude .mix ./ root@10.8.0.7:/opt/chatyy-router-src/
ssh root@10.8.0.7 "cd /opt/chatyy-router-src && export MIX_HOME=/opt/chatyy-router-src/.mix HEX_OFFLINE=1 ERL_EPMD_ADDRESS=127.0.0.1 LANG=C.UTF-8; nice -n 19 $1; epmd -kill >/dev/null 2>&1 || true"
