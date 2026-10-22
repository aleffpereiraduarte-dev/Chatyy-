#!/bin/sh
# uso (no US): server/chatyy_router/build.sh "<comando mix>"  -> roda no BR2 (host de build), nunca no US
# Toolchain = OTP 27.3.4.6 + Elixir 1.18.3 PRÉ-COMPILADOS p/ Ubuntu 24.04 (builds.hex.pm, sha256 conferido)
# em /opt/chatyy-router-toolchain do BR2: o ERTS embutido no release exige só GLIBC_2.38, então roda
# nos 10 edges (USW/IN são 24.04 = glibc 2.39). O OTP do apt do BR2 (26.04) exige GLIBC_2.43 (sqrtf) → não usar.
# RT_BUILD_DIR (padrão /opt/chatyy-router-src) permite builds paralelos em diretórios distintos;
# o epmd (só 127.0.0.1) é derrubado no fim apenas se nenhum outro build/teste ainda roda.
set -e
cd "$(dirname "$0")"
D=${RT_BUILD_DIR:-/opt/chatyy-router-src}
T=/opt/chatyy-router-toolchain
rsync -a --delete --exclude _build --exclude deps --exclude .mix --exclude .elixir_ls --exclude dist ./ root@10.8.0.7:$D/
ssh root@10.8.0.7 "cd $D && export PATH=$T/otp/bin:$T/elixir/bin:\$PATH MIX_HOME=$D/.mix HEX_OFFLINE=1 ERL_EPMD_ADDRESS=127.0.0.1 LANG=C.UTF-8; epmd -daemon; nice -n 19 $1; rc=\$?; pgrep -f '[e]rts-[0-9.]*/bin/beam.smp.*chatyy-router-src' >/dev/null || epmd -kill >/dev/null 2>&1 || true; exit \$rc"
