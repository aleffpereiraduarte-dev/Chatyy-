package expo.modules.chatyyprivacy

import android.app.Application
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// [2026-10-15 screen-protect-all] Lado Android do expo-chat-privacy.
//   apiVersion() → 2
//   setAppProtection(enabled, labels) → Boolean efetivo   (persistido p/ o cold start)
//   getAppProtection() → { supported, enabled, effective, sharing }
//   setLocalTag(tag, on)  — conversa protegida/visualizador (vale mesmo com o global desligado)
//   reassert()            — re-aplica depois de um allowScreenCaptureAsync do expo-screen-capture
//   resetLocalTags(keep)  — [2026-10-22 print-local] boot do JS: solta as tags órfãs
//   evento onProtectChange { effective, sharing }
// O escudo de gravação (setShield) é só iOS — aqui é no-op (o FLAG_SECURE já
// deixa a gravação preta).
class ExpoChatPrivacyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoChatPrivacy")

    Events("onCaptureChange", "onProtectChange", "onScreenshotBlocked")

    OnCreate {
      // Normalmente já instalado pelo ExpoChatPrivacyPackage; rede de segurança.
      try {
        (appContext.reactContext?.applicationContext as? Application)?.let { ScreenProtectHub.install(it) }
      } catch (_: Throwable) {}
      ScreenProtectHub.listener = { effective, sharing ->
        try { sendEvent("onProtectChange", mapOf("effective" to effective, "sharing" to sharing)) } catch (_: Throwable) {}
      }
      // [2026-10-22 print-local] runtime do JS novo (cold start, reload, OTA):
      // tags locais do runtime anterior ficaram órfãs → zera (o JS pede de novo).
      ScreenProtectHub.resetLocalTags(emptyList())
    }

    OnDestroy {
      ScreenProtectHub.listener = null
    }

    Function("apiVersion") { 2 }

    Function("isCaptured") { false }

    AsyncFunction("setShield") { _: String, _: Boolean, _: String, _: String -> false }

    AsyncFunction("clearShields") { true }

    AsyncFunction("setAppProtection") { enabled: Boolean, _: Map<String, Any?> ->
      ScreenProtectHub.setGlobal(enabled)
      ScreenProtectHub.effective()
    }

    AsyncFunction("getAppProtection") {
      mapOf(
        "supported" to true,
        "enabled" to ScreenProtectHub.isGlobal(),
        "effective" to ScreenProtectHub.effective(),
        "sharing" to ScreenProtectHub.isSharing(),
      )
    }

    AsyncFunction("setLocalTag") { tag: String, on: Boolean ->
      ScreenProtectHub.setLocalTag(tag, on)
      true
    }

    // [2026-10-22 print-local] boot do JS: fica só com `keep`.
    AsyncFunction("resetLocalTags") { keep: List<String> ->
      ScreenProtectHub.resetLocalTags(keep)
      true
    }

    AsyncFunction("reassert") {
      ScreenProtectHub.reassert()
      true
    }
  }
}
