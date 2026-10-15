package expo.modules.chatyyconversationlist

// [2026-10-15 native-search-notifs] Módulo da lista de RESULTADOS nativa
// (busca global + central de notificações). Mesmo contrato do iOS
// (ios/ChatyyResultListModule.swift).

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyResultListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyResultList")

    Function("apiVersion") { 1 }

    View(ChatyyResultListView::class) {
      Events(
        "onRowPress",
        "onRowAction",
        "onRefresh",
        "onEndReached",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyyResultListView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("colors") { view: ChatyyResultListView, v: Map<String, Any?>? -> view.setColorsProp(v) }
      Prop("highlight") { view: ChatyyResultListView, v: String? -> view.setHighlightProp(v) }
      Prop("separators") { view: ChatyyResultListView, v: Boolean? -> view.setSeparatorsProp(v ?: false) }
      Prop("swipeEnabled") { view: ChatyyResultListView, v: Boolean? -> view.swipeEnabled = v ?: true }
      Prop("refreshEnabled") { view: ChatyyResultListView, v: Boolean? -> view.setRefreshEnabledProp(v ?: false) }
      Prop("refreshing") { view: ChatyyResultListView, v: Boolean? -> view.setRefreshingProp(v ?: false) }
      Prop("topInset") { view: ChatyyResultListView, v: Double? -> view.setTopInset(v ?: 0.0) }
      Prop("bottomInset") { view: ChatyyResultListView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      Prop("scrollToTopSeq") { view: ChatyyResultListView, v: Double? -> view.setScrollToTopSeqProp(v ?: 0.0) }
      // iOS: inset automático do header translúcido. Android: Toolbar sólida → no-op.
      Prop("autoInset") { _: ChatyyResultListView, _: Boolean? -> }
      Prop("authToken") { view: ChatyyResultListView, v: String? -> view.setAuthToken(v) }

      OnViewDidUpdateProps { view: ChatyyResultListView -> view.commitProps() }
    }
  }
}
