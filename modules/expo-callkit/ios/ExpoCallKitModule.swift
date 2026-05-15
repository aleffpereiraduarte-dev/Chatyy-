import ExpoModulesCore
import CallKit
import PushKit
import AVFoundation
import Network

public class ExpoCallKitModule: Module {
  private var provider: CXProvider?
  private var callController: CXCallController?
  private var voipRegistry: PKPushRegistry?
  private var providerDelegate: ProviderDelegate?
  private var voipDelegate: VoipPushDelegate?

  /// Network reachability monitor — emits onNetworkChange events to JS so
  /// the call screen can show "Reconnecting..." when Wi-Fi drops, etc.
  /// WhatsApp uses NWPathMonitor under the hood for the same UX.
  private var pathMonitor: NWPathMonitor?
  private var lastNetworkStatus: String = ""
  private var audioInterruptionObserver: Any?

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

    Events("onCallAnswered", "onCallEnded", "onVoipTokenReceived", "onIncomingCall", "onAudioInterruption", "onNetworkChange")

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
        self.setupVoipPush()
        self.setupNetworkMonitor()
        // [bug 2026-05-14] Pre-arm AVAudioSession with .playAndRecord +
        // .voiceChat at module load so when CallKit activates the session
        // post-answer, the mic input route is already wired. Without this
        // pre-arm, the session inherits .ambient/.solo from a prior
        // expo-audio call, and CXAnswerCallAction → fulfill() → didActivate
        // races with JS PC setup — by the time addTrack runs, the audio
        // unit has no input attached and uplink mic is silent.
        // setActive(false) keeps it inactive until CallKit owns it.
        do {
          let session = AVAudioSession.sharedInstance()
          try session.setCategory(.playAndRecord, mode: .voiceChat,
            options: [.allowBluetooth, .allowBluetoothA2DP, .duckOthers])
          print("[ExpoCallKit] AVAudioSession pre-armed for voiceChat (mic capture ready)")
        } catch {
          print("[ExpoCallKit] AVAudioSession pre-arm failed: \(error)")
        }
        print("[ExpoCallKit] Auto-initialized on module create")
      }
    }

    OnStartObserving {
      print("[ExpoCallKit] JS listeners registered — flushing pending events")
      self.stateQueue.sync {
        self.jsListenersReady = true
      }
      self.flushPendingEvents()
    }

    AsyncFunction("setup") { () -> Void in
      // Setup already happens in OnCreate, but this ensures it's done
      if self.provider == nil {
        if Thread.isMainThread {
          self.setupProvider()
          self.setupVoipPush()
        } else {
          DispatchQueue.main.sync {
            self.setupProvider()
            self.setupVoipPush()
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
      DispatchQueue.main.async {
        self.setupVoipPush()
      }
    }

    Function("getVoipToken") { () -> String? in
      if let cachedToken = self.voipRegistry?.pushToken(for: .voIP) {
        return cachedToken.map { String(format: "%02x", $0) }.joined()
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

    Function("getDiagnostics") { () -> [String: Any] in
      let callCount = self.stateQueue.sync { self.activeCalls.count }
      return [
        "providerReady": self.provider != nil,
        "callControllerReady": self.callController != nil,
        "voipRegistryReady": self.voipRegistry != nil,
        "voipDelegateReady": self.voipDelegate != nil,
        "providerDelegateReady": self.providerDelegate != nil,
        "hasVoipToken": self.voipRegistry?.pushToken(for: .voIP) != nil,
        "activeCalls": callCount,
        "isMainThread": Thread.isMainThread
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

  private func setupVoipPush() {
    guard voipRegistry == nil else {
      print("[ExpoCallKit] VoIP registry already exists, checking cached token...")
      // Check for cached token even if registry exists
      if let cachedToken = voipRegistry?.pushToken(for: .voIP) {
        let token = cachedToken.map { String(format: "%02x", $0) }.joined()
        print("[ExpoCallKit] Found cached VoIP token: \(token.prefix(8))...")
        voipTokenReceived(token: token)
      }
      return
    }
    print("[ExpoCallKit] Setting up PKPushRegistry on thread: \(Thread.isMainThread ? "main" : "background")")
    voipDelegate = VoipPushDelegate(module: self)
    voipRegistry = PKPushRegistry(queue: DispatchQueue.main)
    voipRegistry?.delegate = voipDelegate
    voipRegistry?.desiredPushTypes = [.voIP]
    print("[ExpoCallKit] PKPushRegistry configured, waiting for token...")

    // Also check for cached token immediately after setup
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
      guard let self = self else { return }
      if let cachedToken = self.voipRegistry?.pushToken(for: .voIP) {
        let token = cachedToken.map { String(format: "%02x", $0) }.joined()
        print("[ExpoCallKit] Found cached VoIP token (delayed check): \(token.prefix(8))...")
        self.voipTokenReceived(token: token)
      } else {
        print("[ExpoCallKit] No VoIP token after 2s - check provisioning profile has Push Notifications capability")
      }
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

  func voipPushReceived(payload: [AnyHashable: Any], completion: @escaping () -> Void) {
    let callId = (payload["call_id"] as? String) ?? UUID().uuidString
    let callerName = (payload["caller_name"] as? String) ?? (payload["caller_email"] as? String) ?? "Unknown"
    let hasVideo = (payload["video"] as? String) == "1" || (payload["call_type"] as? String) == "video"

    print("[ExpoCallKit] VoIP push received - reporting to CallKit BEFORE completion")

    guard let provider = self.provider else {
      print("[ExpoCallKit] ERROR: provider is nil, cannot report call")
      completion()
      return
    }

    // Dedup by callId — duplicate VoIP pushes for the same call (carrier
    // retries, app warm/cold paths, etc.) used to overwrite activeCalls
    // with a fresh UUID and trigger a SECOND CallKit incoming-call screen,
    // breaking end/answer mapping. Reuse the existing UUID if the same
    // callId was already reported.
    var uuid: UUID! = nil
    var alreadyReported = false
    stateQueue.sync {
      if let existing = activeCalls[callId] {
        uuid = existing
        alreadyReported = true
        // Refresh payload in case the new push has richer fields
        callPayloads[callId] = payload
      } else {
        uuid = UUID()
        activeCalls[callId] = uuid
        callPayloads[callId] = payload
      }
    }
    if alreadyReported {
      print("[ExpoCallKit] Duplicate VoIP push for \(callId) — reusing UUID, skipping reportNewIncomingCall")
      completion()
      return
    }

    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: callerName)
    update.localizedCallerName = callerName
    update.hasVideo = hasVideo
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsHolding = true
    update.supportsDTMF = false

    // Report to CallKit SYNCHRONOUSLY before calling completion
    provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
      if let error = error {
        print("[ExpoCallKit] Failed to report incoming call: \(error.localizedDescription)")
        // Clean up orphaned payload on failure
        self?.stateQueue.sync {
          self?.callPayloads.removeValue(forKey: callId)
          self?.activeCalls.removeValue(forKey: callId)
        }
      } else {
        print("[ExpoCallKit] Successfully reported incoming call to CallKit")

        // If app is in FOREGROUND, immediately end CallKit call
        // The in-app Modal (via WS) will handle the call instead
        DispatchQueue.main.async { [weak self] in
          guard let self = self else { return }
          let appState = UIApplication.shared.applicationState
          if appState == .active {
            print("[ExpoCallKit] App in foreground - ending CallKit, WS Modal will handle")
            let endAction = CXEndCallAction(call: uuid)
            let transaction = CXTransaction(action: endAction)
            self.callController?.request(transaction) { _ in }
            self.stateQueue.sync {
              self.activeCalls.removeValue(forKey: callId)
              self.callPayloads.removeValue(forKey: callId)
            }
          } else {
            print("[ExpoCallKit] App in background - CallKit will show native call screen")
            self.safeSendEvent("onIncomingCall", [
              "callId": callId,
              "callerName": callerName,
              "callerEmail": payload["caller_email"] as? String ?? "",
              "conversationId": payload["conversation_id"] as? String ?? "",
              "hasVideo": hasVideo
            ])
          }
        }
      }
      // ONLY call completion AFTER CallKit has been notified
      completion()
    }
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
    do {
      try audioSession.setCategory(
        .playAndRecord, mode: .voiceChat,
        options: [.allowBluetooth, .allowBluetoothA2DP, .allowBluetoothHFP]
      )
    } catch {
      print("[ExpoCallKit] Audio category set failed (non-fatal): \(error)")
    }
    module?.callAnswered(uuid: action.callUUID)
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    module?.callEnded(uuid: action.callUUID)
    // Deactivate audio session when call ends so other apps (Spotify, Music)
    // can reclaim the audio session. Without this, audio stays "stolen".
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.ambient, mode: .default, options: [])
      try session.setActive(false, options: [.notifyOthersOnDeactivation])
    } catch {
      print("[ExpoCallKit] Audio session deactivation failed: \(error)")
    }
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
        try session.setCategory(
          .playAndRecord, mode: .voiceChat,
          options: [.allowBluetooth, .allowBluetoothA2DP, .allowBluetoothHFP]
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
        options: [.allowBluetooth, .allowBluetoothA2DP, .allowBluetoothHFP, .duckOthers]
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
        }
      }
    }
  }
  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    print("[ExpoCallKit] Audio session deactivated")
    do {
      try audioSession.setActive(false, options: [.notifyOthersOnDeactivation])
    } catch {
      print("[ExpoCallKit] Failed to deactivate AVAudioSession: \(error)")
    }
  }
}

