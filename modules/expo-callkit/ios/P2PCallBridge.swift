import Foundation
import LiveKitClient

// [2026-10-09 p2p-ios] Integra a sessão P2P (P2PCallSessionIOS) com a ligação
// nativa (CallViewController / NativeCallRoom / CallSignalWs).
//
// Modelo "LiveKit em espera quente": o Room LiveKit da ligação conecta como
// sempre (preconnect do callee no toque, Room do caller no viewDidLoad), mas
// enquanto o P2P é DONO DA MÍDIA nada é publicado nele (nem mic). Assim:
//   * P2P conectou → áudio direto aparelho↔aparelho (menor latência).
//   * P2P falhou (timeout, par sem P2P, ICE perdido, câmera ligada, vídeo do
//     par, par pediu) → publica o mic no Room que JÁ está conectado →
//     fallback em ~centenas de ms, sem renegociar sala.
//   * Par publicou áudio no SFU (app antigo / Android / web sem flag) →
//     fallback imediato ("peer_on_sfu"), sem esperar timeout.
// Nunca há duas pilhas de áudio ativas ao mesmo tempo.
//
// Elegível só quando: build tem LiveKitWebRTC importável, servidor mandou
// `p2p.enabled` (e não `p2p.ios:false`), ligação 1:1 de VOZ (vídeo = LiveKit
// na v1), sem kill switch local (App Group `p2p_ios_off`), e o mic ainda não
// foi publicado no LiveKit para esta ligação.
//
// Thread-safety: estado estático sob `lock`; efeitos de LiveKit/UI na main.
final class P2PCallBridge {

    static let stateChangedNotification = Notification.Name("ChatyyP2PStateChanged")

    private static let kAppGroup = "group.com.onemundo.mail"
    private static let kCacheJson = "p2p_cfg_json"
    private static let kCacheTs = "p2p_cfg_ts"
    private static let kKillSwitch = "p2p_ios_off"
    private static let cacheTtl: TimeInterval = 12 * 3600

    private final class Active {
        let session: P2PCallSessionIOS
        let isCaller: Bool
        var state: String = "negotiating"
        var micDesired: Bool = true
        var watcher: Timer?
        init(session: P2PCallSessionIOS, isCaller: Bool) {
            self.session = session
            self.isCaller = isCaller
        }
    }

    private static let lock = NSLock()
    /// callId → config do servidor (nil = servidor disse desligado p/ esta ligação).
    private static var perCall: [String: P2PCallConfig?] = [:]
    private static var perCallOrder: [String] = []
    private static var videoByCall: [String: Bool] = [:]
    private static var active: [String: Active] = [:]
    /// Ligações cuja tentativa P2P já terminou (não tenta de novo).
    private static var finished: Set<String> = []

    // MARK: - config

    /// Guarda o `p2p` do servidor (dict ou JSON string) p/ a ligação + cache da
    /// conta no App Group (o callee costuma receber token inline no push, sem
    /// `p2p` → usa o último config visto da conta, TTL 12h). `iceServers` =
    /// envelope do chat_livekit_token (só STUN é usado sem `turn:true`).
    static func rememberConfig(_ raw: Any?, iceServers: Any? = nil, callId: String) {
        guard raw != nil, !callId.isEmpty else { return }
        var cfg = P2PCallConfig.parse(raw)
        if var c = cfg, c.iceServers.isEmpty, let ice = iceServers as? [[String: Any]] { c.iceServers = ice; cfg = c }
        lock.lock()
        if perCall[callId] == nil { perCallOrder.append(callId) }
        perCall[callId] = cfg
        while perCallOrder.count > 16 {
            let old = perCallOrder.removeFirst()
            perCall.removeValue(forKey: old)
        }
        lock.unlock()
        // Cache da conta (inclui "desligado" — servidor desligou → para de tentar).
        var json: String?
        if let s = raw as? String { json = s }
        else if let d = raw as? [String: Any],
                let data = try? JSONSerialization.data(withJSONObject: d) { json = String(data: data, encoding: .utf8) }
        if let j = json, let ud = UserDefaults(suiteName: kAppGroup) {
            ud.set(j, forKey: kCacheJson)
            ud.set(Date().timeIntervalSince1970, forKey: kCacheTs)
        }
    }

