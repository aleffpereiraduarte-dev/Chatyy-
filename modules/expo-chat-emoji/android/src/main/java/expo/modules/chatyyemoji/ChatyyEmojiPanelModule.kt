package expo.modules.chatyyemoji

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-15 native-emoji] Painel do composer NATIVO (Android): Emoji |
 * Figurinhas | GIF. Mesmo contrato do iOS (ios/ChatyyEmojiPanelModule.swift):
 *
 * Props: theme{}, labels{}, tab, bottomInset, compact, showStickers, showGifs,
 *   stickerSections[], gifs[], gifLoading.
 * Eventos: onEmoji{emoji}, onBackspace, onSticker{key, uri, section}, onGif{key},
 *   onGifQuery{query}, onSection{key}, onTabChange{tab}, onMore{tab},
 *   onSearchFocus{focused, tab}.
 * Métodos: blurSearch(), resetSearch().
 */
internal fun epColor(v: Any?, fallback: Int): Int {
  val d = (v as? Number)?.toDouble() ?: return fallback
  if (d.isNaN() || d.isInfinite()) return fallback
  return d.toLong().toInt()
}

class ChatyyEmojiPanelModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyEmojiPanel")

    Function("apiVersion") { 1 }

    View(ChatyyEmojiPanelView::class) {
      Events(
        "onEmoji", "onBackspace", "onSticker", "onGif", "onGifQuery",
        "onSection", "onTabChange", "onMore", "onSearchFocus"
      )

      Prop("theme") { view: ChatyyEmojiPanelView, v: Map<String, Any?>? -> view.setTheme(v ?: emptyMap()) }
      Prop("labels") { view: ChatyyEmojiPanelView, v: Map<String, String>? -> view.setLabels(v ?: emptyMap()) }
      Prop("tab") { view: ChatyyEmojiPanelView, v: String? -> view.setTabProp(v ?: "emoji") }
      Prop("bottomInset") { view: ChatyyEmojiPanelView, v: Double? -> view.setBottomInsetDp((v ?: 0.0).coerceAtLeast(0.0)) }
      Prop("compact") { view: ChatyyEmojiPanelView, v: Boolean? -> view.setCompact(v ?: false) }
      Prop("showStickers") { view: ChatyyEmojiPanelView, v: Boolean? -> view.setShowStickers(v ?: true) }
      Prop("showGifs") { view: ChatyyEmojiPanelView, v: Boolean? -> view.setShowGifs(v ?: true) }
      Prop("stickerSections") { view: ChatyyEmojiPanelView, v: List<Map<String, Any?>>? -> view.setStickerSections(v ?: emptyList()) }
      Prop("gifs") { view: ChatyyEmojiPanelView, v: List<Map<String, Any?>>? -> view.setGifs(v ?: emptyList()) }
      Prop("gifLoading") { view: ChatyyEmojiPanelView, v: Boolean? -> view.setGifLoading(v ?: false) }

      OnViewDidUpdateProps { view: ChatyyEmojiPanelView -> view.didUpdateProps() }

      AsyncFunction("blurSearch") { view: ChatyyEmojiPanelView -> view.blurSearch() }.runOnQueue(Queues.MAIN)
      AsyncFunction("resetSearch") { view: ChatyyEmojiPanelView -> view.resetSearch() }.runOnQueue(Queues.MAIN)
    }
  }
}
