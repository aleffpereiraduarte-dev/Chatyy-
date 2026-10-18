import UIKit

// [2026-10-18 tg-look, apiVersion 10] Visual "nível Telegram" (P&B) da lista
// nativa. Prop `look` {tg} (0/1) vinda do JS (components/chat/nativeThreadList.js,
// kill switch globalThis.__chatyy_tg_look = false). Ausente/0 = visual antigo
// (rabicho WhatsApp no topo da 1ª bolha do grupo), byte a byte.
//   tg = 1:
//   • rabicho suave na ÚLTIMA bolha do grupo, embaixo, do lado do autor; as
//     bolhas do meio do grupo ficam com os cantos do autor justos (6 pt);
//   • foto/vídeo/álbum sem nome/encaminhada/citação: mídia rente à bolha (sem
//     a moldura de 3 pt), cantos = cantos da bolha (embaixo retos se houver
//     legenda); mídia sem legenda não tem rabicho nem fundo de bolha.
// Lido na main ao montar o CMLStyle (CMLStyle.tg) — o layout em fila de fundo
// só lê o estilo imutável.
enum CMLLook {
  static var tg = false

  /// true = mudou (a lista refaz o estilo/layouts).
  static func apply(_ d: [String: Any]?) -> Bool {
    let m = d ?? [:]
    let n = m["tg"] == nil ? false : CMLRow.bool(m["tg"])
    if n == tg { return false }
    tg = n
    return true
  }

  /// canto do lado do autor entre bolhas do mesmo grupo
  static let groupRadius: CGFloat = 6
  /// altura da curva do rabicho (de baixo p/ cima)
  static let tailRise: CGFloat = 13
}
