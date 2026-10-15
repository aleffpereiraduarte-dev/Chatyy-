package expo.modules.chatyyconversationlist

// [2026-10-15 native-wallet] Carteira em NATIVO (Android). Mesmo contrato do
// iOS (ios/ChatyyWalletListModule.swift).

import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyWalletListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyWalletList")

    Function("apiVersion") { 1 }

    View(ChatyyWalletListView::class) {
      Events(
        "onRowPress",
        "onRowAction",
        "onHeroAction",
        "onRefresh",
        "onEndReached",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyyWalletListView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("hero") { view: ChatyyWalletListView, v: Map<String, Any?>? -> view.setHero(v) }
      Prop("colors") { view: ChatyyWalletListView, v: Map<String, Any?>? -> view.setColors(v) }
      Prop("dark") { view: ChatyyWalletListView, v: Boolean? -> view.setDark(v ?: false) }
      Prop("headerHeight") { view: ChatyyWalletListView, v: Double? -> view.setHeaderHeightHint(v ?: 0.0) }
      Prop("heroInsets") { view: ChatyyWalletListView, v: Map<String, Any?>? ->
        val top = if (v?.get("top") == null) 16.0 else CLVal.double(v["top"])
        val gap = if (v?.get("gap") == null) 16.0 else CLVal.double(v["gap"])
        view.setHeroInsets(top, gap)
      }
      Prop("bottomInset") { view: ChatyyWalletListView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      Prop("maxContentWidth") { view: ChatyyWalletListView, v: Double? -> view.setMaxContentWidth(v ?: 0.0) }
      // iOS-only (inset automático do header nativo); aceito e ignorado aqui.
      Prop("autoInset") { _: ChatyyWalletListView, _: Boolean? -> }
      Prop("refreshEnabled") { view: ChatyyWalletListView, v: Boolean? -> view.setRefreshEnabled(v ?: true) }
      Prop("refreshing") { view: ChatyyWalletListView, v: Boolean? -> view.setRefreshing(v ?: false) }
      Prop("authToken") { _: ChatyyWalletListView, v: String? -> if (!v.isNullOrEmpty()) CLAuth.token = v }

      OnViewDidUpdateProps { view: ChatyyWalletListView -> view.commitProps() }

      // Filho RN 0 = blocos JS (ganhos, mais vendidos, filtros), abaixo do herói.
      GroupView<ChatyyWalletListView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
      }
    }
  }
}
