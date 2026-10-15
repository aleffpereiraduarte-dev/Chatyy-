package expo.modules.chatyyconversationlist

// [2026-10-15 native-contacts] Módulo da lista de contatos nativa (Android).
// Mesmo contrato do iOS (ios/ChatyyContactListModule.swift).

import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyContactListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyContactList")

    // 2 = [2026-10-15 native-group-create] check animado + haptic, glifos por
    //     nome (`gl`), view irmã ChatyyChipStrip.
    Function("apiVersion") { 2 }

    View(ChatyyContactListView::class) {
      Events(
        "onRowPress",
        "onRowLongPress",
        "onRowAction",
        "onRefresh",
        "onEndReached",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyyContactListView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("colors") { view: ChatyyContactListView, v: Map<String, Any?>? -> view.setColorsProp(v) }
      Prop("metrics") { view: ChatyyContactListView, v: Map<String, Any?>? -> view.setMetricsProp(v) }
      Prop("indexEnabled") { view: ChatyyContactListView, v: Boolean? -> view.setIndexEnabled(v ?: true) }
      Prop("indexMin") { view: ChatyyContactListView, v: Double? -> view.setIndexMin(v ?: 6.0) }
      Prop("refreshEnabled") { view: ChatyyContactListView, v: Boolean? -> view.setRefreshEnabledProp(v ?: false) }
      Prop("refreshing") { view: ChatyyContactListView, v: Boolean? -> view.setRefreshingProp(v ?: false) }
      Prop("swipeEnabled") { view: ChatyyContactListView, v: Boolean? -> view.swipeEnabled = v ?: true }
      Prop("headerHeight") { view: ChatyyContactListView, v: Double? -> view.setHeaderHeightHint(v ?: 0.0) }
      Prop("footerHeight") { view: ChatyyContactListView, v: Double? -> view.setFooterHeightHint(v ?: 0.0) }
      Prop("bottomInset") { view: ChatyyContactListView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      Prop("scrollToTopSeq") { view: ChatyyContactListView, v: Double? -> view.setScrollToTopSeqProp(v ?: 0.0) }

      OnViewDidUpdateProps { view: ChatyyContactListView -> view.commitProps() }

      GroupView<ChatyyContactListView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
      }
    }
  }
}
