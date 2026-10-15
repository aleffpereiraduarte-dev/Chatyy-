package expo.modules.chatyyconversationlist

// [2026-10-15 native-pins] Fileira nativa de conversas fixadas (Android).
// Mesmo contrato do iOS (ios/ChatyyPinnedStripModule.swift).

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyPinnedStripModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyPinnedStrip")

    Function("apiVersion") { 1 }

    View(ChatyyPinnedStripView::class) {
      Events(
        "onPinPress",
        "onPinPressIn",
        "onPinAction",
        "onPinLongPress",
        "onPeekRequest",
        "onPeekOpen",
        "onReorder",
        "onReorderDone",
        "onNativeError"
      )

      Prop("items") { view: ChatyyPinnedStripView, v: List<Any?>? -> view.setItemsProp(v) }
      Prop("dark") { view: ChatyyPinnedStripView, v: Boolean? -> view.setDark(v ?: false) }
      Prop("labels") { view: ChatyyPinnedStripView, v: Map<String, Any?>? -> view.setLabelsProp(v) }
      Prop("folders") { view: ChatyyPinnedStripView, v: List<Any?>? -> view.setFoldersProp(v) }
      Prop("peek") { _: ChatyyPinnedStripView, _: Map<String, Any?>? -> }
      Prop("avatarSize") { view: ChatyyPinnedStripView, v: Double? -> view.setAvatarSize(v ?: 72.0) }
      Prop("reorderMode") { view: ChatyyPinnedStripView, v: Boolean? -> view.setReorderModeProp(v ?: false) }
      Prop("selectionMode") { view: ChatyyPinnedStripView, v: Boolean? -> view.setSelectionModeProp(v ?: false) }
      Prop("menuEnabled") { view: ChatyyPinnedStripView, v: Boolean? -> view.menuEnabled = v ?: true }
      Prop("authToken") { view: ChatyyPinnedStripView, v: String? -> view.setAuthToken(v) }

      OnViewDidUpdateProps { view: ChatyyPinnedStripView -> view.commitProps() }
    }
  }
}
