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

  // Track active calls
  private var activeCalls: [String: UUID] = [:]

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

    AsyncFunction("setup") { () -> Void in
      // Setup already happens in OnCreate, but this ensures it's done
      if self.provider == nil {
        DispatchQueue.main.sync {
          self.setupProvider()
          self.setupVoipPush()
        }
      }
    }

    AsyncFunction("displayIncomingCall") { (callId: String, callerName: String, hasVideo: Bool) -> Void in
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
      return [
        "providerReady": self.provider != nil,
        "callControllerReady": self.callController != nil,
        "voipRegistryReady": self.voipRegistry != nil,
        "voipDelegateReady": self.voipDelegate != nil,
        "providerDelegateReady": self.providerDelegate != nil,
        "hasVoipToken": self.voipRegistry?.pushToken(for: .voIP) != nil,
        "activeCalls": self.activeCalls.count,
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
    activeCalls[callId] = uuid

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
    guard let uuid = activeCalls[callId], let callController = callController else { return }
    let action = CXEndCallAction(call: uuid)
    let transaction = CXTransaction(action: action)
    callController.request(transaction) { error in
      if let error = error {
        print("[ExpoCallKit] End call error: \(error.localizedDescription)")
      }
    }
    activeCalls.removeValue(forKey: callId)
  }

  func callAnswered(uuid: UUID) {
    if let callId = activeCalls.first(where: { $0.value == uuid })?.key {
      sendEvent("onCallAnswered", ["callId": callId])
    }
  }

  func callEnded(uuid: UUID) {
    if let callId = activeCalls.first(where: { $0.value == uuid })?.key {
      sendEvent("onCallEnded", ["callId": callId])
      activeCalls.removeValue(forKey: callId)
    }
  }

  func voipTokenReceived(token: String) {
    print("[ExpoCallKit] VoIP token received: \(token.prefix(8))...")
    sendEvent("onVoipTokenReceived", ["token": token])
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
    activeCalls[callId] = uuid

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
      } else {
        print("[ExpoCallKit] Successfully reported incoming call to CallKit")
        self?.sendEvent("onIncomingCall", [
          "callId": callId,
          "callerName": callerName,
          "hasVideo": hasVideo
        ])
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
    // Pass completion to module - it MUST call completion AFTER reporting to CallKit
    module?.voipPushReceived(payload: payload.dictionaryPayload, completion: completion)
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    print("[ExpoCallKit] VoIP token invalidated")
  }
}
