#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/pjsip/build-android.sh
#
# Builds PJSIP 2.14.1 (PJSUA2 + Opus + libsrtp + OpenSSL) for Android and
# packages the result into a single .aar consumable by the expo-pjsip Gradle
# subproject (see docs/whatsapp-migration/02-pjsip-android.md §1).
#
# Mirrors scripts/pjsip/build-ios.sh from BUILD AGENT 6.
#
# Output: vendor/pjsip-android/pjsip-2.14.1.aar
#         vendor/pjsip-android/build/<ABI>/lib*.so       (per-ABI staging)
#
# Idempotent: safe to re-run. Honors ccache. Skips work that is already done.
#
# Usage:
#   bash scripts/pjsip/build-android.sh                 # all ABIs
#   ABIS_OVERRIDE="arm64-v8a" bash scripts/pjsip/build-android.sh
#   PJSIP_FLAVOR=debug bash scripts/pjsip/build-android.sh
#
# Required env:
#   ANDROID_NDK_ROOT  — path to NDK r27c (see MEMORY android_self_host_runner)
#
# NOTE: do NOT actually run on CI today — PJSIP is GPLv2 and we owe Teluu a
# commercial-license purchase first. See vendor/pjsip-android/README.md and
# docs/whatsapp-migration/IMPL-pjsip-android-license.md.
# ---------------------------------------------------------------------------

set -euo pipefail

# ---- Locate repo root regardless of cwd -----------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export REPO_ROOT

# ---- Source config --------------------------------------------------------
# shellcheck source=./build-android.config
source "${SCRIPT_DIR}/build-android.config"

# Allow ABI override from CLI (handy for fast iteration on arm64 only).
if [[ -n "${ABIS_OVERRIDE:-}" ]]; then
  # shellcheck disable=SC2206
  ANDROID_ABIS=(${ABIS_OVERRIDE})
fi

