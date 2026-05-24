import ExpoModulesCore
import CallKit
import PushKit
import AVFoundation
import Network
import UIKit
import Intents

// [bug 2026-05-15 cold-start-voip-drop] PKPushRegistry is OWNED by
// AppDelegate (created in didFinishLaunchingWithOptions). This module
// consumes pending calls handed off via App Group UserDefaults + a
// NotificationCenter event so the JS Modal/navigation can resume the call
// once the RN bundle is up. See ios/OneMundoMail/AppDelegate.swift.
//
// Key changes vs. the prior implementation:
//   1. NO PKPushRegistry creation here (moved to AppDelegate).
//   2. NO AVAudioSession pre-arm at module load (Spotify focus theft fix).
//   3. reportNewIncomingCall is the FIRST thing on the push handler path
//      (when AppDelegate forwards a synthesized push), so the same-run-loop
//      Apple deadline is never violated.
//   4. CallKit is always reported — we don't auto-end CallKit when app is
//      foreground anymore; CallKit is the source of truth and the JS Modal
//      simply layers above it. Removing the auto-end fixes the "1st call
//      drop" issue on cold start.
//   5. We forward `provider:didActivate` to JS via `onCallKitAudioActivated`
//      so /call (LiveKit) can wait for CallKit to own the audio session
//      before calling `Room.connect` (avoids competing audio-session paths).
//   6. CXEndCallAction does NOT manually deactivate the audio session;
//      CallKit calls didDeactivate automatically.

private let kAppGroupId = "group.com.onemundo.mail"
private let kPendingCallKey = "pendingVoipCall"

public class ExpoCallKitModule: Module {
  private var provider: CXProvider?
  private var callController: CXCallController?
  private var providerDelegate: ProviderDelegate?

  /// Network reachability monitor — emits onNetworkChange events to JS so
  /// the call screen can show "Reconnecting..." when Wi-Fi drops, etc.
  /// WhatsApp uses NWPathMonitor under the hood for the same UX.
  private var pathMonitor: NWPathMonitor?
  private var lastNetworkStatus: String = ""
  private var audioInterruptionObserver: Any?
  private var voipTokenObserver: Any?
  private var pendingCallObserver: Any?
  // [native call screen, 2026-05-16] Observer for CallViewController's
  // hangup notification — bridges the native UI's red-button tap back into
  // the JS `onCallEnded` event so /call state stays consistent.
  private var nativeCallEndedObserver: Any?
  // [foreground gate, 2026-05-21] Observer for CallSignalWs's WS-driven
  // `call_invite` while the app is foreground. CallSignalWs skips CallKit
  // in that case (JS owns the UI via the in-app IncomingCallSheet); we
  // forward the payload to JS as `onIncomingCall` so any module-side
  // listener still sees the call.
  private var incomingCallForegroundObserver: Any?

  // [2026-05-22 #1349 fix] Observers for the caller-side WS receiver loop
  // notifications posted by CallSignalWs (CallKitCallAnsweredRemote /
  // CallKitCallDeclinedRemote / CallKitCallCancelledRemote). Forwarded to JS
  // as `onCallAnsweredRemote` / `onCallDeclinedRemote` / `onCallCancelledRemote`
  // so the JS-side /call screen stops ringback + dismisses outgoing UI
  // without waiting for the 45s outgoing timeout. Stored as a small array
  // so deinit removes all three with one loop.
  private var remoteSignalObservers: [Any] = []

  // __chatyy_native_call_sync 2026-05-19 — call-state observers (mute, cam,
  // speaker, route, hold, PiP, camera flip). CallViewController posts the
  // matching ExpoCallKitLk* notifications; we forward them to JS as typed
  // events. Stored as [Any] so removeObserver(_:) cleans them up in deinit.
  private var callStateObservers: [Any] = []
  // [share outbox feedback, 2026-05-19] Observer for the AppDelegate-rebroadcast
  // ShareDidSend NSNotification (originally a Darwin notification posted by
  // the ShareExtension). Bridges to JS via the `onShareDidSend` event so JS
  // can drain the App Group `chatyy.share_outbox` queue and refresh chat list.
  private var shareDidSendObserver: Any?

  // Serial queue for thread-safe access to activeCalls, callPayloads, pendingEvents
  private let stateQueue = DispatchQueue(label: "com.onemundo.callkit.state")
  // [2026-05-22 reentrancy-safe sync] DispatchSpecificKey set on stateQueue so
  // we can detect when we're ALREADY running on it and avoid `dispatch_sync`
  // deadlock (libdispatch traps EXC_BREAKPOINT if you sync into the queue you
  // currently own — happens when a source/timer callback nests another sync,
  // see crash thread 22 trace from 2026-05-22). Used by `safeStateSync`.
  private let stateQueueKey = DispatchSpecificKey<Void>()
  // Set to true once `stateQueue.setSpecific(...)` has run (idempotent guard).
  private var stateQueueKeyInstalled = false

  /// Reentrancy-safe wrapper around `stateQueue.sync`. If we're already on
  /// stateQueue (detected via DispatchSpecific), runs the block inline so we
  /// don't deadlock. Otherwise dispatches synchronously like the bare call.
  @inline(__always)
  private func safeStateSync<T>(_ block: () -> T) -> T {
    if DispatchQueue.getSpecific(key: stateQueueKey) != nil {
      return block()
    }
    return stateQueue.sync(execute: block)
  }

  /// Install the DispatchSpecific marker on stateQueue. Safe to call multiple
  /// times — guarded by `stateQueueKeyInstalled`. Called from OnCreate (and
  /// defensively from any early path that might race ahead of OnCreate).
  private func installStateQueueKey() {
    if stateQueueKeyInstalled { return }
    stateQueueKeyInstalled = true
    stateQueue.setSpecific(key: stateQueueKey, value: ())
  }

  /// Look up the original server-side callId for a CallKit UUID. Used by
  /// the delegate to keep CXAction events keyed by call_id (what JS sees)
  /// instead of the opaque UUID.
  internal func callIdForUUID(_ uuid: UUID) -> String? {
    return safeStateSync {
      for (cid, u) in activeCalls where u == uuid { return cid }
      return nil
    }
  }

  /// [#1184 dismiss fix, 2026-05-19] Shared snapshot of `callId → UUID` so
  /// non-module static contexts (CallSignalWs.handleIncomingCallEndLocked,
  /// CallViewController.room(_:didDisconnectWithError:)) can fall back to
  /// the live module's `activeCalls` when their own UUID stash is empty.
  /// Previously `inviteUUIDsByCallId` in CallSignalWs only tracked
  /// WS-surfaced invites — for PushKit pushes (typical incoming path) and
  /// outgoing answered calls, that map was empty, so the remote-end frame
  /// failed to fire `provider.reportCall(with:endedAt:reason:.remoteEnded)`
  /// and the CallKit system pill / lock-screen UI stayed visible after the
  /// peer hung up.
  ///
  /// Updated atomically alongside `activeCalls` so a remote `call_end` that
  /// races with the answer transaction still finds the UUID. Uses an
  /// NSLock because Swift `static var` on a generic class can't share the
  /// module's `stateQueue` (the module instance isn't yet alive at static
  /// access time).
  private static var sharedUUIDLock = NSLock()
  private static var sharedUUIDByCallId: [String: UUID] = [:]

  // [WAVE 159 2026-05-22] Expose the module's CXProvider so CallViewController
  // (which is created by the module and lives in a different file) can call
  // reportCall(with:endedAt:reason:) on the SAME provider that owns the call.
  //
  // Apple constraint: reportCall is a no-op if called on a different provider
  // than the one that registered the call. We had 3 providers (module main +
  // earlyProvider + ephemeral fallback), so the user-hangup branch was firing
  // reportCall on the WRONG one and CallKit's pill stayed on screen.
  //
  // Now CallViewController.handleHangup falls back to this shared reference
  // when earlyProvider is nil OR when the call was created via the module's
  // own provider (the common case for outgoing calls).
  static weak var sharedProvider: CXProvider?

  static func sharedCallKitUUID(forCallId callId: String) -> UUID? {
    sharedUUIDLock.lock()
    defer { sharedUUIDLock.unlock() }
    return sharedUUIDByCallId[callId]
  }
  private static func _shared_setUUID(_ uuid: UUID?, forCallId callId: String) {
    sharedUUIDLock.lock()
    defer { sharedUUIDLock.unlock() }
    if let uuid = uuid {
      sharedUUIDByCallId[callId] = uuid
    } else {
      sharedUUIDByCallId.removeValue(forKey: callId)
    }
  }

  /// [#1171 redux dismiss, 2026-05-19] Public bridge so CallViewController can
  /// invoke ProviderDelegate.dismissActiveCallSurfaces as a last-resort
  /// fallback when its own `self.dismiss(animated:)` is swallowed (no
  /// presenter / mid-transition / sibling modal). ProviderDelegate is private
  /// to this file so we forward through a static on the module.
  static func dismissActiveCallSurfacesFromVC(reason: String) {
    ProviderDelegate.dismissActiveCallSurfaces(reason: reason)
  }

  /// [STAGE-A 2026-05-20] GAP #3 — Atomically-updated flag set in
  /// `setupProvider()` after `providerDelegate` is wired up. The cold-start
  /// stub in VoipPushAppDelegateSubscriber reads this to decide whether the
  /// module owns CXAnswer / presentation — if true, the stub's CXAnswer
  /// handler immediately fulfills and bails (no dual-present race).
  private static var _providerDelegateBound: Bool = false
  private static let _providerDelegateBoundLock = NSLock()
  static func hasBoundProviderDelegate() -> Bool {
    _providerDelegateBoundLock.lock()
    defer { _providerDelegateBoundLock.unlock() }
    return _providerDelegateBound
  }
  fileprivate static func _setProviderDelegateBound(_ v: Bool) {
    _providerDelegateBoundLock.lock()
    _providerDelegateBound = v
    _providerDelegateBoundLock.unlock()
  }

  /// [#1171 redux dismiss, 2026-05-19] Race guard for the post-hangup
  /// present window. `presentNativeCallVC` / `presentOutgoingCallVC` both
  /// fire from a `Task.detached` that awaits the LK token fetch (200-500ms
  /// typical, up to 8s on slow networks). If the user (or peer) hangs up
  /// DURING that window, the call UUID is removed from `activeCalls` /
  /// `sharedUUIDByCallId` but the Task continues and eventually presents a
  /// CallViewController for a dead call — the VC then sits at "Conectando…"
  /// forever (no peer to join, the user's tapHangup can't dismiss reliably
  /// because the shared UUID map no longer has an entry, so CXEndCallAction
  /// doesn't fire and the only path is the explicit `self.dismiss` which
  /// has its own failure modes). This was the silent root cause of the
  /// "after hangup screen stays on Conectando…" regression that kept
  /// resurfacing (task #1171). The guard: BEFORE presenting, verify the
  /// callId is still tracked.
  static func isCallStillActive(callId: String) -> Bool {
    return sharedCallKitUUID(forCallId: callId) != nil
  }

  // Track active calls — access only via stateQueue.
  // [#1184 dismiss fix, 2026-05-19] All writes to `activeCalls` must be
  // mirrored to `sharedUUIDByCallId` via `_shared_setUUID` so the static
  // accessor stays in sync. The mirror is intentionally redundant — the
  // module-internal lookup goes through the queue for ordering, the static
  // mirror is the cross-class fallback.
  private var activeCalls: [String: UUID] = [:]
  // Store VoIP push payloads so we can pass full data in onCallAnswered
  private var callPayloads: [String: [AnyHashable: Any]] = [:]
  // [Stage #996 outgoing native flow, 2026-05-17] Outgoing-call params keyed
  // by UUID, consumed by ProviderDelegate.provider(_:perform:CXStartCallAction)
  // once CallKit hands us the action. We can't pass these through the action
  // itself (CXStartCallAction only carries the UUID + handle), so we stash
  // them in this module-owned dictionary and pop on transaction execution.
  internal struct OutgoingCallParams {
    let callId: String
    let calleeEmail: String
    let calleeName: String
    /// [#1176 polish, 2026-05-18] Avatar URL forwarded from JS so the SwiftUI
    /// CallView can paint the real photo (AsyncImage) instead of just an
    /// initial letter while LiveKit Room is still connecting.
    let calleeAvatar: String?
    let callerName: String
    let isVideo: Bool
    let roomName: String
    let conversationId: String
    let lkUrl: String?
    let lkToken: String?
    /// [#1208 2026-05-19] When the app is foreground at the moment JS calls
    /// `startOutgoingCall`, we still want to register the CXStartCallAction
    /// (so iOS shows the call in Recents, surfaces the lock-screen pill,
    /// owns the audio session properly) BUT we DON'T want to present
    /// CallViewController — the rich JS /call.js UI is already on screen
    /// and has features (invite friend, audio→video upgrade, screenshare,
    /// group grid, emoji reactions) the SwiftUI screen doesn't. The CX
    /// delegate handler reads this flag and skips
    /// `presentOutgoingCallVC` when true. JS adopts the LiveKit Room via
    /// `adoptNativeRoom` if/when one was pre-connected, otherwise creates
    /// its own Room via @livekit/react-native.
    let suppressVCPresent: Bool
  }
  private var pendingOutgoingCalls: [UUID: OutgoingCallParams] = [:]

  // [2026-05-22 outgoing ring timeout] If the callee never answers within
  // 45s, auto-cancel the outgoing call so CallKit doesn't stay on
  // "Connecting..." forever (root cause: 3-day C++ WS envelope bug dropped
  // every call_invite → callee never rang → caller stuck). Even after the
  // envelope fix, network drops / app-killed callees / VoIP push misses
  // need this safety net.
  //
  // Lifecycle:
  //   - scheduled in startOutgoingCall after the transaction is queued.
  //   - cancelled in callAnswered (success) or callEnded (manual hangup or
  //     remote reject).
  //   - fires → endCallActionWithReason(callId, "unanswered") which submits
  //     CXEndCallAction so CallKit dismisses, JS gets onCallEnded with
  //     reason:"unanswered", caller sees "Não atendeu" toast.
  private var outgoingCallTimers: [String: DispatchSourceTimer] = [:]

  internal func consumeOutgoingCallParams(uuid: UUID) -> OutgoingCallParams? {
    return safeStateSync {
      let params = pendingOutgoingCalls[uuid]
      pendingOutgoingCalls.removeValue(forKey: uuid)
      return params
    }
  }

  // Buffer events when JS is not ready (cold start)
  private var pendingEvents: [(String, [String: Any])] = []
  private var jsListenersReady = false

  // [Wave Bridge-Surface, 2026-05-21 / Agent 9] Snapshot-backing storage.
  //
  // The whole point of CallStateSnapshot is that JS cannot reach into
  // the raw call state machine. To support that we have to keep the
  // minimum needed information here, and update it from the same code
  // paths that drive the actual state (CallKit callbacks, NativeCallRoom
  // notifications, etc.). All writes go through stateQueue.
  //
  // Invariant: at most one entry — calls are 1:1 by design on this client.
  // (Group calls own their own path via GroupCallViewController and don't
  // surface in this snapshot.)
  //
  // TODO(Agent 9 follow-up wave): wire updateCurrentCallContext from
  //   - reportIncomingCall                        → begin "ringing"
  //   - provider(_:perform:CXAnswerCallAction)    → "connecting"
  //   - NativeCallRoom .connected listener        → "active" + startedAt
  //   - provider(_:perform:CXSetHeldCallAction)   → "held" / "active"
  //   - provider(_:perform:CXSetMutedCallAction)  → mic flip
  //   - AudioRouter speaker route observer        → speaker flip
  //   - cleanup paths (callEnded/timeout/orphan)  → set nil
  // Until that lands, getCurrentCallSnapshot() will return nil even during
  // an active call — JS gracefully falls back to CallContext via
  // CallStatusBar's hybrid path.
  internal struct CurrentCallContext {
    var callId: String
    var contactEmail: String
    var contactName: String
    var isVideo: Bool
    var mic: Bool          // true == unmuted
    var speaker: Bool
    var startedAt: TimeInterval?   // CFAbsoluteTimeGetCurrent at answer/connect
    var ringState: String  // "ringing" | "connecting" | "active" | "held"
  }
  private var currentCallContext: CurrentCallContext?

