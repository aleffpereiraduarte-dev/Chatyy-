package expo.modules.chatyymessagelist

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// [2026-10-14 native-list] Lista de mensagens nativa da conversa (Android).
// JS: components/chat/nativeThreadList.js (requireNativeView('ChatyyMessageList')).
class ChatyyMessageListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyMessageList")

    Function("apiVersion") { 2 }

    View(MLListView::class) {
      Events("onReady", "onNativeError", "onRowPress", "onRowLongPress", "onSwipeReply", "onLoadOlder", "onScrollState", "onDragState", "onVisible")

      Prop("theme") { view: MLListView, v: Map<String, Any?>? -> view.setTheme(v ?: emptyMap()) }
      Prop("fontSize") { view: MLListView, v: Double? -> view.setFontSize(v) }
      Prop("lineHeight") { view: MLListView, v: Double? -> view.setLineHeight(v) }
      Prop("bubbleRadius") { view: MLListView, v: Double? -> view.setRadius(v) }
      Prop("dark") { _: MLListView, _: Boolean? -> }
      Prop("keyboardDismissMode") { view: MLListView, v: String? -> view.setKeyboardDismissMode(v) }
      Prop("bottomInset") { view: MLListView, v: Double? -> view.setInsets(v, null) }
      Prop("topInset") { view: MLListView, v: Double? -> view.setInsets(null, v) }
      // [fase 2]
      Prop("stickyDate") { view: MLListView, v: Map<String, Any?>? -> view.setStickyDate(v) }

      OnViewDestroys { view: MLListView -> view.destroy() }

      AsyncFunction("applyRows") { view: MLListView, payload: Map<String, Any?> ->
        view.applyRows(payload)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("scrollToLatest") { view: MLListView, animated: Boolean ->
        view.scrollToLatest(animated)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("scrollToKey") { view: MLListView, key: String, viewPosition: Double, animated: Boolean ->
        view.scrollToKey(key, viewPosition, animated)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("flashKey") { view: MLListView, key: String ->
        view.flashKey(key)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("setAudioState") { view: MLListView, state: Map<String, Any?> ->
        view.setAudioState(state)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("setLiftedKey") { view: MLListView, key: String ->
        view.setLiftedKey(key)
      }.runOnQueue(Queues.MAIN)
    }
  }
}
