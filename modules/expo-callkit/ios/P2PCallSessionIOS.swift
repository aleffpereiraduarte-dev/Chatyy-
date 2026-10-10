import Foundation
import Network
#if canImport(LiveKitWebRTC)
import LiveKitWebRTC
#endif

// [2026-10-09 p2p-ios] Ligação 1:1 PEER-TO-PEER no iOS — porte de
// services/p2pCall.js (web) e android/.../P2PCallSession.kt. Usa o libwebrtc
// que o pod LiveKitClient 2.0.18 JÁ embute (pod LiveKitWebRTC = 125.6422.11,
// classes ObjC com prefixo LK: LKRTCPeerConnection etc.) → zero binário novo.
// A dependência está declarada explicitamente no ExpoCallKit.podspec com a
// MESMA versão exata que o LiveKitClient 2.0.18 exige (sem conflito no
// resolvedor). Se por algum motivo o módulo não for importável, o bloco
// `#else` no fim do arquivo compila um stub (isAvailable = false) e a ligação
// segue 100% pelo LiveKit — o build nunca quebra por causa deste arquivo.
//
// Protocolo (hub Go /opt/chatyy-ws-go/p2p_signal.go), idêntico ao web/Android:
//   call_p2p_ready (callee→caller) · call_p2p_offer (caller→callee)
//   call_p2p_answer (callee→caller) · call_p2p_candidate (ambos, lote)
//   call_p2p_restart (callee pede ICE restart) · call_p2p_fallback (→ LiveKit)
// Só o CALLER oferece (sem glare). Transceivers áudio+vídeo sempre presentes
// (mesmo formato de SDP do web/Android). Opus FEC+DTX + teto de bitrate.
//
// v1 iOS = SÓ ÁUDIO: a mídia de vídeo continua no LiveKit (quem decide é o
// P2PCallBridge — ligação de vídeo nem tenta P2P; câmera ligada no meio ou
// vídeo chegando do par → fallback p/ o LiveKit, que já está conectado).
//
// Este arquivo NÃO importa LiveKit (só LiveKitWebRTC) e não conhece a UI:
// quem integra é o P2PCallBridge.swift.

/// Config vinda do servidor (`p2p` do chat_livekit_token / chat_call_invite_v2).
struct P2PCallConfig {
    var connectTimeoutMs: Int = 4000
    var readyWaitMs: Int = 2500
    var reconnectGraceMs: Int = 8000
    var maxAudioKbps: Int = 40
    var allowTurn: Bool = false
    /// iceServers dedicados do P2P (`p2p.ice_servers`) ou os do token LiveKit.
    var iceServers: [[String: Any]] = []

    private static func clampInt(_ v: Any?, _ def: Int, _ lo: Int, _ hi: Int) -> Int {
        var n = def
        if let x = v as? NSNumber { n = x.intValue }
        else if let s = v as? String, let x = Int(s) { n = x }
        if n <= 0 { n = def }
        return max(lo, min(hi, n))
    }

    /// nil = P2P desligado p/ esta ligação. `ios: false` explícito no servidor
    /// desliga só o iOS (kill switch sem build novo).
    static func parse(_ raw: Any?) -> P2PCallConfig? {
        var dict: [String: Any]? = raw as? [String: Any]
        if dict == nil, let s = raw as? String, let d = s.data(using: .utf8) {
            dict = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
        }
        guard let p = dict else { return nil }
        let enabled = (p["enabled"] as? Bool) ?? ((p["enabled"] as? NSNumber)?.boolValue ?? false)
        guard enabled else { return nil }
        if let ios = p["ios"] as? Bool, ios == false { return nil }
        var c = P2PCallConfig()
        c.connectTimeoutMs = clampInt(p["connect_timeout_ms"], 4000, 1500, 15000)
        c.readyWaitMs = clampInt(p["ready_wait_ms"], 2500, 800, 8000)
        c.reconnectGraceMs = clampInt(p["reconnect_grace_ms"], 8000, 3000, 30000)
        c.maxAudioKbps = clampInt(p["max_audio_kbps"], 40, 12, 96)
        c.allowTurn = (p["turn"] as? Bool) ?? false
        if let ice = p["ice_servers"] as? [[String: Any]], !ice.isEmpty { c.iceServers = ice }
        return c
    }
}

