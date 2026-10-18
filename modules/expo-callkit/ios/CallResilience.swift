// CallResilience.swift
// [2026-10-18 call-resilience] WhatsApp-level in-call resilience helpers for
// the native 1:1 call screen (CallViewController). Self-contained on purpose
// (Foundation / AVFoundation / UIKit only, no LiveKit types) so a bad change
// is contained and every feature has a kill switch:
//
//   App Group `group.com.onemundo.mail`, key `call_res_flags` = JSON string
//   written by ExpoCallKit.setCallResilienceFlags(json) (JS mirrors
//   globalThis.__chatyy_call_res via OTA). Missing / unparsable = defaults.
//
//   {"enabled":true,            master switch (false = legacy behaviour)
//    "reconnect_tone":true,     soft beep while "Reconectando…"
//    "peer_grace_s":30,         wait this long for a peer that left the SFU (legacy 15)
//    "hold_cap_s":45,           hard cap of continuous "Reconectando…" before ending (0 = off)
//    "end_notice":true,         "Chamada encerrada — conexão perdida" notice
//    "video_autopause":true,    pause OUR camera when the uplink is very poor
//    "vpause_after_s":12,       poor/lost this long → pause
//    "vresume_after_s":8}       good this long → resume (x2, x4 after repeated flaps)
//
// Pieces:
//   CallResilience.flags()      — read (cheap; UserDefaults is cached)
//   CallReconnectGuard          — polls the screen's "reconnecting" state
//                                 every 0.5 s: tone, trail diag, hold cap
//   CallVideoAutoPause          — sustained poor uplink → pause camera
//   CallEndNotice               — transient pill on the key window

import Foundation
import AVFoundation
import UIKit

final class CallResilience {
    static let appGroup = "group.com.onemundo.mail"
    static let flagsKey = "call_res_flags"

    struct Flags {
        var enabled: Bool = true
        var reconnectTone: Bool = true
        var peerGraceS: Double = 30
        var holdCapS: Double = 45
        var endNotice: Bool = true
        var videoAutoPause: Bool = true
        var videoPauseAfterS: Double = 12
        var videoResumeAfterS: Double = 8
    }

    private static func num(_ v: Any?) -> Double? {
        if let n = v as? NSNumber { return n.doubleValue }
        if let s = v as? String { return Double(s) }
        return nil
    }

    private static func bool(_ v: Any?) -> Bool? {
        if let b = v as? Bool { return b }
        if let n = v as? NSNumber { return n.intValue != 0 }
        if let s = v as? String { return s == "1" || s.lowercased() == "true" }
        return nil
    }

