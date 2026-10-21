import ExpoModulesCore
import UIKit

// [2026-10-14 native-home] Lista de conversas da home em NATIVO (Telegram/
// WhatsApp): UICollectionView com layout de lista compositional + diffable
// data source (insere/move/atualiza linhas animado, sem piscar), swipe actions
// nativas, menu de contexto com prévia, anel de status em CoreGraphics e
// avatares com cache em disco. O header da home (título grande, filtros,
// faixa de status, fixadas…) continua em JS: é o 1º filho RN desta view e
// rola junto com a lista; o 2º filho é o rodapé (resultados de busca).
//
// JS: modules/expo-chat-conversation-list/index.ts +
//     components/chatlist/{nativeAdapter.js,NativeConversationList.js}.
//
// Props:  rowsPatch {seq, base, reset?, upsert?, remove?, order?}, dark,
//         selectionMode, labels, authToken, headerHeight, footerHeight,
//         bottomInset, collapseOffset, peek, swipeEnabled, menuEnabled,
//         scrollToTopSeq
// Events: onRowPress, onRowPressIn, onAvatarPress, onRowAction, onLongPress,
//         onPeekRequest, onPeekOpen, onCollapsedChange, onEndReached,
//         onResync, onFirstPaint, onNativeError
public class ChatyyConversationListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyConversationList")

    // 2 = [native-store fase 1.5] prop `store` {a, r, n, s}: foto da home lida
    //     direto do store nativo (modules/expo-chat-store) + regravada sozinha.
    // 3 = [2026-10-16 wave8-list] props `topInset` (header do app por cima da
    //     lista + vidro nativo no topo) e `snapOffset` (snap do título grande);
    //     dígitos rolando, ✓→✓✓ animado, reordenação com mola (sem contrato).
    // 4 = [2026-10-17 peek-fixed] prévia do toque longo com altura FIXA
    //     (igual em toda conversa) + prop `peekHeight` (fração da tela).
    // 5 = [2026-10-18 failed-row] linha com `failed:true` desenha "!" vermelho
    //     (exclamação em círculo) no lugar do relógio/✓ (chave extra; sem contrato).
    // 6 = [2026-10-18 tg-list] evento `onPullReveal` {distance}: puxar a lista
    //     além de 64 pt no topo (uma vez por arrasto) — o JS revela a linha
    //     "Arquivadas" escondida (Telegram). Sem prop nova.
    // 7 = [2026-10-18 peek-full] prévia do toque longo desenha até 15 balões e
    //     o FUNDO da conversa (chave opcional `bg` na prop `peek`: cor, padrão
    //     vetorial, foto, cores dos balões). Sem prop nova (binário antigo ignora).
    // 8 = [2026-10-18 compact-list] prop `density` ("compact" = linha 72 /
    //     avatar 52 / vão 12, WhatsApp; ausente/"regular" = 76 / 54 / 14).
    // 9 = [2026-10-19 tg-list] density "telegram" (linha 78 / avatar 58 /
    //     prévia em 2 linhas, ✓✓ junto da hora, remetente do grupo em linha
    //     própria, alfinete no lugar do contador, swipe com glifo cheio) +
    //     prop `accent` ("#RRGGBB": cor do "digitando…").
    // [2026-10-20 grafite] 10 = prop `palette` (cores do tema Grafite suave).
    // [2026-10-21 lista-viva] 11 = prop `vivo` (mockup preview-2026/lista.html:
    //     avatar quente, online pulsando, digitando/gravando animados, não lidas
    //     fortes, fixadas num cartão, miniatura de foto/vídeo, sem separadores,
    //     entrada leve) + chaves opcionais da linha `typing` ("typing" |
    //     "recording" | texto), `typingKind`, `thumbUrl`, `thumbAuth` e
    //     palette `pinnedCard`. vivo ausente/false = desenho idêntico ao 10.
    Function("apiVersion") { () -> Int in
      #if canImport(ExpoChatStore)
      return 11
      #else
      return 1
      #endif
    }

    View(ChatyyConversationListView.self) {
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

      Prop("rowsPatch") { (view: ChatyyConversationListView, value: [String: Any]?) in
        view.setRowsPatch(value)
      }
      Prop("dark") { (view: ChatyyConversationListView, value: Bool?) in
        view.setDark(value ?? false)
      }
      Prop("palette") { (view: ChatyyConversationListView, value: [String: Any]?) in
        view.setPalette(value)
      }
      Prop("vivo") { (view: ChatyyConversationListView, value: Bool?) in
        view.setVivo(value ?? false)
      }
      Prop("selectionMode") { (view: ChatyyConversationListView, value: Bool?) in
        view.setSelectionMode(value ?? false)
      }
      Prop("density") { (view: ChatyyConversationListView, value: String?) in
        view.setDensity(value)
      }
      Prop("accent") { (view: ChatyyConversationListView, value: String?) in
        view.setAccent(value)
      }
      Prop("labels") { (view: ChatyyConversationListView, value: [String: Any]?) in
        view.setLabels(value)
      }
      Prop("authToken") { (view: ChatyyConversationListView, value: String?) in
        CLImageLoader.shared.authToken = value ?? ""
      }
      Prop("headerHeight") { (view: ChatyyConversationListView, value: Double?) in
        view.setHeaderHeightHint(CGFloat(value ?? 0))
      }
      Prop("footerHeight") { (view: ChatyyConversationListView, value: Double?) in
        view.setFooterHeightHint(CGFloat(value ?? 0))
      }
      Prop("bottomInset") { (view: ChatyyConversationListView, value: Double?) in
        view.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("collapseOffset") { (view: ChatyyConversationListView, value: Double?) in
        view.collapseOffset = CGFloat(value ?? 34)
      }
      Prop("folders") { (view: ChatyyConversationListView, value: [[String: Any]]?) in
        view.setFolders(value)
      }
      Prop("peek") { (view: ChatyyConversationListView, value: [String: Any]?) in
        view.setPeek(value)
      }
      Prop("peekHeight") { (view: ChatyyConversationListView, value: Double?) in
        view.peekHeight = CGFloat(value ?? 0)
      }
      Prop("swipeEnabled") { (view: ChatyyConversationListView, value: Bool?) in
        view.swipeEnabled = value ?? true
      }
      Prop("menuEnabled") { (view: ChatyyConversationListView, value: Bool?) in
        view.menuEnabled = value ?? true
      }
      Prop("scrollToTopSeq") { (view: ChatyyConversationListView, value: Double?) in
        view.setScrollToTopSeq(value ?? 0)
      }
      Prop("store") { (view: ChatyyConversationListView, value: [String: Any]?) in
        view.setStore(value)
      }
      Prop("topInset") { (view: ChatyyConversationListView, value: Double?) in
        view.setTopInset(CGFloat(value ?? 0))
      }
      Prop("snapOffset") { (view: ChatyyConversationListView, value: Double?) in
        view.snapOffset = CGFloat(max(0, value ?? 0))
      }
      // Android usa (prévia do toque longo); iOS já abre a prévia nativa do menu.
      Prop("peekMode") { (_: ChatyyConversationListView, _: String?) in }
      // [2026-10-16 motion-nav] kill switch das molas da lista (JS só manda quando false).
      Prop("springMotion") { (_: ChatyyConversationListView, value: Bool?) in
        CLSpring.enabled = value ?? true
      }

      OnViewDidUpdateProps { (view: ChatyyConversationListView) in
        view.commitProps()
      }
    }
  }
}
