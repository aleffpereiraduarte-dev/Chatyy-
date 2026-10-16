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
    Function("apiVersion") { () -> Int in
      #if canImport(ExpoChatStore)
      return 3
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
        "onNativeError"
      )

      Prop("rowsPatch") { (view: ChatyyConversationListView, value: [String: Any]?) in
        view.setRowsPatch(value)
      }
      Prop("dark") { (view: ChatyyConversationListView, value: Bool?) in
        view.setDark(value ?? false)
      }
      Prop("selectionMode") { (view: ChatyyConversationListView, value: Bool?) in
        view.setSelectionMode(value ?? false)
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

      OnViewDidUpdateProps { (view: ChatyyConversationListView) in
        view.commitProps()
      }
    }
  }
}
