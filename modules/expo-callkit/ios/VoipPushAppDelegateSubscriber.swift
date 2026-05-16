import ExpoModulesCore
import UIKit
import PushKit
import CallKit
import AVFoundation

// [bug 2026-05-15 cold-start-voip-drop] PKPushRegistry MUST be created in
// AppDelegate.application(_:didFinishLaunchingWithOptions:) — NOT in the
// Expo module's OnCreate which runs after RN bundle parse (1-3s into cold
// start). When the first VoIP push arrives before the registry exists, iOS
// drops it AND flags the app as "misbehaving", which can throttle or stop
// future VoIP push deliveries for that token. Subsequent pushes look fine
// because the registry is now alive, masking the real bug.
//
// Lives in modules/expo-callkit/ios/ so it survives `expo prebuild --clean`
// (the /ios dir is gitignored and is regenerated). The expo-module.config
// registers this class as an `appDelegateSubscribers`, which makes
// ExpoModulesCore install the hooks into AppDelegate at build time.
//
// We hand off to ExpoCallKitModule via App Group UserDefaults + NotificationCenter:
//   - Token: kept in App Group "voipToken" + posted as ExpoCallKitVoipTokenUpdated.
//   - Incoming pushes: pending queue persisted under "pendingVoipCall"; module
//     drains on RN bundle load AND listens for ExpoCallKitPendingVoipCall.
//
// References:
//   - https://developer.apple.com/documentation/pushkit/pkpushregistry/init(queue:)
//   - https://developer.apple.com/forums/thread/796519 (run-loop deadline)

private let kAppGroupId = "group.com.onemundo.mail"
private let kPendingCallKey = "pendingVoipCall"

// [stage 2 native LiveKit pre-connect, 2026-05-15]
// When CXAnswerCallAction fires before the RN bundle is up, we want to start
// the LiveKit Room.connect handshake immediately so audio is alive in <1s.
// We need the call payload (room_name, identity-or-email, callId) to do that,
// keyed by the CallKit UUID — that's the only identifier CallKit hands us in
// the answer callback. This dictionary persists in-memory for the lifetime of
// the app process (which on a VoIP cold start is exactly the call's lifetime).
private var kPendingAnswerPayloads: [UUID: [String: Any]] = [:]
private let kPendingAnswerPayloadsLock = NSLock()

public class VoipPushAppDelegateSubscriber: ExpoAppDelegateSubscriber {

    // PushKit registry and stub CallKit provider live for the lifetime of the
    // app (created in didFinishLaunching). ExpoCallKitModule observes via
    // App Group UserDefaults + NotificationCenter; once RN bundle is loaded,
    // the real module replays the pending call via `onIncomingCall`.
    static var voipRegistry: PKPushRegistry?
    static var earlyProvider: CXProvider?

    // Dedicated serial queue at userInteractive QoS.
    // PKPushRegistry on .main is starved during cold start because RN bridge
    // is hot on main; the result is the same-run-loop reportNewIncomingCall
    // requirement gets violated. WhatsApp/Telegram use a private serial
    // queue here too.
    static let voipQueue = DispatchQueue(label: "com.chatyy.voip", qos: .userInteractive)

    // Singleton-style delegate target so PushKit and CallKit have a strong
    // reference for their delegate slots (they hold them weak).
    static let shared = VoipPushAppDelegateSubscriber()

    private static var didInstall = false

