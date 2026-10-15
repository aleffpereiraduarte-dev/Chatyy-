import ExpoModulesCore
import UIKit

// [2026-10-15 native-wallet] Carteira em NATIVO (app/wallet.js,
// app/creator-earnings.js). Ver ChatyyWalletListView.swift e
// components/native/NativeWalletList.js.
//
// Props:  rowsPatch {seq, base, reset?, upsert?, remove?, order?}, hero (WLHero),
//         colors {pageBg, cardBg, separator, text, secondary, tertiary, fill,
//         success, danger, ink, onInk, press} (ARGB), dark, headerHeight,
//         heroTop, heroGap, bottomInset, maxContentWidth, autoInset,
//         refreshEnabled, refreshing, authToken
// Events: onRowPress {id}, onRowAction {id, action}, onHeroAction {id},
//         onRefresh, onEndReached, onResync {seq}, onFirstPaint {count},
//         onNativeError {message}
public class ChatyyWalletListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyWalletList")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyWalletListView.self) {
      Events(
        "onRowPress",
        "onRowAction",
        "onHeroAction",
        "onRefresh",
        "onEndReached",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { (view: ChatyyWalletListView, value: [String: Any]?) in
        view.setRowsPatch(value)
      }
      Prop("hero") { (view: ChatyyWalletListView, value: [String: Any]?) in
        view.setHero(value)
      }
      Prop("colors") { (view: ChatyyWalletListView, value: [String: Any]?) in
        view.setColors(value)
      }
      Prop("dark") { (view: ChatyyWalletListView, value: Bool?) in
        view.setDark(value ?? false)
      }
      Prop("headerHeight") { (view: ChatyyWalletListView, value: Double?) in
        view.setHeaderHeightHint(CGFloat(value ?? 0))
      }
      Prop("heroInsets") { (view: ChatyyWalletListView, value: [String: Any]?) in
        let top = value?["top"] == nil ? 16 : CLVal.double(value?["top"])
        let gap = value?["gap"] == nil ? 16 : CLVal.double(value?["gap"])
        view.setHeroInsets(top: CGFloat(top), gap: CGFloat(gap))
      }
      Prop("bottomInset") { (view: ChatyyWalletListView, value: Double?) in
        view.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("maxContentWidth") { (view: ChatyyWalletListView, value: Double?) in
        view.setMaxContentWidth(CGFloat(value ?? 0))
      }
      Prop("autoInset") { (view: ChatyyWalletListView, value: Bool?) in
        view.setAutoInset(value ?? false)
      }
      Prop("refreshEnabled") { (view: ChatyyWalletListView, value: Bool?) in
        view.setRefreshEnabled(value ?? true)
      }
      Prop("refreshing") { (view: ChatyyWalletListView, value: Bool?) in
        view.setRefreshing(value ?? false)
      }
      Prop("authToken") { (_: ChatyyWalletListView, value: String?) in
        if let v = value, !v.isEmpty { CLImageLoader.shared.authToken = v }
      }

      OnViewDidUpdateProps { (view: ChatyyWalletListView) in
        view.commitProps()
      }
    }
  }
}
