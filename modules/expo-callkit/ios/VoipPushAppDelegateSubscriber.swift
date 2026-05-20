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

        // [native call screen day-3 finale, 2026-05-16] OPT-IN cold-start
        // auto-accept. If the server marks the push with `auto_accept=1`
        // (e.g. a callback-style auto-pickup flow), skip the CallKit UI
        // entirely and jump straight to CallViewController. The
        // reportNewIncomingCall flow is still REQUIRED by Apple for every
        // VoIP push so we report-and-immediately-end-as-answered below.
        //
        // TODO(future): wire backend to emit `auto_accept` on TestCalls /
        // server-driven pickup. Today no push carries the flag — this branch
        // is dormant in production.
        let autoAccept = ((dict["auto_accept"] as? String) == "1")
            || ((dict["auto_accept"] as? Bool) == true)
            || ((dict["auto_accept"] as? NSNumber)?.boolValue == true)

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

        // [#1114 avatar handoff, 2026-05-19] Side-channel the caller's avatar
        // URL into App Group UserDefaults under `callAvatar:<callId>`. CallView
        // already reads this key in .onAppear — the outgoing path
        // (ExpoCallKitModule.startOutgoingCall) populates it, but the answer
        // path used to leave it empty and fall back to the initials letter
        // (e.g. "S" for a Suporte call). Backend now ships `caller_avatar` in
        // the VoIP push payload via chatCallerAvatarUrl().
        if let avatarUrl = (dict["caller_avatar"] as? String), !avatarUrl.isEmpty,
           let ud = UserDefaults(suiteName: kAppGroupId) {
            ud.set(avatarUrl, forKey: "callAvatar:\(callId)")
        }

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

            // [STAGE-A 2026-05-20] GAP #2 — Kick Room.connect during the ring
            // window, BEFORE the user taps Accept. Audio is hot the instant
            // they answer (WhatsApp parity). The push may carry an inline
            // `lk_token`+`lk_url` (server-side fast-path) OR JS may have
            // persisted them ahead of time via `persistPendingLkToken`. Try
            // inline first, then App Group cache, then async token fetch.
            let lkTokenInline = (dict["lk_token"] as? String) ?? ""
            let lkUrlInline   = (dict["lk_url"]   as? String) ?? ""
            if !lkTokenInline.isEmpty && !lkUrlInline.isEmpty {
                Task.detached(priority: .userInitiated) {
                    CallViewController.preconnectRoom(url: lkUrlInline, token: lkTokenInline, callId: callId)
                }
            } else if let ud = UserDefaults(suiteName: kAppGroupId),
                      let cachedTok = ud.string(forKey: "lk_token_\(callId)"), !cachedTok.isEmpty,
                      let cachedUrl = ud.string(forKey: "lk_url_\(callId)"), !cachedUrl.isEmpty {
                Task.detached(priority: .userInitiated) {
                    CallViewController.preconnectRoom(url: cachedUrl, token: cachedTok, callId: callId)
                }
            } else {
                // No inline / cached token — fetch then preconnect. This still
                // races the ring timer but typically resolves in 300-600ms.
                let identityForFetch: String = {
                    if let s = dict["identity"] as? String, !s.isEmpty { return s }
                    if let ud = UserDefaults(suiteName: kAppGroupId),
                       let e = ud.string(forKey: "user_email"), !e.isEmpty { return e }
                    return callId
                }()
                Task.detached(priority: .userInitiated) {
                    do {
                        let tok = try await NativeCallTokenFetcher.shared.fetchToken(
                            roomName: callId,
                            identity: identityForFetch,
                            role: "publisher"
                        )
                        CallViewController.preconnectRoom(url: tok.url, token: tok.token, callId: callId)
                    } catch {
                        print("[VoipSubscriber] STAGE-A preconnect token fetch failed: \(error)")
                    }
                }
            }

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

            // [native call screen day-3 finale, 2026-05-16] If the server flag
            // `auto_accept` was set, skip the CallKit ring UI and jump
            // straight into CallViewController on the cold-start path. We
            // must still call reportNewIncomingCall (above) to satisfy Apple's
            // PushKit contract, then immediately report the call as answered
            // and synthesise the connect by presenting the native VC.
            if autoAccept {
                print("[VoipSubscriber] auto_accept=1 — programmatically answering + presenting CallViewController")
                // Programmatically answer the just-reported incoming call so
                // CallKit clears its ring UI. This is the canonical
                // server-driven auto-pickup flow: PushKit requires we report
                // every VoIP push, but we can immediately request an answer
                // transaction on behalf of the user. CallKit will then route
                // through provider:perform CXAnswerCallAction (this same
                // delegate), which kicks startNativeLkConnect; we ALSO
                // present CallViewController explicitly here so the UI swap
                // happens with no JS round-trip.
                let controller = CXCallController(queue: .main)
                let answer = CXAnswerCallAction(call: uuid)
                controller.request(CXTransaction(action: answer)) { err in
                    if let e = err {
                        print("[VoipSubscriber] auto_accept answer request failed: \(e)")
                    }
                }
                let callerEmail = (dict["caller_email"] as? String) ?? ""
                VoipPushAppDelegateSubscriber.startAutoAcceptNativeCall(
                    callId: callId,
                    callerName: callerName,
                    callerEmail: callerEmail,
                    hasVideo: hasVideo,
                    payload: dict
                )
            }
            completion()
        }
    }

    /// Cold-start auto-accept entry point. Reads the same App Group inputs
    /// the regular CXAnswerCallAction path uses, fetches a LiveKit token
    /// (via NativeCallTokenFetcher), then presents CallViewController on
    /// the main thread.
    fileprivate static func startAutoAcceptNativeCall(callId: String,
                                                       callerName: String,
                                                       callerEmail: String,
                                                       hasVideo: Bool,
                                                       payload: [AnyHashable: Any]) {
        // [STAGE-A 2026-05-20] GAP #3 — Bail if the module's ProviderDelegate
        // is already live; the module owns presentation in that case and a
        // stub-side present would double-mount CallViewController.
        if ExpoCallKitModule.hasBoundProviderDelegate() {
            print("[VoipSubscriber] STAGE-A startAutoAcceptNativeCall: module owns provider — bailing")
            return
        }
        // Cached LK token short-circuit (server may have published one via
        // the existing `persistPendingLkToken` JS function before the push).
        if let ud = UserDefaults(suiteName: kAppGroupId),
           let cachedToken = ud.string(forKey: "lk_token_\(callId)"), !cachedToken.isEmpty,
           let cachedUrl = ud.string(forKey: "lk_url_\(callId)"), !cachedUrl.isEmpty {
            DispatchQueue.main.async {
                presentAutoAcceptVC(callId: callId,
                                    callerName: callerName,
                                    callerEmail: callerEmail,
                                    hasVideo: hasVideo,
                                    lkUrl: cachedUrl,
                                    lkToken: cachedToken)
            }
            return
        }
        let identity: String = {
            if let s = payload["identity"] as? String, !s.isEmpty { return s }
            if let ud = UserDefaults(suiteName: kAppGroupId),
               let e = ud.string(forKey: "user_email"), !e.isEmpty { return e }
            return callId
        }()
        Task.detached(priority: .userInitiated) {
            do {
                let result = try await NativeCallTokenFetcher.shared.fetchToken(
                    roomName: callId,
                    identity: identity,
                    role: "publisher"
                )
                await MainActor.run {
                    presentAutoAcceptVC(callId: callId,
                                        callerName: callerName,
                                        callerEmail: callerEmail,
                                        hasVideo: hasVideo,
                                        lkUrl: result.url,
                                        lkToken: result.token)
                }
            } catch {
                print("[VoipSubscriber] auto-accept LK token fetch failed: \(error)")
            }
        }
    }

    fileprivate static func presentAutoAcceptVC(callId: String,
                                                 callerName: String,
                                                 callerEmail: String,
                                                 hasVideo: Bool,
                                                 lkUrl: String,
                                                 lkToken: String) {
        // [STAGE-A 2026-05-20] GAP #3 — Last-line defense: if the module is
        // bound between the async hop and present, abort cleanly.
        if ExpoCallKitModule.hasBoundProviderDelegate() {
            print("[VoipSubscriber] STAGE-A presentAutoAcceptVC: module owns provider — bailing")
            return
        }
        // [#1172 fix, 2026-05-18] Robust window/VC resolver — falls back
        // across scene activation states and presented VCs so a cold-start
        // VoIP push auto-accept actually surfaces CallViewController instead
        // of silently bailing on a nil keyWindow.
        // [#1192 cold-start fix, 2026-05-19] On a true cold start the
        // AppDelegate has called `factory.startReactNative(...)` but
        // `window.rootViewController` is still nil until the RN bridge
        // attaches it (~1-3s after didFinishLaunching). Without retry,
        // `robustPresentingViewController()` returns nil, the print warns
        // "deferring" but there is no actual handler — the native call
        // screen never appears. Retry on the main run-loop until rootVC
        // attaches, up to ~3s.
        let presentBlock: (UIViewController) -> Void = { root in
            CallViewController.present(
                from: root,
                callId: callId,
                callerName: callerName,
                callerEmail: callerEmail,
                hasVideo: hasVideo,
                lkUrl: lkUrl,
                lkToken: lkToken
            )
        }
        if let root = robustPresentingViewController() {
            presentBlock(root)
            return
        }
        print("[VoipSubscriber] auto-accept: no presenting VC yet (cold-start) — retrying up to ~3s")
        retryRobustPresent(reason: "autoAccept:\(callId)", block: presentBlock)
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
        // [STAGE-A 2026-05-20] GAP #3 — Gate against dual-present race. Once
        // the real ExpoCallKitModule.ProviderDelegate is bound (RN bundle
        // booted), the module owns CXAnswer handling end-to-end. The stub
        // should only fire when the cold-start path is still active — i.e.
        // when *this* delegate is the earlyProvider. If the provider passed
        // to us is anything else, or the module's delegate is already wired,
        // immediately fulfill and bail to avoid double-presenting the
        // CallViewController.
        guard provider === Self.earlyProvider else {
            print("[VoipSubscriber] STAGE-A: CXAnswer on non-early provider — module owns it; stub fulfilling and bailing")
            action.fulfill()
            return
        }
        if ExpoCallKitModule.hasBoundProviderDelegate() {
            print("[VoipSubscriber] STAGE-A: ExpoCallKitModule has ProviderDelegate bound — stub fulfilling and bailing")
            action.fulfill()
            return
        }
        print("[VoipSubscriber] stub CXAnswerCallAction — marking pending accept + native LK pre-connect")
        let uuid = action.callUUID

        // 1. Persist accept intent so ExpoCallKitModule replays once RN is up.
        if let ud = UserDefaults(suiteName: kAppGroupId) {
            ud.set(uuid.uuidString, forKey: "pendingAcceptUUID")
        }

        // [STAGE-A 2026-05-20] GAP #4 — AVAudioSession config DELETED from
        // here. AudioRouter.configureForCall (invoked from
        // provider:didActivate audioSession:) is the single owner of
        // setCategory/setMode. Calling it before didActivate races with
        // CallKit's own session ownership and clobbers options set later.

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

        // [native call screen day-3 finale, 2026-05-16] In addition to the
        // legacy NativeCallRoom pre-connect above (which still feeds the JS
        // adopt-room path), also present CallViewController directly so the
        // user lands on the native fullscreen the moment they accept — even
        // when RN bundle has not yet finished parsing. The stub CXAnswer
        // delegate fires before the live ExpoCallKitModule.ProviderDelegate
        // is wired, so we replicate the same present logic here.
        if let p = payload {
            let callId = (p["callId"] as? String)
                ?? (p["call_id"] as? String)
                ?? (p["room_name"] as? String)
                ?? (p["conversation_id"] as? String)
                ?? uuid.uuidString
            let callerName = (p["callerName"] as? String)
                ?? (p["caller_name"] as? String)
                ?? "Chatyy"
            let callerEmail = (p["caller_email"] as? String) ?? ""
            let hasVideo: Bool = {
                if let v = p["hasVideo"] as? Bool { return v }
                if let v = p["video"] as? String { return v == "1" }
                if let t = p["call_type"] as? String { return t == "video" }
                return false
            }()
            Self.startAutoAcceptNativeCall(
                callId: callId,
                callerName: callerName,
                callerEmail: callerEmail,
                hasVideo: hasVideo,
                payload: p
            )
        }
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

// MARK: - Robust window resolver
//
// [#1172 native-call-in-background fix, 2026-05-18] See full docstring in
// ExpoCallKitModule.swift's `resolvePresentingViewController`. Duplicated
// here so the AppDelegate-tier code (cold-start, no JS bundle yet) doesn't
// need to cross-import the module file.
// NOT @MainActor-annotated: callers (DispatchQueue.main.async, MainActor.run,
// PushKit delegate-on-main) are already main-thread. See sibling helper in
// ExpoCallKitModule.swift for the full rationale.
fileprivate func robustPresentingViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes

    func windowFrom(_ scene: UIWindowScene) -> UIWindow? {
        if let key = scene.windows.first(where: { $0.isKeyWindow }) { return key }
        return scene.windows.first { !$0.isHidden }
    }

    if let active = scenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
       let win = windowFrom(active),
       let vc = win.rootViewController {
        return vc
    }
    if let inactive = scenes.first(where: { $0.activationState == .foregroundInactive }) as? UIWindowScene,
       let win = windowFrom(inactive),
       let vc = win.rootViewController {
        return vc
    }
    for s in scenes {
        if let ws = s as? UIWindowScene,
           let win = windowFrom(ws),
           let vc = win.rootViewController {
            return vc
        }
    }
    if let appWin = (UIApplication.shared.delegate as? UIResponder)?.value(forKey: "window") as? UIWindow,
       let vc = appWin.rootViewController {
        return vc
    }
    return nil
}

