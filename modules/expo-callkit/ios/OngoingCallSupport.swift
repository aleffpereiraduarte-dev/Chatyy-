// OngoingCallSupport.swift — [2026-10-11 ongoing-call] "Ligação em andamento"
// estilo WhatsApp: minimizar a ligação (1:1 ou grupo), usar o app normalmente
// (lista de chats, abrir conversa, mandar mensagem/foto) e voltar à ligação
// pela barra no topo — sem reconectar.
//
// Peças:
//   * OngoingCallState  — snapshot thread-safe da ligação viva (lido pelo JS via
//     getCurrentCallSnapshot, de qualquer thread) + ações vindas da barra JS
//     (voltar / mudo / encerrar). Recalcula a partir dos VCs vivos NA MAIN a
//     cada 1s enquanto há ligação, e na hora em cada transição de UI
//     (minimizar / voltar / PiP / encerrar) — e aí posta
//     `ExpoCallKitCallUiChanged`, que o módulo repassa ao JS como
//     `onCallUiChanged` (barra aparece/some sem esperar o poll).
//   * OngoingCallStrings — textos nativos da barra/botões nos 11 idiomas
//     (mesmo padrão/idioma do GroupCallStrings).
//   * OngoingCallPassthroughWindow — janela da barra nativa (fallback quando o
//     JS não monta a barra) que deixa passar toques fora da barra. Antes a
//     janela cobria a TELA INTEIRA e engolia todos os toques: com a ligação
//     de voz minimizada o app ficava "congelado" (não dava pra mandar
//     mensagem).
//
// Só UIKit/Foundation. Sem dependências novas.

import Foundation
import UIKit

final class OngoingCallState {
    static let shared = OngoingCallState()
    static let uiChangedNotification = Notification.Name("ExpoCallKitCallUiChanged")

    private let lock = NSLock()
    private var cached: [String: Any]?
    private var timer: Timer?

    /// Leitura do JS (qualquer thread). nil = nenhuma ligação nativa viva.
    func snapshot() -> [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        return cached
    }

    /// Recalcula a partir dos VCs vivos (sempre na main). `notify` = posta
    /// `ExpoCallKitCallUiChanged` p/ o JS reler na hora.
    func refresh(notify: Bool = false) {
        if !Thread.isMainThread {
            DispatchQueue.main.async { [weak self] in self?.refresh(notify: notify) }
            return
        }
        let next = CallViewController.ongoingSnapshot() ?? GroupCallViewController.ongoingSnapshot()
        lock.lock()
        cached = next
        lock.unlock()
        if next != nil {
            ensureTimer()
        } else {
            timer?.invalidate()
            timer = nil
        }
        if notify {
            NotificationCenter.default.post(name: OngoingCallState.uiChangedNotification, object: nil)
        }
    }

    /// Transição de UI (minimizar / voltar / PiP / encerrar).
    func notifyChanged() {
        refresh(notify: true)
        // A apresentação/dismiss termina num tick seguinte — relê de novo pra
        // pegar o `view.window` final.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self] in
            self?.refresh(notify: true)
        }
    }

    private func ensureTimer() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.refresh(notify: false)
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    // MARK: Ações da barra JS (sempre despachadas na main)

    /// Volta pra tela da ligação (1:1 estacionada / PiP, ou grupo).
    func restore() -> Bool {
        let has = snapshot() != nil || CallViewController.hasOngoing() || GroupCallViewController.hasOngoing()
        DispatchQueue.main.async {
            if CallViewController.ongoingRestore() { return }
            _ = GroupCallViewController.ongoingRestore()
        }
        return has
    }

    func setMuted(_ muted: Bool) -> Bool {
        let has = snapshot() != nil || CallViewController.hasOngoing() || GroupCallViewController.hasOngoing()
        DispatchQueue.main.async { [weak self] in
            if !CallViewController.ongoingSetMuted(muted) {
                _ = GroupCallViewController.ongoingSetMuted(muted)
            }
            self?.refresh(notify: true)
        }
        return has
    }

    func hangup() -> Bool {
        let has = snapshot() != nil || CallViewController.hasOngoing() || GroupCallViewController.hasOngoing()
        DispatchQueue.main.async { [weak self] in
            if !CallViewController.ongoingHangup() {
                _ = GroupCallViewController.ongoingHangup()
            }
            self?.refresh(notify: true)
        }
        return has
    }
}

/// Janela que só "existe" onde há conteúdo: toque fora da barra cai no app.
final class OngoingCallPassthroughWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let hit = super.hitTest(point, with: event) else { return nil }
        if hit === self || hit === rootViewController?.view { return nil }
        return hit
    }
}

/// Botão redondo de 36pt visuais com área de toque de 44pt.
final class CallHitExpandButton: UIButton {
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let dx = max(0, (44 - bounds.width) / 2)
        let dy = max(0, (44 - bounds.height) / 2)
        return bounds.insetBy(dx: -dx, dy: -dy).contains(point)
    }
}

enum OngoingCallStrings {
    private static let table: [String: [String: String]] = [
        "pt-BR": ["tapToReturn": "Toque para voltar à ligação", "message": "Mensagem", "mute": "Silenciar", "unmute": "Ativar som", "end": "Encerrar"],
        "pt-PT": ["tapToReturn": "Toque para voltar à chamada", "message": "Mensagem", "mute": "Silenciar", "unmute": "Ativar som", "end": "Terminar"],
        "en": ["tapToReturn": "Tap to return to call", "message": "Message", "mute": "Mute", "unmute": "Unmute", "end": "End"],
        "es": ["tapToReturn": "Toca para volver a la llamada", "message": "Mensaje", "mute": "Silenciar", "unmute": "Activar sonido", "end": "Finalizar"],
        "fr": ["tapToReturn": "Touchez pour revenir à l’appel", "message": "Message", "mute": "Couper le micro", "unmute": "Réactiver le micro", "end": "Raccrocher"],
        "de": ["tapToReturn": "Tippen, um zum Anruf zurückzukehren", "message": "Nachricht", "mute": "Stummschalten", "unmute": "Stummschaltung aufheben", "end": "Beenden"],
        "it": ["tapToReturn": "Tocca per tornare alla chiamata", "message": "Messaggio", "mute": "Silenzia", "unmute": "Riattiva audio", "end": "Termina"],
        "ja": ["tapToReturn": "タップして通話に戻る", "message": "メッセージ", "mute": "ミュート", "unmute": "ミュート解除", "end": "終了"],
        "ar": ["tapToReturn": "انقر للعودة إلى المكالمة", "message": "رسالة", "mute": "كتم الصوت", "unmute": "إلغاء الكتم", "end": "إنهاء"],
        "id": ["tapToReturn": "Ketuk untuk kembali ke panggilan", "message": "Pesan", "mute": "Bisukan", "unmute": "Bunyikan", "end": "Akhiri"],
        "hi": ["tapToReturn": "कॉल पर लौटने के लिए टैप करें", "message": "मैसेज", "mute": "म्यूट करें", "unmute": "अनम्यूट करें", "end": "समाप्त करें"],
    ]

    static func s(_ key: String) -> String {
        let l = GroupCallStrings.lang
        return table[l]?[key] ?? table["en"]?[key] ?? key
    }

    static var tapToReturn: String { s("tapToReturn") }
    static var message: String { s("message") }
    static var mute: String { s("mute") }
    static var unmute: String { s("unmute") }
    static var end: String { s("end") }
}
