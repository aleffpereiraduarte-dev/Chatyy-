# PJSIP iOS XCFramework

This directory holds the pre-built `PJSIP.xcframework` artifact consumed by the
iOS app. The framework is **not** checked into git — it is built locally on the
shared Mac 207 build server.

## Status

| Item | Value |
|------|-------|
| PJSIP version | 2.14.1 (pinned in `scripts/pjsip/build-ios.config`) |
| Slices | `ios-arm64`, `ios-arm64-simulator`, `ios-x86_64-simulator` |
| Min iOS | 15.1 |
| Codecs | Opus (default), SILK fallback, PCMU last-resort |
| Crypto | OpenSSL 3.0 LTS (static) |
| Integrated into app | **No.** Phase 2 prep only — not linked in Podfile yet. |

## Build (Mac 207 only)

```bash
ssh administrator@207.254.28.52
cd ~/apps/webmail-app
bash scripts/pjsip/build-ios.sh
# → vendor/pjsip-ios/PJSIP.xcframework
```

The script is idempotent — re-running with no changes is a no-op (it stamps the
source hash + config hash in `.build/.source-stamp`).

### One-time setup on Mac 207

```bash
brew install ccache pkg-config autoconf automake libtool
# Build OpenSSL + Opus for iOS (scripts/pjsip/build-deps.sh — TBD next phase).
# For now, point OPENSSL_PATH + OPUS_PATH in build-ios.config at existing builds.
```

## License (READ THIS BEFORE LINKING)

**PJSIP/PJProject is dual-licensed:**

1. **GPLv2** — viral. Linking PJSIP into a closed-source binary distributed via
   the App Store would require the entire `Chatyy.ipa` to ship its source under
   GPLv2. Apple's repackaging on upload likely triggers redistribution.
2. **Teluu commercial license** — ~USD $4–6k perpetual, per-app. WhatsApp,
   Zoom, 8x8, RingCentral all hold one.

**Until Teluu signs a commercial license for `com.onemundo.mail`:**

- This XCFramework MAY be built locally for evaluation.
- It MAY NOT be linked into a TestFlight or App Store IPA.
- It MAY NOT be distributed to anyone outside Chatyy engineering.

See `docs/whatsapp-migration/IMPL-pjsip-ios-license.md` for the procurement
checklist and the legal blocker that gates every downstream phase.

## Why not vendor the source?

Vendoring `pjproject/**.c` into this repo would also subject Chatyy's source
to GPLv2 (the FOSS exception only applies if Chatyy itself ships under a
listed OSS license — it does not). The source lives in a sibling untracked
dir (`vendor/pjsip-src/`) that `scripts/pjsip/build-ios.sh` clones at build
time. CI rejects PRs that add `*.c` files under `vendor/pjsip-src/**`.

## Verifying the build artifact

```bash
# Confirm 3 slices present
ls vendor/pjsip-ios/PJSIP.xcframework
# Expect: ios-arm64/  ios-arm64-simulator/  ios-x86_64-simulator/  Info.plist

# Confirm arch matches
lipo -info vendor/pjsip-ios/PJSIP.xcframework/ios-arm64/libPJSIP.a
# Expect: Non-fat file: ... is architecture: arm64

lipo -info vendor/pjsip-ios/PJSIP.xcframework/ios-arm64-simulator/libPJSIP.a
# Expect: Non-fat file: ... is architecture: arm64

# Confirm Opus + OpenSSL got merged in
nm vendor/pjsip-ios/PJSIP.xcframework/ios-arm64/libPJSIP.a 2>/dev/null | grep -c opus_encoder_create
# Expect: > 0

nm vendor/pjsip-ios/PJSIP.xcframework/ios-arm64/libPJSIP.a 2>/dev/null | grep -c SSL_CTX_new
# Expect: > 0
```

## File map

| File | Purpose |
|------|---------|
| `../../scripts/pjsip/build-ios.sh` | Driver — clones source, builds 3 slices, bundles xcframework |
| `../../scripts/pjsip/build-ios.config` | env knobs (paths to OpenSSL/Opus, tag, min-iOS) |
| `../../scripts/pjsip/pjsip-config-site.h` | PJSIP build-time config (codec set, AVAudioSession, SRTP) |
| `../../scripts/pjsip/codec-priorities.swift` | Runtime codec config — applied during PJSUA init (Phase 2) |
| `../../docs/whatsapp-migration/01-pjsip-ios.md` | Design doc — read this first |
| `../../docs/whatsapp-migration/IMPL-pjsip-ios-license.md` | Legal blocker tracker |
