package expo.modules.chatyychatstore

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-15 native-store] API JS do store local nativo (fase 1). A leitura e a
 * escrita das fotos de conversa NÃO passam por aqui: a lista nativa
 * (expo-chat-message-list) chama ChatyyStoreDB direto. Aqui: gate, limpeza,
 * diagnóstico. Ver docs/native-store-DESIGN.md.
 */
class ChatyyChatStoreModule : Module() {
  private fun store(): ChatyyStoreDB? {
    val ctx = appContext.reactContext ?: return null
    return ChatyyStoreDB.get(ctx)
  }

  override fun definition() = ModuleDefinition {
    Name("ChatyyChatStore")

    // 2 = [fase 1.5/2] foto da home + pré-carga no toque + tabelas canônicas
    //     (applyBatchAsync) + operações na foto + messagesSync.
    Function("apiVersion") { 2 }

    AsyncFunction("applyBatchAsync") { account: String, json: String, promise: Promise ->
      val s = store()
      if (s == null) promise.resolve(mapOf("ok" to 0, "why" to "nostore"))
      else s.applyBatch(account, json) { out -> promise.resolve(out) }
    }

    Function("prewarmThread") { account: String, conv: String ->
      store()?.prewarmThread(account, conv)
      Unit
    }

    Function("homeTopSync") { account: String, scope: String ->
      store()?.homeTopSync(account, scope) ?: ""
    }

    Function("messagesSync") { account: String, conv: String, beforeId: Double, limit: Int ->
      store()?.messagesJSONSync(account, conv, beforeId.toLong(), limit) ?: "[]"
    }

    Function("threadNewestSync") { account: String, conv: String ->
      store()?.newestSync(account, conv) ?: ""
    }

    Function("statsSync") { account: String ->
      store()?.statsSync(account) ?: mapOf<String, Any>("threads" to 0, "rows" to 0, "bytes" to 0)
    }

    AsyncFunction("wipeAccount") { account: String ->
      store()?.wipeAccount(account)
      Unit
    }

    AsyncFunction("wipeAll") {
      store()?.wipeAll()
      Unit
    }
  }
}
