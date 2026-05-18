import ExpoModulesCore
import AVFoundation

// -----------------------------------------------------------------------------
// ExpoShortsModule — Stage 2/3 (2026-05-16, 2026-05-18)
//
// Wires the native Shorts/Reels player on iOS:
//   - prefetchShortsVideo binds the URL to a pooled AVPlayer (paused).
//   - releasePool tears down all 3 AVPlayer instances.
//   - View prop setters route through AVPoolManager.
//
// Stage 3 additions:
//   - seek(viewTag, ms) — drives the JS scrubber.
//   - setAudioSessionPlayback / restoreAudioSession — TikTok parity, audio
//     keeps playing on lock screen / app background.
//   - View now emits `onTime` (~8fps) for the scrubber.
// -----------------------------------------------------------------------------

public class ExpoShortsModule: Module {
  // Remember the session state we found so restore() doesn't over-step into
  // settings the caller never picked.
  private var savedCategory: AVAudioSession.Category?
  private var savedMode: AVAudioSession.Mode?
  private var savedOptions: AVAudioSession.CategoryOptions = []
  private var didActivatePlayback: Bool = false

  public func definition() -> ModuleDefinition {
    Name("ExpoShorts")

    AsyncFunction("prefetchShortsVideo") { (id: String, url: String) in
      AVPoolManager.shared.prefetch(urlString: url)
      NSLog("[ExpoShorts] prefetchShortsVideo: id=\(id) url=\(url)")
    }

    AsyncFunction("releasePool") {
      AVPoolManager.shared.releaseAll()
      NSLog("[ExpoShorts] releasePool: drained")
    }

    // Switch AVAudioSession to .playback so Reels audio continues over the
    // lock screen and survives Spotify/podcast handoff the way TikTok does.
    // Idempotent: subsequent calls are a no-op.
    AsyncFunction("setAudioSessionPlayback") { [weak self] () -> Void in
      guard let self = self else { return }
      let s = AVAudioSession.sharedInstance()
      if !self.didActivatePlayback {
        self.savedCategory = s.category
        self.savedMode = s.mode
        self.savedOptions = s.categoryOptions
      }
      do {
        try s.setCategory(.playback, mode: .moviePlayback, options: [])
        try s.setActive(true, options: [])
        self.didActivatePlayback = true
        NSLog("[ExpoShorts] AVAudioSession → .playback")
      } catch {
        NSLog("[ExpoShorts] setAudioSessionPlayback error: \(error.localizedDescription)")
      }
    }

    // Roll the AVAudioSession back to whatever it was before Reels mounted.
    AsyncFunction("restoreAudioSession") { [weak self] () -> Void in
      guard let self = self else { return }
      guard self.didActivatePlayback else { return }
      let s = AVAudioSession.sharedInstance()
      do {
        if let cat = self.savedCategory {
          try s.setCategory(cat, mode: self.savedMode ?? .default, options: self.savedOptions)
        }
        try s.setActive(false, options: [.notifyOthersOnDeactivation])
      } catch {
        NSLog("[ExpoShorts] restoreAudioSession error: \(error.localizedDescription)")
      }
      self.didActivatePlayback = false
      self.savedCategory = nil
      self.savedMode = nil
      self.savedOptions = []
    }

    OnDestroy {
      AVPoolManager.shared.releaseAll()
    }

    View(ShortsPlayerView.self) {
      Events("onPlaybackReady", "onBuffering", "onError", "onTime")

      Prop("videoUrl") { (view: ShortsPlayerView, value: String?) in
        view.setVideoUrl(value)
      }

      Prop("playWhenInFocus") { (view: ShortsPlayerView, value: Bool?) in
        view.setPlayWhenInFocus(value ?? false)
      }

      Prop("muted") { (view: ShortsPlayerView, value: Bool?) in
        view.setMuted(value ?? true) // default muted (WhatsApp/IG)
      }

      Prop("playbackRate") { (view: ShortsPlayerView, value: Double?) in
        view.setPlaybackRate(value ?? 1.0)
      }

      // View-bound async function (Expo Modules dispatches to the view by its
      // RN tag). Drives the JS scrubber by seeking the bound AVPlayer.
      AsyncFunction("seek") { (view: ShortsPlayerView, ms: Double) in
        view.seek(toMillis: ms)
      }
    }
  }
}
