package expo.modules.chatyyconversationlist

// [2026-10-15 native-social] Aba CANAIS nativa (Android) — ChatyyChannelFeed.
// Mesmo contrato do iOS (ios/ChatyyChannelFeedModule.swift).

import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyChannelFeedModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyChannelFeed")

    Function("apiVersion") { 1 }

    View(ChatyyChannelFeedView::class) {
      Events(
        "onRowPress",
        "onRowAction",
        "onRefresh",
        "onEndReached",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyyChannelFeedView, v: Map<String, Any?>? -> view.core.setRowsPatch(v) }
      Prop("dark") { view: ChatyyChannelFeedView, v: Boolean? -> view.core.setDark(v ?: false) }
      Prop("labels") { view: ChatyyChannelFeedView, v: Map<String, Any?>? -> view.core.setLabels(v) }
      Prop("palette") { view: ChatyyChannelFeedView, v: Map<String, Any?>? -> view.core.setPalette(v) }
      Prop("authToken") { view: ChatyyChannelFeedView, v: String? -> view.core.setAuthToken(v) }
      Prop("headerHeight") { view: ChatyyChannelFeedView, v: Double? -> view.core.setHeaderHeightHint(v ?: 0.0) }
      Prop("footerHeight") { view: ChatyyChannelFeedView, v: Double? -> view.core.setFooterHeightHint(v ?: 0.0) }
      Prop("bottomInset") { view: ChatyyChannelFeedView, v: Double? -> view.core.setBottomInset(v ?: 0.0) }
      Prop("refreshing") { view: ChatyyChannelFeedView, v: Boolean? -> view.core.setRefreshing(v ?: false) }
      Prop("refreshTint") { view: ChatyyChannelFeedView, v: String? -> view.core.setRefreshTint(v) }
      Prop("quickReactions") { view: ChatyyChannelFeedView, v: List<String>? -> view.core.setQuick(v) }

      OnViewDidUpdateProps { view: ChatyyChannelFeedView -> view.commitProps() }

      GroupView<ChatyyChannelFeedView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
      }
    }
  }
}