    public func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        VoipPushAppDelegateSubscriber.installOnce()
        return true
    }

    /// Idempotent setup. Safe to call from multiple paths.
    static func installOnce() {
        guard !didInstall else { return }
        didInstall = true

        // WebRTC manual audio mode. With manual mode the WebRTC audio unit
        // (VPIO) is NOT started until we explicitly set isAudioEnabled = true
        // — which we do inside provider:didActivate. Without this, the audio
        // unit starts before CallKit owns the session and mic capture is
        // silent on the cold-start VoIP path.
        configureRTCAudioSessionManual()

        // CallKit stub provider must exist BEFORE the first PushKit push
        // arrives, so reportNewIncomingCall can run in the same run-loop tick.
        setupEarlyCallKitProvider()
        setupVoipPushRegistry()
    }

    // MARK: - Early CallKit provider (stub)

    private static func setupEarlyCallKitProvider() {
        let config = CXProviderConfiguration(localizedName: "Chatyy")
        config.supportsVideo = true
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.includesCallsInRecents = true
        config.ringtoneSound = "ringtone.wav"
        config.supportedHandleTypes = [.generic, .emailAddress]
        let p = CXProvider(configuration: config)
        p.setDelegate(shared, queue: .main)
        earlyProvider = p
        print("[VoipSubscriber] Early CXProvider configured (stub until RN bundle loads)")
    }

    private static func setupVoipPushRegistry() {
        let registry = PKPushRegistry(queue: voipQueue)
        registry.delegate = shared
        registry.desiredPushTypes = [.voIP]
        voipRegistry = registry
        print("[VoipSubscriber] PKPushRegistry created on serial queue at app launch")
    }

    // MARK: - WebRTC manual audio mode

    private static func configureRTCAudioSessionManual() {
        // Reach for RTCAudioSession dynamically — react-native-webrtc may not
        // be linked at this point on debug builds. Resolving via NSClassFromString
        // avoids hard-link issues.
        guard let cls = NSClassFromString("RTCAudioSession") else {
            print("[VoipSubscriber] RTCAudioSession not present yet — manual mode deferred")
            return
        }
        let sharedSel = NSSelectorFromString("sharedInstance")
        guard (cls as AnyObject).responds(to: sharedSel) else { return }
        let session = (cls as AnyObject).perform(sharedSel)?.takeUnretainedValue() as? NSObject
        let setManualSel = NSSelectorFromString("setUseManualAudio:")
        let setEnabledSel = NSSelectorFromString("setIsAudioEnabled:")
        if session?.responds(to: setManualSel) == true {
            session?.perform(setManualSel, with: NSNumber(value: true))
        }
        if session?.responds(to: setEnabledSel) == true {
            session?.perform(setEnabledSel, with: NSNumber(value: false))
        }
        print("[VoipSubscriber] RTCAudioSession useManualAudio=true, isAudioEnabled=false")
    }

    fileprivate static func setRTCAudioEnabled(_ enabled: Bool) {
        guard let cls = NSClassFromString("RTCAudioSession") else { return }
        let sharedSel = NSSelectorFromString("sharedInstance")
        guard (cls as AnyObject).responds(to: sharedSel) else { return }
        let session = (cls as AnyObject).perform(sharedSel)?.takeUnretainedValue() as? NSObject
        let sel = NSSelectorFromString("setIsAudioEnabled:")
        if session?.responds(to: sel) == true {
            session?.perform(sel, with: NSNumber(value: enabled))
        }
    }
}

// MARK: - PKPushRegistryDelegate

