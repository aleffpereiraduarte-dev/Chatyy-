# PJSIP iOS Migration Plan (Agent 1/10)

Replace `@livekit/react-native` + libwebrtc with PJSIP native on iOS — WhatsApp parity. Design only.

---

## 1. Library version + license verdict

- **Version**: PJSIP/PJProject **2.14.1** (stable, Feb 2025). Opus built-in, ICE-rewrite, SRTP/DTLS dual, arm64 + sim-arm64 slices ship.
- **License**: GPLv2 + FOSS exception OR commercial Teluu license.
  - GPLv2 is incompatible with closed-source IPAs (Apple repackaging triggers redistribution). **Verdict: buy commercial license** (~USD $4–6k, perpetual). WhatsApp, Zoom, 8x8 all hold one.
  - LGPL escape does NOT apply — PJSIP is GPL.
- **Blocker**: legal must close the license before phase 6; until then PJSIP stays behind a feature flag and TestFlight internal only.

---

## 2. iOS integration approach (recommended)

| Approach | Verdict |
|---|---|
| CocoaPods community pod | Reject — stuck on 2.10, no arm64-sim |
| Pre-built XCFramework off-the-shelf | Reject — no codec control |
| **Build from source → XCFramework** | **Pick** — full control, ccache-able on Mac 207 |

Plan: `vendor/pjsip/` submodule pinned to `2.14.1`; `scripts/build-pjsip-ios.sh` runs `configure-iphone` with our `config_site.h` (Opus on, video on, ICE on, SRTP on, G.722/BCG729 off); output `vendor/pjsip-prebuilt/PJSIP.xcframework` (device-arm64 + sim-arm64 + sim-x86_64) tracked via Git LFS; Podfile uses `pod 'PJSIP', :path => 'vendor/pjsip-prebuilt'`. Mac 207 ccaches the source build.

Binary cost: ~12 MB per slice vs current LiveKit+WebRTC 38 MB → net IPA shrink ≈ 50 MB.

---

## 3. Wrapper architecture (ASCII)

PJSIP is ANSI C. RN consumes it through an Obj-C++ shim (`.mm`) so we get C++ STL inside while exposing Swift-friendly classes.

```
+--------------------------------------------------------------+
| React Native (JS)                                            |
|  services/callService.js  → NativeModules.ChatyyCall.*       |
+--------------------------------------------------------------+
                          │  bridge (sync + events)
+--------------------------------------------------------------+
| Swift layer                                                  |
|  ChatyyCallModule.swift  (Expo Module API; replaces parts of |
|                           ExpoCallKitModule.swift)           |
|  CallViewController.swift  (UNCHANGED shell, internals       |
|                             repointed at PJSipSession)       |
|  PJSipSession.swift  (Swift-facing actor; thread-confines    |
|                       calls to a serial pjsip queue)         |
+--------------------------------------------------------------+
                          │  @_silgen_name / clang-importer
+--------------------------------------------------------------+
| Obj-C++ wrapper (.mm)                                        |
|  PJSipBridge.mm     - pjsua_* calls, thread registration     |
|  PJSipMedia.mm      - audio device + video frame pump        |
|  PJSipEvents.mm     - C callbacks → NSNotification           |
|  PJSipCodec.mm      - codec priority + Opus tuning           |
+--------------------------------------------------------------+
                          │  static link
+--------------------------------------------------------------+
| PJSIP.xcframework (C)                                        |
|   pjsua2 (high-level) + pjsua (low-level)                    |
|   pjmedia · pjnath (ICE) · pjlib · libsrtp · opus · pjsip    |
+--------------------------------------------------------------+
                          │  syscalls
+--------------------------------------------------------------+
| AVAudioSession  ·  AVCaptureSession  ·  Network framework    |
+--------------------------------------------------------------+
```

Obj-C++ vs Obj-C: video frame cb fires at 30 fps from a media thread — `std::atomic`/`std::lock_guard` beat `os_unfair_lock` (same-thread only).

---

## 4. AVAudioSession ownership coordination with CallKit

Highest-risk area (LiveKit gave us 4 incidents in 2026). Rules:

- **CallKit owns activation.** Only `CXProvider didActivate audioSession:` may call `pjsua_set_snd_dev(...)`. Earlier = silent call.
- **Category set before `reportNewIncomingCall`.** `VoipPushAppDelegateSubscriber.swift` already configures `.playAndRecord, mode: .voiceChat, [.allowBluetooth, .allowBluetoothA2DP, .duckOthers]`. PJSIP must NOT `setActive(true)` itself — set `PJMEDIA_SND_DEV_NO_AUTO_OPEN_AUDIO`.
- **didDeactivate**: call `pjsua_set_no_snd_dev()` to release the AU first; otherwise next call hits `kAudioUnitErr_TooManyFramesToProcess`.
- **Route changes** (Bluetooth in/out): on `AVAudioSession.routeChangeNotification`, mute mic → `pjsua_set_snd_dev(-1,-1)` → re-resolve via `pjmedia_aud_dev_count()` → `pjsua_set_snd_dev`. ~80 ms gap.
- `AudioRouter.swift` stays; `setOutput(.speaker)` now toggles `pjmedia_aud_stream_set_cap(..., OUTPUT_ROUTE, ...)` instead of LK `AudioManager`.

