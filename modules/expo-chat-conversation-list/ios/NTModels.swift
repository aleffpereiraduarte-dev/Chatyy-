import UIKit

// [2026-10-15 native-notes] Modelos da lista de NOTAS nativa (ChatyyNotesList,
// app/notes.js via components/native/NativeNotesList.js). Mesmo contrato do
// Android (NTModels.kt). Linhas PLANAS vindas de components/native/notesListAdapter.js:
//   seção → { id, k: 's', t }                      (t vazio = só espaço)
//   nota  → { id, k: 'n', t, p, d, c, pn, ar, tg, nb, rm, ro, rr, ph, a11y }
//           t título · p prévia (texto puro) · d data · c cor da nota (ARGB)
//           pn fixada · ar arquivada · tg [etiquetas] · nb caderno
//           rm lembrete (texto) · ro lembrete vencido · rr lembrete repete
//           ph texto quando não há título nem prévia ("Sem título")
// O nativo só desenha; ações voltam por id (onRowAction {id, action, source}).

struct NTRow {
  var id: String = ""
  var kind: String = "n"
  var title: String = ""
  var preview: String = ""
  var date: String = ""
  var color: UIColor?
  var pinned = false
  var archived = false
  var tags: [String] = []
  var notebook: String = ""
  var reminder: String = ""
  var reminderOverdue = false
  var reminderRepeat = false
  var placeholder: String = ""
  var a11y: String = ""

  init() {}

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    kind = CLVal.str(d["k"])
    if kind.isEmpty { kind = "n" }
    title = CLVal.str(d["t"])
    preview = CLVal.str(d["p"])
    date = CLVal.str(d["d"])
    color = CTColor.of(d["c"])
    pinned = CLVal.bool(d["pn"])
    archived = CLVal.bool(d["ar"])
    if let tg = d["tg"] as? [Any] {
      tags = tg.prefix(4).map { CLVal.str($0) }.filter { !$0.isEmpty }
    }
    notebook = CLVal.str(d["nb"])
    reminder = CLVal.str(d["rm"])
    reminderOverdue = CLVal.bool(d["ro"])
    reminderRepeat = CLVal.bool(d["rr"])
    placeholder = CLVal.str(d["ph"])
    a11y = CLVal.str(d["a11y"])
  }

  var isSection: Bool { kind == "s" }
}

/// Item do menu do toque longo (prop `menu`): a = ação devolvida ao JS,
/// t = título, t2 = título alternativo (fixada/arquivada), g = glifo, x = destrutivo.
struct NTMenuItem {
  var action: String
  var title: String
  var altTitle: String
  var glyph: String
  var destructive: Bool

  init(_ d: [String: Any]) {
    action = CLVal.str(d["a"])
    title = CLVal.str(d["t"])
    altTitle = CLVal.str(d["t2"])
    glyph = CLVal.str(d["g"])
    destructive = CLVal.bool(d["x"])
  }

  /// Título para a nota: Fixar/Desafixar e Arquivar/Desarquivar trocam pelo estado.
  func titleFor(_ row: NTRow) -> String {
    if altTitle.isEmpty { return title }
    if action == "pin" { return row.pinned ? altTitle : title }
    if action == "archive" { return row.archived ? altTitle : title }
    return title
  }

  var symbol: String {
    switch glyph {
    case "edit": return "square.and.pencil"
    case "pin": return "pin"
    case "archive": return "archivebox"
    case "color": return "paintpalette"
    case "mail": return "envelope"
    case "download": return "arrow.down.doc"
    case "copy": return "doc.on.doc"
    case "trash": return "trash"
    case "bell": return "bell"
    case "share": return "square.and.arrow.up"
    default: return ""
    }
  }
}

struct NTStyle {
  var colors = CTColors()
  var card: UIColor = .white
  var cardBorder: UIColor = UIColor(white: 0, alpha: 0.06)
  var tokens: [String] = []
  var grid = false
}

/// Medidas do card — espelham os StyleSheets de app/notes.js (noteCard,
/// noteCardContent, noteTitle, noteContent, noteFooter, tagPill).
enum NTMetrics {
  static let outerH: CGFloat = 10      // gridContainer padding
  static let cellPadH: CGFloat = 5     // gridItem padding
  static let cellPadV: CGFloat = 5
  static let radius: CGFloat = 16
  static let strip: CGFloat = 5
  static let padTop: CGFloat = 14
  static let padLeft: CGFloat = 12
  static let padRight: CGFloat = 14
  static let padBottom: CGFloat = 14
  static let titleGap: CGFloat = 4
  static let rowGap: CGFloat = 8
  static let chipH: CGFloat = 20
  static let gridHeight: CGFloat = 188
  static let sectionH: CGFloat = 34
  static let spacerH: CGFloat = 12
}
