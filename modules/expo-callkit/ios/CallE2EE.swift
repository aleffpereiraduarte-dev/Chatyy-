import Foundation
import UIKit
import LiveKitClient

// [e2ee5 WP-13 2026-10-21] Ligações E2EE v5 no iOS (LiveKitClient 2.0.18, frame encryption AES-GCM).
//
// O JS (services/callE2ee.js) é o cérebro: gera/recebe a chave por to-device Olm
// (`chatyy.call_key`) e entrega aqui por `setCallE2EEKey(callId, keyB64)`; marca a ligação como
// EXIGIDA por `setCallE2EERequired(callId, true)` e grava a dica por conversa
// (`setCallE2EEConvHint`) para o toque com o app morto (VoIP push → preconnect sem JS).
//
// Regra de segurança: ligação exigida ⇒ o Room é criado com `E2EEOptions` MESMO SEM chave
// (BaseKeyProvider vazio). Sem chave o cifrador nativo DESCARTA os quadros (missing_key) — nunca
// sai mídia em claro. Quando a chave chega, `setKey` no MESMO provider (slot 0) libera a mídia;
// a rotação (grupo) troca o slot 0 de novo.
//
// Nada exigido e sem chave (= todas as ligações hoje, flag desligada) ⇒ `e2eeOptions` devolve nil
// e o Room é criado exatamente como antes.
//
// Chave = TEXTO base64 de 32 B (44 chars), igual ao Android (setSharedKey(String)) e à web
// (ExternalE2EEKeyProvider.setKey(string)) → mesmo PBKDF2 nos 3. Nunca logar a chave.
final class CallE2EE {
    static let shared = CallE2EE()
    /// Versão da API exposta ao JS (`callE2EECaps`). 0 = binário sem E2EE de ligação.
    static let apiVersion = 1
    static let changedNotification = Notification.Name("ChatyyCallE2EEChanged")

    private struct Entry {
        var required = false
        var key: String?
        var provider: BaseKeyProvider?
        var createdAt = Date()
        var keyAt: Date?
    }

    private let lock = NSLock()
    private var calls: [String: Entry] = [:]
    private let groupId = "group.com.onemundo.mail"
    private let hintKey = "chatyy.e2ee5.call_hints_v1"

    private init() {}

    private func locked<T>(_ f: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return f()
    }