---

## 5. Codec config — Opus 16 kHz @ 20 kbps + SILK fallback

WhatsApp spec (webrtchacks 2024): Opus 16 kHz mono, 20 kbps, 20 ms ptime, in-band FEC + DTX on. SILK 12 kHz fallback. `PJSipCodec.mm`:

```objc
// Disable everything, then enable + prioritize our set.
pjsua_codec_set_priority(pj_str((char*)"*"), 0);
pjsua_codec_set_priority(pj_str((char*)"opus/48000/2"), 255);
pjsua_codec_set_priority(pj_str((char*)"SILK/16000"),   128);
pjsua_codec_set_priority(pj_str((char*)"PCMU/8000"),     64); // last-resort

// Opus tuning - matches WhatsApp wire format
pjmedia_codec_param param;
pjsua_codec_get_param(pj_str((char*)"opus/48000/2"), &param);
param.setting.frm_per_pkt = 1;              // 20 ms ptime
param.setting.vad         = 1;              // DTX
param.setting.plc         = 1;
// Custom Opus params via setting.dec_fmtp:
//   maxplaybackrate=16000; sprop-maxcapturerate=16000;
//   maxaveragebitrate=20000; useinbandfec=1; usedtx=1; stereo=0
pjsua_codec_set_param(pj_str((char*)"opus/48000/2"), &param);
```

Video: H.264 Constrained Baseline 3.1 (profile-level-id `42e01f`) priority 255; VP8 priority 128 fallback.

---

## 6. SRTP/SDES (not DTLS-SRTP)

WhatsApp uses SDES because (a) SDP carries the key in `a=crypto:` lines → one fewer RTT vs DTLS handshake on media path (≈150 ms saved cold), (b) DTLS-SRTP keepalive is a background battery killer on iOS, (c) SIP signaling is already over TLS so SDES inherits transport security.

```objc
pjsua_acc_config acc_cfg;
pjsua_acc_config_default(&acc_cfg);
acc_cfg.use_srtp           = PJMEDIA_SRTP_MANDATORY;
acc_cfg.srtp_secure_signaling = 1;  // require sips: or TLS
// AES_CM_128_HMAC_SHA1_80 only (RFC 4568) — matches WhatsApp profile
```

Transport is TLS/5061 (Telnyx already; Kamailio bridge per Agent 4). DTLS-SRTP stays compiled-in but runtime-disabled for fallback.

---

## 7. SwiftUI CallView integration

Today: `CallView.swift` reads `@Published var remoteVideoTrack: VideoTrack?` (LiveKit) and renders via `VideoView(track: …)`.

After:

```swift
// In CallSessionState (file unchanged elsewhere)
@Published var remoteFrame: CVPixelBuffer?  // pushed by PJSipMedia

// New SwiftUI view (drop-in replacement for LiveKit's VideoView)
struct PJSipVideoView: UIViewRepresentable {
  let pixelBuffer: CVPixelBuffer?
  func makeUIView(context: Context) -> SampleBufferDisplayLayerView { … }
  func updateUIView(_ v: SampleBufferDisplayLayerView, context: Context) {
    if let pb = pixelBuffer { v.enqueue(pb) }
  }
}
```

PJSIP delivers I420 `pjmedia_frame`; `PJSipMedia.mm` wraps it zero-copy as `CVPixelBuffer` (`420YpCbCr8BiPlanarFullRange` via `IOSurface`) then assigns on main. PiP (`AVPictureInPictureVideoCallViewController`) shares the same `AVSampleBufferDisplayLayer` host view.

---

## 8. PJSUA API mapping

| LiveKit today | PJSUA after |
|---|---|
| `room.connect(url, token)` | `pjsua_acc_add` + REGISTER 200 |
| publishTrack(audio) | implicit via `pjsua_call_make_call` |
| `setMicrophoneEnabled(false)` | `pjsua_conf_adjust_tx_level(port, 0.0)` |
| `setCameraEnabled(true)` | `pjsua_call_set_vid_strm(..., START_TRANSMIT)` |
| `room.disconnect()` | `pjsua_call_hangup(id, 200, NULL, NULL)` |
| `didFailToConnect` | `on_call_state` `INV_DISCONNECTED` + cause ≥400 |
| `didReceiveData` | `on_pager` (in-call MESSAGE) or RTCP-APP |

Outbound flow:

