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
  //   • pílulas de data/sistema em cápsula fosca chapada (perf-scroll 19/10: sem
  //     desfoque por célula), 12 pt; a flutuante (CMLSticky, 1 só) mantém o desfoque;
  //   • hora/✓ sobre foto/vídeo/figurinha e duração do vídeo em pílula translúcida;
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
  /// [2026-10-19 perf-scroll] não é mais usado nas células (só legado).
  static let mediaBlur = UIBlurEffect(style: .systemUltraThinMaterialDark)

  // MARK: [2026-10-19 perf-scroll] pílula "fosca" SEM desfoque
  // A pílula de data/sistema das células era UIVisualEffectView (material fino +
  // tinta pillBg) — 1 passe de desfoque por pílula por quadro. Agora a cor do
  // material é aproximada por um branco/grafite translúcido e a tinta pillBg é
  // composta por cima (source-over) numa cor só → backgroundColor chapado.
  private static var frostKey: (UInt32, UInt32)?
  private static var frostVal: UIColor = .clear

  static func frostedPill(tint: UIColor, wall: UIColor) -> UIColor {
    let k = (rgba32(tint), rgba32(wall))
    if let fk = frostKey, fk.0 == k.0, fk.1 == k.1 { return frostVal }
    let dark = isDark(wall)
    // ≈ systemThinMaterialLight/Dark sobre fundo liso
    let base: (CGFloat, CGFloat) = dark ? (0.16, 0.80) : (0.985, 0.82)
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    if !tint.getRed(&r, green: &g, blue: &b, alpha: &a) {
      var w: CGFloat = 0
      _ = tint.getWhite(&w, alpha: &a)
      r = w; g = w; b = w
    }
    let ba = base.1
    let oa = a + ba * (1 - a)
    func mix(_ c: CGFloat) -> CGFloat { return oa > 0 ? (c * a + base.0 * ba * (1 - a)) / oa : 0 }
    let out = UIColor(red: mix(r), green: mix(g), blue: mix(b), alpha: oa)
    frostKey = k
    frostVal = out
    return out
  }

  private static func rgba32(_ c: UIColor) -> UInt32 {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    if !c.getRed(&r, green: &g, blue: &b, alpha: &a) {
      var w: CGFloat = 0
      _ = c.getWhite(&w, alpha: &a)
      r = w; g = w; b = w
    }
    func q(_ v: CGFloat) -> UInt32 { return UInt32(max(0, min(255, (v * 255).rounded()))) }
    return (q(r) << 24) | (q(g) << 16) | (q(b) << 8) | q(a)
  }

  /// canto do lado do autor entre bolhas do mesmo grupo
  static let groupRadius: CGFloat = 6
  /// altura da curva do rabicho (de baixo p/ cima)
  static let tailRise: CGFloat = 13
}

// MARK: [2026-10-19 store-rev, apiVersion 13] rótulos de dia recalculados ao pintar a foto
// Antes o `rev` da foto do store levava o id do OTA + o DIA local (rótulos "Hoje/
// Ontem/sexta-feira" ficavam assados nas linhas de data) → todo OTA e toda virada
// de dia jogava a foto fora (45 % why=rev; abertura pintada pelo JS p50 87–99 ms
// vs 31 ms pela foto). Agora o rev é fixo (versão do esquema) e o JS manda em
// store.dl {m: {"A-M-D" (mês 0-based = chave "sep-A-M-D"): rótulo de hoje}, loc}
// os rótulos dos 7 dias relativos; linhas mais velhas usam `ab` (rótulo absoluto
// que o JS grava junto) ou, sem ele, formatam a data aqui (template yMMMd = o
// Intl {month:'short', day:'numeric', year:'numeric'} do JS).
final class CMLDayLabels {
  private(set) var map: [String: String] = [:]
  private var rel = Set<String>()
  private var loc = ""
  private var fmt: DateFormatter?

  func update(_ v: Any?) {
    guard let d = v as? [String: Any], let m = d["m"] as? [String: Any] else {
      map = [:]
      rel = []
      return
    }
    var out: [String: String] = [:]
    for (k, x) in m {
      if let s = x as? String, !s.isEmpty { out[k] = s }
    }
    map = out
    rel = Set(out.values)
    let l = (d["loc"] as? String) ?? ""
    if l != loc { loc = l; fmt = nil }
  }

  /// Linha de data da foto com o rótulo de HOJE (as outras voltam iguais).
  func relabel(_ d: [String: Any]) -> [String: Any] {
    guard !map.isEmpty, (d["kind"] as? String) == "date", let k = d["k"] as? String, k.hasPrefix("sep-") else { return d }
    let day = String(k.dropFirst(4))
    let cur = (d["text"] as? String) ?? ""
    var want: String? = nil
    if let l = map[day] {
      want = l
    } else if let ab = d["ab"] as? String, !ab.isEmpty {
      want = ab
    } else if rel.contains(cur) {
      want = absLabel(day)
    }
    guard let w = want, !w.isEmpty, w != cur else { return d }
    var out = d
    out["text"] = w
    return out
  }

  private func absLabel(_ day: String) -> String? {
    let p = day.split(separator: "-").compactMap { Int($0) }
    guard p.count == 3 else { return nil }
    var c = DateComponents()
    c.year = p[0]
    c.month = p[1] + 1
    c.day = p[2]
    c.hour = 12
    guard let date = Calendar.current.date(from: c) else { return nil }
    if fmt == nil {
      let f = DateFormatter()
      if !loc.isEmpty { f.locale = Locale(identifier: loc) }
      f.setLocalizedDateFormatFromTemplate("yMMMd")
      fmt = f
    }
    return fmt?.string(from: date)
  }
}
