package expo.modules.chatyymessagelist

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// [2026-10-14 native-list] Lista de mensagens nativa da conversa (Android).
// JS: components/chat/nativeThreadList.js (requireNativeView('ChatyyMessageList')).
class ChatyyMessageListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyMessageList")

    // 3 = [native-ctxmenu] menu de contexto nativo (prop ctxMenu,
    //     showContextMenu/dismissContextMenu, onMenuAction/onReact/onMenuDismiss).
    Function("apiVersion") { 3 }

    View(MLListView::class) {
      Events("onReady", "onNativeError", "onRowPress", "onRowLongPress", "onSwipeReply", "onLoadOlder", "onScrollState", "onDragState", "onVisible", "onMenuAction", "onReact", "onMenuDismiss")

      Prop("theme") { view: MLListView, v: Map<String, Any?>? -> view.setTheme(v ?: emptyMap()) }
      Prop("fontSize") { view: MLListView, v: Double? -> view.setFontSize(v) }
      Prop("lineHeight") { view: MLListView, v: Double? -> view.setLineHeight(v) }
      Prop("bubbleRadius") { view: MLListView, v: Double? -> view.setRadius(v) }
      Prop("dark") { view: MLListView, v: Boolean? -> view.setDarkHint(v) }
      Prop("ctxMenu") { view: MLListView, v: Boolean? -> view.setCtxMenu(v ?: false) }
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

      AsyncFunction("showContextMenu") { view: MLListView, payload: Map<String, Any?> ->
        view.showContextMenu(payload)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("dismissContextMenu") { view: MLListView ->
        view.dismissContextMenu()
      }.runOnQueue(Queues.MAIN)

      // [hero] frame atual da miniatura de uma mensagem (null = fora da tela)
      AsyncFunction("mediaFrame") { view: MLListView, messageId: String ->
        view.mediaFrame(messageId)
      }.runOnQueue(Queues.MAIN)
    }
  }
}