// MARK: - PushKit Delegate
private class VoipPushDelegate: NSObject, PKPushRegistryDelegate {
  weak var module: ExpoCallKitModule?

  init(module: ExpoCallKitModule) {
    self.module = module
    super.init()
  }

  func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    guard type == .voIP else { return }
    let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    print("[ExpoCallKit] VoIP token received: \(token.prefix(8))...")
    module?.voipTokenReceived(token: token)
  }

  func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    guard type == .voIP else {
      completion()
      return
    }
    print("[ExpoCallKit] VoIP push received")

    guard let module = self.module else {
      // Module is nil (deallocated). Per Apple docs, we MUST report a call to
      // CallKit before calling completion(), otherwise iOS will terminate
      // the app and stop delivering VoIP pushes permanently.
      print("[ExpoCallKit] WARNING: module is nil — reporting dummy call to satisfy Apple requirement")
      let config = CXProviderConfiguration(localizedName: "Chatyy")
      config.supportsVideo = true
      let tempProvider = CXProvider(configuration: config)
      let uuid = UUID()
      let update = CXCallUpdate()
      let callerName = (payload.dictionaryPayload["caller_name"] as? String) ?? "Unknown"
      update.remoteHandle = CXHandle(type: .generic, value: callerName)
      update.localizedCallerName = callerName
      update.hasVideo = false

      tempProvider.reportNewIncomingCall(with: uuid, update: update) { error in
        if let error = error {
          print("[ExpoCallKit] Dummy call report failed: \(error.localizedDescription)")
        } else {
          // Immediately end the dummy call since we can't handle it
          tempProvider.reportCall(with: uuid, endedAt: nil, reason: .failed)
        }
        completion()
      }
      return
    }

    // Pass completion to module - it MUST call completion AFTER reporting to CallKit
    module.voipPushReceived(payload: payload.dictionaryPayload, completion: completion)
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    print("[ExpoCallKit] VoIP token invalidated — requesting new one")
    // Re-arm the registry so iOS issues a new token. WhatsApp does this so
    // missed-call rate stays low across token rotations (~weekly).
    DispatchQueue.main.async {
      registry.desiredPushTypes = [.voIP]
    }
  }
}