/// Callbacks da sessão (sempre entregues na main queue).
struct P2PCallCallbacks {
    var onConnected: (_ ms: Int) -> Void = { _ in }
    /// afterConnected=false → ainda no setup.
    var onFallback: (_ reason: String, _ afterConnected: Bool) -> Void = { _, _ in }
    var onReconnecting: (_ on: Bool) -> Void = { _ in }
    var onData: (_ obj: [String: Any]) -> Void = { _ in }
    /// Chegou vídeo do par por P2P (a v1 iOS não renderiza → quem integra cai p/ o LiveKit).
    var onRemoteVideoActive: () -> Void = {}
    var log: (_ evt: String, _ info: String) -> Void = { _, _ in }
}

enum P2PSignalTypes {
    static let all: Set<String> = [
        "call_p2p_ready", "call_p2p_offer", "call_p2p_answer",
        "call_p2p_candidate", "call_p2p_restart", "call_p2p_fallback",
    ]
    static func isP2PType(_ t: String?) -> Bool {
        guard let t = t else { return false }
        return all.contains(t)
    }
}

/// Buffer de frames que chegam antes da sessão existir (ready/offer podem
/// chegar antes do answer local terminar). Compartilhado por stub e real.
enum P2PSignalBuffer {
    private static let lock = NSLock()
    private static var buf: [String: [(Date, [String: Any])]] = [:]

    static func push(_ callId: String, _ frame: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        let now = Date()
        var list = (buf[callId] ?? []).filter { now.timeIntervalSince($0.0) < 45 }
        if list.count < 80 { list.append((now, frame)) }
        buf[callId] = list
        if buf.count > 20 {
            buf = buf.filter { !$0.value.isEmpty && now.timeIntervalSince($0.value.last!.0) < 45 }
        }
    }

    static func take(_ callId: String) -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        let now = Date()
        let list = buf.removeValue(forKey: callId) ?? []
        return list.filter { now.timeIntervalSince($0.0) < 45 }.map { $0.1 }
    }
}

#if canImport(LiveKitWebRTC)

final class P2PCallSessionIOS: NSObject, LKRTCPeerConnectionDelegate, LKRTCDataChannelDelegate {

    static let isAvailable = true

    // MARK: registro global

    private static let regLock = NSLock()
    private static var sessions: [String: P2PCallSessionIOS] = [:]

    static func get(_ callId: String) -> P2PCallSessionIOS? {
        regLock.lock(); defer { regLock.unlock() }
        return sessions[callId]
    }

    /// Entrada dos frames call_p2p_* (CallSignalWs, qualquer thread).
    static func dispatchSignal(_ frame: [String: Any]) {
        let id = (frame["call_id"] as? String) ?? ""
        if id.isEmpty { return }
        if let s = get(id) { s.onSignal(frame); return }
        P2PSignalBuffer.push(id, frame)
    }

    private static let factoryLock = NSLock()
    private static var _factory: LKRTCPeerConnectionFactory?

    /// Factory própria (o do LiveKit é interno ao SDK). O RTCAudioSession é o
    /// MESMO singleton do LiveKit (mesmo framework) → o modo manual do
    /// LKAudioSessionCallKitBridge (unidade de áudio só após didActivate do
    /// CallKit) vale também aqui. Só uma das duas pilhas tem áudio ativo por
    /// vez: enquanto o P2P é dono da mídia nada é publicado no Room LiveKit.
    private static func factory() -> LKRTCPeerConnectionFactory {
        factoryLock.lock(); defer { factoryLock.unlock() }
        if let f = _factory { return f }
        _ = RTCInitializeSSL()
        let f = LKRTCPeerConnectionFactory(encoderFactory: LKRTCDefaultVideoEncoderFactory(),
                                           decoderFactory: LKRTCDefaultVideoDecoderFactory())
        _factory = f
        return f
    }

    // MARK: estado

    let callId: String
    let isCaller: Bool
    private let cfg: P2PCallConfig
    private let send: ([String: Any]) -> Void
    private let cb: P2PCallCallbacks
    private let q: DispatchQueue

    private var pc: LKRTCPeerConnection?
    private var audioTx: LKRTCRtpTransceiver?
    private var videoTx: LKRTCRtpTransceiver?
    private var dc: LKRTCDataChannel?
    private var localAudio: LKRTCAudioTrack?

