package expo.modules.chatyyreelsfeed

// [2026-10-15 native-feed] Aba FEED (posts) nativa (Android). Mesmo contrato
// do iOS (ios/ChatyyPostFeedModule.swift).

import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyPostFeedModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyPostFeed")

    Function("apiVersion") { 1 }

    View(ChatyyPostFeedView::class) {
      Events(
        "onPostAction",
        "onEndReached",
        "onRefresh",
        "onScrollState",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyyPostFeedView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("dark") { view: ChatyyPostFeedView, v: Boolean? -> view.setDark(v ?: false) }
      Prop("labels") { view: ChatyyPostFeedView, v: Map<String, Any?>? -> view.setLabelsProp(v) }
      Prop("palette") { view: ChatyyPostFeedView, v: Map<String, Any?>? -> view.setPaletteProp(v) }
      Prop("imageHeaders") { view: ChatyyPostFeedView, v: Map<String, Any?>? -> view.setImageHeaders(v) }
      Prop("headerHeight") { view: ChatyyPostFeedView, v: Double? -> view.setHeaderHeightHint(v ?: 0.0) }
      Prop("footerHeight") { view: ChatyyPostFeedView, v: Double? -> view.setFooterHeightHint(v ?: 0.0) }
      Prop("bottomInset") { view: ChatyyPostFeedView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      Prop("refreshing") { view: ChatyyPostFeedView, v: Boolean? -> view.setRefreshingProp(v ?: false) }
      Prop("refreshTint") { view: ChatyyPostFeedView, v: String? -> view.setRefreshTint(v) }
      Prop("paused") { view: ChatyyPostFeedView, v: Boolean? -> view.setPausedProp(v ?: false) }
      Prop("scrollToTopSeq") { view: ChatyyPostFeedView, v: Double? -> view.setScrollToTopSeq(v ?: 0.0) }

      OnViewDidUpdateProps { view: ChatyyPostFeedView -> view.commitProps() }

      GroupView<ChatyyPostFeedView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
      }
    }
  }
}
