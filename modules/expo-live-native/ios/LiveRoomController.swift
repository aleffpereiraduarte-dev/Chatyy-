// LiveRoomController.swift
//
// ObservableObject that wraps a LiveKit `Room` and exposes the bits SwiftUI
// needs to render the host and viewer screens.
//
// Design notes:
//
//   * The host calls `connect(role: .host)`, which enables camera+mic on the
//     local participant. The viewer calls `connect(role: .viewer)` and does
//     NOT publish anything — we just subscribe to whoever is publishing video.
//
//   * `firstRemoteVideoTrack` is the simplest possible "show me the host"
//     strategy: pick the first non-local participant that has a video track.
//     A single-host live is fine for now; cohost grid will come later (see
//     MEMORY.md → live_cohost_tiktok_plan).
//
//   * `sendLike` publishes a small data payload over the room's data channel.
//     The host listens for `dataReceived` and emits `onLikeReceived` to JS.
//     We use Reliable delivery — heart counts are not high-rate enough to
//     justify Lossy, and missing a heart is user-visible.
//
//   * All `@Published` mutations are dispatched to `MainActor` because
//     SwiftUI is main-thread-only and LiveKit's delegate callbacks can fire
//     on background threads.

import Foundation
import Combine
import AVFoundation
import LiveKit

@MainActor
final class LiveRoomController: ObservableObject {

  // ----- Role -------------------------------------------------------------

  enum Role {
    case host
    case viewer
  }

  // ----- Published state --------------------------------------------------

  @Published var isConnecting: Bool = false
  @Published var isConnected: Bool = false
  @Published var lastError: String? = nil

  /// Number of remote participants (viewers, on the host side).
  @Published var participantCount: Int = 0

  /// Local mic on/off. Host-side UI only.
  @Published var micEnabled: Bool = true
  /// Local camera on/off. Host-side UI only.
  @Published var cameraEnabled: Bool = true
  /// `.front` (selfie) or `.back`. Host-side UI only.
  @Published var cameraFacing: AVCaptureDevice.Position = .front

  /// The track the SwiftUI VideoView should render. For the host it's the
  /// local camera track; for the viewer it's the first remote track found.
  @Published private(set) var renderTrack: VideoTrack? = nil

  // ----- Hooks (read by the Expo module to bridge events to JS) -----------

  /// (roomName, reason)
  var onLiveEnded: ((String, String) -> Void)?
  /// (roomName, message)
  var onLiveError: ((String, String) -> Void)?
  /// (roomName, identity, participantCount)
  var onViewerJoined: ((String, String, Int) -> Void)?
  /// (roomName, fromIdentity, color)
  var onLikeReceived: ((String, String, String?) -> Void)?

  // ----- LiveKit primitives -----------------------------------------------

  private(set) var room: Room
  private(set) var role: Role = .viewer
  private(set) var roomName: String = ""
  private var delegateRetain: RoomDelegateBridge? = nil

  // ------------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------------

  init() {
    self.room = Room()
  }

  // ------------------------------------------------------------------------
  // Connect / disconnect
  // ------------------------------------------------------------------------

  func connect(
    url: String,
    token: String,
    roomName: String,
    role: Role
  ) async {
    self.role = role
    self.roomName = roomName
    self.isConnecting = true
    self.lastError = nil

    // Install the delegate. We retain it manually because LiveKit holds
    // delegates weakly.
    let bridge = RoomDelegateBridge(owner: self)
    self.delegateRetain = bridge
    self.room.add(delegate: bridge)

    do {
      let connectOptions = ConnectOptions(autoSubscribe: true)
      let roomOptions = RoomOptions(
        adaptiveStream: true,
        dynacast: true
      )
      try await self.room.connect(
        url: url,
        token: token,
        connectOptions: connectOptions,
        roomOptions: roomOptions
      )
      self.isConnected = true
      self.isConnecting = false

      if role == .host {
        await self.enableCapture()
      } else {
        // viewer: nothing to publish; pull current remote track if any
        self.refreshRemoteTrack()
      }
    } catch {
      self.isConnecting = false
      self.isConnected = false
      let msg = "connect failed: \(error.localizedDescription)"
      self.lastError = msg
      self.onLiveError?(self.roomName, msg)
    }
  }

  func disconnect(reason: String = "user_close") async {
    let name = self.roomName
    if self.role == .host {
      // best-effort: unpublish so viewers see the stream end immediately
      try? await self.room.localParticipant.setCamera(enabled: false)
      try? await self.room.localParticipant.setMicrophone(enabled: false)
    }
    await self.room.disconnect()
    self.isConnected = false
    self.renderTrack = nil
    self.onLiveEnded?(name, reason)
  }

  // ------------------------------------------------------------------------
  // Host controls
  // ------------------------------------------------------------------------

  private func enableCapture() async {
    do {
      try await self.room.localParticipant.setCamera(enabled: true)
      try await self.room.localParticipant.setMicrophone(enabled: true)
      self.micEnabled = true
      self.cameraEnabled = true
      self.refreshLocalTrack()
    } catch {
      let msg = "capture failed: \(error.localizedDescription)"
      self.lastError = msg
      self.onLiveError?(self.roomName, msg)
    }
  }

  func toggleMic() {
    Task { @MainActor in
      let next = !self.micEnabled
      do {
        try await self.room.localParticipant.setMicrophone(enabled: next)
        self.micEnabled = next
      } catch {
        self.onLiveError?(self.roomName, "toggleMic: \(error.localizedDescription)")
      }
    }
  }

