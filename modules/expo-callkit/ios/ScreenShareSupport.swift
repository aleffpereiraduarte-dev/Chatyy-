//
//  ScreenShareSupport.swift
//  ExpoCallKit
//
//  [2026-10-06 screen-share iOS] Single source of truth for "compartilhar
//  tela" on the native call surfaces (CallViewController 1:1,
//  GroupCallViewController, and the JS bridge in ExpoCallKitModule).
//
//  WHY THIS EXISTS — what was broken:
//    * The native call screens called `set(source: .screenShareVideo,
//      enabled:)` with the SDK DEFAULT ScreenShareCaptureOptions, i.e.
//      `useBroadcastExtension == false`. On iOS that is LiveKit's in-app
//      `InAppScreenCapturer` (RPScreenRecorder.startCapture) — it can only
//      capture THIS app's own window. During a call that window IS the call
//      screen, so the peer saw… the call screen. Leaving the app paused the
//      capture. From the founder's point of view: "não funciona".
//    * The system-wide path (ReplayKit Broadcast Upload Extension) existed
//      as `plugins/with-broadcast-extension.js` but was NOT registered in
//      app.json since Wave 19 (build failure that has since been fixed in the
//      plugin's Podfile snippet), so no `ChatyyBroadcastExtension.appex` was
//      ever in the bundle and no `RTCScreenSharingExtension` /
//      `RTCAppGroupIdentifier` keys were in Info.plist.
//
//  HOW IT WORKS NOW:
//    * `useBroadcastExtension` is TRUE only when the host Info.plist carries
//      `RTCScreenSharingExtension` AND the matching .appex is physically
//      present in the bundle's PlugIns/ folder. LiveKit's
//      `BroadcastScreenCapturer` reads BOTH `RTCAppGroupIdentifier` and
//      `RTCScreenSharingExtension` from Info.plist (same keys as
//      react-native-webrtc), presents the system `RPSystemBroadcastPickerView`
//      pre-targeted at our extension, and pumps frames from the extension
//      (SampleHandler: LKSampleHandler) over the App Group socket into the
//      Room's screen-share track.
//    * When the extension is absent (builds made before the provisioning
//      profile for com.onemundo.mail.broadcast exists), we fall back to the
//      in-app capturer so the button still DOES something, and the UI says
//      "tela do app" so the limitation is explicit.
//
//  API NOTES (LiveKit Swift 2.x — same surface the rest of the module uses):
//    * `RoomOptions(defaultScreenShareCaptureOptions:)` — verified signature
//      in CallViewController (LK Swift 2.5+). We hand `captureOptions()` to
//      BOTH native rooms so `set(source: .screenShareVideo, enabled:)` keeps
//      compiling exactly as before while picking up the broadcast path.
//    * `Participant.videoTracks: [TrackPublication]` + `publication.source`.
//

import Foundation
import LiveKitClient
import ReplayKit
import UIKit

enum ScreenShareSupport {

    /// App Group shared by the main app, ShareExtension and the broadcast
    /// extension. Mirrors `APP_GROUP` in plugins/with-broadcast-extension.js.
    static let appGroupId = "group.com.onemundo.mail"

    /// Bundle id of the ReplayKit upload extension as declared in the host
    /// Info.plist (`RTCScreenSharingExtension`, written by the config plugin).
    /// nil when the plugin was gated off for this build.
    static let extensionBundleId: String? = {
        let v = Bundle.main.object(forInfoDictionaryKey: "RTCScreenSharingExtension") as? String
        return (v?.isEmpty == false) ? v : nil
    }()

    /// True when a `*.appex` whose CFBundleIdentifier == `extensionBundleId`
    /// is physically inside the app bundle. Protects against a stale
    /// Info.plist key pointing at an extension that was not embedded — the
    /// system picker would then show an empty list and LiveKit would wait
    /// forever for a socket connection.
    static let isBroadcastExtensionBundled: Bool = {
        guard let wanted = extensionBundleId,
              let plugins = Bundle.main.builtInPlugInsURL,
              let items = try? FileManager.default.contentsOfDirectory(at: plugins,
                                                                       includingPropertiesForKeys: nil,
                                                                       options: [.skipsHiddenFiles]) else {
            return false
        }
        for url in items where url.pathExtension == "appex" {
            if let b = Bundle(url: url), b.bundleIdentifier == wanted {
                return true
            }
        }
        return false
    }()