    static func noteCall(callId: String, hasVideo: Bool) {
        guard !callId.isEmpty else { return }
        lock.lock()
        videoByCall[callId] = hasVideo
        if videoByCall.count > 32 { videoByCall = [callId: hasVideo] }
        lock.unlock()
    }

    static func knownVideo(_ callId: String) -> Bool? {
        lock.lock(); defer { lock.unlock() }
        return videoByCall[callId]
    }

    private static func config(for callId: String) -> P2PCallConfig? {
        lock.lock()
        let hit = perCall[callId]
        lock.unlock()
        if let h = hit { return h } // per-call (pode ser nil = desligado)
        guard let ud = UserDefaults(suiteName: kAppGroup),
              let j = ud.string(forKey: kCacheJson) else { return nil }
        let ts = ud.double(forKey: kCacheTs)
        if ts <= 0 || Date().timeIntervalSince1970 - ts > cacheTtl { return nil }
        return P2PCallConfig.parse(j)
    }

    private static func isGroupLike(_ callId: String) -> Bool {
        let l = callId.lowercased()
        for p in ["group_", "conv_", "live_", "link_", "meet_"] where l.hasPrefix(p) { return true }
        return false
    }

    // MARK: - estado

    /// true enquanto o P2P é dono da mídia desta ligação (negociando,
    /// conectado ou reconectando) → NADA deve ser publicado no LiveKit.
    static func ownsMedia(_ callId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return active[callId] != nil
    }

    static func isConnected(_ callId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return active[callId]?.state == "connected"
    }

    /// Começa o P2P se elegível. Idempotente: true se o P2P já é (ou passou a
    /// ser) dono da mídia; false → siga o caminho LiveKit normal.
    @discardableResult
    static func startIfEligible(callId: String, isCaller: Bool, hasVideo: Bool) -> Bool {
        guard !callId.isEmpty else { return false }
        lock.lock()
        if active[callId] != nil { lock.unlock(); return true }
        let wasFinished = finished.contains(callId)
        lock.unlock()
        if wasFinished || hasVideo || isGroupLike(callId) { return false }
        guard P2PCallSessionIOS.isAvailable else { return false }
        if let ud = UserDefaults(suiteName: kAppGroup), ud.bool(forKey: kKillSwitch) { return false }
        guard let cfg = config(for: callId) else { return false }
        // Callee: se o mic já começou a ser publicado no LiveKit, não troca de pilha.
        if !isCaller && NativeCallRoom.shared.hasStartedIncomingMicPublish(callId: callId) { return false }
        // Par já está mandando áudio pelo SFU (app sem P2P) → nem tenta.
        if Thread.isMainThread && peerHasSfuAudio(callId) { return false }

        let cb = P2PCallCallbacks(
            onConnected: { ms in P2PCallBridge.handleConnected(callId: callId, ms: ms) },
            onFallback: { reason, after in P2PCallBridge.handleFallback(callId: callId, reason: reason, afterConnected: after) },
            onReconnecting: { on in P2PCallBridge.handleReconnecting(callId: callId, on: on) },
            onData: { _ in },
            onRemoteVideoActive: { P2PCallBridge.requestFallback(callId: callId, reason: "remote_video") },
            log: { evt, info in
                if evt == "quality" { return }
                nativeCallDiag("p2p_" + evt, callId, info)
            }
        )
        let s = P2PCallSessionIOS(
            callId: callId,
            isCaller: isCaller,
            cfg: cfg,
            send: { frame in CallSignalWs.shared.sendP2P(frame) },
            callbacks: cb
        )
        let a = Active(session: s, isCaller: isCaller)
        lock.lock()
        if active[callId] != nil { lock.unlock(); return true }
        active[callId] = a
        lock.unlock()
        nativeCallDiag("p2p_owns_media", callId, "caller=\(isCaller) timeout=\(cfg.connectTimeoutMs)")
        CallSignalWs.shared.warmConnect()
        s.start()
        DispatchQueue.main.async {
            post(callId: callId, state: "negotiating")
            startWatcher(callId: callId)
        }
        return true
    }

    static func setMicEnabled(callId: String, _ on: Bool) {
        lock.lock()
        let a = active[callId]
        a?.micDesired = on
        lock.unlock()
        a?.session.setMicEnabled(on)
    }

    /// Pede p/ sair do P2P (câmera ligada, vídeo do par…). O mic volta a ser
    /// publicado no LiveKit em handleFallback.
    static func requestFallback(callId: String, reason: String) {
        lock.lock()
        let a = active[callId]
        lock.unlock()
        a?.session.fallback(reason)
    }

