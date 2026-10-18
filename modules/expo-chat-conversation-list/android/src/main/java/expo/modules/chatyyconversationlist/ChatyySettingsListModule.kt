package expo.modules.chatyyconversationlist

// [2026-10-15 settings-native] Raiz das Configurações em NATIVO (Android).
// Mesmo contrato do iOS (ios/ChatyySettingsListModule.swift).

import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyySettingsListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyySettingsList")

    // 2 = [2026-10-18 settings-sub-native] val/acc/dis/tl/sl/ft, k "i", ícones do
    //     ChatInfo e prop scrollToId (sub-páginas das Configurações em nativo).
    // 3 = [2026-10-18 bia-orb-icon] ícone "biaOrb" (orb da Bia, drawable ccl_bia_orb).
    Function("apiVersion") { 3 }

    View(ChatyySettingsListView::class) {
      Events(
        "onRowPress",
        "onToggle",
        "onRefresh",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyySettingsListView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("query") { view: ChatyySettingsListView, v: String? -> view.setQuery(v) }
      Prop("colors") { view: ChatyySettingsListView, v: Map<String, Any?>? -> view.setColors(v) }
      Prop("dark") { view: ChatyySettingsListView, v: Boolean? -> view.setDark(v ?: false) }
      Prop("labels") { view: ChatyySettingsListView, v: Map<String, Any?>? -> view.setLabelsProp(v) }
      Prop("headerHeight") { view: ChatyySettingsListView, v: Double? -> view.setHeaderHeightHint(v ?: 0.0) }
      Prop("bottomInset") { view: ChatyySettingsListView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      Prop("maxContentWidth") { view: ChatyySettingsListView, v: Double? -> view.setMaxContentWidth(v ?: 0.0) }
      // iOS-only (inset automático do header nativo); aceito e ignorado aqui.
      Prop("autoInset") { _: ChatyySettingsListView, _: Boolean? -> }
      Prop("refreshing") { view: ChatyySettingsListView, v: Boolean? -> view.setRefreshing(v ?: false) }
      Prop("scrollToId") { view: ChatyySettingsListView, v: String? -> view.setScrollToId(v) }

      OnViewDidUpdateProps { view: ChatyySettingsListView -> view.commitProps() }

      // Filho RN 0 = hero + cartões especiais (rola junto, acima da 1ª seção).
      GroupView<ChatyySettingsListView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
      }
    }
  }
}
