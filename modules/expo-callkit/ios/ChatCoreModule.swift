import ExpoModulesCore

/// [2026-10-07 native-core] JS bridge for ChatCoreSocket (phase 1, shadow).
/// Separate Expo module ("ChatyyChatCore") so JS capability-detects it with
/// requireOptionalNativeModule (old binaries → null → no-op). OnCreate only
/// wires the event emitter; nothing connects until JS calls start().
public class ChatCoreModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyChatCore")

    Events("onChatCoreFrame", "onChatCoreState")

    OnCreate {
      ChatCoreSocket.shared.emitter = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
    }

    OnDestroy {
      ChatCoreSocket.shared.emitter = nil
      if ChatCoreSocket.shared.isRunning() {
        ChatCoreSocket.shared.stop(reason: "module_destroy")
      }
    }

    Function("version") { () -> Int in
      return 1
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
