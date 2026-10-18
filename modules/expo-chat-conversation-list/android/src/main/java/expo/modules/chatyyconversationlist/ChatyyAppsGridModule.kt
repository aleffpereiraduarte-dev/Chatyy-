package expo.modules.chatyyconversationlist

// [2026-10-18 native-apps-grid] Painel "Apps" nativo (Android). Mesmo contrato
// do iOS (ios/ChatyyAppsGridModule.swift) — ver ChatyyAppsGridView.kt e
// components/apps/NativeAppsGrid.js.

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyAppsGridModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyAppsGrid")

    Function("apiVersion") { 1 }

    View(ChatyyAppsGridView::class) {
      Events(
        "onAppPress", "onEditingChange", "onPinnedChange", "onQueryChange",
        "onContentHeight", "onPullDismiss", "onNativeError"
      )

      Prop("sections") { view: ChatyyAppsGridView, v: List<Any?>? -> view.setSectionsProp(v) }
      Prop("recent") { view: ChatyyAppsGridView, v: List<Any?>? -> view.setRecentProp(v) }
      Prop("pinned") { view: ChatyyAppsGridView, v: List<Any?>? -> view.setPinnedProp(v) }
      Prop("badges") { view: ChatyyAppsGridView, v: Map<String, Any?>? -> view.setBadgesProp(v) }
      Prop("labels") { view: ChatyyAppsGridView, v: Map<String, Any?>? -> view.setLabelsProp(v) }
      Prop("dark") { view: ChatyyAppsGridView, v: Boolean? -> view.setDark(v ?: false) }
      Prop("editing") { view: ChatyyAppsGridView, v: Boolean? -> view.setEditingProp(v ?: false) }
      Prop("bottomInset") { view: ChatyyAppsGridView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      Prop("resetSeq") { view: ChatyyAppsGridView, v: Double? -> view.setResetSeq(v ?: 0.0) }
      Prop("searchEnabled") { view: ChatyyAppsGridView, v: Boolean? -> view.setSearchEnabled(v ?: true) }

      OnViewDidUpdateProps { view: ChatyyAppsGridView -> view.commitProps() }
    }
  }
}
