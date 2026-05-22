# vendor/pjsip-android

Vendored PJSIP 2.14.1 build artefacts for the Android call engine migration
described in [`docs/whatsapp-migration/02-pjsip-android.md`](../../docs/whatsapp-migration/02-pjsip-android.md).
Companion to [`vendor/pjsip-ios`](../pjsip-ios/) (Agent 6, iOS).

Contents at runtime (after a successful build):

```
vendor/pjsip-android/
├── pjsip-2.14.1.aar          ← consumed by android/app/build.gradle (NOT YET WIRED)
├── build/
│   ├── arm64-v8a/jni-libs/   ← libpjsua2.so, libssl.so, libopus.so, libsrtp2.so, ...
│   ├── armeabi-v7a/jni-libs/
│   ├── x86_64/jni-libs/      ← required for emul-5554/5556 (see MEMORY)
│   └── src/                  ← pjproject @ 2.14.1, openssl, opus, libsrtp checkouts
└── README.md, .gitignore
```

The `.aar` is git-ignored; rebuild with `scripts/pjsip/build-android.sh`.

---

## Build instructions

```bash
# Pre-requisite: Android NDK r27c installed (matches self-host runner)
export ANDROID_NDK_ROOT=/opt/android-sdk/ndk/27.1.12297006

cd /root/webmail-app
bash scripts/pjsip/build-android.sh
```

Expected wall time on the self-host runner (217.216.67.99, 18 vCPU):
- Cold (no ccache): ~38 min for 3 ABIs.
- Warm (ccache hit ratio > 80 %): ~6 min.

To rebuild a single ABI while iterating on the bridge:

```bash
ABIS_OVERRIDE="arm64-v8a" bash scripts/pjsip/build-android.sh
```

Output lands at `vendor/pjsip-android/pjsip-2.14.1.aar`. The script is
idempotent — finished ABIs are skipped via a marker file
(`build/<ABI>/.built-2.14.1-release`). Delete the marker to force a redo.

### Tuning

All knobs live in [`scripts/pjsip/build-android.config`](../../scripts/pjsip/build-android.config):

| Knob | Default | Notes |
|------|---------|-------|
| `PJSIP_VERSION` | `2.14.1` | Bumping requires re-verifying ProGuard rules (R8 may need new `-keep`s for any renamed SWIG class). |
| `ANDROID_API_MIN` | `24` | Matches app.json minSdkVersion. Bumping to 26 enables AAudio unconditionally and lets us drop OpenSL ES from the build. |
| `ANDROID_ABIS` | `arm64-v8a`, `armeabi-v7a`, `x86_64` | x86_64 mandatory for the dual-emulator QA pipeline. |
| `PJSIP_FLAVOR` | `release` | `debug` skips `llvm-strip` and adds `-O0 -g`. Do NOT ship debug. |

The codec / AAudio settings come from [`scripts/pjsip/pjsua-android-config.h`](../../scripts/pjsip/pjsua-android-config.h)
(Opus 16 kHz prio 255 + SILK 16 kHz prio 128 + PCMU prio 64 + AAudio for API 26+,
OpenSL ES fallback below).

R8 / ProGuard rules ship inside the `.aar` from [`scripts/pjsip/pjsip.pro`](../../scripts/pjsip/pjsip.pro).
They are MANDATORY — see "License & legal" and the warning in §10 of the
Android plan doc.

---

## License & legal — BLOCKER before shipping

**PJSIP / pjproject is dual-licensed: GPLv2 OR commercial (Teluu).**

We ship a closed-source RN app on the Play Store. Distributing GPLv2-derived
binaries inside a non-GPLv2 application is a licence violation. Building
locally is fine for evaluation; bundling the resulting `.aar` into a
released APK/AAB is **NOT**.

Required action items, tracked in
[`docs/whatsapp-migration/IMPL-pjsip-android-license.md`](../../docs/whatsapp-migration/IMPL-pjsip-android-license.md):

1. Purchase a Teluu commercial license for pjproject 2.14.x. Quotes from
   <https://www.pjsip.org/licensing.htm> historically run USD 5–15 k for a
   single-product perpetual license + 1 year of updates.
2. Same coverage scope as iOS (Agent 6) — bundle both purchases so the legal
   paperwork is a single contract.
3. Once signed, drop the licence PDF in `legal/pjsip-commercial-license.pdf`
   (not yet created — make the dir under git lock-down so it isn't synced to
   any public mirror) AND flip a `PJSIP_LICENSED=true` build flag that the
   ship script will check before allowing a release build to proceed.

Until then: this directory exists for evaluation/CI-dry-run only. Do not
merge any branch that ships the `.aar` to internal-track testers without
sign-off from legal.

---

## Troubleshooting

- **`configure: error: NDK_ROOT not set`** — `ANDROID_NDK_ROOT` not exported.
  The script checks this first; if you see the inner pjsip error it means
  you're somehow bypassing our wrapper.
- **`UnsatisfiedLinkError: libpjsua2.so`** at runtime — almost always R8
  stripped the SWIG glue. Confirm the .aar's `proguard.txt` matches our
  `scripts/pjsip/pjsip.pro` and that `android.enableR8.fullMode=true` is
  still applying the rules. See "License & legal" §10 in the plan.
- **AAudio glitchy / robot voice on Pixel 6/7** — open the
  `PJMEDIA_AAUDIO_PREFER_SHARED` flag in `pjsua-android-config.h` and
  confirm it's `1`. Exclusive mode breaks on those devices.
- **x86_64 build fails with `assembler too old`** — install Linux host
  binutils ≥ 2.41 or use the bundled `llvm-mc` (default with NDK r27c).

---

## Status (BUILD AGENT 7)

- [x] Scripts written, idempotent, ccache-aware.
- [x] AAR packaging includes ProGuard rules + AndroidManifest stub.
- [x] Plan doc (§1–§11) honoured.
- [ ] **Not run** on CI yet (license blocker — see above).
- [ ] `android/app/build.gradle` integration — deferred to a later agent
      (constraint of this build).
- [ ] `NativeCallRoom.kt` rewire — deferred to a later agent.
