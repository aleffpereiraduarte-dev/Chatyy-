import ExpoModulesCore
import UIKit

// ExpoLiveNativeModule — Stage 1 scaffold (2026-05-16).
//
// Mirrors the Kotlin module: openHost / openViewer present a fullscreen
// UIViewController over the keyWindow's root VC. Stage 1 placeholders just
// show a UILabel + dismiss button; Stage 2 will wire LiveKit publish/
// subscribe against the LiveKitClient pod declared in ExpoLiveNative.podspec.
//
// Pattern follows modules/expo-callkit/ExpoCallKitModule.swift — events
// declared in definition(), AsyncFunctions presenting the VC on the main
// actor, and a NotificationCenter observer that forwards the placeholder
// view controller's "I closed" notification back into JS as onLiveEnded.

public class ExpoLiveNativeModule: Module {

  // Stash the currently-presented host/viewer VC so closeLive can dismiss it
  // and emit onLiveEnded synchronously.
  private weak var currentLiveVC: UIViewController?
  private var endedObserver: Any?
  // [Stage 2, 2026-05-16] Additional notification observers — error + viewer
  // joined. The VCs post NSNotifications because they don't hold a hard
  // reference to the Module; the Module fans them back into JS events.
  private var errorObserver: Any?
  private var viewerJoinedObserver: Any?

  public func definition() -> ModuleDefinition {
    Name("ExpoLiveNative")

    Events(
      "onLiveEnded",
      "onLiveError",
      "onViewerJoined",
      "onLikeReceived"
    )

    OnCreate {
      self.installEndedObserver()
    }

    OnDestroy {
      if let obs = self.endedObserver {
        NotificationCenter.default.removeObserver(obs)
        self.endedObserver = nil
      }
      if let obs = self.errorObserver {
        NotificationCenter.default.removeObserver(obs)
        self.errorObserver = nil
      }
      if let obs = self.viewerJoinedObserver {
        NotificationCenter.default.removeObserver(obs)
        self.viewerJoinedObserver = nil
      }
    }

    AsyncFunction("openHost") {
      (lkToken: String, lkUrl: String, roomName: String, hostEmail: String,
       title: String?, audience: String?) -> Void in
      await MainActor.run {
        guard let root = Self.findRootViewController() else {
          self.sendEvent("onLiveError", [
            "roomName": roomName,
            "message": "no rootViewController",
          ])
          return
        }
        let vc = LiveHostViewController(
          lkToken: lkToken,
          lkUrl: lkUrl,
          roomName: roomName,
          hostEmail: hostEmail,
          title: title,
          audience: audience
        )
        vc.modalPresentationStyle = .fullScreen
        self.currentLiveVC = vc
        root.present(vc, animated: true, completion: nil)
      }
    }

    AsyncFunction("openViewer") {
      (lkToken: String, lkUrl: String, roomName: String,
       hostName: String?, hostAvatarUrl: String?) -> Void in
      await MainActor.run {
        guard let root = Self.findRootViewController() else {
          self.sendEvent("onLiveError", [
            "roomName": roomName,
            "message": "no rootViewController",
          ])
          return
        }
        let vc = LiveViewerViewController(
          lkToken: lkToken,
          lkUrl: lkUrl,
          roomName: roomName,
          hostName: hostName,
          hostAvatarUrl: hostAvatarUrl
        )
        vc.modalPresentationStyle = .fullScreen
        self.currentLiveVC = vc
        root.present(vc, animated: true, completion: nil)
      }
    }

    AsyncFunction("closeLive") { () -> Void in
      await MainActor.run {
        if let vc = self.currentLiveVC {
          vc.dismiss(animated: true, completion: nil)
          self.currentLiveVC = nil
        }
        self.sendEvent("onLiveEnded", ["roomName": "", "reason": "closeLive"])
      }
    }
  }

  // MARK: - Helpers

  private func installEndedObserver() {
    if endedObserver == nil {
      endedObserver = NotificationCenter.default.addObserver(
        forName: LiveNativeNotifications.didEnd,
        object: nil,
        queue: .main
      ) { [weak self] note in
        guard let self = self else { return }
        let info = note.userInfo ?? [:]
        let roomName = (info["roomName"] as? String) ?? ""
        let reason = (info["reason"] as? String) ?? ""
        self.sendEvent("onLiveEnded", ["roomName": roomName, "reason": reason])
        self.currentLiveVC = nil
      }
    }
    if errorObserver == nil {
      errorObserver = NotificationCenter.default.addObserver(
        forName: LiveNativeNotifications.didError,
        object: nil,
        queue: .main
      ) { [weak self] note in
        guard let self = self else { return }
        let info = note.userInfo ?? [:]
        let roomName = (info["roomName"] as? String) ?? ""
        let message = (info["message"] as? String) ?? ""
        self.sendEvent("onLiveError", ["roomName": roomName, "message": message])
      }
    }
    if viewerJoinedObserver == nil {
      viewerJoinedObserver = NotificationCenter.default.addObserver(
        forName: LiveNativeNotifications.viewerJoined,
        object: nil,
        queue: .main
      ) { [weak self] note in
        guard let self = self else { return }
        let info = note.userInfo ?? [:]
        let roomName = (info["roomName"] as? String) ?? ""
        let identity = (info["identity"] as? String) ?? ""
        let name = (info["name"] as? String) ?? ""
        self.sendEvent("onViewerJoined", [
          "roomName": roomName,
          "identity": identity,
          "name": name,
        ])
      }
    }
  }

  private static func findRootViewController() -> UIViewController? {
    return UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.keyWindow?.rootViewController }
      .first
  }
}

// Notifications used by the VCs to bubble events back into the module
// without holding a hard reference to it.
enum LiveNativeNotifications {
  static let didEnd = Notification.Name("ExpoLiveNativeLiveEnded")
  // [Stage 2, 2026-05-16] error + viewerJoined notifications. The Host VC
  // posts viewerJoined on RoomDelegate participantDidConnect; either VC
  // posts didError on LK connect failure / camera permission denied.
  static let didError = Notification.Name("ExpoLiveNativeLiveError")
  static let viewerJoined = Notification.Name("ExpoLiveNativeViewerJoined")
}
