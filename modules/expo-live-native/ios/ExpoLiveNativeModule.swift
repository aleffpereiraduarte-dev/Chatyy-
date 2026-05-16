// ExpoLiveNativeModule.swift
//
// Expo module bridge for the SwiftUI host/viewer screens.
//
//   * `openHost(token, url, roomName, hostName)` — presents
//     `LiveHostView` fullscreen via a UIHostingController.
//   * `openViewer(token, url, roomName, hostName, hostAvatarUrl)` — presents
//     `LiveViewerView` the same way.
//   * `closeLive()` — dismisses whatever modal is up.
//
// Events bridged to JS:
//   * onLiveEnded(roomName, reason)
//   * onLiveError(roomName, message)
//   * onViewerJoined(roomName, identity, participantCount)   [host only]
//   * onLikeReceived(roomName, from, color)                  [host only]

import ExpoModulesCore
import SwiftUI
import UIKit
import Combine

public class ExpoLiveNativeModule: Module {

  /// Tracks the modal currently on screen so closeLive() can find it again.
  private var currentHosting: UIViewController?

  /// Holds onto the active controller so SwiftUI's `@StateObject` doesn't
  /// release it underneath us when the module shuts down.
  private var currentController: LiveRoomController?

  public func definition() -> ModuleDefinition {
    Name("ExpoLiveNative")

    Events(
      "onLiveEnded",
      "onLiveError",
      "onViewerJoined",
      "onLikeReceived"
    )

    // ------------------------------------------------------------------
    // openHost
    // ------------------------------------------------------------------
    AsyncFunction("openHost") { (token: String, url: String, roomName: String, hostName: String, promise: Promise) in
      DispatchQueue.main.async {
        guard let presenter = Self.topMostViewController() else {
          promise.reject("no_presenter", "Could not find a root UIViewController to present from")
          return
        }
        // Tear down any previous modal first.
        self.dismissCurrent(animated: false) {
          let hostView = LiveHostView(
            url: url,
            token: token,
            roomName: roomName,
            hostName: hostName,
            onClose: { [weak self] in
              self?.dismissCurrent(animated: true, completion: nil)
            }
          )
          let hosting = UIHostingController(rootView: hostView)
          hosting.modalPresentationStyle = .fullScreen
          hosting.overrideUserInterfaceStyle = .dark
          self.currentHosting = hosting
          self.attachHostListeners(hostView: hostView)
          presenter.present(hosting, animated: true) {
            promise.resolve(nil)
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // openViewer
    // ------------------------------------------------------------------
    AsyncFunction("openViewer") { (token: String, url: String, roomName: String, hostName: String, hostAvatarUrl: String, promise: Promise) in
      DispatchQueue.main.async {
        guard let presenter = Self.topMostViewController() else {
          promise.reject("no_presenter", "Could not find a root UIViewController to present from")
          return
        }
        self.dismissCurrent(animated: false) {
          let viewerView = LiveViewerView(
            url: url,
            token: token,
            roomName: roomName,
            hostName: hostName,
            hostAvatarUrl: hostAvatarUrl,
            onClose: { [weak self] in
              self?.dismissCurrent(animated: true, completion: nil)
            }
          )
          let hosting = UIHostingController(rootView: viewerView)
          hosting.modalPresentationStyle = .fullScreen
          hosting.overrideUserInterfaceStyle = .dark
          self.currentHosting = hosting
          self.attachViewerListeners(viewerView: viewerView)
          presenter.present(hosting, animated: true) {
            promise.resolve(nil)
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // closeLive
    // ------------------------------------------------------------------
    Function("closeLive") {
      DispatchQueue.main.async {
        self.dismissCurrent(animated: true, completion: nil)
      }
    }

    OnDestroy {
      DispatchQueue.main.async {
        self.dismissCurrent(animated: false, completion: nil)
      }
    }
  }

  // ----------------------------------------------------------------------
  // Listener wiring — pulls events out of LiveRoomController and pushes
  // them across the JS bridge via `sendEvent`.
  //
  // Because the SwiftUI view owns its `@StateObject`, we don't have a clean
  // handle to the controller until SwiftUI has built the view tree. As a
  // first-pass scaffold we lazily install hooks on the next runloop tick;
  // SwiftUI will have created the StateObject by then.
  // ----------------------------------------------------------------------

  private func attachHostListeners(hostView _: LiveHostView) {
    // SwiftUI creates the @StateObject the first time the view is rendered.
    // We give it one runloop cycle, then walk the presented hosting
    // controller's child responder chain to find the controller.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
      guard let self = self else { return }
      if let controller = self.findController(in: self.currentHosting) {
        self.currentController = controller
        self.bindHooks(controller: controller)
      }
    }
  }

  private func attachViewerListeners(viewerView _: LiveViewerView) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
      guard let self = self else { return }
      if let controller = self.findController(in: self.currentHosting) {
        self.currentController = controller
        self.bindHooks(controller: controller)
      }
    }
  }

  private func bindHooks(controller: LiveRoomController) {
    controller.onLiveEnded = { [weak self] room, reason in
      self?.sendEvent("onLiveEnded", ["roomName": room, "reason": reason])
    }
    controller.onLiveError = { [weak self] room, message in
      self?.sendEvent("onLiveError", ["roomName": room, "message": message])
    }
    controller.onViewerJoined = { [weak self] room, identity, count in
      self?.sendEvent("onViewerJoined", [
        "roomName": room,
        "identity": identity,
        "participantCount": count
      ])
    }
    controller.onLikeReceived = { [weak self] room, from, color in
      self?.sendEvent("onLikeReceived", [
        "roomName": room,
        "from": from,
        "color": color ?? "#ff4d6d"
      ])
    }
  }

  /// Best-effort walk of the hosting controller's view tree to find the
  /// `LiveRoomController` that SwiftUI created as `@StateObject`. This is a
  /// scaffold-grade approach — final implementation will likely lift the
  /// controller out of the View and inject it via `environmentObject`.
  private func findController(in _: UIViewController?) -> LiveRoomController? {
    // Mirror-based introspection: SwiftUI's hosting controller stores the
    // rootView's StateObjects in private storage. Rather than poke at those
    // internals, the next iteration will refactor LiveHostView/LiveViewerView
    // to accept an injected `@ObservedObject controller` so this method can
    // simply read it back. For the scaffold we return nil and rely on the
    // SwiftUI views themselves to call into the module if they need to fire
    // events.
    return nil
  }

  // ----------------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------------

  private func dismissCurrent(animated: Bool, completion: (() -> Void)?) {
    guard let hosting = self.currentHosting else {
      completion?()
      return
    }
    self.currentHosting = nil
    self.currentController = nil
    hosting.dismiss(animated: animated, completion: completion)
  }

  /// Walks the UIWindowScene tree to find the topmost view controller that
  /// can present a modal. Falls back to the keyWindow's rootViewController.
  static func topMostViewController() -> UIViewController? {
    var root: UIViewController?
    if let scene = UIApplication.shared.connectedScenes
        .first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene {
      root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController
        ?? scene.windows.first?.rootViewController
    }
    if root == nil {
      root = UIApplication.shared.windows.first(where: { $0.isKeyWindow })?.rootViewController
        ?? UIApplication.shared.windows.first?.rootViewController
    }
    while let presented = root?.presentedViewController {
      root = presented
    }
    return root
  }
}
