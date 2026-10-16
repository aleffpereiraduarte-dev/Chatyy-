package expo.modules.chatyyrowzoom

import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [wave8 row-zoom] "A conversa cresce a partir da linha" (Android).
 * Mesmo contrato do iOS (ios/ChatyyRowZoomModule.swift):
 *   begin({x, y, w, h (px, coords da janela), dark, radius (dp), dim, maxWait (ms)}) → Boolean
 *   ready()   casca da conversa pintou → começa a animar
 *   cancel()  some com o overlay (fade curto)
 *   evento onZoomEnd {ok}
 * Overlay = RZOverlayView no DecorView (PixelCopy da janela, API 26+).
 * O push da rota roda com animation:'none' por baixo; nada de Fragment/
 * RNScreens é tocado. Falhou qualquer coisa → false e o JS faz o push padrão.
 */
class ChatyyRowZoomModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyRowZoom")

    Events("onZoomEnd")

    Function("apiVersion") { 1 }

    AsyncFunction("begin") { opts: Map<String, Any?>, promise: Promise ->
      RZOverlayView.begin(
        appContext.currentActivity,
        opts,
        { ok -> promise.resolve(ok) },
        { ok -> try { sendEvent("onZoomEnd", mapOf("ok" to ok)) } catch (_: Throwable) {} }
      )
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("ready") {
      RZOverlayView.ready()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("cancel") {
      RZOverlayView.cancel()
    }.runOnQueue(Queues.MAIN)
  }
}
