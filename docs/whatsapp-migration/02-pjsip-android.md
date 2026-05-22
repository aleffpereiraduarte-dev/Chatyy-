# Agent 2 — PJSIP Android Migration Plan

Mirrors Agent 1 (iOS). Target: replace LiveKit-based Android call engine with PJSIP/PJSUA2 while keeping the existing Compose UI, Telecom self-managed integration, FCM data-push ringing path, and `expo-callkit` JNI surface.

Baseline (read-only, do not modify):
- `modules/expo-callkit/android/src/main/java/expo/modules/callkit/NativeCallRoom.kt` (534 LOC, LiveKit `Room` singleton + adoptForCall + preconnect)
- `modules/expo-callkit/android/src/main/java/expo/modules/callkit/CallActivity.kt` (3338 LOC, Compose UI + LiveKit `VideoTrack` renderer)
- `modules/expo-callkit/android/src/main/java/expo/modules/callkit/ChatyyConnectionService.kt` (Telecom self-managed `ConnectionService` + `ChatyyConnection.onAnswer/onHold/onDisconnect`)
- `ChatyyInCallService.kt`, `CallFirebaseMessagingService.kt`, `CallSignalWs.kt`

Current dep dragged in: `io.livekit:livekit-android:2.24.1` (bundles libwebrtc ~28 MB per ABI). That is what we are evicting.

---

## 1. Library build approach (recommended)

**Pre-built `.so` per ABI, vendored under `android/libs/pjsip/<ABI>/`.** Do NOT build PJSIP from source in CI.

Rationale:
- PJSIP autoconf + Android NDK + OpenSSL + Opus build chain is ~40 min wall time and is allergic to NDK upgrades (we just stabilised NDK 27.1.12297006 for the self-host runner — see MEMORY `android_self_host_runner`). Source-building would break our 17 min CI budget.
- 3 ABIs needed: `arm64-v8a` (primary, 99% of testers), `armeabi-v7a` (legacy 32-bit), `x86_64` (emul-5554 / emul-5556 QA pipeline — non-negotiable per `android_emul_state_2026_05_15`).
- We mirror what WhatsApp ships: prebuilt PJSIP + PJMEDIA + PJLIB-UTIL + PJNATH stripped (no SDP audio video raw, no GSM, no L16) → ~3.5 MB per ABI compressed.

Build pipeline (one-shot, off CI):
1. macOS / Linux host with NDK r27c + `ANDROID_NDK_ROOT`.
2. `configure-android --use-ndk-cflags --with-ssl=<openssl>` per ABI loop (4 invocations).
3. Strip with `llvm-strip -x` then `aar` package with a tiny `build.gradle` exposing `pjsua2.jar` (SWIG-generated Java bindings) + native libs.
4. Publish to internal Maven (or just commit the `.aar` under `modules/expo-pjsip/android/libs/`).

Dependency choice — **PJSUA2 (C++) over raw PJSUA (C)**:
- PJSUA2 ships a SWIG-generated Java binding. We skip writing 3000 lines of JNI shims for `pjsua_call_make_call`, account registration, codec config, etc.
- PJSUA2 is what the official Android sample (`pjsip/pjproject/pjsip-apps/src/swig/java/android/`) uses → battle-tested.
- We still write **one** thin Kotlin layer (`PjsipBridge.kt`, see below) for everything that crosses a thread boundary or needs to wire into Telecom/CameraX. Pure call control stays in PJSUA2 Java.

Footprint budget: PJSIP+Opus+SRTP+OpenSSL ≈ 3.5 MB × 3 ABIs = **10.5 MB** (vs LiveKit+libwebrtc ≈ 84 MB). Net APK shrink ≈ 70 MB.

---

## 2. JNI bridge architecture

