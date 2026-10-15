import ExpoModulesCore
import UIKit

// [2026-10-15 native-search-notifs] Lista de RESULTADOS nativa (busca global +
// central de notificações). Ver ChatyyResultListView.swift e
// components/native/NativeResultList.js.
//
// Props:  rowsPatch {seq, base, reset?, upsert?, remove?, order?}, colors
//         {dark, bg, text, sub, faint, hair, primary, onPrimary, error, press,
//         chipBg, border, unreadBg} (ARGB), highlight (termo), separators,
//         swipeEnabled, refreshEnabled, refreshing, topInset, bottomInset,
//         scrollToTopSeq, authToken, autoInset (iOS: inset automático do header)
// Events: onRowPress {id}, onRowAction {id, action: b1|b2|delete|section,
//         source}, onRefresh, onEndReached, onResync {seq},
//         onFirstPaint {count}, onNativeError {message}
public class ChatyyResultListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyResultList")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyResultListView.self) {
      Events(
        "onRowPress",
        "onRowAction",
        "onRefresh",
        "onEndReached",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { (view: ChatyyResultListView, value: [String: Any]?) in
        view.setRowsPatch(value)
      }
      Prop("colors") { (view: ChatyyResultListView, value: [String: Any]?) in
        view.setColors(value)
      }
      Prop("highlight") { (view: ChatyyResultListView, value: String?) in
        view.setHighlight(value ?? "")
      }
      Prop("separators") { (view: ChatyyResultListView, value: Bool?) in
        view.setSeparators(value ?? false)
      }
      Prop("swipeEnabled") { (view: ChatyyResultListView, value: Bool?) in
        view.swipeEnabled = value ?? true
      }
      Prop("refreshEnabled") { (view: ChatyyResultListView, value: Bool?) in
        view.setRefreshEnabled(value ?? false)
      }
      Prop("refreshing") { (view: ChatyyResultListView, value: Bool?) in
        view.setRefreshing(value ?? false)
      }
      Prop("topInset") { (view: ChatyyResultListView, value: Double?) in
        view.setTopInset(CGFloat(value ?? 0))
      }
      Prop("bottomInset") { (view: ChatyyResultListView, value: Double?) in
        view.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("autoInset") { (view: ChatyyResultListView, value: Bool?) in
        view.setAutoInset(value ?? false)
      }
      Prop("scrollToTopSeq") { (view: ChatyyResultListView, value: Double?) in
        view.setScrollToTopSeq(value ?? 0)
      }
      Prop("authToken") { (view: ChatyyResultListView, value: String?) in
        if let v = value, !v.isEmpty { CLImageLoader.shared.authToken = v }
      }

      OnViewDidUpdateProps { (view: ChatyyResultListView) in
        view.commitProps()
      }
    }
  }
}
