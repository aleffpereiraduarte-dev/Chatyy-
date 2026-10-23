// CallSystemIntegration.swift — [2026-10-09 system-integration] small,
// self-contained pieces that make a Chatyy call behave like a system call
// (WhatsApp parity). Nothing here touches LiveKit connect options.
//
//   * CallHoldResumer        — auto-resume a Chatyy call the SYSTEM put on
//                              hold ("Hold & Accept" on a GSM / other VoIP
//                              call) once the other call ends.
//   * CallMultitaskingCamera — keep the local camera alive while the call is
//                              in Picture-in-Picture (iOS 16+, requires the
//                              com.apple.developer.avfoundation.multitasking-
//                              camera-access entitlement; no-op without it).
//   * CallRecentsIntentStore — Phone.app Recents / Siri / CarPlay redial:
//                              maps the CallKit handle we reported back to a
//                              Chatyy email and hands INStartCallIntent to JS.

import Foundation
import AVFoundation
import CallKit
import Intents

// MARK: - CallHoldResumer

final class CallHoldResumer: NSObject, CXCallObserverDelegate {
    static let shared = CallHoldResumer()

    private let observer = CXCallObserver()
    private var installed = false
    /// Our call UUIDs that were put on hold while ANOTHER call was live —
    /// i.e. the system (not the user's own "Colocar em espera") held them.
    /// Main-thread only (CXProvider delegate + observer both run on main).
    private var systemHeld = Set<UUID>()
    private var pendingResume: [UUID: DispatchWorkItem] = [:]

    func install() {
        let run = { [weak self] in
            guard let self = self, !self.installed else { return }
            self.installed = true
            self.observer.setDelegate(self, queue: DispatchQueue.main)
        }
        if Thread.isMainThread { run() } else { DispatchQueue.main.async(execute: run) }
    }

    /// Called from ProviderDelegate's CXSetHeldCallAction handler (main).
    func noteHoldAction(uuid: UUID, onHold: Bool) {
        if onHold {
            let othersLive = observer.calls.contains { $0.uuid != uuid && !$0.hasEnded }
            if othersLive {
                systemHeld.insert(uuid)
                NSLog("[CallHoldResumer] system hold uuid=\(uuid.uuidString) — will auto-resume when the other call ends")
            } else {
                systemHeld.remove(uuid)
            }
        } else {
            systemHeld.remove(uuid)
            pendingResume.removeValue(forKey: uuid)?.cancel()
        }
    }

    func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
        guard !systemHeld.isEmpty else { return }
        for uuid in systemHeld {
            guard let ours = callObserver.calls.first(where: { $0.uuid == uuid }), !ours.hasEnded else {
                systemHeld.remove(uuid)
                pendingResume.removeValue(forKey: uuid)?.cancel()
                continue
            }
            guard ours.isOnHold else {
                // Already resumed (by the system or the user via the pill).
                systemHeld.remove(uuid)
                continue
            }
            // Another call still active (not ended, not itself held)? Wait.
            let othersActive = callObserver.calls.contains {
                $0.uuid != uuid && !$0.hasEnded && !$0.isOnHold
            }
            if othersActive { continue }
            scheduleResume(uuid)
        }
    }

    private func scheduleResume(_ uuid: UUID) {
        guard pendingResume[uuid] == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.pendingResume.removeValue(forKey: uuid)
            guard self.systemHeld.contains(uuid),
                  let ours = self.observer.calls.first(where: { $0.uuid == uuid }),
                  !ours.hasEnded, ours.isOnHold else { return }
            let othersActive = self.observer.calls.contains {
                $0.uuid != uuid && !$0.hasEnded && !$0.isOnHold
            }
            if othersActive { return }
            NSLog("[CallHoldResumer] other call ended — resuming uuid=\(uuid.uuidString)")
            let tx = CXTransaction(action: CXSetHeldCallAction(call: uuid, onHold: false))
            CXCallController(queue: .main).request(tx) { error in
                if let error = error {
                    NSLog("[CallHoldResumer] resume failed: \(error.localizedDescription)")
                }
            }
        }
        pendingResume[uuid] = work
        // Small grace so the GSM audio session is fully released first.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: work)
    }
}

// MARK: - CallMultitaskingCamera

enum CallMultitaskingCamera {
    private static var token: NSObjectProtocol?
    private static let callObserver = CXCallObserver()

