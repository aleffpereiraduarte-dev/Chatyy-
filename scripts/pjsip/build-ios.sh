#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# build-ios.sh — Vendor PJSIP for iOS as a fat XCFramework.
#
# Output: vendor/pjsip-ios/PJSIP.xcframework
# Slices: ios-arm64 (device), ios-arm64-simulator, ios-x86_64-simulator
#
# WARNING (LEGAL):
#   PJSIP is GPLv2 + Teluu commercial license. This script builds the artifact
#   but the resulting .xcframework MUST NOT be linked into a closed-source
#   release IPA until the commercial license is signed by Teluu.
#   See: docs/whatsapp-migration/IMPL-pjsip-ios-license.md
#
# Run location: Mac 207 (207.254.28.52) only. macOS 14+, Xcode 16+.
# -----------------------------------------------------------------------------
set -euo pipefail

# ---------- repo root + config ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/build-ios.config"
CONFIG_SITE="${SCRIPT_DIR}/pjsip-config-site.h"

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "ERROR: ${CONFIG_FILE} not found" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "${CONFIG_FILE}"

# ---------- knobs (overridable via env) ----------
PJSIP_TAG="${PJSIP_TAG:-2.14.1}"
PJSIP_REPO="${PJSIP_REPO:-https://github.com/pjsip/pjproject}"
SRC_DIR="${SRC_DIR:-${REPO_ROOT}/vendor/pjsip-src}"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/vendor/pjsip-ios}"
BUILD_DIR="${BUILD_DIR:-${REPO_ROOT}/vendor/pjsip-ios/.build}"
XCFRAMEWORK="${OUT_DIR}/PJSIP.xcframework"
STAMP_FILE="${BUILD_DIR}/.source-stamp"

MIN_IOS="${MIN_IOS:-15.1}"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 8)}"

# Slices we package.
SLICES=("ios-arm64" "ios-arm64-simulator" "ios-x86_64-simulator")

# Static archives (the PJSIP build emits these per target dir).
ARCHIVES=(
  "pjlib/lib/libpj"
  "pjlib-util/lib/libpjlib-util"
  "pjnath/lib/libpjnath"
  "pjmedia/lib/libpjmedia"
  "pjmedia/lib/libpjmedia-audiodev"
  "pjmedia/lib/libpjmedia-videodev"
  "pjmedia/lib/libpjmedia-codec"
  "pjsip/lib/libpjsip"
  "pjsip/lib/libpjsip-ua"
  "pjsip/lib/libpjsip-simple"
  "pjsip/lib/libpjsua"
  "pjsip/lib/libpjsua2"
  "third_party/lib/libsrtp"
  "third_party/lib/libresample"
  "third_party/lib/libyuv"
  "third_party/lib/libwebrtc"   # built but webrtc AEC only, no full LK stack
)

# ---------- helpers ----------
log()  { printf "\033[1;34m[pjsip]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[pjsip WARN]\033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31m[pjsip ERR]\033[0m %s\n" "$*" >&2; exit 1; }

require_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || die "Must run on macOS (Mac 207). uname=$(uname -s)"
  xcrun --find clang >/dev/null 2>&1 || die "Xcode CLT not found. Run: xcode-select --install"
}

require_deps() {
  for tool in git curl xcrun lipo otool make perl; do
    command -v "${tool}" >/dev/null 2>&1 || die "Missing tool: ${tool}"
  done
  [[ -d "${OPENSSL_PATH:-}" ]] || die "OPENSSL_PATH not set or invalid: ${OPENSSL_PATH:-<unset>}"
  [[ -d "${OPUS_PATH:-}"    ]] || die "OPUS_PATH not set or invalid: ${OPUS_PATH:-<unset>}"
}

setup_ccache() {
  if [[ "${USE_CCACHE:-1}" == "1" ]] && command -v ccache >/dev/null 2>&1; then
    export CCACHE_DIR="${CCACHE_DIR:-${REPO_ROOT}/.ccache/pjsip}"
    mkdir -p "${CCACHE_DIR}"
    export CC="ccache clang"
    export CXX="ccache clang++"
    log "ccache enabled at ${CCACHE_DIR} ($(ccache -s 2>/dev/null | head -1 || true))"
  else
    warn "ccache not enabled (set USE_CCACHE=1 + brew install ccache for fast rebuilds)"
    export CC="clang"
    export CXX="clang++"
  fi
}