```
+--------------------------- expo-pjsip (new module) ---------------------------+
|                                                                              |
|  Kotlin layer (replaces NativeCallRoom.kt LK guts, KEEPS its public API)     |
|  ┌────────────────────────────────────────────────────────────────────────┐  |
|  │  PjsipBridge.kt        — singleton, mirrors NativeCallRoom surface     │  |
|  │    fun publish(callId, sipUri, ctx)                                    │  |
|  │    fun adoptForCall(...) -> Snapshot   (callable from JS bridge)       │  |
|  │    fun preconnect(sipUri, callId)      (FCM warmup, parity w/ LK)      │  |
|  │    fun setMicEnabled(b) / setCameraEnabled(b)                          │  |
|  │    fun disconnect()                                                    │  |
|  │  PjsipAccountManager.kt — SIP REGISTER w/ /api/voip_sip_credentials    │  |
|  │  PjsipCallObserver.kt   — extends CallCallback, emits RoomEvent-shape  │  |
|  │  PjsipAudioRoute.kt     — AudioManager + AAudio low-latency wiring     │  |
|  │  PjsipVideoCapturer.kt  — CameraX → pj_vid_dev_factory bridge          │  |
|  └────────────────────────────────────────────────────────────────────────┘  |
|                              │ (Java method calls)                           |
|  ┌────────────────────────────────────────────────────────────────────────┐  |
|  │  pjsua2.jar  (SWIG bindings, ~250 KB)                                  │  |
|  │    org.pjsip.pjsua2.{Endpoint,Account,Call,AudDevManager,VidDevManager}│  |
|  └────────────────────────────────────────────────────────────────────────┘  |
|                              │ (JNI via System.loadLibrary)                  |
|  ┌────────────────────────────────────────────────────────────────────────┐  |
|  │  libpjsua2.so      libpjsip.so    libpjmedia.so    libpjnath.so        │  |
|  │  libsrtp.so        libopus.so     libssl.so        libcrypto.so        │  |
|  └────────────────────────────────────────────────────────────────────────┘  |
|                                                                              |
+------------------------------------------------------------------------------+
       │                          │                          │
       ▼                          ▼                          ▼
+--------------+      +-----------------------+     +-----------------+
| CallActivity |      | ChatyyConnectionSvc   |     | ExpoCallKitModule|
| (unchanged   |      | (Telecom self-managed)|     | (RN bridge —    |
|  Compose UI) |      | onAnswer→Bridge.adopt |     |  adoptNativeRoom)|
+--------------+      +-----------------------+     +-----------------+
```

**Critical invariant**: `PjsipBridge` re-emits events with the same shape `NativeCallRoom` currently emits (`participant_connected`, `track_subscribed`, `connection_quality_changed`, `disconnected`). That keeps `CallActivity.kt` and the JS `adoptNativeRoom` path in `services/call.js` **untouched** — they consume the bridge through the existing `ExpoCallKitModule.emitCallEvent(...)` calls.

---

## 3. Audio strategy — AAudio low-latency

PJMEDIA on Android historically uses OpenSL ES (`pjmedia-aud-openSL`). To hit <20 ms RTT (WhatsApp parity, see iOS plan §4), we:

1. Compile PJMEDIA with `--enable-aaudio` (PJSIP 2.14+ supports AAudio native callbacks).
2. `PjsipAudioRoute.kt` calls `AudDevManager.setSndDev(captureIdx, playbackIdx)` where the indices point to the AAudio device IDs we enumerate via `AudioManager.getDevices(GET_DEVICES_INPUTS|OUTPUTS)`.
3. Request `AudioManager.MODE_IN_COMMUNICATION` + `setCommunicationDevice(...)` (API 31+) on call start, restore previous mode on `onDestroy`.
4. AEC: prefer hardware AEC (`AcousticEchoCanceler.create(sessionId)`) when `isAvailable()`, otherwise fall back to PJMEDIA's WebRTC AEC3 (already linked statically in our build).
5. Bluetooth + speakerphone toggle continues to flow through `ChatyyInCallService.kt` setAudioRoute — we just translate the route to `AudDevManager`.

Codec: Opus 16 kHz mono, 32 kbps, FEC enabled, DTX off (parity with iOS). Configured via `EpConfig.medConfig.audioFramePtime = 20`.

---

## 4. Video strategy — CameraX → PJMEDIA

PJMEDIA's stock Android camera (`pjmedia-vid-dev/android_dev.c`) uses Camera1 API — deprecated on API 30+. We replace it with **CameraX-backed `VideoCapturer`**:

1. `PjsipVideoCapturer.kt` runs a `CameraX.ImageAnalysis` use case at 720p @ 30 fps, YUV_420_888 output.
2. On each frame, we copy planes into a `pjmedia_frame` (preallocated pool) and push via `VidConference.sendFrame()` — implemented as a small custom `pj_vid_dev_factory` registered at `Endpoint.libCreate`.
3. Remote rendering: PJMEDIA decodes → we receive frames on a `VideoSink` callback → blit to a `SurfaceView` inside Compose via `AndroidView { SurfaceView(it) }`. This swaps for the LiveKit `VideoTrack` `SurfaceViewRenderer` currently used in `CallActivity.kt:~line 1800`.
4. Codec: VP8 default (H.264 hardware encode optional via `MediaCodec` if device supports `OMX.qcom.video.encoder.avc` — fallback to software VP8 for emulators).

