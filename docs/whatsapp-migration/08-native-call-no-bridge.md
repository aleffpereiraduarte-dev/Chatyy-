# 08 — Native Call Lifecycle (No RN Bridge)

> **Agent 8 / 10** — eliminate JS bridge from the call hot-path. CallKit (iOS) and Telecom (Android) own the entire call lifecycle. JS only renders the chat screen + a "currently on call" status bar.

## Why

Every P0 we shipped this week traced back to JS↔native marshalling on the call path:

| Bug | Root cause |
|---|---|
| C++ WS envelope wrap eternal | `call_invite` envelope round-tripped JS before CallKit reported |
| `callee_email=""` | RN bridge dropped string when `chat-conversation.js` was unmounted |
| CallKit Error 7 MaxCallGroups | JS reported `endCall` after RN bridge GC'd the UUID |
| "Connecting..." eterno | LiveKit `Room.connect` resolved in JS but CallKit timer ticked in native — desync |

WhatsApp's call stack is zero JavaScript. We adopt the same posture.

---

## 1. Component Ownership Matrix

| Layer | Today (broken) | After migration |
|---|---|---|
| Incoming push parsing | JS (`pushRouter.js`) | **Native** (`VoipPushAppDelegateSubscriber.swift`, `CallFirebaseMessagingService.kt`) |
| CallKit/Telecom report | JS via `ExpoCallKit.reportNewIncoming()` | **Native** direct `CXProvider.reportNewIncomingCall` |
| Ring UI (lockscreen) | iOS native, Android JS Activity | **Native both** (iOS CallKit, Android `CallActivity` Compose) |
| In-call screen | JS `/call.js` w/ RN bridge to LiveKit Room | **Native** SwiftUI `CallView` / Compose `InCallScreen` |
| Signaling (SDP/ICE/SIP) | LiveKit JS SDK | **PJSIP native** (`PJCall.mm`, `PJCall.kt`) |
| Audio session | JS toggles `lkSetMic` | **Native** `AVAudioSession` / Android `AudioManager` |
| Call state machine | JS Redux + native — TWO copies | **Native single source** |
| Call button in chat | JS `chat-conversation.js` | **JS** (only triggers native via ExpoModule) |
| "On call with X" status bar | JS `CallStatusBar.js` | **JS** (reads native state via ExpoModule) |
| Web `/call.web.js` | JS | **JS** (web has no PJSIP — stays JS-only) |

---

## 2. iOS Lifecycle (Pure Obj-C++ / Swift)

### 2a. Incoming

```
APNs VoIP push
   │
   ▼
PKPushRegistry (modules/expo-callkit/ios/VoipPushAppDelegateSubscriber.swift)
   │  parses payload {call_id, caller_email, caller_name} — no JS roundtrip
   ▼
CXProvider.reportNewIncomingCall(uuid, update)  ◀── synchronous, < 50 ms
   │
   ▼ user taps Accept (lockscreen / CallKit UI)
CXAnswerCallAction → ProviderDelegate.provider(_:perform:)
   │
   ▼
PJCall.answer(call_id)              [PJSIP INVITE 200 OK]
   │
   ▼
CXProvider.reportOutgoingCall(connectedAt:)
   │
   ▼
SwiftUI CallView mounted as rootViewController.present(_:)
   │  bound to PJCallStateObservable (Combine)
   ▼
Audio path: PJSIP <-> AVAudioSession (CallKit owns activation)

JS notification (ONE-SHOT, fire-and-forget):
   NotificationCenter.default.post(name: .callStarted, …)
   → ExpoModule emitter → JS receives `on_call_started`
   → chat-conversation.js refreshes CallStatusBar
```

### 2b. Outgoing

```
User taps Call button (chat-conversation.js)
   │  ChatyyCallNative.startCall(peerEmail, video: bool)   ◀── ExpoModule fn
   ▼
ChatyyCallModule.swift  [native]
   │
   ▼
CXStartCallAction → ProviderDelegate
   │
   ▼
PJCall.invite(peerEmail) → SIP INVITE
   │
   ▼
CallView mounted, ringback tone, etc.
```

**The JS function returns void.** No promise resolved with call object. No state in JS. JS waits for `on_call_started` event.

---

## 3. Android Lifecycle (Pure Kotlin/C++)

### 3a. Incoming

```
FCM data message {type: "call_invite", call_id, caller_email}
   │
   ▼
CallFirebaseMessagingService.onMessageReceived()
   │  parses NATIVE — never enters RN reactContext
   ▼
TelecomManager.addNewIncomingCall(phoneAccountHandle, extras)
   │
   ▼
ChatyyConnectionService.onCreateIncomingConnection()
   │  returns ChatyyConnection (extends Connection)
   ▼
Full-screen Notification + CallActivity launched (singleTask, showWhenLocked)
   │
   ▼ user taps Accept on Compose UI
ChatyyConnection.onAnswer()
   │
   ▼
PJCall.answer(call_id)  [JNI → libpjsip.so]
   │
   ▼
CallActivity stays foregrounded with InCallScreen Compose
```