  /// Update the snapshot when the call advances. Called from CallKit
  /// delegate callbacks and NativeCallRoom listener. Never called from JS.
  internal func updateCurrentCallContext(_ mutate: (inout CurrentCallContext?) -> Void) {
    safeStateSync {
      mutate(&currentCallContext)
    }
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoCallKit")

    Events(
      "onCallAnswered",
      "onCallEnded",
      "onVoipTokenReceived",
      "onIncomingCall",
      "onAudioInterruption",
      "onNetworkChange",
      // [bug 2026-05-15 #9] Bridged to JS so /call can wait for CallKit to
      // own the AVAudioSession before calling Room.connect on LiveKit.
      "onCallKitAudioActivated",
      "onCallKitAudioDeactivated",
      // [stage 2 native LiveKit pre-connect, 2026-05-15] Mirrored from
      // NativeCallRoom so JS can adopt the already-connected Room instead of
      // creating a duplicate. Order roughly mirrors livekit-client's events
      // so /call can swap its emitter shim.
      "onLkConnected",
      "onLkDisconnected",
      "onLkParticipantConnected",
      "onLkParticipantDisconnected",
      "onLkTrackSubscribed",
      "onLkTrackUnsubscribed",
      "onLkConnectionQuality",
      // __chatyy_native_call_sync 2026-05-19 — native call-state changes
      // mirrored to JS so analytics, recording banner, peek UI, and post-call
      // rating see the same mute/cam/speaker/route/hold/PiP state the native
      // UI is rendering. Without these the JS overlay drifts out of sync
      // (mute toggle from native CallKit UI never updates analytics, speaker
      // route had 2 writers with no cross-talk, camera flip not mirrored,
      // timer started at different points → wrong end-card duration).
      "onLkLocalAudioChanged",
      "onLkLocalVideoChanged",
      "onLkSpeakerChanged",
      "onLkCameraFlipped",
      "onAudioRouteChanged",
      "onCallHoldChanged",
      "onPipChanged",
      // [share outbox feedback, 2026-05-19] Emitted when the native
      // ShareExtension finishes sending shares; JS drains the App Group
      // queue via getShareOutbox() and refreshes the chat list for any
      // affected conversations so users see their share messages without
      // pull-to-refresh.
      "onShareDidSend",
      // [Wave C-1, 2026-05-21] Emitted when the user taps the in-call chat
      // button on the native SwiftUI CallView. Payload: { callId, conversationId }.
      // JS subscriber in callkeep.js calls router.push('/chat-conversation').
      "onOpenChat",
      // [2026-05-22 #1349 fix] Caller-side remote-signaling events bridged
      // from the CallSignalWs receiver loop. Caller-only — the callee path
      // already has `onCallAnswered` (CXAnswerCallAction) and `onIncomingCall`.
      // Without these, ringback drones until the 45s outgoing timeout fires
      // even after the peer accepted/declined, because the JS-side mailWs
      // subscription was the only place these frames were observed.
      "onCallAnsweredRemote",
      "onCallDeclinedRemote",
      "onCallCancelledRemote"
    )

    // Auto-initialize on module load (skip CallKit in China per Apple requirement)
    OnCreate {
      // [2026-05-22 reentrancy-safe sync] Install the DispatchSpecific marker
      // FIRST, before any other setup that might dispatch onto stateQueue.
      self.installStateQueueKey()
      var region = ""
      if #available(iOS 16.0, *) {
        region = Locale.current.region?.identifier ?? ""
      } else {
        region = Locale.current.regionCode ?? ""
      }
      let isChina = region == "CN" || region == "CHN"
      if isChina {
        print("[ExpoCallKit] China detected — CallKit disabled per Apple/MIIT requirement")
        return
      }
      DispatchQueue.main.async {
        self.setupProvider()
        self.setupNetworkMonitor()
        self.installAppDelegateBridges()
        self.installNativeCallEndedObserver()
        self.installRemoteSignalObservers()
        self.installShareDidSendObserver()
        self.flushVoipTokenFromAppGroup()
        self.adoptPendingCallsFromAppGroup()
        // [WAVE 163 2026-05-23 GHOST FIX] Register willTerminate observer so
        // swipe-kill while a call is "Connecting…" doesn't leave a CallKit
        // ghost on the lock screen. CXProvider state lives in callservicesd
        // (separate process) — reportCall MUST happen before SIGKILL.
        // iOS gives ~5s in willTerminate which is enough for sync reportCall.
        NotificationCenter.default.addObserver(
          self,
          selector: #selector(self.handleAppWillTerminate),
          name: UIApplication.willTerminateNotification,
          object: nil
        )
        // [bug 2026-05-15 #4] Removed AVAudioSession pre-arm.
        // Pre-arming with .playAndRecord/.voiceChat at module load stole
        // audio focus from Spotify/Music every app launch (user complaint:
        // "abro o app e minha música pausa"). The real uplink-mic-silent
        // fix is the RTCAudioSession forwarding inside provider:didActivate
        // (see ProviderDelegate below) — that runs after CallKit owns the
        // session so the WebRTC audio unit sees the active mic input.
        print("[ExpoCallKit] Auto-initialized on module create (no audio pre-arm)")
      }
    }

    OnStartObserving {
      print("[ExpoCallKit] JS listeners registered — flushing pending events")
      self.safeStateSync {
        self.jsListenersReady = true
      }
      self.flushPendingEvents()
      // Re-adopt pending calls every time JS attaches: covers the case
      // where the AppDelegate posted the NotificationCenter event before
      // OnCreate ran, and the only fallback is the UserDefaults queue.
      self.adoptPendingCallsFromAppGroup()
    }

    AsyncFunction("setup") { () -> Void in
      // Setup already happens in OnCreate, but this ensures it's done
      if self.provider == nil {
        if Thread.isMainThread {
          self.setupProvider()
        } else {
          DispatchQueue.main.sync {
            self.setupProvider()
          }
        }
      }
      // [2026-05-17] Touch the processor singletons so they're allocated
      // (and their dlsym / pod-load probe runs) ahead of the first Room.
      // The wiring into LiveKit's audio/video custom-processing pipeline is
      // done on the Room itself in CallViewController.bringUpRoom — these
      // singletons just need to exist before that fires.
      _ = RNNoiseAudioProcessor.shared
      _ = BackgroundProcessor.shared
    }

    // JS calls this on mount to get any events that fired before JS was ready
    Function("consumePendingEvents") { () -> [[String: Any]] in
      return self.safeStateSync {
        let events = self.pendingEvents.map { (name, data) -> [String: Any] in
          var result = data
          result["_eventName"] = name
          return result
        }
        self.pendingEvents.removeAll()
        self.jsListenersReady = true
        print("[ExpoCallKit] consumePendingEvents: returning \(events.count) events")
        return events
      }
    }

    AsyncFunction("displayIncomingCall") { (callId: String, callerName: String, hasVideo: Bool, callerEmail: String?, conversationId: String?) -> Void in
      try await self.reportIncomingCall(callId: callId, callerName: callerName, hasVideo: hasVideo)
    }

    // [Wave WhatsApp parity, 2026-05-20 gap H5] Optional `reason` arg lets JS
    // tell CallKit *why* the call ended so Recents.app + the system banner
    // pick the right wording ("Cancelada", "Atendida em outro dispositivo",
    // "Sem resposta"). Old call sites still work — reason defaults to nil
    // which routes through the legacy CXEndCallAction path with .failed.
    // Mapping (string → CXCallEndedReason) lives in `mapEndedReason`.
    Function("endCall") { (callId: String, reason: String?) -> Void in
      if let r = reason, !r.isEmpty {
        self.endCallActionWithReason(callId: callId, reasonRaw: r)
      } else {
        self.endCallAction(callId: callId)
      }
    }

    // iOS parity for the Android cold-start warm path. CallKit already
    // handles the UI handoff natively (CXProvider drives the in-call screen),
    // so this is a no-op here. Defined to avoid a JS-side optional-chain
    // crash on the cross-platform call screen.
    Function("notifyAppReady") { () -> Void in
      // intentionally empty — CallKit handles iOS handoff
    }

    Function("registerVoipPush") { () -> Void in
      // PKPushRegistry is owned by AppDelegate (created in
      // didFinishLaunchingWithOptions). This function exists only for JS
      // API parity; it surfaces any cached token from the App Group.
      self.flushVoipTokenFromAppGroup()
    }

    Function("getVoipToken") { () -> String? in
      if let ud = UserDefaults(suiteName: kAppGroupId),
         let token = ud.string(forKey: "voipToken") {
        return token
      }
      return nil
    }

    // [bug 2026-05-15 #981] JS-side speaker toggle for video calls.
    // Native default is earpiece (audio-call WhatsApp pattern); /call calls
    // this with true on mount when the call is video, or on the user's
    // explicit "speaker" button press.
    Function("setSpeakerEnabled") { (enabled: Bool) -> Void in
      let session = AVAudioSession.sharedInstance()
      do {
        try session.overrideOutputAudioPort(enabled ? .speaker : .none)
      } catch {
        print("[ExpoCallKit] setSpeakerEnabled(\(enabled)) failed: \(error)")
      }
    }

    // ---------------------------------------------------------------------
    // [stage 2 native LiveKit pre-connect, 2026-05-15] JS-facing bridge.
    //
    // The CallKit answer path may have already started a LiveKit Room before
    // JS mounted. /call calls `adoptNativeRoom()` first; if it returns a
    // connected snapshot it skips its own Room.connect and just renders the
    // participants from the snapshot, then listens to onLk* events for
    // live updates.
    // ---------------------------------------------------------------------

    // DEPRECATED — to be removed in v2.5.0
    // [Wave Bridge-Surface, 2026-05-21 / Agent 9] This exposes the LiveKit
    // Room handle to JS via the lkUrl/lkToken side channel, which is exactly
    // the bridge-heavy path we are eliminating. JS must NOT call this on
    // mobile from v2.5.0 onwards. Native owns Room.connect via
    // CallViewController + NativeCallRoom; JS observes via the
    // getCurrentCallSnapshot read path. Kept here only to avoid breaking
    // OTA-shipped JS bundles still running on installed app builds.
    // Replacement: do nothing in JS; native handles connect after CallKit
    // CXAnswerCallAction / CXStartCallAction.
    // [#992 Stage 1+2 alignment] Positional args matching Android Kotlin
    // signature: lkConnect(url, token, callId, hasVideo). JS uses positional
    // — Expo Module binds them to ordered params. identity is derived from
    // App Group `user_email` (or callId fallback) since iOS only needs an
    // identifier; the callId doubles as roomName.
    AsyncFunction("lkConnect") { (url: String, token: String, callId: String, hasVideo: Bool) -> Void in
      let identity: String = {
        if let ud = UserDefaults(suiteName: kAppGroupId),
           let e = ud.string(forKey: "user_email"), !e.isEmpty { return e }
        return "ios-\(callId)"
      }()
      NativeCallRoom.shared.connect(
        url: url,
        token: token,
        identity: identity,
        roomName: callId
      )
    }

    // DEPRECATED — to be removed in v2.5.0
    // JS-driven disconnect bypasses CallKit's CXEndCallAction. Use
    // ExpoCallKit.endCall(callId, reason) instead which fires the proper
    // CallKit transaction; CallKit then notifies native, native tears down
    // the Room. Removing this stops one class of "Room disconnected but
    // CallKit pill still visible" bugs.
    AsyncFunction("lkDisconnect") { () -> Void in
      NativeCallRoom.shared.disconnect()
    }

    // DEPRECATED — to be removed in v2.5.0
    // Mic state is now driven natively (CXSetMutedCallAction + AVAudioSession).
    // JS reads it via getCurrentCallSnapshot().mic and toggles via the
    // forthcoming toggleMute() fire-and-forget Function. This direct setter
    // skipped CXSetMutedCallAction so the system Recents + lock-screen UI
    // never saw the mute toggle — visible bug class going away.
    AsyncFunction("lkSetMicEnabled") { (enabled: Bool) -> Void in
      NativeCallRoom.shared.setMicEnabled(enabled)
    }

    // DEPRECATED — to be removed in v2.5.0
    // Camera state is native-owned (CallViewController.swift). JS should
    // not poke the LK track directly. Replacement: new toggleCamera()
    // fire-and-forget Function lands in v2.4.x; for now JS code targeting
    // mobile should skip calling this and let native handle camera.
    AsyncFunction("lkSetCameraEnabled") { (enabled: Bool) -> Void in
      NativeCallRoom.shared.setCameraEnabled(enabled)
    }

    // [#1205 live muting fix, 2026-05-19] Pre-broadcast AVAudioSession reset.
    // Symptom: live broadcast "ficando muda" — host's mic captures the first
    // few seconds then progressively silences. Root cause is a leaked
    // `.voiceChat` mode left by a prior CallViewController / GroupCall that
    // didn't run AudioRouter.teardown (CXEndCall race, app force-quit, etc).
    // With the session still pinned to `.playAndRecord + .voiceChat`, the
    // OS expects bi-directional audio (caller-style). Live broadcast is
    // one-way send, so AVAudioEngine's voice processing chain (built-in AEC
    // + duck) over-suppresses the local mic to near-silence within ~5s.
    //
    // We re-configure to `.playAndRecord + .videoRecording` (or `.default`)
    // which mirrors what Instagram/TikTok live use — no voice processing,
    // full mic gain, A2DP allowed for the host's headphones. We do NOT
    // setActive(true) here — getUserMedia on the JS side will activate it.
    Function("prepareAudioForLive") { () -> Bool in
      let session = AVAudioSession.sharedInstance()
      do {
        try session.setCategory(
          .playAndRecord,
          mode: .videoRecording,
          options: [.allowBluetoothA2DP, .defaultToSpeaker, .mixWithOthers]
        )
        NSLog("[ExpoCallKit] prepareAudioForLive: AVAudioSession reset to .playAndRecord/.videoRecording")
        return true
      } catch {
        NSLog("[ExpoCallKit] prepareAudioForLive failed: \(error)")
        return false
      }
    }

    // [host-mute, 2026-05-17] Host-issued mute of a remote participant.
    //
    // Architecture note (post #1207, 2026-05-19): NativeCallRoom is now REAL
    // — CallViewController publishes its Room to the singleton, JS adopts via
    // `adoptNativeRoom()`. We *could* implement host-mute directly here via
    // `NativeCallRoom.shared.disconnect()` + a per-participant mute API, but
    // LK Swift SDK doesn't expose SFU-side mute through RemoteParticipant
    // yet, so the WS round-trip below stays canonical.
    // For host mute we don't have a direct LK SFU-side mute action exposed
    // through the JS SDK either, so the agreed protocol is:
    //   1. Host calls this bridge -> POST /api/email.php?action=chat_call_mute_participant
    //   2. Backend validates host role + relays a WS `call_mute_request` event
    //      to the target participant.
    //   3. Target client picks up the event and locally calls
    //      `room.localParticipant.setMicrophoneEnabled(false)`.
    //
    // This native bridge function is a thin no-op pass-through so the JS
    // /call.js can call it via `await ExpoCallKit.muteParticipant(...)` and
    // keep call sites symmetric across platforms. The actual HTTP roundtrip
    // happens in JS (services/api.js -> chatCallMuteParticipant). Future:
    // when NativeCallRoom v2 lands, do the SFU mute directly here.
    AsyncFunction("muteParticipant") { (roomName: String, identity: String) -> Bool in
      NSLog("[ExpoCallKit] muteParticipant room=\(roomName) identity=\(identity) — JS owns the HTTP path, this is a no-op shim")
      return true
    }

    // ─── RNNoise (2026-05-17) ────────────────────────────────────────────
    //
    // Per-user ML noise suppression toggle. Default ON. The actual frame
    // processing happens inside RNNoiseAudioProcessor (loaded via dlsym so
    // the app links even when the Swift Package isn't added yet — see the
    // MANUAL STEPS at the bottom of RNNoiseAudioProcessor.swift).
    Function("setNoiseSuppression") { (enabled: Bool) -> Bool in
      RNNoiseAudioProcessor.shared.enabled = enabled
      NSLog("[ExpoCallKit] setNoiseSuppression: \(enabled) (available=\(RNNoiseAudioProcessor.shared.available))")
      return true
    }

    Function("getNoiseSuppression") { () -> Bool in
      return RNNoiseAudioProcessor.shared.enabled
    }

    Function("isNoiseSuppressionAvailable") { () -> Bool in
      return RNNoiseAudioProcessor.shared.available
    }

    // ─── MediaPipe Background blur / virtual background (2026-05-17) ────
    Function("setBackgroundMode") { (mode: String, imageAsset: String?) -> Bool in
      let proc = BackgroundProcessor.shared
      switch mode.lowercased() {
      case "off", "none": proc.mode = .off
      case "blur_low", "blur-low": proc.mode = .blurLow
      case "blur_medium", "blur-medium", "blur": proc.mode = .blurMedium
      case "blur_high", "blur-high": proc.mode = .blurHigh
      case "image", "wallpaper": proc.mode = .image
      default: proc.mode = .off
      }
      proc.imageAsset = imageAsset
      // Persist to App Group UserDefaults so cold launches inherit.
      if let ud = UserDefaults(suiteName: kAppGroupId) {
        ud.set(mode, forKey: "bg_mode")
        ud.set(imageAsset ?? "", forKey: "bg_image")
      }
      NSLog("[ExpoCallKit] setBackgroundMode: \(mode) asset=\(imageAsset ?? "<nil>") available=\(proc.available)")
      return true
    }

    Function("getBackgroundMode") { () -> [String: Any] in
      if let ud = UserDefaults(suiteName: kAppGroupId) {
        return [
          "mode": ud.string(forKey: "bg_mode") ?? "off",
          "imageAsset": ud.string(forKey: "bg_image") ?? "",
        ]
      }
      return ["mode": "off", "imageAsset": ""]
    }

    Function("isBackgroundProcessorAvailable") { () -> Bool in
      return BackgroundProcessor.shared.available
    }

    Function("getBackgroundWallpapers") { () -> [String] in
      return BackgroundProcessor.builtinWallpapers
    }

    // ─── Screen share (Stage 4 / 2026-05-17) ─────────────────────────────
    //
    // Top-level entry that JS calls when the user taps the screen-share pill.
    // On iOS we forward to the existing modules/expo-screen-share which owns
    // the ReplayKit broadcast picker. The actual frame transmission is the
    // ChatyyBroadcastExtension target (SampleHandler.swift) which already
    // extends LKSampleHandler — LiveKit pipes those frames into the screen
    // share track without any further wiring here.
    //
    // `audioShare` is honoured per ReplayKit's API: the picker exposes an
    // "Include microphone" toggle automatically; system-audio (app audio)
    // requires the extension to call AVAudioSession.sharedInstance().setCategory(.playAndRecord)
    // with .mixWithOthers — handled in SampleHandler.swift when LKSampleHandler
    // sees a non-zero `broadcastDelayMillis`.
    AsyncFunction("startScreenshare") { (audioShare: Bool) -> Bool in
      // Forward via NotificationCenter so the existing ExpoScreenShare module
      // owns the picker presentation. Keeps native + JS call sites symmetric
      // (the bridge into the LK Room is the same on both platforms).
      NotificationCenter.default.post(
        name: Notification.Name("ExpoCallKitRequestScreenshare"),
        object: nil,
        userInfo: ["audioShare": audioShare]
      )
      NSLog("[ExpoCallKit] startScreenshare: dispatched (audioShare=\(audioShare))")
      return true
    }

    AsyncFunction("stopScreenshare") { () -> Bool in
      NotificationCenter.default.post(
        name: Notification.Name("ExpoCallKitRequestStopScreenshare"),
        object: nil
      )
      return true
    }

    // DEPRECATED — to be removed in v2.5.0
    // [Wave Bridge-Surface, 2026-05-21 / Agent 9] This was the explicit
    // "give JS a handle to the native LiveKit Room so JS /call.js can
    // render the participant grid" escape hatch. The return value leaks
    // remote participants array, identity, room name — all things JS
    // shouldn't need. /call.js on mobile is going away (full native
    // SwiftUI CallView owns the UI). Replacement: read minimal call info
    // via getCurrentCallSnapshot(). For participant list (group calls
    // only) a new dedicated GroupCallSnapshot will be added if needed.
    // [Stage 1+2 alignment] Match Android signature: adoptNativeRoom(callId)
    // returns the snapshot dict or nil if no room or callId mismatch.
    AsyncFunction("adoptNativeRoom") { (callId: String) -> [String: Any]? in
      // [FIX 2026-05-20 #954 regression] Loosened: accept the Room even when
      // it's still .connecting. JS will mark peerConnected=false and wait for
      // the onLkConnected event (via installNativeCallStateBridge). Previously
      // the strict `snap.connected` gate caused a 2-4s window where JS
      // assumed no native Room existed and spawned its own → duplicate Room
      // with same identity → SFU evicts one → audio one-way / mute desync.
      NativeCallRoom.shared.addListener(self)
      guard NativeCallRoom.shared.hasRoom() else { return nil }
      if let active = NativeCallRoom.shared.lastRoomName, !active.isEmpty,
         active != callId {
        print("[ExpoCallKit] adoptNativeRoom: room is for \(active), not \(callId)")
        return nil
      }
      let snap = NativeCallRoom.shared.getSnapshot()
      var dict = snap.toDictionary()
      dict["alreadyConnected"] = snap.connected
      dict["state"] = NativeCallRoom.shared.state.rawValue
      return dict
    }

