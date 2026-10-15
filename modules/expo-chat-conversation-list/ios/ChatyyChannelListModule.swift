import ExpoModulesCore
import UIKit

// [2026-10-15 native-social] Aba CANAIS em NATIVO — view ChatyyChannelList.
// Props:  rowsPatch, dark, palette, labels, authToken, headerHeight,
//         footerHeight, bottomInset, refreshing, refreshTint
// Events: onRowPress {id}, onRowAction {id, action, emoji?}, onRefresh,
//         onEndReached {count}, onResync {seq}, onFirstPaint {count},
//         onNativeError {message}
public class ChatyyChannelListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyChannelList")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyChannelListView.self) {
      Events(
        "onRowPress",
        "onRowAction",
        "onRefresh",
        "onEndReached",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { (view: ChatyyChannelListView, value: [String: Any]?) in
        view.core.setRowsPatch(value)
      }
      Prop("dark") { (view: ChatyyChannelListView, value: Bool?) in
        view.core.setDark(value ?? false)
      }
      Prop("labels") { (view: ChatyyChannelListView, value: [String: Any]?) in
        view.core.setLabels(value)
      }
      Prop("palette") { (view: ChatyyChannelListView, value: [String: Any]?) in
        view.core.setPalette(value)
      }
      Prop("authToken") { (view: ChatyyChannelListView, value: String?) in
        view.authToken = value ?? ""
        if let v = value, !v.isEmpty { CLImageLoader.shared.authToken = v }
      }
      Prop("headerHeight") { (view: ChatyyChannelListView, value: Double?) in
        view.core.setHeaderHeightHint(CGFloat(value ?? 0))
      }
      Prop("footerHeight") { (view: ChatyyChannelListView, value: Double?) in
        view.core.setFooterHeightHint(CGFloat(value ?? 0))
      }
      Prop("bottomInset") { (view: ChatyyChannelListView, value: Double?) in
        view.core.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("refreshing") { (view: ChatyyChannelListView, value: Bool?) in
        view.core.setRefreshing(value ?? false)
      }
      Prop("refreshTint") { (view: ChatyyChannelListView, value: String?) in
        view.core.setRefreshTint(value ?? "")
      }

      OnViewDidUpdateProps { (view: ChatyyChannelListView) in
        view.commitProps()
      }
    }
  }
}