    static func flags() -> Flags {
        var f = Flags()
        guard let ud = UserDefaults(suiteName: appGroup),
              let raw = ud.string(forKey: flagsKey),
              let data = raw.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data, options: []),
              let obj = any as? [String: Any] else {
            return f
        }
        if let v = bool(obj["enabled"]) { f.enabled = v }
        if let v = bool(obj["reconnect_tone"]) { f.reconnectTone = v }
        if let v = num(obj["peer_grace_s"]) { f.peerGraceS = min(90, max(10, v)) }
        if let v = num(obj["hold_cap_s"]) { f.holdCapS = (v <= 0) ? 0 : min(120, max(20, v)) }
        if let v = bool(obj["end_notice"]) { f.endNotice = v }
        if let v = bool(obj["video_autopause"]) { f.videoAutoPause = v }
        if let v = num(obj["vpause_after_s"]) { f.videoPauseAfterS = min(60, max(4, v)) }
        if let v = num(obj["vresume_after_s"]) { f.videoResumeAfterS = min(60, max(3, v)) }
        if !f.enabled {
            // Master OFF = exactly the pre-2026-10-18 behaviour.
            f.reconnectTone = false
            f.peerGraceS = 15
            f.holdCapS = 0
            f.endNotice = false
            f.videoAutoPause = false
        }
        return f
    }

    /// Persist the JSON from JS. Empty string = back to defaults.
    /// Returns false when the payload is not a JSON object.
    @discardableResult
    static func save(json: String) -> Bool {
        guard let ud = UserDefaults(suiteName: appGroup) else { return false }
        let t = json.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty {
            ud.removeObject(forKey: flagsKey)
            return true
        }
        guard let data = t.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data, options: []),
              any is [String: Any] else {
            return false
        }
        ud.set(t, forKey: flagsKey)
        return true
    }

    // MARK: - Strings (own table: CallStrings stays untouched)

    private static let table: [String: [String: String]] = [
        "pt-BR": ["connectionLost": "Chamada encerrada — conexão perdida", "videoPaused": "Vídeo pausado — conexão fraca"],
        "pt-PT": ["connectionLost": "Chamada terminada — ligação perdida", "videoPaused": "Vídeo em pausa — ligação fraca"],
        "en": ["connectionLost": "Call ended — connection lost", "videoPaused": "Video paused — poor connection"],
        "es": ["connectionLost": "Llamada finalizada — se perdió la conexión", "videoPaused": "Video en pausa — conexión débil"],
        "fr": ["connectionLost": "Appel terminé — connexion perdue", "videoPaused": "Vidéo en pause — connexion faible"],
        "de": ["connectionLost": "Anruf beendet — Verbindung verloren", "videoPaused": "Video pausiert — schwache Verbindung"],
        "it": ["connectionLost": "Chiamata terminata — connessione persa", "videoPaused": "Video in pausa — connessione debole"],
        "ja": ["connectionLost": "通話終了 — 接続が切れました", "videoPaused": "ビデオ一時停止 — 接続が不安定です"],
        "ar": ["connectionLost": "انتهت المكالمة — انقطع الاتصال", "videoPaused": "تم إيقاف الفيديو مؤقتًا — اتصال ضعيف"],
        "id": ["connectionLost": "Panggilan berakhir — koneksi terputus", "videoPaused": "Video dijeda — koneksi lemah"],
        "hi": ["connectionLost": "कॉल समाप्त — कनेक्शन टूट गया", "videoPaused": "वीडियो रुका — कमज़ोर कनेक्शन"],
    ]

    static func text(_ key: String, lang: String) -> String {
        if let v = table[lang]?[key] { return v }
        if let v = table["en"]?[key] { return v }
        return key
    }

    // MARK: - Soft "reconnecting" tone (mono 16-bit PCM WAV, generated once)

    private static var cachedToneWav: Data?

    /// Two soft 440 Hz blips then ~2.6 s of silence (loops). Quiet on purpose:
    /// it only tells the user the call is still alive.
    static func reconnectToneWav() -> Data {
        if let d = cachedToneWav { return d }
        let sampleRate = 16000
        let freq = 440.0
        let amplitude = 0.16
        let pattern: [(Double, Double)] = [(0.11, 0.09), (0.11, 2.6)]
        var samples: [Int16] = []
        let fade = max(1, Int(Double(sampleRate) * 0.015))
        let step = 2.0 * Double.pi * freq / Double(sampleRate)
        for (onSec, offSec) in pattern {
            let on = Int(Double(sampleRate) * onSec)
            let off = Int(Double(sampleRate) * offSec)
            var phase = 0.0
            for i in 0..<on {
                var env = 1.0
                if i < fade {
                    env = Double(i) / Double(fade)
                } else if i > on - fade {
                    env = Double(on - i) / Double(fade)
                }
                let v = max(-1.0, min(1.0, sin(phase) * amplitude * env))
                samples.append(Int16(v * 32767.0))
                phase += step
                if phase > 2.0 * Double.pi { phase -= 2.0 * Double.pi }
            }
            if off > 0 { samples.append(contentsOf: repeatElement(Int16(0), count: off)) }
        }
        let dataBytes = samples.count * 2
        var b: [UInt8] = []
        b.reserveCapacity(44 + dataBytes)
        func le32(_ v: UInt32) {
            b.append(UInt8(v & 0xff)); b.append(UInt8((v >> 8) & 0xff))
            b.append(UInt8((v >> 16) & 0xff)); b.append(UInt8((v >> 24) & 0xff))
        }
        func le16(_ v: UInt16) {
            b.append(UInt8(v & 0xff)); b.append(UInt8((v >> 8) & 0xff))
        }
        b.append(contentsOf: Array("RIFF".utf8)); le32(UInt32(36 + dataBytes))
        b.append(contentsOf: Array("WAVE".utf8))
        b.append(contentsOf: Array("fmt ".utf8)); le32(16)
        le16(1)
        le16(1)
        le32(UInt32(sampleRate))
        le32(UInt32(sampleRate * 2))
        le16(2)
        le16(16)
        b.append(contentsOf: Array("data".utf8)); le32(UInt32(dataBytes))
        for s in samples {
            let u = UInt16(bitPattern: s)
            b.append(UInt8(u & 0xff)); b.append(UInt8(u >> 8))
        }
        let d = Data(b)
        cachedToneWav = d
        return d
    }
}

