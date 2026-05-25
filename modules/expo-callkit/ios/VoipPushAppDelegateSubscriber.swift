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

// [Wave WhatsApp parity, 2026-05-20 gap A1 iOS] Ring-window missed-call
// timers. When a VoIP push arrives we schedule a 30s timer; if the user
// hasn't answered or the peer hasn't cancelled by then, we call
// reportCall(with:endedAt:reason:.unanswered) so iOS records the missed
// call in Recents.app AND keeps the persistent banner on the lock screen
// (this is what WhatsApp does — without it the call disappears silently and
// the user has no recovery path from the lock screen).
private var kRingTimers: [UUID: DispatchSourceTimer] = [:]
private let kRingTimersLock = NSLock()
// [WAVE 161B 2026-05-24] Aligned with Android RINGING_TIMEOUT_MS=45_000 and
// caller-side outgoing 45s. Used to be 30s here, Android 60s, outgoing 45s —
// three independent timers drifting produced tardy "missed call" surfaces.
private let kRingTimeoutSeconds: Int = 45

// [WAVE 163 2026-05-23 GHOST FIX] Outgoing-side timers, parallel to kRingTimers.
// Lives at FILE scope (NOT inside ExpoCallKitModule) so the DispatchSource
// timer survives module/bridge teardown when user swipe-kills the app while
// the dialer is still "Connecting...". Without this, the timer on
// ExpoCallKitModule.stateQueue is freed with the process and CallKit never
// gets reportCall(.failed) → ghost pill stays on lock screen for 30-90s
// until iOS's internal timeout. CXProvider state lives in callservicesd
// (separate process), so the reportCall MUST come from somewhere alive.
private var kOutgoingTimers: [String: DispatchSourceTimer] = [:]
private let kOutgoingTimersLock = NSLock()
private let kOutgoingTimeoutSeconds: Int = 45

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
        // [Wave WhatsApp parity, 2026-05-20 gap A2+H5] Accept .phoneNumber too
        // so CallKit doesn't reject pushes whose handle was upgraded to phone.
        config.supportedHandleTypes = [.generic, .emailAddress, .phoneNumber]
        // [Wave WhatsApp parity, 2026-05-20 gap A2] Logo template — iOS masks
        // the alpha channel and tints with the system call color so it works
        // on both light/dark CallKit chrome. 40×40 is Apple's recommended size
        // for the lock-screen + Recents.app row; larger images get downscaled
        // and look fuzzy. PNG must live in the main bundle as "callkit_icon".
        if let img = UIImage(named: "callkit_icon"),
           let data = img.pngData() {
            config.iconTemplateImageData = data
        }
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
        // [Wave WhatsApp parity, 2026-05-20 gap A2+H5] Phone-number handle gives
        // iOS enough info to render the call on the lock-screen + Recents.app
        // exactly like a PSTN call (with carrier-style number formatting). If
        // the push carries `caller_phone` (E.164), use that; otherwise fall
        // back to the display name on a `.generic` handle below.
        let callerPhone = (dict["caller_phone"] as? String) ?? ""

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
        // [Wave WhatsApp parity, 2026-05-20 gap A2+H5] Prefer .phoneNumber when
        // we have the caller's E.164 — iOS routes through the same handle
        // formatter PSTN uses, so Recents.app entry + lock-screen text matches
        // the user's contact card (auto-resolved against the address book).
        // No phone? Stay on .generic with the display name (no regression).
        if !callerPhone.isEmpty {
            update.remoteHandle = CXHandle(type: .phoneNumber, value: callerPhone)
        } else {
            update.remoteHandle = CXHandle(type: .generic, value: callerName)
        }
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
                // [Wave WhatsApp parity, 2026-05-20 gap A1 iOS] Arm the ring
                // timeout AFTER reportNewIncomingCall succeeds — only then is
                // the UUID known to CallKit. CXAnswer / CXEnd will cancel it
                // (see provider:perform handlers below) so the timer only
                // fires on a genuine no-answer.
                VoipPushAppDelegateSubscriber.scheduleRingTimeout(uuid: uuid, callId: callId, provider: provider)
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
                // [WAVE 104D fix, 2026-05-21] Persist inline push token to App Group
                // so the CXAnswer handler (ExpoCallKitModule.provider:perform:
                // CXAnswerCallAction) finds it in cache and doesn't fire a second
                // NativeCallTokenFetcher.fetchToken() round-trip. Before this fix:
                //   1. Push arrives with lk_token (pre-minted by backend).
                //   2. preconnectRoom fires — Room connects with token A (identity X).
                //   3. User taps Accept — CXAnswer reads lk_token_<callId> from
                //      App Group → missing → falls through to fetchToken() → mints
                //      token B (identity Y, different device-hash window) → presents
                //      CallViewController with token B → LK SFU sees two publishers
                //      for the same user → evicts one → audio gone or stuck "Conectando".
                // Post-fix: token A is in App Group at push-receive time, CXAnswer
                // uses it directly, single Room identity, no SFU eviction.
                if let ud = UserDefaults(suiteName: kAppGroupId) {
                    ud.set(lkTokenInline, forKey: "lk_token_\(callId)")
                    ud.set(lkUrlInline,   forKey: "lk_url_\(callId)")
                    print("[VoipSubscriber] WAVE104D: persisted inline lk_token to App Group for \(callId)")
                }
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
        // [2026-05-25 ROOT-CAUSE FIX] Do NOT bail when the module is bound. The
        // module never presents push calls — callAnswered only emits the
        // onCallAnswered JS event and the JS IncomingCallListener is dead on
        // mobile (WAVE 141). The stub is the sole presenter; CallViewController.
        // present de-dupes by callId so a stray double-call is harmless.
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
        // [2026-05-25 ROOT-CAUSE FIX] Removed the module-bound bail — the module
        // does not present push calls (callAnswered only emits the dead-on-mobile
        // onCallAnswered JS event, WAVE 141). The stub must present. Idempotent:
        // CallViewController.present de-dupes by callId.
        nativeCallDiag("voipstub_present_autoaccept", callId, "hasVideo=\(hasVideo) urlLen=\(lkUrl.count)")
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

    /// [Wave WhatsApp parity, 2026-05-20 gap A1 iOS] Schedule a one-shot
    /// missed-call timer. If `kRingTimeoutSeconds` elapses without the user
    /// answering AND without the peer sending a cancel, we fire
    /// `reportCall(with:endedAt:reason:.unanswered)` so iOS:
    ///   1. Tears down the ring UI cleanly (otherwise it stays stuck for
    ///      Apple's hidden timeout, then logs as `.failed`).
    ///   2. Logs a "Missed call" entry in Recents.app + leaves the persistent
    ///      lock-screen banner the user can tap to call back. This is the
    ///      WhatsApp pattern — without it the call vanishes and the recipient
    ///      has no way to recover the contact from the lock screen.
    /// Timer is a DispatchSourceTimer on a global queue so it survives the
    /// rare case where the main run-loop is starved during cold start.
    fileprivate static func scheduleRingTimeout(uuid: UUID, callId: String, provider: CXProvider) {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + .seconds(kRingTimeoutSeconds))
        timer.setEventHandler {
            // Re-check the timer still belongs to this uuid — defensive
            // against the rare race where cancelRingTimeout fired but the
            // timer already started its event handler.
            kRingTimersLock.lock()
            let stillArmed = (kRingTimers[uuid] != nil)
            kRingTimers.removeValue(forKey: uuid)
            kRingTimersLock.unlock()
            guard stillArmed else { return }
            print("[VoipSubscriber] ring timeout reached for \(callId) — reporting .unanswered")
            // reportCall on the same provider that did reportNewIncomingCall.
            // CallKit auto-dismisses the ring UI and logs the missed call.
            provider.reportCall(with: uuid, endedAt: Date(), reason: .unanswered)
            // Drop the stashed payload too so the answer path won't reactivate
            // the LK pre-connect on a dead UUID.
            kPendingAnswerPayloadsLock.lock()
            kPendingAnswerPayloads.removeValue(forKey: uuid)
            kPendingAnswerPayloadsLock.unlock()
        }
        kRingTimersLock.lock()
        kRingTimers[uuid] = timer
        kRingTimersLock.unlock()
        timer.resume()
    }

    /// Cancel a previously-scheduled missed-call timer. Idempotent.
    fileprivate static func cancelRingTimeout(uuid: UUID) {
        kRingTimersLock.lock()
        let t = kRingTimers.removeValue(forKey: uuid)
        kRingTimersLock.unlock()
        t?.cancel()
    }

    // ─── [WAVE 163 2026-05-23 GHOST FIX] Outgoing-side timer (caller side)
    //
    // Mirrors scheduleRingTimeout but keyed by callId (the outgoing path
    // doesn't have a single canonical UUID at scheduling time — JS owns the
    // callId, ExpoCallKitModule owns the UUID, and we want the timer
    // independent of either to survive process kill).
    //
    // Why static/file-scope: when user swipe-kills the app during "Connecting…",
    // the iOS process dies. CXProvider state lives in callservicesd (separate
    // process) and KEEPS the call alive showing the pill on the lock screen
    // until something explicitly calls reportCall(.failed). The previous
    // DispatchSource on ExpoCallKitModule.stateQueue died with the process,
    // leaving the ghost. This timer lives on a global queue and the closure
    // captures only ExpoCallKitModule.sharedProvider (weak class-static), so
    // it survives bridge teardown.
    public static func scheduleOutgoingTimeout(callId: String, uuid: UUID) {
        cancelOutgoingTimeout(callId: callId) // idempotent re-arm
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + .seconds(kOutgoingTimeoutSeconds))
        timer.setEventHandler {
            kOutgoingTimersLock.lock()
            let stillArmed = (kOutgoingTimers[callId] != nil)
            kOutgoingTimers.removeValue(forKey: callId)
            kOutgoingTimersLock.unlock()
            guard stillArmed else { return }
            NSLog("[VoipSubscriber][WAVE163] outgoing timeout 45s for \(callId) — reportCall(.unanswered)")
            if let provider = ExpoCallKitModule.sharedProvider {
                provider.reportCall(with: uuid, endedAt: Date(), reason: .unanswered)
            }
        }
        kOutgoingTimersLock.lock()
        kOutgoingTimers[callId] = timer
        kOutgoingTimersLock.unlock()
        timer.resume()
    }

    public static func cancelOutgoingTimeout(callId: String) {
        kOutgoingTimersLock.lock()
        let t = kOutgoingTimers.removeValue(forKey: callId)
        kOutgoingTimersLock.unlock()
        t?.cancel()
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
        nativeCallDiag("voipstub_cxanswer_entry", action.callUUID.uuidString,
                       "isEarly=\(provider === Self.earlyProvider) moduleBound=\(ExpoCallKitModule.hasBoundProviderDelegate())")
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
            nativeCallDiag("voipstub_bail_nonearly", action.callUUID.uuidString)
            action.fulfill()
            return
        }
        if ExpoCallKitModule.hasBoundProviderDelegate() {
            // [2026-05-25 ROOT-CAUSE FIX] Previously bailed here (fulfill+return)
            // trusting the module to present. But the VoIP-push call is owned by
            // `earlyProvider` (this delegate), NOT the module's CXProvider — so
            // the module's CXProviderDelegate NEVER receives this CXAnswer. The
            // only module-side handling is the pendingAcceptUUID replay →
            // callAnswered, which ONLY emits the onCallAnswered JS event. And the
            // JS IncomingCallListener is DEAD on mobile (WAVE 141) → NOBODY
            // presented the native call UI → "atendo e não abre nada" on EVERY
            // warm-app answer (cold-start happened to work because the module
            // wasn't bound yet so the stub presented). Fix: the stub presents
            // unconditionally. No double-present: callAnswered does not present,
            // and CallViewController.present de-dupes by callId.
            nativeCallDiag("voipstub_modulebound_present_anyway", action.callUUID.uuidString)
        }
        nativeCallDiag("voipstub_cxanswer_handling", action.callUUID.uuidString, "stub will present")
        print("[VoipSubscriber] stub CXAnswerCallAction — marking pending accept + native LK pre-connect")
        let uuid = action.callUUID
        // [Wave WhatsApp parity, 2026-05-20 gap A1 iOS] User answered — kill
        // the missed-call timer so we don't fire .unanswered against a UUID
        // that's actively connecting.
        VoipPushAppDelegateSubscriber.cancelRingTimeout(uuid: uuid)

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
    ///
    /// [WAVE 92 2026-05-21] Bug 1 root cause: pre-WAVE92 the lookup order was
    /// room_name → conversation_id → callId. WAVE 74 fixed chat.php so the
    /// backend mints `lk_token` for room=callId, but this Swift path STILL
    /// preferred `conversation_id` as room name — meaning the callee's native
    /// pre-connect joined `conv_47` while caller joined the callId-named room.
    /// Result: 25s tFailed timer surfaced "Não foi possível conectar." Now we
    /// prioritize `lk_room` (server-authoritative) → `call_id` → `callId` →
    /// `room_name`, with `conversation_id` strictly as last resort.
    static func startNativeLkConnect(payload: [String: Any]) {
        let roomName = (payload["lk_room"] as? String)
            ?? (payload["call_id"] as? String)
            ?? (payload["callId"] as? String)
            ?? (payload["room_name"] as? String)
            ?? (payload["conversation_id"] as? String)
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
        // [WAVE 104D fix, 2026-05-21] Short-circuit: if the push carried an
        // inline lk_token (already persisted to App Group in the push-receive
        // path above), use it directly instead of fetching a NEW token with a
        // different identity hash. Minting a second token here would cause the
        // SFU to see two publisher identities for the same callee → evict one
        // → "Conectando" stuck on callee screen.
        let inlineToken = (payload["lk_token"] as? String) ?? ""
        let inlineUrl   = (payload["lk_url"]   as? String) ?? ""
        if !inlineToken.isEmpty && !inlineUrl.isEmpty {
            NativeCallRoom.shared.connect(
                url: inlineUrl,
                token: inlineToken,
                identity: identity,
                roomName: roomName
            )
            return
        }
        // Also check App Group cache (populated by WAVE104D persist block above
        // or by JS persistPendingLkToken).
        if let ud = UserDefaults(suiteName: kAppGroupId),
           let cachedTok = ud.string(forKey: "lk_token_\(roomName)"), !cachedTok.isEmpty,
           let cachedUrl = ud.string(forKey: "lk_url_\(roomName)"), !cachedUrl.isEmpty {
            NativeCallRoom.shared.connect(
                url: cachedUrl,
                token: cachedTok,
                identity: identity,
                roomName: roomName
            )
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
        // [Wave WhatsApp parity, 2026-05-20 gap A1 iOS] User declined or peer
        // hung up first — cancel the ring timer so we don't fire .unanswered
        // on top of an already-ended call.
        VoipPushAppDelegateSubscriber.cancelRingTimeout(uuid: action.callUUID)
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
        print("[VoipSubscriber] stub didActivate — configuring route + enabling RTCAudioSession")
        // [2026-05-25 speaker-only ROOT CAUSE] The push-answer path runs THIS
        // didActivate (earlyProvider owns the call), not ExpoCallKitModule's.
        // Previously it only enabled the WebRTC VPIO unit and never configured
        // the AVAudioSession route — so the ONLY configureForCall was in
        // CallViewController.viewDidLoad, which runs AFTER the VPIO unit started
        // → its setCategory breaks the earpiece route and audio gets stuck on
        // the loudspeaker ("só funciona no viva voz"). Fix: configure the
        // category + route HERE first (AudioRouter guards setCategory to run
        // once), THEN start VPIO. viewDidLoad's later call only re-applies the
        // port override, never setCategory-after-VPIO.
        AudioRouter.shared.configureForCall(hasVideo: AudioRouter.shared.hasVideo)
        VoipPushAppDelegateSubscriber.setRTCAudioEnabled(true)
        let route = audioSession.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ",")
        nativeCallDiag("voipstub_didactivate", "-", "route=\(route) hasVideo=\(AudioRouter.shared.hasVideo)")
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
