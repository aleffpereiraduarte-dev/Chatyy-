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
    // 3 = [fase 2b/4] transporte nativo grava direto (ingestFrames), perfil de
    //     texto p/ linhas nativas (setThreadProfile), foto "desatualizada"
    //     (threadStaleSync), tabela outbox (fila de envio nativa).
    Function("apiVersion") { 3 }

    Function("setThreadProfile") { account: String, conv: String, json: String ->
      store()?.setThreadProfile(account, conv, json)
      Unit
    }

    Function("clearThreadProfiles") { account: String ->
      store()?.clearThreadProfiles(account)
      Unit
    }

    Function("threadStaleSync") { account: String, conv: String ->
      (store()?.threadStaleSync(account, conv) ?: 0L).toDouble()
    }

    /** Teste/diagnóstico: aplica frames crus do hub como o transporte faria. */
    AsyncFunction("ingestFramesAsync") { account: String, frames: List<String>, promise: Promise ->
      val s = store()
      if (s == null) promise.resolve(mapOf("ok" to 0, "why" to "nostore"))
      else s.ingestFrames(account, frames) { out -> promise.resolve(out) }
    }

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

    // ─── [e2ee5 WP-08b] E2EE nativo (sem mudar apiVersion: o JS detecta pela função) ───
    /** {id: payloadJson} decifrados pelo nativo (transporte/push/2º plano). ids = "[1,2,…]". */
    Function("e2ePlainSync") { account: String, conv: String, idsJson: String ->
      val ids = try { org.json.JSONArray(idsJson).let { a -> (0 until a.length()).map { a.optLong(it) } } } catch (_: Throwable) { emptyList() }
      store()?.e2ePlainMany(account, conv, ids) ?: "{}"
    }

    /**
     * [e2ee5 reload-ota 2026-10-22] o JS grava o que ELE decifrou na mesma tabela `e2e_plain`
     * (noBackupFilesDir, mesmo arquivo do store), fora da thread do JS. rows = JSON "[{conv, id, cmid?, payload, trust?}]".
     */
    AsyncFunction("e2ePlainPut") { account: String, json: String ->
      val st = store() ?: return@AsyncFunction false
      if (account.isEmpty()) return@AsyncFunction false
      val a = try { org.json.JSONArray(json) } catch (_: Throwable) { return@AsyncFunction false }
      var n = 0
      for (i in 0 until minOf(a.length(), 500)) {
        val r = a.optJSONObject(i) ?: continue
        val conv = r.optString("conv"); val id = r.optLong("id"); val payload = r.optString("payload")
        if (conv.isEmpty() || id <= 0 || payload.isEmpty()) continue
        st.e2ePlainPut(account, conv, id, r.optString("cmid"), payload, r.optString("trust"))
        n++
      }
      n > 0
    }

    /** Eventos `chatyy.*` recebidos num sync NATIVO (JS parado) — entrega e apaga. */
    Function("e2eEventsDrain") { account: String -> store()?.e2eEventsDrain(account) ?: "[]" }

    /** Diagnóstico (sem segredos): núcleo linkado, gate da conta, pendentes. */
    Function("e2eInfo") { account: String ->
      val ctx = appContext.reactContext ?: return@Function mapOf<String, Any?>("coreLinked" to false)
      E2eeNative.info(ctx, account)
    }

    /** Flag/conta mudou (status()/logout): esquece os caches de gate e de estado de conversa. */
    Function("e2eInvalidate") { E2eeNative.invalidateAll(); Unit }

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