// MARK: - Reconnect guard

/// Main thread only. Owned by CallViewController for one call.
/// Polls `isReconnecting()` (the screen's own truth: LK .reconnecting OR the
/// peer-gone grace) every 0.5 s, so no existing code path has to call it.
final class CallReconnectGuard {
    private let flags: CallResilience.Flags
    private let isReconnecting: () -> Bool
    private let mediaConnected: () -> Bool
    private let onGiveUp: () -> Void
    private let diag: (String, String) -> Void
    private var timer: Timer?
    private var since: Date?
    private var episodes = 0
    private var gaveUp = false
    private var player: AVAudioPlayer?

    init(flags: CallResilience.Flags,
         isReconnecting: @escaping () -> Bool,
         mediaConnected: @escaping () -> Bool,
         onGiveUp: @escaping () -> Void,
         diag: @escaping (String, String) -> Void) {
        self.flags = flags
        self.isReconnecting = isReconnecting
        self.mediaConnected = mediaConnected
        self.onGiveUp = onGiveUp
        self.diag = diag
    }

    func start() {
        guard flags.enabled, timer == nil else { return }
        let t = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        stopTone()
        if let s = since {
            since = nil
            diag("call_reconnect_end", "ok=0 why=stopped ms=\(Int(Date().timeIntervalSince(s) * 1000)) n=\(episodes)")
        }
    }

    deinit {
        timer?.invalidate()
        player?.stop()
    }

    private func tick() {
        let rec = isReconnecting()
        // Only for a call whose media already flowed: before that, the
        // connect watchdogs own the screen ("Conectando…").
        let live = mediaConnected()
        if rec && live {
            if since == nil {
                since = Date()
                episodes += 1
                gaveUp = false
                diag("call_reconnect_begin", "n=\(episodes) tone=\(flags.reconnectTone ? 1 : 0) cap=\(Int(flags.holdCapS))")
                if flags.reconnectTone { startTone() }
            } else if flags.reconnectTone, let p = player, !p.isPlaying {
                // Paused by an audio-session interruption / route change.
                _ = p.play()
            }
            if let s = since, flags.holdCapS > 0, !gaveUp,
               Date().timeIntervalSince(s) >= flags.holdCapS {
                gaveUp = true
                stopTone()
                diag("call_reconnect_giveup", "ms=\(Int(Date().timeIntervalSince(s) * 1000)) n=\(episodes)")
                since = nil
                onGiveUp()
            }
        } else if let s = since {
            since = nil
            stopTone()
            diag("call_reconnect_end", "ok=\(rec ? 0 : 1) ms=\(Int(Date().timeIntervalSince(s) * 1000)) n=\(episodes)")
        }
    }

    private func startTone() {
        guard player == nil else { return }
        do {
            let p = try AVAudioPlayer(data: CallResilience.reconnectToneWav(), fileTypeHint: AVFileType.wav.rawValue)
            p.numberOfLoops = -1
            p.volume = 0.5
            p.prepareToPlay()
            if p.play() {
                player = p
            } else {
                diag("call_reconnect_tone_fail", "play=false")
            }
        } catch {
            diag("call_reconnect_tone_fail", "err=\(error.localizedDescription)")
        }
    }

    private func stopTone() {
        player?.stop()
        player = nil
    }
}

// MARK: - Video auto-pause

/// Main thread only. Sustained poor/lost uplink while our camera is on →
/// pause (mute) it; sustained good → resume. Repeated flaps double the
/// resume wait (x2, x4) so a marginal link doesn't oscillate.
final class CallVideoAutoPause {
    private let flags: CallResilience.Flags
    /// Camera on by the USER and published.
    private let cameraWanted: () -> Bool
    /// May we pause right now (1:1, not reconnecting / on hold / sharing).
    private let eligible: () -> Bool
    private let pause: () -> Void
    private let resume: () -> Void
    private let changed: () -> Void
    private let diag: (String, String) -> Void
    private var timer: Timer?
    private var score = -1
    private var badSince: Date?
    private var goodSince: Date?
    private var flaps = 0
    private(set) var paused = false

