import ExpoModulesCore

// [2026-10-15 native-store] API JS do store local nativo (fase 1).
// Leitura/escrita das fotos de conversa NÃO passa por aqui: a lista nativa
// (ExpoChatMessageList) chama ChatyyStoreDB direto. Aqui só gate, limpeza e
// diagnóstico. Ver docs/native-store-DESIGN.md.
public class ChatyyChatStoreModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyChatStore")

    // 1 = fotos por conversa (thread_snap/thread_rows), 1 arquivo por conta.
    // 2 = [fase 1.5/2] foto da home + pré-carga no toque + tabelas canônicas
    //     (applyBatchAsync) + operações na foto + messagesSync.
    // 3 = [fase 2b/4] transporte nativo grava direto (ingestFrames), perfil de
    //     texto p/ linhas nativas (setThreadProfile), foto "desatualizada"
    //     (threadStaleSync), tabela outbox (fila de envio nativa).
    Function("apiVersion") { () -> Int in
      return 3
    }

    Function("setThreadProfile") { (account: String, conv: String, json: String) in
      ChatyyStoreDB.shared.setThreadProfile(account: account, conv: conv, json: json)
    }

    Function("clearThreadProfiles") { (account: String) in
      ChatyyStoreDB.shared.clearThreadProfiles(account: account)
    }

    Function("threadStaleSync") { (account: String, conv: String) -> Double in
      return Double(ChatyyStoreDB.shared.threadStaleSync(account: account, conv: conv))
    }

    /// Teste/diagnóstico: aplica frames crus do hub como o transporte faria.
    AsyncFunction("ingestFramesAsync") { (account: String, frames: [String], promise: Promise) in
      if frames.isEmpty { promise.resolve(["ok": 1, "messages": 0]); return }
      ChatyyStoreDB.shared.ingestFrames(account: account, frames: frames) { out in promise.resolve(out) }
    }

    // Lote do sync (1 string JSON). Resolve com {ok, messages, threads, convs}.
    AsyncFunction("applyBatchAsync") { (account: String, json: String, promise: Promise) in
      ChatyyStoreDB.shared.applyBatch(account: account, json: json) { out in promise.resolve(out) }
    }

    // pressIn da linha da home: foto decodificada em memória antes da navegação.
    Function("prewarmThread") { (account: String, conv: String) in
      ChatyyStoreDB.shared.prewarmThread(account: account, conv: conv)
    }

    Function("homeTopSync") { (account: String, scope: String) -> String in
      return ChatyyStoreDB.shared.homeTopSync(account: account, scope: scope)
    }

    Function("messagesSync") { (account: String, conv: String, beforeId: Double, limit: Int) -> String in
      return ChatyyStoreDB.shared.messagesJSONSync(account: account, conv: conv, beforeId: Int64(beforeId), limit: limit)
    }

    // [e2ee5 WP-08a] payloads decifrados pelo nativo (tabela e2e_plain). 1 = e2ePlainSync.
    Function("e2eeApiVersion") { () -> Int in
      return 1
    }

    /// ids = JSON "[id,…]" ("[]" = as 200 mais novas) → JSON {"<id>": {state, payload?, reason?, trust?, cmid}}.
    Function("e2ePlainSync") { (account: String, conv: String, idsJson: String) -> String in
      var ids: [Int64] = []
      if let d = idsJson.data(using: .utf8), let a = (try? JSONSerialization.jsonObject(with: d)) as? [Any] {
        for x in a {
          if let n = x as? NSNumber { ids.append(n.int64Value) } else if let s = x as? String, let v = Int64(s) { ids.append(v) }
        }
      }
      return ChatyyStoreDB.shared.e2ePlainJSONSync(account: account, conv: conv, ids: ids)
    }

    /// [e2ee5 reload-ota 2026-10-22] o JS grava o que ELE decifrou (histórico HTTP, enviadas pelo JS) na
    /// mesma tabela `e2e_plain` (mesmo arquivo/proteção). rows = JSON "[{conv, id, cmid?, payload, trust?}]".
    /// Assíncrono na fila do store; `ok` nunca regride. Sem payload/id = ignorado.
    Function("e2ePlainPut") { (account: String, json: String) -> Bool in
      guard !account.isEmpty, let d = json.data(using: .utf8),
            let a = (try? JSONSerialization.jsonObject(with: d)) as? [[String: Any]], !a.isEmpty else { return false }
      var rows: [[String: Any]] = []
      for r in a.prefix(500) {
        guard let p = r["payload"] as? String, !p.isEmpty else { continue }
        var o = r; o["state"] = "ok"; o["payload"] = p
        rows.append(o)
      }
      if rows.isEmpty { return false }
      ChatyyStoreDB.shared.e2ePut(account: account, rows: rows)
      return true
    }

    Function("threadNewestSync") { (account: String, conv: String) -> String in
      return ChatyyStoreDB.shared.newestSync(account: account, conv: conv)
    }

    Function("statsSync") { (account: String) -> [String: Any] in
      return ChatyyStoreDB.shared.statsSync(account: account)
    }

    AsyncFunction("wipeAccount") { (account: String) in
      ChatyyStoreDB.shared.wipeAccount(account)
    }

    AsyncFunction("wipeAll") { () in
      ChatyyStoreDB.shared.wipeAll()
    }
  }
}
