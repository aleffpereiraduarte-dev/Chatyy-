package expo.modules.chatyytransport

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-15 native-transport] Ponte JS do transporte realtime nativo
 * (ver ChatTransport.kt). Módulo separado ("ChatyyTransport") para o JS
 * detectar com requireOptionalNativeModule — binário sem ele → null →
 * WebSocket JS de sempre. Nada conecta até o JS chamar open().
 */
class ChatyyTransportModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyTransport")

    Events("onTransportFrames", "onTransportState", "onOutboxState")

    OnCreate {
      val self = this@ChatyyTransportModule
      ChatTransport.emitter = { name, body ->
        try { self.sendEvent(name, body) } catch (_: Throwable) {}
      }
      appContext.reactContext?.applicationContext?.let { ctx ->
        ChatTransport.init(ctx)
        // [fase 4] fila nativa: o motor sobrevive ao JS; só o canal de eventos é do JS.
        NativeOutbox.get(ctx).emitter = { body -> try { self.sendEvent("onOutboxState", body) } catch (_: Throwable) {} }
      }
    }

    OnDestroy {
      // Runtime JS indo embora (reload): a sessão é do JS → vai junto.
      ChatTransport.emitter = null
      ChatTransport.closeAll("module_destroy")
      NativeOutbox.peek()?.emitter = null
    }

    // ─── [2026-10-15 fase 4] fila de envio nativa ─────────────────────────
    /** Credenciais p/ reenviar sem o JS (persistidas, privadas). base = https (só chatyy.com.br e subdomínios) */
    Function("outboxConfigure") { account: String, token: String, base: String ->
      val ctx = appContext.reactContext?.applicationContext ?: return@Function false
      val b = if (OutboxCore.isUsableBase(base)) base else "https://chatyy.com.br"
      NativeOutbox.Creds.save(ctx, account, token, b)
      NativeOutbox.get(ctx).configure(account, token, b)
      true
    }

    /** item = JSON {cmi, conv, kind:'text'|'media', body:{…chat_send}, frame?, file?, up?}. → "new" | estado atual | "" */
    AsyncFunction("outboxSubmit") { account: String, itemJson: String ->
      val ctx = appContext.reactContext?.applicationContext ?: return@AsyncFunction ""
      val item = try { org.json.JSONObject(itemJson) } catch (_: Throwable) { return@AsyncFunction "" }
      val st = NativeOutbox.get(ctx).submit(account, item)
      // rede de segurança: processo morto antes do onStop → o Worker reenvia
      if (st == "new") NativeOutbox.scheduleWork(ctx, 15_000L)
      st
    }

    AsyncFunction("outboxList") { account: String ->
      val ctx = appContext.reactContext?.applicationContext ?: return@AsyncFunction "[]"
      NativeOutbox.get(ctx).list(account)
    }

    Function("outboxAck") { account: String, cmi: String -> NativeOutbox.peek()?.ack(account, cmi); Unit }
    Function("outboxRetry") { account: String, cmi: String -> NativeOutbox.peek()?.retry(account, cmi); Unit }
    Function("outboxCancel") { account: String, cmi: String -> NativeOutbox.peek()?.cancel(account, cmi); Unit }
    Function("outboxKick") { reason: String -> NativeOutbox.peek()?.kick(reason); Unit }

    Function("outboxStats") { NativeOutbox.peek()?.snapshot() ?: emptyMap<String, Any?>() }
    // [2026-10-23 midia-wa] BUILD: capacidades da fila (JS: r2DirectUpload.nativePutSupported). put_url = PUT direto no R2.
    Function("outboxCaps") { mapOf<String, Any?>("v" to 1, "put_url" to true) }

    /** Logout: apaga credenciais e cancela o Worker (a tabela some com o wipe do store). */
    Function("outboxForget") {
      appContext.reactContext?.applicationContext?.let { NativeOutbox.forgetAll(it) }
      Unit
    }

    Function("version") { ChatTransport.VERSION }

    /** Lança se a config for inválida (URL fora de *.chatyy.com.br etc.) → JS usa o WebSocket JS. */
    Function("open") { sid: String, config: Map<String, Any?> ->
      ChatTransport.open(sid, config)
      true
    }

    Function("send") { sid: String, text: String ->
      ChatTransport.send(sid, text)
    }

    Function("close") { sid: String, code: Int, reason: String ->
      ChatTransport.close(sid, code, reason)
    }

    Function("setHeartbeat") { sid: String, intervalMs: Double, deadlineMs: Double ->
      ChatTransport.setHeartbeat(sid, intervalMs.toLong(), deadlineMs.toLong())
    }

    Function("probe") { sid: String, ms: Double ->
      ChatTransport.probe(sid, ms.toLong())
    }

    Function("kick") { sid: String, reason: String, force: Boolean ->
      ChatTransport.kick(sid, reason, force)
    }

    Function("setAuthToken") { sid: String, token: String ->
      ChatTransport.setAuthToken(sid, token)
    }

    Function("getStats") {
      ChatTransport.snapshot()
    }
  }
}
