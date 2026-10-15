import ExpoModulesCore
import UIKit

// [2026-10-15 native-live] Palco nativo do visualizador de live (ChatyyLiveStageView).
// JS: modules/expo-chat-effects/liveStage.js → <ChatyyLiveStage/> + ref.spawnHearts/burst/playGift/resetSwipe.
public class ChatyyLiveStageModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyLiveStage")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyLiveStageView.self) {
      Events("onSwipe", "onStageTap", "onMuteToggle")

      Prop("peekNext") { (view: ChatyyLiveStageView, v: [String: Any]?) in view.setPeekNext(v) }
      Prop("peekPrev") { (view: ChatyyLiveStageView, v: [String: Any]?) in view.setPeekPrev(v) }
      Prop("swipeEnabled") { (view: ChatyyLiveStageView, v: Bool?) in view.setSwipeEnabled(v) }
      Prop("tapHearts") { (view: ChatyyLiveStageView, v: Bool?) in view.setTapHearts(v) }
      Prop("heartColors") { (view: ChatyyLiveStageView, v: [String]?) in view.setHeartColors(v) }
      Prop("muted") { (view: ChatyyLiveStageView, v: Bool?) in view.setMuted(v) }
      Prop("showMute") { (view: ChatyyLiveStageView, v: Bool?) in view.setShowMute(v) }
      Prop("controlsTop") { (view: ChatyyLiveStageView, v: Double?) in view.setControlsTop(v) }
      Prop("labels") { (view: ChatyyLiveStageView, v: [String: Any]?) in view.setLabels(v) }

      AsyncFunction("spawnHearts") { (view: ChatyyLiveStageView, items: [[String: Any]]) in
        view.spawnHearts(items)
      }.runOnQueue(.main)

      AsyncFunction("burst") { (view: ChatyyLiveStageView, opts: [String: Any]?) in
        var p: CGPoint? = nil
        if let x = (opts?["x"] as? NSNumber)?.doubleValue, let y = (opts?["y"] as? NSNumber)?.doubleValue {
          p = CGPoint(x: x, y: y)
        }
        view.spawnBurst(at: p)
      }.runOnQueue(.main)

      AsyncFunction("playGift") { (view: ChatyyLiveStageView, opts: [String: Any]) in
        view.playGift(opts)
      }.runOnQueue(.main)

      AsyncFunction("resetSwipe") { (view: ChatyyLiveStageView) in
        view.resetSwipe()
      }.runOnQueue(.main)
    }
  }
}
