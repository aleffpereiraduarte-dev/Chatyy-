import ExpoModulesCore
import UIKit

// [2026-10-15 native-tabs] Barra de abas inferior da home (app/chat.js) NATIVA.
// A view só desenha e entrega toques — quem decide o que cada aba faz continua
// sendo o JS (handleTabPress / requestNewStatus).
//
// Props: items[{key,label,sfSymbol,sfSymbolActive,badge,dot,longPress,selectable,
//        avatarUrl,avatarHeaders (api 3+), hideLabel (api 4+)}],
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
    Function("apiVersion") { () -> Int in
      return 4
    }

    View(ChatyyTabBarView.self) {
      // onBarFail{reason} = [2026-10-18 tabbar-invisivel] api 4: barra não se desenha → JS usa a barra JS.
      Events("onTabPress", "onTabLongPress", "onPreferredHeight", "onBarFail")

      Prop("items") { (view: ChatyyTabBarView, v: [NTBItemRecord]?) in
        view.setItems(v ?? [])
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