```objc
pj_str_t dst = pj_str((char*)"sip:bob@chatyy.com.br;transport=tls");
pjsua_call_setting setting;
pjsua_call_setting_default(&setting);
setting.vid_cnt = isVideo ? 1 : 0;
setting.aud_cnt = 1;
pjsua_call_id callId;
pjsua_call_make_call(accId, &dst, &setting, NULL, NULL, &callId);
```

---

## 9. NAT traversal — use PJSIP's built-in ICE/STUN/TURN

Decision: **drop the WASP-style custom protocol idea**. `pjnath` is the same ICE family libwebrtc derived from (RFC 8445 + 8489); saves 3 weeks. Config:

```objc
pjsua_media_config_default(&med);
med.enable_ice    = PJ_TRUE;
med.enable_turn   = PJ_TRUE;
med.ice_max_host_cands = 4;
med.turn_server   = pj_str((char*)"turn.chatyy.com.br:3478");
med.turn_conn_type = PJ_TURN_TP_TCP;            // TLS in prod
med.turn_auth_cred.data.static_cred.username = pj_str((char*)"chatyy");
// shared-secret matches existing TURN_SECRET in /etc/mail-api.env
```

`turn.chatyy.com.br` already operational (grey-cloud, no re-provision).

---

## 10. Migration path from `CallViewController.swift`

**Stays** (~1500 of 2160 lines): `CXProvider` plumbing, `VoipPushAppDelegateSubscriber`, SwiftUI `CallView` layout/gestures/PiP scaffold, `AudioRouter.swift`, ringtone/haptics, `CallSignalWs.swift` (chatyy WS invite/ringing/hangup — SIP REGISTER is too slow for iOS background cold-start invite delivery).

**Replaced** (~660 lines): all `LiveKitClient` imports; `room: Room?` + `NativeCallRoom.shared` → `pjsipSession: PJSipSession`; `VideoView` → `PJSipVideoView`; LK `RoomDelegate` → `PJSipSessionDelegate` (Swift protocol bridged from C cb); sample-buffer renderer attach (we own the buffer end-to-end now).

---

## Migration phases (week by week)

| Wk | Milestone | Exit |
|----|-----------|------|
| 1 | License signed; submodule + build script on Mac 207 | XCFramework artifact builds |
| 2 | `PJSipBridge.mm` + `PJSipSession.swift`; loopback call | Hear own voice via SDES Opus |
| 3 | `PJSipMedia.mm` frame pump; `PJSipVideoView`; PiP | 30 fps remote video + PiP |
| 4 | CallKit + AVAudioSession; route changes; BT | 10-min call, swap AirPods, no glitch |
| 5 | Kamailio/Telnyx; TURN/ICE soak | p95 setup < 1.5 s on cellular |
| 6 | Server flag `pjsip_ios_enabled` ramp 10 → 50 → 100 % | No decline-rate regression |
| 7 | Remove `@livekit/react-native-webrtc` | IPA −40 MB; LK pod gone |

---

## Risk assessment

| Risk | L | I | Mitigation |
|------|---|---|-----------|
| Commercial license blocked/over-budget | M | blocker | Negotiate now; linphone-sdk LGPL as plan-B |
| Opus param mismatch w/ WhatsApp wire | L | H | We don't interop with WA — parity only |
| AVAudioSession deadlock under CallKit + ReplayKit (`replaykit_lk_refactor_pending`) | M | H | Gate ReplayKit on call state; ban during active SIP call |
| arm64-sim slice missing → M-series sim breaks | M | M | Build script asserts 3 slices before packaging |
| PJSIP H.264 HW-decoder gap → SW fallback | H | M | Custom `pjmedia_vid_codec` → VideoToolbox (~1 wk extra) |
| Mid-call re-INVITE drops audio 200–800 ms | M | M | Disable mid-call res adapt; renegotiate only on network type change |
| GPL contamination via accidental source vendor | L | severe | CODEOWNERS on `vendor/pjsip/`; CI rejects `.c` sources in PRs |

---

## Testing strategy

- **Mac 207 unit**: `xcodebuild test -scheme PJSipTests` + ASAN/TSAN on `PJSipBridge.mm`; PJSUA mocked via `dlsym` shim.
- **Loopback device**: apitest@onemundo.com.br ↔ duarte@chatyy.com.br nightly 50-call soak (Mac 207-wired iPhone).
- **TestFlight internal only** until phase 6; double-gated by server flag.
- **A/B canary**: `call_setup_p95_ms`, `call_drop_rate`, `audio_route_change_failure_rate` in `/var/www/suporte/`; add `stack=lk|pjsip` dim before phase 6.
- **Drills**: TURN down, airplane mode mid-call, AirPods rip, ReplayKit during call, CallKit hold from another VoIP app — scripted via `xcrun simctl` + `idb`.
- **Device matrix**: iPhone SE 2, 13, 15 Pro, iPad Air M2.

---

End of Agent 1 plan. Hand-off to Agent 2 (Android PJSIP) for codec/SDES parity on the other platform.
