package expo.modules.chatyyconversationlist

// [2026-10-15 native-calls] Histórico da aba Ligações em NATIVO (Android).
// Mesmo contrato do iOS (ios/ChatyyCallListModule.swift).

import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyCallListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyCallList")

    Function("apiVersion") { 1 }

    View(ChatyyCallListView::class) {
      Events(
        "onRowPress",
        "onRowAction",
        "onCollapsedChange",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyyCallListView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("dark") { view: ChatyyCallListView, v: Boolean? -> view.setDark(v ?: false) }
      Prop("labels") { view: ChatyyCallListView, v: Map<String, Any?>? -> view.setLabelsProp(v) }
      Prop("authToken") { view: ChatyyCallListView, v: String? -> view.setAuthToken(v) }
      Prop("headerHeight") { view: ChatyyCallListView, v: Double? -> view.setHeaderHeightHint(v ?: 0.0) }
      Prop("bottomInset") { view: ChatyyCallListView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      Prop("collapseOffset") { view: ChatyyCallListView, v: Double? -> view.collapseOffsetDp = (v ?: 34.0).toFloat() }
      Prop("swipeEnabled") { view: ChatyyCallListView, v: Boolean? -> view.swipeEnabled = v ?: true }
      Prop("menuEnabled") { view: ChatyyCallListView, v: Boolean? -> view.menuEnabled = v ?: true }

      OnViewDidUpdateProps { view: ChatyyCallListView -> view.commitProps() }

      // Filhos RN: 0 = cabeçalho (título grande, chips, cartões), 1 = rodapé.
      GroupView<ChatyyCallListView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
      }
    }
  }
}