clone_or_update_source() {
  if [[ -d "${SRC_DIR}/.git" ]]; then
    local current
    current="$(git -C "${SRC_DIR}" describe --tags --exact-match 2>/dev/null || echo "")"
    if [[ "${current}" == "${PJSIP_TAG}" ]]; then
      log "Source already at tag ${PJSIP_TAG}"
      return
    fi
    log "Updating source to tag ${PJSIP_TAG} (was ${current:-unknown})"
    git -C "${SRC_DIR}" fetch --tags origin
    git -C "${SRC_DIR}" checkout "${PJSIP_TAG}"
    git -C "${SRC_DIR}" clean -fdx
  else
    log "Cloning ${PJSIP_REPO} @ ${PJSIP_TAG} into ${SRC_DIR}"
    mkdir -p "$(dirname "${SRC_DIR}")"
    git clone --depth 1 --branch "${PJSIP_TAG}" "${PJSIP_REPO}" "${SRC_DIR}"
  fi
  # Drop our config_site.h into the source tree.
  install -m 0644 "${CONFIG_SITE}" "${SRC_DIR}/pjlib/include/pj/config_site.h"
}

source_stamp() {
  # Hash of source tree + config to decide if rebuild needed.
  {
    git -C "${SRC_DIR}" rev-parse HEAD 2>/dev/null || echo "no-git"
    shasum -a 256 "${CONFIG_SITE}" "${CONFIG_FILE}" 2>/dev/null || true
    printf "min_ios=%s\n" "${MIN_IOS}"
  } | shasum -a 256 | awk '{print $1}'
}

needs_rebuild() {
  if [[ ! -d "${XCFRAMEWORK}" ]]; then
    log "XCFramework not present — building from scratch"
    return 0
  fi
  local now want
  want="$(source_stamp)"
  now="$(cat "${STAMP_FILE}" 2>/dev/null || echo "")"
  if [[ "${want}" != "${now}" ]]; then
    log "Source changed (stamp ${now:0:8} → ${want:0:8}) — rebuilding"
    return 0
  fi
  log "XCFramework up-to-date (stamp ${want:0:8}) — skipping build"
  return 1
}

# ---------- per-slice build ----------
configure_for() {
  local slice="$1" sdk arch host
  case "${slice}" in
    ios-arm64)               sdk="iphoneos";         arch="arm64";  host="arm-apple-darwin";;
    ios-arm64-simulator)     sdk="iphonesimulator";  arch="arm64";  host="arm-apple-darwin";;
    ios-x86_64-simulator)    sdk="iphonesimulator";  arch="x86_64"; host="x86_64-apple-darwin";;
    *) die "Unknown slice: ${slice}";;
  esac

  local sdk_path min_flag
  sdk_path="$(xcrun --sdk "${sdk}" --show-sdk-path)"
  if [[ "${sdk}" == "iphonesimulator" ]]; then
    min_flag="-mios-simulator-version-min=${MIN_IOS}"
  else
    min_flag="-miphoneos-version-min=${MIN_IOS}"
  fi

  local cflags ldflags
  cflags="-arch ${arch} -isysroot ${sdk_path} ${min_flag} -fembed-bitcode-marker -O2 -fPIC -DNDEBUG"
  cflags+=" -I${OPENSSL_PATH}/include -I${OPUS_PATH}/include"
  ldflags="-arch ${arch} -isysroot ${sdk_path} ${min_flag}"
  ldflags+=" -L${OPENSSL_PATH}/lib -L${OPUS_PATH}/lib"

  export CFLAGS="${cflags}"
  export LDFLAGS="${ldflags}"
  export CC CXX

  # PJSIP iOS env knobs (see pjproject docs).
  export DEVPATH="$(xcrun --sdk "${sdk}" --show-sdk-platform-path)/Developer"
  export IPHONESDK="$(basename "${sdk_path}")"
  export MIN_IOS_VERSION="${MIN_IOS}"
  export ARCH="-arch ${arch}"

  # Distclean + configure under a per-slice build root via separate VPATH? No — pjsip
  # writes into the source tree, so we serialize and stash output before next slice.
  (
    cd "${SRC_DIR}"
    make distclean >/dev/null 2>&1 || true
    ./configure-iphone \
      --with-ssl="${OPENSSL_PATH}" \
      --with-opus="${OPUS_PATH}" \
      --enable-video \
      --disable-libwebrtc \
      --host="${host}" \
      ${EXTRA_CONFIGURE_FLAGS:-}
  )
}