---

## 5. Telecom integration

`ChatyyConnectionService` already does the right ceremony — we just rewire the body of `ChatyyConnection.onAnswer()`:

```
Before: onAnswer { NativeCallRoom.adoptForCall(callId, lkToken, lkUrl, ctx) }
After:  onAnswer { PjsipBridge.adoptForCall(callId, sipUri, sipCreds, ctx) }
```

- Audio focus: Telecom self-managed already calls `setAudioRoute(ROUTE_EARPIECE)` etc. — `PjsipAudioRoute` just listens to `Connection.onCallAudioStateChanged` and pushes the matching device to `AudDevManager.setSndDev`.
- CallKit-equivalent: nothing to do — `ChatyyConnectionService` + `IncomingCallActivity` are the equivalent of iOS CallKit/CXProvider.
- `addNewIncomingCall` from `CallFirebaseMessagingService` keeps working unchanged (FCM data-only → Telecom → ringing UI).

---

## 6. Compose UI integration

`CallActivity.kt` keeps its 3338-line Compose tree. Two surgical swaps only:

1. **Remote video sink**: replace the LiveKit `SurfaceViewRenderer { lkVideoTrack.addRenderer(it) }` block with an `AndroidView` hosting `PjsipBridge.getRemoteVideoSurface(participantId)`. Surface lifecycle bound to `DisposableEffect`.
2. **State events**: `LaunchedEffect(roomState)` already listens to `NativeCallRoom.events.collect`. `PjsipBridge` exposes the same `MutableSharedFlow<RoomEvent>` (mapping PJSIP `OnCallStateNotifyParam` → synthetic `RoomEvent.ParticipantConnected/Disconnected`). Zero Compose code changes downstream.

---

## 7. Background service — PJSIP survives backgrounding

PJSIP Endpoint MUST live in a foreground service so Doze/App Standby don't kill the SIP socket. Reuse `CallOngoingService.kt` (already a `FOREGROUND_SERVICE_PHONE_CALL` type per `play_foreground_service_cicd_quirk`):

- `CallOngoingService.onCreate` → `PjsipBridge.ensureEndpointStarted(ctx)` (idempotent).
- Endpoint is held inside the service's process; bridge is a `object` singleton scoped to application classloader so config survives Activity recreation.
- WiFi/Cellular network change: PJSIP has built-in `Endpoint.handleIpChange()` — we wire it to a `ConnectivityManager.NetworkCallback` registered in the service.
- SIP keepalive: 30 s STUN binding through `turn.chatyy.com.br` (already in MEMORY infra), no FCM ping needed mid-call.

---

## 8. Migration phases

| Week | Scope | Behind flag? |
|------|-------|--------------|
| W1 | Add `expo-pjsip` Gradle subproject. Vendor `.aar` (3 ABIs). Wire `PjsipBridge.ensureEndpointStarted` no-op call in `CallOngoingService`. App still uses LK. | yes (`PJSIP_ENABLED=false`) |
| W2 | Implement `PjsipAccountManager` + SIP REGISTER against new SIP edge (`sip.chatyy.com.br`). REGISTER-only smoke test on emul-5554. Audio still on LK. | yes |
| W3 | Implement `PjsipAudioRoute` + AAudio path + AEC. Audio-only outgoing call (no video) routed through PJSIP behind flag. A/B vs LK with telemetry: setup-time, MOS, jitter. | yes |
| W4 | Implement `PjsipVideoCapturer` (CameraX) + remote `SurfaceView`. Swap Compose remote tile to PJSIP surface. Dual-emul QA (5554↔5556). | yes |
| W5 | Group call (3-party conf) via PJSUA2 `VidConference` + `AudioMedia.startTransmit` mesh. Match iOS group semantics. | yes |
| W6 | Flip flag default→on for 5% testers (Play internal track per `play_track_internal_2026_05_20`). Keep LK code paths as fallback. | rollout |
| W7 | 50% rollout. Burn LK code paths in a separate branch; do NOT delete yet. | rollout |
| W8 | 100% rollout. After 7 stable days, delete `livekit-android` dep + LK code paths in `NativeCallRoom.kt`, `CallActivity.kt`. APK drops ~70 MB. | off |