    // DEPRECATED — to be removed in v2.5.0
    // Replaced by getCurrentCallSnapshot().lkConnected which is part of the
    // canonical read API. Standalone existence of this Function encouraged
    // JS to poll LK state independently of the rest of call state, which
    // is exactly the desync that caused "Connecting..." eternal.
    Function("isNativeRoomConnected") { () -> Bool in
      NativeCallRoom.shared.state.rawValue == "connected"
    }

    // [Stage 1+2 alignment] Positional args: persistAuthForNativeCall(token, baseUrl).
    AsyncFunction("persistAuthForNativeCall") { (token: String, baseUrl: String) -> Void in
      guard let ud = UserDefaults(suiteName: kAppGroupId) else { return }
      ud.set(token, forKey: "auth_token")
      ud.set(baseUrl, forKey: "api_base")
      ud.set(Date().timeIntervalSince1970, forKey: "auth_token_at")
      // [P0 2026-05-18 #1132] Now that we have a fresh bearer in the App
      // Group, open the native CallSignalWs eagerly so inbound `call_invite`
      // frames can ring CallKit even if the JS WS path is broken/paused.
      CallSignalWs.shared.warmConnect()
    }

    AsyncFunction("persistPendingLkToken") { (roomName: String, token: String, url: String) -> Void in
      guard let ud = UserDefaults(suiteName: kAppGroupId) else { return }
      ud.set(token, forKey: "lk_token_\(roomName)")
      ud.set(url, forKey: "lk_url_\(roomName)")
      ud.set(Date().timeIntervalSince1970, forKey: "lk_ts_\(roomName)")
    }

    Function("getDiagnostics") { () -> [String: Any] in
      let callCount = self.safeStateSync { self.activeCalls.count }
      let hasToken: Bool = {
        if let ud = UserDefaults(suiteName: kAppGroupId) {
          return ud.string(forKey: "voipToken") != nil
        }
        return false
      }()
      return [
        "providerReady": self.provider != nil,
        "callControllerReady": self.callController != nil,
        "providerDelegateReady": self.providerDelegate != nil,
        "hasVoipToken": hasToken,
        "activeCalls": callCount,
        "isMainThread": Thread.isMainThread,
        "registryOwner": "AppDelegate",
        // [stage 2] surface native LK state to JS so /call can diagnose
        // pre-connect outcome without a roundtrip through events.
        "nativeRoomState": NativeCallRoom.shared.state.rawValue,
        "nativeRoomName": NativeCallRoom.shared.lastRoomName as Any,
        "nativeRoomIdentity": NativeCallRoom.shared.lastIdentity as Any,
      ]
    }

    // [Wave Bridge-Surface, 2026-05-21 / Agent 9] Read-only call snapshot.
    //
    // SYNCHRONOUS — must be `Function`, NOT `AsyncFunction`. JS polls this
    // every 1s from `services/call-state-reader.js` (via `useCurrentCall`
    // hook) plus on `onCallStarted`/`onCallEnded` event triggers. Sync
    // means a single bridge crossing and no microtask queue scheduling —
    // measured at ~30µs roundtrip on iPhone 13.
    //
    // Returns `nil` when no call is active. JS receives `null` in that
    // case and the hook short-circuits CallStatusBar rendering.
    //
    // CONTRACT: the payload shape is the entire JS-visible call state.
    // If you find yourself wanting to expose more (Room handle, SDP, raw
    // signaling), STOP — see docs/whatsapp-migration/IMPL-bridge-surface-policy.md
    // and either add it to CallStateSnapshot intentionally or push the
    // logic into native instead.
    Function("getCurrentCallSnapshot") { () -> [String: Any]? in
      return self.safeStateSync { () -> [String: Any]? in
        guard let ctx = self.currentCallContext else { return nil }
        let duration: Int = {
          guard let start = ctx.startedAt else { return 0 }
          return max(0, Int(CFAbsoluteTimeGetCurrent() - start))
        }()
        // [Bridge-Surface] lkConnected derived from NativeCallRoom — JS
        // doesn't reach into NativeCallRoom directly anymore. The single
        // permitted way for JS to learn about LK state is via this field.
        let lkConnected = (NativeCallRoom.shared.state.rawValue == "connected")
        let snap = CallStateSnapshot(
          callId: ctx.callId,
          contactEmail: ctx.contactEmail,
          contactName: ctx.contactName,
          isVideo: ctx.isVideo,
          mic: ctx.mic,
          speaker: ctx.speaker,
          durationSec: duration,
          lkConnected: lkConnected,
          ringState: ctx.ringState
        )
        return snap.toDictionary()
      }
    }

    // [native call screen, 2026-05-16] Mirrors Android's `openNativeCall`.
    // JS calls this to swap /call.js out for the SwiftUI CallView.
    // [Day 2, 2026-05-16] lkUrl + lkToken are now forwarded into the VC so
    // CallViewController can own the LiveKit Room directly. When either is
    // nil/empty the VC skips Room.connect and the JS @livekit/react-native
    // path stays in charge (fallback for unmigrated callers).
    AsyncFunction("openNativeCall") { (callId: String, callerName: String, callerEmail: String, hasVideo: Bool, lkUrl: String?, lkToken: String?) -> Void in
      await MainActor.run {
        // [STAGE-A 2026-05-20] GAP #8 — Foreground gate REMOVED. WhatsApp
        // (and FaceTime) ALWAYS present the native CallKit-owned call UI,
        // even when the app is open. CallViewController is the source of
        // truth; /call.js becomes a read-only fallback observer for legacy
        // unmigrated callers. The double-mount ("duas telas de ligação")
        // concern is now mitigated upstream: services/callkeep no longer
        // router.push('/call') when openNativeCall succeeds (handled by
        // MobileNativeBridge JS gate). If a stale /call.js does mount it
        // will adopt the native Room via the GAP #6 poll loop and stay
        // invisible behind the SwiftUI VC.
        // [#1172 fix, 2026-05-18] resolvePresentingViewController handles
        // backgrounded scenes, CallKit ring-sheet contention, and multi-scene
        // iPad windows — see helper docstring.
        guard let root = resolvePresentingViewController() else {
          print("[ExpoCallKit] openNativeCall: no presenting VC available — call will not foreground")
          return
        }
        CallViewController.present(from: root,
            callId: callId, callerName: callerName,
            callerEmail: callerEmail, hasVideo: hasVideo,
            lkUrl: lkUrl, lkToken: lkToken)
      }
    }