Key: `CallActivity` is **not** a React Native activity. It is `ComponentActivity` with `setContent { InCallScreen(...) }`. It runs in its own task, can outlive the RN process.

### 3b. Outgoing

```
chat-conversation.js → ChatyyCallNative.startCall(peerEmail)
   │
   ▼
ChatyyCallModule.kt
   │  TelecomManager.placeCall(uri, extras)
   ▼
ChatyyConnectionService.onCreateOutgoingConnection()
   │
   ▼
PJCall.invite → CallActivity
```

---

## 4. ExpoModule API (Minimal, Read-Mostly)

`modules/chatyy-call-native/expo-module.config.json` exposes ONLY:

```ts
// JS-side type (read-only, no setters except startCall/endCall)
interface ChatyyCallNative {
  // Triggers — fire-and-forget, no return value
  startCall(peerEmail: string, video: boolean): void;
  endCall(): void;                       // user-initiated hang-up from chat screen
  toggleMute(): void;
  toggleSpeaker(): void;

  // Snapshot read (sync) — for CallStatusBar rendering
  getCurrentCall(): {
    callId: string;
    peerEmail: string;
    peerName: string;
    state: 'ringing' | 'connecting' | 'active' | 'held';
    startedAt: number;       // epoch ms, 0 if not yet active
    isMuted: boolean;
    isSpeaker: boolean;
    isVideo: boolean;
  } | null;

  // Events (NativeEventEmitter, fire-and-forget)
  // - "on_call_started"  { callId, peerEmail }
  // - "on_call_ended"    { callId, reason }     reason: completed | declined | failed | timeout
  // - "on_call_muted"    { isMuted }
}
```

That's the **entire surface**. No SDP, no ICE candidates, no LiveKit Room handle, no audio track refs. JS literally cannot break the call.

CallStatusBar polls `getCurrentCall()` on `on_call_started` + on 1 s timer for the duration counter (sync call, ~30 µs roundtrip).

---

## 5. Migration Plan

### Phase 0 — Today
- Native modules `expo-callkit` (iOS only) + `react-native-callkeep` (Android, not even installed — see [call_regression_android_native_missing](../../memory/call_regression_android_native_missing.md))
- JS `/call.js` owns Room, mic, camera, UI

### Phase 1 — Native scaffolding (Week 1)
1. New module `modules/chatyy-call-native/` with iOS Swift + Android Kotlin
2. PJSIP integration (Agent 5 spec)
3. CallKit ProviderDelegate moved out of `expo-callkit` legacy into new module
4. Android `CallActivity` + `ChatyyConnectionService` registered in `AndroidManifest.xml`
5. ExpoModule emits two events only — wire CallStatusBar to consume them