// [#1192 cold-start native call fix, 2026-05-19] Mirror of
// ExpoCallKitModule.retryPresent for the AppDelegate-tier stub path.
// Lives here so the auto-accept presentation can poll for the RN
// rootViewController to attach during a true cold-start.
//
// Cold-start path: VoIP push arrives → didFinishLaunchingWithOptions
// installs the registry+provider and starts the RN factory, but
// `window.rootViewController` is nil until the RN bridge boots
// (~1-3s). If the user immediately taps Accept on the CallKit
// ring sheet, CXAnswer fires while rootVC is still nil — the
// original code printed "deferring" and returned, leaving the
// user with no call UI at all (warm path works because rootVC
// is already set).
//
// We retry up to ~3s on the main run-loop. Each tick re-resolves
// via `robustPresentingViewController()`; the first non-nil result
// fires the present block.
fileprivate func retryRobustPresent(reason: String,
                                     attempts: Int = 30,
                                     interval: TimeInterval = 0.1,
                                     block: @escaping (UIViewController) -> Void) {
    func tick(_ remaining: Int) {
        if let vc = robustPresentingViewController() {
            print("[VoipSubscriber] retryRobustPresent(\(reason)): resolved on attempt \(attempts - remaining + 1)")
            block(vc)
            return
        }
        if remaining <= 0 {
            print("[VoipSubscriber] retryRobustPresent(\(reason)): exhausted \(attempts) attempts, giving up")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + interval) {
            tick(remaining - 1)
        }
    }
    tick(attempts)
}