    // ─── Stage #996 outgoing native flow (2026-05-17) ────────────────────
    //
    // JS calls `startOutgoingCall` from the chat "Ligar" tap. We:
    //   1. Generate (or accept JS-supplied) callId.
    //   2. Mint a CXStartCallAction so CallKit knows this is an outgoing
    //      call — required for the system to show the call in Recents, route
    //      the audio session properly, allow lock-screen access etc.
    //   3. ProviderDelegate.provider(_:perform:CXStartCallAction) is the
    //      delegate hook CallKit fires once the transaction executes; that
    //      handler reads `pendingOutgoingCalls[uuid]`, fetches the LK token
    //      if not provided, presents CallViewController with isOutgoing=true
    //      (which fires call_invite + plays ringback already), and calls
    //      action.fulfill().
    //
    // Returns true once the CXTransaction was submitted (not when it
    // completes — CallKit handles the rest async).
    AsyncFunction("startOutgoingCall") { (params: [String: Any]) -> Bool in
      let calleeEmail = (params["callee_email"] as? String) ?? ""
      guard !calleeEmail.isEmpty else {
        throw NSError(domain: "ExpoCallKit", code: 100,
                      userInfo: [NSLocalizedDescriptionKey: "callee_email required"])
      }
      let calleeName = (params["callee_name"] as? String) ?? calleeEmail
      // [CALL-TRACE 2026-05-20 WAVE42] Step 3/12 — iOS native module receives
      // outgoing call from JS. Subsystem stays as the legacy print() but
      // tagged with `[CallTrace][3/12]` so the same grep on console works:
      //   log stream --predicate 'eventMessage contains "CallTrace"'
      let __ct_callId = (params["call_id"] as? String) ?? "<gen>"
      let __ct_hasToken = !((params["lk_token"] as? String) ?? "").isEmpty
      NSLog("[CallTrace][3/12] native startOutgoingCall callId=\(__ct_callId) callee=\(calleeEmail) video=\(params["is_video"] as? Bool ?? false) hasLkToken=\(__ct_hasToken)")
      let calleeAvatar = (params["callee_avatar"] as? String) ?? ""
      let callerName = (params["caller_name"] as? String) ?? ""
      let isVideo = (params["is_video"] as? Bool) ?? false
      let roomName = (params["room_name"] as? String) ?? ""
      let conversationId = (params["conversation_id"] as? String) ?? ""
      let lkUrl = params["lk_url"] as? String
      let lkToken = params["lk_token"] as? String
      // Caller may pin a callId (so the JS side and the server share the same
      // identifier); otherwise we generate one. Note: this is the server-side
      // call_id string, NOT the CallKit UUID — the two are mapped via
      // activeCalls.
      let callId: String = {
        if let cid = params["call_id"] as? String, !cid.isEmpty { return cid }
        return "call_\(Int(Date().timeIntervalSince1970 * 1000))_\(UUID().uuidString.prefix(8))"
      }()
      let uuid = UUID()

      // [#1217 2026-05-19] FULL NATIVE — gate reverted per user decision.
      // The dual-UI approach (JS /call.js when foreground, native when
      // background) kept producing race conditions and "2 telas" reports.
      // We now always present the native CallViewController for every
      // outgoing call, regardless of app state. JS /call.js on mobile is
      // retired (the route still exists for legacy push, but it just
      // dispatches to native and pops).
      let suppressVCPresent = false

      // Stash params for the delegate path AND register the callId↔UUID map
      // so callAnswered/callEnded/endCall route correctly once the callee
      // accepts (the answer event comes through the same CallKit channel).
      self.safeStateSync {
        self.activeCalls[callId] = uuid
        // [#1184 dismiss fix, 2026-05-19] Mirror to static map so CallSignalWs
        // can dismiss CallKit when a `call_end` frame arrives.
        ExpoCallKitModule._shared_setUUID(uuid, forCallId: callId)
        self.pendingOutgoingCalls[uuid] = OutgoingCallParams(
          callId: callId,
          calleeEmail: calleeEmail,
          calleeName: calleeName,
          calleeAvatar: calleeAvatar.isEmpty ? nil : calleeAvatar,
          callerName: callerName,
          isVideo: isVideo,
          roomName: roomName.isEmpty ? callId : roomName,
          conversationId: conversationId,
          lkUrl: lkUrl,
          lkToken: lkToken,
          suppressVCPresent: suppressVCPresent
        )
      }

      // [#1176 polish, 2026-05-18] Side-channel the avatar URL into the App
      // Group UserDefaults so CallView.swift (which is constructed by
      // CallViewController with fixed positional args we can't extend
      // without touching the VC) can pull it on .onAppear. Keyed by callId
      // so concurrent calls don't collide; cleared by the receive path.
      if !calleeAvatar.isEmpty, let ud = UserDefaults(suiteName: kAppGroupId) {
        ud.set(calleeAvatar, forKey: "callAvatar:\(callId)")
      }

      // [WAVE 145 2026-05-22 IMMEDIATE PRESENT — WhatsApp parity]
      // User report: "no whatsapp chama o nativo diferente — quando atende
      // abre o app com a UI". WhatsApp shows its rich call UI INSTANTLY when
      // the user taps "Call", BEFORE CallKit's CXStartCallAction transaction
      // is even queued. The CallKit transaction runs in parallel just for
      // system integration (Recents, lock-screen pill, audio session
      // ownership) — it never blocks the UI.
      //
      // Our old flow waited for: CXStartCallAction.fulfill() → token fetch
      // (200-800ms) → presentOutgoingCallVC. During that window the user
      // saw NO rich UI — just the JS chat screen + maybe iOS's basic call
      // pill at the top. That's the "page não abre dentro do app" bug.
      //
      // Fix: present CallViewController RIGHT NOW with whatever token info
      // we already have (params.lkUrl + params.lkToken if JS prefetched, or
      // nil/nil to let the VC fetch async on its own). CallKit transaction
      // queues immediately after but doesn't block UI rendering.
      let immediateParams = OutgoingCallParams(
        callId: callId,
        calleeEmail: calleeEmail,
        calleeName: calleeName,
        calleeAvatar: calleeAvatar.isEmpty ? nil : calleeAvatar,
        callerName: callerName,
        isVideo: isVideo,
        roomName: roomName.isEmpty ? callId : roomName,
        conversationId: conversationId,
        lkUrl: lkUrl,
        lkToken: lkToken,
        suppressVCPresent: false
      )
      // [WAVE 152 2026-05-22] STOP showing CallView SwiftUI — it crashes.
      //
      // Histórico:
      //  - WAVE 149 criou CallWindowManager pra UIWindow dedicada (não fixou)
      //  - WAVE 150 skip CXStartCallAction em foreground (idem)
      //  - WAVE 151 TimelineView fix pra Timer/Combine (fixou esse crash mas
      //    expôs OUTRO crash de SwiftUI layout recursion: StackLayout →
      //    _PaddingLayout → ZStackLayout infinite loop em build 553)
      //
      // CallView.swift cresceu pra 1795 linhas com ZStacks aninhados, Padding,
      // GeometryReaders e gradients que não convergem em layout. Watchdog
      // scene-update 10s mata o app SEMPRE que tenta abrir.
      //
      // WAVE 152 = NÃO mostra CallView. CallKit cuida da UI (igual WhatsApp
      // durante outgoing ringing). Quando atender, /call.js JS path cuida.
      // Resultado: ligação FUNCIONA. Sem fancy UI mas sem crash.
      //
      // CallWindowManager.swift stays (não removido) caso queira tentar
      // novamente no futuro com CallView simplificado.
      NSLog("[ExpoCallKit WAVE 152] skipping CallWindowManager.showCallUI — CallKit owns UI to prevent SwiftUI layout crash. callId=\(immediateParams.callId)")

      // [2026-05-21] Donate an INStartCallIntent so iOS records this outgoing
      // call in Siri / Recents / "Suggestions" surfaces. Without donation
      // the system can't surface a "Call <name>" shortcut and the call won't
      // appear in the user's call history outside the in-app list.
      let person = INPerson(
        personHandle: INPersonHandle(value: calleeEmail, type: .emailAddress),
        nameComponents: nil,
        displayName: calleeName,
        image: nil,
        contactIdentifier: nil,
        customIdentifier: nil
      )
      let intent = INStartCallIntent(
        callRecordFilter: nil,
        callRecordToCallBack: nil,
        audioRoute: .unknown,
        destinationType: .normal,
        contacts: [person],
        callCapability: isVideo ? .videoCall : .audioCall
      )
      let interaction = INInteraction(intent: intent, response: nil)
      interaction.donate(completion: nil)

      // [fix 2026-05-21] OnCreate dispatches setupProvider via main.async, so on
      // very fast taps (< ~50ms after launch) callController may still be nil.
      // Eagerly set up on the calling thread if so, falling back to a blocking
      // main-thread dispatch so CXCallController is always available here.
      if self.callController == nil {
        if Thread.isMainThread {
          self.setupProvider()
        } else {
          DispatchQueue.main.sync { self.setupProvider() }
        }
      }
      guard let cc = self.callController else {
        throw NSError(domain: "ExpoCallKit", code: 101,
                      userInfo: [NSLocalizedDescriptionKey: "CallController not ready — setupProvider() failed on main thread"])
      }

      // [2026-05-21] Pre-cleanup orphan calls.
      // User print: "Erro: Não foi possível iniciar a chamada. The
      // operation couldn't be completed. (com.apple.CallKit.error.
      // requesttransaction error 7.)" — code 7 =
      // CXErrorCodeRequestTransactionErrorMaximumCallGroupsReached. iOS
      // caps the number of active CXCall groups; if a previous outgoing
      // attempt didn't tear down (network drop, app kill mid-call,
      // delegate path bypassed end-action), every new attempt hits the
      // cap and the dialog above appears. End every observed call from
      // CXCallObserver and clear our maps before requesting the new
      // transaction. Failures from end-action are ignored (best effort).
      let observer = CXCallObserver()
      let orphans = observer.calls.filter { !$0.hasEnded }
      if !orphans.isEmpty {
        NSLog("[ExpoCallKit] startOutgoingCall: clearing \(orphans.count) orphan call group(s) before new transaction")
        let endTx = CXTransaction()
        for orphan in orphans {
          endTx.addAction(CXEndCallAction(call: orphan.uuid))
        }
        // Fire-and-forget — we don't await the end transaction; if it fails
        // the new transaction below will likely also fail and the JS layer
        // will surface a fresh error.
        cc.request(endTx) { err in
          if let err = err {
            NSLog("[ExpoCallKit] orphan cleanup transaction error: \(err.localizedDescription)")
          }
        }
        // Clear in-memory maps; the provider delegate's CXEndCallAction
        // handlers may also fire and remove these, but doing it here keeps
        // state coherent in case the delegate is delayed.
        self.safeStateSync {
          self.activeCalls.removeAll()
          self.pendingOutgoingCalls.removeAll()
        }
        // Re-stash the new pending entry — the removeAll above wiped it.
        self.safeStateSync {
          self.activeCalls[callId] = uuid
          ExpoCallKitModule._shared_setUUID(uuid, forCallId: callId)
          self.pendingOutgoingCalls[uuid] = OutgoingCallParams(
            callId: callId,
            calleeEmail: calleeEmail,
            calleeName: calleeName,
            calleeAvatar: calleeAvatar.isEmpty ? nil : calleeAvatar,
            callerName: callerName,
            isVideo: isVideo,
            roomName: roomName.isEmpty ? callId : roomName,
            conversationId: conversationId,
            lkUrl: lkUrl,
            lkToken: lkToken,
            suppressVCPresent: suppressVCPresent
          )
        }
      }

      // [WAVE 152 2026-05-22] REVERTED WAVE 150 skip. CXStartCallAction ALWAYS
      // fires — CallKit owns the UI completely (same as WhatsApp during outgoing
      // ringing). Without this, the call would have no system integration and
      // no UI at all. Combined with WAVE 152's skip of showCallUI above, the
      // result is: CallKit's native call screen handles everything.
      let handle = CXHandle(type: .emailAddress, value: calleeEmail)
      let startAction = CXStartCallAction(call: uuid, handle: handle)
      startAction.isVideo = isVideo
      startAction.contactIdentifier = calleeName
      let transaction = CXTransaction(action: startAction)

      // CXCallController.request takes a completion. We bridge it to the
      // async function via withCheckedThrowingContinuation so JS gets a
      // proper Promise resolve/reject.
      return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
        cc.request(transaction) { error in
          if let error = error {
            print("[ExpoCallKit] startOutgoingCall: transaction failed: \(error.localizedDescription)")
            // Clean up the stashed state on failure so we don't leak.
            self.safeStateSync {
              self.activeCalls.removeValue(forKey: callId)
              self.pendingOutgoingCalls.removeValue(forKey: uuid)
            }
            ExpoCallKitModule._shared_setUUID(nil, forCallId: callId)
            continuation.resume(throwing: error)
          } else {
            print("[ExpoCallKit] startOutgoingCall: transaction queued for callId=\(callId)")
            // [2026-05-22 outgoing timeout] Schedule a 45s ring-timeout so
            // if the callee never answers (network drop, app killed, FCM
            // throttled, WS dropped, etc) we don't stay parasitic on
            // "Connecting..." forever.
            self.scheduleOutgoingTimeout(callId: callId)
            continuation.resume(returning: true)
          }
        }
      }
    }

    // [native group call screen, 2026-05-16] Mirrors Android's
    // openGroupCall — JS swaps /group-call.js (WebView wrapping
    // livekit-room.html) out for the SwiftUI GroupCallView grid.
    // participantsJson is a JSON-encoded array of
    //   { identity, name, audioMuted }
    // so the grid can render avatar placeholders immediately while LiveKit
    // negotiates the actual room.
    AsyncFunction("openGroupCall") {
      (roomName: String, lkUrl: String, lkToken: String, participantsJson: String, hasVideo: Bool) -> Void in
      await MainActor.run {
        guard let root = resolvePresentingViewController() else {
          print("[ExpoCallKit] openGroupCall: no presenting VC available")
          return
        }
        GroupCallViewController.present(from: root,
          roomName: roomName, lkUrl: lkUrl, lkToken: lkToken,
          participantsJson: participantsJson, hasVideo: hasVideo)
      }
    }

    // [Stage #999 native live broadcast, 2026-05-17] Launch the SwiftUI
    // host UI for /live. Replaces the RN /live-broadcast.js screen.
    // hostAvatar is the URL string (empty string treated as nil — Swift
    // optionals across the JS bridge are nullable). The VC owns the LK
    // Room (publisher) and the WS subscription, so JS only needs the
    // initial token + session id.
    AsyncFunction("startLiveBroadcast") {
      (liveSessionId: String, lkUrl: String, lkToken: String,
       hostEmail: String, hostName: String, hostAvatar: String?) -> Void in
      await MainActor.run {
        guard let root = resolvePresentingViewController() else {
          print("[ExpoCallKit] startLiveBroadcast: no presenting VC available")
          return
        }
        LiveBroadcastViewController.present(
          from: root,
          liveSessionId: liveSessionId,
          lkUrl: lkUrl, lkToken: lkToken,
          hostEmail: hostEmail, hostName: hostName,
          hostAvatar: (hostAvatar?.isEmpty == false) ? hostAvatar : nil
        )
      }
    }

    // [Stage #1000 native live viewer, 2026-05-17] Launch the SwiftUI
    // viewer UI for /live-viewer. Subscriber-only LK role. pinnedComment
    // + slowModeSeconds let the viewer render the current host-side
    // state without a WS round-trip (server snapshot already lives in
    // chat_live_pin_comment + chat_live_sessions.slow_mode_seconds; JS
    // pulls them on /live-viewer mount and forwards here).
    AsyncFunction("startLiveViewer") {
      (liveSessionId: String, lkUrl: String, lkToken: String,
       hostEmail: String, hostName: String, hostAvatar: String?,
       viewerEmail: String,
       pinnedCommentText: String?, pinnedCommentAuthor: String?,
       slowModeSeconds: Int) -> Void in
      await MainActor.run {
        guard let root = resolvePresentingViewController() else {
          print("[ExpoCallKit] startLiveViewer: no presenting VC available")
          return
        }
        let pinned: LivePinnedComment? = {
          guard let txt = pinnedCommentText, !txt.isEmpty else { return nil }
          let name = pinnedCommentAuthor ?? "?"
          return LivePinnedComment(authorName: name, text: txt)
        }()
        LiveViewerViewController.present(
          from: root,
          liveSessionId: liveSessionId,
          lkUrl: lkUrl, lkToken: lkToken,
          hostEmail: hostEmail, hostName: hostName,
          hostAvatar: (hostAvatar?.isEmpty == false) ? hostAvatar : nil,
          viewerEmail: viewerEmail,
          pinnedComment: pinned,
          slowModeSeconds: slowModeSeconds
        )
      }
    }

    // ─── Native WS call signaling (Stage 1, 2026-05-16) ──────────────────
    //
    // JS-callable bridge to CallSignalWs (raw URLSessionWebSocketTask to
    // wss://ws.chatyy.com.br/ws). Sync Function — fire-and-forget; the WS
    // layer queues + auto-reconnects internally.
    //
    // Stage 1 only stands up the bridge. Stage 2 (separate work) will wire
    // CallViewController to call these directly so the call signaling path
    // no longer touches the JS bridge. JS-side WS keeps working in parallel.
    // DEPRECATED — to be removed in v2.5.0
    // [Wave Bridge-Surface, 2026-05-21 / Agent 9] JS-initiated signaling
    // emission. The whole point of native ownership is that JS should not
    // be the source of call_invite frames anymore — CallSignalWs.swift
    // emits them directly when CXStartCallAction fulfils. Kept so OTA-
    // shipped JS bundles still work; new code paths must NOT call this.
    Function("fireCallInviteNative") { (callId: String, conversationId: String, calleeEmail: String, hasVideo: Bool) -> Void in
      CallSignalWs.shared.fireCallInvite(
        callId: callId,
        conversationId: conversationId,
        calleeEmail: calleeEmail,
        hasVideo: hasVideo
      )
    }

    // DEPRECATED — to be removed in v2.5.0
    // Native fires the answered signal when CXAnswerCallAction fulfils,
    // not when JS asks. JS-initiated firing produced double-answer races
    // (JS emits while CallKit is mid-fulfill → SFU joins twice).
    Function("fireCallAnsweredNative") { (callId: String, conversationId: String) -> Void in
      CallSignalWs.shared.fireCallAnswered(callId: callId, conversationId: conversationId)
    }

    // DEPRECATED — to be removed in v2.5.0
    // Use ExpoCallKit.endCall(callId, reason) which goes through CallKit
    // CXEndCallAction. Direct WS frame emission from JS skipped CallKit's
    // call-ended cleanup so the system pill stayed visible.
    Function("fireCallEndNative") { (callId: String, conversationId: String, reason: String) -> Void in
      CallSignalWs.shared.fireCallEnd(callId: callId, conversationId: conversationId, reason: reason)
    }

    // [P0 2026-05-18 #1132] Eagerly open the native CallSignalWs so it can
    // receive inbound `call_invite` frames and ring CallKit even if the JS
    // WS path is broken / paused / lazy-loading. Idempotent; safe to call
    // from any JS hook (login, foreground, even on every render).
    Function("warmCallSignalWs") { () -> Void in
      CallSignalWs.shared.warmConnect()
    }

    // ─── DTMF keypad (2026-05-19) ────────────────────────────────────────
    //
    // Two-tier dispatch:
    //   1. Post `ExpoCallKitPlayDTMF` so CallViewController (which owns the
    //      LK Room) publishes a `{type:"dtmf", digit:"5"}` data frame to the
    //      peer. The peer's call screen can show the digit feedback / play
    //      a tone, but more importantly: when the peer is the SIP/Telnyx
    //      bridge (PSTN gateway), the bridge listens for these frames and
    //      injects RFC 2833 in-band tones into the carrier leg so IVRs see
    //      the keypress.
    //   2. Locally trigger the iOS DTMF tone via `AudioServicesPlaySystemSound`
    //      so the user hears their tap matches the digit (WhatsApp pattern).
    //
    // JS callers: ExpoCallKit.playDTMF("5"). Accepts a single character of
    // 0-9, *, #, or letters A-D (rare but spec-allowed).
    Function("playDTMF") { (digit: String) -> Void in
      let cleaned = digit.trimmingCharacters(in: .whitespacesAndNewlines)
      guard let first = cleaned.first else { return }
      let ch = String(first)
      // Validate — silently drop unknown characters.
      let validChars: Set<Character> = ["0","1","2","3","4","5","6","7","8","9","*","#","A","B","C","D"]
      guard let c = ch.first, validChars.contains(c) else { return }

      // Local audible feedback: play the matching DTMF tone briefly. Codes
      // from the iOS system sound table:
      //   1209-1633Hz row tones — system sounds 1200..1209 are reserved
      //   for the dialer tones (kSystemSoundID_DTMF_*). Using the public
      //   AudioServicesPlaySystemSound stable IDs:
      //     '0' -> 1200, '1' -> 1201, '2' -> 1202, …, '9' -> 1209,
      //     '*' -> 1210, '#' -> 1211, 'A'..'D' -> 1212..1215.
      let baseId: UInt32 = {
        switch c {
        case "0": return 1200
        case "1": return 1201
        case "2": return 1202
        case "3": return 1203
        case "4": return 1204
        case "5": return 1205
        case "6": return 1206
        case "7": return 1207
        case "8": return 1208
        case "9": return 1209
        case "*": return 1210
        case "#": return 1211
        case "A": return 1212
        case "B": return 1213
        case "C": return 1214
        case "D": return 1215
        default: return 0
        }
      }()
      if baseId != 0 {
        AudioServicesPlaySystemSound(SystemSoundID(baseId))
      }

      // Forward to the active CallViewController via NotificationCenter so
      // the Room.localParticipant.publish(data:) call happens on the VC's
      // owned Task scope. The VC ignores when there is no active room
      // (e.g. during ringing pre-connect).
      NotificationCenter.default.post(
        name: Notification.Name("ExpoCallKitPlayDTMF"),
        object: nil,
        userInfo: ["digit": ch]
      )
    }

    // ─── ShareExtension outbox JS bridge (2026-05-19) ────────────────────
    //
    // The ShareExtension writes successful sends to App Group UserDefaults
    // key `chatyy.share_outbox` and posts a Darwin notification. The host
    // observes via Darwin → NSNotification → this module's
    // installShareDidSendObserver(), which then fires `onShareDidSend` to JS.
    //
    // JS reads the queue with getShareOutbox(), reacts to it (refresh chat
    // list / affected conv), then calls clearShareOutbox() to drain.
    //
    // We deliberately don't auto-clear inside the event — JS needs the
    // entries to know which conv to refresh, and a crash between read and
    // refresh shouldn't lose them. The "ack the queue" model keeps the
    // contract simple.

    Function("getShareOutbox") { () -> [[String: Any]] in
      guard let ud = UserDefaults(suiteName: kAppGroupId),
            let queue = ud.array(forKey: "chatyy.share_outbox") as? [[String: Any]]
      else { return [] }
      return queue
    }

    Function("clearShareOutbox") { () -> Void in
      guard let ud = UserDefaults(suiteName: kAppGroupId) else { return }
      ud.removeObject(forKey: "chatyy.share_outbox")
      ud.synchronize()
    }
  }

  // [share outbox feedback, 2026-05-19] Subscribe to the NSNotification the
  // host AppDelegate posts whenever the ShareExtension's Darwin notification
  // fires. We forward to JS as `onShareDidSend`. The event body carries the
  // entire current queue so the JS handler can dispatch per-conversation
  // refreshes in one pass; JS is expected to call clearShareOutbox() after
  // it has dispatched its refreshes.
  private func installShareDidSendObserver() {
    if shareDidSendObserver != nil { return }
    shareDidSendObserver = NotificationCenter.default.addObserver(
      forName: Notification.Name("ShareDidSend"),
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self = self else { return }
      var entries: [[String: Any]] = []
      if let ud = UserDefaults(suiteName: kAppGroupId),
         let queue = ud.array(forKey: "chatyy.share_outbox") as? [[String: Any]] {
        entries = queue
      }
      self.safeSendEvent("onShareDidSend", [
        "entries": entries,
        "count": entries.count,
      ])
      print("[ExpoCallKit] onShareDidSend fired — \(entries.count) entries")
    }
  }

  private func setupProvider() {
    guard provider == nil else { return }
    let config = CXProviderConfiguration(localizedName: "Chatyy")
    config.supportsVideo = true
    config.maximumCallGroups = 1
    config.maximumCallsPerCallGroup = 1
    config.includesCallsInRecents = true
    config.ringtoneSound = "ringtone.wav"
    // [Wave WhatsApp parity, 2026-05-20 gap A2+H5] Accept phoneNumber handles
    // (the VoIP push path now upgrades to .phoneNumber when caller_phone is in
    // the payload). Without this, CallKit rejects the reportNewIncomingCall
    // call silently and the user sees nothing on the lock screen.
    config.supportedHandleTypes = [.generic, .emailAddress, .phoneNumber]
    // [Wave WhatsApp parity, 2026-05-20 gap A2] Same logo template the early
    // provider uses — mirror so the in-app CallKit chrome matches what the
    // user saw on the lock-screen ring window.
    if let img = UIImage(named: "callkit_icon"),
       let data = img.pngData() {
      config.iconTemplateImageData = data
    }

    provider = CXProvider(configuration: config)
    // [WAVE 159 2026-05-22] Publish the module's provider so CallViewController
    // (in another file) can call reportCall on the SAME instance that owns
    // the call. Without this, reportCall(.unanswered) was firing on
    // earlyProvider — a different CXProvider — and CallKit ignored it,
    // leaving the system pill ghost on screen.
    ExpoCallKitModule.sharedProvider = provider
    providerDelegate = ProviderDelegate(module: self)
    provider?.setDelegate(providerDelegate, queue: DispatchQueue.main)
    callController = CXCallController()
    // [STAGE-A 2026-05-20] GAP #3 — module's ProviderDelegate is now LIVE.
    // From this point onwards the cold-start stub in VoipPushAppDelegate-
    // Subscriber will bail on CXAnswer / present so we don't double-mount.
    ExpoCallKitModule._setProviderDelegateBound(true)

    // Listen for system audio interruptions (incoming PSTN call, alarm, etc).
    // WhatsApp pauses WebRTC during interruption and resumes after.
    audioInterruptionObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      self?.handleAudioInterruption(notification)
    }
    print("[ExpoCallKit] CXProvider configured")
  }

  /// Install observers that bridge AppDelegate's early PushKit/CallKit
  /// signals into this module so JS sees them once it's ready.
  private func installAppDelegateBridges() {
    if voipTokenObserver == nil {
      voipTokenObserver = NotificationCenter.default.addObserver(
        forName: Notification.Name("ExpoCallKitVoipTokenUpdated"),
        object: nil,
        queue: .main
      ) { [weak self] note in
        guard let token = note.userInfo?["token"] as? String else { return }
        self?.voipTokenReceived(token: token)
      }
    }
    if pendingCallObserver == nil {
      pendingCallObserver = NotificationCenter.default.addObserver(
        forName: Notification.Name("ExpoCallKitPendingVoipCall"),
        object: nil,
        queue: .main
      ) { [weak self] note in
        self?.adoptPendingCall(from: note.userInfo ?? [:])
      }
    }
    // [foreground gate, 2026-05-21] WS-driven incoming-call invite while
    // app is foreground — CallSignalWs.handleIncomingCallInviteLocked posts
    // this notification instead of reporting to CallKit. Forward to JS so
    // /call.js + IncomingCallListener can pick it up alongside the parallel
    // services/websocket.js subscription.
    if incomingCallForegroundObserver == nil {
      incomingCallForegroundObserver = NotificationCenter.default.addObserver(
        forName: Notification.Name("ExpoCallKitIncomingCallForeground"),
        object: nil,
        queue: .main
      ) { [weak self] note in
        guard let info = note.userInfo else { return }
        var payload: [String: Any] = [:]
        for (k, v) in info {
          if let key = k as? String { payload[key] = v }
        }
        // Always tag the source so JS can distinguish from the VoIP/CallKit
        // path. JS-side primary subscription is still services/websocket.js
        // → mailWs.on('call_invite'); this is a belt-and-suspenders bridge.
        if payload["source"] == nil { payload["source"] = "ws" }
        if payload["foreground"] == nil { payload["foreground"] = true }
        self?.safeSendEvent("onIncomingCall", payload)
      }
    }
  }

  /// [native call screen, 2026-05-16] Listen for the SwiftUI CallView's
  /// hangup tap and translate it into the canonical `onCallEnded` JS event.
  /// Ignored if the notification's userInfo is missing the callId — the
  /// emitter is always CallViewController, which sets it unconditionally.
  private func installNativeCallEndedObserver() {
    guard nativeCallEndedObserver == nil else { return }
    nativeCallEndedObserver = NotificationCenter.default.addObserver(
      forName: Notification.Name("ExpoCallKitNativeCallEnded"),
      object: nil,
      queue: .main
    ) { [weak self] note in
      guard let callId = note.userInfo?["callId"] as? String, !callId.isEmpty else { return }
      // [#1171 redux dismiss, 2026-05-19] Drop the activeCalls / sharedUUID
      // entries on remote-end paths too. Previously this observer only fired
      // the JS event + UI dismiss; activeCalls stayed populated, so a
      // concurrent CXAnswer / CXStart token-fetch Task that completed AFTER
      // the remote end would pass the `isCallStillActive` guard (which it
      // shouldn't) and present a stale CallViewController. Cleaning the
      // maps here is idempotent vs. the local CXEndCallAction path
      // (callEnded already cleared them) — both paths converge.
      if let self = self {
        let uuid: UUID? = self.safeStateSync {
          let u = self.activeCalls[callId]
          self.activeCalls.removeValue(forKey: callId)
          self.callPayloads.removeValue(forKey: callId)
          return u
        }
        // Mirror the static map so isCallStillActive sees the change.
        ExpoCallKitModule._shared_setUUID(nil, forCallId: callId)
        if uuid != nil {
          print("[ExpoCallKit] remote-end \(callId): cleared activeCalls + sharedUUID")
        }
      }
      // [WAVE 116 2026-05-21] Issue 4 — purge pending LK token on remote-end
      // path too (peer hung up via WS → ExpoCallKitNativeCallEnded).
      ExpoCallKitModule.clearPendingLkToken(callId: callId)
      self?.safeSendEvent("onCallEnded", ["callId": callId])
      // [#1179 cleanup, 2026-05-19] When the peer hangs up via WS, CallSignalWs
      // posts this notification (handleIncomingCallEndLocked). The CallKit
      // system UI dismisses via reportCall(with:endedAt:reason:) but our
      // presented CallViewController is a UIKit modal — CallKit doesn't tear
      // it down. Dismiss it explicitly here. Idempotent vs. the local-hangup
      // CXEndCallAction path which also dismisses.
      ProviderDelegate.dismissActiveCallSurfaces(reason: "remote_call_end")
    }

    // __chatyy_native_call_sync 2026-05-19 — observe call-state notifications
    // posted by CallViewController.apply* (mute, cam, speaker, route, hold,
    // PiP, camera flip) and forward them to JS as typed events. Using
    // NotificationCenter avoids needing a strong CallVC→Module ref (CallVC
    // is a UIKit-presented modal owned by ProviderDelegate, not the RN
    // bridge). The state names are stable across iOS minor revs.
    guard callStateObservers.isEmpty else { return }
    let nc = NotificationCenter.default
    let q = OperationQueue.main
    let triples: [(String, String, String)] = [
      // (postedName, jsEvent, payloadKey)
      ("ExpoCallKitLkLocalAudioChanged", "onLkLocalAudioChanged", "enabled"),
      ("ExpoCallKitLkLocalVideoChanged", "onLkLocalVideoChanged", "enabled"),
      ("ExpoCallKitLkSpeakerChanged", "onLkSpeakerChanged", "enabled"),
      ("ExpoCallKitLkCameraFlipped", "onLkCameraFlipped", "front"),
      ("ExpoCallKitAudioRouteChanged", "onAudioRouteChanged", "route"),
      ("ExpoCallKitCallHoldChanged", "onCallHoldChanged", "held"),
      ("ExpoCallKitPipChanged", "onPipChanged", "inPip"),
    ]
    for (name, jsEvent, key) in triples {
      let token = nc.addObserver(forName: Notification.Name(name), object: nil, queue: q) { [weak self] note in
        guard let raw = note.userInfo?[key] else { return }
        self?.safeSendEvent(jsEvent, [key: raw])
      }
      callStateObservers.append(token)
    }

    // [Wave C-1, 2026-05-21] Back-to-chat event. Payload has two string
    // fields (callId, conversationId); the triples loop above only handles
    // single-key payloads so we wire this one manually.
    let chatToken = nc.addObserver(
      forName: Notification.Name("ExpoCallKitOpenChat"),
      object: nil,
      queue: q
    ) { [weak self] note in
      let callId = note.userInfo?["callId"] as? String ?? ""
      let convId  = note.userInfo?["conversationId"] as? String ?? ""
      self?.safeSendEvent("onOpenChat", ["callId": callId, "conversationId": convId])
    }
    callStateObservers.append(chatToken)
  }

  /// [2026-05-22 #1349 fix] Bridge the CallSignalWs receiver-loop
  /// notifications to JS as typed Expo Module events. CallSignalWs only
  /// posts NotificationCenter (it has no RN bridge ref of its own);
  /// CallViewController observes the same notifications for its own
  /// ringback teardown. This installer adds the JS-side fan-out so /call
  /// state stays consistent without waiting for the JS mailWs subscription
  /// (which is paused when the screen is backgrounded or the JS bridge is
  /// still loading on cold-start). Idempotent.
  private func installRemoteSignalObservers() {
    guard remoteSignalObservers.isEmpty else { return }
    let nc = NotificationCenter.default
    let q = OperationQueue.main

    let triples: [(notif: String, event: String)] = [
      ("CallKitCallAnsweredRemote",  "onCallAnsweredRemote"),
      ("CallKitCallDeclinedRemote",  "onCallDeclinedRemote"),
      ("CallKitCallCancelledRemote", "onCallCancelledRemote"),
    ]
    for triple in triples {
      let event = triple.event
      let token = nc.addObserver(
        forName: Notification.Name(triple.notif),
        object: nil,
        queue: q
      ) { [weak self] note in
        // Tolerate both spellings — CallSignalWs writes both today.
        let callId = (note.userInfo?["callId"] as? String)
          ?? (note.userInfo?["call_id"] as? String)
          ?? ""
        guard !callId.isEmpty else { return }
        var payload: [String: Any] = ["callId": callId]
        if let r = note.userInfo?["reason"] as? String, !r.isEmpty {
          payload["reason"] = r
        }
        if let e = note.userInfo?["acceptedByEmail"] as? String, !e.isEmpty {
          payload["acceptedByEmail"] = e
        }
        if let c = note.userInfo?["acceptedByClientId"] as? String, !c.isEmpty {
          payload["acceptedByClientId"] = c
        }
        if let d = note.userInfo?["declinedByEmail"] as? String, !d.isEmpty {
          payload["declinedByEmail"] = d
        }
        self?.safeSendEvent(event, payload)
      }
      remoteSignalObservers.append(token)
    }
  }

  private func flushVoipTokenFromAppGroup() {
    guard let ud = UserDefaults(suiteName: kAppGroupId),
          let token = ud.string(forKey: "voipToken") else { return }
    voipTokenReceived(token: token)
  }

  /// Drain the App Group pending-call queue, adopting each call so CallKit
  /// answer/end actions route through this module and JS sees onIncomingCall.
  private func adoptPendingCallsFromAppGroup() {
    guard let ud = UserDefaults(suiteName: kAppGroupId) else { return }
    guard let raw = ud.array(forKey: kPendingCallKey) as? [[String: Any]],
          !raw.isEmpty else { return }
    ud.removeObject(forKey: kPendingCallKey)
    print("[ExpoCallKit] Adopting \(raw.count) pending call(s) from AppDelegate")
    for entry in raw {
      adoptPendingCall(from: entry)
    }
    // Also check if AppDelegate already answered/ended via the stub provider
    // while RN was loading — replay onCallAnswered / onCallEnded as needed.
    if let acceptUUID = ud.string(forKey: "pendingAcceptUUID"),
       let uuid = UUID(uuidString: acceptUUID) {
      print("[ExpoCallKit] AppDelegate accepted UUID \(acceptUUID) before RN ready — replaying")
      callAnswered(uuid: uuid)
      ud.removeObject(forKey: "pendingAcceptUUID")
    }
    if let endUUID = ud.string(forKey: "pendingEndUUID"),
       let uuid = UUID(uuidString: endUUID) {
      print("[ExpoCallKit] AppDelegate ended UUID \(endUUID) before RN ready — replaying")
      callEnded(uuid: uuid)
      ud.removeObject(forKey: "pendingEndUUID")
    }
  }

  /// Adopt a single pending call entry: register its UUID in `activeCalls`,
  /// stash the payload, and emit onIncomingCall to JS so the in-app Modal
  /// can render alongside the CallKit native UI.
  private func adoptPendingCall(from entry: [AnyHashable: Any]) {
    guard let callId = entry["callId"] as? String,
          let uuidStr = entry["uuid"] as? String,
          let uuid = UUID(uuidString: uuidStr) else { return }
    let callerName = (entry["callerName"] as? String) ?? "Unknown"
    let hasVideo = (entry["hasVideo"] as? Bool) ?? false
    let payload = (entry["payload"] as? [String: Any]) ?? [:]

    safeStateSync {
      activeCalls[callId] = uuid
      callPayloads[callId] = payload
    }
    // [#1184 dismiss fix, 2026-05-19] Mirror to static map so CallSignalWs
    // remote-end path can dismiss CallKit for VoIP-push-surfaced calls.
    ExpoCallKitModule._shared_setUUID(uuid, forCallId: callId)
    print("[ExpoCallKit] Adopted call \(callId) uuid=\(uuid.uuidString)")
    safeSendEvent("onIncomingCall", [
      "callId": callId,
      "callerName": callerName,
      "callerEmail": (payload["caller_email"] as? String) ?? "",
      "conversationId": (payload["conversation_id"] as? String) ?? "",
      "hasVideo": hasVideo
    ])
  }

  private func setupNetworkMonitor() {
    guard pathMonitor == nil else { return }
    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { [weak self] path in
      guard let self = self else { return }
      let status: String
      if path.status == .satisfied {
        if path.usesInterfaceType(.wifi) { status = "wifi" }
        else if path.usesInterfaceType(.cellular) { status = "cellular" }
        else if path.usesInterfaceType(.wiredEthernet) { status = "ethernet" }
        else { status = "online" }
      } else {
        status = "offline"
      }
      // Thread-safe check via stateQueue (pathUpdateHandler runs on monitorQueue)
      let shouldNotify = self.safeStateSync { () -> Bool in
        if status != self.lastNetworkStatus {
          self.lastNetworkStatus = status
          return true
        }
        return false
      }
      if shouldNotify {
        print("[ExpoCallKit] Network changed: \(status)")
        self.safeSendEvent("onNetworkChange", [
          "status": status,
          "isExpensive": path.isExpensive,
          "isConstrained": path.isConstrained,
        ])
      }
    }
    monitor.start(queue: DispatchQueue(label: "com.onemundo.callkit.netmon"))
    pathMonitor = monitor
    print("[ExpoCallKit] NWPathMonitor started")
  }

  deinit {
    if let obs = audioInterruptionObserver {
      NotificationCenter.default.removeObserver(obs)
    }
    if let obs = voipTokenObserver {
      NotificationCenter.default.removeObserver(obs)
    }
    if let obs = pendingCallObserver {
      NotificationCenter.default.removeObserver(obs)
    }
    if let obs = nativeCallEndedObserver {
      NotificationCenter.default.removeObserver(obs)
    }
    if let obs = incomingCallForegroundObserver {
      NotificationCenter.default.removeObserver(obs)
    }
    if let obs = shareDidSendObserver {
      NotificationCenter.default.removeObserver(obs)
    }
    // [2026-05-22 #1349 fix] Caller-side WS receiver-loop event observers.
    for obs in remoteSignalObservers {
      NotificationCenter.default.removeObserver(obs)
    }
    remoteSignalObservers.removeAll()
    // __chatyy_native_call_sync — drop the call-state observers too.
    for obs in callStateObservers {
      NotificationCenter.default.removeObserver(obs)
    }
    callStateObservers.removeAll()
    pathMonitor?.cancel()
  }

  /// [WAVE 163 2026-05-23 GHOST FIX] willTerminate selector — fires before
  /// SIGKILL when user swipes the app away. We have ~5s to walk activeCalls
  /// and reportCall(.failed) for any "Connecting…" call before iOS kills us.
  /// Without this, CallKit's callservicesd keeps the pill on lock screen
  /// until its own internal timeout (~30-90s).
  @objc private func handleAppWillTerminate() {
    NSLog("[ExpoCallKit][WAVE163] willTerminate — failing any in-flight outgoing calls")
    let snapshot: [String: UUID] = safeStateSync { activeCalls }
    let prov = self.provider ?? ExpoCallKitModule.sharedProvider
    guard let provider = prov else {
      NSLog("[ExpoCallKit][WAVE163] willTerminate: no provider available")
      return
    }
    for (callId, uuid) in snapshot {
      provider.reportCall(with: uuid, endedAt: Date(), reason: .failed)
      NSLog("[ExpoCallKit][WAVE163] willTerminate — reportCall(.failed) \(callId)")
    }
  }

  private func handleAudioInterruption(_ notification: Notification) {
    guard let userInfo = notification.userInfo,
          let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
      return
    }
    switch type {
    case .began:
      print("[ExpoCallKit] Audio interruption began — notifying JS")
      safeSendEvent("onAudioInterruption", ["state": "began"])
    case .ended:
      print("[ExpoCallKit] Audio interruption ended — notifying JS")
      var shouldResume = true
      if let opts = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
        let interruptionOptions = AVAudioSession.InterruptionOptions(rawValue: opts)
        shouldResume = interruptionOptions.contains(.shouldResume)
      }
      safeSendEvent("onAudioInterruption", ["state": "ended", "shouldResume": shouldResume])
    @unknown default:
      break
    }
  }

  func reportIncomingCall(callId: String, callerName: String, hasVideo: Bool) async throws {
    guard let provider = self.provider else {
      throw NSError(domain: "ExpoCallKit", code: 1, userInfo: [NSLocalizedDescriptionKey: "Provider not setup"])
    }

    // Deduplicate: reuse existing UUID if callId already tracked
    let uuid: UUID = safeStateSync {
      if let existing = activeCalls[callId] { return existing }
      let newUUID = UUID()
      activeCalls[callId] = newUUID
      return newUUID
    }
    // [#1184 dismiss fix, 2026-05-19] Mirror to static map.
    ExpoCallKitModule._shared_setUUID(uuid, forCallId: callId)

    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: callerName)
    update.localizedCallerName = callerName
    update.hasVideo = hasVideo
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsHolding = true
    // [DTMF, 2026-05-19] Set true so the CallKit system call bar
    // exposes the keypad button alongside our in-app keypad overlay.
    // Both paths route through `playDTMF` (LK data channel) and the
    // ProviderDelegate CXPlayDTMFCallAction handler.
    update.supportsDTMF = true

    try await provider.reportNewIncomingCall(with: uuid, update: update)
  }

  func endCallAction(callId: String) {
    // [WAVE 116 followup, 2026-05-21] Resolve the UUID via THREE sources so
    // a JS-initiated hangup always reaches CallKit's system layer:
    //   1. activeCalls (primary, populated on incoming/outgoing tracking)
    //   2. sharedUUIDByCallId static mirror (survives map clears during
    //      orphan cleanup, populated alongside activeCalls)
    //   3. CXCallObserver().calls (system source of truth — picks up any
    //      CXCall that iOS still considers active even if our bookkeeping
    //      lost it, e.g. after hot reload, app re-launch, or a race where
    //      the cold-start VoIP push stub created a UUID we never tracked)
    // Without all three, the lock-screen pill / Recents / system call bar
    // stays visible after the user taps the JS hangup button — exactly the
    // user report: "desligando quando desliga a chamada no app" the native
    // CallKit UI doesn't sync.
    var resolvedUUID: UUID? = safeStateSync { activeCalls[callId] }
    if resolvedUUID == nil {
      resolvedUUID = ExpoCallKitModule.sharedCallKitUUID(forCallId: callId)
    }
    let observedActiveCalls: [CXCall] = {
      let observed = CXCallObserver().calls.filter { !$0.hasEnded }
      // If we resolved a UUID via maps, prefer ending only that one. Otherwise
      // fall back to ALL active CXCalls (last-resort — there should never be
      // more than one in normal flow because of the orphan-cleanup in
      // startOutgoingCall).
      if let known = resolvedUUID {
        return observed.filter { $0.uuid == known }.isEmpty
          ? observed // known UUID isn't in the observer set (already ended at system level) — fall through to system-wide sweep
          : observed.filter { $0.uuid == known }
      }
      return observed
    }()

    // Always tell CallKit the call ended at the SYSTEM level. CXEndCallAction
    // alone is for user-initiated hangups via the system UI; reportCall is the
    // generic "this call is over, dismiss your surfaces" API and is the one
    // that reliably clears the lock screen + Recents entries on JS-initiated
    // ends. We fire BOTH — reportCall first (no-op if the UUID is unknown to
    // the provider) so CallKit drops its system pill immediately, then submit
    // CXEndCallAction so the delegate's perform-handler runs and the rest of
    // our teardown (audio session, JS event, UI dismiss) fires through the
    // canonical path.
    if let provider = self.provider {
      var endedAny = false
      if let uuid = resolvedUUID {
        provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
        endedAny = true
        print("[ExpoCallKit] endCallAction(\(callId)): reportCall(remoteEnded) on resolved uuid=\(uuid.uuidString)")
      }
      for cxCall in observedActiveCalls where cxCall.uuid != resolvedUUID {
        provider.reportCall(with: cxCall.uuid, endedAt: Date(), reason: .remoteEnded)
        endedAny = true
        print("[ExpoCallKit] endCallAction(\(callId)): reportCall(remoteEnded) on observed uuid=\(cxCall.uuid.uuidString)")
      }
      if !endedAny {
        print("[ExpoCallKit] endCallAction(\(callId)): no UUID resolvable, no observed active CXCalls — UI-only dismiss path")
      }
    }

    // Submit CXEndCallAction(s) through the controller so the delegate's
    // perform-handler runs (it owns audio teardown + system-bar cleanup).
    // Idempotent vs. reportCall above — CallKit dedupes.
    if let callController = callController {
      var endActions: [CXEndCallAction] = []
      if let uuid = resolvedUUID {
        endActions.append(CXEndCallAction(call: uuid))
      }
      for cxCall in observedActiveCalls where cxCall.uuid != resolvedUUID {
        endActions.append(CXEndCallAction(call: cxCall.uuid))
      }
      if !endActions.isEmpty {
        let transaction = CXTransaction()
        for action in endActions { transaction.addAction(action) }
        callController.request(transaction) { error in
          if let error = error {
            print("[ExpoCallKit] End call transaction error: \(error.localizedDescription)")
            // [#1179 cleanup, 2026-05-19] Belt-and-suspenders: if the CallKit
            // transaction fails (already-ended UUID, provider in inconsistent
            // state) we still need to dismiss the modal. Without this the
            // user sees the SwiftUI screen stuck on top with no way out.
            DispatchQueue.main.async {
              ProviderDelegate.dismissActiveCallSurfaces(reason: "cx_transaction_error")
            }
          }
        }
      }
    }

    // Always dismiss any presented call surfaces and tear down audio routing
    // — this is the only path for the "no UUID + no observed call" edge case
    // (hot-reload in dev, residual CallViewController after the system call
    // already ended). Idempotent vs. the CXEndCallAction delegate path.
    DispatchQueue.main.async {
      ProviderDelegate.dismissActiveCallSurfaces(reason: "endCallAction")
      AudioRouter.shared.teardown()
    }

    // Clean bookkeeping so a stale UUID stash can't drive a dismiss on the
    // next call. Safe to clear unconditionally — if the entry wasn't there,
    // removeValue is a no-op. Mirror static map.
    safeStateSync {
      activeCalls.removeValue(forKey: callId)
      callPayloads.removeValue(forKey: callId)
    }
    // [#1184 dismiss fix, 2026-05-19] Mirror remove.
    ExpoCallKitModule._shared_setUUID(nil, forCallId: callId)
    // [WAVE 116 2026-05-21] Issue 4 — purge pending LK token.
    ExpoCallKitModule.clearPendingLkToken(callId: callId)

    // When the resolved-UUID path is taken, the delegate's CXEndCallAction
    // handler fires `module?.callEnded(uuid:)` which emits onCallEnded — JS
    // listens and finishes its teardown (unmounts /call.web.js). When the
    // no-UUID path is taken (no CXEndCallAction submitted), we must emit
    // here so JS still gets the canonical "call ended" event. Guard by
    // checking we never submitted a transaction.
    let didSubmitTransaction = (resolvedUUID != nil) || !observedActiveCalls.isEmpty
    if !didSubmitTransaction {
      safeSendEvent("onCallEnded", ["callId": callId])
    }
  }

  /// Send event to JS, buffering if JS isn't ready yet (cold start)
  /// IMPORTANT: sendEvent must be called OUTSIDE safeStateSync/stateQueue.sync to avoid deadlock
  func safeSendEvent(_ eventName: String, _ body: [String: Any]) {
    let shouldSend = safeStateSync { () -> Bool in
      if jsListenersReady {
        return true
      } else {
        print("[ExpoCallKit] JS not ready, buffering event: \(eventName)")
        pendingEvents.append((eventName, body))
        return false
      }
    }
    if shouldSend {
      sendEvent(eventName, body)
    } else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
        self?.flushPendingEvents()
      }
    }
  }

  private func flushPendingEvents() {
    let toFlush: [(String, [String: Any])] = safeStateSync {
      guard jsListenersReady, !pendingEvents.isEmpty else { return [] }
      let events = pendingEvents
      pendingEvents.removeAll()
      return events
    }
    if !toFlush.isEmpty {
      print("[ExpoCallKit] Flushing \(toFlush.count) pending events")
      for (name, data) in toFlush {
        sendEvent(name, data)
      }
    }
  }

  // [Wave Bridge-Surface, 2026-05-21 / Agent 9] LEAKAGE AUDIT — onCallAnswered.
  //
  // Spec (08-native-call-no-bridge.md §4) calls for minimal `{callId,
  // peerEmail}` only. Today this emitter still publishes callerEmail,
  // callerName, conversationId, hasVideo — that's three extra fields JS
  // could (and does) parse into its own duplicate call state.
  //
  // We DO NOT trim them yet:
  //   - services/callkeep.js reads callerEmail/callerName/hasVideo to
  //     populate the CallContext (CallStatusBar contactName etc).
  //   - Pruning now would blank the status bar on every existing OTA
  //     bundle.
  //
  // Migration plan:
  //   v2.4.x — getCurrentCallSnapshot() ships, JS switches to reading
  //            contactName/contactEmail/isVideo from there (via the new
  //            useCurrentCall hook).
  //   v2.5.0 — strip everything except callId from this emission, drop
  //            the deprecated direct event fields. By then the snapshot
  //            read path is the source of truth.
  func callAnswered(uuid: UUID) {
    let result: (String, [String: Any])? = safeStateSync {
      guard let callId = activeCalls.first(where: { $0.value == uuid })?.key else { return nil }
      var eventData: [String: Any] = ["callId": callId]
      if let payload = callPayloads[callId] {
        eventData["callerEmail"] = payload["caller_email"] as? String ?? ""
        eventData["callerName"] = payload["caller_name"] as? String ?? ""
        eventData["conversationId"] = payload["conversation_id"] as? String ?? ""
        eventData["hasVideo"] = (payload["video"] as? String) == "1"
      }
      callPayloads.removeValue(forKey: callId)
      return (callId, eventData)
    }
    if let (callId, eventData) = result {
      // [2026-05-22 outgoing timeout] Call connected — kill the 45s ring
      // timeout so it can't fire AFTER the call started.
      cancelOutgoingTimeout(callId: callId)
      print("[ExpoCallKit] callAnswered: callId=\(callId), jsReady=\(jsListenersReady)")
      safeSendEvent("onCallAnswered", eventData)
    }
  }

  /// [WAVE 163 2026-05-23 GHOST FIX] Outgoing timeout helpers — moved to a
  /// static, process-scope DispatchSource in VoipPushAppDelegateSubscriber.
  ///
  /// Previously the timer lived on this module's stateQueue. When the user
  /// swipe-kills the app while CallKit is showing "Connecting…", the JS
  /// bridge tears down and stateQueue is freed → timer never fires →
  /// CXProvider in callservicesd (separate process) keeps the call alive
  /// → ghost pill on lock screen for 30-90s until iOS internal timeout.
  ///
  /// Fix: delegate to VoipPushAppDelegateSubscriber.scheduleOutgoingTimeout
  /// which uses DispatchQueue.global(qos: .utility) — survives bridge
  /// teardown. The closure captures only ExpoCallKitModule.sharedProvider
  /// (weak class-static), so it can fire reportCall(.unanswered) even
  /// after this instance dies.
  internal func scheduleOutgoingTimeout(callId: String) {
    guard let uuid = safeStateSync({ activeCalls[callId] }) else {
      NSLog("[ExpoCallKit][WAVE163] scheduleOutgoingTimeout: no UUID for callId=\(callId)")
      return
    }
    VoipPushAppDelegateSubscriber.scheduleOutgoingTimeout(callId: callId, uuid: uuid)
  }

  internal func cancelOutgoingTimeout(callId: String) {
    VoipPushAppDelegateSubscriber.cancelOutgoingTimeout(callId: callId)
  }

  func callEnded(uuid: UUID) {
    let callId: String? = safeStateSync {
      guard let callId = activeCalls.first(where: { $0.value == uuid })?.key else { return nil }
      activeCalls.removeValue(forKey: callId)
      callPayloads.removeValue(forKey: callId)
      return callId
    }
    // [2026-05-22 outgoing timeout] Always cancel the ring timeout — call
    // ended by any path (answered, manual hangup, remote reject, timeout
    // itself) means the timer is no longer needed.
    if let cid = callId { cancelOutgoingTimeout(callId: cid) }
    // [#1184 dismiss fix, 2026-05-19] Mirror remove so a stale UUID stash
    // can't accidentally drive a dismiss on the next call's surface.
    if let cid = callId { ExpoCallKitModule._shared_setUUID(nil, forCallId: cid) }
    if let callId = callId {
      print("[ExpoCallKit] callEnded: callId=\(callId), jsReady=\(jsListenersReady)")
      // [WAVE 116 2026-05-21] Issue 4 — purge the pending LK token/url/ts
      // that was stashed in UserDefaults by persistPendingLkToken (JS) or by
      // the inline VoIP push handler. Safe here: CXEndCallAction fires AFTER
      // the call is fully answered (CXAnswer already ran) — the token is no
      // longer needed.
      ExpoCallKitModule.clearPendingLkToken(callId: callId)
      safeSendEvent("onCallEnded", ["callId": callId])
    }
  }

  // [WAVE 116 2026-05-21] Issue 4 — remove the trio of UserDefaults keys that
  // persistPendingLkToken / VoipPushAppDelegateSubscriber write for a given
  // callId / roomName. Called from every call-end path so tokens don't
  // accumulate over the app lifetime. Must be called AFTER the call ends —
  // CXAnswer still reads lk_token_<callId> during answer-time preconnect.
  static func clearPendingLkToken(callId: String) {
    guard let ud = UserDefaults(suiteName: kAppGroupId) else { return }
    ud.removeObject(forKey: "lk_token_\(callId)")
    ud.removeObject(forKey: "lk_url_\(callId)")
    ud.removeObject(forKey: "lk_ts_\(callId)")
    print("[ExpoCallKit] clearPendingLkToken: removed lk_*_\(callId) from UserDefaults")
  }

  /// Force-end a call by UUID with a CallKit-known reason. Used by the
  /// timedOutPerforming delegate path so the call exits "ringing" cleanly.
  func endCall(callUUID: UUID, reason: CXCallEndedReason) {
    provider?.reportCall(with: callUUID, endedAt: nil, reason: reason)
    callEnded(uuid: callUUID)
  }

  /// [Wave WhatsApp parity, 2026-05-20 gap H5] JS-facing end-call entry that
  /// goes through CXProvider.reportCall (NOT CXEndCallAction) so the system
  /// records the typed ended-reason in Recents.app. The CXEndCallAction path
  /// is for *user-initiated* hangups; reportCall is for everything else
  /// (declined elsewhere, no-answer, peer hung up first, etc.).
  func endCallActionWithReason(callId: String, reasonRaw: String) {
    let mapped = Self.mapEndedReason(reasonRaw)
    let uuid = safeStateSync { activeCalls[callId] }
    if let uuid = uuid {
      provider?.reportCall(with: uuid, endedAt: Date(), reason: mapped)
      safeStateSync {
        activeCalls.removeValue(forKey: callId)
        callPayloads.removeValue(forKey: callId)
      }
      ExpoCallKitModule._shared_setUUID(nil, forCallId: callId)
      print("[ExpoCallKit] endCallActionWithReason \(callId) reason=\(reasonRaw)")
      // [WAVE 116 2026-05-21] Issue 4 — purge pending LK token.
      ExpoCallKitModule.clearPendingLkToken(callId: callId)
      safeSendEvent("onCallEnded", ["callId": callId, "reason": reasonRaw])
    } else {
      // [WAVE 116 followup, 2026-05-21] Unknown callId in activeCalls. Try the
      // shared static mirror + CXCallObserver before falling back to a UI-only
      // dismiss — otherwise the system call bar / lock-screen pill stays.
      let fallbackUUID = ExpoCallKitModule.sharedCallKitUUID(forCallId: callId)
      let observed = CXCallObserver().calls.filter { !$0.hasEnded }
      var anyReported = false
      if let provider = self.provider {
        if let uuid = fallbackUUID {
          provider.reportCall(with: uuid, endedAt: Date(), reason: mapped)
          anyReported = true
          print("[ExpoCallKit] endCallActionWithReason: reportCall on shared-mirror uuid=\(uuid.uuidString) reason=\(reasonRaw)")
        }
        for cxCall in observed where cxCall.uuid != fallbackUUID {
          provider.reportCall(with: cxCall.uuid, endedAt: Date(), reason: mapped)
          anyReported = true
          print("[ExpoCallKit] endCallActionWithReason: reportCall on observed uuid=\(cxCall.uuid.uuidString) reason=\(reasonRaw)")
        }
      }
      if !anyReported {
        print("[ExpoCallKit] endCallActionWithReason: no UUID for \(callId) — direct dismiss")
      }
      DispatchQueue.main.async {
        ProviderDelegate.dismissActiveCallSurfaces(reason: "endCall_reason_no_uuid")
        AudioRouter.shared.teardown()
      }
      ExpoCallKitModule._shared_setUUID(nil, forCallId: callId)
      ExpoCallKitModule.clearPendingLkToken(callId: callId)
      // JS expects the onCallEnded event even when we couldn't find a UUID —
      // without it, /call.web.js never unmounts on the no-UUID path.
      safeSendEvent("onCallEnded", ["callId": callId, "reason": reasonRaw])
    }
  }

  /// Maps a JS-side reason string to CXCallEndedReason. Unknown values fall
  /// back to .failed so legacy callers don't crash if they typo.
  static func mapEndedReason(_ raw: String) -> CXCallEndedReason {
    switch raw {
    case "unanswered":         return .unanswered
    case "declinedElsewhere":  return .declinedElsewhere
    case "answeredElsewhere":  return .answeredElsewhere
    case "remoteEnded":        return .remoteEnded
    default:                   return .failed
    }
  }

  /// Called when CallKit completely resets (system restart, etc).
  /// Wipe our bookkeeping so we don't leak ghost calls.
  func handleProviderReset() {
    print("[ExpoCallKit] Provider reset — clearing all active calls")
    let toEnd: [String] = safeStateSync {
      let ids = Array(activeCalls.keys)
      activeCalls.removeAll()
      callPayloads.removeAll()
      return ids
    }
    for callId in toEnd {
      safeSendEvent("onCallEnded", ["callId": callId])
    }
  }

  func voipTokenReceived(token: String) {
    print("[ExpoCallKit] VoIP token received: \(token.prefix(8))...")
    safeSendEvent("onVoipTokenReceived", ["token": token])
  }

  func notifyAudioActivated() {
    safeSendEvent("onCallKitAudioActivated", [:])
  }

  func notifyAudioDeactivated() {
    safeSendEvent("onCallKitAudioDeactivated", [:])
  }
}

