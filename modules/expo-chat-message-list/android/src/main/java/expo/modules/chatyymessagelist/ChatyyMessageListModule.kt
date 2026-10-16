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
    // 4 = [native-store] prop `store` {a,c,r,n} + evento onStore; onReady traz src.
    // 5 = [native-media-dl] download nativo com anel (row.media/au/file/album[].dl),
    //     configureTransfers, setTransfers, onMediaTransfer, onRowPress part 'xfer'.
    // 6 = [wave13-C a11y] linha ax (rótulo do TalkBack) + aa (máscara de ações
    //     1 responder/2 reagir/4 copiar/8 encaminhar/16 mais) + prop a11y (nomes +
    //     hint). responder → onSwipeReply dir 'reply'; reagir/mais → onRowLongPress
    //     (a11y: id); copiar/encaminhar → onRowPress part 'a11y' url id; clique do
    //     TalkBack → toque na parte principal.
    Function("apiVersion") { 6 }

    // [native-media-dl] pasta do cache do mediaCache + matriz de auto-download +
    // economia de dados + modelo "{a} de {b}" traduzido.
    AsyncFunction("configureTransfers") { cfg: Map<String, Any?> ->
      MLTransfers.configure(cfg)
    }.runOnQueue(Queues.MAIN)

    View(MLListView::class) {
      Events("onReady", "onNativeError", "onRowPress", "onRowLongPress", "onSwipeReply", "onLoadOlder", "onScrollState", "onDragState", "onVisible", "onMenuAction", "onReact", "onMenuDismiss", "onStore", "onMediaTransfer")

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
      Prop("store") { view: MLListView, v: Map<String, Any?>? -> view.setStore(v) }
      Prop("a11y") { view: MLListView, v: Map<String, Any?>? -> view.setA11yLabels(v) }

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

      // [native-media-dl] progresso de transferências feitas pelo JS → o mesmo anel
      AsyncFunction("setTransfers") { view: MLListView, list: List<Map<String, Any?>> ->
        view.setTransfers(list)
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

      // [reply-v2] "Citar trecho" nativo → resolve com o trecho ("" = cancelou)
      AsyncFunction("showQuotePicker") { _: MLListView, payload: Map<String, Any?>, promise: expo.modules.kotlin.Promise ->
        MLQuotePicker.present(appContext.currentActivity, payload) { promise.resolve(it) }
      }.runOnQueue(Queues.MAIN)

      // [hero] frame atual da miniatura de uma mensagem (null = fora da tela)
      AsyncFunction("mediaFrame") { view: MLListView, messageId: String ->
        view.mediaFrame(messageId)
      }.runOnQueue(Queues.MAIN)
    }
  }
}
