// CallStateSnapshot.swift
//
// [Wave Bridge-Surface, 2026-05-21 / Agent 9] Read-only call state DTO
// returned by ExpoCallKitModule.getCurrentCallSnapshot(). This is the ONLY
// data shape JS is allowed to see for the in-progress call — no Room handle,
// no SDP, no ICE candidates, no LiveKit Track refs. The native side owns the
// full state machine; JS gets a periodic (or event-triggered) photograph.
//
// Background — see docs/whatsapp-migration/08-native-call-no-bridge.md and
// docs/whatsapp-migration/IMPL-bridge-surface-policy.md. Tonight's bug class
// (envelope parsing across JS-native bridge, RN bridge dropping strings,
// duplicate Room from JS racing native pre-connect) becomes structurally
// impossible when JS cannot touch any raw signaling object. The native call
// state machine has exactly ONE shape it can serialize back, and that shape
// is this struct.
//
// Mirror: modules/expo-callkit/android/.../CallStateSnapshot.kt — keep
// fields and types in lockstep. Any field added here MUST be added there
// (and to services/call-state-reader.js so JS sees a consistent shape).

import Foundation

/// Codable struct describing the currently-active call (or empty/nil if no
/// call is in progress). Returned synchronously from a `Function` (NOT
/// `AsyncFunction`) — Expo Modules bridges this to a JS plain object in a
/// single bridge cross. Total payload is <300 bytes; sync read is ~30µs
/// which is well under one frame.
@objc public class CallStateSnapshot: NSObject, Codable {
  /// Server-side call id (e.g. `call_1716345678901_abcd1234`). Empty when no
  /// call is active. JS uses this as the primary key for analytics + UI.
  public let callId: String

  /// Peer email (`@chatyy.com.br` or external). Empty if not yet known
  /// (rare: only on the very first ring before SIP From-header parsed).
  public let contactEmail: String

  /// Display name resolved from address book or backend contact lookup.
  /// Falls back to local-part of `contactEmail` if no name available.
  public let contactName: String

  /// True if the call is a video call (CallKit handle had `.generic` +
  /// video flag, or backend `is_video=true`). Audio-only calls = false.
  public let isVideo: Bool

  /// Local mic state. Mirrors `AVAudioSession.setMicrophoneEnabled` —
  /// `true` = mic is open, `false` = muted. JS displays the mic-off icon
  /// when this is false. Native is the source of truth (CallKit can also
  /// toggle mute via the system UI; that flows through here too).
  public let mic: Bool

  /// True if audio is routed to speaker (vs. earpiece / headphones). On
  /// iOS this maps to `AVAudioSession.overrideOutputAudioPort(.speaker)`.
  /// `false` does NOT mean muted — it just means non-speaker route.
  public let speaker: Bool

  /// Seconds since the call was answered (CallKit `.reportOutgoingCall(connectedAt:)`
  /// or `CXAnswerCallAction.fulfill()`). `0` while ringing or connecting.
  /// JS renders this in the CallStatusBar as MM:SS. Native increments it;
  /// JS doesn't need a local timer (which is also why we don't need to send
  /// `callStartTime` — fewer chances for clock skew between JS Hermes time
  /// and native CFAbsoluteTime).
  public let durationSec: Int

  /// True when the underlying LiveKit Room (`NativeCallRoom`) is in the
  /// `.connected` state. False during ringing, connecting, or after the
  /// peer hangs up but before CallKit dismisses. JS uses this to decide
  /// whether to show "Conectando..." vs the duration timer in the status
  /// bar.
  public let lkConnected: Bool

  /// String enum: `"idle" | "ringing" | "connecting" | "active" | "held" |
  /// "ended"`. `"idle"` = no call. `"ringing"` = inbound, not yet
  /// answered. `"connecting"` = CallKit answered, signaling in flight.
  /// `"active"` = audio flowing. `"held"` = CallKit hold state. `"ended"`
  /// = call finished, snapshot will be `nil` on next read.
  public let ringState: String

  public init(callId: String,
              contactEmail: String,
              contactName: String,
              isVideo: Bool,
              mic: Bool,
              speaker: Bool,
              durationSec: Int,
              lkConnected: Bool,
              ringState: String) {
    self.callId = callId
    self.contactEmail = contactEmail
    self.contactName = contactName
    self.isVideo = isVideo
    self.mic = mic
    self.speaker = speaker
    self.durationSec = durationSec
    self.lkConnected = lkConnected
    self.ringState = ringState
    super.init()
  }

  /// Convert to `[String: Any]` for Expo Modules JS bridge serialization.
  /// The module's `Function("getCurrentCallSnapshot")` calls this since
  /// Expo Modules' direct Codable bridge support varies by SDK; the
  /// dictionary path is bulletproof across SDK 51–55.
  public func toDictionary() -> [String: Any] {
    return [
      "callId": callId,
      "contactEmail": contactEmail,
      "contactName": contactName,
      "isVideo": isVideo,
      "mic": mic,
      "speaker": speaker,
      "durationSec": durationSec,
      "lkConnected": lkConnected,
      "ringState": ringState,
    ]
  }
}