# ---- Pretty logging -------------------------------------------------------
log()  { printf '\033[1;36m[pjsip-android]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[pjsip-android WARN]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[pjsip-android FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- Pre-flight checks ----------------------------------------------------
preflight() {
  log "Pre-flight checks…"

  if [[ -z "${ANDROID_NDK_ROOT:-}" ]]; then
    fail "ANDROID_NDK_ROOT not set. Export it (we pin to ${NDK_VERSION_REQUIRED})."
  fi
  [[ -d "${ANDROID_NDK_ROOT}" ]] || fail "ANDROID_NDK_ROOT does not exist: ${ANDROID_NDK_ROOT}"

  local detected_ndk
  if [[ -f "${ANDROID_NDK_ROOT}/source.properties" ]]; then
    detected_ndk="$(grep -E '^Pkg\.Revision' "${ANDROID_NDK_ROOT}/source.properties" | cut -d= -f2 | tr -d ' ')"
    log "Detected NDK: ${detected_ndk}"
    if [[ "${detected_ndk}" != "${NDK_VERSION_REQUIRED}" ]]; then
      warn "NDK version drift: have ${detected_ndk}, expected ${NDK_VERSION_REQUIRED}. Continuing — bump NDK_VERSION_REQUIRED in build-android.config if intentional."
    fi
  else
    warn "Cannot read source.properties from NDK; skipping version pin check."
  fi

  for tool in git make autoconf curl tar swig javac jar zip aapt2; do
    command -v "${tool}" >/dev/null 2>&1 || warn "Missing tool: ${tool} (will fail mid-build)"
  done

  # JDK 17 is the canonical for AGP 8.x — same one the self-host runner uses.
  if command -v javac >/dev/null 2>&1; then
    local jver
    jver="$(javac -version 2>&1 | awk '{print $2}' | cut -d. -f1)"
    [[ "${jver}" -ge 17 ]] || warn "javac < 17 (${jver}). AGP 8.x wants 17+."
  fi

  if [[ -n "${CCACHE_BIN}" && -z "${CCACHE_DISABLE:-}" ]]; then
    export CCACHE_DIR="${CCACHE_DIR:-${CCACHE_DIR_DEFAULT}}"
    mkdir -p "${CCACHE_DIR}"
    log "ccache enabled: ${CCACHE_BIN} (cache dir ${CCACHE_DIR})"
  else
    warn "ccache not available — clean builds will take ~40 min wall time."
  fi
}

# ---- Source checkout ------------------------------------------------------
fetch_sources() {
  local src_root="${OUTPUT_DIR}/build/src"
  mkdir -p "${src_root}"

  local pj_dir="${src_root}/pjproject-${PJSIP_VERSION}"
  if [[ -d "${pj_dir}/.git" ]]; then
    log "pjproject already checked out at ${pj_dir} (idempotent skip)"
    (cd "${pj_dir}" && git fetch --tags --quiet && git checkout --quiet "${PJSIP_GIT_TAG}")
  else
    log "Cloning pjproject @ ${PJSIP_GIT_TAG}…"
    git clone --depth=1 --branch "${PJSIP_GIT_TAG}" "${PJSIP_GIT_URL}" "${pj_dir}"
  fi

  # Drop our codec/audio-framework config in place. PJSIP's autoconf reads it
  # at configure time via -DPJ_CONFIG_ANDROID and our custom include path.
  cp "${SCRIPT_DIR}/pjsua-android-config.h" "${pj_dir}/pjlib/include/pj/config_site.h"
  log "Wrote config_site.h (Opus 16k prio 255 + AAudio API 26+)"

  # OpenSSL / Opus / libsrtp — tarball fetch keyed by version. Idempotent.
  _fetch_tarball "openssl-${OPENSSL_VERSION}" \
    "https://www.openssl.org/source/openssl-${OPENSSL_VERSION}.tar.gz" "${src_root}"
  _fetch_tarball "opus-${OPUS_VERSION}" \
    "https://downloads.xiph.org/releases/opus/opus-${OPUS_VERSION}.tar.gz" "${src_root}"
  _fetch_tarball "libsrtp-${SRTP_VERSION}" \
    "https://github.com/cisco/libsrtp/archive/refs/tags/v${SRTP_VERSION}.tar.gz" "${src_root}"
}

_fetch_tarball() {
  local name="$1"; local url="$2"; local dest="$3"
  if [[ -d "${dest}/${name}" ]]; then
    log "${name} already extracted (skip)"
    return
  fi
  log "Fetching ${name}…"
  local tgz="${dest}/${name}.tar.gz"
  curl -fsSL "${url}" -o "${tgz}"
  tar -xzf "${tgz}" -C "${dest}"
  rm -f "${tgz}"
}

# ---- Per-ABI build --------------------------------------------------------
build_abi() {
  local abi="$1"
  log "===================================================================="
  log " Building ABI: ${abi}  (flavor=${PJSIP_FLAVOR})"
  log "===================================================================="

  local stage="${OUTPUT_DIR}/build/${abi}"
  mkdir -p "${stage}"

  # Marker file lets us skip re-doing finished ABIs on idempotent re-runs.
  local marker="${stage}/.built-${PJSIP_VERSION}-${PJSIP_FLAVOR}"
  if [[ -f "${marker}" ]]; then
    log "ABI ${abi} already built (marker present). Delete ${marker} to force rebuild."
    return
  fi

  # --- NDK toolchain triple selection -------------------------------------
  local triple host_tag toolchain_root
  case "${abi}" in
    arm64-v8a)    triple="aarch64-linux-android" ;;
    armeabi-v7a) triple="armv7a-linux-androideabi" ;;
    x86_64)      triple="x86_64-linux-android" ;;
    *) fail "Unsupported ABI: ${abi}" ;;
  esac

  case "$(uname -s)" in
    Linux)  host_tag="linux-x86_64" ;;
    Darwin) host_tag="darwin-x86_64" ;;
    *) fail "Unsupported host OS for NDK toolchain: $(uname -s)" ;;
  esac
  toolchain_root="${ANDROID_NDK_ROOT}/toolchains/llvm/prebuilt/${host_tag}"
  [[ -d "${toolchain_root}" ]] || fail "NDK toolchain not found: ${toolchain_root}"

  local CC_BIN="${toolchain_root}/bin/${triple}${ANDROID_API_MIN}-clang"
  local CXX_BIN="${toolchain_root}/bin/${triple}${ANDROID_API_MIN}-clang++"
  local AR_BIN="${toolchain_root}/bin/llvm-ar"
  local STRIP_BIN="${toolchain_root}/bin/llvm-strip"

  # ccache wrap
  if [[ -n "${CCACHE_BIN}" && -z "${CCACHE_DISABLE:-}" ]]; then
    CC_BIN="${CCACHE_BIN} ${CC_BIN}"
    CXX_BIN="${CCACHE_BIN} ${CXX_BIN}"
  fi

  export CC="${CC_BIN}"
  export CXX="${CXX_BIN}"
  export AR="${AR_BIN}"
  export RANLIB="${toolchain_root}/bin/llvm-ranlib"
  export LD="${toolchain_root}/bin/ld.lld"

  local cflags="-fPIC -DANDROID -O2 -ffunction-sections -fdata-sections"
  [[ "${PJSIP_FLAVOR}" = "debug" ]] && cflags="-fPIC -DANDROID -O0 -g -DDEBUG=1"
  local ldflags="-Wl,--gc-sections -Wl,--as-needed"

  export CFLAGS="${cflags}"
  export CPPFLAGS="${cflags}"
  export LDFLAGS="${ldflags}"

  # --- 1. OpenSSL ----------------------------------------------------------
  local openssl_prefix="${stage}/deps/openssl"
  _build_openssl "${abi}" "${openssl_prefix}" "${toolchain_root}"
  export OPENSSL_PREFIX="${openssl_prefix}"

  # --- 2. Opus -------------------------------------------------------------
  local opus_prefix="${stage}/deps/opus"
  _build_opus "${abi}" "${opus_prefix}" "${triple}"
  export OPUS_PREFIX="${opus_prefix}"

  # --- 3. libsrtp2 ---------------------------------------------------------
  local srtp_prefix="${stage}/deps/libsrtp"
  _build_srtp "${abi}" "${srtp_prefix}" "${triple}" "${openssl_prefix}"

  # --- 4. PJSIP (PJSUA2) ---------------------------------------------------
  _build_pjsip "${abi}" "${stage}" "${triple}"

  # --- 5. Strip + collect .so ---------------------------------------------
  local libs_out="${stage}/jni-libs"
  mkdir -p "${libs_out}"
  find "${stage}/pjproject" "${openssl_prefix}" "${opus_prefix}" "${srtp_prefix}" \
       -name '*.so' -type f -print0 2>/dev/null \
    | while IFS= read -r -d '' so; do
        cp "${so}" "${libs_out}/"
      done

  if [[ "${PJSIP_FLAVOR}" = "release" ]]; then
    log "Stripping debug symbols (release flavor)…"
    find "${libs_out}" -name '*.so' -exec "${STRIP_BIN}" -x {} \;
  fi

  touch "${marker}"
  log "ABI ${abi} built. Artifacts in ${libs_out}"
}

