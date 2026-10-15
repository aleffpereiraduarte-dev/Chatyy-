package expo.modules.chatyyreelsfeed

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// [2026-10-15 native-reels] Feed vertical de Reels nativo (Android).
// JS: components/reels/NativeReelsFeed.js (requireNativeView('ChatyyReelsFeed')).
// apiVersion 1 = applyItems(reset|append|update|remove) / play / pause / scrollTo.
class ChatyyReelsFeedModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyReelsFeed")

    Function("apiVersion") { 1 }

    OnActivityEntersBackground {
      for (v in RFFeedView.live.toList()) v.enterBackground()
    }

    OnActivityEntersForeground {
      for (v in RFFeedView.live.toList()) v.enterForeground()
    }

    View(RFFeedView::class) {
      Events(
        "onReady", "onNativeError", "onIndexChange", "onLike", "onComment", "onGift", "onShare",
        "onSave", "onFollow", "onAuthorPress", "onMore", "onMusicPress", "onCreditPress",
        "onNeedMore", "onViewProgress", "onMuteChange", "onRefresh", "onPlaybackError", "onLikersPress"
      )

      Prop("labels") { view: RFFeedView, v: Map<String, Any?>? -> view.setLabels(v) }
      Prop("muted") { view: RFFeedView, v: Boolean? -> view.setMuted(v ?: false) }
      Prop("paused") { view: RFFeedView, v: Boolean? -> view.setPaused(v ?: false) }
      Prop("rate") { view: RFFeedView, v: Double? -> view.setRate(v) }
      Prop("captionsEnabled") { view: RFFeedView, v: Boolean? -> view.setCaptionsEnabled(v ?: true) }
      Prop("insets") { view: RFFeedView, v: Map<String, Any?>? -> view.setInsets(v) }
      Prop("imageHeaders") { view: RFFeedView, v: Map<String, Any?>? -> view.setImageHeaders(v) }
      Prop("refreshEnabled") { view: RFFeedView, v: Boolean? -> view.setRefreshEnabled(v ?: false) }
      Prop("refreshing") { view: RFFeedView, v: Boolean? -> view.setRefreshing(v ?: false) }

      OnViewDestroys { view: RFFeedView -> view.destroy() }

      AsyncFunction("applyItems") { view: RFFeedView, payload: Map<String, Any?> ->
        view.applyItems(payload)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("play") { view: RFFeedView ->
        view.play()
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("pause") { view: RFFeedView ->
        view.pause()
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("scrollTo") { view: RFFeedView, index: Int, animated: Boolean ->
        view.scrollTo(index, animated)
      }.runOnQueue(Queues.MAIN)
    }
  }
}