extension VoipPushAppDelegateSubscriber: PKPushRegistryDelegate {
    public func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        print("[VoipSubscriber] VoIP token received: \(token.prefix(8))…")
        if let ud = UserDefaults(suiteName: kAppGroupId) {
            ud.set(token, forKey: "voipToken")
            ud.set(Date().timeIntervalSince1970, forKey: "voipTokenAt")
        }
        NotificationCenter.default.post(
            name: Notification.Name("ExpoCallKitVoipTokenUpdated"),
            object: nil,
            userInfo: ["token": token]
        )
    }

    public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        print("[VoipSubscriber] VoIP token invalidated — re-arming")
        DispatchQueue.main.async {
            registry.desiredPushTypes = [.voIP]
        }
    }

    public func pushRegistry(_ registry: PKPushRegistry,
                             didReceiveIncomingPushWith payload: PKPushPayload,
                             for type: PKPushType,
                             completion: @escaping () -> Void) {
        guard type == .voIP else { completion(); return }
        print("[VoipSubscriber] VoIP push received on \(Thread.isMainThread ? "main" : "voip-queue")")

        let dict = payload.dictionaryPayload
        let callId = (dict["call_id"] as? String) ?? UUID().uuidString
        let callerName = (dict["caller_name"] as? String) ?? (dict["caller_email"] as? String) ?? "Unknown"
        let hasVideo = (dict["video"] as? String) == "1" || (dict["call_type"] as? String) == "video"

        // reportNewIncomingCall FIRST — before any bookkeeping. Apple's
        // run-loop deadline is enforced: any work between the push receipt
        // and the report call eats budget and any blocking sync can push us
        // over the deadline. iOS then kills the app and stops VoIP delivery.
        let uuid = UUID()
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callerName)
        update.localizedCallerName = callerName
        update.hasVideo = hasVideo
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsHolding = true
        update.supportsDTMF = false

        // [stage 2] Stash payload keyed by UUID so the stub answer handler
        // can pre-connect LiveKit before the RN bundle is alive. Even if RN
        // boots faster than the answer, ExpoCallKitModule will get the same
        // payload via the App Group queue + NotificationCenter event, so
        // there's no race.
        kPendingAnswerPayloadsLock.lock()
        var sp: [String: Any] = ["callId": callId, "hasVideo": hasVideo, "callerName": callerName]
        for (k, v) in dict {
            guard let key = k as? String else { continue }
            if let s = v as? String { sp[key] = s }
            else if let n = v as? NSNumber { sp[key] = n }
        }
        kPendingAnswerPayloads[uuid] = sp
        kPendingAnswerPayloadsLock.unlock()

        let provider = VoipPushAppDelegateSubscriber.earlyProvider ?? makeEphemeralProvider()
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if let error = error {
                print("[VoipSubscriber] reportNewIncomingCall failed: \(error.localizedDescription)")
            } else {
                print("[VoipSubscriber] reportNewIncomingCall succeeded")
            }
            self?.persistPendingCall(
                callId: callId,
                uuid: uuid,
                callerName: callerName,
                hasVideo: hasVideo,
                payload: dict
            )
            NotificationCenter.default.post(
                name: Notification.Name("ExpoCallKitPendingVoipCall"),
                object: nil,
                userInfo: [
                    "callId": callId,
                    "uuid": uuid.uuidString,
                    "callerName": callerName,
                    "hasVideo": hasVideo,
                    "payload": dict
                ]
            )
            completion()
        }
    }

    private func makeEphemeralProvider() -> CXProvider {
        let config = CXProviderConfiguration(localizedName: "Chatyy")
        config.supportsVideo = true
        let p = CXProvider(configuration: config)
        p.setDelegate(self, queue: .main)
        return p
    }

    private func persistPendingCall(callId: String,
                                    uuid: UUID,
                                    callerName: String,
                                    hasVideo: Bool,
                                    payload: [AnyHashable: Any]) {
        guard let ud = UserDefaults(suiteName: kAppGroupId) else { return }
        var safePayload: [String: Any] = [:]
        for (k, v) in payload {
            guard let key = k as? String else { continue }
            if let s = v as? String { safePayload[key] = s }
            else if let n = v as? NSNumber { safePayload[key] = n }
            else if let b = v as? Bool { safePayload[key] = b }
        }
        let entry: [String: Any] = [
            "callId": callId,
            "uuid": uuid.uuidString,
            "callerName": callerName,
            "hasVideo": hasVideo,
            "payload": safePayload,
            "ts": Date().timeIntervalSince1970,
        ]
        var queue = (ud.array(forKey: kPendingCallKey) as? [[String: Any]]) ?? []
        queue.append(entry)
        if queue.count > 5 { queue.removeFirst(queue.count - 5) }
        ud.set(queue, forKey: kPendingCallKey)
    }
}

// MARK: - Stub CXProviderDelegate
//
// These callbacks fire on the rare path where the user accepts/declines on
// the native CallKit UI BEFORE the RN bundle finishes loading. We must
// always call `action.fulfill()` (or `.fail()`) within ~30s or CallKit
// throttles future calls. We persist the answer/end intent through the App
// Group and let the RN module replay it once it observes the pending entry.

extension VoipPushAppDelegateSubscriber: CXProviderDelegate {
    public func providerDidReset(_ provider: CXProvider) {
        print("[VoipSubscriber] providerDidReset (stub)")
        if let ud = UserDefaults(suiteName: kAppGroupId) {
            ud.removeObject(forKey: kPendingCallKey)
        }
    }

    public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        print("[VoipSubscriber] stub CXAnswerCallAction — marking pending accept + native LK pre-connect")
        let uuid = action.callUUID

        // 1. Persist accept intent so ExpoCallKitModule replays once RN is up.
        if let ud = UserDefaults(suiteName: kAppGroupId) {
            ud.set(uuid.uuidString, forKey: "pendingAcceptUUID")
        }