    /// System-wide (ReplayKit broadcast extension) screen share available?
    static var useBroadcastExtension: Bool {
        return extensionBundleId != nil && isBroadcastExtensionBundled
    }

    /// Capture options every native Room should install as
    /// `defaultScreenShareCaptureOptions`. Broadcast when available, in-app
    /// capture (app's own window only) otherwise.
    static func captureOptions() -> ScreenShareCaptureOptions {
        // [video-quality 2026-10-06] 1080p @ 15 fps for the in-app capturer
        // (text stays legible; 15 fps is plenty for slides/docs). The
        // broadcast extension sizes frames itself — these are a no-op there.
        return ScreenShareCaptureOptions(
            dimensions: CallViewController.CallVideoQuality.screenShareDimensions,
            fps: 15,
            useBroadcastExtension: useBroadcastExtension
        )
    }

    /// Human-readable description for the UI chip / logs.
    static var modeLabel: String {
        // [2026-10-14] localized (CallStrings, 11 idiomas) for the system-wide path.
        return useBroadcastExtension ? CallStrings.s("sharingScreen") : "Compartilhando tela do app"
    }

    /// True when the local participant currently has a screen-share video
    /// publication in `room`. This is the TRUTH for the toggle state — with
    /// the broadcast extension the publication appears only after the user
    /// confirms "Iniciar Transmissão" in the system sheet, and disappears
    /// when they stop it from the red status pill.
    static func isSharing(room: Room) -> Bool {
        return room.localParticipant.videoTracks.contains { $0.source == .screenShareVideo }
    }

    /// Toggle the local screen-share publication.
    ///
    /// [2026-10-15 screen-share whatsapp-level] Broadcast path no longer goes
    /// through `set(source: .screenShareVideo, enabled: true)`: LK Swift
    /// 2.0.18 shows the picker AND publishes a frame-less track immediately
    /// (the peer saw a black tile and our chip said "sharing" while the user
    /// was still looking at the system sheet). Now:
    ///   1. tap → `RPSystemBroadcastPickerView` pre-targeted at our extension
    ///      (preferredExtension, no mic button, internal button "pressed"
    ///      programmatically — same helper LiveKit/WhatsApp/Zoom use);
    ///   2. the user confirms → system 3-2-1 → extension posts
    ///      iOS_BroadcastStarted → we publish the BroadcastScreenCapturer track
    ///      (`didPublishTrack` flips the UI on every surface);
    ///   3. cancelled / never confirmed → nothing was published; the pending
    ///      request expires after `pendingTimeout`.
    /// A broadcast started from Control Center while a call is active is
    /// attached to the active room the same way (WhatsApp parity).
    /// In-app capture (no extension in this build) keeps the old SDK call.
    ///
    /// Callers drive UI from `RoomDelegate didPublishTrack/didUnpublishTrack`.
    static func set(room: Room, enabled: Bool, callId: String = "") async throws {
        if !enabled {
            cancelPending(reason: "stop")
            // Tell the extension it is an intentional stop → it ends the
            // system broadcast (red pill) at once instead of waiting out its
            // reconnect grace.
            if isSharing(room: room) { postHostStop() }
            _ = try await room.localParticipant.set(source: .screenShareVideo, enabled: false)
            return
        }
        // [e2ee5 WP-13 2026-10-22] Ligação cifrada num Room sem E2EE → não compartilha a tela (lança).
        _ = try CallE2EE.gated(room, callId, "screen_set")
        if useBroadcastExtension {
            await MainActor.run {
                armPending(room: room, callId: callId)
                RPSystemBroadcastPickerView.show(for: extensionBundleId, showsMicrophoneButton: false)
            }
            nativeCallDiag("screen_share_picker_shown", callId)
            return
        }
        // In-app capture (app window only) — publishes immediately.
        _ = try await room.localParticipant.set(
            source: .screenShareVideo,
            enabled: true,
            captureOptions: nil,
            publishOptions: CallViewController.screenSharePublishOptions()
        )
    }

