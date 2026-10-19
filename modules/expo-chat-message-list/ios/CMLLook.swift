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

  // MARK: [2026-10-19 tg-style, apiVersion 12] polimento "nível Telegram"
  // Prop `tgStyle` {on: 0/1} (JS: nativeThreadList.js, kill switch
  // globalThis.__chatyy_tg_bubbles = false). Ausente/0 = visual da api 11.
  //   on = 1:
  //   • 2 pt dentro do grupo / 8 pt entre grupos;
  //   • pílulas de data/sistema (e a flutuante) em cápsula com desfoque, 12 pt;
  //   • hora/✓ sobre foto/vídeo/figurinha e duração do vídeo em pílula com desfoque;
  //   • nota de voz: botão play cheio (tinta) com glifo na cor da bolha, onda mais firme;
  //   • "Encaminhada" 13 regular (sem itálico), citação com cantos 6, reações sem sombra.
  static var style = false

  /// true = mudou (a lista refaz o estilo/layouts).
  static func applyStyle(_ d: [String: Any]?) -> Bool {
    let m = d ?? [:]
    let n = m["on"] == nil ? false : CMLRow.bool(m["on"])
    if n == style { return false }
    style = n
    return true
  }

  /// fundo escuro? (escolhe o material do desfoque das pílulas)
  static func isDark(_ c: UIColor) -> Bool {
    var r: CGFloat = 1, g: CGFloat = 1, b: CGFloat = 1, a: CGFloat = 1
    if !c.getRed(&r, green: &g, blue: &b, alpha: &a) {
      var w: CGFloat = 1
      _ = c.getWhite(&w, alpha: &a)
      r = w; g = w; b = w
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) < 0.5
  }

  static func pillBlur(dark: Bool) -> UIBlurEffect {
    return UIBlurEffect(style: dark ? .systemThinMaterialDark : .systemThinMaterialLight)
  }

  /// pílula sobre mídia (hora/duração): sempre material escuro (texto branco)
  static let mediaBlur = UIBlurEffect(style: .systemUltraThinMaterialDark)

  /// canto do lado do autor entre bolhas do mesmo grupo
  static let groupRadius: CGFloat = 6
  /// altura da curva do rabicho (de baixo p/ cima)
  static let tailRise: CGFloat = 13
}
