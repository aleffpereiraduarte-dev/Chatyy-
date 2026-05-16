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

    AsyncFunction("lkConnect") { (params: [String: Any]) -> Void in
      guard let url = params["url"] as? String,
            let token = params["token"] as? String,
            let identity = params["identity"] as? String,
            let roomName = params["roomName"] as? String else {
        print("[ExpoCallKit] lkConnect missing params: \(params.keys)")
        return
      }
      NativeCallRoom.shared.connect(
        url: url,
        token: token,
        identity: identity,
        roomName: roomName
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

    AsyncFunction("adoptNativeRoom") { () -> [String: Any] in
      // Wire ourselves up as a listener so JS gets onLk* events.
      // Idempotent — NSHashTable dedupes.
      NativeCallRoom.shared.addListener(self)
      let snap = NativeCallRoom.shared.getSnapshot()
      var dict = snap.toDictionary()
      dict["alreadyConnected"] = snap.connected
      return dict
    }

    AsyncFunction("persistAuthForNativeCall") { (params: [String: Any]) -> Void in
      // Stash bearer token + user email in App Group so the AppDelegate
      // subscriber can fetch a LiveKit token without the RN bridge.
      // JS calls this on login and whenever the active account changes.
      guard let ud = UserDefaults(suiteName: kAppGroupId) else { return }
      if let token = params["authToken"] as? String { ud.set(token, forKey: "auth_token") }
      if let email = params["email"] as? String { ud.set(email, forKey: "user_email") }
      if let api = params["apiBase"] as? String { ud.set(api, forKey: "api_base") }
      ud.set(Date().timeIntervalSince1970, forKey: "auth_token_at")
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
    module?.callAnswered(uuid: action.callUUID)
    action.fulfill()
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
