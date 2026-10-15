package expo.modules.chatyyconversationlist

// [2026-10-15 native-drive] Módulo da lista/grade de ARQUIVOS nativa
// (app/drive.js, app/files.js). Mesmo contrato do iOS
// (ios/ChatyyDriveListModule.swift).

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyDriveListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyDriveList")

    Function("apiVersion") { 1 }

    View(ChatyyDriveListView::class) {
      Events(
        "onRowPress",
        "onRowAction",
        "onLongPress",
        "onRefresh",
        "onEndReached",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyyDriveListView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("mode") { view: ChatyyDriveListView, v: String? -> view.setModeProp(v) }
      Prop("columns") { view: ChatyyDriveListView, v: Double? -> view.setColumnsProp((v ?: 0.0).toInt()) }
      Prop("selectionMode") { view: ChatyyDriveListView, v: Boolean? -> view.setSelectionModeProp(v ?: false) }
      Prop("selectedIds") { view: ChatyyDriveListView, v: List<String>? -> view.setSelectedIdsProp(v) }
      Prop("uploads") { view: ChatyyDriveListView, v: List<Map<String, Any?>>? -> view.setUploadsProp(v) }
      Prop("labels") { view: ChatyyDriveListView, v: Map<String, Any?>? -> view.setLabelsProp(v) }
      Prop("highlight") { view: ChatyyDriveListView, v: String? -> view.setHighlightProp(v) }
      Prop("colors") { view: ChatyyDriveListView, v: Map<String, Any?>? -> view.setColorsProp(v) }
      Prop("refreshEnabled") { view: ChatyyDriveListView, v: Boolean? -> view.setRefreshEnabledProp(v ?: true) }
      Prop("refreshing") { view: ChatyyDriveListView, v: Boolean? -> view.setRefreshingProp(v ?: false) }
      Prop("topInset") { view: ChatyyDriveListView, v: Double? -> view.setTopInset(v ?: 0.0) }
      Prop("bottomInset") { view: ChatyyDriveListView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      Prop("scrollToTopSeq") { view: ChatyyDriveListView, v: Double? -> view.setScrollToTopSeqProp(v ?: 0.0) }
      Prop("authToken") { view: ChatyyDriveListView, v: String? -> view.setAuthToken(v) }
      // iOS: inset automático do header translúcido. Android: Toolbar sólida → no-op.
      Prop("autoInset") { _: ChatyyDriveListView, _: Boolean? -> }

      OnViewDidUpdateProps { view: ChatyyDriveListView -> view.commitProps() }
    }
  }
}