    // MARK: - [2026-10-15] Active room + pending start (main thread)

    /// Posted (main thread) when a pending start ends WITHOUT a publication
    /// (picker dismissed / timeout / publish failed). userInfo["failed"]=Bool.
    static let pendingEndedNotification = Notification.Name("ChatyyScreenSharePendingEnded")

    /// How long a tap on "Compartilhar tela" waits for the user to confirm
    /// the system sheet (countdown included).
    static let pendingTimeout: TimeInterval = 60

    private static weak var activeRoom: Room?
    private static var activeCallId: String = ""
    private static weak var pendingRoom: Room?
    private static var pendingCallId: String = ""
    private static var pendingToken: Int = 0
    private static var publishing = false

    /// The native call surfaces register their connected Room so a broadcast
    /// started from Control Center (or a late "started") finds it.
    static func registerActive(room: Room, callId: String) {
        DispatchQueue.main.async {
            activeRoom = room
            activeCallId = callId
            _ = darwinObserversInstalled
        }
    }

    /// Call teardown (hang-up / VC deinit): end the system broadcast now and
    /// forget the room. The track itself dies with the Room disconnect; the
    /// peer gets the unpublish / participant-left from the SFU.
    static func callEnding(room: Room?, callId: String) {
        let sharing = room.map { isSharing(room: $0) } ?? false
        if sharing { nativeCallDiag("screen_share_stop_call_end", callId) }
        postHostStop()
        DispatchQueue.main.async {
            if room == nil || activeRoom === room { activeRoom = nil; activeCallId = "" }
            if room == nil || pendingRoom === room { cancelPending(reason: "call_end") }
        }
        if let r = room, sharing {
            Task { _ = try? await r.localParticipant.set(source: .screenShareVideo, enabled: false) }
        }
    }

    @MainActor
    private static func armPending(room: Room, callId: String) {
        _ = darwinObserversInstalled
        pendingRoom = room
        pendingCallId = callId
        activeRoom = room
        activeCallId = callId
        pendingToken &+= 1
        let token = pendingToken
        DispatchQueue.main.asyncAfter(deadline: .now() + pendingTimeout) {
            guard pendingToken == token, pendingRoom != nil else { return }
            nativeCallDiag("screen_share_never_started", pendingCallId)
            cancelPending(reason: "timeout")
        }
    }

    private static func cancelPending(reason: String) {
        let work = {
            guard pendingRoom != nil else { return }
            pendingRoom = nil
            pendingToken &+= 1
            NotificationCenter.default.post(name: pendingEndedNotification, object: nil,
                                            userInfo: ["failed": false, "reason": reason])
        }
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }

    /// Extension said "started" (main thread).
    private static func handleBroadcastStarted() {
        // Warm/adopted rooms may never fire roomDidConnect on the VC → also
        // fall back to the native call Room singleton.
        let room = pendingRoom ?? activeRoom ?? NativeCallRoom.shared.currentRoom()
        let callId = pendingRoom != nil ? pendingCallId : activeCallId
        let fromPicker = pendingRoom != nil
        pendingRoom = nil
        pendingToken &+= 1
        guard let r = room else {
            // No call: the extension's connect timeout ends the broadcast
            // with "Abra uma chamada no Chatyy…".
            nativeCallDiag("screen_share_started_no_call", "")
            return
        }
        guard r.connectionState == .connected else {
            nativeCallDiag("screen_share_started_room_not_connected", callId)
            postHostStop()
            return
        }
        guard !publishing, !isSharing(room: r) else { return }
        publishing = true
        nativeCallDiag("screen_share_broadcast_started", callId, fromPicker ? "picker" : "control_center")
        let startedAt = CACurrentMediaTime()
        Task {
            do {
                let track = LocalVideoTrack.createBroadcastScreenCapturerTrack(options: captureOptions())
                _ = try await CallE2EE.gated(r, callId, "screen_broadcast").publish(videoTrack: track,
                                                         options: CallViewController.screenSharePublishOptions())
                let ms = Int((CACurrentMediaTime() - startedAt) * 1000)
                nativeCallDiag("screen_share_publish_ok", callId, "ms=\(ms)")
            } catch {
                nativeCallDiag("screen_share_error", callId, "publish:" + String("\(error)".prefix(140)))
                postHostStop()
                await MainActor.run {
                    NotificationCenter.default.post(name: pendingEndedNotification, object: nil,
                                                    userInfo: ["failed": true, "reason": "publish"])
                }
            }
            await MainActor.run { publishing = false }
        }
    }

