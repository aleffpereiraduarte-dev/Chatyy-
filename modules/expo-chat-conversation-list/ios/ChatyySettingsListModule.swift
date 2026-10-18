import ExpoModulesCore
import UIKit

// [2026-10-15 settings-native] Raiz das Configurações em NATIVO.
// Ver ChatyySettingsListView.swift e components/settings/NativeSettingsList.js.
//
// Props:  rowsPatch {seq, base, reset?, upsert?, remove?, order?}, query,
//         colors {pageBg, cardBg, separator, header, text, secondary, tertiary,
//         chipBg, chipFg, destructive, press} (ARGB), dark, labels
//         {results, noResults}, headerHeight, bottomInset, maxContentWidth,
//         autoInset, refreshing, scrollToId ("id|token", api 2)
// Events: onRowPress {id}, onToggle {id, value}, onRefresh, onResync {seq},
//         onFirstPaint {count}, onNativeError {message}
public class ChatyySettingsListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyySettingsList")

    Function("apiVersion") { () -> Int in
      // 2 = [2026-10-18 settings-sub-native] val/acc/dis/tl/sl/ft, k "i",
      //     ícones do ChatInfo e prop scrollToId (sub-páginas nativas).
      // 3 = [2026-10-18 bia-orb-icon] ícone "biaOrb" (orb da Bia desenhado).
      // 4 = [2026-10-18 settings-sub-native-2] "vd" (valor na cor destrutiva) —
      //     Conta/Conversas/E-mail/Idioma/Armazenamento em nativo.
      return 4
    }

    View(ChatyySettingsListView.self) {
      Events(
        "onRowPress",
        "onToggle",
        "onRefresh",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { (view: ChatyySettingsListView, value: [String: Any]?) in
        view.setRowsPatch(value)
      }
      Prop("query") { (view: ChatyySettingsListView, value: String?) in
        view.setQuery(value ?? "")
      }
      Prop("colors") { (view: ChatyySettingsListView, value: [String: Any]?) in
        view.setColors(value)
      }
      Prop("dark") { (view: ChatyySettingsListView, value: Bool?) in
        view.setDark(value ?? false)
      }
      Prop("labels") { (view: ChatyySettingsListView, value: [String: Any]?) in
        view.setLabels(value)
      }
      Prop("headerHeight") { (view: ChatyySettingsListView, value: Double?) in
        view.setHeaderHeightHint(CGFloat(value ?? 0))
      }
      Prop("bottomInset") { (view: ChatyySettingsListView, value: Double?) in
        view.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("maxContentWidth") { (view: ChatyySettingsListView, value: Double?) in
        view.setMaxContentWidth(CGFloat(value ?? 0))
      }
      Prop("autoInset") { (view: ChatyySettingsListView, value: Bool?) in
        view.setAutoInset(value ?? false)
      }
      Prop("refreshing") { (view: ChatyySettingsListView, value: Bool?) in
        view.setRefreshing(value ?? false)
      }
      Prop("scrollToId") { (view: ChatyySettingsListView, value: String?) in
        view.setScrollToId(value ?? "")
      }

      OnViewDidUpdateProps { (view: ChatyySettingsListView) in
        view.commitProps()
      }
    }
  }
}