    private func notify(_ callId: String) {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: CallE2EE.changedNotification, object: nil, userInfo: ["callId": callId])
        }
    }

    static func validKey(_ k: String) -> Bool {
        guard k.count == 44, k.hasSuffix("="), let d = Data(base64Encoded: k) else { return false }
        return d.count == 32
    }

    // MARK: JS → nativo

    func setRequired(_ callId: String, _ on: Bool) {
        guard !callId.isEmpty else { return }
        locked {
            var e = calls[callId] ?? Entry()
            e.required = on
            calls[callId] = e
        }
        NSLog("[CallE2EE] required=%@ call=%@", on ? "1" : "0", callId)
        notify(callId)
    }

    /// Chave nova (1ª ou rotação). Atualiza o provider do Room vivo na hora.
    func setKey(_ callId: String, _ keyB64: String) {
        guard !callId.isEmpty, CallE2EE.validKey(keyB64) else {
            NSLog("[CallE2EE] setKey ignorada (formato) call=%@", callId)
            return
        }
        let provider: BaseKeyProvider? = locked {
            var e = calls[callId] ?? Entry()
            e.key = keyB64
            e.keyAt = Date()
            calls[callId] = e
            return e.provider
        }
        provider?.setKey(key: keyB64, participantId: nil, index: 0)
        NSLog("[CallE2EE] key set call=%@ live=%@", callId, provider == nil ? "0" : "1")
        notify(callId)
    }

    func clear(_ callId: String) {
        _ = locked { calls.removeValue(forKey: callId) }
        notify(callId)
    }

    // MARK: consultas

    /// A ligação TEM de ser cifrada (marcada pelo JS, pela dica da conversa, ou já há chave).
    func isRequired(_ callId: String) -> Bool {
        return locked {
            guard let e = calls[callId] else { return false }
            return e.required || e.key != nil
        }
    }

    func hasKey(_ callId: String) -> Bool {
        return locked { calls[callId]?.key != nil }
    }

    /// `RoomOptions(e2eeOptions:)` para esta ligação. nil = ligação de hoje (sem E2EE).
    func e2eeOptions(callId: String) -> E2EEOptions? {
        let r: (E2EEOptions?, Bool) = locked {
            guard var e = calls[callId], e.required || e.key != nil else { return (nil, false) }
            let p = BaseKeyProvider(isSharedKey: true)
            if let k = e.key { p.setKey(key: k, participantId: nil, index: 0) }
            e.provider = p
            calls[callId] = e
            return (E2EEOptions(keyProvider: p), e.key != nil)
        }
        if r.0 != nil { NSLog("[CallE2EE] room e2ee call=%@ key=%@", callId, r.1 ? "1" : "0") }
        return r.0
    }

    /// Room já criado (preconnect do toque) sem E2EE numa ligação que agora é exigida → não adotar.
    func roomViolatesPolicy(_ callId: String, room: Room) -> Bool {
        return isRequired(callId) && room.e2eeManager == nil
    }

    /// P2P nativo (DTLS-SRTP com SDP pelo hub, sem autenticação) fica de fora das ligações cifradas.
    func blocksNativeP2P(_ callId: String) -> Bool {
        return isRequired(callId)
    }

    /// Algum participante remoto publicando SEM cifra (app antigo)?
    func hasUnencryptedRemote(_ room: Room) -> Bool {
        for p in room.remoteParticipants.values {
            for pub in p.trackPublications.values where pub.encryptionType == .none {
                return true
            }
        }
        return false
    }

    func status(_ callId: String) -> [String: Any] {
        return locked {
            let e = calls[callId]
            return [
                "required": e?.required ?? false,
                "hasKey": e?.key != nil,
                "live": e?.provider != nil,
                "ageMs": Int((Date().timeIntervalSince(e?.createdAt ?? Date())) * 1000),
            ]
        }
    }

    // MARK: dica por conversa (VoIP push com o app morto)

    func setConvHint(convId: String, peerEmail: String, on: Bool) {
        guard !convId.isEmpty, let ud = UserDefaults(suiteName: groupId) else { return }
        var m = (ud.dictionary(forKey: hintKey) as? [String: [String: Any]]) ?? [:]
        if on {
            m[convId] = ["p": peerEmail.lowercased(), "t": Date().timeIntervalSince1970]
        } else {
            m.removeValue(forKey: convId)
        }
        if m.count > 500 {
            let keep = m.sorted { (($0.value["t"] as? Double) ?? 0) > (($1.value["t"] as? Double) ?? 0) }.prefix(400)
            m = Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
        }
        ud.set(m, forKey: hintKey)
    }

    private static func canon(_ e: String) -> String {
        let s = e.trimmingCharacters(in: .whitespaces).lowercased()
        if s.hasSuffix("@onemundo.com.br") { return String(s.dropLast(16)) + "@chatyy.com.br" }
        return s
    }

    /// Toque chegou (push/WS): conversa (ou par do 1:1) marcada como cifrada ⇒ exigida.
    func noteIncoming(callId: String, convId: String, peerEmail: String) {
        guard !callId.isEmpty, let ud = UserDefaults(suiteName: groupId),
              let m = ud.dictionary(forKey: hintKey) as? [String: [String: Any]], !m.isEmpty else { return }
        var hit = !convId.isEmpty && m[convId] != nil
        if !hit && !peerEmail.isEmpty {
            let pe = CallE2EE.canon(peerEmail)
            hit = m.values.contains { CallE2EE.canon(($0["p"] as? String) ?? "") == pe && !pe.isEmpty }
        }
        if hit { setRequired(callId, true) }
    }
}

// MARK: - Cadeado / aviso na tela de chamada (UIKit, por cima da UI existente)

final class CallE2EEBadge: UIView {
    private let label = UILabel()
    private let icon = UIImageView()
    private var timer: Timer?
    private var observer: NSObjectProtocol?
    private let callId: String
    private let roomProvider: () -> Room?
    private let startedAt = Date()

