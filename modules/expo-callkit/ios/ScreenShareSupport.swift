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
import LiveKit
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
        return useBroadcastExtension ? "Compartilhando tela" : "Compartilhando tela do app"
    }

    /// True when the local participant currently has a screen-share video
    /// publication in `room`. This is the TRUTH for the toggle state — with
    /// the broadcast extension the publication appears only after the user
    /// confirms "Iniciar Transmissão" in the system sheet, and disappears
    /// when they stop it from the red status pill.
    static func isSharing(room: Room) -> Bool {
        return room.localParticipant.videoTracks.contains { $0.source == .screenShareVideo }
    }

    /// Toggle the local screen-share publication. `set(source:enabled:)` is
    /// the exact call the native screens already compiled against; the
    /// broadcast/in-app decision comes from the Room's
    /// `defaultScreenShareCaptureOptions` (see `captureOptions()`).
    ///
    /// With the broadcast extension, `enabled == true` returns as soon as
    /// the system picker has been presented — the publication is created
    /// later by the SDK once the extension connects. Callers must therefore
    /// drive UI state from `RoomDelegate.room(_:participant:didPublishTrack:)`
    /// / `didUnpublishTrack`, not from this call returning.
    static func set(room: Room, enabled: Bool) async throws {
        // [video-quality 2026-10-06] Explicit publish options for the screen
        // track: H.264, ~3 Mbps @ 15 fps, degradation = maintainResolution
        // (camera uses .balanced; a shared Room default can't express both).
        // Signature verified on LK Swift 2.0.18:
        //   set(source:enabled:captureOptions:publishOptions:)
        _ = try await room.localParticipant.set(
            source: .screenShareVideo,
            enabled: enabled,
            captureOptions: nil,
            publishOptions: enabled ? CallViewController.screenSharePublishOptions() : nil
        )
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
