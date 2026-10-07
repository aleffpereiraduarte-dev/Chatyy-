import ExpoModulesCore

/// [2026-10-07 native-core] JS bridge for ChatCoreSocket (phase 1, shadow).
/// Separate Expo module ("ChatyyChatCore") so JS capability-detects it with
/// requireOptionalNativeModule (old binaries → null → no-op). OnCreate only
/// wires the event emitter; nothing connects until JS calls start().
public class ChatCoreModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyChatCore")

    // [2026-10-08 native-core-2] + onChatCoreRaw (primary frames) / onChatCoreAck (outbox).
    Events("onChatCoreFrame", "onChatCoreState", "onChatCoreRaw", "onChatCoreAck")

    OnCreate {
      ChatCoreSocket.shared.emitter = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
    }

    OnDestroy {
      ChatCoreSocket.shared.emitter = nil
      ChatCoreSocket.shared.setPrimary(false)
      if ChatCoreSocket.shared.isRunning() {
        ChatCoreSocket.shared.stop(reason: "module_destroy")
      }
    }

    /// 1 = shadow (phase 1); 2 = + setPrimary / sendText / cancelSend (phase 2).
    Function("version") { () -> Int in
      return 2
    }

    Function("setPrimary") { (on: Bool) -> Void in
      ChatCoreSocket.shared.setPrimary(on)
    }

    AsyncFunction("sendText") { (acct: String, cmi: String, frameJson: String) -> Bool in
      return ChatCoreSocket.shared.sendText(acct: acct, cmi: cmi, frameJson: frameJson)
    }

    Function("cancelSend") { (cmi: String) -> Void in
      ChatCoreSocket.shared.cancelSend(cmi: cmi)
    }

    AsyncFunction("start") { (acct: String, lastEventId: Double, deviceId: String) -> Bool in
      // Int64(Double) traps on NaN/inf → clamp first.
      let seed: Int64 = lastEventId.isFinite ? Int64(max(0, min(lastEventId, 9.0e15))) : 0
      ChatCoreSocket.shared.start(acct: acct, jsLastEventId: seed, deviceId: deviceId)
      return true
    }

    AsyncFunction("stop") { (reason: String) -> Void in
      ChatCoreSocket.shared.stop(reason: reason)
    }

    Function("getState") { () -> [String: Any] in
      return ChatCoreSocket.shared.snapshot()
    }
  }
}
