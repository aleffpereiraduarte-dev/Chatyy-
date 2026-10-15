import ExpoModulesCore
import UIKit

// [2026-10-15 native-inbox] Caixa de entrada do e-mail em NATIVO (mesmo pacote
// da lista de conversas: reaproveita avatar/imagem/tema). JS:
// components/email/{emailNativeAdapter.js,NativeEmailList.js} via
// components/EmailList.js. Contrato em ios/ChatyyEmailListView.swift.
public class ChatyyEmailListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyEmailList")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyEmailListView.self) {
      Events(
        "onRowPress",
        "onLeftPress",
        "onStarPress",
        "onRowAction",
        "onLongPress",
        "onPeekRequest",
        "onPeekOpen",
        "onRefresh",
        "onEndReached",
        "onVisibleIds",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { (view: ChatyyEmailListView, value: [String: Any]?) in
        view.setRowsPatch(value)
      }
      Prop("dark") { (view: ChatyyEmailListView, value: Bool?) in
        view.setDark(value ?? false)
      }
      Prop("palette") { (view: ChatyyEmailListView, value: [String: Any]?) in
        view.setPalette(value)
      }
      Prop("density") { (view: ChatyyEmailListView, value: [String: Any]?) in
        view.setDensity(value)
      }
      Prop("labels") { (view: ChatyyEmailListView, value: [String: Any]?) in
        view.setLabels(value)
      }
      Prop("selectionMode") { (view: ChatyyEmailListView, value: Bool?) in
        view.setSelectionMode(value ?? false)
      }
      Prop("authToken") { (view: ChatyyEmailListView, value: String?) in
        if let v = value, !v.isEmpty { CLImageLoader.shared.authToken = v }
      }
      Prop("peek") { (view: ChatyyEmailListView, value: [String: Any]?) in
        view.setPeek(value)
      }
      Prop("swipeEnabled") { (view: ChatyyEmailListView, value: Bool?) in
        view.swipeEnabled = value ?? true
      }
      Prop("menuEnabled") { (view: ChatyyEmailListView, value: Bool?) in
        view.menuEnabled = value ?? true
      }
      Prop("refreshing") { (view: ChatyyEmailListView, value: Bool?) in
        view.setRefreshing(value ?? false)
      }
      Prop("loadingMore") { (view: ChatyyEmailListView, value: Bool?) in
        view.setLoadingMore(value ?? false)
      }
      Prop("bottomInset") { (view: ChatyyEmailListView, value: Double?) in
        view.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("scrollToTopSeq") { (view: ChatyyEmailListView, value: Double?) in
        view.setScrollToTopSeq(value ?? 0)
      }

      OnViewDidUpdateProps { (view: ChatyyEmailListView) in
        view.commitProps()
      }
    }
  }
}
