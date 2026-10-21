#!/usr/bin/env bash
# Empacota dist/ em 3 pacotes determinísticos + SHA256SUMS (assets do release que os builds
# do app baixam; o app NÃO compila Rust no release).
#   bash native/chatyy-crypto/ci/package.sh <versão>     # ex.: 0.1.0-a1b2c3d
# Saída: dist/release/chatyy-crypto-{ios,android,wasm}-<versão>.tar.gz + SHA256SUMS + manifest.json
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/env.sh"
VER="${1:?versão}"
D="$CHATYY_CRYPTO_DIST"; R="$D/release"; rm -rf "$R"; mkdir -p "$R"
TAR=(tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner)
command -v gtar >/dev/null && TAR[0]=gtar
pack() { # <nome> <paths relativos a dist...>
  local name="$1"; shift; local have=()
  for p in "$@"; do [ -e "$D/$p" ] && have+=("$p"); done
  [ ${#have[@]} -gt 0 ] || { cc_log "pulando $name (sem artefatos)"; return 0; }
  ( cd "$D" && "${TAR[@]}" -cf - "${have[@]}" ) | gzip -9 -n > "$R/chatyy-crypto-$name-$VER.tar.gz"
}
pack ios     ios/ChatyyCryptoCore.xcframework ios/size-report.txt bindings/swift
pack android android/jniLibs android/size-report.txt bindings/kotlin
pack wasm    wasm/web wasm/no-modules wasm/size-report.txt
cc_manifest; cp "$D/manifest.json" "$R/manifest.json"
( cd "$R" && for f in *.tar.gz manifest.json; do printf '%s  %s\n' "$(cc_sha256 "$f")" "$f"; done > SHA256SUMS )
cat "$R/SHA256SUMS"