// MARK: - CXProvider Delegate
private class ProviderDelegate: NSObject, CXProviderDelegate {
  weak var module: ExpoCallKitModule?

  // [WAVE 147 2026-05-22 DOUBLE-PRESENT GUARD]
  // Tracks callIds for which CallViewController has been successfully
  // presented. presentOutgoingCallVC checks this set as its first guard
  // — if a callId is already presented, subsequent presents (e.g. from
  // CXStartCallAction handler firing AFTER WAVE 145's immediate present)
  // short-circuit silently.
  //
  // Lifecycle:
  // - INSERT: _actuallyPresentOutgoing completion block (after UIKit
  //   accepts and vc.view.window is non-nil — proves real attachment).
  // - REMOVE: CXEndCallAction handler (call ends naturally) AND in
  //   CallViewController.deinit via NotificationCenter (force-dismiss
  //   or memory pressure dismissal).
  // - ALWAYS accessed on main thread (UIKit invariant).
  fileprivate static var _activePresentedCallIds = Set<String>()

  init(module: ExpoCallKitModule) {
    self.module = module
    super.init()
  }

  func providerDidReset(_ provider: CXProvider) {
    // Called when CallKit forgets all calls (e.g. system reset). End any
    // active call state in our own bookkeeping so we don't leak.
    module?.handleProviderReset()
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    // Apple guidance (WhatsApp/Telegram pattern): in CXAnswerCallAction we
    // ONLY configure the audio category and call fulfill(). DO NOT call
    // setActive(true) here — during cold-start from a VoIP push, the audio
    // session is owned by iOS and setActive will fail with kAudioSessionNotActive.
    // CallKit then aborts the answer, fires CXEndCallAction, and the user sees
    // "Chamada falhou". The session is activated automatically by the system
    // via `provider:didActivate audioSession:` AFTER action.fulfill() returns
    // — that handler (already implemented below) is where the actual
    // activation happens. This is the "answer fails on cold start" bug.
    // [STAGE-A 2026-05-20] GAP #4 — setCategory/setMode DELETED. The single
    // owner is AudioRouter.configureForCall(hasVideo:) invoked from
    // provider:didActivate audioSession:. Calling setCategory here races
    // CallKit's own ownership and forced earpiece even for video calls.
    // [native call screen day-3 finale, 2026-05-16] Fire the JS event AND
    // call action.fulfill() FIRST. Then, on a separate Task, fetch (or read
    // cached) the LiveKit token + present CallViewController directly. This
    // collapses the old accept→JS→router.push→Room.connect chain (4-8s) into
    // accept→present→Room.connect (<500ms). JS still gets onCallAnswered so
    // its WS notify path runs; the JS router.push('/call') becomes a no-op
    // because CallViewController is already on screen above it.
    module?.callAnswered(uuid: action.callUUID)
    action.fulfill()

    // Snapshot what we know about the call from the stashed payload BEFORE
    // dispatching async work. callAnswered() above already removed the
    // payload from the in-memory dictionary, so we look up the callId via
    // the UUID→callId reverse map and re-derive caller info from any push
    // copy still available in the App Group queue. Worst case, we degrade
    // to placeholder strings — the room name only needs to be the callId.
    let actionUUID = action.callUUID
    let callId = module?.callIdForUUID(actionUUID) ?? actionUUID.uuidString
    let snapshot = Self.collectAnswerSnapshot(callId: callId, uuid: actionUUID)

    // [2026-05-16 Stage 2 native WS signaling] Fire call_answered from
    // native immediately after CallKit hands us the answer action. This
    // races the JS-side services/api.js call_answered fire that happens
    // when JS receives the onCallAnswered event from callAnswered() above
    // — server dedupes by call_id so the duplicate is safe. Native fires
    // ~ms after CallKit answer, well before the JS bundle would parse
    // the bridge event. Empty conversationId is tolerated (dialer flow).
    if !callId.isEmpty {
      // [2026-05-24] Pass caller_email so the WS relay can find the
      // caller's channel — root cause of iOS-stuck-on-"Chamando".
      CallSignalWs.shared.fireCallAnswered(
        callId: callId,
        conversationId: snapshot.conversationId,
        callerEmail: snapshot.callerEmail
      )
    }

    // Identity for the LiveKit token request. Backend ignores this today
    // (it uses the authenticated session email) but we prefer the
    // App-Group-persisted `user_email` so logs match the real user.
    let identity: String = {
      if let ud = UserDefaults(suiteName: kAppGroupId),
         let e = ud.string(forKey: "user_email"), !e.isEmpty { return e }
      return callId
    }()

    // [STAGE-A 2026-05-21] If NativeCallRoom already kicked off a Room.connect
    // during the ring window (push receive path optimistically pre-connects),
    // we can skip the LK token fetch entirely and just present the
    // CallViewController. The VC's adopt path will bind to the live Room via
    // NativeCallRoom.currentRoom() / attachDelegate() and not re-connect.
    if NativeCallRoom.shared.isPreconnected(callId: callId) {
      print("[ExpoCallKit] Answer: Room preconnected for \(callId) — skipping token fetch")
      DispatchQueue.main.async {
        Self.presentNativeCallVC(callId: callId,
                                 callerName: snapshot.callerName,
                                 callerEmail: snapshot.callerEmail,
                                 hasVideo: snapshot.hasVideo,
                                 lkUrl: "",
                                 lkToken: "",
                                 conversationId: snapshot.conversationId)
      }
      return
    }

    // First try the App Group LK token cache (populated by JS-side
    // `persistPendingLkToken` whenever a chat_livekit_token mint round-trips
    // through JS before the push lands). If the cache misses, fetch via
    // NativeCallTokenFetcher.
    let cachedToken: (token: String, url: String)? = {
      guard let ud = UserDefaults(suiteName: kAppGroupId),
            let t = ud.string(forKey: "lk_token_\(callId)"), !t.isEmpty,
            let u = ud.string(forKey: "lk_url_\(callId)"), !u.isEmpty
      else { return nil }
      return (t, u)
    }()

    if let cached = cachedToken {
      print("[ExpoCallKit] Answer: using cached LK token for \(callId)")
      DispatchQueue.main.async {
        Self.presentNativeCallVC(callId: callId,
                                 callerName: snapshot.callerName,
                                 callerEmail: snapshot.callerEmail,
                                 hasVideo: snapshot.hasVideo,
                                 lkUrl: cached.url,
                                 lkToken: cached.token,
                                 conversationId: snapshot.conversationId)
      }
      return
    }

    // Capture a weak ref to the module so the failure path can route through
    // endCallActionWithReason — `Task.detached` otherwise can't reach `self`
    // safely under Swift 6 strict concurrency.
    weak var moduleRef = self.module
    Task.detached(priority: .userInitiated) {
      var lastError: Error?
      var result: NativeCallTokenFetcher.TokenResult?
      for attempt in 1...4 {
        do {
          result = try await NativeCallTokenFetcher.shared.fetchToken(
            roomName: callId,
            identity: identity,
            role: "publisher"
          )
          break
        } catch {
          lastError = error
          NSLog("[ExpoCallKit] Token fetch attempt \(attempt)/4 failed: \(error)")
          if attempt < 4 {
            try? await Task.sleep(nanoseconds: UInt64(attempt) * 800_000_000)
          }
        }
      }
      if let result = result {
        await MainActor.run {
          Self.presentNativeCallVC(callId: callId,
                                   callerName: snapshot.callerName,
                                   callerEmail: snapshot.callerEmail,
                                   hasVideo: snapshot.hasVideo,
                                   lkUrl: result.url,
                                   lkToken: result.token,
                                   conversationId: snapshot.conversationId)
        }
      } else {
        print("[ExpoCallKit] LK token fetch failed after 4 attempts: \(lastError ?? NSError()) — ending call")
        await MainActor.run {
          moduleRef?.endCallActionWithReason(callId: callId, reasonRaw: "failed")
        }
      }
    }
  }

