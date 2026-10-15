package expo.modules.chatyyconversationlist

// [2026-10-15 native-social] COMUNIDADES nativo (Android) — view
// ChatyyCommunityDetail. Mesmo contrato do iOS (ios/ChatyyCommunityDetailModule.swift).

import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyCommunityDetailModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyCommunityDetail")

    Function("apiVersion") { 1 }

    View(ChatyyCommunityDetailView::class) {
      Events(
        "onRowPress",
        "onRowAction",
        "onLongPress",
        "onRefresh",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyyCommunityDetailView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("dark") { view: ChatyyCommunityDetailView, v: Boolean? -> view.setDark(v ?: false) }
      Prop("palette") { view: ChatyyCommunityDetailView, v: Map<String, Any?>? -> view.setPaletteProp(v) }
      Prop("authToken") { view: ChatyyCommunityDetailView, v: String? -> view.setAuthToken(v) }
      Prop("headerHeight") { view: ChatyyCommunityDetailView, v: Double? -> view.setHeaderHeightHint(v ?: 0.0) }
      Prop("footerHeight") { view: ChatyyCommunityDetailView, v: Double? -> view.setFooterHeightHint(v ?: 0.0) }
      Prop("bottomInset") { view: ChatyyCommunityDetailView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      Prop("refreshing") { view: ChatyyCommunityDetailView, v: Boolean? -> view.setRefreshingProp(v ?: false) }
      Prop("refreshTint") { view: ChatyyCommunityDetailView, v: String? -> view.setRefreshTint(v) }
      Prop("refreshEnabled") { view: ChatyyCommunityDetailView, v: Boolean? -> view.setRefreshEnabled(v ?: true) }

      OnViewDidUpdateProps { view: ChatyyCommunityDetailView -> view.commitProps() }

      GroupView<ChatyyCommunityDetailView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
      }
    }
  }
}
