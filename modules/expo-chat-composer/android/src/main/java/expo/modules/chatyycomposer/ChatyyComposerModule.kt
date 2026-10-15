package expo.modules.chatyycomposer

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/**
 * [2026-10-14 native-composer] Composer da conversa NATIVO (Android). Mesmo
 * contrato da versão iOS (ios/ChatyyComposerModule.swift):
 *
 * Props: placeholder, labels{}, theme{}, replyPreview{}|null, mentionCandidates[],
 *   sendMenu[], defaultText, bottomInset, sending, uploading, enterSends,
 *   autocorrect, maxLength, maxLines, showEmoji, emojiActive, showCamera,
 *   showVideoNote, voiceEnabled, voiceBlocked, disabled, changeDebounceMs,
 *   keyboardTracking ('none' | 'translate').
 * Eventos: onChangeText, onSend, onAttach, onCamera, onEmoji, onVideoNote,
 *   onVoiceRecorded, onVoiceState, onHeightChange, onSelectionChange,
 *   onPasteImage, onFocusChange, onReplyCancel, onSendMenu, onKeyboardFrame.
 * Métodos: focus, blur, setText, clear, setSelection, cancelVoice.
 */
class NCThemeRecord : Record {
  @Field val dark: Boolean = false
  @Field val surface: Double? = null
  @Field val pill: Double? = null
  @Field val pillBorder: Double? = null
  @Field val text: Double? = null
  @Field val secondaryText: Double? = null
  @Field val placeholder: Double? = null
  @Field val icon: Double? = null
  @Field val iconActive: Double? = null
  @Field val action: Double? = null
  @Field val actionIcon: Double? = null
  @Field val hairline: Double? = null
  @Field val accent: Double? = null
  @Field val mention: Double? = null
  @Field val replyCard: Double? = null
  @Field val replyCardBorder: Double? = null
  @Field val recording: Double? = null
}

class NCReplyRecord : Record {
  @Field val kind: String = "reply"
  @Field val key: String = ""
  @Field val title: String = ""
  @Field val text: String = ""
  @Field val italic: Boolean = false
  @Field val thumbUri: String? = null
  @Field val thumbRound: Boolean = false
  // [reply-v2] cor do remetente (ARGB), tipo, linhas do trecho (0 = legado),
  // abrir teclado, "pulinho"; ícone vem como paths SVG (viewBox iconVb).
  @Field val color: Double? = null
  @Field val icon: String = ""
  @Field val lines: Int = 0
  @Field val focus: Boolean = false
  @Field val pop: Boolean = false
  @Field val iconVb: Double = 24.0
  @Field val iconPaths: List<NCIconPathRecord>? = null
}

class NCIconPathRecord : Record {
  @Field val d: String = ""
  @Field val fill: Int = 0
  @Field val w: Double = 0.0
}

class NCMentionRecord : Record {
  @Field val token: String = ""
  @Field val email: String = ""
}

class NCMenuItemRecord : Record {
  @Field val key: String = ""
  @Field val label: String = ""
}

/** processColor() do RN = Int ARGB (chega como Double). */
internal fun ncColor(v: Double?, fallback: Int): Int {
  if (v == null || v.isNaN() || v.isInfinite()) return fallback
  return v.toLong().toInt()
}

class ChatyyComposerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyComposer")

    Function("apiVersion") { 1 }

    View(ChatyyComposerView::class) {
      Events(
        "onChangeText", "onSend", "onAttach", "onCamera", "onEmoji", "onVideoNote",
        "onVoiceRecorded", "onVoiceState", "onHeightChange", "onSelectionChange",
        "onPasteImage", "onFocusChange", "onReplyCancel", "onSendMenu", "onKeyboardFrame"
      )

      Prop("placeholder") { view: ChatyyComposerView, v: String? -> view.setPlaceholder(v ?: "") }
      Prop("labels") { view: ChatyyComposerView, v: Map<String, String>? -> view.setLabels(v ?: emptyMap()) }
      Prop("theme") { view: ChatyyComposerView, v: NCThemeRecord? -> view.pendingTheme = v ?: NCThemeRecord() }
      Prop("replyPreview") { view: ChatyyComposerView, v: NCReplyRecord? -> view.setPendingReply(v) }
      Prop("mentionCandidates") { view: ChatyyComposerView, v: List<NCMentionRecord>? -> view.setMentionCandidates(v ?: emptyList()) }
      Prop("sendMenu") { view: ChatyyComposerView, v: List<NCMenuItemRecord>? -> view.sendMenuItems = v ?: emptyList() }
      Prop("defaultText") { view: ChatyyComposerView, v: String? -> view.applyDefaultText(v ?: "") }
      Prop("bottomInset") { view: ChatyyComposerView, v: Double? -> view.setBottomInsetDp((v ?: 0.0).coerceAtLeast(0.0)) }
      Prop("sending") { view: ChatyyComposerView, v: Boolean? -> view.setSending(v ?: false) }
      Prop("uploading") { view: ChatyyComposerView, v: Boolean? -> view.setUploading(v ?: false) }
      Prop("enterSends") { view: ChatyyComposerView, v: Boolean? -> view.setEnterSends(v ?: false) }
      Prop("autocorrect") { view: ChatyyComposerView, v: Boolean? -> view.setAutocorrect(v ?: true) }
      Prop("maxLength") { view: ChatyyComposerView, v: Int? -> view.setMaxLength((v ?: 5000).coerceAtLeast(1)) }
      Prop("maxLines") { view: ChatyyComposerView, v: Int? -> view.setMaxLinesProp((v ?: 6).coerceIn(1, 12)) }
      Prop("showEmoji") { view: ChatyyComposerView, v: Boolean? -> view.setShowEmoji(v ?: true) }
      Prop("emojiActive") { view: ChatyyComposerView, v: Boolean? -> view.setEmojiActive(v ?: false) }
      Prop("showCamera") { view: ChatyyComposerView, v: Boolean? -> view.setShowCamera(v ?: true) }
      Prop("showVideoNote") { view: ChatyyComposerView, v: Boolean? -> view.setShowVideoNote(v ?: false) }
      Prop("voiceEnabled") { view: ChatyyComposerView, v: Boolean? -> view.voiceEnabled = v ?: true }
      Prop("voiceBlocked") { view: ChatyyComposerView, v: Boolean? -> view.voiceBlocked = v ?: false }
      Prop("disabled") { view: ChatyyComposerView, v: Boolean? -> view.setDisabledProp(v ?: false) }
      Prop("changeDebounceMs") { view: ChatyyComposerView, v: Double? -> view.changeDebounceMs = (v ?: 60.0).coerceAtLeast(0.0).toLong() }
      Prop("keyboardTracking") { view: ChatyyComposerView, v: String? -> view.setKeyboardTracking(v ?: "none") }

      OnViewDidUpdateProps { view: ChatyyComposerView -> view.didUpdateProps() }

      AsyncFunction("focus") { view: ChatyyComposerView -> view.focusInput() }.runOnQueue(Queues.MAIN)
      AsyncFunction("blur") { view: ChatyyComposerView -> view.blurInput() }.runOnQueue(Queues.MAIN)
      AsyncFunction("setText") { view: ChatyyComposerView, text: String -> view.setTextFromJS(text) }.runOnQueue(Queues.MAIN)
      AsyncFunction("clear") { view: ChatyyComposerView -> view.setTextFromJS("") }.runOnQueue(Queues.MAIN)
      AsyncFunction("setSelection") { view: ChatyyComposerView, start: Int, end: Int ->
        view.setSelectionFromJS(start, end)
      }.runOnQueue(Queues.MAIN)
      AsyncFunction("cancelVoice") { view: ChatyyComposerView -> view.cancelVoiceFromJS() }.runOnQueue(Queues.MAIN)
    }
  }
}