    init(flags: CallResilience.Flags,
         cameraWanted: @escaping () -> Bool,
         eligible: @escaping () -> Bool,
         pause: @escaping () -> Void,
         resume: @escaping () -> Void,
         changed: @escaping () -> Void,
         diag: @escaping (String, String) -> Void) {
        self.flags = flags
        self.cameraWanted = cameraWanted
        self.eligible = eligible
        self.pause = pause
        self.resume = resume
        self.changed = changed
        self.diag = diag
    }

    func start() {
        guard flags.videoAutoPause, timer == nil else { return }
        let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    deinit { timer?.invalidate() }

    /// Local ConnectionQuality: 0 lost, 1 poor, 2 good, 3 excellent (-1 unknown).
    func noteLocalQuality(_ s: Int) {
        score = s
    }

    /// The user toggled the camera by hand: their choice wins, forget ours.
    func userToggledCamera() {
        badSince = nil
        goodSince = nil
        if paused {
            paused = false
            diag("video_autopause_clear", "why=user_toggle")
            changed()
        }
    }

    private func tick() {
        let now = Date()
        if !paused {
            goodSince = nil
            guard cameraWanted(), eligible(), score >= 0, score <= 1 else {
                badSince = nil
                return
            }
            if badSince == nil { badSince = now }
            if let b = badSince, now.timeIntervalSince(b) >= flags.videoPauseAfterS {
                badSince = nil
                paused = true
                diag("video_autopause_on", "score=\(score) after=\(Int(flags.videoPauseAfterS)) flaps=\(flaps)")
                pause()
                changed()
            }
        } else {
            badSince = nil
            if !cameraWanted() {
                // User switched the camera off meanwhile: nothing to resume.
                paused = false
                goodSince = nil
                diag("video_autopause_clear", "why=camera_off")
                changed()
                return
            }
            guard score >= 2 else {
                goodSince = nil
                return
            }
            if goodSince == nil { goodSince = now }
            let mult = Double(1 << min(flaps, 2))
            if let g = goodSince, now.timeIntervalSince(g) >= flags.videoResumeAfterS * mult {
                goodSince = nil
                paused = false
                flaps += 1
                diag("video_autopause_off", "score=\(score) flaps=\(flaps)")
                resume()
                changed()
            }
        }
    }
}

// MARK: - End notice

/// Transient pill on the app's key window (survives the call screen's
/// dismissal). Main thread only. No-op when the app has no window.
enum CallEndNotice {
    static func show(_ text: String, delay: Double = 0.4) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            guard let window = keyWindow() else { return }
            let pill = UIView()
            pill.translatesAutoresizingMaskIntoConstraints = false
            pill.backgroundColor = UIColor.black.withAlphaComponent(0.82)
            pill.layer.cornerRadius = 18
            pill.isUserInteractionEnabled = false
            pill.alpha = 0
            let lbl = UILabel()
            lbl.translatesAutoresizingMaskIntoConstraints = false
            lbl.text = text
            lbl.textColor = .white
            lbl.font = .systemFont(ofSize: 14, weight: .medium)
            lbl.numberOfLines = 2
            lbl.textAlignment = .center
            pill.addSubview(lbl)
            window.addSubview(pill)
            NSLayoutConstraint.activate([
                pill.centerXAnchor.constraint(equalTo: window.centerXAnchor),
                pill.bottomAnchor.constraint(equalTo: window.safeAreaLayoutGuide.bottomAnchor, constant: -96),
                pill.widthAnchor.constraint(lessThanOrEqualTo: window.widthAnchor, constant: -32),
                lbl.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 16),
                lbl.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -16),
                lbl.topAnchor.constraint(equalTo: pill.topAnchor, constant: 10),
                lbl.bottomAnchor.constraint(equalTo: pill.bottomAnchor, constant: -10),
            ])
            UIView.animate(withDuration: 0.25) { pill.alpha = 1 }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.2) {
                UIView.animate(withDuration: 0.3, animations: { pill.alpha = 0 }, completion: { _ in
                    pill.removeFromSuperview()
                })
            }
        }
    }

    private static func keyWindow() -> UIWindow? {
        for scene in UIApplication.shared.connectedScenes {
            guard let ws = scene as? UIWindowScene else { continue }
            if let w = ws.windows.first(where: { $0.isKeyWindow }) { return w }
        }
        for scene in UIApplication.shared.connectedScenes {
            guard let ws = scene as? UIWindowScene else { continue }
            if let w = ws.windows.first { return w }
        }
        return nil
    }
}
