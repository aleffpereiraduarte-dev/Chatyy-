import ExpoModulesCore
import CallKit
import PushKit
import AVFoundation
import Network

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

  // Serial queue for thread-safe access to activeCalls, callPayloads, pendingEvents
  private let stateQueue = DispatchQueue(label: "com.onemundo.callkit.state")

  /// Look up the original server-side callId for a CallKit UUID. Used by
  /// the delegate to keep CXAction events keyed by call_id (what JS sees)
  /// instead of the opaque UUID.
  internal func callIdForUUID(_ uuid: UUID) -> String? {
    return stateQueue.sync {
      for (cid, u) in activeCalls where u == uuid { return cid }
      return nil
    }
  }

  // Track active calls — access only via stateQueue
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
    let callerName: String
    let isVideo: Bool
    let roomName: String
    let conversationId: String
    let lkUrl: String?
    let lkToken: String?
  }
  private var pendingOutgoingCalls: [UUID: OutgoingCallParams] = [:]

  internal func consumeOutgoingCallParams(uuid: UUID) -> OutgoingCallParams? {
    return stateQueue.sync {
      let params = pendingOutgoingCalls[uuid]
      pendingOutgoingCalls.removeValue(forKey: uuid)
      return params
    }
  }

  // Buffer events when JS is not ready (cold start)
  private var pendingEvents: [(String, [String: Any])] = []
  private var jsListenersReady = false

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
      "onLkConnectionQuality"
    )

    // Auto-initialize on module load (skip CallKit in China per Apple requirement)
    OnCreate {
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
        self.flushVoipTokenFromAppGroup()
        self.adoptPendingCallsFromAppGroup()
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
      self.stateQueue.sync {
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
    }

    // JS calls this on mount to get any events that fired before JS was ready
    Function("consumePendingEvents") { () -> [[String: Any]] in
      return self.stateQueue.sync {
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

    Function("endCall") { (callId: String) -> Void in
      self.endCallAction(callId: callId)
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

    AsyncFunction("lkDisconnect") { () -> Void in
      NativeCallRoom.shared.disconnect()
    }

    AsyncFunction("lkSetMicEnabled") { (enabled: Bool) -> Void in
      NativeCallRoom.shared.setMicEnabled(enabled)
    }

    AsyncFunction("lkSetCameraEnabled") { (enabled: Bool) -> Void in
      NativeCallRoom.shared.setCameraEnabled(enabled)
    }

    // [host-mute, 2026-05-17] Host-issued mute of a remote participant.
    //
    // Architecture note: NativeCallRoom is still a stub on iOS (see
    // NativeCallRoom.swift) so the LK Room is JS-owned via @livekit/react-native.
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

    // [Stage 1+2 alignment] Match Android signature: adoptNativeRoom(callId)
    // returns the snapshot dict or nil if no room or callId mismatch.
    AsyncFunction("adoptNativeRoom") { (callId: String) -> [String: Any]? in
      NativeCallRoom.shared.addListener(self)
      let snap = NativeCallRoom.shared.getSnapshot()
      guard snap.connected else { return nil }
      if let active = NativeCallRoom.shared.lastRoomName, !active.isEmpty,
         active != callId {
        print("[ExpoCallKit] adoptNativeRoom: room is for \(active), not \(callId)")
        return nil
      }
      var dict = snap.toDictionary()
      dict["alreadyConnected"] = true
      return dict
    }

    Function("isNativeRoomConnected") { () -> Bool in
      NativeCallRoom.shared.state.rawValue == "connected"
    }

    // [Stage 1+2 alignment] Positional args: persistAuthForNativeCall(token, baseUrl).
    AsyncFunction("persistAuthForNativeCall") { (token: String, baseUrl: String) -> Void in
      guard let ud = UserDefaults(suiteName: kAppGroupId) else { return }
      ud.set(token, forKey: "auth_token")
      ud.set(baseUrl, forKey: "api_base")
      ud.set(Date().timeIntervalSince1970, forKey: "auth_token_at")
    }

    AsyncFunction("persistPendingLkToken") { (roomName: String, token: String, url: String) -> Void in
      guard let ud = UserDefaults(suiteName: kAppGroupId) else { return }
      ud.set(token, forKey: "lk_token_\(roomName)")
      ud.set(url, forKey: "lk_url_\(roomName)")
      ud.set(Date().timeIntervalSince1970, forKey: "lk_ts_\(roomName)")
    }

    Function("getDiagnostics") { () -> [String: Any] in
      let callCount = self.stateQueue.sync { self.activeCalls.count }
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

    // [native call screen, 2026-05-16] Mirrors Android's `openNativeCall`.
    // JS calls this to swap /call.js out for the SwiftUI CallView.
    // [Day 2, 2026-05-16] lkUrl + lkToken are now forwarded into the VC so
    // CallViewController can own the LiveKit Room directly. When either is
    // nil/empty the VC skips Room.connect and the JS @livekit/react-native
    // path stays in charge (fallback for unmigrated callers).
    AsyncFunction("openNativeCall") { (callId: String, callerName: String, callerEmail: String, hasVideo: Bool, lkUrl: String?, lkToken: String?) -> Void in
      await MainActor.run {
        guard let root = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
            .first else { return }
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

      // Stash params for the delegate path AND register the callId↔UUID map
      // so callAnswered/callEnded/endCall route correctly once the callee
      // accepts (the answer event comes through the same CallKit channel).
      self.stateQueue.sync {
        self.activeCalls[callId] = uuid
        self.pendingOutgoingCalls[uuid] = OutgoingCallParams(
          callId: callId,
          calleeEmail: calleeEmail,
          calleeName: calleeName,
          callerName: callerName,
          isVideo: isVideo,
          roomName: roomName.isEmpty ? callId : roomName,
          conversationId: conversationId,
          lkUrl: lkUrl,
          lkToken: lkToken
        )
      }

      guard let cc = self.callController else {
        throw NSError(domain: "ExpoCallKit", code: 101,
                      userInfo: [NSLocalizedDescriptionKey: "CallController not ready"])
      }
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
            self.stateQueue.sync {
              self.activeCalls.removeValue(forKey: callId)
              self.pendingOutgoingCalls.removeValue(forKey: uuid)
            }
            continuation.resume(throwing: error)
          } else {
            print("[ExpoCallKit] startOutgoingCall: transaction queued for callId=\(callId)")
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
        guard let root = UIApplication.shared.connectedScenes
          .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
          .first else { return }
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
        guard let root = UIApplication.shared.connectedScenes
          .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
          .first else { return }
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
        guard let root = UIApplication.shared.connectedScenes
          .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
          .first else { return }
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
    Function("fireCallInviteNative") { (callId: String, conversationId: String, calleeEmail: String, hasVideo: Bool) -> Void in
      CallSignalWs.shared.fireCallInvite(
        callId: callId,
        conversationId: conversationId,
        calleeEmail: calleeEmail,
        hasVideo: hasVideo
      )
    }

    Function("fireCallAnsweredNative") { (callId: String, conversationId: String) -> Void in
      CallSignalWs.shared.fireCallAnswered(callId: callId, conversationId: conversationId)
    }

    Function("fireCallEndNative") { (callId: String, conversationId: String, reason: String) -> Void in
      CallSignalWs.shared.fireCallEnd(callId: callId, conversationId: conversationId, reason: reason)
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
    config.supportedHandleTypes = [.generic, .emailAddress]

    provider = CXProvider(configuration: config)
    providerDelegate = ProviderDelegate(module: self)
    provider?.setDelegate(providerDelegate, queue: DispatchQueue.main)
    callController = CXCallController()

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
      self?.safeSendEvent("onCallEnded", ["callId": callId])
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

    stateQueue.sync {
      activeCalls[callId] = uuid
      callPayloads[callId] = payload
    }
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
      let shouldNotify = self.stateQueue.sync { () -> Bool in
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
    pathMonitor?.cancel()
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
    let uuid: UUID = stateQueue.sync {
      if let existing = activeCalls[callId] { return existing }
      let newUUID = UUID()
      activeCalls[callId] = newUUID
      return newUUID
    }

    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: callerName)
    update.localizedCallerName = callerName
    update.hasVideo = hasVideo
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsHolding = true
    update.supportsDTMF = false

    try await provider.reportNewIncomingCall(with: uuid, update: update)
  }

  func endCallAction(callId: String) {
    let uuid = stateQueue.sync { activeCalls[callId] }
    guard let uuid = uuid, let callController = callController else { return }
    let action = CXEndCallAction(call: uuid)
    let transaction = CXTransaction(action: action)
    callController.request(transaction) { error in
      if let error = error {
        print("[ExpoCallKit] End call error: \(error.localizedDescription)")
      }
    }
    stateQueue.sync {
      activeCalls.removeValue(forKey: callId)
    }
  }

  /// Send event to JS, buffering if JS isn't ready yet (cold start)
  /// IMPORTANT: sendEvent must be called OUTSIDE stateQueue.sync to avoid deadlock
  func safeSendEvent(_ eventName: String, _ body: [String: Any]) {
    let shouldSend = stateQueue.sync { () -> Bool in
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
    let toFlush: [(String, [String: Any])] = stateQueue.sync {
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

  func callAnswered(uuid: UUID) {
    let result: (String, [String: Any])? = stateQueue.sync {
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
      print("[ExpoCallKit] callAnswered: callId=\(callId), jsReady=\(jsListenersReady)")
      safeSendEvent("onCallAnswered", eventData)
    }
  }

  func callEnded(uuid: UUID) {
    let callId: String? = stateQueue.sync {
      guard let callId = activeCalls.first(where: { $0.value == uuid })?.key else { return nil }
      activeCalls.removeValue(forKey: callId)
      callPayloads.removeValue(forKey: callId)
      return callId
    }
    if let callId = callId {
      print("[ExpoCallKit] callEnded: callId=\(callId), jsReady=\(jsListenersReady)")
      safeSendEvent("onCallEnded", ["callId": callId])
    }
  }

  /// Force-end a call by UUID with a CallKit-known reason. Used by the
  /// timedOutPerforming delegate path so the call exits "ringing" cleanly.
  func endCall(callUUID: UUID, reason: CXCallEndedReason) {
    provider?.reportCall(with: callUUID, endedAt: nil, reason: reason)
    callEnded(uuid: callUUID)
  }

  /// Called when CallKit completely resets (system restart, etc).
  /// Wipe our bookkeeping so we don't leak ghost calls.
  func handleProviderReset() {
    print("[ExpoCallKit] Provider reset — clearing all active calls")
    let toEnd: [String] = stateQueue.sync {
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
    let audioSession = AVAudioSession.sharedInstance()
    // [bug 2026-05-15 #981 lock-screen viva-voz] Removed `.defaultToSpeaker`.
    // When CallKit answers from the lock screen, this option forced every
    // audio call to route to the loudspeaker (user complaint: "atendo com
    // tela bloqueada só fica no viva voz"). The JS side (/call) explicitly
    // toggles speaker for video calls via `setSpeakerEnabled(true)` once
    // mounted, so the native default should be earpiece (WhatsApp pattern).
    //
    // [bug 2026-05-15 #10] `.allowBluetooth` is deprecated since iOS 8.
    // `.allowBluetoothA2DP` covers media playback over BT; `.allowBluetoothHFP`
    // covers hands-free profile (in-call). Same set is used in didActivate
    // and CXSetHeldCallAction.resume for consistency.
    do {
      try audioSession.setCategory(
        .playAndRecord, mode: .voiceChat,
        options: [.allowBluetoothA2DP, .allowBluetoothHFP]
      )
    } catch {
      print("[ExpoCallKit] Audio category set failed (non-fatal): \(error)")
    }
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
      CallSignalWs.shared.fireCallAnswered(
        callId: callId,
        conversationId: snapshot.conversationId
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

    Task.detached(priority: .userInitiated) {
      do {
        let result = try await NativeCallTokenFetcher.shared.fetchToken(
          roomName: callId,
          identity: identity,
          role: "publisher"
        )
        await MainActor.run {
          Self.presentNativeCallVC(callId: callId,
                                   callerName: snapshot.callerName,
                                   callerEmail: snapshot.callerEmail,
                                   hasVideo: snapshot.hasVideo,
                                   lkUrl: result.url,
                                   lkToken: result.token,
                                   conversationId: snapshot.conversationId)
        }
      } catch {
        // No native screen this round — JS-side router.push('/call') is the
        // fallback and will retry the token fetch through @livekit/react-native.
        print("[ExpoCallKit] LK token fetch failed in CXAnswer path: \(error). JS fallback will retry.")
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
    guard let root = UIApplication.shared.connectedScenes
        .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
        .first else {
      print("[ExpoCallKit] presentNativeCallVC: no keyWindow rootViewController — skipping native present")
      return
    }
    // [2026-05-16 Stage 2] isOutgoing stays false for the CXAnswer path —
    // we're presenting because the callee just answered, NOT because they
    // initiated. The native call_answered fire happens up in the CXAnswer
    // handler; we just need conversationId here so CallViewController's
    // hangup path can fire call_end with the correct (call_id, conv_id).
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
    guard let root = UIApplication.shared.connectedScenes
        .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
        .first else {
      print("[ExpoCallKit] presentOutgoingCallVC: no keyWindow rootViewController — skipping native present")
      return
    }
    CallViewController.present(
      from: root,
      callId: params.callId,
      callerName: params.calleeName,
      callerEmail: params.calleeEmail,
      hasVideo: params.isVideo,
      lkUrl: lkUrl,
      lkToken: lkToken,
      isOutgoing: true,
      conversationId: params.conversationId
    )
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    module?.callEnded(uuid: action.callUUID)
    // [bug 2026-05-15 #12] Do NOT manually setActive(false) here.
    // CallKit fires didDeactivate automatically after action.fulfill();
    // calling setActive ourselves races with WebRTC engine teardown and
    // the system's deactivation flow, which on some devices caused a
    // brief audio glitch when ending a call back-to-back. Let CallKit
    // own the deactivation lifecycle.
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
    // CallKit owns the AVAudioSession during a call. Configure it explicitly
    // so the system ringtone (and post-answer call audio) play reliably.
    // Without this, AVAudioSession can stay in .ambient/.solo from a prior
    // expo-audio call and silently drop the ringtone.
    do {
      try audioSession.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        // [bug 2026-05-15 #10] removed `.allowBluetooth` (deprecated). The
        // A2DP + HFP options give us bluetooth headset support across modern
        // iOS without the deprecation warning that breaks the build on newer
        // Xcode toolchains.
        options: [.allowBluetoothA2DP, .allowBluetoothHFP, .duckOthers]
      )
      try audioSession.setActive(true, options: [])
      // [bug 2026-05-15 #981] Force default routing (earpiece / Bluetooth /
      // headset — whatever the system picks). Without this, a previous
      // setCategory(.defaultToSpeaker) leaves the route override pinned to
      // speaker even after we drop the option. `.none` is the canonical
      // LiveKit/WhatsApp workaround.
      try audioSession.overrideOutputAudioPort(.none)
    } catch {
      print("[ExpoCallKit] Failed to configure AVAudioSession: \(error)")
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
