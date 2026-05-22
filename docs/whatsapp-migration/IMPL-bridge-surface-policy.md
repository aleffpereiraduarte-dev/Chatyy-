# IMPL — ExpoCallKit Bridge-Surface Policy

> **Author:** Agent 9 (Bridge-Surface Refactor wave)
> **Date:** 2026-05-21
> **Scope:** Native call modules `modules/expo-callkit/{ios,android}` and the
> JS-side reader `services/call-state-reader.js`.
> **Companion design:** [`08-native-call-no-bridge.md`](./08-native-call-no-bridge.md)

---

## Why this policy exists

Tonight's P0s (envelope wrap eternal, `callee_email=""`, CallKit Error 7
MaxCallGroups, "Conectando..." eterno) all traced back to the JS↔native
bridge being too wide. JS reached into raw signaling — Room handles, SDP,
ICE — and every time the bridge marshalled a string wrong, dropped an event,
or GC'd a UUID, we got a P0.

WhatsApp / Signal / Telegram do not let JavaScript touch their call state
machines. We adopt the same posture.

---

## The Policy

### 1. Native owns the call state machine.

The full `{call_id ↔ UUID ↔ Connection ↔ Room ↔ AVAudioSession/AudioManager}`
graph lives in Swift / Kotlin. JS is a read-mostly observer. It MUST NOT
hold a reference to:

- A LiveKit `Room` handle or any of its tracks
- SDP offers/answers, ICE candidates, or any raw signaling frame body
- The CallKit `CXProvider` / `CXCallController`
- The Android `Telecom Connection` instance
- The PJSIP call handle (once Agent 5 wave lands)

### 2. JS has FOUR triggers and ONE read.

| Kind     | API                                | Returns         | Notes |
|----------|------------------------------------|-----------------|-------|
| Trigger  | `ExpoCallKit.startOutgoingCall({…})`   | void / promise<true>  | Fire-and-forget. Native answers via `onCallStarted` event. |
| Trigger  | `ExpoCallKit.endCall(callId, reason)`  | void                  | Native routes via CXEndCallAction / Connection.disconnect. |
| Trigger  | `ExpoCallKit.toggleMute()`             | void *(new in v2.4.x)* | Replaces `lkSetMicEnabled`. CallKit/Telecom-aware. |
| Trigger  | `ExpoCallKit.toggleSpeaker()`          | void                  | Replaces `setSpeakerEnabled` semantics for in-call only. |
| Read     | `ExpoCallKit.getCurrentCallSnapshot()` | `CallStateSnapshot \| null` | Sync. ~30µs. JS calls via the `useCurrentCall()` hook only. |

That is the full surface area. Events emitted by native (`onCallStarted`,
`onCallEnded`) carry **minimum** payload — `{callId}` plus at most a
`reason` for `onCallEnded`. Anything else JS thinks it needs MUST come
through the snapshot read.

### 3. Snapshot shape is frozen.

`CallStateSnapshot` lives in:
- `modules/expo-callkit/ios/CallStateSnapshot.swift`
- `modules/expo-callkit/android/src/main/java/expo/modules/callkit/CallStateSnapshot.kt`
- JS shape documented in `services/call-state-reader.js`

Fields:

```
callId        String
contactEmail  String
contactName   String
isVideo       Bool
mic           Bool      // true = unmuted
speaker       Bool      // true = speaker route
durationSec   Int       // 0 while ringing/connecting
lkConnected   Bool
ringState     String    // idle | ringing | connecting | active | held | ended
```

**Adding a field requires:**
1. PR description justifies why the data can't stay inside native logic.
2. Field added to all three locations (Swift, Kotlin, JS docstring).
3. Native writes wired from the same code path that owns the state.
4. PR reviewer signs the bridge-surface-policy line in the checklist.

### 4. New ExpoModule call APIs must justify themselves.

Default = read-only. If you propose adding a new `Function` or
`AsyncFunction` to `ExpoCallKitModule`, the PR description must answer:

- **Why can't this be a snapshot field?** (Read-only path is preferred.)
- **Is this a fire-and-forget trigger?** (Then it returns void and JS waits
  on the next snapshot poll for the side effect — no return-value
  contract with JS.)
- **Does it expose any raw signaling object?** (If yes, the PR must
  also delete a deprecated API of equivalent size — net new exposed
  surface is forbidden.)

### 5. Deprecation lifecycle.

Existing APIs that violate this policy are marked
`// DEPRECATED — to be removed in v2.5.0` inline in the Swift/Kotlin source.
They are NOT deleted in the current wave because OTA-shipped JS bundles
still call them; removing them would crash old installs.

**v2.4.x (current)** — snapshot API ships, deprecated paths kept.
**v2.5.0** — deprecated paths removed. JS bundle ship-blocked on a static
grep check that the deprecated symbols are absent.

Deprecated list (snapshot @ 2026-05-21):

- `lkConnect`, `lkDisconnect`, `lkSetMicEnabled`, `lkSetCameraEnabled`
- `adoptNativeRoom`, `isNativeRoomConnected`
- `fireCallInviteNative`, `fireCallAnsweredNative`, `fireCallEndNative`

Also under audit but not yet marked: `persistPendingLkToken` (debatable —
native legitimately needs the token; the persistence happening from JS is
a bootstrap concession until the OAuth-style native fetch lands).

### 6. JS may import `ExpoCallKit` only from:

- `services/callkeep.js` — owns the trigger API (`startCall`, `endCall`,
  setup, push token handoff).
- `services/voipNative.js` — owns the outgoing-call orchestration.
- `services/call-state-reader.js` — the **only** read path. Everything
  rendering call info imports `useCurrentCall()` from here.

Any other JS file importing `'../modules/expo-callkit'` is a policy
violation and must be refactored to go through one of these three.

Static enforcement (future): `eslint-plugin-no-restricted-imports` rule
in `.eslintrc.json` flagging `modules/expo-callkit` imports outside the
three sanctioned files.

---

## Open items

- `toggleMute()` / `toggleCamera()` fire-and-forget Functions: land in
  v2.4.x. Until then JS uses the legacy `lkSetMicEnabled` /
  `lkSetCameraEnabled` paths (deprecation comments in place).
- Group call snapshot: 1:1 only today. Group calls keep using
  `adoptNativeRoom` (which leaks participant list) until a dedicated
  `GroupCallStateSnapshot` ships. Tracked separately.
- Web parity: `getCurrentCallSnapshot()` returns null on web (no native
  module). `useCurrentCall()` hook falls back to `CallContext` for web —
  see `CallStatusBar.js`.

---

## Checklist for PR reviewers

When reviewing a PR that touches `modules/expo-callkit/**` or
`services/call-state-reader.js` or any call-state JS, confirm:

- [ ] No new `Function`/`AsyncFunction` exposes a raw native handle.
- [ ] Any new snapshot field is mirrored across iOS + Android + JS doc.
- [ ] Deprecated APIs are not re-introduced in JS (`fireCall*Native`,
      `lkConnect`, `lkDisconnect`, `adoptNativeRoom`, `lkSet*Enabled`,
      `isNativeRoomConnected`).
- [ ] If a new JS file imports `'../modules/expo-callkit'` directly, the
      PR justifies the deviation from the three-file allowlist above.
- [ ] Events still carry minimal payloads (`{callId}` + optional `reason`).
- [ ] No new JS-side timers / poll loops outside `useCurrentCall()`.
