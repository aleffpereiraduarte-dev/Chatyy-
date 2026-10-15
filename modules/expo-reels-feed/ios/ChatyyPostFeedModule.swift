import ExpoModulesCore
import UIKit

// [2026-10-15 native-feed] Aba FEED (posts) em NATIVO. Mesmo pacote dos Reels
// para reaproveitar RFPlayerPool / RFVideoCache / RFImageLoader.
// JS: components/feed/NativePostFeed.js
// Props:  rowsPatch, dark, labels, palette, imageHeaders, headerHeight,
//         footerHeight, bottomInset, refreshing, refreshTint, paused,
//         scrollToTopSeq
// Events: onPostAction {id, action, value, liked?, likes?, saved?},
//         onEndReached, onRefresh, onScrollState {top, hidden}, onResync,
//         onFirstPaint, onNativeError
public class ChatyyPostFeedModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyPostFeed")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(FDPostFeedView.self) {
      Events(
        "onPostAction",
        "onEndReached",
        "onRefresh",
        "onScrollState",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("rowsPatch") { (view: FDPostFeedView, value: [String: Any]?) in
        view.setRowsPatch(value)
      }
      Prop("dark") { (view: FDPostFeedView, value: Bool?) in
        view.setDark(value ?? false)
      }
      Prop("labels") { (view: FDPostFeedView, value: [String: Any]?) in
        view.setLabels(value)
      }
      Prop("palette") { (view: FDPostFeedView, value: [String: Any]?) in
        view.setPalette(value)
      }
      Prop("imageHeaders") { (view: FDPostFeedView, value: [String: Any]?) in
        view.setImageHeaders(value)
      }
      Prop("headerHeight") { (view: FDPostFeedView, value: Double?) in
        view.setHeaderHeightHint(CGFloat(value ?? 0))
      }
      Prop("footerHeight") { (view: FDPostFeedView, value: Double?) in
        view.setFooterHeightHint(CGFloat(value ?? 0))
      }
      Prop("bottomInset") { (view: FDPostFeedView, value: Double?) in
        view.setBottomInset(CGFloat(value ?? 0))
      }
      Prop("refreshing") { (view: FDPostFeedView, value: Bool?) in
        view.setRefreshing(value ?? false)
      }
      Prop("refreshTint") { (view: FDPostFeedView, value: String?) in
        view.setRefreshTint(value ?? "")
      }
      Prop("paused") { (view: FDPostFeedView, value: Bool?) in
        view.setPaused(value ?? false)
      }
      Prop("scrollToTopSeq") { (view: FDPostFeedView, value: Double?) in
        view.setScrollToTopSeq(value ?? 0)
      }

      OnViewDidUpdateProps { (view: FDPostFeedView) in
        view.commitProps()
      }
    }
  }
}
