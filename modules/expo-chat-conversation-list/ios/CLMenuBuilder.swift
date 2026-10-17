import UIKit

// [2026-10-15 native-pins] Menu do toque longo estilo WhatsApp, compartilhado
// entre a lista (ChatyyConversationListView) e a fileira de fixados
// (ChatyyPinnedStripView): ações rápidas no topo, submenus (silenciar por…,
// listas, mais) e destrutivas em vermelho. A confirmação das destrutivas é a
// dos handlers JS existentes (Alert nativo / biometria): aqui só emitimos.
enum CLMenuBuilder {
  /// Uma ação do menu que emite `{id, action, source: "menu", ...extra}`.
  static func action(id: String, action: String, title: String, symbol: String,
                     destructive: Bool = false, extra: [String: Any] = [:], on: Bool = false,
                     emit: @escaping ([String: Any]) -> Void) -> UIAction {
    let a = UIAction(title: title, image: UIImage(systemName: symbol)) { _ in
      var body: [String: Any] = ["id": id, "action": action, "source": "menu"]
      for (k, v) in extra { body[k] = v }
      emit(body)
    }
    if destructive { a.attributes.insert(.destructive) }
    if on { a.state = .on }
    return a
  }

  /// [2026-10-17 peek-fit] Altura estimada do menu do toque longo (rowMenu)
  /// p/ a prévia (CLPeekController) se limitar e o menu INTEIRO caber na tela.
  /// Conta os itens de topo + grupo destrutivo; escala com o Dynamic Type.
  static func estimatedHeight(row: CLRow, extraItems: Int = 0) -> CGFloat {
    let top = 7 + max(0, extraItems)        // lida, fixar, silenciar, arquivar, trancar, lista, mais
    let danger = row.blockLabel.isEmpty ? 2 : 3 // (bloquear), denunciar, apagar
    let rowH = UIFontMetrics.default.scaledValue(for: 46)
    // + 1 linha a mais ("Marcar como não lida" quebra), divisor do grupo e respiro
    return CGFloat(top + danger) * rowH + rowH * 0.5 + 12 + 16
  }

  /// [2026-10-17 peek-fixed] Pior caso do menu (com Bloquear e "Reorganizar
  /// fixados"): a prévia usa ESTE valor p/ ter a mesma altura em toda conversa.
  static func maxEstimatedHeight() -> CGFloat {
    let rowH = UIFontMetrics.default.scaledValue(for: 46)
    return CGFloat(8 + 3) * rowH + rowH * 0.5 + 12 + 16
  }

  /// `afterPin`: itens extras logo depois de Fixar/Desafixar (ex.: "Reorganizar
  /// fixados" na fileira de fixados).
  static func rowMenu(id: String, row: CLRow, labels L: CLLabels, folders: [CLFolder],
                      afterPin: [UIMenuElement] = [],
                      emit: @escaping ([String: Any]) -> Void) -> UIMenu {
    func act(_ action: String, _ title: String, _ symbol: String, destructive: Bool = false,
             extra: [String: Any] = [:], on: Bool = false) -> UIAction {
      return CLMenuBuilder.action(id: id, action: action, title: title, symbol: symbol,
                                  destructive: destructive, extra: extra, on: on, emit: emit)
    }
    var top: [UIMenuElement] = []
    top.append(act("toggleRead",
                   row.unreadVisible ? L.get("markRead", "Marcar como lida") : L.get("markUnread", "Marcar como não lida"),
                   row.unreadVisible ? "checkmark.message" : "message"))
    top.append(act("pin", row.pinned ? L.get("unpin", "Desafixar") : L.get("pin", "Fixar"), row.pinned ? "pin.slash" : "pin"))
    top.append(contentsOf: afterPin)
    if row.muted {
      top.append(act("mute", L.get("unmute", "Reativar som"), "bell"))
    } else {
      let now = Date().timeIntervalSince1970
      top.append(UIMenu(title: L.get("mute", "Silenciar"), image: UIImage(systemName: "bell.slash"), children: [
        act("mute", L.get("muteFor8h", "Silenciar por 8 horas"), "clock", extra: ["until": floor(now) + 8 * 3600]),
        act("mute", L.get("muteFor1w", "Silenciar por 1 semana"), "calendar", extra: ["until": floor(now) + 7 * 86400]),
        act("mute", L.get("muteForever", "Silenciar sempre"), "bell.slash", extra: ["until": 4070908800.0]),
      ]))
    }
    top.append(act("archive", row.archived ? L.get("unarchive", "Desarquivar") : L.get("archive", "Arquivar"),
                   row.archived ? "tray.and.arrow.up" : "archivebox"))
    top.append(act("lock", row.lockOn ? L.get("unlockChat", "Destrancar conversa") : L.get("lockChat", "Trancar conversa"),
                   row.lockOn ? "lock.open" : "lock"))
    var lists: [UIMenuElement] = folders.map { f -> UIMenuElement in
      act("list", f.name, f.ids.contains(id) ? "checkmark" : "list.bullet", extra: ["folderId": f.id], on: f.ids.contains(id))
    }
    lists.append(act("listNew", L.get("createNewList", "Criar nova lista"), "plus"))
    top.append(UIMenu(title: L.get("addToList", "Adicionar à lista"), image: UIImage(systemName: "text.badge.plus"), children: lists))
    top.append(UIMenu(title: L.get("moreMenu", "Mais"), image: UIImage(systemName: "ellipsis.circle"), children: [
      act("select", L.get("select", "Selecionar várias"), "checkmark.circle"),
      act("clear", L.get("clearChat", "Limpar conversa"), "xmark.circle"),
    ]))
    var danger: [UIMenuElement] = []
    if !row.blockLabel.isEmpty {
      danger.append(act("block", row.blockLabel, "nosign", destructive: true))
    }
    danger.append(act("report", L.get("report", "Denunciar"), "exclamationmark.bubble", destructive: true))
    danger.append(act("delete", L.get("delete", "Apagar"), "trash", destructive: true))
    return UIMenu(title: "", children: top + [UIMenu(title: "", options: .displayInline, children: danger)])
  }
}
