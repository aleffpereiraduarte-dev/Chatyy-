import ExpoModulesCore
import UIKit

// [2026-10-14 native-list] Lista de mensagens nativa da conversa.
// JS: components/chat/nativeThreadList.js (requireNativeView('ChatyyMessageList')).
// apiVersion 1 = applyRows/scrollToLatest/scrollToKey/flashKey/setAudioState.
public class ChatyyMessageListModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyMessageList")

    // 2 = [fase 2] blocos (bl/pre/post), spoiler/emoji/code inline, fail/pin/timer,
    //     lift (anchor no long-press + setLiftedKey), flash pulsando, stickyDate,
    //     seleção animada, nota de vídeo.
    Function("apiVersion") { () -> Int in
      return 2
    }

    View(CMLListView.self) {
      Events("onReady", "onNativeError", "onRowPress", "onRowLongPress", "onSwipeReply", "onLoadOlder", "onScrollState", "onDragState", "onVisible")

      Prop("theme") { (view: CMLListView, value: [String: Any]?) in
        view.setTheme(value ?? [:])
      }
      Prop("fontSize") { (view: CMLListView, value: Double?) in
        view.setFontSize(value)
      }
      Prop("lineHeight") { (view: CMLListView, value: Double?) in
        view.setLineHeight(value)
      }
      Prop("bubbleRadius") { (view: CMLListView, value: Double?) in
        view.setRadius(value)
      }
      Prop("dark") { (_: CMLListView, _: Bool?) in
        // cores vêm prontas em `theme`; mantido p/ compatibilidade de props
      }
      Prop("keyboardDismissMode") { (view: CMLListView, value: String?) in
        view.setKeyboardDismissMode(value)
      }
      Prop("bottomInset") { (view: CMLListView, value: Double?) in
        view.setInsets(bottom: value, top: nil)
      }
      Prop("topInset") { (view: CMLListView, value: Double?) in
        view.setInsets(bottom: nil, top: value)
      }
      Prop("stickyDate") { (view: CMLListView, value: [String: Any]?) in
        view.setStickyDate(value)
      }

      AsyncFunction("applyRows") { (view: CMLListView, payload: [String: Any]) in
        view.applyRows(payload)
      }.runOnQueue(.main)

      AsyncFunction("scrollToLatest") { (view: CMLListView, animated: Bool) in
        view.scrollToLatest(animated: animated)
      }.runOnQueue(.main)

      AsyncFunction("scrollToKey") { (view: CMLListView, key: String, viewPosition: Double, animated: Bool) -> Bool in
        return view.scrollToKey(key, viewPosition: viewPosition, animated: animated)
      }.runOnQueue(.main)

      AsyncFunction("flashKey") { (view: CMLListView, key: String) in
        view.flashKey(key)
      }.runOnQueue(.main)

      AsyncFunction("setAudioState") { (view: CMLListView, state: [String: Any]) in
        view.setAudioState(state)
      }.runOnQueue(.main)

      AsyncFunction("setLiftedKey") { (view: CMLListView, key: String) in
        view.setLiftedKey(key)
      }.runOnQueue(.main)
    }
  }
}
