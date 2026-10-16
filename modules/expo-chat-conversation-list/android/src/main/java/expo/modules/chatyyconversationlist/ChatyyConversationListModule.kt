package expo.modules.chatyyconversationlist

// [2026-10-14 native-home] Módulo da lista de conversas nativa (Android).
// Mesmo contrato do iOS (ios/ChatyyConversationListModule.swift).

import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyConversationListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyConversationList")

    // 2 = [native-store fase 1.5] prop `store` {a, r, n, s} (foto da home no store nativo)
    // 3 = [2026-10-16 wave8-list] props `topInset` (vidro no topo, header do app
    //     por cima), `snapOffset` (snap do título grande) e `peekMode` ("peek" =
    //     prévia estilo Telegram no toque longo); dígitos rolando, ✓→✓✓, swipe
    //     com resistência/estalo.
    Function("apiVersion") { 3 }

    View(ChatyyConversationListView::class) {
      Events(
        "onRowPress",
        "onRowPressIn",
        "onAvatarPress",
        "onRowAction",
        "onLongPress",
        "onPeekRequest",
        "onPeekOpen",
        "onCollapsedChange",
        "onEndReached",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { view: ChatyyConversationListView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("dark") { view: ChatyyConversationListView, v: Boolean? -> view.setDark(v ?: false) }
      Prop("selectionMode") { view: ChatyyConversationListView, v: Boolean? -> view.setSelectionModeProp(v ?: false) }
      Prop("labels") { view: ChatyyConversationListView, v: Map<String, Any?>? -> view.setLabelsProp(v) }
      Prop("authToken") { view: ChatyyConversationListView, v: String? -> view.setAuthToken(v) }
      Prop("headerHeight") { view: ChatyyConversationListView, v: Double? -> view.setHeaderHeightHint(v ?: 0.0) }
      Prop("footerHeight") { view: ChatyyConversationListView, v: Double? -> view.setFooterHeightHint(v ?: 0.0) }
      Prop("bottomInset") { view: ChatyyConversationListView, v: Double? -> view.setBottomInset(v ?: 0.0) }
      Prop("collapseOffset") { view: ChatyyConversationListView, v: Double? -> view.collapseOffsetDp = (v ?: 34.0).toFloat() }
      Prop("folders") { view: ChatyyConversationListView, v: List<Any?>? -> view.setFoldersProp(v) }
      Prop("peek") { view: ChatyyConversationListView, v: Map<String, Any?>? -> view.setPeekProp(v) }
      Prop("swipeEnabled") { view: ChatyyConversationListView, v: Boolean? -> view.swipeEnabled = v ?: true }
      Prop("menuEnabled") { view: ChatyyConversationListView, v: Boolean? -> view.menuEnabled = v ?: true }
      Prop("scrollToTopSeq") { view: ChatyyConversationListView, v: Double? -> view.setScrollToTopSeqProp(v ?: 0.0) }
      Prop("store") { view: ChatyyConversationListView, v: Map<String, Any?>? -> view.setStore(v) }
      Prop("topInset") { view: ChatyyConversationListView, v: Double? -> view.setTopInset(v ?: 0.0) }
      Prop("snapOffset") { view: ChatyyConversationListView, v: Double? -> view.setSnapOffset(v ?: 0.0) }
      Prop("peekMode") { view: ChatyyConversationListView, v: String? -> view.setPeekModeProp(v) }

      OnViewDidUpdateProps { view: ChatyyConversationListView -> view.commitProps() }

      // Filhos RN: 0 = header da home, 1 = rodapé (busca). Moram dentro do
      // RecyclerView, não como filhos diretos desta view.
      GroupView<ChatyyConversationListView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
      }
    }
  }
}
