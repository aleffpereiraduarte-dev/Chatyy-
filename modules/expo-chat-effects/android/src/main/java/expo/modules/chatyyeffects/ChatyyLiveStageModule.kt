package expo.modules.chatyyeffects

import android.view.View
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-15 native-live] Palco NATIVO do espectador da live (Android).
 * Mesmo contrato do iOS (ios/ChatyyLiveStage*.swift):
 *   props  peekNext/peekPrev {title, subtitle, imageUrl, initials}, swipeEnabled,
 *          tapHearts, heartColors[], muted, showMute, controlsTop (dp), labels {mute, unmute}
 *   events onSwipe {direction}, onStageTap {x, y, color, double}, onMuteToggle {muted}
 *   view fns spawnHearts(items), burst({x,y}), playGift({kind,title,subtitle,count,color}), resetSwipe()
 * Filhos RN (tiles de vídeo do LiveKit) via GroupView — posicionados pelo Fabric.
 */
class ChatyyLiveStageModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyLiveStage")

    Function("apiVersion") { 1 }

    View(ChatyyLiveStageView::class) {
      Events("onSwipe", "onStageTap", "onMuteToggle")

      Prop("peekNext") { view: ChatyyLiveStageView, v: Map<String, Any?>? -> view.setPeek(true, v) }
      Prop("peekPrev") { view: ChatyyLiveStageView, v: Map<String, Any?>? -> view.setPeek(false, v) }
      Prop("swipeEnabled") { view: ChatyyLiveStageView, v: Boolean? -> view.swipeEnabled = v ?: true }
      Prop("tapHearts") { view: ChatyyLiveStageView, v: Boolean? -> view.tapHearts = v ?: true }
      Prop("heartColors") { view: ChatyyLiveStageView, v: List<String>? -> view.setHeartColors(v) }
      Prop("muted") { view: ChatyyLiveStageView, v: Boolean? -> view.setMutedProp(v ?: false) }
      Prop("showMute") { view: ChatyyLiveStageView, v: Boolean? -> view.setShowMute(v ?: false) }
      Prop("controlsTop") { view: ChatyyLiveStageView, v: Double? -> view.setControlsTop(v ?: 100.0) }
      Prop("labels") { view: ChatyyLiveStageView, v: Map<String, Any?>? -> view.setLabels(v) }

      AsyncFunction("spawnHearts") { view: ChatyyLiveStageView, items: List<Map<String, Any?>> ->
        view.spawnHearts(items)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("burst") { view: ChatyyLiveStageView, opts: Map<String, Any?>? ->
        view.burstFromJs(opts)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("playGift") { view: ChatyyLiveStageView, opts: Map<String, Any?> ->
        view.playGift(opts)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("resetSwipe") { view: ChatyyLiveStageView ->
        view.resetSwipe()
      }.runOnQueue(Queues.MAIN)

      // Só os filhos RN aparecem p/ o Fabric — peeks e botão mudo ficam fora dos índices.
      GroupView<ChatyyLiveStageView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
      }
    }
  }
}
