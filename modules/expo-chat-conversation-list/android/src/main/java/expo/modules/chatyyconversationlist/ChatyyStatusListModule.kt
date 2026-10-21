package expo.modules.chatyyconversationlist

// [2026-10-15 native-lists] Aba STATUS nativa (Android). Mesmo contrato do
// iOS (ios/ChatyyStatusListModule.swift).

import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyStatusListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyStatusList")

    // 2 = [2026-10-21 pitada-azul] palette `ringNew`/`ringNew2` (anel NÃO visto em gradiente).
    Function("apiVersion") { 2 }

    View(ChatyyStatusListView::class) {
      Events(
        "onRowPress",
        "onRowPressIn",
        "onRowAction",
        "onLongPress",
        "onPeekOpen",
        "onRefresh",
        "onCollapsedChange",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyyStatusListView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("dark") { view: ChatyyStatusListView, v: Boolean? -> view.setDark(v ?: false) }
      Prop("labels") { view: ChatyyStatusListView, v: Map<String, Any?>? -> view.setLabelsProp(v) }
      Prop("palette") { view: ChatyyStatusListView, v: Map<String, Any?>? -> view.setPaletteProp(v) }
      Prop("authToken") { view: ChatyyStatusListView, v: String? -> view.setAuthToken(v) }
      Prop("headerHeight") { view: ChatyyStatusListView, v: Double? -> view.setHeaderHeightHint(v ?: 0.0) }
      Prop("footerHeight") { view: ChatyyStatusListView, v: Double? -> view.setFooterHeightHint(v ?: 0.0) }
      Prop("bottomInset") { view: ChatyyStatusListView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      Prop("collapseOffset") { view: ChatyyStatusListView, v: Double? -> view.collapseOffsetDp = (v ?: 34.0).toFloat() }
      Prop("refreshing") { view: ChatyyStatusListView, v: Boolean? -> view.setRefreshingProp(v ?: false) }
      Prop("refreshTint") { view: ChatyyStatusListView, v: String? -> view.setRefreshTint(v) }

      OnViewDidUpdateProps { view: ChatyyStatusListView -> view.commitProps() }

      GroupView<ChatyyStatusListView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
      }
    }
  }
}