  /// Collect caller_name / caller_email / hasVideo / conversationId for
  /// the answer-time CallViewController presentation. Looks at the App
  /// Group pending-call queue (which AppDelegateSubscriber writes on every
  /// VoIP push) since `callPayloads` in-memory was already drained by
  /// callAnswered(). conversationId is best-effort: empty string when the
  /// push didn't carry one (dialer-style calls).
  fileprivate static func collectAnswerSnapshot(callId: String, uuid: UUID) -> (callerName: String, callerEmail: String, hasVideo: Bool, conversationId: String) {
    var callerName = ""
    var callerEmail = ""
    var hasVideo = false
    var conversationId = ""
    if let ud = UserDefaults(suiteName: kAppGroupId),
       let queue = ud.array(forKey: kPendingCallKey) as? [[String: Any]] {
      for entry in queue {
        let entryId = entry["callId"] as? String
        let entryUuid = entry["uuid"] as? String
        if entryId == callId || entryUuid == uuid.uuidString {
          callerName = (entry["callerName"] as? String) ?? ""
          if let p = entry["payload"] as? [String: Any] {
            callerEmail = (p["caller_email"] as? String) ?? ""
            if let v = p["video"] as? String { hasVideo = (v == "1") }
            else if let b = p["video"] as? Bool { hasVideo = b }
            else if let t = p["call_type"] as? String { hasVideo = (t == "video") }
            if callerName.isEmpty { callerName = (p["caller_name"] as? String) ?? "" }
            // [2026-05-16 Stage 2] Surface conversation_id for the native
            // call_answered WS fire. May be missing on dialer-style pushes.
            conversationId = (p["conversation_id"] as? String) ?? ""
          }
          break
        }
      }
    }
    if callerName.isEmpty { callerName = "Chatyy" }
    return (callerName, callerEmail, hasVideo, conversationId)
  }

