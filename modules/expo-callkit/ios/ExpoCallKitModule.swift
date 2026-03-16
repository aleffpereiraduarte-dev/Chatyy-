import ExpoModulesCore
import CallKit
import PushKit
import AVFoundation

public class ExpoCallKitModule: Module {
  private var provider: CXProvider?
  private var callController: CXCallController?
  private var voipRegistry: PKPushRegistry?
  private var providerDelegate: ProviderDelegate?
  private var voipDelegate: VoipPushDelegate?

  // Serial queue for thread-safe access to activeCalls, callPayloads, pendingEvents
  private let stateQueue = DispatchQueue(label: "com.onemundo.callkit.state")

  // Track active calls — access only via stateQueue
  private var activeCalls: [String: UUID] = [:]
  // Store VoIP push payloads so we can pass full data in onCallAnswered
  private var callPayloads: [String: [AnyHashable: Any]] = [:]

  // Buffer events when JS is not ready (cold start)
  private var pendingEvents: [(String, [String: Any])] = []
  private var jsListenersReady = false

  public func definition() -> ModuleDefinition {
    Name("ExpoCallKit")

    Events("onCallAnswered", "onCallEnded", "onVoipTokenReceived", "onIncomingCall")

    // Auto-initialize on module load
    OnCreate {
      DispatchQueue.main.async {
        self.setupProvider()
        self.setupVoipPush()
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
        DispatchQueue.main.sync {
          self.setupProvider()
          self.setupVoipPush()
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
    let config = CXProviderConfiguration(localizedName: "OneMundo Mail")
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
    print("[ExpoCallKit] CXProvider configured")
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

    let uuid = UUID()
    stateQueue.sync {
      activeCalls[callId] = uuid
    }

    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: callerName)
    update.localizedCallerName = callerName
    update.hasVideo = hasVideo
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsHolding = false
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
  func safeSendEvent(_ eventName: String, _ body: [String: Any]) {
    let wasReady = stateQueue.sync { () -> Bool in
      if jsListenersReady {
        sendEvent(eventName, body)
        return true
      } else {
        print("[ExpoCallKit] JS not ready, buffering event: \(eventName)")
        pendingEvents.append((eventName, body))
        return false
      }
    }
    // Schedule a delayed flush in case OnStartObserving fires later
    if !wasReady {
      DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
        self?.flushPendingEvents()
      }
    }
  }

  private func flushPendingEvents() {
    stateQueue.sync {
      guard jsListenersReady, !pendingEvents.isEmpty else { return }
      print("[ExpoCallKit] Flushing \(pendingEvents.count) pending events")
      for (name, data) in pendingEvents {
        sendEvent(name, data)
      }
      pendingEvents.removeAll()
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

    let uuid = UUID()
    stateQueue.sync {
      activeCalls[callId] = uuid
      callPayloads[callId] = payload
    }

    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: callerName)
    update.localizedCallerName = callerName
    update.hasVideo = hasVideo
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsHolding = false
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

  func providerDidReset(_ provider: CXProvider) {}

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    let audioSession = AVAudioSession.sharedInstance()
    do {
      try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
      try audioSession.setActive(true)
    } catch {
      print("[ExpoCallKit] Audio session error: \(error)")
    }
    module?.callAnswered(uuid: action.callUUID)
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    module?.callEnded(uuid: action.callUUID)
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {}
  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {}
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
      let config = CXProviderConfiguration(localizedName: "OneMundo Mail")
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
    print("[ExpoCallKit] VoIP token invalidated")
  }
}