_build_openssl() {
  local abi="$1"; local prefix="$2"; local toolchain_root="$3"
  if [[ -f "${prefix}/lib/libssl.a" ]]; then
    log "  openssl ${abi}: cached"
    return
  fi
  log "  Building openssl ${OPENSSL_VERSION} for ${abi}…"
  local target
  case "${abi}" in
    arm64-v8a)   target="android-arm64" ;;
    armeabi-v7a) target="android-arm" ;;
    x86_64)      target="android-x86_64" ;;
  esac
  (
    cd "${OUTPUT_DIR}/build/src/openssl-${OPENSSL_VERSION}"
    export ANDROID_NDK_ROOT
    export PATH="${toolchain_root}/bin:${PATH}"
    ./Configure "${target}" -D__ANDROID_API__="${ANDROID_API_MIN}" \
      no-shared no-tests no-asm \
      --prefix="${prefix}" --openssldir="${prefix}/ssl"
    make -j"$(_ncpu)" >/dev/null
    make install_sw >/dev/null
  )
}

_build_opus() {
  local abi="$1"; local prefix="$2"; local triple="$3"
  if [[ -f "${prefix}/lib/libopus.a" ]]; then
    log "  opus ${abi}: cached"
    return
  fi
  log "  Building opus ${OPUS_VERSION} for ${abi}…"
  (
    cd "${OUTPUT_DIR}/build/src/opus-${OPUS_VERSION}"
    ./configure --host="${triple}" --prefix="${prefix}" \
      --disable-shared --enable-static --disable-extra-programs --disable-doc
    make -j"$(_ncpu)" >/dev/null
    make install >/dev/null
  )
}

_build_srtp() {
  local abi="$1"; local prefix="$2"; local triple="$3"; local openssl_prefix="$4"
  if [[ -f "${prefix}/lib/libsrtp2.a" ]]; then
    log "  libsrtp ${abi}: cached"
    return
  fi
  log "  Building libsrtp ${SRTP_VERSION} for ${abi}…"
  (
    cd "${OUTPUT_DIR}/build/src/libsrtp-${SRTP_VERSION}"
    ./configure --host="${triple}" --prefix="${prefix}" \
      --enable-openssl --with-openssl-dir="${openssl_prefix}"
    make -j"$(_ncpu)" libsrtp2.a >/dev/null
    make install >/dev/null
  )
}

