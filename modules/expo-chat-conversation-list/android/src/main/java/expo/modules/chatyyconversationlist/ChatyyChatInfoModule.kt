package expo.modules.chatyyconversationlist

// [2026-10-18 chat-info-native] "Dados do contato" / "Dados do grupo" em
// NATIVO (Android). Mesmo contrato do iOS (ios/ChatyyChatInfoModule.swift).

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyChatInfoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyChatInfo")

    // [2026-10-18 elegance] 2 = prop headerMode ("collapse") + evento onClose.
    // [2026-10-18 profile-native] 3 = perfil próprio/público: hero.photos
    // (carrossel), hero.nav {key,label} (botão de texto → onAction), hero.back
    // (seta à esquerda) e onAvatarPress {index}.
    // [2026-10-18 profile-edit-native] 4 = prop `edit` + evento onEdit
    // ("Editar perfil" nativo estilo Telegram; contrato em CIEditPanel.kt).
    Function("apiVersion") { 4 }

    View(ChatyyChatInfoView::class) {
      Events(
        "onRowPress",
        "onToggle",
        "onAction",
        "onAvatarPress",
        "onMediaPress",
        "onMemberPress",
        "onMembersEnd",
        "onMemberQuery",
        "onFirstPaint",
        "onNativeError",
        "onClose",
        "onEdit"
      )

      Prop("hero") { view: ChatyyChatInfoView, v: Map<String, Any?>? -> view.setHeroProp(v) }
      Prop("rows") { view: ChatyyChatInfoView, v: List<Any?>? -> view.setRowsProp(v) }
      Prop("media") { view: ChatyyChatInfoView, v: List<Any?>? -> view.setMediaProp(v) }
      Prop("members") { view: ChatyyChatInfoView, v: Map<String, Any?>? -> view.setMembersProp(v) }
      Prop("colors") { view: ChatyyChatInfoView, v: Map<String, Any?>? -> view.setColors(v) }
      Prop("dark") { view: ChatyyChatInfoView, v: Boolean? -> view.setDark(v ?: false) }
      Prop("labels") { view: ChatyyChatInfoView, v: Map<String, Any?>? -> view.setLabelsProp(v) }
      Prop("bottomInset") { view: ChatyyChatInfoView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      Prop("maxContentWidth") { view: ChatyyChatInfoView, v: Double? -> view.setMaxContentWidth(v ?: 0.0) }
      Prop("headerMode") { view: ChatyyChatInfoView, v: String? -> view.setHeaderMode(v ?: "") }
      Prop("edit") { view: ChatyyChatInfoView, v: Map<String, Any?>? -> view.setEditProp(v) }
      Prop("authToken") { _: ChatyyChatInfoView, v: String? -> if (!v.isNullOrEmpty()) CLAuth.token = v }

      OnViewDidUpdateProps { view: ChatyyChatInfoView -> view.commitProps() }
    }
  }
}
