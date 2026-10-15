package expo.modules.chatyyconversationlist

// [2026-10-15 native-inbox] Módulo da caixa de entrada do e-mail nativa
// (Android). Mesmo contrato do iOS (ios/ChatyyEmailListModule.swift).

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyEmailListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyEmailList")

    Function("apiVersion") { 1 }

    View(ChatyyEmailListView::class) {
      Events(
        "onRowPress",
        "onLeftPress",
        "onStarPress",
        "onRowAction",
        "onLongPress",
        "onPeekRequest",
        "onPeekOpen",
        "onRefresh",
        "onEndReached",
        "onVisibleIds",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyyEmailListView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("dark") { view: ChatyyEmailListView, v: Boolean? -> view.setDark(v ?: false) }
      Prop("palette") { view: ChatyyEmailListView, v: Map<String, Any?>? -> view.setPaletteProp(v) }
      Prop("density") { view: ChatyyEmailListView, v: Map<String, Any?>? -> view.setDensityProp(v) }
      Prop("labels") { view: ChatyyEmailListView, v: Map<String, Any?>? -> view.setLabelsProp(v) }
      Prop("selectionMode") { view: ChatyyEmailListView, v: Boolean? -> view.setSelectionModeProp(v ?: false) }
      Prop("authToken") { view: ChatyyEmailListView, v: String? -> view.setAuthToken(v) }
      Prop("peek") { view: ChatyyEmailListView, v: Map<String, Any?>? -> view.setPeekProp(v) }
      Prop("swipeEnabled") { view: ChatyyEmailListView, v: Boolean? -> view.swipeEnabled = v ?: true }
      Prop("menuEnabled") { view: ChatyyEmailListView, v: Boolean? -> view.menuEnabled = v ?: true }
      Prop("refreshing") { view: ChatyyEmailListView, v: Boolean? -> view.setRefreshingProp(v ?: false) }
      Prop("loadingMore") { view: ChatyyEmailListView, v: Boolean? -> view.setLoadingMoreProp(v ?: false) }
      Prop("bottomInset") { view: ChatyyEmailListView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      Prop("scrollToTopSeq") { view: ChatyyEmailListView, v: Double? -> view.setScrollToTopSeqProp(v ?: 0.0) }

      OnViewDidUpdateProps { view: ChatyyEmailListView -> view.commitProps() }
    }
  }
}
