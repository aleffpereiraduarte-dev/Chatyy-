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

    AsyncFunction("setup") { () -> Void in
      self.setupProvider()
      self.setupVoipPush()
    }

    AsyncFunction("displayIncomingCall") { (callId: String, callerName: String, hasVideo: Bool) -> Void in
      try await self.reportIncomingCall(callId: callId, callerName: callerName, hasVideo: hasVideo)
    }

    Function("endCall") { (callId: String) -> Void in
      self.endCallAction(callId: callId)
    }

    Function("registerVoipPush") { () -> Void in
      self.setupVoipPush()
    }
  }

  private func setupProvider() {
    let config = CXProviderConfiguration()
    config.localizedName = "OneMundo Mail"
    config.supportsVideo = true
    config.maximumCallGroups = 1
    config.maximumCallsPerCallGroup = 1
    config.includesCallsInRecents = true
    config.ringtoneSound = "ringtone.wav"

    // Set supported handle types
    config.supportedHandleTypes = [.generic, .emailAddress]

    provider = CXProvider(configuration: config)
    providerDelegate = ProviderDelegate(module: self)
    provider?.setDelegate(providerDelegate, queue: DispatchQueue.main)
    callController = CXCallController()
  }

  private func setupVoipPush() {
    guard voipRegistry == nil else { return }
    voipRegistry = PKPushRegistry(queue: DispatchQueue.main)
    voipDelegate = VoipPushDelegate(module: self)
    voipRegistry?.delegate = voipDelegate
    voipRegistry?.desiredPushTypes = [.voIP]
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
    // Find callId by UUID
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
    sendEvent("onVoipTokenReceived", ["token": token])
  }

  func voipPushReceived(payload: [AnyHashable: Any]) {
    let callId = (payload["call_id"] as? String) ?? UUID().uuidString
    let callerName = (payload["caller_name"] as? String) ?? (payload["caller_email"] as? String) ?? "Unknown"
    let hasVideo = (payload["video"] as? String) == "1" || (payload["call_type"] as? String) == "video"

    // MUST report to CallKit immediately or iOS kills the app
    Task {
      do {
        try await self.reportIncomingCall(callId: callId, callerName: callerName, hasVideo: hasVideo)
        self.sendEvent("onIncomingCall", [
          "callId": callId,
          "callerName": callerName,
          "hasVideo": hasVideo
        ])
      } catch {
        print("[ExpoCallKit] Failed to report incoming call: \(error)")
      }
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
    // Clean up
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    // Configure audio session for call
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

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    // Audio session activated by CallKit
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    // Audio session deactivated
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
    print("[ExpoCallKit] VoIP token: \(token.prefix(8))...")
    module?.voipTokenReceived(token: token)
  }

  func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    guard type == .voIP else {
      completion()
      return
    }
    print("[ExpoCallKit] VoIP push received")
    module?.voipPushReceived(payload: payload.dictionaryPayload)
    completion()
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    print("[ExpoCallKit] VoIP token invalidated")
  }
}