    /// Anexa o selo à `view` (topo, centralizado). Não faz nada se a ligação não é cifrada.
    @discardableResult
    static func attach(to view: UIView, callId: String, room: @escaping () -> Room?) -> CallE2EEBadge? {
        guard !callId.isEmpty else { return nil }
        if let old = view.subviews.compactMap({ $0 as? CallE2EEBadge }).first { return old }
        let b = CallE2EEBadge(callId: callId, room: room)
        b.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(b)
        NSLayoutConstraint.activate([
            b.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            b.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 6),
            b.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -32),
        ])
        b.refresh()
        return b
    }

    private init(callId: String, room: @escaping () -> Room?) {
        self.callId = callId
        self.roomProvider = room
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        isHidden = true
        layer.cornerRadius = 10
        backgroundColor = UIColor(white: 0, alpha: 0.35)
        icon.image = UIImage(systemName: "lock.fill")
        icon.tintColor = UIColor(white: 1, alpha: 0.8)
        icon.translatesAutoresizingMaskIntoConstraints = false
        label.font = UIFont.systemFont(ofSize: 11, weight: .semibold)
        label.textColor = UIColor(white: 1, alpha: 0.85)
        label.numberOfLines = 2
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icon)
        addSubview(label)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 10),
            icon.heightAnchor.constraint(equalToConstant: 11),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 5),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3),
        ])
        observer = NotificationCenter.default.addObserver(forName: CallE2EE.changedNotification, object: nil, queue: .main) { [weak self] _ in
            self?.refresh()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in self?.refresh() }
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        timer?.invalidate()
        if let o = observer { NotificationCenter.default.removeObserver(o) }
    }

    override func removeFromSuperview() {
        timer?.invalidate()
        timer = nil
        super.removeFromSuperview()
    }

    private static func text(_ key: String) -> String {
        let lang = (Locale.preferredLanguages.first ?? "pt").lowercased()
        let pt = lang.hasPrefix("pt"), es = lang.hasPrefix("es")
        switch key {
        case "on": return pt ? "Criptografada de ponta a ponta" : es ? "Cifrada de extremo a extremo" : "End-to-end encrypted"
        case "wait": return pt ? "Protegendo a ligação…" : es ? "Protegiendo la llamada…" : "Securing the call…"
        case "nokey": return pt ? "Não foi possível proteger esta ligação." : es ? "No fue posible proteger esta llamada." : "Couldn't secure this call."
        case "plain": return pt ? "Esta ligação não está protegida. Desligue e ligue de novo." : es ? "Esta llamada no está protegida. Cuelga y vuelve a llamar." : "This call isn't secured. Hang up and call again."
        default: return pt ? "A outra pessoa precisa atualizar o Chatyy para esta ligação ser protegida." : es ? "La otra persona necesita actualizar Chatyy para proteger esta llamada." : "The other person needs to update Chatyy to secure this call."
        }
    }

    func refresh() {
        let e2 = CallE2EE.shared
        guard e2.isRequired(callId) else { isHidden = true; return }
        isHidden = false
        superview?.bringSubviewToFront(self) // a UI SwiftUI pode ter sido adicionada depois
        let warnColor = UIColor(red: 1, green: 0.82, blue: 0.48, alpha: 1)
        if let r = roomProvider(), r.e2eeManager == nil {
            // Room criado antes de a ligação ser marcada como cifrada (sem dica): avisa, não esconde.
            label.text = CallE2EEBadge.text("plain")
            label.textColor = warnColor
            icon.image = UIImage(systemName: "exclamationmark.triangle.fill")
            icon.tintColor = warnColor
        } else if let r = roomProvider(), e2.hasUnencryptedRemote(r) {
            label.text = CallE2EEBadge.text("peer")
            label.textColor = warnColor
            icon.image = UIImage(systemName: "exclamationmark.triangle.fill")
            icon.tintColor = warnColor
        } else if e2.hasKey(callId) {
            label.text = CallE2EEBadge.text("on")
            label.textColor = UIColor(white: 1, alpha: 0.85)
            icon.image = UIImage(systemName: "lock.fill")
            icon.tintColor = UIColor(white: 1, alpha: 0.8)
        } else {
            let late = Date().timeIntervalSince(startedAt) > 30
            label.text = CallE2EEBadge.text(late ? "nokey" : "wait")
            label.textColor = late ? warnColor : UIColor(white: 1, alpha: 0.85)
            icon.image = UIImage(systemName: "lock.fill")
            icon.tintColor = late ? warnColor : UIColor(white: 1, alpha: 0.8)
        }
    }
}
