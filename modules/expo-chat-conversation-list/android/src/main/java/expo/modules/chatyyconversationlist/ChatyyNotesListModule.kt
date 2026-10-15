package expo.modules.chatyyconversationlist

// [2026-10-15 native-notes] Módulo da lista/grade de NOTAS nativa (app/notes.js).
// Mesmo contrato do iOS (ios/ChatyyNotesListModule.swift).

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyNotesListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyNotesList")

    Function("apiVersion") { 1 }

    View(ChatyyNotesListView::class) {
      Events(
        "onRowPress",
        "onRowAction",
        "onRefresh",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyyNotesListView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("colors") { view: ChatyyNotesListView, v: Map<String, Any?>? -> view.setColorsProp(v) }
      Prop("highlight") { view: ChatyyNotesListView, v: String? -> view.setHighlightProp(v) }
      Prop("layoutMode") { view: ChatyyNotesListView, v: String? -> view.setLayoutModeProp(v) }
      Prop("labels") { view: ChatyyNotesListView, v: Map<String, Any?>? -> view.setLabelsProp(v) }
      Prop("menu") { view: ChatyyNotesListView, v: List<Any?>? -> view.setMenuProp(v) }
      Prop("swipeEnabled") { view: ChatyyNotesListView, v: Boolean? -> view.swipeEnabled = v ?: true }
      Prop("menuEnabled") { view: ChatyyNotesListView, v: Boolean? -> view.menuEnabled = v ?: true }
      Prop("refreshEnabled") { view: ChatyyNotesListView, v: Boolean? -> view.setRefreshEnabledProp(v ?: false) }
      Prop("refreshing") { view: ChatyyNotesListView, v: Boolean? -> view.setRefreshingProp(v ?: false) }
      Prop("topInset") { view: ChatyyNotesListView, v: Double? -> view.setTopInset(v ?: 0.0) }
      Prop("bottomInset") { view: ChatyyNotesListView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      // iOS: inset automático do header translúcido. Android: Toolbar sólida → no-op.
      Prop("autoInset") { _: ChatyyNotesListView, _: Boolean? -> }
      Prop("scrollToTopSeq") { view: ChatyyNotesListView, v: Double? -> view.setScrollToTopSeqProp(v ?: 0.0) }

      OnViewDidUpdateProps { view: ChatyyNotesListView -> view.commitProps() }
    }
  }
}
