package expo.modules.chatyyconversationlist

// [2026-10-15 native-social] COMUNIDADES nativo (Android) — view
// ChatyyCommunityList. Mesmo contrato do iOS (ios/ChatyyCommunityListModule.swift).

import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyCommunityListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyCommunityList")

    Function("apiVersion") { 1 }

    View(ChatyyCommunityListView::class) {
      Events(
        "onRowPress",
        "onRowAction",
        "onLongPress",
        "onRefresh",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyyCommunityListView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("dark") { view: ChatyyCommunityListView, v: Boolean? -> view.setDark(v ?: false) }
      Prop("palette") { view: ChatyyCommunityListView, v: Map<String, Any?>? -> view.setPaletteProp(v) }
      Prop("authToken") { view: ChatyyCommunityListView, v: String? -> view.setAuthToken(v) }
      Prop("headerHeight") { view: ChatyyCommunityListView, v: Double? -> view.setHeaderHeightHint(v ?: 0.0) }
      Prop("footerHeight") { view: ChatyyCommunityListView, v: Double? -> view.setFooterHeightHint(v ?: 0.0) }
      Prop("bottomInset") { view: ChatyyCommunityListView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      Prop("refreshing") { view: ChatyyCommunityListView, v: Boolean? -> view.setRefreshingProp(v ?: false) }
      Prop("refreshTint") { view: ChatyyCommunityListView, v: String? -> view.setRefreshTint(v) }
      Prop("refreshEnabled") { view: ChatyyCommunityListView, v: Boolean? -> view.setRefreshEnabled(v ?: true) }

      OnViewDidUpdateProps { view: ChatyyCommunityListView -> view.commitProps() }

      GroupView<ChatyyCommunityListView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
      }
    }
  }
}
