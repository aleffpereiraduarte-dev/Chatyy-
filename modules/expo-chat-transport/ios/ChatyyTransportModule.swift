import ExpoModulesCore

/// [2026-10-15 native-transport] Ponte JS do transporte realtime nativo
/// (ver ChatTransport.swift). Módulo separado ("ChatyyTransport") para o JS
/// detectar com requireOptionalNativeModule — binário sem ele → null →
/// WebSocket JS de sempre. Nada conecta até o JS chamar open().
public class ChatyyTransportModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyTransport")

    Events("onTransportFrames", "onTransportState", "onOutboxState", "onE2EEPlain")

    OnCreate {
      ChatTransport.shared.emitter = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
      ChatTransport.shared.initialize()
      // [fase 4] fila nativa: o motor sobrevive ao JS; só o canal de eventos é do JS.
      ChatOutbox.shared.emitter = { [weak self] body in
        self?.sendEvent("onOutboxState", body)
      }
      ChatOutbox.shared.start()
      ChatyyE2EEBridge.install() // [e2ee5 WP-08a] envio cifrado da notificação/Siri
    }

    OnDestroy {
      // Runtime JS indo embora (reload): a sessão é do JS → vai junto.
      ChatTransport.shared.emitter = nil
      ChatTransport.shared.closeAll(reason: "module_destroy")
      ChatOutbox.shared.emitter = nil
    }

    // ─── [2026-10-15 fase 4] fila de envio nativa ───────────────────────────
    /// Credenciais p/ reenviar sem o JS (Keychain). base só https chatyy.com.br/subdomínios.
    Function("outboxConfigure") { (account: String, token: String, base: String) -> Bool in
      ChatOutbox.shared.configure(account: account, token: token, base: base)
      return true
    }

    /// item = JSON {cmi, conv, kind:'text'|'media', body:{…chat_send}, frame?, file?, up?} → "new" | estado | ""
    /// [e2ee5 WP-08a] conversa E2EE (flag e2ee5_native): cifra antes de gravar; "" = não entrou.
    AsyncFunction("outboxSubmit") { (account: String, itemJson: String, promise: Promise) in
      guard let d = itemJson.data(using: .utf8),
            let item = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { promise.resolve(""); return }
      ChatOutbox.shared.submitAsync(account: account, item: item) { st in promise.resolve(st) }
    }

    // ─── [e2ee5 WP-08a] E2EE nativo (sem conteúdo nas respostas) ────────────
    /// 0 = binário sem o núcleo; 1 = fila cifra / ingest decifra / ponte notificação+Siri.
    Function("e2eeNativeVersion") { () -> Int in
      return ChatyyE2EEGate.coreLinked ? 1 : 0
    }

    /// O JS soube do e2ee_mode (conv_e2ee/conversation_state): aquece o cache nativo.
    Function("e2eeNoteConv") { (account: String, conv: String, mode: Int) in
      if let u = ChatyyE2EEConvModes.uid(account: account) { ChatyyE2EEConvCache.shared.noteMode(uid: u, conv: conv, mode: mode) }
    }

    Function("e2eeStats") { () -> [String: Any] in
      return ChatyyE2EEIngest.shared.snapshot()
    }

    AsyncFunction("outboxList") { (account: String) -> String in
      return ChatOutbox.shared.list(account: account)
    }

    Function("outboxAck") { (account: String, cmi: String) in ChatOutbox.shared.ack(account: account, cmi: cmi) }
    Function("outboxRetry") { (account: String, cmi: String) in ChatOutbox.shared.retry(account: account, cmi: cmi) }
    Function("outboxCancel") { (account: String, cmi: String) in ChatOutbox.shared.cancel(account: account, cmi: cmi) }
    Function("outboxKick") { (reason: String) in ChatOutbox.shared.kick(reason) }
    Function("outboxStats") { () -> [String: Any] in return ChatOutbox.shared.snapshot() }
    /// [2026-10-23 midia-wa] BUILD: capacidades da fila (JS: r2DirectUpload.nativePutSupported). put_url = PUT direto no R2.
    Function("outboxCaps") { () -> [String: Any] in return ["v": 1, "put_url": true] }

    /// Logout: apaga credenciais (a tabela some com o wipe do store).
    Function("outboxForget") { () in ChatOutbox.shared.forgetAll() }

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
