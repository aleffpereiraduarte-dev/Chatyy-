import ExpoModulesCore

/// [2026-10-15 native-transport] Ponte JS do transporte realtime nativo
/// (ver ChatTransport.swift). Módulo separado ("ChatyyTransport") para o JS
/// detectar com requireOptionalNativeModule — binário sem ele → null →
/// WebSocket JS de sempre. Nada conecta até o JS chamar open().
public class ChatyyTransportModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyTransport")

    Events("onTransportFrames", "onTransportState")

    OnCreate {
      ChatTransport.shared.emitter = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
      ChatTransport.shared.initialize()
    }

    OnDestroy {
      // Runtime JS indo embora (reload): a sessão é do JS → vai junto.
      ChatTransport.shared.emitter = nil
      ChatTransport.shared.closeAll(reason: "module_destroy")
    }

    Function("version") { () -> Int in
      return ChatTransport.version
    }

    /// Lança se a config for inválida (URL fora de *.chatyy.com.br etc.) → JS usa o WebSocket JS.
    Function("open") { (sid: String, config: [String: Any]) throws -> Bool in
      try ChatTransport.shared.open(sid: sid, config: config)
      return true
    }

    Function("send") { (sid: String, text: String) -> Bool in
      ChatTransport.shared.send(sid: sid, text: text)
      return true
    }

    Function("close") { (sid: String, code: Int, reason: String) -> Void in
      ChatTransport.shared.close(sid: sid, code: code, reason: reason)
    }

    Function("setHeartbeat") { (sid: String, intervalMs: Double, deadlineMs: Double) -> Void in
      ChatTransport.shared.setHeartbeat(sid: sid, intervalMs: intervalMs, deadlineMs: deadlineMs)
    }

    Function("probe") { (sid: String, ms: Double) -> Void in
      ChatTransport.shared.probe(sid: sid, ms: ms)
    }

    Function("kick") { (sid: String, reason: String, force: Bool) -> Void in
      ChatTransport.shared.kick(sid: sid, reason: reason, force: force)
    }

    Function("setAuthToken") { (sid: String, token: String) -> Void in
      ChatTransport.shared.setAuthToken(sid: sid, token: token)
    }

    Function("getStats") { () -> [String: Any] in
      return ChatTransport.shared.snapshot()
    }
  }
}
