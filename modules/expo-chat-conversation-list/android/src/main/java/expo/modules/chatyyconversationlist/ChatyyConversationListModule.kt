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
    // 4 = [2026-10-16 topbar-hairline] vidro do topo recalculado após o layout
    //     (antes ficava com hairline presa sob o header ao ligar o topInset).
    //     O JS só liga o header sobreposto no Android com api >= 4.
    // 5 = [2026-10-17 peek-fixed] prévia (peekMode "peek") com cartão de altura
    //     FIXA igual em toda conversa + prop `peekHeight` (fração da tela).
    // 6 = [2026-10-18 failed-row] linha com `failed:true` desenha "!" vermelho
    //     (exclamação em círculo) no lugar do relógio/✓ (chave extra; sem contrato).
    // 7 = [2026-10-18 tg-list] evento `onPullReveal` {distance}: puxar a lista
    //     além de 64 dp no topo (uma vez por gesto) — o JS revela a linha
    //     "Arquivadas" escondida (Telegram). Sem prop nova.
    // 8 = [2026-10-18 peek-full] prévia (CLPeekDialog) com até 15 balões e o
    //     FUNDO da conversa (chave opcional `bg` na prop `peek`). Sem prop nova.
    // 9 = [2026-10-18 compact-list] prop `density` ("compact" = linha 72 /
    //     avatar 52 / vão 12, WhatsApp; ausente/"regular" = 76 / 54 / 14).
    Function("apiVersion") { 9 }

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
        "onNativeError",
        "onPullReveal"
      )

      Prop("rowsPatch") { view: ChatyyConversationListView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("dark") { view: ChatyyConversationListView, v: Boolean? -> view.setDark(v ?: false) }
      Prop("selectionMode") { view: ChatyyConversationListView, v: Boolean? -> view.setSelectionModeProp(v ?: false) }
      Prop("labels") { view: ChatyyConversationListView, v: Map<String, Any?>? -> view.setLabelsProp(v) }
      Prop("density") { view: ChatyyConversationListView, v: String? -> view.setDensityProp(v) }
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
      Prop("peekHeight") { view: ChatyyConversationListView, v: Double? -> view.peekHeight = v ?: 0.0 }
      // [2026-10-16 motion-nav] kill switch das molas da lista (JS só manda quando false).
      Prop("springMotion") { _: ChatyyConversationListView, v: Boolean? -> CLSpring.enabled = v ?: true }

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