    private(set) var state: String = "new" // new → negotiating → connected → (reconnecting) → closed|fallback
    private var done = false
    private var gen = 0
    private var remoteGen = -1
    private let t0 = Date()
    private(set) var connectedAt: Date?
    private var gotReady = false
    private var haveRemote = false
    private var pendingCands: [[String: Any]] = []
    private var outCands: [[String: Any]] = []
    private var outScheduled = false
    private var discArmed = false
    private var graceArmed = false
    private var timerGen = 0 // invalida timers antigos de desconexão/grace
    private var pathMonitor: NWPathMonitor?
    private var lastPathSig: String?
    private var micEnabled = true
    private var remoteVideoReported = false

    init(callId: String,
         isCaller: Bool,
         cfg: P2PCallConfig,
         send: @escaping ([String: Any]) -> Void,
         callbacks: P2PCallCallbacks) {
        self.callId = callId
        self.isCaller = isCaller
        self.cfg = cfg
        self.send = send
        self.cb = callbacks
        self.q = DispatchQueue(label: "chatyy.p2p.\(callId)")
        super.init()
    }

    // MARK: helpers

    private func log(_ evt: String, _ info: String = "") {
        NSLog("[P2P-iOS][\(callId)] \(evt) \(info)")
        let c = cb
        DispatchQueue.main.async { c.log(evt, info) }
    }

    /// Timer na fila da sessão; não roda depois do teardown.
    private func later(_ ms: Int, _ fn: @escaping () -> Void) {
        q.asyncAfter(deadline: .now() + .milliseconds(ms)) { [weak self] in
            guard let self = self, !self.done else { return }
            fn()
        }
    }

    private func sendFrame(_ type: String, _ extra: [String: Any] = [:]) {
        var o: [String: Any] = ["type": type, "call_id": callId, "gen": gen]
        for (k, v) in extra { o[k] = v }
        send(o)
    }

    private func iceServers() -> [LKRTCIceServer] {
        var out: [LKRTCIceServer] = []
        for o in cfg.iceServers {
            var urls: [String] = []
            if let u = o["urls"] as? String { urls = [u] }
            else if let us = o["urls"] as? [Any] { urls = us.compactMap { $0 as? String } }
            let keep = urls.filter { !$0.isEmpty && (cfg.allowTurn || $0.lowercased().hasPrefix("stun:")) }
            if keep.isEmpty { continue }
            let user = (o["username"] as? String) ?? ""
            let cred = (o["credential"] as? String) ?? ""
            if cfg.allowTurn && !user.isEmpty {
                out.append(LKRTCIceServer(urlStrings: keep, username: user, credential: cred))
            } else {
                out.append(LKRTCIceServer(urlStrings: keep))
            }
        }
        if out.isEmpty {
            // Os coturns de produção só relayam p/ o SFU → sem `turn:true` só STUN.
            out.append(LKRTCIceServer(urlStrings: ["stun:147.93.12.236:3478", "stun:turn.chatyy.com.br:3478"]))
        }
        return out
    }

    // MARK: ciclo de vida

    func start() {
        P2PCallSessionIOS.regLock.lock()
        let prev = P2PCallSessionIOS.sessions[callId]
        P2PCallSessionIOS.sessions[callId] = self
        P2PCallSessionIOS.regLock.unlock()
        if let p = prev, p !== self { p.close("replaced") }
        let buffered = P2PSignalBuffer.take(callId)
        q.async { [weak self] in
            guard let self = self, !self.done else { return }
            do {
                try self.createMediaAndPc()
                self.log("start", "caller=\(self.isCaller) ice=\(self.cfg.iceServers.count) buffered=\(buffered.count)")
                for f in buffered { self.onSignalLocked(f) }
                if self.isCaller {
                    if !self.gotReady {
                        self.later(self.cfg.readyWaitMs) { [weak self] in
                            guard let self = self else { return }
                            if !self.gotReady && self.state == "new" { self.fallbackLocked("peer_not_ready", fromPeer: false) }
                        }
                    } else {
                        self.beginOfferLocked()
                    }
                } else {
                    self.later(self.cfg.connectTimeoutMs + 500) { [weak self] in
                        guard let self = self else { return }
                        if self.state != "connected" && self.state != "reconnecting" { self.fallbackLocked("connect_timeout", fromPeer: false) }
                    }
                    self.sendReadyLocked(0)
                }
                self.watchNetwork()
            } catch {
                self.log("start_err", "\(error)")
                self.fallbackLocked("start_error", fromPeer: false)
            }
        }
    }