  /// Walk the connectedScenes to find the key window's rootViewController and
  /// hand off to CallViewController.present. Must run on the main thread —
  /// callers (Task continuation, etc.) wrap us in MainActor.run.
  fileprivate static func presentNativeCallVC(callId: String,
                                              callerName: String,
                                              callerEmail: String,
                                              hasVideo: Bool,
                                              lkUrl: String,
                                              lkToken: String,
                                              conversationId: String = "") {
    // [#1171 redux dismiss, 2026-05-19] If the call was ended (user hung up
    // from the CallKit ring sheet, peer cancelled via WS call_end, network
    // dropped, or the CX action timed out) DURING the LK token fetch window,
    // `activeCalls`/`sharedUUIDByCallId` no longer carry the UUID. Without
    // this guard we present a CallViewController for an already-dead call and
    // the user is stranded staring at "Conectando…" — exactly the recurring
    // task #1171 complaint. The state cleanup in callEnded / endCallAction
    // already happened on the main thread synchronously, so this check is
    // race-free vs. the present that is also on main.
    guard ExpoCallKitModule.isCallStillActive(callId: callId) else {
      print("[ExpoCallKit] presentNativeCallVC: call \(callId) already ended — skipping stale present")
      return
    }
    // [#1172 fix, 2026-05-18] resolvePresentingViewController is robust to
    // backgrounded scenes + CallKit ring-sheet contention; the old
    // keyWindow-first chain silently bailed when the app was cold-starting
    // from a VoIP push and the user had not yet returned to foreground.
    // [#1192 cold-start fix, 2026-05-19] If the immediate lookup misses
    // (rootVC not yet attached during cold-start from VoIP push), retry
    // up to ~3s waiting for RN bootstrap to attach the rootVC.
    let presentBlock: (UIViewController) -> Void = { root in
      // [2026-05-16 Stage 2] isOutgoing stays false for the CXAnswer path —
      // we're presenting because the callee just answered, NOT because they
      // initiated. The native call_answered fire happens up in the CXAnswer
      // handler; we just need conversationId here so CallViewController's
      // hangup path can fire call_end with the correct (call_id, conv_id).
      // Re-check active state under retry — the call may have been ended by
      // peer / network / hangup during the wait window.
      guard ExpoCallKitModule.isCallStillActive(callId: callId) else {
        print("[ExpoCallKit] presentNativeCallVC(retry): call \(callId) ended during wait — abort")
        return
      }
      CallViewController.present(
        from: root,
        callId: callId,
        callerName: callerName,
        callerEmail: callerEmail,
        hasVideo: hasVideo,
        lkUrl: lkUrl,
        lkToken: lkToken,
        isOutgoing: false,
        conversationId: conversationId
      )
    }
    if let root = resolvePresentingViewController() {
      presentBlock(root)
    } else {
      print("[ExpoCallKit] presentNativeCallVC: no presenting VC yet (cold-start) — retrying")
      retryPresent(reason: "presentNativeCallVC:\(callId)", block: presentBlock)
    }
  }

  // [Stage #996 outgoing native flow, 2026-05-17] CXStartCallAction is the
  // canonical way to tell CallKit "we're starting an outgoing call". Without
  // it, iOS won't show the call in Recents, won't surface a lock-screen UI,
  // and the audio session ownership lifecycle is uneven. We pop the params
  // stashed by startOutgoingCall(), report startedConnecting, fetch (or
  // accept the pre-minted) LK token, then present CallViewController with
  // isOutgoing=true — CallViewController already fires call_invite via
  // CallSignalWs and plays the ringback engine.
  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    let uuid = action.callUUID
    guard let module = self.module,
          let params = module.consumeOutgoingCallParams(uuid: uuid) else {
      print("[ExpoCallKit] CXStartCallAction: no pending params for uuid=\(uuid.uuidString), failing")
      action.fail()
      return
    }
    print("[ExpoCallKit] CXStartCallAction: callId=\(params.callId) callee=\(params.calleeEmail) video=\(params.isVideo)")
    // Mark startedConnecting so the system shows "Calling …" status. Apple
    // wants this BEFORE we ship the SIP/WS invite — it covers the brief
    // window between "user tapped call" and "callee phone is ringing".
    provider.reportOutgoingCall(with: uuid, startedConnectingAt: nil)