    /// Extension said "stopped" (main thread) — red pill / Control Center /
    /// iOS ended it. Unpublish (UI resets via didUnpublishTrack).
    private static func handleBroadcastStoppedGlobal() {
        cancelPending(reason: "ext_stopped")
        guard let r = activeRoom ?? NativeCallRoom.shared.currentRoom(), isSharing(room: r) else { return }
        nativeCallDiag("screen_share_stopped_by_system", activeCallId)
        Task { _ = try? await r.localParticipant.set(source: .screenShareVideo, enabled: false) }
    }

    private static let darwinAnchor = NSObject()
    private static let darwinObserversInstalled: Bool = {
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let anchor = Unmanaged.passUnretained(darwinAnchor).toOpaque()
        CFNotificationCenterAddObserver(center, anchor, { (_, _, _, _, _) in
            DispatchQueue.main.async { ScreenShareSupport.handleBroadcastStarted() }
        }, broadcastStartedName as CFString, nil, .deliverImmediately)
        CFNotificationCenterAddObserver(center, anchor, { (_, _, _, _, _) in
            DispatchQueue.main.async { ScreenShareSupport.handleBroadcastStoppedGlobal() }
        }, broadcastStoppedName as CFString, nil, .deliverImmediately)
        return true
    }()

    /// Host → extension: intentional stop (app button / hang-up).
    static let hostStopName = "com.chatyy.screenshare.hoststop"
    static func postHostStop() {
        guard useBroadcastExtension else { return }
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
                                             CFNotificationName(rawValue: hostStopName as CFString),
                                             nil, nil, true)
    }

    // MARK: - [2026-10-15] First-use privacy notice

    private static let privacyNoticeKey = "chatyy_screenshare_privacy_ack_v1"

    /// WhatsApp-style one-time warning before the first share. `proceed`
    /// runs on main after "Continuar" (or immediately when already
    /// acknowledged). The picker is presented ~0.35 s after the alert
    /// dismisses — UIKit refuses a presentation during a dismissal.
    static func confirmFirstUse(from vc: UIViewController, proceed: @escaping () -> Void) {
        if UserDefaults.standard.bool(forKey: privacyNoticeKey) { proceed(); return }
        let alert = UIAlertController(title: CallStrings.s("ssPrivacyTitle"),
                                      message: CallStrings.s("ssPrivacyBody"),
                                      preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: CallStrings.s("cancel"), style: .cancel))
        alert.addAction(UIAlertAction(title: CallStrings.s("ssContinue"), style: .default) { _ in
            UserDefaults.standard.set(true, forKey: privacyNoticeKey)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { proceed() }
        })
        var top: UIViewController = vc
        while let p = top.presentedViewController, !p.isBeingDismissed { top = p }
        top.present(alert, animated: true)
    }

    // MARK: - [2026-10-15] Extension stats → voip_diag

    /// The extension writes its counters (frames, drops, peak footprint,
    /// size, end reason) into the App Group when it ends; log them once.
    static func logExtensionStats(callId: String) {
        guard useBroadcastExtension else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            let ud = UserDefaults(suiteName: appGroupId)
            guard let stats = ud?.dictionary(forKey: "chatyy_ss_ext_stats") else { return }
            ud?.removeObject(forKey: "chatyy_ss_ext_stats")
            let line = stats.keys.sorted().map { "\($0)=\(stats[$0] ?? "")" }.joined(separator: " ")
            nativeCallDiag("screen_share_ext_stats", callId, String(line.prefix(300)))
        }
    }

    // MARK: - Darwin notifications (extension → host, cross-process)

    /// Names posted by the broadcast extension (LiveKit's LKSampleHandler and
    /// react-native-webrtc's sample extension use the same two names).
    static let broadcastStartedName = "iOS_BroadcastStarted"
    static let broadcastStoppedName = "iOS_BroadcastStopped"

    /// Observe the extension's "stopped" Darwin notification. The SDK's
    /// BroadcastScreenCapturer also reacts to the socket closing, but older
    /// 2.x releases leave the (now frame-less) track published; we use this
    /// to unpublish defensively and reset the UI. Returns a token to pass to
    /// `stopObserving`.
    final class ObserverToken {
        fileprivate let handler: () -> Void
        fileprivate init(handler: @escaping () -> Void) { self.handler = handler }
    }

    static func observeBroadcastStopped(_ handler: @escaping () -> Void) -> ObserverToken {
        let token = ObserverToken(handler: handler)
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(token).toOpaque()
        CFNotificationCenterAddObserver(
            center,
            observer,
            { (_, observerRaw, _, _, _) in
                guard let raw = observerRaw else { return }
                let tok = Unmanaged<ObserverToken>.fromOpaque(raw).takeUnretainedValue()
                DispatchQueue.main.async { tok.handler() }
            },
            broadcastStoppedName as CFString,
            nil,
            .deliverImmediately
        )
        return token
    }

    static func stopObserving(_ token: ObserverToken?) {
        guard let token = token else { return }
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(token).toOpaque()
        CFNotificationCenterRemoveEveryObserver(center, observer)
    }
}

