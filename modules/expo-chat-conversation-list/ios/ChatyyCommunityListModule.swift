import ExpoModulesCore
import UIKit

// [2026-10-15 native-social] lista da aba COMUNIDADES (components/CommunitiesTab.js → components/communities/NativeCommunityList.js): cartões expansíveis com avatar quadrado arredondado, meta, grupos dentro, X remover (admin) e pílulas Adicionar grupo / Aviso.
// Motor compartilhado: CMListCore (CMListCore.swift) + CMCell (CMCells.swift).
// Props:  rowsPatch, dark, palette, authToken, headerHeight, footerHeight,
//         bottomInset, refreshing, refreshTint, refreshEnabled
// Events: onRowPress {id}, onRowAction {id, action}, onLongPress {id},
//         onRefresh, onResync {seq}, onFirstPaint {count}, onNativeError {message}
public class ChatyyCommunityListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyCommunityList")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyCommunityListView.self) {
      Events(
        "onRowPress",
        "onRowAction",
        "onLongPress",
        "onRefresh",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { (view: ChatyyCommunityListView, value: [String: Any]?) in
        view.core.setRowsPatch(value)
      }
      Prop("dark") { (view: ChatyyCommunityListView, value: Bool?) in
        view.core.setDark(value ?? false)
      }
      Prop("palette") { (view: ChatyyCommunityListView, value: [String: Any]?) in
        view.core.setPalette(value)
      }
      Prop("authToken") { (view: ChatyyCommunityListView, value: String?) in
        if let v = value, !v.isEmpty { CLImageLoader.shared.authToken = v }
      }
      Prop("headerHeight") { (view: ChatyyCommunityListView, value: Double?) in
        view.core.setHeaderHeightHint(CGFloat(value ?? 0))
      }
      Prop("footerHeight") { (view: ChatyyCommunityListView, value: Double?) in
        view.core.setFooterHeightHint(CGFloat(value ?? 0))
      }
      Prop("bottomInset") { (view: ChatyyCommunityListView, value: Double?) in
        view.core.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("refreshing") { (view: ChatyyCommunityListView, value: Bool?) in
        view.core.setRefreshing(value ?? false)
      }
      Prop("refreshTint") { (view: ChatyyCommunityListView, value: String?) in
        view.core.setRefreshTint(value ?? "")
      }
      Prop("refreshEnabled") { (view: ChatyyCommunityListView, value: Bool?) in
        view.core.setRefreshEnabled(value ?? true)
      }

      OnViewDidUpdateProps { (view: ChatyyCommunityListView) in
        view.core.commitProps()
      }
    }
  }
}