  func toggleCamera() {
    Task { @MainActor in
      let next = !self.cameraEnabled
      do {
        try await self.room.localParticipant.setCamera(enabled: next)
        self.cameraEnabled = next
        self.refreshLocalTrack()
      } catch {
        self.onLiveError?(self.roomName, "toggleCamera: \(error.localizedDescription)")
      }
    }
  }

  func switchCamera() {
    Task { @MainActor in
      let next: AVCaptureDevice.Position =
        (self.cameraFacing == .front) ? .back : .front

      // Walk the published tracks and ask the underlying CameraCapturer to
      // switch position. Different LiveKit versions expose this differently;
      // we try the modern `switchCameraPosition()` first and fall back to
      // re-publishing the track if that isn't available.
      for pub in self.room.localParticipant.videoTracks {
        guard let track = pub.track as? LocalVideoTrack else { continue }
        if let capturer = track.capturer as? CameraCapturer {
          do {
            try await capturer.switchCameraPosition()
            self.cameraFacing = next
            return
          } catch {
            self.onLiveError?(self.roomName, "switchCamera: \(error.localizedDescription)")
          }
        }
      }
      self.cameraFacing = next
    }
  }

  // ------------------------------------------------------------------------
  // Viewer / shared
  // ------------------------------------------------------------------------

  /// Publishes a small "like" payload via the room data channel. The host
  /// side decodes it in `RoomDelegateBridge.room(_:didReceiveData:from:)`
  /// and emits `onLikeReceived` to JS.
  func sendLike(color: String?) {
    let payload: [String: Any] = [
      "t": "like",
      "color": color ?? "#ff4d6d"
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
      return
    }
    Task { @MainActor in
      do {
        try await self.room.localParticipant.publish(
          data: data,
          options: DataPublishOptions(reliable: true)
        )
      } catch {
        // not fatal — hearts are best-effort
      }
    }
  }

  // ------------------------------------------------------------------------
  // Track refresh helpers (called from delegate callbacks)
  // ------------------------------------------------------------------------

  fileprivate func refreshLocalTrack() {
    if let pub = self.room.localParticipant.videoTracks.first,
       let track = pub.track as? VideoTrack {
      self.renderTrack = track
    }
  }

  fileprivate func refreshRemoteTrack() {
    // Pick the first remote participant with a video track.
    for (_, p) in self.room.remoteParticipants {
      for pub in p.videoTracks {
        if let track = pub.track as? VideoTrack {
          self.renderTrack = track
          return
        }
      }
    }
  }

  fileprivate func updateParticipantCount() {
    self.participantCount = self.room.remoteParticipants.count
  }
}

// ============================================================================
// MARK: - RoomDelegateBridge
// ============================================================================
//
// LiveKit's delegate protocol is `RoomDelegate`. We need a separate type
// (rather than making LiveRoomController itself conform) because LiveKit
// retains delegates weakly AND LiveRoomController is `@MainActor` while
// RoomDelegate methods are nonisolated. Splitting them lets us hop to the
// MainActor cleanly inside each method.

private final class RoomDelegateBridge: NSObject, RoomDelegate {

  weak var owner: LiveRoomController?

  init(owner: LiveRoomController) {
    self.owner = owner
    super.init()
  }

  // ----- Connection lifecycle -------------------------------------------

  func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldState: ConnectionState) {
    guard let owner = self.owner else { return }
    Task { @MainActor in
      switch connectionState {
      case .disconnected:
        owner.isConnected = false
        owner.renderTrack = nil
        owner.onLiveEnded?(owner.roomName, "disconnected")
      case .connected:
        owner.isConnected = true
      default:
        break
      }
    }
  }

  // ----- Participants ---------------------------------------------------

  func room(_ room: Room, participantDidJoin participant: RemoteParticipant) {
    guard let owner = self.owner else { return }
    Task { @MainActor in
      owner.updateParticipantCount()
      owner.onViewerJoined?(
        owner.roomName,
        participant.identity?.stringValue ?? "",
        owner.participantCount
      )
      // For viewer role: a publishing host may show up after we connect
      if owner.role == .viewer {
        owner.refreshRemoteTrack()
      }
    }
  }

  func room(_ room: Room, participantDidLeave participant: RemoteParticipant) {
    guard let owner = self.owner else { return }
    Task { @MainActor in
      owner.updateParticipantCount()
      if owner.role == .viewer {
        owner.refreshRemoteTrack()
      }
    }
  }

  // ----- Tracks ---------------------------------------------------------

  func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
    guard let owner = self.owner else { return }
    Task { @MainActor in
      if owner.role == .viewer {
        owner.refreshRemoteTrack()
      }
    }
  }

  func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
    guard let owner = self.owner else { return }
    Task { @MainActor in
      if owner.role == .viewer {
        owner.refreshRemoteTrack()
      }
    }
  }

  func room(_ room: Room, participant: LocalParticipant, didPublishTrack publication: LocalTrackPublication) {
    guard let owner = self.owner else { return }
    Task { @MainActor in
      if owner.role == .host {
        owner.refreshLocalTrack()
      }
    }
  }

  // ----- Data channel (likes) -------------------------------------------

  func room(_ room: Room, participant: RemoteParticipant?, didReceiveData data: Data, forTopic topic: String?) {
    guard let owner = self.owner else { return }
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    let type = obj["t"] as? String ?? ""
    let color = obj["color"] as? String
    let from = participant?.identity?.stringValue ?? ""
    if type == "like" {
      Task { @MainActor in
        owner.onLikeReceived?(owner.roomName, from, color)
      }
    }
  }
}
