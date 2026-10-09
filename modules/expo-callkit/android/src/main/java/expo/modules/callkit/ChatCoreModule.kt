package expo.modules.callkit

import android.content.Context
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-07 native-core] JS bridge for ChatCoreSocket (phase 1, shadow).
 *
 * Separate Expo module ("ChatyyChatCore") so JS can capability-detect it with
 * requireOptionalNativeModule — binaries without it → null → no-op. It has no
 * init-order dependencies (no TurboModule probing): OnCreate only installs the
 * event listener; nothing connects until JS calls start().
 */
class ChatCoreModule : Module() {

  private val context: Context?
    get() = appContext.reactContext?.applicationContext

  override fun definition() = ModuleDefinition {
    Name("ChatyyChatCore")

    // [2026-10-08 native-core-2] + onChatCoreRaw (primary frames) / onChatCoreAck (outbox).
    Events("onChatCoreFrame", "onChatCoreState", "onChatCoreRaw", "onChatCoreAck")

    OnCreate {
      val self = this@ChatCoreModule
      ChatCoreSocket.listener = object : ChatCoreSocket.Listener {
        override fun onFrame(body: Map<String, Any?>) {
          try { self.sendEvent("onChatCoreFrame", body) } catch (_: Throwable) {}
        }
        override fun onState(body: Map<String, Any?>) {
          try { self.sendEvent("onChatCoreState", body) } catch (_: Throwable) {}
        }
        override fun onRaw(body: Map<String, Any?>) {
          try { self.sendEvent("onChatCoreRaw", body) } catch (_: Throwable) {}
        }
        override fun onAck(body: Map<String, Any?>) {
          try { self.sendEvent("onChatCoreAck", body) } catch (_: Throwable) {}
        }
      }
    }

    OnDestroy {
      // JS runtime going away (reload / process teardown). Phase 1 is
      // JS-driven, so the socket goes with it.
      ChatCoreSocket.listener = null
      try { ChatCoreSocket.setPrimary(false) } catch (_: Throwable) {}
      try {
        if (ChatCoreSocket.isRunning()) ChatCoreSocket.stop("module_destroy")
      } catch (_: Throwable) {}
    }

    /**
     * Protocol/feature version of the native core. 1 = shadow (phase 1);
     * 2 = + setPrimary / sendText / cancelSend (phase 2 groundwork).
     */
    Function("version") { 2 }

    Function("setPrimary") { on: Boolean ->
      try { ChatCoreSocket.setPrimary(on) } catch (_: Throwable) {}
    }

    AsyncFunction("sendText") { acct: String, cmi: String, frameJson: String ->
      val ctx = context
      if (ctx == null) {
        false
      } else {
        try {
          ChatCoreSocket.sendText(ctx, acct, cmi, frameJson)
        } catch (t: Throwable) {
          Log.w("ChatCoreModule", "sendText failed: ${t.message}")
          false
        }
      }
    }

    Function("cancelSend") { cmi: String ->
      try { ChatCoreSocket.cancelSend(cmi) } catch (_: Throwable) {}
    }

    AsyncFunction("start") { acct: String, lastEventId: Double, deviceId: String ->
      val ctx = context
      if (ctx == null) {
        false
      } else {
        try {
          ChatCoreSocket.start(ctx, acct, lastEventId.toLong(), deviceId)
          true
        } catch (t: Throwable) {
          Log.w("ChatCoreModule", "start failed: ${t.message}")
          false
        }
      }
    }

    AsyncFunction("stop") { reason: String ->
      try { ChatCoreSocket.stop(reason) } catch (_: Throwable) {}
    }

    Function("getState") {
      try { ChatCoreSocket.snapshot() } catch (_: Throwable) { mapOf<String, Any?>("enabled" to false) }
    }

    // [2026-10-09 native-transport] Região do WebSocket escolhida pelo JS
    // ("us" | "br" | "eu") → ChatCoreSocket / CallSignalWs / RelayWakeService
    // abrem na entrada regional (fallback US). Ver ChatyyWsEndpoint.kt.
    Function("setWsRegion") { region: String ->
      try { ChatyyWsEndpoint.setRegion(context, region) } catch (_: Throwable) {}
    }

    Function("getWsEndpoint") {
      try { ChatyyWsEndpoint.snapshot(context) } catch (_: Throwable) { mapOf<String, Any?>("url" to ChatyyWsEndpoint.US_URL) }
    }
  }
}
