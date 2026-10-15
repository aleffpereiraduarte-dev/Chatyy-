import ExpoModulesCore
import UIKit

// [2026-10-15 native-lists] Aba STATUS em NATIVO (UICollectionView lista
// compositional + diffable): cartões com avatar + anel segmentado
// (visto/não visto) ou miniatura do status de texto, nome, hora e contagem;
// seções Meus / Recentes / Vistos / Silenciados (recolhível); swipe
// silenciar/reativar; menu de contexto com prévia da última atualização;
// pull-to-refresh nativo. Topo da aba (título grande, busca, carrossel,
// "Meu status") = 1º filho RN, rola junto; estado vazio = 2º filho.
//
// JS: components/status/NativeStatusList.js
// Props:  rowsPatch, dark, labels, palette, authToken, headerHeight,
//         footerHeight, bottomInset, collapseOffset, refreshing, refreshTint
// Events: onRowPress, onRowPressIn, onRowAction {id, action, source},
//         onLongPress, onPeekOpen, onRefresh, onCollapsedChange, onResync,
//         onFirstPaint, onNativeError
public class ChatyyStatusListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyStatusList")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyStatusListView.self) {
      Events(
        "onRowPress",
        "onRowPressIn",
        "onRowAction",
        "onLongPress",
        "onPeekOpen",
        "onRefresh",
        "onCollapsedChange",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { (view: ChatyyStatusListView, value: [String: Any]?) in
        view.setRowsPatch(value)
      }
      Prop("dark") { (view: ChatyyStatusListView, value: Bool?) in
        view.setDark(value ?? false)
      }
      Prop("labels") { (view: ChatyyStatusListView, value: [String: Any]?) in
        view.setLabels(value)
      }
      Prop("palette") { (view: ChatyyStatusListView, value: [String: Any]?) in
        view.setPalette(value)
      }
      Prop("authToken") { (view: ChatyyStatusListView, value: String?) in
        view.authToken = value ?? ""
        if let v = value, !v.isEmpty { CLImageLoader.shared.authToken = v }
      }
      Prop("headerHeight") { (view: ChatyyStatusListView, value: Double?) in
        view.setHeaderHeightHint(CGFloat(value ?? 0))
      }
      Prop("footerHeight") { (view: ChatyyStatusListView, value: Double?) in
        view.setFooterHeightHint(CGFloat(value ?? 0))
      }
      Prop("bottomInset") { (view: ChatyyStatusListView, value: Double?) in
        view.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("collapseOffset") { (view: ChatyyStatusListView, value: Double?) in
        view.collapseOffset = CGFloat(value ?? 34)
      }
      Prop("refreshing") { (view: ChatyyStatusListView, value: Bool?) in
        view.setRefreshing(value ?? false)
      }
      Prop("refreshTint") { (view: ChatyyStatusListView, value: String?) in
        view.setRefreshTint(value ?? "")
      }

      OnViewDidUpdateProps { (view: ChatyyStatusListView) in
        view.commitProps()
      }
    }
  }
}