    private func sendReadyLocked(_ n: Int) {
        if done || haveRemote || n > 6 { return }
        sendFrame("call_p2p_ready")
        later(600) { [weak self] in self?.sendReadyLocked(n + 1) }
    }

    private func beginOfferLocked() {
        guard state == "new" else { return }
        state = "negotiating"
        later(cfg.connectTimeoutMs) { [weak self] in
            guard let self = self else { return }
            if self.state != "connected" && self.state != "reconnecting" { self.fallbackLocked("connect_timeout", fromPeer: false) }
        }
        makeOfferLocked(iceRestart: false)
    }

    private struct StartError: Error { let msg: String }

    private func createMediaAndPc() throws {
        let f = P2PCallSessionIOS.factory()
        let ac = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: [
            "googEchoCancellation": "true",
            "googNoiseSuppression": "true",
            "googAutoGainControl": "true",
            "googHighpassFilter": "true",
        ])
        let src = f.audioSource(with: ac)
        let at = f.audioTrack(with: src, trackId: "p2pa0")
        at.isEnabled = micEnabled
        localAudio = at

        let rtc = LKRTCConfiguration()
        rtc.iceServers = iceServers()
        rtc.sdpSemantics = .unifiedPlan
        rtc.bundlePolicy = .maxBundle
        rtc.rtcpMuxPolicy = .require
        rtc.continualGatheringPolicy = .gatherContinually
        rtc.iceTransportPolicy = .all
        let pcc = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let p = f.peerConnection(with: rtc, constraints: pcc, delegate: self) else {
            throw StartError(msg: "peerConnection nil")
        }
        pc = p
        if isCaller {
            let ai = LKRTCRtpTransceiverInit()
            ai.direction = .sendRecv
            ai.streamIds = ["p2p0"]
            audioTx = p.addTransceiver(with: at, init: ai)
            let vi = LKRTCRtpTransceiverInit()
            vi.direction = .sendRecv
            vi.streamIds = ["p2p0"]
            videoTx = p.addTransceiver(of: .video, init: vi)
            let dcc = LKRTCDataChannelConfiguration()
            dcc.isOrdered = true
            if let d = p.dataChannel(forLabel: "chatyy", configuration: dcc) {
                d.delegate = self
                dc = d
            }
        }
    }

    // MARK: SDP

    /// Opus: FEC in-band + DTX + teto de bitrate, mono. Mantém o que já existe.
    private func mungeOpus(_ sdp: String) -> String {
        guard let re = try? NSRegularExpression(pattern: "a=rtpmap:(\\d+) opus/48000", options: [.caseInsensitive]),
              let m = re.firstMatch(in: sdp, range: NSRange(sdp.startIndex..., in: sdp)),
              let ptR = Range(m.range(at: 1), in: sdp),
              let fullR = Range(m.range, in: sdp) else { return sdp }
        let pt = String(sdp[ptR])
        let want: [(String, String)] = [
            ("useinbandfec", "1"), ("usedtx", "1"),
            ("maxaveragebitrate", String(cfg.maxAudioKbps * 1000)), ("stereo", "0"),
        ]
        if let fre = try? NSRegularExpression(pattern: "a=fmtp:\(pt) ([^\\r\\n]*)"),
           let fm = fre.firstMatch(in: sdp, range: NSRange(sdp.startIndex..., in: sdp)),
           let lineR = Range(fm.range, in: sdp),
           let parR = Range(fm.range(at: 1), in: sdp) {
            var keys: [String] = []
            var kv: [String: String] = [:]
            for part in sdp[parR].split(separator: ";") {
                let pieces = part.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                guard let k = pieces.first, !k.isEmpty else { continue }
                if kv[k] == nil { keys.append(k) }
                kv[k] = pieces.count > 1 ? pieces[1] : ""
            }
            for (k, v) in want where kv[k] == nil { keys.append(k); kv[k] = v }
            let line = "a=fmtp:\(pt) " + keys.map { "\($0)=\(kv[$0] ?? "")" }.joined(separator: ";")
            var out = sdp
            out.replaceSubrange(lineR, with: line)
            return out
        }
        let add = "\r\na=fmtp:\(pt) " + want.map { "\($0.0)=\($0.1)" }.joined(separator: ";")
        var out = sdp
        out.replaceSubrange(fullR, with: String(sdp[fullR]) + add)
        return out
    }

    private func makeOfferLocked(iceRestart: Bool) {
        guard let p = pc else { return }
        gen += 1
        let myGen = gen
        let mc = LKRTCMediaConstraints(mandatoryConstraints: iceRestart ? ["IceRestart": "true"] : nil,
                                       optionalConstraints: nil)
        p.offer(for: mc) { [weak self] desc, err in
            guard let self = self else { return }
            self.q.async {
                guard !self.done, let pp = self.pc else { return }
                guard let d = desc, err == nil else { self.log("sdp_create_fail", "offer \(String(describing: err))"); return }
                let sdp = self.mungeOpus(d.sdp)
                pp.setLocalDescription(LKRTCSessionDescription(type: .offer, sdp: sdp)) { [weak self] e in
                    guard let self = self else { return }
                    self.q.async {
                        if self.done || myGen != self.gen { return }
                        if let e = e { self.log("sdp_set_fail", "local_offer \(e)"); return }
                        self.sendFrame("call_p2p_offer", ["sdp": sdp, "video": false])
                        self.log("offer_sent", "gen=\(myGen) restart=\(iceRestart)")
                    }
                }
            }
        }
    }

    /// Frame call_p2p_* recebido (qualquer thread).
    func onSignal(_ frame: [String: Any]) {
        q.async { [weak self] in self?.onSignalLocked(frame) }
    }

    private func intVal(_ v: Any?) -> Int? {
        if let n = v as? NSNumber { return n.intValue }
        if let s = v as? String { return Int(s) }
        return nil
    }

    private func onSignalLocked(_ msg: [String: Any]) {
        if done { return }
        switch (msg["type"] as? String) ?? "" {
        case "call_p2p_ready":
            guard isCaller else { return }
            if connectedAt != nil && state != "connected" { restartIceLocked("peer_ready_again"); return }
            if !gotReady { gotReady = true; if pc != nil { beginOfferLocked() } }
        case "call_p2p_fallback":
            fallbackLocked("peer_" + String(((msg["reason"] as? String) ?? "fallback").prefix(40)), fromPeer: true)
        case "call_p2p_restart":
            if isCaller { restartIceLocked("peer_request") }
        case "call_p2p_offer":
            if !isCaller { handleOfferLocked(msg) }
        case "call_p2p_answer":
            if isCaller { handleAnswerLocked(msg) }
        case "call_p2p_candidate":
            guard let arr = msg["candidates"] as? [[String: Any]] else { return }
            for c in arr {
                if !haveRemote { pendingCands.append(c) } else { addCandLocked(c) }
            }
        default:
            break
        }
    }

    private func handleOfferLocked(_ msg: [String: Any]) {
        guard let p = pc else { return }
        let g = intVal(msg["gen"]) ?? (remoteGen + 1)
        if g <= remoteGen { return }
        remoteGen = g
        guard let sdp = msg["sdp"] as? String, !sdp.isEmpty else { return }
        if state == "new" { state = "negotiating" }
        p.setRemoteDescription(LKRTCSessionDescription(type: .offer, sdp: sdp)) { [weak self] err in
            guard let self = self else { return }
            self.q.async {
                guard !self.done, let p2 = self.pc else { return }
                if let err = err { self.log("sdp_set_fail", "remote_offer \(err)"); return }
                self.haveRemote = true
                if self.audioTx == nil {
                    for tx in p2.transceivers {
                        if tx.mediaType == .audio && self.audioTx == nil { self.audioTx = tx }
                        else if tx.mediaType == .video && self.videoTx == nil { self.videoTx = tx }
                    }
                    if let a = self.audioTx {
                        a.setDirection(.sendRecv, error: nil)
                        a.sender.track = self.localAudio
                        a.sender.streamIds = ["p2p0"]
                    }
                    // Vídeo: v1 iOS só recebe (e nem renderiza) — direção
                    // sendrecv sem track mantém o SDP igual ao web/Android.
                    if let v = self.videoTx { v.setDirection(.sendRecv, error: nil) }
                }
                let mc = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
                p2.answer(for: mc) { [weak self] desc, e2 in
                    guard let self = self else { return }
                    self.q.async {
                        guard !self.done, let p3 = self.pc else { return }
                        guard let d = desc, e2 == nil else { self.log("sdp_create_fail", "answer \(String(describing: e2))"); return }
                        let ans = self.mungeOpus(d.sdp)
                        p3.setLocalDescription(LKRTCSessionDescription(type: .answer, sdp: ans)) { [weak self] e3 in
                            guard let self = self else { return }
                            self.q.async {
                                if self.done { return }
                                if let e3 = e3 { self.log("sdp_set_fail", "local_answer \(e3)"); return }
                                self.gen = self.remoteGen
                                self.sendFrame("call_p2p_answer", ["sdp": ans])
                                self.flushCandsLocked()
                            }
                        }
                    }
                }
            }
        }
    }

    private func handleAnswerLocked(_ msg: [String: Any]) {
        guard let p = pc else { return }
        if let g = intVal(msg["gen"]), g != gen { return }
        if p.signalingState != .haveLocalOffer { return }
        guard let sdp = msg["sdp"] as? String, !sdp.isEmpty else { return }
        p.setRemoteDescription(LKRTCSessionDescription(type: .answer, sdp: sdp)) { [weak self] err in
            guard let self = self else { return }
            self.q.async {
                if self.done { return }
                if let err = err { self.log("sdp_set_fail", "remote_answer \(err)"); return }
                self.haveRemote = true
                self.flushCandsLocked()
            }
        }
    }

    private func addCandLocked(_ c: [String: Any]) {
        guard let s = c["candidate"] as? String, !s.isEmpty, let p = pc else { return }
        let mid = c["sdpMid"] as? String
        let idx = Int32(intVal(c["sdpMLineIndex"]) ?? 0)
        p.add(LKRTCIceCandidate(sdp: s, sdpMLineIndex: idx, sdpMid: mid)) { _ in }
    }

    private func flushCandsLocked() {
        let l = pendingCands
        pendingCands.removeAll()
        for c in l { addCandLocked(c) }
    }

    // MARK: LKRTCPeerConnectionDelegate (thread de sinalização do WebRTC)

    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: LKRTCPeerConnection) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: RTCIceConnectionState) {
        q.async { [weak self] in self?.onConnStateLocked() }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        q.async { [weak self] in self?.onConnStateLocked() }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
        let entry: [String: Any] = [
            "candidate": candidate.sdp,
            "sdpMid": candidate.sdpMid ?? "0",
            "sdpMLineIndex": Int(candidate.sdpMLineIndex),
        ]
        q.async { [weak self] in
            guard let self = self, !self.done else { return }
            self.outCands.append(entry)
            if self.outScheduled { return }
            self.outScheduled = true
            self.q.asyncAfter(deadline: .now() + .milliseconds(40)) { [weak self] in
                guard let self = self else { return }
                self.outScheduled = false
                while !self.outCands.isEmpty && !self.done {
                    let n = min(24, self.outCands.count)
                    let batch = Array(self.outCands.prefix(n))
                    self.outCands.removeFirst(n)
                    self.sendFrame("call_p2p_candidate", ["candidates": batch])
                }
            }
        }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {
        q.async { [weak self] in
            guard let self = self, !self.done else { return }
            if self.dc == nil { dataChannel.delegate = self; self.dc = dataChannel }
        }
    }

    // MARK: LKRTCDataChannelDelegate

    func dataChannelDidChangeState(_ dataChannel: LKRTCDataChannel) {
        if dataChannel.readyState == .open {
            q.async { [weak self] in
                guard let self = self, !self.done else { return }
                _ = self.sendDataLocked(["type": "audio_muted", "muted": !self.micEnabled])
            }
        }
    }

    func dataChannel(_ dataChannel: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) {
        if buffer.isBinary { return }
        guard let obj = (try? JSONSerialization.jsonObject(with: buffer.data)) as? [String: Any] else { return }
        let c = cb
        q.async { [weak self] in
            guard let self = self, !self.done else { return }
            DispatchQueue.main.async { c.onData(obj) }
        }
    }

    @discardableResult
    func sendData(_ obj: [String: Any]) -> Bool {
        var ok = false
        q.sync { ok = sendDataLocked(obj) }
        return ok
    }

    private func sendDataLocked(_ obj: [String: Any]) -> Bool {
        guard let d = dc, d.readyState == .open,
              let data = try? JSONSerialization.data(withJSONObject: obj) else { return false }
        return d.sendData(LKRTCDataBuffer(data: data, isBinary: false))
    }

    // MARK: conexão / recuperação

    private func isUpLocked() -> Bool {
        guard let p = pc else { return false }
        return p.connectionState == .connected
    }

    private func onConnStateLocked() {
        guard let p = pc, !done else { return }
        if isUpLocked() {
            timerGen += 1 // cancela disc/grace pendentes
            discArmed = false
            graceArmed = false
            if state != "connected" {
                let wasRe = state == "reconnecting"
                state = "connected"
                if connectedAt == nil {
                    let now = Date()
                    connectedAt = now
                    let ms = Int(now.timeIntervalSince(t0) * 1000)
                    applySenderParamsLocked()
                    startQualityLoopLocked()
                    log("connected", "ms=\(ms)")
                    let c = cb
                    DispatchQueue.main.async { c.onConnected(ms) }
                } else if wasRe {
                    log("reconnected")
                    let c = cb
                    DispatchQueue.main.async { c.onReconnecting(false) }
                }
            }
            return
        }
        if state != "connected" && state != "reconnecting" { return }
        let cs = p.connectionState
        if cs == .failed { beginRecoveryLocked(0) }
        else if cs == .disconnected { beginRecoveryLocked(1500) }
    }

    private func beginRecoveryLocked(_ delayMs: Int) {
        if state == "connected" {
            state = "reconnecting"
            let c = cb
            DispatchQueue.main.async { c.onReconnecting(true) }
        }
        let tg = timerGen
        if !graceArmed {
            graceArmed = true
            later(cfg.reconnectGraceMs) { [weak self] in
                guard let self = self, self.timerGen == tg else { return }
                if !self.isUpLocked() { self.fallbackLocked("ice_lost", fromPeer: false) }
            }
        }
        if discArmed { return }
        discArmed = true
        later(delayMs) { [weak self] in
            guard let self = self, self.timerGen == tg else { return }
            self.discArmed = false
            if !self.isUpLocked() { self.restartIceLocked("ice_\(self.pc?.iceConnectionState.rawValue ?? -1)") }
        }
    }

    private func restartIceLocked(_ reason: String) {
        if done || pc == nil { return }
        log("ice_restart", reason)
        if isCaller { makeOfferLocked(iceRestart: true) }
        else { sendFrame("call_p2p_restart", ["reason": String(reason.prefix(40))]) }
    }

    private func watchNetwork() {
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] path in
            guard let self = self else { return }
            var sig = path.status == .satisfied ? "up" : "down"
            if path.usesInterfaceType(.wifi) { sig += ":wifi" }
            else if path.usesInterfaceType(.cellular) { sig += ":cell" }
            else if path.usesInterfaceType(.wiredEthernet) { sig += ":eth" }
            let sigNow = sig
            self.q.async {
                if self.done { return }
                let prev = self.lastPathSig
                self.lastPathSig = sigNow
                if let prev = prev, prev != sigNow, sigNow.hasPrefix("up"), self.connectedAt != nil {
                    self.restartIceLocked("network_change")
                }
            }
        }
        m.start(queue: q)
        pathMonitor = m
    }

    private func applySenderParamsLocked() {
        guard let s = audioTx?.sender else { return }
        let p = s.parameters
        if let e = p.encodings.first {
            e.maxBitrateBps = NSNumber(value: cfg.maxAudioKbps * 1000)
            s.parameters = p
        }
    }

    /// RTT + perda de áudio a cada 3s (diagnóstico) e detecção de vídeo do
    /// par (a v1 iOS não renderiza vídeo P2P → quem integra cai p/ o LiveKit).
    private func startQualityLoopLocked() {
        later(3000) { [weak self] in
            guard let self = self, let p = self.pc else { return }
            p.statistics { [weak self] report in
                guard let self = self else { return }
                var rtt = -1
                var lost = 0.0
                var rec = 0.0
                var videoFrames = 0.0
                for s in report.statistics.values {
                    let v = s.values
                    if s.type == "candidate-pair",
                       (v["nominated"] as? NSNumber)?.boolValue == true,
                       (v["state"] as? String) == "succeeded",
                       let r = v["currentRoundTripTime"] as? NSNumber {
                        rtt = Int(r.doubleValue * 1000)
                    }
                    if s.type == "inbound-rtp" {
                        let kind = (v["kind"] as? String) ?? (v["mediaType"] as? String) ?? ""
                        if kind == "audio" {
                            lost += (v["packetsLost"] as? NSNumber)?.doubleValue ?? 0
                            rec += (v["packetsReceived"] as? NSNumber)?.doubleValue ?? 0
                        } else if kind == "video" {
                            videoFrames += (v["framesDecoded"] as? NSNumber)?.doubleValue ?? 0
                        }
                    }
                }
                let loss = (rec + lost) > 0 ? lost * 100.0 / (rec + lost) : 0
                let rttMs = rtt
                let vFrames = videoFrames
                self.q.async {
                    if self.done { return }
                    self.log("quality", "rtt=\(rttMs) loss=\(String(format: "%.1f", loss))")
                    if vFrames > 0 && !self.remoteVideoReported {
                        self.remoteVideoReported = true
                        let c = self.cb
                        DispatchQueue.main.async { c.onRemoteVideoActive() }
                    }
                    self.startQualityLoopLocked()
                }
            }
        }
    }

    // MARK: controles

    func setMicEnabled(_ on: Bool) {
        q.async { [weak self] in
            guard let self = self else { return }
            self.micEnabled = on
            self.localAudio?.isEnabled = on
            _ = self.sendDataLocked(["type": "audio_muted", "muted": !on])
        }
    }

    func fallback(_ reason: String) {
        q.async { [weak self] in self?.fallbackLocked(reason, fromPeer: false) }
    }

    private func fallbackLocked(_ reason: String, fromPeer: Bool) {
        if done { return }
        let after = connectedAt != nil
        log("fallback", "reason=\(reason) peer=\(fromPeer) after=\(after) ms=\(Int(Date().timeIntervalSince(t0) * 1000))")
        if !fromPeer { sendFrame("call_p2p_fallback", ["reason": String(reason.prefix(40))]) }
        teardownLocked()
        state = "fallback"
        let c = cb
        DispatchQueue.main.async { c.onFallback(reason, after) }
    }

    func close(_ reason: String) {
        q.async { [weak self] in
            guard let self = self, !self.done else { return }
            self.log("close", reason)
            self.teardownLocked()
            self.state = "closed"
        }
    }

    private func teardownLocked() {
        done = true
        P2PCallSessionIOS.regLock.lock()
        if P2PCallSessionIOS.sessions[callId] === self { P2PCallSessionIOS.sessions.removeValue(forKey: callId) }
        P2PCallSessionIOS.regLock.unlock()
        pathMonitor?.cancel()
        pathMonitor = nil
        if let d = dc { d.delegate = nil; d.close() }
        dc = nil
        if let p = pc { p.delegate = nil; p.close() }
        pc = nil
        localAudio?.isEnabled = false
        localAudio = nil
        audioTx = nil
        videoTx = nil
    }
}

#else

/// Stub: LiveKitWebRTC não importável neste build → P2P indisponível; a
/// ligação segue 100% pelo LiveKit (comportamento anterior).
final class P2PCallSessionIOS: NSObject {
    static let isAvailable = false
    let callId: String
    let isCaller: Bool
    private let cb: P2PCallCallbacks
    private(set) var state: String = "new"
    private(set) var connectedAt: Date?

    static func get(_ callId: String) -> P2PCallSessionIOS? { return nil }
    static func dispatchSignal(_ frame: [String: Any]) {}

    init(callId: String, isCaller: Bool, cfg: P2PCallConfig,
         send: @escaping ([String: Any]) -> Void, callbacks: P2PCallCallbacks) {
        self.callId = callId
        self.isCaller = isCaller
        self.cb = callbacks
        super.init()
    }

    func start() {
        state = "fallback"
        let c = cb
        DispatchQueue.main.async { c.onFallback("unavailable", false) }
    }
    func onSignal(_ frame: [String: Any]) {}
    @discardableResult func sendData(_ obj: [String: Any]) -> Bool { return false }
    func setMicEnabled(_ on: Bool) {}
    func fallback(_ reason: String) {}
    func close(_ reason: String) { state = "closed" }
}

#endif
