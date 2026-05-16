// LiveHostView.swift
//
// SwiftUI host screen. Renders the local camera preview fullscreen with a
// translucent top bar (host name + viewer count + close X) and a bottom
// control bar (mic toggle, camera flip, end-live). Likes coming in from
// viewers float up on the right edge.
//
// This is scaffolding — not the final visual polish. We deliberately keep
// the code self-contained (no external SwiftUI helpers) so the file can
// stand alone in early builds.

import SwiftUI
import LiveKit
import AVFoundation

struct LiveHostView: View {

  // ----- Inputs ----------------------------------------------------------

  let url: String
  let token: String
  let roomName: String
  let hostName: String

  /// Called by the dismiss button / end-live to tear down the UIHostingController.
  let onClose: () -> Void

  // ----- State -----------------------------------------------------------

  @StateObject private var controller = LiveRoomController()
  @State private var hearts: [HeartFx] = []

  // ----- Body ------------------------------------------------------------

  var body: some View {
    ZStack {
      // 1. Camera preview (or black placeholder while connecting)
      Group {
        if let track = controller.renderTrack {
          SwiftUIVideoView(track)
            .ignoresSafeArea()
        } else {
          Color.black
            .ignoresSafeArea()
        }
      }

      // 2. Subtle top gradient for legibility
      LinearGradient(
        colors: [Color.black.opacity(0.55), Color.black.opacity(0.0)],
        startPoint: .top,
        endPoint: .center
      )
      .ignoresSafeArea()
      .allowsHitTesting(false)

      // 3. Subtle bottom gradient for control bar legibility
      LinearGradient(
        colors: [Color.black.opacity(0.0), Color.black.opacity(0.55)],
        startPoint: .center,
        endPoint: .bottom
      )
      .ignoresSafeArea()
      .allowsHitTesting(false)

      // 4. Top bar + bottom bar
      VStack(spacing: 0) {
        topBar
        Spacer()
        bottomBar
      }
      .padding(.horizontal, 16)
      .padding(.top, 12)
      .padding(.bottom, 24)

      // 5. Hearts overlay (right edge)
      heartsLayer

      // 6. Connecting spinner
      if controller.isConnecting {
        ProgressView()
          .progressViewStyle(CircularProgressViewStyle(tint: .white))
          .scaleEffect(1.6)
      }
    }
    .statusBar(hidden: true)
    .onAppear { Task { await connect() } }
    .onDisappear { Task { await controller.disconnect(reason: "host_dismiss") } }
  }

  // ----- Subviews --------------------------------------------------------

  private var topBar: some View {
    HStack(alignment: .center, spacing: 10) {
      // Live pill
      Text("LIVE")
        .font(.system(size: 11, weight: .heavy))
        .foregroundColor(.white)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color(red: 0.86, green: 0.15, blue: 0.15))
        .cornerRadius(4)

      // Host display
      Text(hostName.isEmpty ? roomName : hostName)
        .font(.system(size: 14, weight: .semibold))
        .foregroundColor(.white)
        .lineLimit(1)

      Spacer()

      // Viewer count
      HStack(spacing: 4) {
        Image(systemName: "eye.fill")
          .font(.system(size: 11))
        Text("\(controller.participantCount)")
          .font(.system(size: 13, weight: .semibold))
      }
      .foregroundColor(.white)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(Color.black.opacity(0.35))
      .cornerRadius(14)

      // Close
      Button(action: handleClose) {
        Image(systemName: "xmark")
          .font(.system(size: 16, weight: .bold))
          .foregroundColor(.white)
          .frame(width: 32, height: 32)
          .background(Color.black.opacity(0.35))
          .clipShape(Circle())
      }
    }
  }

  private var bottomBar: some View {
    HStack(spacing: 24) {
      // Mic toggle
      circleButton(systemName: controller.micEnabled ? "mic.fill" : "mic.slash.fill") {
        controller.toggleMic()
      }

      // Camera enable toggle
      circleButton(systemName: controller.cameraEnabled ? "video.fill" : "video.slash.fill") {
        controller.toggleCamera()
      }

      // Camera flip
      circleButton(systemName: "camera.rotate.fill") {
        controller.switchCamera()
      }

      Spacer()

      // End live (destructive)
      Button(action: handleClose) {
        Text("End Live")
          .font(.system(size: 14, weight: .bold))
          .foregroundColor(.white)
          .padding(.horizontal, 18)
          .padding(.vertical, 10)
          .background(Color(red: 0.86, green: 0.15, blue: 0.15))
          .cornerRadius(20)
      }
    }
  }

  private func circleButton(systemName: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: systemName)
        .font(.system(size: 18, weight: .semibold))
        .foregroundColor(.white)
        .frame(width: 44, height: 44)
        .background(Color.black.opacity(0.45))
        .clipShape(Circle())
    }
  }

  private var heartsLayer: some View {
    GeometryReader { geo in
      ZStack(alignment: .bottomTrailing) {
        ForEach(hearts) { fx in
          Image(systemName: "heart.fill")
            .font(.system(size: 28))
            .foregroundColor(Color(hex: fx.color) ?? .pink)
            .opacity(fx.opacity)
            .offset(x: fx.xOffset, y: fx.yOffset)
        }
      }
      .frame(width: geo.size.width, height: geo.size.height, alignment: .bottomTrailing)
      .padding(.trailing, 20)
      .padding(.bottom, 100)
      .allowsHitTesting(false)
    }
  }

  // ----- Actions ---------------------------------------------------------

  private func connect() async {
    // Request camera/mic permission proactively; LiveKit will fail to
    // publish silently if these are denied.
    await requestPermissions()
    await controller.connect(
      url: url,
      token: token,
      roomName: roomName,
      role: .host
    )
  }

  private func handleClose() {
    Task {
      await controller.disconnect(reason: "host_end_live")
      onClose()
    }
  }

  /// Called by ExpoLiveNativeModule when a `like` data message arrives.
  func spawnHeart(color: String?) {
    let id = UUID()
    let chosen = color ?? "#ff4d6d"
    let fx = HeartFx(id: id, color: chosen, xOffset: 0, yOffset: 0, opacity: 1.0)
    hearts.append(fx)

    // Animate up
    withAnimation(.easeOut(duration: 1.8)) {
      if let idx = hearts.firstIndex(where: { $0.id == id }) {
        hearts[idx].yOffset = -260
        hearts[idx].xOffset = CGFloat.random(in: -30...30)
        hearts[idx].opacity = 0.0
      }
    }
    // Cleanup
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.9) {
      hearts.removeAll { $0.id == id }
    }
  }

  // ----- Permissions -----------------------------------------------------

  private func requestPermissions() async {
    _ = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
      AVCaptureDevice.requestAccess(for: .video) { ok in cont.resume(returning: ok) }
    }
    _ = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
      AVCaptureDevice.requestAccess(for: .audio) { ok in cont.resume(returning: ok) }
    }
  }
}

// ============================================================================
// MARK: - Heart effect model
// ============================================================================

struct HeartFx: Identifiable, Equatable {
  let id: UUID
  let color: String
  var xOffset: CGFloat
  var yOffset: CGFloat
  var opacity: Double
}

// ============================================================================
// MARK: - Color hex helper
// ============================================================================

extension Color {
  /// Parse `#rrggbb` (with or without leading `#`). Returns nil on failure.
  init?(hex: String) {
    var s = hex
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
    let r = Double((v & 0xFF0000) >> 16) / 255.0
    let g = Double((v & 0x00FF00) >> 8) / 255.0
    let b = Double(v & 0x0000FF) / 255.0
    self.init(red: r, green: g, blue: b)
  }
}
