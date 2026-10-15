package expo.modules.chatyyeffects

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-15 native-effects] Efeitos de tela cheia das mensagens (Android).
 * Mesmo contrato do iOS (ios/ChatyyEffectsModule.swift):
 *   play(name, {dark, emoji, intensity, x, y, w, h}) → Boolean (true = assumiu)
 *   stopAll()
 * Overlay = CEOverlayView no DecorView da Activity atual (não recebe toques).
 */
class ChatyyEffectsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyEffects")

    Function("apiVersion") { 1 }

    AsyncFunction("play") { name: String, opts: Map<String, Any?>? ->
      CEOverlayView.play(appContext.currentActivity, name, opts ?: emptyMap())
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stopAll") {
      CEOverlayView.stopAll(appContext.currentActivity)
    }.runOnQueue(Queues.MAIN)
  }
}
