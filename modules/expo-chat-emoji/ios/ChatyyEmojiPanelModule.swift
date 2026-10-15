import ExpoModulesCore
import UIKit

// [2026-10-15 native-emoji] Painel Emoji | Figurinhas | GIF do composer.
// JS: components/chat/NativeEmojiPanelBridge.js (requireNativeView('ChatyyEmojiPanel')).
// Props: theme{}, labels{}, tab, bottomInset, compact, showStickers, showGifs,
//        stickerSections[], gifs[], gifLoading.
// Eventos: onEmoji{emoji}, onBackspace, onSticker{key, uri, section}, onGif{key},
//        onGifQuery{query}, onSection{key}, onTabChange{tab}, onMore{tab},
//        onSearchFocus{focused, tab}.
// Métodos (ref): blurSearch, resetSearch.
public class ChatyyEmojiPanelModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyEmojiPanel")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyEmojiPanelView.self) {
      Events(
        "onEmoji", "onBackspace", "onSticker", "onGif", "onGifQuery",
        "onSection", "onTabChange", "onMore", "onSearchFocus"
      )

      Prop("theme") { (view: ChatyyEmojiPanelView, v: [String: Any]?) in view.pendingTheme = v ?? [:] }
      Prop("labels") { (view: ChatyyEmojiPanelView, v: [String: String]?) in view.labels = v ?? [:] }
      Prop("tab") { (view: ChatyyEmojiPanelView, v: String?) in view.tabProp = v ?? "emoji" }
      Prop("bottomInset") { (view: ChatyyEmojiPanelView, v: Double?) in view.bottomInset = CGFloat(max(0, v ?? 0)) }
      Prop("compact") { (view: ChatyyEmojiPanelView, v: Bool?) in view.compact = v ?? false }
      Prop("showStickers") { (view: ChatyyEmojiPanelView, v: Bool?) in view.showStickers = v ?? true }
      Prop("showGifs") { (view: ChatyyEmojiPanelView, v: Bool?) in view.showGifs = v ?? true }
      Prop("stickerSections") { (view: ChatyyEmojiPanelView, v: [Any]?) in view.pendingStickers = (v ?? []).compactMap { $0 as? [String: Any] } }
      Prop("gifs") { (view: ChatyyEmojiPanelView, v: [Any]?) in view.pendingGifs = (v ?? []).compactMap { $0 as? [String: Any] } }
      Prop("gifLoading") { (view: ChatyyEmojiPanelView, v: Bool?) in view.gifLoading = v ?? false }

      OnViewDidUpdateProps { (view: ChatyyEmojiPanelView) in
        view.didUpdateProps()
      }

      AsyncFunction("blurSearch") { (view: ChatyyEmojiPanelView) in
        view.blurSearch()
      }.runOnQueue(.main)

      AsyncFunction("resetSearch") { (view: ChatyyEmojiPanelView) in
        view.resetSearch()
      }.runOnQueue(.main)
    }
  }
}
