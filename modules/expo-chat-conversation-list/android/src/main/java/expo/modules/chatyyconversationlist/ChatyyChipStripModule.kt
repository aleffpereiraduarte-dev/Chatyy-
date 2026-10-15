package expo.modules.chatyyconversationlist

// [2026-10-15 native-group-create] Fileira de membros selecionados do Novo
// grupo (Android). Mesmo contrato do iOS (ios/ChatyyChipStripModule.swift).

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyChipStripModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyChipStrip")

    Function("apiVersion") { 1 }

    View(ChatyyChipStripView::class) {
      Events("onChipPress", "onNativeError")

      Prop("items") { view: ChatyyChipStripView, v: List<Any?>? -> view.setItemsProp(v) }
      Prop("colors") { view: ChatyyChipStripView, v: Map<String, Any?>? -> view.setColorsProp(v) }
      Prop("dark") { view: ChatyyChipStripView, v: Boolean? -> view.setDark(v ?: false) }
      Prop("authToken") { _: ChatyyChipStripView, v: String? -> if (!v.isNullOrEmpty()) CLAuth.token = v }

      OnViewDidUpdateProps { view: ChatyyChipStripView -> view.commitProps() }
    }
  }
}
