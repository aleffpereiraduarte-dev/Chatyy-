package expo.modules.chatyytabbar

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/**
 * [2026-10-15 native-tabs] Barra de abas inferior da home NATIVA (Android).
 * Mesmo contrato da versão iOS (ios/ChatyyTabBarModule.swift):
 *
 * Props: items[{key,label,androidIcon,badge,dot,longPress,selectable,
 *   avatarUrl,avatarHeaders (api 3+), hideLabel (api 4+)}],
 *   selectedKey, theme{dark,active,inactive,background,hairline,badgeBackground,
 *   badgeText,pill,ripple}, bottomInset (dp), bounce.
 * Eventos: onTabPress{key}, onTabLongPress{key}.
 */
class NTBItemRecord : Record {
  @Field val key: String = ""
  @Field val label: String = ""
  @Field val sfSymbol: String = ""
  @Field val sfSymbolActive: String? = null
  @Field val androidIcon: String? = null
  @Field val badge: Int = 0
  @Field val dot: Boolean = false
  @Field val longPress: Boolean = false
  @Field val selectable: Boolean = true
  /** [2026-10-18 you-tab-avatar] api 3: foto redonda no lugar do vetor (http(s)/file:// /caminho). */
  @Field val avatarUrl: String? = null
  /** Cabeçalhos do download (ex.: Authorization p/ foto restrita). */
  @Field val avatarHeaders: Map<String, String>? = null
  /** [2026-10-18 you-tab-nolabel] api 4: sem rótulo embaixo (só o ícone/foto,
   *  centralizado e maior — aba de perfil do Instagram). `label` continua sendo
   *  o contentDescription (TalkBack lê "Você"). */
  @Field val hideLabel: Boolean = false
  /** [2026-10-19 tabbar-offline] api 6: cópia LOCAL da foto (file:// / caminho) — antes da rede. */
  @Field val avatarLocalPath: String? = null
  /** api 6: chave ESTÁVEL da conta (e-mail) p/ a última foto boa em disco (offline-first). */
  @Field val avatarKey: String? = null
}

class NTBThemeRecord : Record {
  @Field val dark: Boolean = false
  @Field val active: Double? = null
  @Field val inactive: Double? = null
  @Field val background: Double? = null
  @Field val hairline: Double? = null
  @Field val badgeBackground: Double? = null
  @Field val badgeText: Double? = null
  @Field val pill: Double? = null
  @Field val ripple: Double? = null
}

/** processColor() do RN = Int ARGB (chega como Double). */
internal fun ntbColor(v: Double?, fallback: Int): Int {
  if (v == null || v.isNaN() || v.isInfinite()) return fallback
  return v.toLong().toInt()
}

class ChatyyTabBarModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyTabBar")

    // 2 = [2026-10-18 you-tab] ícone "you" (aba Você). JS: binário < 2 no Android → barra JS.
    // 3 = [2026-10-18 you-tab-avatar] items[].avatarUrl (foto redonda + anel quando ativa).
    // 4 = [2026-10-18 you-tab-nolabel] items[].hideLabel (sem rótulo; ícone/foto centralizado e maior).
    // 5 = (só iOS: foto por cima do ícone + autochecagem) — Android pula de 4 p/ 6.
    // 6 = [2026-10-19 tabbar-offline] items[].avatarLocalPath + avatarKey: foto OFFLINE-FIRST (última
    //     foto boa por conta em disco, síncrona; rede só revalida; falha nunca volta ao vetor).
    Function("apiVersion") { 7 } // [tabs-v2 2026-10-20] 7 = vetor "mural" (aba Mural)

    View(ChatyyTabBarView::class) {
      Events("onTabPress", "onTabLongPress", "onPreferredHeight")

      Prop("items") { view: ChatyyTabBarView, v: List<NTBItemRecord>? -> view.setItems(v ?: emptyList()) }
      Prop("selectedKey") { view: ChatyyTabBarView, v: String? -> view.setSelectedKeyProp(v) }
      Prop("theme") { view: ChatyyTabBarView, v: NTBThemeRecord? -> view.setThemeProp(v ?: NTBThemeRecord()) }
      Prop("bottomInset") { view: ChatyyTabBarView, v: Double? -> view.setBottomInsetDp((v ?: 0.0).coerceAtLeast(0.0)) }
      Prop("bounce") { view: ChatyyTabBarView, v: Boolean? -> view.bounceEnabled = v ?: true }
      // Só iOS (material translúcido); declarado para o contrato ser igual.
      Prop("translucent") { _: ChatyyTabBarView, _: Boolean? -> }

      OnViewDidUpdateProps { view: ChatyyTabBarView -> view.didUpdateProps() }
    }
  }
}
