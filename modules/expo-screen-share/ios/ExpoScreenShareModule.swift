//
//  ExpoScreenShareModule.swift
//
//  Main-app side of the screen-share pipeline. Bridges three concerns:
//
//   1. Present the iOS native broadcast picker (RPSystemBroadcastPickerView)
//      pre-pointed at our ChatyyBroadcastExtension bundle. User confirms in
//      the system UI, then iOS spawns the extension process for us — there
//      is no API to start the broadcast silently. Apple requires the user
//      gesture for privacy reasons.
//
//   2. Listen for Darwin notifications the extension posts on every frame
//      it writes to the App Group container, then emit a JS event with the
//      frame's file:// URI so the React side can either:
//        (a) hand it to a custom RTCVideoCapturer that pumps it into the
//            existing RTCPeerConnection's video sender via replaceTrack, or
//        (b) decode it for an on-screen preview.
//
//   3. Track broadcast lifecycle (started / paused / resumed / finished) and
//      surface it to JS so the call screen can swap the camera track back
//      when the user stops sharing.
//
//  WHY DARWIN CFNotification AND NOT NSNotification:
//  NSNotificationCenter is process-local. CFNotificationCenter's Darwin
//  variant is the only documented cross-process notification primitive that
//  works between an app extension and its host without entitlements.
//
//  SECURITY MODEL:
//   - All IPC happens inside the App Group sandbox (group.com.onemundo.mail).
//     No data leaves the device on this path; WebRTC handles transport.
//   - The extension never sees the user's auth token. The main app injects
//     frames into the existing authenticated WebRTC peer connection.
//   - We delete stale frame files on broadcast end so screenshots don't
//     persist in the sandbox after the session ends.
//

import ExpoModulesCore
import ReplayKit
import UIKit

public class ExpoScreenShareModule: Module {

    // Must match the extension bundle ID configured in the Xcode target.
    private static let extensionBundleId = "com.onemundo.mail.broadcastupload"
    private static let appGroupId = "group.com.onemundo.mail"

    private static let frameNotificationName = "com.onemundo.mail.screenshare.frame"
    private static let stateNotificationName = "com.onemundo.mail.screenshare.state"

    private static let frameFileA = "screenshare-frame-a.jpg"
    private static let frameFileB = "screenshare-frame-b.jpg"
    private static let statePtrFile = "screenshare-state.txt"
    private static let stateFile = "screenshare-broadcast-state.txt"
    private static let stopRequestFile = "screenshare-stop-request.txt"

    private var sharedContainerURL: URL?
    private var isObserving = false
    private var frameSeq: UInt64 = 0
    private var broadcastingFlag = false

    public func definition() -> ModuleDefinition {
        Name("ExpoScreenShare")

        Events("onBroadcastStarted", "onBroadcastFrame", "onBroadcastStopped", "onBroadcastError")

        OnCreate {
            self.sharedContainerURL = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: ExpoScreenShareModule.appGroupId)
            if self.sharedContainerURL == nil {
                print("[ExpoScreenShare] WARNING: App Group container missing — entitlement not configured?")
            }
        }

        OnDestroy {
            self.stopObserving()
        }