    /// Fim da ligação: fecha sem publicar nada no LiveKit.
    static func close(callId: String, reason: String) {
        guard !callId.isEmpty else { return }
        lock.lock()
        let a = active.removeValue(forKey: callId)
        finished.insert(callId)
        if finished.count > 64 { finished = [callId] }
        lock.unlock()
        guard let act = a else { return }
        act.session.close(reason)
        DispatchQueue.main.async {
            act.watcher?.invalidate()
            act.watcher = nil
            post(callId: callId, state: "closed")
        }
    }

    // MARK: - callbacks (main)

    private static func handleConnected(callId: String, ms: Int) {
        lock.lock()
        active[callId]?.state = "connected"
        lock.unlock()
        post(callId: callId, state: "connected", extra: ["ms": ms])
    }

    private static func handleReconnecting(callId: String, on: Bool) {
        lock.lock()
        if let a = active[callId] { a.state = on ? "reconnecting" : "connected" }
        lock.unlock()
        post(callId: callId, state: on ? "reconnecting" : "connected")
    }

    private static func handleFallback(callId: String, reason: String, afterConnected: Bool) {
        lock.lock()
        let a = active.removeValue(forKey: callId)
        finished.insert(callId)
        lock.unlock()
        guard let act = a else { return } // close() já tratou
        act.watcher?.invalidate()
        act.watcher = nil
        nativeCallDiag("p2p_to_livekit", callId, "reason=\(reason) after=\(afterConnected) mic=\(act.micDesired)")
        post(callId: callId, state: "fallback", extra: ["reason": reason, "after": afterConnected])
        publishLiveKitMic(callId: callId, enabled: act.micDesired, attempt: 0)
    }

    /// Publica o mic no Room LiveKit da ligação (espera conectar, até ~10s).
    private static func publishLiveKitMic(callId: String, enabled: Bool, attempt: Int) {
        guard enabled else { return }
        guard NativeCallRoom.shared.currentCallId() == callId,
              let r = NativeCallRoom.shared.currentRoom() else {
            nativeCallDiag("p2p_fallback_no_room", callId, "attempt=\(attempt)")
            return
        }
        if r.connectionState != .connected {
            if attempt >= 50 {
                nativeCallDiag("p2p_fallback_room_not_connected", callId)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                publishLiveKitMic(callId: callId, enabled: enabled, attempt: attempt + 1)
            }
            return
        }
        Task {
            do {
                _ = try await r.localParticipant.setMicrophone(
                    enabled: true,
                    captureOptions: CallViewController.defaultAudioCaptureOptions()
                )
                nativeCallDiag("p2p_fallback_mic_published", callId)
            } catch {
                nativeCallDiag("p2p_fallback_mic_failed", callId, "\(error)")
            }
        }
    }

    /// Enquanto o P2P é dono da mídia: se o par publicar áudio no SFU (app sem
    /// P2P ou que já caiu p/ o LiveKit), sai do P2P na hora.
    private static func startWatcher(callId: String) {
        lock.lock()
        let a = active[callId]
        lock.unlock()
        guard let act = a, act.watcher == nil else { return }
        act.watcher = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { t in
            lock.lock()
            let still = active[callId] != nil
            lock.unlock()
            if !still { t.invalidate(); return }
            if peerHasSfuAudio(callId) {
                t.invalidate()
                requestFallback(callId: callId, reason: "peer_on_sfu")
            }
        }
    }

    /// O par publicou áudio no Room LiveKit desta ligação. MAIN THREAD.
    private static func peerHasSfuAudio(_ callId: String) -> Bool {
        guard NativeCallRoom.shared.currentCallId() == callId,
              let r = NativeCallRoom.shared.currentRoom() else { return false }
        for rp in r.remoteParticipants.values
            where rp.trackPublications.values.contains(where: { $0.kind == .audio }) {
            return true
        }
        return false
    }

    private static func post(callId: String, state: String, extra: [String: Any] = [:]) {
        var info: [String: Any] = ["callId": callId, "state": state]
        for (k, v) in extra { info[k] = v }
        if Thread.isMainThread {
            NotificationCenter.default.post(name: stateChangedNotification, object: nil, userInfo: info)
        } else {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: stateChangedNotification, object: nil, userInfo: info)
            }
        }
    }
}
