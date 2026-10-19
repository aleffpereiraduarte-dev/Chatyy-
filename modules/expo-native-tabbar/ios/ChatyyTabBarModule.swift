import ExpoModulesCore
import UIKit

// [2026-10-15 native-tabs] Barra de abas inferior da home (app/chat.js) NATIVA.
// A view só desenha e entrega toques — quem decide o que cada aba faz continua
// sendo o JS (handleTabPress / requestNewStatus).
//
// Props: items[{key,label,sfSymbol,sfSymbolActive,badge,dot,longPress,selectable,
//        avatarUrl,avatarHeaders (api 3+), hideLabel (api 4+), avatarLocalPath,avatarKey (api 6+)}],
//        selectedKey (String|null), theme{dark,active,inactive,background,hairline,
//        badgeBackground,badgeText,pill,ripple}, translucent, bounce.
// Eventos: onTabPress{key}, onTabLongPress{key}, onPreferredHeight{height}
//          (sizeThatFits do UITabBar, já com a safe area de baixo),
//          onBarFail{reason} (api 4+: barra não se desenha → JS usa a barra JS).

struct NTBItemRecord: Record {
  @Field var key: String = ""
  @Field var label: String = ""
  @Field var sfSymbol: String = ""
  @Field var sfSymbolActive: String? = nil
  @Field var androidIcon: String? = nil
  @Field var badge: Int = 0
  @Field var dot: Bool = false
  @Field var longPress: Bool = false
  @Field var selectable: Bool = true
  /// [2026-10-18 you-tab-avatar] api 3: foto redonda no lugar do SF Symbol
  /// (http(s)://, file:// ou caminho absoluto). Vazio/nil = ícone.
  @Field var avatarUrl: String? = nil
  /// Cabeçalhos do download (ex.: Authorization p/ foto restrita).
  @Field var avatarHeaders: [String: String]? = nil
  /// [2026-10-18 you-tab-nolabel] api 4: sem rótulo embaixo (só ícone/foto,
  /// centralizado e maior — aba de perfil do Instagram). `label` continua
  /// sendo o accessibilityLabel (VoiceOver lê "Você").
  @Field var hideLabel: Bool = false
  /// [2026-10-19 tabbar-offline] api 6: cópia LOCAL da foto (file:// ou caminho do
  /// avatarCache do JS) — mostrada antes da rede; `avatarUrl` (https) revalida.
  @Field var avatarLocalPath: String? = nil
  /// api 6: chave ESTÁVEL da conta (e-mail) p/ a "última foto boa" em disco —
  /// aparece na montagem, offline, antes de qualquer rede.
  @Field var avatarKey: String? = nil
}

struct NTBThemeRecord: Record {
  @Field var dark: Bool = false
  @Field var active: Double? = nil
  @Field var inactive: Double? = nil
  @Field var background: Double? = nil
  @Field var hairline: Double? = nil
  @Field var badgeBackground: Double? = nil
  @Field var badgeText: Double? = nil
  @Field var pill: Double? = nil
  @Field var ripple: Double? = nil
}

// [2026-10-19 tabbar-api7] items chegam como dicionários e são lidos SEM exceção:
// com o Record do Expo, um único campo de tipo inesperado (ex.: badge "9+",
// cabeçalho não-string) faz a conversão da LISTA inteira falhar e o setter nem é
// chamado → barra sem itens (731 + OTA 01a152a3: it=0/0). Item sem `key` é
// descartado (contado em `dropped` p/ o diagnóstico).
func ntbString(_ v: Any?) -> String? {
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  return nil
}

func ntbInt(_ v: Any?) -> Int {
  if let n = v as? NSNumber {
    let d = n.doubleValue
    guard d.isFinite else { return 0 }
    return Int(max(-1_000_000, min(1_000_000, d)))
  }
  if let s = v as? String {
    let digits = s.filter { (c: Character) -> Bool in c.isNumber }
    return Int(digits.prefix(7)) ?? 0
  }
  return 0
}

func ntbBool(_ v: Any?, _ fallback: Bool) -> Bool {
  if let b = v as? Bool { return b }
  if let n = v as? NSNumber { return n.intValue != 0 }
  if let s = v as? String { return s == "true" || s == "1" }
  return fallback
}