// MARK: - [2026-10-15 screen-share whatsapp-level] Landscape viewer (1:1)
//
// iPhone builds are portrait-only (app.json "orientation": "portrait"; only
// iPad gets all four), so the call screen never rotates. When the viewer
// turns the phone sideways while the PEER's screen is shown, this overlay
// covers the call screen with a landscape-sized container rotated ±90°
// (bounds = host height × width, then rotated) holding a second VideoView of
// the same track — the shared screen fills the phone in landscape. Back to
// portrait (or the share ends) → overlay removed. Pinch / drag / double tap
// zoom inside. Honours the user's rotation lock (UIDevice keeps reporting
// portrait). Main thread only.
final class ScreenShareLandscapePresenter: NSObject {
    private weak var host: UIView?
    private var track: VideoTrack?
    private var overlay: UIView?
    private var videoView: VideoView?
    private var observing = false
    private var angle: CGFloat = 0

    private var zoom: CGFloat = 1
    private var offset: CGPoint = .zero
    private var panStart: CGPoint = .zero

    init(host: UIView) {
        self.host = host
        super.init()
    }

    deinit {
        if observing {
            NotificationCenter.default.removeObserver(self)
            UIDevice.current.endGeneratingDeviceOrientationNotifications()
        }
    }

    func attach(track: VideoTrack) {
        self.track = track
        if !observing {
            observing = true
            UIDevice.current.beginGeneratingDeviceOrientationNotifications()
            NotificationCenter.default.addObserver(self, selector: #selector(orientationChanged),
                                                   name: UIDevice.orientationDidChangeNotification, object: nil)
        }
        if let vv = videoView, vv.track !== track { vv.track = track }
        evaluate()
    }

    func detach() {
        track = nil
        if observing {
            observing = false
            NotificationCenter.default.removeObserver(self, name: UIDevice.orientationDidChangeNotification, object: nil)
            UIDevice.current.endGeneratingDeviceOrientationNotifications()
        }
        hideOverlay()
    }

    var isLandscapeShown: Bool { overlay != nil }

    @objc private func orientationChanged() { evaluate() }

    private func evaluate() {
        guard track != nil else { hideOverlay(); return }
        switch UIDevice.current.orientation {
        case .landscapeLeft: showOverlay(angle: .pi / 2)      // home side right → content rotates clockwise
        case .landscapeRight: showOverlay(angle: -.pi / 2)
        case .portrait, .portraitUpsideDown: hideOverlay()
        default: break                                         // face up/down/unknown: keep as is
        }
    }