### Phase 2 — Cutover (Week 2)
1. Feature flag `call_v2_native` per-user (admin.php → push to chat_user_settings)
2. When flag ON: `chat-conversation.js` calls `ChatyyCallNative.startCall` and SKIPS `router.push('/call')`
3. JS `/call.js` becomes dead code on mobile, stays on web (`/call.web.js`)
4. Remove `lkSetMic`, `lkSetCam`, `adoptNativeRoom` bridges
5. Backend `chat_call_invite` payload simplified — strip LiveKit token from native devices (PJSIP doesn't need it)

### Phase 3 — Cleanup (Week 3)
1. Delete `/call.js` (keep `.web.js`)
2. Delete `expo-callkit` legacy module (functionality absorbed)
3. Remove `livekit-client` from native bundle (web keeps it)
4. Bundle size audit (see §8)

### Phase 4 — Drop bridge events (Week 4)
1. `on_call_started`/`on_call_ended` remain — they are the **only** JS↔native messages during a call
2. Verify no other code touches calls in JS via grep

---

## 6. Web Considerations

Web has no PJSIP, no CallKit, no Telecom. Web stays on:
- `/call.web.js` (React + WebRTC + LiveKit JS)
- LiveKit room signaling unchanged
- `CallStatusBar.web.js` reads JS state, not native

`chat-conversation.js` branches on `Platform.OS`:
```js
if (Platform.OS === 'web') {
  router.push(`/call?peer=${peerEmail}`);
} else {
  ChatyyCallNative.startCall(peerEmail, false);
}
```

Backend supports both: web devices get LiveKit token, native devices get SIP credentials (see Agent 5). The `chat_call_invite` endpoint inspects `User-Agent` / `X-Chatyy-Platform` header.

---

## 7. Risk Assessment

| Risk | Mitigation |
|---|---|
| Native UI is harder to A/B test | Feature flag `call_v2_native` gates rollout per-user; can rollback by toggling flag |
| Theming / i18n duplicated (SwiftUI + Compose + JS web) | Generate strings from single `i18n/en.json` via codegen script in CI; colors from `Theme.json` to `Colors.xcassets` + `colors.xml` |
| Call screen feature parity (PIP, screen share, reactions) | Stage parity table per platform; only ship features available on all 3. PIP iOS done in CallKit natively; Android requires `enterPictureInPictureMode()` on `CallActivity` |
| Native crash kills whole app | Sandboxed: PJSIP crashes inside `ChatyyConnectionService` (Android) / extension-like delegate (iOS). Add Bugsnag native handlers |
| Hot-reload dev loop slow | Native devs use Mac 207 + Xcode + Android Studio direct. JS devs untouched — chat screen still hot-reloads |
| Lost OTA agility for call bugs | Accepted trade-off. Calls are not OTA-able. Match WhatsApp / Signal / Telegram posture |
| Migration of in-flight calls | Cutover only applies to NEW calls. Active LiveKit calls finish on old path. Flag check at `startCall` only |

---

## 8. Bundle Size + Perf

### Size delta

| Component | iOS (per arch) | Android (per ABI) |
|---|---|---|
| Add: PJSIP static lib | +2.8 MB arm64 | +3.1 MB arm64-v8a, +2.9 MB armeabi-v7a |
| Add: Opus codec | +180 KB | +210 KB |
| Add: chatyy-call-native module | +90 KB | +110 KB |
| Remove: livekit-client JS (mobile bundle) | −620 KB minified | −620 KB |
| Remove: livekit-react-native native | −1.2 MB | −1.8 MB |
| Remove: `/call.js` JS bundle code | −85 KB | −85 KB |
| **Net** | **+1.16 MB / arch** | **+0.71 MB armeabi, +0.93 MB arm64** |

Acceptable. WhatsApp ships at 75 MB iOS / 40 MB Android; Chatyy currently 32 MB iOS / 28 MB Android. Headroom present.

App Bundle (`.aab`) split-APK delivers only the user's ABI — Play download impact is single ABI.

### Perf

| Metric | JS bridge today | Native target |
|---|---|---|
| Push → CallKit ring | 800–2400 ms (bridge cold-start) | 30–80 ms |
| Accept → audio flowing | 1.5–4 s (LiveKit JS connect) | 300–600 ms (PJSIP INVITE 200 OK) |
| End call → screen dismissed | 200–800 ms (RN unmount) | < 100 ms (native pop) |
| Memory during call | +85 MB (JS heap + Hermes) | +12 MB (PJSIP RSS) |
| Battery 10-min call | 8–11% drain | 3–4% drain (no JS event loop running) |

---

## 9. Testing

### Unit
- iOS: XCTest on `ProviderDelegate`, `PJCall.swift` state machine (mock PJSIP); aim 80% coverage
- Android: JUnit + Robolectric on `ChatyyConnectionService`, `CallActivity` Compose snapshot tests
- C++ shared layer (if any): GoogleTest in `modules/chatyy-call-native/cpp/tests/`

### Integration — Mac 207 / Emulators
- iOS Simulator (Mac 207, `xcrun simctl`): launch app, trigger fake VoIP push via `xcrun simctl push`, assert CallKit UI appears within 100 ms
- Android emulator-5554 / 5556 (server `213.136.72.141`): use `adb shell am broadcast` to deliver mock FCM, assert `CallActivity` launches and PJSIP attempts INVITE
- Two-emulator real-call test: 5554 calls 5556, both PJSIP through dev SIP proxy

### E2E — Real devices
- TestFlight build → 2 iOS devices, 2 Android devices, matrix call test (4×4)
- Background, foreground, locked, DND, low-power, no-network all states logged

### Regression
- `CallStatusBar` displays "On call with X" when `getCurrentCall()` returns active
- chat-conversation re-render does NOT call `startCall` twice (debounce + native idempotency)
- App force-quit during call → CallKit/Telecom continue, JS reconnect doesn't re-invite

### Load
- 50 concurrent calls on PJSIP backend (Agent 5 server) — Chatyy native client side has 1 call max per device, but signaling load tested

---

## 10. Open Questions for Group

1. **Do we keep LiveKit at all server-side?** Group calls (>2) need SFU; PJSIP is 1:1. Proposal: native 1:1 via PJSIP, group calls fall back to LiveKit JS path even on mobile (rare flow).
2. **CallKit on iOS in China:** App Store China blocks CallKit. Need fallback path (full-screen notification like Android). Affects ~0% of Chatyy users today — defer.
3. **Background incoming on Android 14+ restricted-FGS:** `CallActivity` launch from FCM requires `USE_FULL_SCREEN_INTENT` permission (granted-by-default for category=call). Verified in [android_appstate_lag_fullscreen_intent](../../memory/android_appstate_lag_fullscreen_intent.md).

---

**Outcome:** Calls become native artifacts. JS owns chat surfaces and a 4-field status bar. Bridge crossings during a call: exactly 2 (`on_call_started`, `on_call_ended`). The bug class that caused tonight's incidents becomes structurally impossible.
