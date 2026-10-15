import ExpoModulesCore
import UIKit

// [2026-10-15 native-social] tela da comunidade (app/community/[id].js → components/communities/NativeCommunityDetail.js): avisos, grupos (tag Avisos), membros (tag de cargo, toque longo = gerir), sobre. Capa/título/abas = filho RN 0 (header); compositor/dica = filho RN 1 (rodapé).
// Motor compartilhado: CMListCore (CMListCore.swift) + CMCell (CMCells.swift).
// Props:  rowsPatch, dark, palette, authToken, headerHeight, footerHeight,
//         bottomInset, refreshing, refreshTint, refreshEnabled
// Events: onRowPress {id}, onRowAction {id, action}, onLongPress {id},
//         onRefresh, onResync {seq}, onFirstPaint {count}, onNativeError {message}
public class ChatyyCommunityDetailModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyCommunityDetail")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyCommunityDetailView.self) {
      Events(
        "onRowPress",
        "onRowAction",
        "onLongPress",
        "onRefresh",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { (view: ChatyyCommunityDetailView, value: [String: Any]?) in
        view.core.setRowsPatch(value)
      }
      Prop("dark") { (view: ChatyyCommunityDetailView, value: Bool?) in
        view.core.setDark(value ?? false)
      }
      Prop("palette") { (view: ChatyyCommunityDetailView, value: [String: Any]?) in
        view.core.setPalette(value)
      }
      Prop("authToken") { (view: ChatyyCommunityDetailView, value: String?) in
        if let v = value, !v.isEmpty { CLImageLoader.shared.authToken = v }
      }
      Prop("headerHeight") { (view: ChatyyCommunityDetailView, value: Double?) in
        view.core.setHeaderHeightHint(CGFloat(value ?? 0))
      }
      Prop("footerHeight") { (view: ChatyyCommunityDetailView, value: Double?) in
        view.core.setFooterHeightHint(CGFloat(value ?? 0))
      }
      Prop("bottomInset") { (view: ChatyyCommunityDetailView, value: Double?) in
        view.core.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("refreshing") { (view: ChatyyCommunityDetailView, value: Bool?) in
        view.core.setRefreshing(value ?? false)
      }
      Prop("refreshTint") { (view: ChatyyCommunityDetailView, value: String?) in
        view.core.setRefreshTint(value ?? "")
      }
      Prop("refreshEnabled") { (view: ChatyyCommunityDetailView, value: Bool?) in
        view.core.setRefreshEnabled(value ?? true)
      }

      OnViewDidUpdateProps { (view: ChatyyCommunityDetailView) in
        view.core.commitProps()
      }
    }
  }
}