    /// Main thread. Idempotent.
    static func install() {
        guard token == nil else { return }
        token = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.didStartRunningNotification,
            object: nil,
            queue: nil
        ) { note in
            guard let session = note.object as? AVCaptureSession else { return }
            if #available(iOS 16.0, *) {
                // Only while a call is live — other capture surfaces (status
                // camera, QR) keep the default behaviour.
                guard callObserver.calls.contains(where: { !$0.hasEnded }) else { return }
                guard session.isMultitaskingCameraAccessSupported,
                      !session.isMultitaskingCameraAccessEnabled else { return }
                session.isMultitaskingCameraAccessEnabled = true
                NSLog("[CallMultitaskingCamera] multitasking camera access enabled (PiP keeps camera)")
            }
        }
    }
}

// MARK: - CallRecentsIntentStore

enum CallRecentsIntentStore {
    static let didReceiveNotification = Notification.Name("ChatyyStartCallIntent")

    private static let mapKey = "chatyy.recents_handle_map"
    private static let pendingKey = "chatyy.pending_start_call_intent"
    private static let maxEntries = 300
    private static let pendingTtl: TimeInterval = 120

    private static var defaults: UserDefaults {
        return UserDefaults(suiteName: "group.com.onemundo.mail") ?? .standard
    }

    static func normalize(_ raw: String) -> String {
        let v = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if v.contains("@") { return v }
        let digits = v.filter { $0.isNumber }
        // Phone-ish handle (Recents may hand back a formatted number).
        if digits.count >= 8 && digits.count >= v.filter({ !$0.isWhitespace }).count - 4 {
            return digits
        }
        return v
    }

    /// Remember which Chatyy account a CallKit handle value belongs to, so a
    /// redial from Phone.app Recents (which only carries the handle) can be
    /// mapped back. Cheap; safe from any thread (UserDefaults is thread-safe).
    static func remember(handleValue: String, email: String, name: String, conversationId: String) {
        let key = normalize(handleValue)
        let mail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, !mail.isEmpty, mail.contains("@") else { return }
        var map = (defaults.dictionary(forKey: mapKey) as? [String: [String: Any]]) ?? [:]
        map[key] = [
            "email": mail,
            "name": name,
            "conv": conversationId,
            "ts": Date().timeIntervalSince1970,
        ]
        if map.count > maxEntries {
            let sorted = map.sorted {
                (($0.value["ts"] as? Double) ?? 0) < (($1.value["ts"] as? Double) ?? 0)
            }
            for (k, _) in sorted.prefix(map.count - maxEntries) { map.removeValue(forKey: k) }
        }
        defaults.set(map, forKey: mapKey)
    }

    /// [2026-10-20 caller-name] Último nome de exibição conhecido p/ um e-mail
    /// (ligações anteriores). nil quando não há nome útil.
    static func knownName(forEmail email: String) -> String? {
        let mail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !mail.isEmpty else { return nil }
        if let m = defaults.dictionary(forKey: namesKey) as? [String: String],
           let n = m[mail], CallerNameResolver.isUseful(n, email: mail) { return n }
        guard let map = defaults.dictionary(forKey: mapKey) as? [String: [String: Any]] else { return nil }
        var best: (String, Double)? = nil
        for (_, v) in map {
            guard ((v["email"] as? String) ?? "").lowercased() == mail,
                  let n = v["name"] as? String, CallerNameResolver.isUseful(n, email: mail),
                  n.lowercased() != String(mail.split(separator: "@").first ?? "") else { continue }
            let ts = (v["ts"] as? Double) ?? 0
            if best == nil || ts > best!.1 { best = (n, ts) }
        }
        return best?.0
    }
    private static let namesKey = "chatyy.caller_names_v1"
    /// [2026-10-20 caller-name] Guarda e-mail → nome (máx. 500).
    static func rememberName(_ name: String, forEmail email: String) {
        let mail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard mail.contains("@"), CallerNameResolver.isUseful(n, email: mail) else { return }
        var m = (defaults.dictionary(forKey: namesKey) as? [String: String]) ?? [:]
        if m[mail] == n { return }
        if m.count >= 500, let k = m.keys.first { m.removeValue(forKey: k) }
        m[mail] = n
        defaults.set(m, forKey: namesKey)
    }