_build_pjsip() {
  local abi="$1"; local stage="$2"; local triple="$3"
  log "  Configuring PJSIP for ${abi}…"

  local pj_src="${OUTPUT_DIR}/build/src/pjproject-${PJSIP_VERSION}"
  local pj_build="${stage}/pjproject"

  # We do an out-of-tree build by syncing the source. Source tree is shared
  # but the .o files end up in per-ABI dirs because PJSIP's makefiles key on
  # $(MACHINE_NAME).
  rsync -a --delete "${pj_src}/" "${pj_build}/"

  local -a configure_args=(
    "--use-ndk-cflags"
    "--with-ssl=${OPENSSL_PREFIX}"
    "--with-opus=${OPUS_PREFIX}"
    "--enable-libsrtp"
    "--disable-sound"     # we wire AAudio at runtime via custom factory
  )
  # shellcheck disable=SC2154
  configure_args+=("${PJSIP_DISABLE_FEATURES[@]}")

  (
    cd "${pj_build}"
    export TARGET_ABI="${abi}"
    export APP_PLATFORM="android-${ANDROID_API_MIN}"
    bash configure-android "${configure_args[@]}"

    log "  Compiling PJSIP libs (this is the slow part — ccache helps a lot)…"
    make dep >/dev/null
    make clean >/dev/null
    make -j"$(_ncpu)" >/dev/null

    log "  Building SWIG Java binding (pjsua2)…"
    (
      cd pjsip-apps/src/swig
      make >/dev/null
    )

    log "  Building libpjsua2.so (shared) for ${abi}…"
    (
      cd pjsip-apps/src/swig/java
      make >/dev/null
    )
  )
}

_ncpu() {
  if command -v nproc >/dev/null 2>&1; then nproc
  elif command -v sysctl >/dev/null 2>&1; then sysctl -n hw.ncpu
  else echo 4; fi
}

# ---- AAR packaging --------------------------------------------------------
package_aar() {
  log "===================================================================="
  log " Packaging ${OUTPUT_AAR_NAME}"
  log "===================================================================="

  local pkg="${OUTPUT_DIR}/build/aar-staging"
  rm -rf "${pkg}"
  mkdir -p "${pkg}/jni" "${pkg}/libs"

  # Per-ABI .so → jni/<ABI>/
  for abi in "${ANDROID_ABIS[@]}"; do
    local src="${OUTPUT_DIR}/build/${abi}/jni-libs"
    [[ -d "${src}" ]] || fail "Missing built libs for ${abi}: ${src}"
    mkdir -p "${pkg}/jni/${abi}"
    cp "${src}"/*.so "${pkg}/jni/${abi}/"
  done

  # SWIG Java binding (built once per ABI, but identical; take from arm64)
  local pjsua2_jar="${OUTPUT_DIR}/build/${ANDROID_ABIS[0]}/pjproject/pjsip-apps/src/swig/java/pjsua2.jar"
  if [[ -f "${pjsua2_jar}" ]]; then
    cp "${pjsua2_jar}" "${pkg}/libs/pjsua2.jar"
  else
    warn "pjsua2.jar not produced; SWIG step may have failed. Continuing with empty libs/."
  fi

  # Required AAR scaffolding
  cat > "${pkg}/AndroidManifest.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${AAR_PACKAGE}">
    <uses-sdk android:minSdkVersion="${ANDROID_API_MIN}" />
</manifest>
EOF

  # Empty R.txt placeholder (no resources)
  : > "${pkg}/R.txt"

  # ProGuard / R8 consumer rules — CRITICAL. R8 will strip the SWIG JNI
  # entrypoints without these and the app will UnsatisfiedLinkError at first
  # call. See docs/whatsapp-migration/02-pjsip-android.md §10.
  cp "${SCRIPT_DIR}/pjsip.pro" "${pkg}/proguard.txt"

  # ZIP-up as .aar (an .aar is just a ZIP — no special tooling needed).
  local out="${OUTPUT_DIR}/${OUTPUT_AAR_NAME}"
  rm -f "${out}"
  (cd "${pkg}" && zip -qr "${out}" . -x '*.DS_Store')

  log "Wrote ${out}"
  log "Size: $(du -h "${out}" | cut -f1)"
}

# ---- Main -----------------------------------------------------------------
main() {
  log "REPO_ROOT=${REPO_ROOT}"
  log "OUTPUT_DIR=${OUTPUT_DIR}"
  log "ABIs: ${ANDROID_ABIS[*]}"
  preflight
  fetch_sources
  for abi in "${ANDROID_ABIS[@]}"; do
    build_abi "${abi}"
  done
  package_aar
  log "Done. Consume from android/app/build.gradle with:"
  log "  implementation files('\${rootDir}/../vendor/pjsip-android/${OUTPUT_AAR_NAME}')"
  log "REMINDER: PJSIP is GPLv2. Do NOT ship until commercial license signed."
  log "  See docs/whatsapp-migration/IMPL-pjsip-android-license.md"
}

main "$@"
