import ExpoModulesCore
import UIKit

// [2026-10-14 native-composer] Composer da conversa 100% NATIVO (nível
// Telegram/iMessage). A view `ChatyyComposer` só CAPTURA e ENTREGA: texto,
// seleção, colar imagem, toques em +/câmera/emoji/vídeo-recado, envio e o áudio
// gravado (m4a AAC mono). Toda a lógica de envio/fila/rascunho/menções continua
// no JS (app/chat-conversation.js via components/chat/NativeComposerBridge.js).
//
// Props: placeholder, labels{}, theme{}, replyPreview{}|null, mentionCandidates[],
//        sendMenu[], defaultText, bottomInset, sending, uploading, enterSends,
//        autocorrect, maxLength, maxLines, showEmoji, emojiActive, showCamera,
//        showVideoNote, voiceEnabled, voiceBlocked, disabled, changeDebounceMs,
//        keyboardTracking ('none' | 'translate').
// Eventos: onChangeText{text}, onSend{text, mentions[]}, onAttach, onCamera,
//        onEmoji, onVideoNote, onVoiceRecorded{uri, durationMs, waveform[],
//        sizeBytes, mimeType, name}, onVoiceState{state, reason?},
//        onHeightChange{height}, onSelectionChange{start, end},
//        onPasteImage{uri, mimeType, name, width, height, size},
//        onFocusChange{focused}, onReplyCancel, onSendMenu{key},
//        onKeyboardFrame{height, lift}.
// Métodos (ref): focus, blur, setText(text), clear, setSelection(start, end),
//        cancelVoice.

struct NCThemeRecord: Record {
  @Field var dark: Bool = false
  @Field var surface: Double? = nil
  @Field var pill: Double? = nil
  @Field var pillBorder: Double? = nil
  @Field var text: Double? = nil
  @Field var secondaryText: Double? = nil
  @Field var placeholder: Double? = nil
  @Field var icon: Double? = nil
  @Field var iconActive: Double? = nil
  @Field var action: Double? = nil
  @Field var actionIcon: Double? = nil
  @Field var hairline: Double? = nil
  @Field var accent: Double? = nil
  @Field var mention: Double? = nil
  @Field var replyCard: Double? = nil
  @Field var replyCardBorder: Double? = nil
  @Field var recording: Double? = nil
}

// [2026-10-16 reply-card-ios] Cartão de resposta: struct SIMPLES + conversão à
// mão. Antes era um `Record` (NCReplyRecord) e o `updateProps` do Expo no Fabric
// faz `try? prop.set(...)` — qualquer falha de conversão de UM campo descartava
// o cartão inteiro em silêncio (build 692: cartão nunca aparecia). Agora a prop
// chega como dicionário cru, cada campo é tolerante (NSNull/NSNumber/String) e
// o que não bate vira default + log de diagnóstico, nunca "sem cartão".
struct NCReply: Equatable {
  var kind: String = "reply"
  var key: String = ""
  var title: String = ""
  var text: String = ""
  var italic: Bool = false
  var thumbUri: String? = nil
  var thumbRound: Bool = false
  // [reply-v2] cor do remetente (ARGB), ícone por tipo, nº de linhas do trecho
  // (0 = legado), abrir teclado e "pulinho" ao trocar de alvo.
  var color: Double? = nil
  var icon: String = ""
  var lines: Int = 0
  var focus: Bool = false
  var pop: Bool = false

  /// nil/NSNull/dicionário vazio → nil (sem cartão).
  static func parse(_ raw: [String: Any]?) -> NCReply? {
    guard let d = raw, !d.isEmpty else { return nil }
    var r = NCReply()
    var bad: [String] = []
    func str(_ k: String) -> String? {
      guard let v = d[k] else { return nil }
      if let s = v as? String { return s }
      if let n = v as? NSNumber { return n.stringValue }
      if v is NSNull || ncIsNil(v) { return nil }
      bad.append(k)
      return nil
    }
    func num(_ k: String) -> Double? {
      guard let v = d[k] else { return nil }
      if let n = v as? NSNumber { return n.doubleValue }
      if let n = v as? Double { return n }
      if let n = v as? Int { return Double(n) }
      if let s = v as? String, let n = Double(s) { return n }
      if v is NSNull || ncIsNil(v) { return nil }
      bad.append(k)
      return nil
    }
    func bool(_ k: String) -> Bool? {
      guard let v = d[k] else { return nil }
      if let b = v as? Bool { return b }
      if let n = v as? NSNumber { return n.boolValue }
      if let s = v as? String { return s == "true" || s == "1" }
      if v is NSNull || ncIsNil(v) { return nil }
      bad.append(k)
      return nil
    }
    if let v = str("kind"), !v.isEmpty { r.kind = v }
    r.key = str("key") ?? ""
    r.title = str("title") ?? ""
    r.text = str("text") ?? ""
    r.italic = bool("italic") ?? false
    if let u = str("thumbUri"), !u.isEmpty { r.thumbUri = u }
    r.thumbRound = bool("thumbRound") ?? false
    if let c = num("color"), c.isFinite { r.color = c }
    r.icon = str("icon") ?? ""
    if let l = num("lines"), l.isFinite { r.lines = max(0, min(12, Int(l.rounded()))) }
    r.focus = bool("focus") ?? false
    r.pop = bool("pop") ?? false
    if !bad.isEmpty || (r.title.isEmpty && r.text.isEmpty) {
      NSLog("[ChatyyComposer] replyPreview diag: kind=%@ key=%@ badFields=%@ keys=%@",
            r.kind, r.key, bad.joined(separator: ","), d.keys.sorted().joined(separator: ","))
    }
    return r
  }
}