    /// Parse an INStartCallIntent-family user activity. Returns true when it
    /// was a call intent (handled), false otherwise.
    static func handle(userActivity: NSUserActivity) -> Bool {
        guard let intent = userActivity.interaction?.intent else { return false }
        var handleValue: String?
        var displayName: String?
        var video = false
        if let i = intent as? INStartCallIntent {
            handleValue = i.contacts?.first?.personHandle?.value
            displayName = i.contacts?.first?.displayName
            video = i.callCapability == .videoCall
        } else {
            // iOS 13+ always delivers INStartCallIntent (the deprecated
            // INStartAudio/VideoCallIntent types are intentionally not used).
            return false
        }
        // [2026-10-23 callkit-native-buttons] "Video" on the native CallKit
        // screen of an ongoing call arrives as INStartCallIntent for the SAME
        // contact. Never treat it as a new call: hand it to the live call
        // screen (restore + camera on). expo-native-toolkit's shortcut
        // subscriber skips call intents while a call is active (same rule).
        if CallViewController.hasOngoing() || hasActiveSystemCall() {
            NSLog("[CallRecentsIntent] call intent during an active call (video=\(video)) → live call screen")
            CallViewController.handleSystemCallIntent(video: video)
            return true
        }
        let raw = (handleValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else {
            NSLog("[CallRecentsIntent] call intent without handle — ignored")
            return false
        }
        // Email handles (our OUTGOING calls report .emailAddress) are routed by
        // expo-native-toolkit's AppShortcutsAppDelegateSubscriber
        // (onemundomail://assistant-action/call?email=…). We only take the
        // handles it cannot resolve: display-name / phone handles of INCOMING
        // calls, mapped back through remember(). Never both → no double call.
        if raw.contains("@") { return false }
        var email = ""
        var name = displayName ?? ""
        var conv = ""
        let key = normalize(raw)
        if let map = defaults.dictionary(forKey: mapKey) as? [String: [String: Any]],
           let hit = map[key] {
            email = (hit["email"] as? String) ?? ""
            if name.isEmpty { name = (hit["name"] as? String) ?? "" }
            conv = (hit["conv"] as? String) ?? ""
        }
        let payload: [String: Any] = [
            "handle": raw,
            "email": email,
            "name": name,
            "video": video,
            "conversationId": conv,
            "ts": Date().timeIntervalSince1970,
        ]
        defaults.set(payload, forKey: pendingKey)
        NSLog("[CallRecentsIntent] start-call intent video=\(video) resolved=\(!email.isEmpty)")
        let post = {
            NotificationCenter.default.post(name: didReceiveNotification, object: nil, userInfo: payload)
        }
        if Thread.isMainThread { post() } else { DispatchQueue.main.async(execute: post) }
        return true
    }

    /// A Chatyy CallKit call that has not ended (ringing, dialing or live).
    private static func hasActiveSystemCall() -> Bool {
        return CXCallObserver().calls.contains { call in
            !call.hasEnded && ExpoCallKitModule.sharedCallId(forCallKitUUID: call.uuid) != nil
        }
    }

    /// One-shot read for JS (cold start: JS mounts after the activity).
    static func consumePending() -> [String: Any]? {
        guard let p = defaults.dictionary(forKey: pendingKey) else { return nil }
        defaults.removeObject(forKey: pendingKey)
        let ts = (p["ts"] as? Double) ?? 0
        if Date().timeIntervalSince1970 - ts > pendingTtl { return nil }
        return p
    }
}


/// [2026-10-20 caller-name] Nome de quem liga p/ o CallKit — nunca "Chatyy"
/// quando há QUALQUER pista: caller_name → caller_display → nome já visto p/
/// esse e-mail → parte local do e-mail → "Chatyy". Prod 20/10 12:36Z: o hub
/// (auth pelo atalho PG auth_tokens) mandou caller_name "" e o banner mostrou
/// "Chatyy" com o e-mail da Thalisa no mesmo frame.
enum CallerNameResolver {
    static func isUseful(_ raw: String, email: String) -> Bool {
        let n = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if n.isEmpty { return false }
        let l = n.lowercased()
        if l == "chatyy" || l == "unknown" || l == "desconhecido" { return false }
        if !email.isEmpty && l == email.lowercased() { return false }
        return true
    }
    static func resolve(_ dict: [AnyHashable: Any], email: String) -> String {
        let mail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        for k in ["caller_name", "callerName", "caller_display", "caller_display_name"] {
            if let s = dict[k] as? String, isUseful(s, email: mail) {
                let n = s.trimmingCharacters(in: .whitespacesAndNewlines)
                CallRecentsIntentStore.rememberName(n, forEmail: mail)
                return n
            }
        }
        if let n = CallRecentsIntentStore.knownName(forEmail: mail) { return n }
        if let at = mail.firstIndex(of: "@"), at > mail.startIndex {
            return String(mail[..<at])
        }
        return mail.isEmpty ? "Chatyy" : mail
    }
}
