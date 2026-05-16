// LiveViewerView.swift
//
// SwiftUI viewer screen. Renders the remote host's video fullscreen with a
// top bar (avatar + host name + close X), a bottom bar (chat placeholder
// input + heart button + share button), and a hearts overlay on the right.
//
// Like LiveHostView this is scaffolding only — chat overlay is a TODO and
// share is a no-op placeholder. The real chat UI will arrive in a follow-up.

import SwiftUI
import LiveKit
import AVFoundation

struct LiveViewerView: View {

  // ----- Inputs ----------------------------------------------------------

  let url: String
  let token: String
  let roomName: String
  let hostName: String
  let hostAvatarUrl: String

  let onClose: () -> Void

  // ----- State -----------------------------------------------------------

  @StateObject private var controller = LiveRoomController()
  @State private var hearts: [HeartFx] = []
  @State private var commentDraft: String = ""

  // ----- Body ------------------------------------------------------------

  var body: some View {
    ZStack {
      // 1. Remote video (or black placeholder while connecting)
      Group {
        if let track = controller.renderTrack {
          SwiftUIVideoView(track)
            .ignoresSafeArea()
        } else {
          Color.black
            .ignoresSafeArea()
        }
      }

      // 2. Gradients top + bottom for legibility
      LinearGradient(
        colors: [Color.black.opacity(0.55), Color.black.opacity(0.0)],
        startPoint: .top,
        endPoint: .center
      )
      .ignoresSafeArea()
      .allowsHitTesting(false)

      LinearGradient(
        colors: [Color.black.opacity(0.0), Color.black.opacity(0.55)],
        startPoint: .center,
        endPoint: .bottom
      )
      .ignoresSafeArea()
      .allowsHitTesting(false)

      VStack(spacing: 0) {
        topBar
        Spacer()
        bottomBar
      }
      .padding(.horizontal, 16)
      .padding(.top, 12)
      .padding(.bottom, 24)

      // Hearts overlay on the right
      heartsLayer

      if controller.isConnecting {
        ProgressView()
          .progressViewStyle(CircularProgressViewStyle(tint: .white))
          .scaleEffect(1.6)
      }
    }
    .statusBar(hidden: true)
    .onAppear { Task { await connect() } }
    .onDisappear { Task { await controller.disconnect(reason: "viewer_dismiss") } }
  }

  // ----- Subviews --------------------------------------------------------

  private var topBar: some View {
    HStack(alignment: .center, spacing: 10) {
      // Avatar (async URL or initial fallback)
      avatarView

      VStack(alignment: .leading, spacing: 1) {
        Text(hostName.isEmpty ? roomName : hostName)
          .font(.system(size: 14, weight: .semibold))
          .foregroundColor(.white)
          .lineLimit(1)
        Text("LIVE")
          .font(.system(size: 10, weight: .heavy))
          .foregroundColor(.white)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Color(red: 0.86, green: 0.15, blue: 0.15))
          .cornerRadius(3)
      }

      Spacer()

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

  @ViewBuilder
  private var avatarView: some View {
    if let url = URL(string: hostAvatarUrl), !hostAvatarUrl.isEmpty {
      AsyncImage(url: url) { phase in
        switch phase {
        case .success(let img):
          img.resizable().scaledToFill()
        default:
          avatarFallback
        }
      }
      .frame(width: 36, height: 36)
      .clipShape(Circle())
      .overlay(Circle().stroke(Color.white.opacity(0.4), lineWidth: 1))
    } else {
      avatarFallback
        .frame(width: 36, height: 36)
        .clipShape(Circle())
    }
  }

  private var avatarFallback: some View {
    ZStack {
      Color.gray.opacity(0.6)
      Text(String((hostName.isEmpty ? roomName : hostName).prefix(1)).uppercased())
        .font(.system(size: 16, weight: .bold))
        .foregroundColor(.white)
    }
  }

  private var bottomBar: some View {
    HStack(spacing: 10) {
      // Comment input placeholder (real chat overlay coming later)
      HStack {
        // TODO: wire to LiveChatOverlay JS-equivalent. For now this is a
        // visual placeholder — typing here doesn't post anywhere.
        TextField("", text: $commentDraft, prompt: Text("Add comment…").foregroundColor(.white.opacity(0.6)))
          .foregroundColor(.white)
          .font(.system(size: 14))
          .submitLabel(.send)
        if !commentDraft.isEmpty {
          Button(action: { commentDraft = "" }) {
            Image(systemName: "paperplane.fill")
              .font(.system(size: 14))
              .foregroundColor(.white)
          }
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(Color.white.opacity(0.15))
      .cornerRadius(22)
      .overlay(
        RoundedRectangle(cornerRadius: 22)
          .stroke(Color.white.opacity(0.25), lineWidth: 1)
      )

      // Heart
      Button(action: sendLike) {
        Image(systemName: "heart.fill")
          .font(.system(size: 20, weight: .bold))
          .foregroundColor(.pink)
          .frame(width: 44, height: 44)
          .background(Color.black.opacity(0.45))
          .clipShape(Circle())
      }

      // Share (placeholder — TODO wire to UIActivityViewController)
      Button(action: { /* TODO: present share sheet */ }) {
        Image(systemName: "square.and.arrow.up")
          .font(.system(size: 20, weight: .semibold))
          .foregroundColor(.white)
          .frame(width: 44, height: 44)
          .background(Color.black.opacity(0.45))
          .clipShape(Circle())
      }
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
      .padding(.trailing, 70)
      .padding(.bottom, 100)
      .allowsHitTesting(false)
    }
  }

  // ----- Actions ---------------------------------------------------------

  private func connect() async {
    await controller.connect(
      url: url,
      token: token,
      roomName: roomName,
      role: .viewer
    )
  }

  private func handleClose() {
    Task {
      await controller.disconnect(reason: "viewer_close")
      onClose()
    }
  }

  private func sendLike() {
    // pick a color from the brand palette (same as JS HEART_COLORS)
    let palette = ["#ff4d6d", "#ff7eb9", "#ff006e", "#c70039", "#ef4444"]
    let color = palette.randomElement() ?? "#ff4d6d"
    controller.sendLike(color: color)
    spawnLocalHeart(color: color)
  }

  /// Spawn a heart on our own screen so the tap feels responsive (mirrors
  /// the TikTok-style optimistic effect on the JS side).
  private func spawnLocalHeart(color: String) {
    let id = UUID()
    let fx = HeartFx(id: id, color: color, xOffset: 0, yOffset: 0, opacity: 1.0)
    hearts.append(fx)
    withAnimation(.easeOut(duration: 1.6)) {
      if let idx = hearts.firstIndex(where: { $0.id == id }) {
        hearts[idx].yOffset = -240
        hearts[idx].xOffset = CGFloat.random(in: -25...25)
        hearts[idx].opacity = 0.0
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.7) {
      hearts.removeAll { $0.id == id }
    }
  }
}
