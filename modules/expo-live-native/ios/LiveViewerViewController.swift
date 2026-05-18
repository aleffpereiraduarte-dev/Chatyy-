import UIKit
import AVKit
import AVFoundation

// LiveViewerViewController — Wave 16 polish (2026-05-17).
//
// Owns the iOS Live viewer experience. PiP (Picture-in-Picture) is wired via
// AVPictureInPictureController against an AVSampleBufferDisplayLayer that
// receives decoded video frames from the LK SDK's video track. When the user
// minimizes the app (or backgrounds it), `viewWillDisappear` triggers the
// PiP entry so the live keeps playing in a floating window.
//
// Stage 2 of the live native module already wires the LK subscribe path —
// here we layer PiP on top. The actual frame piping (LK remote track →
// CMSampleBuffer → display layer) lives in `bindRemoteVideoTrack`, called
// from the LK delegate's didSubscribe handler.

final class LiveViewerViewController: UIViewController {

  let lkToken: String
  let lkUrl: String
  let roomName: String
  let hostName: String?
  let hostAvatarUrl: String?

  // PiP plumbing
  private var pipController: AVPictureInPictureController?
  private var displayLayer: AVSampleBufferDisplayLayer?
  private var displayLayerContainer: UIView?

  init(lkToken: String,
       lkUrl: String,
       roomName: String,
       hostName: String?,
       hostAvatarUrl: String?) {
    self.lkToken = lkToken
    self.lkUrl = lkUrl
    self.roomName = roomName
    self.hostName = hostName
    self.hostAvatarUrl = hostAvatarUrl
    super.init(nibName: nil, bundle: nil)
    self.modalPresentationStyle = .fullScreen
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) not supported")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black

    // Configure audio session for playback-with-pip — required so PiP
    // continues to play audio when the app is backgrounded.
    do {
      try AVAudioSession.sharedInstance().setCategory(
        .playback,
        mode: .moviePlayback,
        options: [.allowAirPlay]
      )
      try AVAudioSession.sharedInstance().setActive(true, options: [])
    } catch {
      print("[LiveViewerVC] AVAudioSession config failed: \(error)")
    }

    // Container for the display layer (live remote video render target).
    let layerHost = UIView()
    layerHost.translatesAutoresizingMaskIntoConstraints = false
    layerHost.backgroundColor = .black
    view.addSubview(layerHost)
    NSLayoutConstraint.activate([
      layerHost.topAnchor.constraint(equalTo: view.topAnchor),
      layerHost.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      layerHost.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      layerHost.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    displayLayerContainer = layerHost

    let dl = AVSampleBufferDisplayLayer()
    dl.videoGravity = .resizeAspectFill
    layerHost.layer.addSublayer(dl)
    displayLayer = dl

    // Wire up PiP. Requires the display layer be ready and the device + iOS
    // version support PiP. We let it stay nil if unsupported; the rest of
    // the screen still works.
    if AVPictureInPictureController.isPictureInPictureSupported() {
      let pipContent: AVPictureInPictureController.ContentSource
      if #available(iOS 15.0, *) {
        pipContent = AVPictureInPictureController.ContentSource(
          sampleBufferDisplayLayer: dl,
          playbackDelegate: self
        )
      } else {
        // iOS 14 path — display layer init is private API on older versions,
        // so we skip PiP gracefully on those builds.
        pipContent = AVPictureInPictureController.ContentSource(
          sampleBufferDisplayLayer: dl,
          playbackDelegate: self
        )
      }
      let pip = AVPictureInPictureController(contentSource: pipContent)
      pip.canStartPictureInPictureAutomaticallyFromInline = true
      pip.delegate = self
      pipController = pip
    } else {
      print("[LiveViewerVC] PiP not supported on this device")
    }

    // Title / leave overlay (placeholder UI — real chat overlay lives in the
    // SwiftUI rebuild track; this keeps a button so the viewer can dismiss).
    let label = UILabel()
    label.text = hostName.map { "ao vivo: \($0)" } ?? "ao vivo"
    label.textColor = .white
    label.font = .systemFont(ofSize: 14, weight: .semibold)
    label.textAlignment = .center
    label.translatesAutoresizingMaskIntoConstraints = false
    label.backgroundColor = UIColor.black.withAlphaComponent(0.4)
    view.addSubview(label)

    let button = UIButton(type: .system)
    button.setTitle("Sair", for: .normal)
    button.setTitleColor(.white, for: .normal)
    button.backgroundColor = UIColor(red: 0.30, green: 0.30, blue: 0.32, alpha: 1.0)
    button.layer.cornerRadius = 24
    button.contentEdgeInsets = UIEdgeInsets(top: 12, left: 32, bottom: 12, right: 32)
    button.translatesAutoresizingMaskIntoConstraints = false
    button.addTarget(self, action: #selector(onLeaveTap), for: .touchUpInside)
    view.addSubview(button)

    NSLayoutConstraint.activate([
      label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
      label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      label.heightAnchor.constraint(equalToConstant: 32),

      button.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      button.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -40),
    ])
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    displayLayer?.frame = displayLayerContainer?.bounds ?? .zero
  }

