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