---

## 9. Risk assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| AAudio + AEC misconfiguration → echo / robot voice | HIGH | Hardware AEC first, MOS telemetry per device model, ship hardware-AEC blocklist for known-bad chipsets (MediaTek MT676x family). |
| CameraX → PJMEDIA frame-copy CPU stall on low-end devices | MED | Cap at 480p @ 24 fps on devices with `<4 GB RAM` (Build.getMemoryInfo()). |
| ABI bloat re-creeping (we just shrank 70 MB, must not regress) | MED | `bundleRelease` ABI splits + per-ABI APK size check in CI. Fail PR if any ABI > 60 MB. |
| PJSIP `.so` ProGuard / R8 strips JNI-entry classes | MED | Add `-keep class org.pjsip.pjsua2.** { *; }` + `-keepclasseswithmembernames class * { native <methods>; }` in `consumer-rules.pro` shipped with the `.aar`. |
| SIP edge not yet built (server-side WhatsApp-style edge is agent 4's scope) | HIGH | W1 unblocks by hitting a temporary Asterisk dev SIP at `sipdev.chatyy.com.br`. Cut over to prod edge in W3. |
| Telecom self-managed not allowed on some OEMs (Xiaomi, Vivo limit `MANAGE_OWN_CALLS`) | MED | Already a current LK limitation, no regression. Fallback to `IncomingCallActivity` full-screen-intent path (already in place). |
| FCM warmup race vs `preconnect()` parity with LK | LOW | Mirror iOS PushKit warm path. PJSIP `Endpoint.libRegisterThread` is cheap (~5 ms). |

---

## 10. ProGuard / R8 considerations

Ship a `consumer-rules.pro` inside the `expo-pjsip` `.aar`:

```
-keep class org.pjsip.** { *; }
-keepclasseswithmembernames class * { native <methods>; }
-keep class expo.modules.pjsip.PjsipCallObserver { *; }
-keep class expo.modules.pjsip.PjsipAccountManager { *; }
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
-dontwarn org.pjsip.**
```

R8 full-mode is fine; the SWIG-generated classes use reflection-style `swigCPtr` long fields that look unreachable but are. The `-keep` rules above are mandatory — without them, R8 in production builds will silently strip `Endpoint.libCreate` and the app will `UnsatisfiedLinkError` at first call. Already a known issue from the `chatyy-ws-cpp` SWIG experiments.

---

## 11. Testing strategy — dual emulator

Per `android_emulator_server.md` (213.136.72.141) and `qa_secondary_account.md`:

- **emul-5554** = `duarteapps1@gmail.com` (caller, our user).
- **emul-5556** = `duarte@chatyy.com.br` / `Aleff2009@@` (callee).

QA matrix:
1. Audio outbound: 5554 → 5556 → assert remote audio within 1.2 s of `onAnswer`.
2. Audio inbound (FCM ring): kill 5556, send call from 5554, FCM wakes Telecom, IncomingCallActivity shows, accept, audio < 1.5 s.
3. Video: enable cam both sides, assert remote `SurfaceView` paints first frame < 800 ms.
4. Mid-call WiFi→LTE switch on emul (toggle via `adb shell svc wifi disable`): `handleIpChange()` re-INVITEs, audio resumes < 3 s.
5. Background survival: tap home on 5554 mid-call, wait 60 s, assert audio still flowing (no Doze kill of foreground service).
6. App killed mid-call: swipe from recents on 5554, assert Telecom `Connection.onDisconnect(LOCAL)` fires → 5556 sees `disconnected` event < 2 s.
7. Group call 3-party (add a third emul if available, else physical device + 2 emuls).
8. Speaker / Bluetooth route toggle during call: `setAudioRoute` flips `AudDevManager.setSndDev` without dropping the stream.
9. APK size guard: `./gradlew :app:bundleRelease` + `bundletool` per-ABI APK extract — assert arm64-v8a < 50 MB.
10. ProGuard release smoke: `assembleRelease` + install + outgoing call (catches R8 stripping regressions).

CI hook: a Gradle `connectedAndroidTest` flavor `pjsip` runs cases 1–4 on the self-hosted Android runner before any PJSIP-touching PR can merge.

---

## Done.

File: `/root/webmail-app/docs/whatsapp-migration/02-pjsip-android.md`. Mirrors agent 1 iOS plan. Production code untouched.
