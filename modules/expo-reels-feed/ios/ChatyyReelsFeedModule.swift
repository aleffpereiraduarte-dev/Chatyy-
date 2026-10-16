import ExpoModulesCore
import UIKit

// [2026-10-15 native-reels] Feed vertical de Reels nativo.
// JS: components/reels/NativeReelsFeed.js (requireNativeView('ChatyyReelsFeed')).
// apiVersion 1 = applyItems(reset|append|update|remove) / play / pause / scrollTo.
public class ChatyyReelsFeedModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyReelsFeed")

    // 2 = [2026-10-16 reels-rail-v2] labels.railStyle/countK/countM/decimalSep +
    //     item.shares/saves/verified/musicCover (trilho redesenhado).
    Function("apiVersion") { () -> Int in
      return 2
    }

    View(RFFeedView.self) {
      Events(
        "onReady", "onNativeError", "onIndexChange", "onLike", "onComment", "onGift", "onShare",
        "onSave", "onFollow", "onAuthorPress", "onMore", "onMusicPress", "onCreditPress",
        "onNeedMore", "onViewProgress", "onMuteChange", "onRefresh", "onPlaybackError", "onLikersPress"
      )

      Prop("labels") { (view: RFFeedView, value: [String: Any]?) in
        view.setLabels(value ?? [:])
      }
      Prop("muted") { (view: RFFeedView, value: Bool?) in
        view.setMuted(value ?? false)
      }
      Prop("paused") { (view: RFFeedView, value: Bool?) in
        view.setPaused(value ?? false)
      }
      Prop("rate") { (view: RFFeedView, value: Double?) in
        view.setRate(value)
      }
      Prop("captionsEnabled") { (view: RFFeedView, value: Bool?) in
        view.setCaptionsEnabled(value ?? true)
      }
      Prop("insets") { (view: RFFeedView, value: [String: Any]?) in
        view.setInsets(value ?? [:])
      }
      Prop("imageHeaders") { (view: RFFeedView, value: [String: Any]?) in
        view.setImageHeaders(value ?? [:])
      }
      Prop("refreshEnabled") { (view: RFFeedView, value: Bool?) in
        view.setRefreshEnabled(value ?? false)
      }
      Prop("refreshing") { (view: RFFeedView, value: Bool?) in
        view.setRefreshing(value ?? false)
      }

      AsyncFunction("applyItems") { (view: RFFeedView, payload: [String: Any]) in
        view.applyItems(payload)
      }.runOnQueue(.main)

      AsyncFunction("play") { (view: RFFeedView) in
        view.play()
      }.runOnQueue(.main)

      AsyncFunction("pause") { (view: RFFeedView) in
        view.pause()
      }.runOnQueue(.main)

      AsyncFunction("scrollTo") { (view: RFFeedView, index: Int, animated: Bool) in
        view.scrollTo(index, animated: animated)
      }.runOnQueue(.main)
    }
  }
}