    private func showOverlay(angle newAngle: CGFloat) {
        guard let host = host, let track = track else { return }
        let ov: UIView
        let vv: VideoView
        if let o = overlay, let v = videoView {
            ov = o; vv = v
            if angle == newAngle { host.bringSubviewToFront(ov); return }
        } else {
            ov = UIView()
            ov.backgroundColor = .black
            ov.alpha = 0
            ov.isUserInteractionEnabled = true
            vv = VideoView()
            vv.layoutMode = .fit
            vv.backgroundColor = .black
            vv.isUserInteractionEnabled = true
            ov.addSubview(vv)
            let pinch = UIPinchGestureRecognizer(target: self, action: #selector(onPinch(_:)))
            let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
            pan.maximumNumberOfTouches = 2
            let dt = UITapGestureRecognizer(target: self, action: #selector(onDoubleTap(_:)))
            dt.numberOfTapsRequired = 2
            ov.addGestureRecognizer(pinch)
            ov.addGestureRecognizer(pan)
            ov.addGestureRecognizer(dt)
            host.addSubview(ov)
            overlay = ov
            videoView = vv
        }
        if vv.track !== track { vv.track = track }
        angle = newAngle
        resetZoom()
        let b = host.bounds
        ov.transform = .identity
        ov.bounds = CGRect(x: 0, y: 0, width: b.height, height: b.width)
        ov.center = CGPoint(x: b.midX, y: b.midY)
        vv.frame = ov.bounds
        host.bringSubviewToFront(ov)
        UIView.animate(withDuration: 0.3, delay: 0, options: [.curveEaseInOut]) {
            ov.transform = CGAffineTransform(rotationAngle: newAngle)
            ov.alpha = 1
        }
    }

    private func hideOverlay() {
        guard let ov = overlay else { return }
        let vv = videoView
        overlay = nil
        videoView = nil
        angle = 0
        UIView.animate(withDuration: 0.25, animations: {
            ov.alpha = 0
            ov.transform = .identity
        }) { _ in
            vv?.track = nil
            ov.removeFromSuperview()
        }
    }

    // Zoom (1×–4×) inside the rotated container (gesture coordinates are in
    // the overlay's own — already rotated — space).
    private func resetZoom() {
        zoom = 1
        offset = .zero
        videoView?.transform = .identity
    }

    private func clamp(_ p: CGPoint, _ s: CGFloat) -> CGPoint {
        guard let ov = overlay else { return .zero }
        let mx = max(0, (s - 1) * ov.bounds.width / 2)
        let my = max(0, (s - 1) * ov.bounds.height / 2)
        return CGPoint(x: min(max(p.x, -mx), mx), y: min(max(p.y, -my), my))
    }

    private func apply() {
        videoView?.transform = CGAffineTransform(translationX: offset.x, y: offset.y).scaledBy(x: zoom, y: zoom)
    }

    @objc private func onPinch(_ gr: UIPinchGestureRecognizer) {
        guard gr.state == .changed || gr.state == .ended else { return }
        zoom = min(max(zoom * gr.scale, 1), 4)
        gr.scale = 1
        offset = clamp(offset, zoom)
        if gr.state == .ended && zoom <= 1.01 {
            UIView.animate(withDuration: 0.25) { self.resetZoom() }
            return
        }
        apply()
    }

    @objc private func onPan(_ gr: UIPanGestureRecognizer) {
        guard zoom > 1.01, let ov = overlay else { return }
        switch gr.state {
        case .began: panStart = offset
        case .changed:
            let t = gr.translation(in: ov)
            offset = clamp(CGPoint(x: panStart.x + t.x, y: panStart.y + t.y), zoom)
            apply()
        default: break
        }
    }

    @objc private func onDoubleTap(_ gr: UITapGestureRecognizer) {
        guard let ov = overlay else { return }
        if zoom > 1.01 {
            UIView.animate(withDuration: 0.25) { self.resetZoom() }
            return
        }
        let p = gr.location(in: ov)
        let s: CGFloat = 2.5
        zoom = s
        offset = clamp(CGPoint(x: (ov.bounds.midX - p.x) * (s - 1), y: (ov.bounds.midY - p.y) * (s - 1)), s)
        UIView.animate(withDuration: 0.25) { self.apply() }
    }
}