    // Configure audio category up front. Same pattern as CXAnswerCallAction —
    // don't activate the session, just set the category. CallKit will
    // activate via provider:didActivate audioSession: once the system is
    // ready.
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(
        .playAndRecord, mode: .voiceChat,
        options: [.allowBluetoothA2DP, .allowBluetoothHFP]
      )
    } catch {
      print("[ExpoCallKit] CXStartCallAction: audio category set failed (non-fatal): \(error)")
    }

    // [Stage #996] Native WS invite fires from CallViewController.viewDidLoad
    // when isOutgoing=true — we do NOT fire here to avoid double-shipping
    // (server dedupes by call_id anyway, but cleaner to keep one fire path).

    let identity: String = {
      if let ud = UserDefaults(suiteName: kAppGroupId),
         let e = ud.string(forKey: "user_email"), !e.isEmpty { return e }
      return params.callId
    }()

    // If JS already minted a token (warm path — services/api.js called
    // chat_livekit_token before invoking startOutgoingCall), use it directly.
    if let url = params.lkUrl, let token = params.lkToken,
       !url.isEmpty, !token.isEmpty {
      print("[ExpoCallKit] CXStartCallAction: using JS-supplied LK token for \(params.callId)")
      DispatchQueue.main.async {
        Self.presentOutgoingCallVC(params: params, lkUrl: url, lkToken: token)
      }
      action.fulfill()
      return
    }

    // Otherwise fetch via NativeCallTokenFetcher. Fulfill the action FIRST so
    // CallKit doesn't time us out — token fetch may take 200-500ms on a cold
    // network and Apple's CX deadline is generous but not infinite. The VC
    // present runs once the token resolves.
    action.fulfill()
    Task.detached(priority: .userInitiated) {
      do {
        let result = try await NativeCallTokenFetcher.shared.fetchToken(
          roomName: params.roomName,
          identity: identity,
          role: "publisher"
        )
        await MainActor.run {
          Self.presentOutgoingCallVC(params: params, lkUrl: result.url, lkToken: result.token)
        }
      } catch {
        print("[ExpoCallKit] CXStartCallAction: LK token fetch failed: \(error). Presenting VC without token (JS fallback may take over).")
        await MainActor.run {
          Self.presentOutgoingCallVC(params: params, lkUrl: nil, lkToken: nil)
        }
      }
    }
  }

  /// Push the CallViewController for an outgoing call. Mirrors
  /// presentNativeCallVC (used by the answer path) but flips isOutgoing=true
  /// so the VC's viewDidLoad fires call_invite via CallSignalWs and starts
  /// the ringback engine. callerName here is the *callee*'s display name
  /// from the JS side — that's the name the SwiftUI screen shows during
  /// "Calling …".
  fileprivate static func presentOutgoingCallVC(
    params: ExpoCallKitModule.OutgoingCallParams,
    lkUrl: String?,
    lkToken: String?
  ) {
    // [WAVE 144 2026-05-22] DEAD-GATE REMOVAL. #1208 was reverted in #1217
    // (full native, retire JS /call.js mobile) and the caller now ALWAYS
    // passes suppressVCPresent=false (line ~938). User report 2026-05-22:
    // "página não tá abrindo dentro do app — UI conectada direto com o
    // nativo". Even with the call-site hardcoded false, leaving the gate
    // here means any edge path that constructs OutgoingCallParams with
    // suppressVCPresent=true (legacy push payload, JS-set field) silently
    // kills the WhatsApp-style rich UI. Kill the gate entirely so the
    // native CallView ALWAYS presents on outgoing — no escape hatch.
    NSLog("[CallTrace][PRESENT-1] presentOutgoingCallVC ENTRY callId=\(params.callId) hasUrl=\(lkUrl != nil) hasToken=\(lkToken != nil) thread=\(Thread.isMainThread ? "main" : "bg")")

    // [WAVE 147 2026-05-22 DOUBLE-PRESENT GUARD — ROOT CAUSE FIX]
    // Deep audit identified: WAVE 145 added immediate present in
    // AsyncFunction("startOutgoingCall") body, BUT did NOT remove the
    // existing presentOutgoingCallVC calls in CXStartCallAction handler
    // (lines ~2433, ~2452, ~2457). Both code paths fire unconditionally
    // — first WAVE 145 (~0ms after JS call), then CXStartCallAction
    // (~200-500ms later). UIKit silently rejects the second present
    // with "Attempt to present X on Y which is already presenting Z"
    // → the rich SwiftUI CallView never renders (either clobbered or
    // never reaches the window).
    //
    // Fix: short-circuit if a CallVC is ALREADY presented for this callId.
    // _activePresentedCallIds is mutated on _actuallyPresentOutgoing
    // completion (after window attachment confirmed) and cleared in
    // CXEndCallAction. Static Set<String> is thread-safe via main-thread
    // dispatch convention (all callers wrap in DispatchQueue.main.async).
    if Self._activePresentedCallIds.contains(params.callId) {
      NSLog("[CallTrace][PRESENT-1B-SKIP] WAVE 147: CallVC already presented for callId=\(params.callId) — skipping duplicate present (double-present collision avoided)")
      return
    }

    // [WAVE 146 2026-05-22] Defensive main-thread guard. UIKit `present(_:)`
    // MUST run on main; warm-path callsite uses DispatchQueue.main.async but
    // we double-guard here in case a future callsite forgets.
    if !Thread.isMainThread {
      DispatchQueue.main.async {
        Self.presentOutgoingCallVC(params: params, lkUrl: lkUrl, lkToken: lkToken)
      }
      return
    }

    guard ExpoCallKitModule.isCallStillActive(callId: params.callId) else {
      NSLog("[CallTrace][PRESENT-2-ABORT] callId=\(params.callId) ended (isCallStillActive=false) — UI WILL NOT APPEAR")
      return
    }
    let callId = params.callId
    let presentBlock: (UIViewController) -> Void = { root in
      guard ExpoCallKitModule.isCallStillActive(callId: callId) else {
        NSLog("[CallTrace][PRESENT-3-ABORT] callId=\(callId) ended during retry wait")
        return
      }
      NSLog("[CallTrace][PRESENT-4] resolved root=\(type(of: root)) presented=\(root.presentedViewController.map { String(describing: type(of: $0)) } ?? "nil")")

      // [WAVE 146] Walk to top — BUT if top is mid-transition / an unrelated
      // sheet/modal (image picker, contact details, etc.), dismiss it forcibly
      // so we can present the CallVC over the scene root. User intent =
      // "show CallView NOW".
      var top: UIViewController = root
      while let p = top.presentedViewController, !p.isBeingDismissed {
        top = p
      }
      if top !== root && !(top is CallViewController) {
        NSLog("[CallTrace][PRESENT-5] dismissing stale top=\(type(of: top)) before presenting CallVC")
        top.dismiss(animated: false) {
          Self._actuallyPresentOutgoing(from: root, params: params, lkUrl: lkUrl, lkToken: lkToken, callId: callId)
        }
        return
      }
      Self._actuallyPresentOutgoing(from: top, params: params, lkUrl: lkUrl, lkToken: lkToken, callId: callId)
    }
    if let root = resolvePresentingViewController() {
      presentBlock(root)
    } else {
      NSLog("[CallTrace][PRESENT-6] no root VC yet — retrying for cold-start")
      retryPresent(reason: "presentOutgoingCallVC:\(callId)", block: presentBlock)
    }
  }

  // [WAVE 146 2026-05-22] Final present helper — guaranteed main-thread,
  // .fullScreen re-asserted, completion handler logs UIKit accept/reject.
  // Splits out the actual UIKit call so the stale-modal dismiss path above
  // can reuse it without duplicating logic.
  fileprivate static func _actuallyPresentOutgoing(
    from presenter: UIViewController,
    params: ExpoCallKitModule.OutgoingCallParams,
    lkUrl: String?, lkToken: String?,
    callId: String
  ) {
    let vc = CallViewController(
      callId: callId,
      callerName: params.calleeName,
      callerEmail: params.calleeEmail,
      hasVideo: params.isVideo,
      lkUrl: lkUrl,
      lkToken: lkToken,
      isOutgoing: true,
      conversationId: params.conversationId
    )
    vc.modalPresentationStyle = UIModalPresentationStyle.fullScreen  // belt + suspenders (init also sets)
    vc.isModalInPresentation = true
    NSLog("[CallTrace][PRESENT-7] calling present from=\(type(of: presenter)) callId=\(callId)")
    presenter.present(vc, animated: true) {
      let attached = vc.view.window != nil
      NSLog("[CallTrace][PRESENT-8-DONE] CallViewController.present completion fired callId=\(callId) window=\(attached)")
      // [WAVE 147] Only mark presented when window-attached. If UIKit silently
      // dropped the present (attached=false), keep the slot empty so a retry
      // (e.g. CXStartCallAction-driven path) can still try. If attached=true,
      // any further present for this callId becomes a no-op via PRESENT-1B-SKIP.
      if attached {
        ProviderDelegate._activePresentedCallIds.insert(callId)
        NSLog("[CallTrace][PRESENT-9] WAVE 147 marked callId=\(callId) as actively presented — future duplicates will skip")
      }
    }
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    // [2026-05-21] Purge App Group side-channel state for this callId BEFORE
    // calling callEnded() drops the UUID → callId reverse map. Without this
    // cleanup, callAvatar:<cid> / lk_token_<cid> / lk_url_<cid> entries leak
    // forever and a future call with a colliding callId (unlikely but
    // possible on cold-start ID generation collisions) would reuse stale data.
    if let cid = self.module?.callIdForUUID(action.callUUID),
       let ud = UserDefaults(suiteName: kAppGroupId) {
      ud.removeObject(forKey: "callAvatar:\(cid)")
      ud.removeObject(forKey: "lk_token_\(cid)")
      ud.removeObject(forKey: "lk_url_\(cid)")
      // [WAVE 147] Clear duplicate-present guard so a subsequent call with the
      // same callId (rare but possible on retry) can present cleanly.
      DispatchQueue.main.async {
        ProviderDelegate._activePresentedCallIds.remove(cid)
        NSLog("[CallTrace][PRESENT-CLEAR] WAVE 147 removed callId=\(cid) from active presented set on CXEndCallAction")
        // [WAVE 149] Tear down the dedicated call UIWindow so the user
        // returns to the normal app UI after End. Idempotent — no-op if
        // not currently showing.
        CallWindowManager.shared.hideCallUI(callId: cid)
      }
    }
    // [WAVE 142 GPT-5.5-pro] Snippet 15 — notify shared observer so SwiftUI
    // status flips to "Encerrada" (and the duration timer stops) without
    // waiting on the existing onCallEnded round trip. Also emit a tagged
    // event so JS analytics can disambiguate CallKit-originated hangups
    // from JS-driven ones (the latter go through endCall → endCallAction).
    CallSessionObserver.shared.markEnded(uuid: action.callUUID)
    let callIdForEnd = module?.callIdForUUID(action.callUUID) ?? action.callUUID.uuidString
    module?.safeSendEvent("onCallEnded", [
      "uuid": action.callUUID.uuidString,
      "callId": callIdForEnd,
      "source": "callkit"
    ])
    module?.callEnded(uuid: action.callUUID)
    // [#1179 cleanup, 2026-05-19] Dismiss the presented native call UI.
    // CXEndCallAction can be triggered three ways:
    //   1. User taps the SwiftUI red hangup → CallViewController.handleHangup
    //      which already calls `dismiss(animated:)` directly. The dispatch
    //      below is a no-op in that path (the VC is already in dismissal).
    //   2. JS calls `ExpoCallKit.endCall(callId)` (hybrid path — user taps
    //      the JS /call red button) → endCallAction → CXEndCallAction → here.
    //      Before this fix, the SwiftUI call screen (CallViewController as a
    //      .fullScreen modal) was NEVER dismissed because handleHangup never
    //      ran. User saw "/call" pop off the stack, but the native modal
    //      stayed on top — exactly the "nativo fica aberto" complaint.
    //   3. CallKit system UI red button on the lock screen / Recents.
    //      Same issue as (2) — JS handles onCallEnded but native modal stays.
    // Find the topmost presented VC and, if it's our call surface, dismiss.
    // Idempotent: dismiss-while-already-dismissing is a UIKit no-op.
    DispatchQueue.main.async {
      ProviderDelegate.dismissActiveCallSurfaces(reason: "cx_end_call_action")
    }
    // [bug 2026-05-15 #12] Do NOT manually setActive(false) here.
    // CallKit fires didDeactivate automatically after action.fulfill();
    // calling setActive ourselves races with WebRTC engine teardown and
    // the system's deactivation flow, which on some devices caused a
    // brief audio glitch when ending a call back-to-back. Let CallKit
    // own the deactivation lifecycle.
    action.fulfill()
  }

  /// [#1179 cleanup, 2026-05-19] Walk the presented-VC stack and dismiss any
  /// of our call surfaces (CallViewController / GroupCallViewController /
  /// LiveBroadcastViewController / LiveViewerViewController). Called from
  /// CXEndCallAction and from the WS-driven `ExpoCallKitNativeCallEnded`
  /// observer so both "I hung up" and "peer hung up" paths converge on a
  /// single dismissal helper.
  ///
  /// We introspect by class-name string instead of importing each class so
  /// this stays a private extension to ProviderDelegate without forcing
  /// CallViewController.swift / GroupCallViewController.swift edits (Wave B/C
  /// is in restored state — see commit 2026-05-19).
  static func dismissActiveCallSurfaces(reason: String) {
    guard let root = resolvePresentingViewController() else {
      print("[ProviderDelegate] dismissActiveCallSurfaces(\(reason)): no presenting VC")
      return
    }
    // Walk down to the topmost presented VC and back up, dismissing each
    // call-surface VC we find. Most cases only have one of our VCs
    // presented at a time, but we walk the whole stack to be safe (e.g.
    // CallViewController.handleAddMember could push a child VC).
    var stack: [UIViewController] = []
    var cur: UIViewController? = root
    while let v = cur {
      stack.append(v)
      cur = v.presentedViewController
    }
    // Dismiss from the top so each parent's presented chain remains valid.
    for vc in stack.reversed() {
      let name = String(describing: type(of: vc))
      if name == "CallViewController"
        || name == "GroupCallViewController"
        || name == "LiveBroadcastViewController"
        || name == "LiveViewerViewController"
      {
        print("[ProviderDelegate] dismissActiveCallSurfaces(\(reason)): dismissing \(name)")
        vc.dismiss(animated: true, completion: nil)
      }
    }
  }

  /// [Wave WhatsApp parity, 2026-05-20 gap B3 iOS] CXSetMutedCallAction —
  /// fires when the user taps the system call-bar mute button. We forward
  /// to the same NotificationCenter channel applyMicEnabled posts on, so
  /// CallViewController picks it up and goes through the fast-path
  /// (track.mute() / unmute()) without re-publishing the RTC sender.
  /// JS analytics still see onLkLocalAudioChanged via the observer in
  /// installNativeCallEndedObserver. Without this handler, CXSetMutedCallAction
  /// raced the in-call SwiftUI mute button — both fired setMicrophone on
  /// the LK Room and the AVAudioSession ended up out of sync.
  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    let muted = action.isMuted
    let actionUuid = action.callUUID
    let callIdForEvent = module?.callIdForUUID(actionUuid) ?? actionUuid.uuidString
    print("[ExpoCallKit] CXSetMutedCallAction \(muted ? "mute" : "unmute") callId=\(callIdForEvent)")
    // Post the same notification the SwiftUI toggle uses. CallViewController
    // owns the LK Room and applies the track.mute()/unmute() fast-path; it
    // also re-broadcasts ExpoCallKitLkLocalAudioChanged after the LK call
    // settles, which the module observer turns into onLkLocalAudioChanged.
    NotificationCenter.default.post(
      name: Notification.Name("ExpoCallKitLkLocalAudioChanged"),
      object: nil,
      userInfo: ["enabled": !muted]
    )
    // CallViewController also listens to a parallel notification so the
    // session.micEnabled @Published flag updates without round-tripping
    // through JS first. Send both to be safe (idempotent).
    NotificationCenter.default.post(
      name: Notification.Name("ExpoCallKitSystemMuteChanged"),
      object: nil,
      userInfo: ["muted": muted, "callId": callIdForEvent]
    )
    // [WAVE 142 GPT-5.5-pro] Snippet 15 — mirror into the shared observer so
    // the SwiftUI `@ObservedObject callKit` instantly reflects the system
    // mute. Also surface an `onMuteChanged` JS event so JS-side UI (the
    // hybrid /call.js layer) stays in sync without re-deriving from the
    // existing onLkLocalAudioChanged event.
    CallSessionObserver.shared.setMutedFromProvider(uuid: actionUuid, muted: muted)
    module?.safeSendEvent("onMuteChanged", [
      "uuid": actionUuid.uuidString,
      "callId": callIdForEvent,
      "isMuted": muted
    ])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    let session = AVAudioSession.sharedInstance()
    // Look up the original server-side call_id from the CallKit UUID. JS
    // listeners key everything by call_id; emitting only the UUID broke
    // hold/resume mapping (state desync between CallKit and JS).
    let actionUuid = action.callUUID
    let callIdForEvent = module?.callIdForUUID(actionUuid) ?? actionUuid.uuidString
    if action.isOnHold {
      // Call placed on hold — deactivate audio so other apps can use it
      do {
        try session.setActive(false, options: [.notifyOthersOnDeactivation])
      } catch {
        print("[ExpoCallKit] Hold audio deactivation failed: \(error)")
      }
      module?.safeSendEvent("onCallEnded", ["callId": callIdForEvent, "held": true])
    } else {
      // Call resumed from hold — reactivate audio
      do {
        // [bug 2026-05-15 #10] aligned BT options with didActivate.
        try session.setCategory(
          .playAndRecord, mode: .voiceChat,
          options: [.allowBluetoothA2DP, .allowBluetoothHFP]
        )
        try session.setActive(true)
        try session.overrideOutputAudioPort(.none)
      } catch {
        print("[ExpoCallKit] Resume audio activation failed: \(error)")
        action.fail()
        return
      }
      module?.safeSendEvent("onCallAnswered", ["callId": callIdForEvent, "resumed": true])
    }
    action.fulfill()
  }

  /// [DTMF, 2026-05-19] CXPlayDTMFCallAction — fires when the user taps a
  /// digit on the CallKit system call bar's built-in keypad (visible because
  /// we set `update.supportsDTMF = true`). The action carries `digits`
  /// (typically 1 char; CallKit batches paste-of-multiple via the
  /// `type` discriminator). We forward each character through the same
  /// NotificationCenter channel the SwiftUI overlay uses, so the LK Room
  /// publishes the data frame regardless of which UI fired the action.
  func provider(_ provider: CXProvider, perform action: CXPlayDTMFCallAction) {
    let digits = action.digits
    for ch in digits {
      NotificationCenter.default.post(
        name: Notification.Name("ExpoCallKitPlayDTMF"),
        object: nil,
        userInfo: ["digit": String(ch)]
      )
    }
    action.fulfill()
  }

  /// CRITICAL: Apple expects this callback within ~30s of any CXAction. If
  /// missing, the call hangs in "ringing" state and Apple throttles future
  /// VoIP pushes. WhatsApp implements this. We were missing it — that's the
  /// "stuck ringing" bug.
  func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
    print("[ExpoCallKit] Action timed out: \(type(of: action))")
    if let answer = action as? CXAnswerCallAction {
      module?.endCall(callUUID: answer.callUUID, reason: .unanswered)
    } else if let end = action as? CXEndCallAction {
      module?.endCall(callUUID: end.callUUID, reason: .failed)
    }
    action.fail()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    print("[ExpoCallKit] Audio session activated — configuring for VoIP")
    // [STAGE-A 2026-05-20] GAP #4 — Single owner for AVAudioSession config.
    // AudioRouter.configureForCall sets .playAndRecord + .voiceChat + the BT
    // / duckOthers options + the initial route override. CallKit already
    // activated the session for us. We default to hasVideo=false (earpiece)
    // here — if the call is actually video, CallViewController.viewDidLoad
    // will call configureForCall(hasVideo:true) seconds later which
    // idempotently overrides to speaker. WhatsApp pattern: ring-time audio
    // never blasts the speaker.
    AudioRouter.shared.configureForCall(hasVideo: false)
    do {
      try audioSession.setActive(true, options: [])
    } catch {
      print("[ExpoCallKit] STAGE-A: setActive(true) post-router failed: \(error)")
    }
    // [bug 2026-05-14 uplink-mic-silent] When user accepts via native CallKit
    // UI, AVAudioSession.didActivate fires BEFORE JS creates the
    // RTCPeerConnection (cold-start path: onCallAnswered → router.push → JS
    // mount → getUserMedia, can take 1-2s on slower devices). The WebRTC
    // C++ engine inspects RTCAudioSession state at addTrack time — if it
    // didn't observe a setActive(true) signal from the CallKit-owned
    // session, the audio unit (VPIO) is configured WITHOUT mic input,
    // hence "I hear them but they don't hear me". Manually signal the
    // react-native-webrtc audio session that the CallKit session is now
    // active so when JS later runs addTrack, the input is properly wired.
    // This is the WhatsApp/Telegram pattern — they piggyback on didActivate
    // to push the audio session state down into their audio engine.
    let RTCAudioSessionClass: AnyClass? = NSClassFromString("RTCAudioSession")
    if let cls = RTCAudioSessionClass {
      let sel = NSSelectorFromString("sharedInstance")
      if (cls as AnyObject).responds(to: sel) {
        let rtcSessionUnmanaged = (cls as AnyObject).perform(sel)
        if let rtcSession = rtcSessionUnmanaged?.takeUnretainedValue() as? NSObject {
          // -[RTCAudioSession audioSessionDidActivate:] takes AVAudioSession
          let activateSel = NSSelectorFromString("audioSessionDidActivate:")
          if rtcSession.responds(to: activateSel) {
            rtcSession.perform(activateSel, with: audioSession)
            print("[ExpoCallKit] RTCAudioSession.audioSessionDidActivate forwarded")
          }
          // Mark isActive=YES so addTrack-time inspection picks up active state
          let setActiveSel = NSSelectorFromString("setIsActive:")
          if rtcSession.responds(to: setActiveSel) {
            rtcSession.perform(setActiveSel, with: NSNumber(value: true))
          }
          // [bug 2026-05-15 #11] Flip manual-audio gate ON so WebRTC engine
          // can finally start VPIO. AppDelegate sets useManualAudio=true and
          // isAudioEnabled=false at launch; CallKit didActivate is the
          // canonical place to flip it true.
          let setEnabledSel = NSSelectorFromString("setIsAudioEnabled:")
          if rtcSession.responds(to: setEnabledSel) {
            rtcSession.perform(setEnabledSel, with: NSNumber(value: true))
          }
        }
      }
    }
    // [bug 2026-05-15 #9] Bridge to JS so /call can wait for CallKit to own
    // the audio session before triggering LiveKit Room.connect.
    module?.notifyAudioActivated()
  }
  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    print("[ExpoCallKit] Audio session deactivated")
    do {
      try audioSession.setActive(false, options: [.notifyOthersOnDeactivation])
    } catch {
      print("[ExpoCallKit] Failed to deactivate AVAudioSession: \(error)")
    }
    // [bug 2026-05-15 #11] Manual-audio gate OFF — stops WebRTC VPIO so the
    // audio unit doesn't keep tickling the system session after CallKit
    // releases it.
    let RTCAudioSessionClass: AnyClass? = NSClassFromString("RTCAudioSession")
    if let cls = RTCAudioSessionClass {
      let sel = NSSelectorFromString("sharedInstance")
      if (cls as AnyObject).responds(to: sel) {
        let rtcSessionUnmanaged = (cls as AnyObject).perform(sel)
        if let rtcSession = rtcSessionUnmanaged?.takeUnretainedValue() as? NSObject {
          let setEnabledSel = NSSelectorFromString("setIsAudioEnabled:")
          if rtcSession.responds(to: setEnabledSel) {
            rtcSession.perform(setEnabledSel, with: NSNumber(value: false))
          }
        }
      }
    }
    module?.notifyAudioDeactivated()
  }
}

// MARK: - NativeCallRoom listener bridge
//
// [stage 2 native LiveKit pre-connect, 2026-05-15]
// Forwards LiveKit Room events from the native singleton up to JS via
// safeSendEvent. Listener registration is idempotent — JS calls
// adoptNativeRoom() which adds us to the listener bag (NSHashTable
// dedupes); we never remove because the listener is owned by the module
// for the lifetime of the app.
extension ExpoCallKitModule: NativeCallRoomListener {
  public func nativeCallRoom(_ room: NativeCallRoom, didEmit event: NativeCallRoomEvent) {
    switch event {
    case .connected(let roomName, let localIdentity):
      safeSendEvent("onLkConnected", [
        "roomName": roomName,
        "localIdentity": localIdentity
      ])
    case .disconnected(let reason):
      safeSendEvent("onLkDisconnected", ["reason": reason])
    case .participantConnected(let identity, let name):
      safeSendEvent("onLkParticipantConnected", [
        "identity": identity,
        "name": name ?? ""
      ])
    case .participantDisconnected(let identity):
      safeSendEvent("onLkParticipantDisconnected", ["identity": identity])
    case .trackSubscribed(let participantIdentity, let trackSid, let kind):
      safeSendEvent("onLkTrackSubscribed", [
        "participantIdentity": participantIdentity,
        "trackSid": trackSid,
        "kind": kind
      ])
    case .trackUnsubscribed(let participantIdentity, let trackSid, let kind):
      safeSendEvent("onLkTrackUnsubscribed", [
        "participantIdentity": participantIdentity,
        "trackSid": trackSid,
        "kind": kind
      ])
    case .connectionQualityChanged(let participantIdentity, let quality):
      safeSendEvent("onLkConnectionQuality", [
        "participantIdentity": participantIdentity,
        "quality": quality
      ])
    }
  }
}

// MARK: - Window/RootVC resolver
//
// [#1172 native-call-in-background fix, 2026-05-18] Apple deprecated
// UIWindow.isKeyWindow / keyWindow lookup on iOS 15+, and the legacy
// `connectedScenes.first.keyWindow` chain returns nil in three real-world
// situations we hit during call presentation:
//
//   * Background scene: when the app is backgrounded mid-cold-start (VoIP
//     push arrived but user hasn't opened the app yet), connectedScenes
//     contains a UISceneActivationState.background scene whose keyWindow is
//     nil because the window has not yet attached to a window scene.
//   * CallKit ring sheet: while CallKit's native ring sheet is on screen
//     (incoming call UI), the host app's window is NOT the key window —
//     CallKit's UIWindow temporarily owns the key. `keyWindow?` returns nil
//     and our present-on-keyWindow path silently bails.
//   * Multi-scene (iPad): connectedScenes is an unordered set; .first picks
//     a deterministic-by-hash scene which may not be the visible one.
//
// resolvePresentingViewController walks the scenes in this order:
//   1. foregroundActive UIWindowScene -> isKeyWindow window
//   2. foregroundActive UIWindowScene -> first non-hidden window
//   3. foregroundInactive scene fallback (transitioning into foreground)
//   4. Any scene's first window (cold-start)
//
// Then it traverses presentedViewController to land on the top-most VC so
// CallViewController.present (which does `top.present(...)` internally) works
// even when another modal (PHPicker, ProMode picker, system action sheet) is
// already on screen.
// NOT @MainActor-annotated: callers are already guaranteed main-thread via
// DispatchQueue.main.async / MainActor.run / Task.detached → await MainActor.run.
// Annotating would require every caller to `await` even from a non-async
// context (CXProvider delegate callbacks, DispatchQueue closures), forcing
// a wider refactor for no real benefit — UIApplication.shared APIs are
// main-thread-safe at runtime in practice and Apple's runtime check is
// only enforced under Swift 6 strict concurrency.
fileprivate func resolvePresentingViewController() -> UIViewController? {
  let scenes = UIApplication.shared.connectedScenes

  func windowFrom(_ scene: UIWindowScene) -> UIWindow? {
    if let key = scene.windows.first(where: { $0.isKeyWindow }) { return key }
    return scene.windows.first { !$0.isHidden }
  }

  // 1+2. Active foreground scene.
  if let active = scenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
     let win = windowFrom(active),
     let vc = win.rootViewController {
    return vc
  }
  // 3. Inactive foreground scene (transitioning).
  if let inactive = scenes.first(where: { $0.activationState == .foregroundInactive }) as? UIWindowScene,
     let win = windowFrom(inactive),
     let vc = win.rootViewController {
    return vc
  }
  // 4. Any scene with a window — covers backgrounded cold-start.
  for s in scenes {
    if let ws = s as? UIWindowScene,
       let win = windowFrom(ws),
       let vc = win.rootViewController {
      return vc
    }
  }
  // 5. Last-resort: AppDelegate.window (deprecated but still set on most
  //    Expo apps that haven't fully migrated to SceneDelegate).
  if let appWin = (UIApplication.shared.delegate as? UIResponder)?.value(forKey: "window") as? UIWindow,
     let vc = appWin.rootViewController {
    return vc
  }
  return nil
}

// [#1192 cold-start native call fix, 2026-05-19] On a true cold start
// (app fully killed) the VoIP push arrives, CallKit shows the system ring
// sheet, user taps Accept, CXAnswerCallAction fires — but the AppDelegate
// is still mid-`startReactNative()`: `UIWindow` was created with a frame
// but `rootViewController` is nil until the RN bridge finishes its
// bootstrap (typically 1-3s). `resolvePresentingViewController()` then
// returns nil and the call-screen presentation is silently abandoned —
// the user sees CallKit dismiss and lands on the home screen with no
// native call UI. (Warm path works because rootVC is already set.)
//
// This helper retries the present up to ~3s in 100ms ticks, draining as
// soon as a rootVC becomes available. Safe to call multiple times —
// guards by `attempts` and the call-still-active check the present block
// is expected to do.
fileprivate func retryPresent(reason: String,
                              attempts: Int = 30,
                              interval: TimeInterval = 0.1,
                              block: @escaping (UIViewController) -> Void) {
  func tick(_ remaining: Int) {
    if let vc = resolvePresentingViewController() {
      print("[ExpoCallKit] retryPresent(\(reason)): resolved on attempt \(attempts - remaining + 1)")
      block(vc)
      return
    }
    if remaining <= 0 {
      print("[ExpoCallKit] retryPresent(\(reason)): exhausted \(attempts) attempts, giving up")
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + interval) {
      tick(remaining - 1)
    }
  }
  // First attempt synchronous so warm path stays single-frame.
  tick(attempts)
}