        AsyncFunction("presentBroadcastPicker") { (promise: Promise) in
            // Must run on main thread — RPSystemBroadcastPickerView is UIKit.
            DispatchQueue.main.async {
                guard let rootVC = ExpoScreenShareModule.topViewController() else {
                    promise.reject("E_NO_VC", "No root view controller to attach picker to")
                    return
                }

                // The trick: RPSystemBroadcastPickerView renders a button that,
                // when tapped, presents the iOS broadcast picker pre-filtered to
                // our extension. There is NO public API to present the picker
                // programmatically without a tap, so we synthesize the tap by
                // walking the subview tree for the embedded UIButton and
                // sending it a touchUpInside event.
                let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
                picker.preferredExtension = ExpoScreenShareModule.extensionBundleId
                picker.showsMicrophoneButton = false

                rootVC.view.addSubview(picker)

                var found = false
                for sub in picker.subviews {
                    if let button = sub as? UIButton {
                        button.sendActions(for: .touchUpInside)
                        found = true
                        break
                    }
                }

                // Tear down the dummy view after the picker is presented.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    picker.removeFromSuperview()
                }

                if !found {
                    promise.reject("E_PICKER", "Could not locate broadcast picker button")
                    return
                }

                // Reset stale stop-request flag so a previous session can't
                // immediately abort a new one.
                if let url = self.sharedContainerURL?.appendingPathComponent(ExpoScreenShareModule.stopRequestFile) {
                    try? FileManager.default.removeItem(at: url)
                }

                promise.resolve(nil)
            }
        }

        Function("isBroadcasting") { () -> Bool in
            return self.broadcastingFlag || self.readBroadcastState() == "started"
        }

        Function("startReceivingFrames") { () -> Void in
            self.startObserving()
        }

        Function("stopReceivingFrames") { () -> Void in
            self.stopObserving()
        }

        Function("requestStopBroadcast") { () -> Void in
            // We can't kill the extension from the host. We write a flag the
            // extension polls in its sample handler; when it sees the flag,
            // it calls finishBroadcastWithError on itself which stops the
            // ReplayKit session cleanly.
            //
            // Alternative for the future: have the extension also observe a
            // Darwin notification we post here. Saves the disk round-trip but
            // is a bigger refactor since CFNotification listeners can't be
            // installed inside the extension's CMSampleBuffer thread.
            guard let url = self.sharedContainerURL?.appendingPathComponent(ExpoScreenShareModule.stopRequestFile) else { return }
            try? "stop".write(to: url, atomically: true, encoding: .utf8)
        }
    }

    // MARK: - Darwin notification pump

    private func startObserving() {
        if isObserving { return }
        guard sharedContainerURL != nil else {
            self.sendEvent("onBroadcastError", ["message": "App Group container unavailable"])
            return
        }

        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()

        // Frame notifications
        CFNotificationCenterAddObserver(
            center,
            observer,
            { (_, observerRaw, _, _, _) in
                guard let raw = observerRaw else { return }
                let module = Unmanaged<ExpoScreenShareModule>.fromOpaque(raw).takeUnretainedValue()
                module.handleFrameNotification()
            },
            ExpoScreenShareModule.frameNotificationName as CFString,
            nil,
            .deliverImmediately
        )

        // State notifications
        CFNotificationCenterAddObserver(
            center,
            observer,
            { (_, observerRaw, _, _, _) in
                guard let raw = observerRaw else { return }
                let module = Unmanaged<ExpoScreenShareModule>.fromOpaque(raw).takeUnretainedValue()
                module.handleStateNotification()
            },
            ExpoScreenShareModule.stateNotificationName as CFString,
            nil,
            .deliverImmediately
        )

        isObserving = true

        // The broadcast may have already started before JS asked us to listen
        // (cold-start case where iOS resumed a paused broadcast). Probe the
        // state file once on attach so we don't lose the "started" event.
        let initialState = readBroadcastState()
        if initialState == "started" {
            broadcastingFlag = true
            self.sendEvent("onBroadcastStarted", [
                "extensionBundleId": ExpoScreenShareModule.extensionBundleId
            ])
        }
    }

    private func stopObserving() {
        if !isObserving { return }
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterRemoveEveryObserver(center, observer)
        isObserving = false
    }

    private func handleFrameNotification() {
        guard let containerURL = sharedContainerURL else { return }
        let ptrURL = containerURL.appendingPathComponent(ExpoScreenShareModule.statePtrFile)
        guard let ptr = try? String(contentsOf: ptrURL, encoding: .utf8) else { return }
        let frameName = ptr.trimmingCharacters(in: .whitespacesAndNewlines) == "a"
            ? ExpoScreenShareModule.frameFileA
            : ExpoScreenShareModule.frameFileB
        let frameURL = containerURL.appendingPathComponent(frameName)
        guard FileManager.default.fileExists(atPath: frameURL.path) else { return }

        frameSeq &+= 1

        // We don't decode the image here — that's the JS/RTCVideoCapturer's
        // job. We just hand the path. Width/height are unknown without a
        // decode; we send 0/0 and let the consumer pull from the actual
        // JPEG if it needs the dims. Saves CPU on the hot path.
        self.sendEvent("onBroadcastFrame", [
            "uri": frameURL.absoluteString,
            "seq": Int(frameSeq),
            "width": 0,
            "height": 0
        ])
    }

    private func handleStateNotification() {
        let state = readBroadcastState()
        switch state {
        case "started":
            if !broadcastingFlag {
                broadcastingFlag = true
                self.sendEvent("onBroadcastStarted", [
                    "extensionBundleId": ExpoScreenShareModule.extensionBundleId
                ])
            }
        case "finished":
            broadcastingFlag = false
            self.sendEvent("onBroadcastStopped", ["reason": "user_stopped"])
            cleanupStaleFiles()
        case "paused":
            // We don't currently bubble paused — peer sees frozen frame which
            // is the same UX WhatsApp gives. Could add it if needed.
            break
        default:
            break
        }
    }

    private func readBroadcastState() -> String {
        guard let url = sharedContainerURL?.appendingPathComponent(ExpoScreenShareModule.stateFile) else { return "" }
        return (try? String(contentsOf: url, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    // Wipe the frame JPEGs after a broadcast ends. The App Group container
    // persists across launches; without this, the last 1-2 frames sit on
    // disk indefinitely.
    private func cleanupStaleFiles() {
        guard let containerURL = sharedContainerURL else { return }
        let names = [
            ExpoScreenShareModule.frameFileA,
            ExpoScreenShareModule.frameFileB,
            ExpoScreenShareModule.statePtrFile,
        ]
        for n in names {
            let u = containerURL.appendingPathComponent(n)
            try? FileManager.default.removeItem(at: u)
        }
    }

    // MARK: - Helpers

    private static func topViewController(base: UIViewController? = nil) -> UIViewController? {
        let root: UIViewController? = {
            if let b = base { return b }
            let scenes = UIApplication.shared.connectedScenes
            for s in scenes {
                if let win = s as? UIWindowScene {
                    return win.keyWindow?.rootViewController ?? win.windows.first?.rootViewController
                }
            }
            return nil
        }()
        if let nav = root as? UINavigationController {
            return topViewController(base: nav.visibleViewController)
        }
        if let tab = root as? UITabBarController, let sel = tab.selectedViewController {
            return topViewController(base: sel)
        }
        if let presented = root?.presentedViewController {
            return topViewController(base: presented)
        }
        return root
    }
}
