package expo.modules.chatyyconversationlist

// [2026-10-15 native-social] Aba CANAIS nativa (Android) — ChatyyChannelList.
// Mesmo contrato do iOS (ios/ChatyyChannelListModule.swift).

import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyChannelListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyChannelList")

    Function("apiVersion") { 1 }

    View(ChatyyChannelListView::class) {
      Events(
        "onRowPress",
        "onRowAction",
        "onRefresh",
        "onEndReached",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyyChannelListView, v: Map<String, Any?>? -> view.core.setRowsPatch(v) }
      Prop("dark") { view: ChatyyChannelListView, v: Boolean? -> view.core.setDark(v ?: false) }
      Prop("labels") { view: ChatyyChannelListView, v: Map<String, Any?>? -> view.core.setLabels(v) }
      Prop("palette") { view: ChatyyChannelListView, v: Map<String, Any?>? -> view.core.setPalette(v) }
      Prop("authToken") { view: ChatyyChannelListView, v: String? -> view.core.setAuthToken(v) }
      Prop("headerHeight") { view: ChatyyChannelListView, v: Double? -> view.core.setHeaderHeightHint(v ?: 0.0) }
      Prop("footerHeight") { view: ChatyyChannelListView, v: Double? -> view.core.setFooterHeightHint(v ?: 0.0) }
      Prop("bottomInset") { view: ChatyyChannelListView, v: Double? -> view.core.setBottomInset(v ?: 0.0) }
      Prop("refreshing") { view: ChatyyChannelListView, v: Boolean? -> view.core.setRefreshing(v ?: false) }
      Prop("refreshTint") { view: ChatyyChannelListView, v: String? -> view.core.setRefreshTint(v) }


      OnViewDidUpdateProps { view: ChatyyChannelListView -> view.commitProps() }

      GroupView<ChatyyChannelListView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
      }
    }
  }
}