func ntbItem(from d: [String: Any]) -> NTBItemRecord? {
  guard let key = ntbString(d["key"]), !key.isEmpty else { return nil }
  var r = NTBItemRecord()
  r.key = key
  r.label = ntbString(d["label"]) ?? ""
  r.sfSymbol = ntbString(d["sfSymbol"]) ?? ""
  r.sfSymbolActive = ntbString(d["sfSymbolActive"])
  r.androidIcon = ntbString(d["androidIcon"])
  r.badge = ntbInt(d["badge"])
  r.dot = ntbBool(d["dot"], false)
  r.longPress = ntbBool(d["longPress"], false)
  r.selectable = ntbBool(d["selectable"], true)
  r.avatarUrl = ntbString(d["avatarUrl"])
  if let h = d["avatarHeaders"] as? [String: Any] {
    var out: [String: String] = [:]
    for (k, v) in h {
      if let sv = ntbString(v) { out[k] = sv }
    }
    r.avatarHeaders = out.isEmpty ? nil : out
  }
  r.hideLabel = ntbBool(d["hideLabel"], false)
  r.avatarLocalPath = ntbString(d["avatarLocalPath"])
  r.avatarKey = ntbString(d["avatarKey"])
  return r
}

/// processColor() do RN entrega 0xAARRGGBB (número). nil → fallback.
func ntbColor(_ v: Double?, _ fallback: UIColor) -> UIColor {
  guard let v = v, v.isFinite else { return fallback }
  let u = UInt32(truncatingIfNeeded: Int64(v))
  let a = CGFloat((u >> 24) & 0xFF) / 255
  let r = CGFloat((u >> 16) & 0xFF) / 255
  let g = CGFloat((u >> 8) & 0xFF) / 255
  let b = CGFloat(u & 0xFF) / 255
  return UIColor(red: r, green: g, blue: b, alpha: a)
}

public class ChatyyTabBarModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyTabBar")

    // 3 = [2026-10-18 you-tab-avatar] items[].avatarUrl (foto redonda na aba Você).
    // 4 = [2026-10-18 you-tab-nolabel] items[].hideLabel (sem rótulo; ícone/foto centralizado e maior).
    // 5 = [2026-10-19 tabbar-api5] foto por cima do ícone (itens nunca mudam de imagem), autochecagem
    //     de visibilidade real (fora da tela / sem conteúdo → onBarFail), onBarProbe + onAvatarState.
    // 6 = [2026-10-19 tabbar-offline] items[].avatarLocalPath + avatarKey: foto OFFLINE-FIRST (última
    //     foto boa por conta em disco, síncrona na montagem; rede só revalida; falha nunca volta ao
    //     ícone) e item transparente por baixo da foto (nada do SF Symbol aparece em volta).
    // 7 = [2026-10-19 tabbar-api7] autochecagem de PIXEL (hitTest da janela nos ícones +
    //     contraste do glifo na captura da tela) → onBarFail{reason:"vis_covered|vis_invisible"};
    //     sem itens = falha "no_items"; items lidos como dicionários sem exceção; prop
    //     visibilityCheck (kill switch); diagnóstico hit/vis/topHit/ancA/lay/pf/ps.
    Function("apiVersion") { () -> Int in
      return 7
    }

    View(ChatyyTabBarView.self) {
      // onBarFail{reason} = [2026-10-18 tabbar-invisivel] api 4: barra não se desenha → JS usa a barra JS.
      // onBarProbe{reason,frame,win,…} / onAvatarState{state,reason,scheme} = api 5.
      Events("onTabPress", "onTabLongPress", "onPreferredHeight", "onBarFail", "onBarProbe", "onAvatarState")

      Prop("items") { (view: ChatyyTabBarView, v: [[String: Any]]?) in
        let raw: [[String: Any]] = v ?? []
        var list: [NTBItemRecord] = []
        for d in raw {
          if let r = ntbItem(from: d) { list.append(r) }
        }
        view.setItems(list, dropped: raw.count - list.count)
      }
      Prop("visibilityCheck") { (view: ChatyyTabBarView, v: Bool?) in
        view.visibilityCheckEnabled = v ?? true
      }
      Prop("selectedKey") { (view: ChatyyTabBarView, v: String?) in
        view.setSelectedKeyProp(v)
      }
      Prop("theme") { (view: ChatyyTabBarView, v: NTBThemeRecord?) in
        view.setThemeProp(v ?? NTBThemeRecord())
      }
      Prop("translucent") { (view: ChatyyTabBarView, v: Bool?) in
        view.setTranslucentProp(v ?? true)
      }
      Prop("bounce") { (view: ChatyyTabBarView, v: Bool?) in
        view.bounceEnabled = v ?? true
      }
      // Só Android (padding do home indicator/gestos); no iOS o UITabBar usa a
      // safe area sozinho. Declarado para o contrato ser igual nas duas.
      Prop("bottomInset") { (_: ChatyyTabBarView, _: Double?) in }

      OnViewDidUpdateProps { (view: ChatyyTabBarView) in
        view.didUpdateProps()
      }
    }
  }
}