build_slice() {
  local slice="$1"
  local slice_out="${BUILD_DIR}/${slice}"
  log "Building slice: ${slice}"
  rm -rf "${slice_out}"
  mkdir -p "${slice_out}/lib" "${slice_out}/include"

  configure_for "${slice}"
  ( cd "${SRC_DIR}" && make dep && make -j"${JOBS}" )

  # Stash archives.
  local missing=0
  for a in "${ARCHIVES[@]}"; do
    local found
    found="$(ls "${SRC_DIR}/${a}-"*-apple-darwin*.a 2>/dev/null | head -n1 || true)"
    if [[ -z "${found}" ]]; then
      warn "  missing archive ${a} (slice=${slice})"
      missing=$((missing+1))
      continue
    fi
    cp "${found}" "${slice_out}/lib/$(basename "${a}").a"
  done
  [[ "${missing}" -gt 4 ]] && die "Too many missing archives for ${slice}: ${missing}"

  # Stash public headers (subset — pjsua + pjsua2 + pjmedia + pjsip + pjnath + pjlib).
  for mod in pjlib pjlib-util pjnath pjmedia pjsip; do
    if [[ -d "${SRC_DIR}/${mod}/include" ]]; then
      mkdir -p "${slice_out}/include"
      ( cd "${SRC_DIR}/${mod}/include" && tar cf - . ) | ( cd "${slice_out}/include" && tar xf - )
    fi
  done
}

merge_slice_static() {
  # libtool -static merge all .a in slice/lib into one fat libPJSIP.a
  local slice="$1"
  local slice_out="${BUILD_DIR}/${slice}"
  log "Merging static archives for ${slice}"
  local libs=()
  while IFS= read -r -d '' f; do libs+=("${f}"); done \
    < <(find "${slice_out}/lib" -name "*.a" -print0)
  [[ "${#libs[@]}" -gt 0 ]] || die "No archives to merge for ${slice}"

  # Also pull in OpenSSL + Opus per-arch (we link them in — single distributable).
  if [[ -f "${OPENSSL_PATH}/lib/libssl.a" ]];    then libs+=("${OPENSSL_PATH}/lib/libssl.a"); fi
  if [[ -f "${OPENSSL_PATH}/lib/libcrypto.a" ]]; then libs+=("${OPENSSL_PATH}/lib/libcrypto.a"); fi
  if [[ -f "${OPUS_PATH}/lib/libopus.a" ]];      then libs+=("${OPUS_PATH}/lib/libopus.a"); fi

  rm -f "${slice_out}/libPJSIP.a"
  libtool -static -o "${slice_out}/libPJSIP.a" "${libs[@]}"
  log "  → ${slice_out}/libPJSIP.a ($(du -h "${slice_out}/libPJSIP.a" | awk '{print $1}'))"
}

assert_slice_arch() {
  local slice="$1"
  local lib="${BUILD_DIR}/${slice}/libPJSIP.a"
  local archs
  archs="$(lipo -info "${lib}" 2>/dev/null | awk -F: '{print $NF}' | xargs)"
  case "${slice}" in
    ios-arm64|ios-arm64-simulator) echo "${archs}" | grep -qw "arm64"  || die "slice ${slice} missing arm64 (got: ${archs})";;
    ios-x86_64-simulator)          echo "${archs}" | grep -qw "x86_64" || die "slice ${slice} missing x86_64 (got: ${archs})";;
  esac
}

bundle_xcframework() {
  log "Bundling PJSIP.xcframework"
  rm -rf "${XCFRAMEWORK}"
  local args=(-create-xcframework)
  for slice in "${SLICES[@]}"; do
    args+=(-library "${BUILD_DIR}/${slice}/libPJSIP.a" -headers "${BUILD_DIR}/${slice}/include")
  done
  args+=(-output "${XCFRAMEWORK}")
  xcodebuild "${args[@]}"
  log "  → ${XCFRAMEWORK}"
  du -sh "${XCFRAMEWORK}"
}

# ---------- main ----------
main() {
  require_macos
  require_deps
  setup_ccache

  mkdir -p "${OUT_DIR}" "${BUILD_DIR}"
  clone_or_update_source

  if ! needs_rebuild; then
    log "Done (cached). XCFramework: ${XCFRAMEWORK}"
    exit 0
  fi

  for slice in "${SLICES[@]}"; do
    build_slice "${slice}"
    merge_slice_static "${slice}"
    assert_slice_arch "${slice}"
  done

  bundle_xcframework
  source_stamp > "${STAMP_FILE}"

  log "SUCCESS — XCFramework at ${XCFRAMEWORK}"
  log "REMINDER: linking this artifact into a closed-source IPA requires a signed"
  log "Teluu commercial license. See docs/whatsapp-migration/IMPL-pjsip-ios-license.md"
}

main "$@"
