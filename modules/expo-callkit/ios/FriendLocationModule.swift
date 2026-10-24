import ExpoModulesCore

/// [2026-10-12 find-my] Ponte JS ↔ FriendLocationAgent. Módulo separado
/// ("ChatyyFriendLocation") para o JS detectar com requireOptionalNativeModule
/// — binário antigo → null → comportamento anterior (expo-location).
public class FriendLocationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyFriendLocation")

    /// 1 = significant-change + visits + ping silencioso.
    Function("version") { () -> Int in
      return 1
    }

    Function("isSupported") { () -> Bool in
      return true
    }

    /// [2026-10-24 mapa-v2] bateria p/ o envio em 1º plano (JS friendMapShare.postShareUpdate).
    Function("getBattery") { () -> [String: Any] in
      if let b = FriendLocationAgent.battery() { return ["level": b.level, "charging": b.charging] }
      return ["level": -1, "charging": false]
    }

    /// Liga o envio nativo em 2º plano (persistido no App Group). `acct` = conta ativa.
    AsyncFunction("start") { (acct: String) -> [String: Any] in
      FriendLocationAgent.shared.enable(acct: acct)
      return FriendLocationAgent.shared.status()
    }

    AsyncFunction("stop") { () -> Void in
      FriendLocationAgent.shared.disable()
    }

    Function("getStatus") { () -> [String: Any] in
      return FriendLocationAgent.shared.status()
    }

    /// Diagnóstico / "publicar agora": mesma rotina do ping silencioso.
    AsyncFunction("requestOnce") { (promise: Promise) in
      FriendLocationAgent.shared.handlePing { ok in
        promise.resolve(ok)
      }
    }
  }
}