        // 2. Configure AVAudioSession FIRST. CallKit will activate it after
        //    fulfill() returns; setting category/mode early avoids a race
        //    where LiveKit's first audio capture runs before voiceChat mode.
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playAndRecord, mode: .voiceChat,
                options: [.allowBluetoothA2DP, .allowBluetoothHFP]
            )
        } catch {
            print("[VoipSubscriber] setCategory pre-connect failed: \(error)")
        }

        // 3. Grab the payload we stashed when the push arrived. If it's gone
        //    (rare — possibly an app cold-restart between push and answer),
        //    fall back to the App Group pending-call queue.
        kPendingAnswerPayloadsLock.lock()
        var payload = kPendingAnswerPayloads[uuid]
        kPendingAnswerPayloadsLock.unlock()
        if payload == nil, let ud = UserDefaults(suiteName: kAppGroupId),
           let queue = ud.array(forKey: kPendingCallKey) as? [[String: Any]] {
            for entry in queue {
                if (entry["uuid"] as? String) == uuid.uuidString {
                    var merged: [String: Any] = entry
                    if let inner = entry["payload"] as? [String: Any] {
                        for (k, v) in inner { merged[k] = v }
                    }
                    payload = merged
                    break
                }
            }
        }

        // 4. Kick off the LiveKit Room connect in a Task — we MUST NOT block
        //    this CXAnswer callback. fulfill() runs synchronously below.
        if let p = payload {
            Self.startNativeLkConnect(payload: p)
        } else {
            print("[VoipSubscriber] No payload found for \(uuid.uuidString) — skipping native LK pre-connect; JS path will handle.")
        }

        action.fulfill()
    }

    /// Read room_name/identity from the push payload and ask NativeCallRoom
    /// to connect. Token fetch happens inside the Task — total time-to-audio
    /// on a typical 4G network is ~300-600ms.
    static func startNativeLkConnect(payload: [String: Any]) {
        let roomName = (payload["room_name"] as? String)
            ?? (payload["conversation_id"] as? String)
            ?? (payload["callId"] as? String)
            ?? ""
        // identity = our user; prefer explicit identity in payload, else fall
        // back to user_email persisted in App Group at login.
        var identity: String = (payload["identity"] as? String) ?? ""
        if identity.isEmpty,
           let ud = UserDefaults(suiteName: kAppGroupId),
           let email = ud.string(forKey: "user_email") {
            identity = email
        }
        guard !roomName.isEmpty, !identity.isEmpty else {
            print("[VoipSubscriber] LK pre-connect skipped — missing room=\(roomName) identity=\(identity)")
            return
        }
        Task.detached(priority: .userInitiated) {
            do {
                let tok = try await NativeCallTokenFetcher.shared.fetchToken(
                    roomName: roomName,
                    identity: identity,
                    role: "subscriber"
                )
                NativeCallRoom.shared.connect(
                    url: tok.url,
                    token: tok.token,
                    identity: identity,
                    roomName: roomName
                )
            } catch {
                print("[VoipSubscriber] LK token fetch failed: \(error) — JS path will retry")
            }
        }
    }

    public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        print("[VoipSubscriber] stub CXEndCallAction — marking pending end")
        if let ud = UserDefaults(suiteName: kAppGroupId) {
            ud.set(action.callUUID.uuidString, forKey: "pendingEndUUID")
        }
        // [stage 2] Drop the stashed payload + tear the native LK room. Safe
        // to call even if connect never fired — disconnect() is idempotent.
        kPendingAnswerPayloadsLock.lock()
        kPendingAnswerPayloads.removeValue(forKey: action.callUUID)
        kPendingAnswerPayloadsLock.unlock()
        NativeCallRoom.shared.disconnect()

        // Do NOT manually setActive(false) here. CallKit fires didDeactivate
        // automatically after fulfill(); calling setActive ourselves competes
        // with the WebRTC audio engine and races with the module's path.
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        print("[VoipSubscriber] stub timedOutPerforming \(type(of: action))")
        action.fail()
    }

    public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        print("[VoipSubscriber] stub didActivate — enabling RTCAudioSession")
        VoipPushAppDelegateSubscriber.setRTCAudioEnabled(true)
    }

    public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        print("[VoipSubscriber] stub didDeactivate — disabling RTCAudioSession")
        VoipPushAppDelegateSubscriber.setRTCAudioEnabled(false)
    }
}