/// `Optional<Any>.none` embrulhado em Any (é assim que o Expo entrega `null`).
func ncIsNil(_ v: Any) -> Bool {
  if case Optional<Any>.none = v { return true }
  return false
}

struct NCMentionRecord: Record {
  @Field var token: String = ""
  @Field var email: String = ""
}

struct NCMenuItemRecord: Record {
  @Field var key: String = ""
  @Field var label: String = ""
}

/// processColor() do RN entrega 0xAARRGGBB (número). nil → fallback.
func ncColor(_ v: Double?, _ fallback: UIColor) -> UIColor {
  guard let v = v, v.isFinite else { return fallback }
  let u = UInt32(truncatingIfNeeded: Int64(v))
  let a = CGFloat((u >> 24) & 0xFF) / 255
  let r = CGFloat((u >> 16) & 0xFF) / 255
  let g = CGFloat((u >> 8) & 0xFF) / 255
  let b = CGFloat(u & 0xFF) / 255
  return UIColor(red: r, green: g, blue: b, alpha: a)
}

public class ChatyyComposerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyComposer")

    // [2026-10-16 reply-card-ios] 2 = cartão de resposta nativo corrigido no iOS
    // (app/chat-conversation.js `_nativeReplyCardOn()` religa o cartão nativo).
    Function("apiVersion") { () -> Int in
      return 2
    }

    View(ChatyyComposerView.self) {
      Events(
        "onChangeText", "onSend", "onAttach", "onCamera", "onEmoji", "onVideoNote",
        "onVoiceRecorded", "onVoiceState", "onHeightChange", "onSelectionChange",
        "onPasteImage", "onFocusChange", "onReplyCancel", "onSendMenu", "onKeyboardFrame"
      )

      Prop("placeholder") { (view: ChatyyComposerView, v: String?) in view.placeholderText = v ?? "" }
      Prop("labels") { (view: ChatyyComposerView, v: [String: String]?) in view.labels = v ?? [:] }
      Prop("theme") { (view: ChatyyComposerView, v: NCThemeRecord?) in view.pendingTheme = v ?? NCThemeRecord() }
      Prop("replyPreview") { (view: ChatyyComposerView, v: [String: Any]?) in view.pendingReply = .some(NCReply.parse(v)) }
      Prop("mentionCandidates") { (view: ChatyyComposerView, v: [NCMentionRecord]?) in view.setMentionCandidates(v ?? []) }
      Prop("sendMenu") { (view: ChatyyComposerView, v: [NCMenuItemRecord]?) in view.sendMenuItems = v ?? [] }
      Prop("defaultText") { (view: ChatyyComposerView, v: String?) in view.applyDefaultText(v ?? "") }
      Prop("bottomInset") { (view: ChatyyComposerView, v: Double?) in view.bottomInset = CGFloat(max(0, v ?? 0)) }
      Prop("sending") { (view: ChatyyComposerView, v: Bool?) in view.sending = v ?? false }
      Prop("uploading") { (view: ChatyyComposerView, v: Bool?) in view.uploading = v ?? false }
      Prop("enterSends") { (view: ChatyyComposerView, v: Bool?) in view.enterSends = v ?? false }
      Prop("autocorrect") { (view: ChatyyComposerView, v: Bool?) in view.autocorrect = v ?? true }
      Prop("maxLength") { (view: ChatyyComposerView, v: Int?) in view.maxLength = max(1, v ?? 5000) }
      Prop("maxLines") { (view: ChatyyComposerView, v: Int?) in view.maxLines = max(1, min(12, v ?? 6)) }
      Prop("showEmoji") { (view: ChatyyComposerView, v: Bool?) in view.showEmoji = v ?? true }
      Prop("emojiActive") { (view: ChatyyComposerView, v: Bool?) in view.emojiActive = v ?? false }
      Prop("showCamera") { (view: ChatyyComposerView, v: Bool?) in view.showCamera = v ?? true }
      Prop("showVideoNote") { (view: ChatyyComposerView, v: Bool?) in view.showVideoNote = v ?? false }
      Prop("voiceEnabled") { (view: ChatyyComposerView, v: Bool?) in view.voiceEnabled = v ?? true }
      Prop("voiceBlocked") { (view: ChatyyComposerView, v: Bool?) in view.voiceBlocked = v ?? false }
      Prop("disabled") { (view: ChatyyComposerView, v: Bool?) in view.disabled = v ?? false }
      Prop("changeDebounceMs") { (view: ChatyyComposerView, v: Double?) in view.changeDebounceMs = max(0, v ?? 60) }
      Prop("keyboardTracking") { (view: ChatyyComposerView, v: String?) in view.keyboardTracking = v ?? "none" }

      OnViewDidUpdateProps { (view: ChatyyComposerView) in
        view.didUpdateProps()
      }

      AsyncFunction("focus") { (view: ChatyyComposerView) in
        view.focusInput()
      }.runOnQueue(.main)

      AsyncFunction("blur") { (view: ChatyyComposerView) in
        view.blurInput()
      }.runOnQueue(.main)

      AsyncFunction("setText") { (view: ChatyyComposerView, text: String) in
        view.setTextFromJS(text)
      }.runOnQueue(.main)

      AsyncFunction("clear") { (view: ChatyyComposerView) in
        view.setTextFromJS("")
      }.runOnQueue(.main)

      AsyncFunction("setSelection") { (view: ChatyyComposerView, start: Int, end: Int) in
        view.setSelectionFromJS(start: start, end: end)
      }.runOnQueue(.main)

      AsyncFunction("cancelVoice") { (view: ChatyyComposerView) in
        view.cancelVoiceFromJS()
      }.runOnQueue(.main)
    }
  }
}
