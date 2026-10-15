import ExpoModulesCore
import UIKit

// [2026-10-15 native-calls] Histórico da aba Ligações em NATIVO.
// Ver ChatyyCallListView.swift e components/calls/NativeCallList.js.
//
// Props:  rowsPatch {seq, base, reset?, upsert?, remove?, order?}, dark, labels,
//         authToken, headerHeight, bottomInset, collapseOffset, swipeEnabled,
//         menuEnabled
// Events: onRowPress {id}, onRowAction {id, action, source}, onCollapsedChange
//         {collapsed}, onResync {seq}, onFirstPaint {count}, onNativeError {message}
public class ChatyyCallListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyCallList")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyCallListView.self) {
      Events(
        "onRowPress",
        "onRowAction",
        "onCollapsedChange",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { (view: ChatyyCallListView, value: [String: Any]?) in
        view.setRowsPatch(value)
      }
      Prop("dark") { (view: ChatyyCallListView, value: Bool?) in
        view.setDark(value ?? false)
      }
      Prop("labels") { (view: ChatyyCallListView, value: [String: Any]?) in
        view.setLabels(value)
      }
      Prop("authToken") { (view: ChatyyCallListView, value: String?) in
        CLImageLoader.shared.authToken = value ?? ""
      }
      Prop("headerHeight") { (view: ChatyyCallListView, value: Double?) in
        view.setHeaderHeightHint(CGFloat(value ?? 0))
      }
      Prop("bottomInset") { (view: ChatyyCallListView, value: Double?) in
        view.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("collapseOffset") { (view: ChatyyCallListView, value: Double?) in
        view.collapseOffset = CGFloat(value ?? 34)
      }
      Prop("swipeEnabled") { (view: ChatyyCallListView, value: Bool?) in
        view.swipeEnabled = value ?? true
      }
      Prop("menuEnabled") { (view: ChatyyCallListView, value: Bool?) in
        view.menuEnabled = value ?? true
      }

      OnViewDidUpdateProps { (view: ChatyyCallListView) in
        view.commitProps()
      }
    }
  }
}
