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

    Events("onTransportFrames", "onTransportState")

    OnCreate {
      val self = this@ChatyyTransportModule
      ChatTransport.emitter = { name, body ->
        try { self.sendEvent(name, body) } catch (_: Throwable) {}
      }
      appContext.reactContext?.applicationContext?.let { ChatTransport.init(it) }
    }

    OnDestroy {
      // Runtime JS indo embora (reload): a sessão é do JS → vai junto.
      ChatTransport.emitter = null
      ChatTransport.closeAll("module_destroy")
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