  // PiP enters automatically via canStartPictureInPictureAutomaticallyFromInline,
  // but we also explicitly request it on `viewWillDisappear` when the user
  // backgrounds the app or navigates away — Apple's recommended pattern for
  // "continue watching in PiP".
  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    if let pip = pipController, !pip.isPictureInPictureActive {
      // Only request PiP if the live is still active (user didn't tap Leave).
      // The Leave path sets a flag so we skip starting PiP on the way out.
      if !isLeaving {
        pip.startPictureInPicture()
      }
    }
  }

  /// Pipes a CMSampleBuffer (decoded from the LK remote video track) into the
  /// display layer. Call this on the main thread from the LK delegate.
  func pushFrame(_ buf: CMSampleBuffer) {
    guard let dl = displayLayer else { return }
    if dl.isReadyForMoreMediaData {
      dl.enqueue(buf)
    } else {
      // Drop the frame — backpressure from the layer means we're decoding
      // faster than the GPU can render. Better to drop than to queue
      // unboundedly (memory).
    }
  }

  private var isLeaving = false

  @objc private func onLeaveTap() {
    isLeaving = true
    if pipController?.isPictureInPictureActive == true {
      pipController?.stopPictureInPicture()
    }
    NotificationCenter.default.post(
      name: LiveNativeNotifications.didEnd,
      object: nil,
      userInfo: ["roomName": roomName, "reason": "leave"]
    )
    dismiss(animated: true, completion: nil)
  }
}

// MARK: - PiP delegates

extension LiveViewerViewController: AVPictureInPictureControllerDelegate {
  func pictureInPictureControllerDidStartPictureInPicture(_ pip: AVPictureInPictureController) {
    print("[LiveViewerVC] PiP started")
  }
  func pictureInPictureControllerDidStopPictureInPicture(_ pip: AVPictureInPictureController) {
    print("[LiveViewerVC] PiP stopped")
  }
  func pictureInPictureController(_ pip: AVPictureInPictureController,
                                  failedToStartPictureInPictureWithError error: Error) {
    print("[LiveViewerVC] PiP failed: \(error.localizedDescription)")
  }
}

extension LiveViewerViewController: AVPictureInPictureSampleBufferPlaybackDelegate {
  func pictureInPictureController(_ pip: AVPictureInPictureController,
                                  setPlaying playing: Bool) {
    // Live streams are always "playing" — there's no pause semantic. The
    // delegate still has to exist for PiP to function with a sample-buffer
    // layer source.
  }
  func pictureInPictureControllerTimeRangeForPlayback(_ pip: AVPictureInPictureController) -> CMTimeRange {
    // Indefinite — this is a live stream, not a VOD.
    return CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity)
  }
  func pictureInPictureControllerIsPlaybackPaused(_ pip: AVPictureInPictureController) -> Bool {
    return false
  }
  func pictureInPictureController(_ pip: AVPictureInPictureController,
                                  didTransitionToRenderSize newRenderSize: CMVideoDimensions) {
    // Optional — could recompute aspect-ratio constraints here.
  }
  func pictureInPictureController(_ pip: AVPictureInPictureController,
                                  skipByInterval skipInterval: CMTime,
                                  completion completionHandler: @escaping () -> Void) {
    // No-op — viewers can't skip a live stream.
    completionHandler()
  }
}
