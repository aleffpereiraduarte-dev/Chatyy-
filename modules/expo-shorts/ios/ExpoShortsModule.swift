import ExpoModulesCore

// -----------------------------------------------------------------------------
// ExpoShortsModule — Stage 2 (2026-05-16)
//
// Wires the native Shorts/Reels player on iOS:
//   - prefetchShortsVideo binds the URL to a pooled AVPlayer (paused).
//   - releasePool tears down all 3 AVPlayer instances.
//   - View prop setters route through AVPoolManager.
// -----------------------------------------------------------------------------

public class ExpoShortsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoShorts")

    AsyncFunction("prefetchShortsVideo") { (id: String, url: String) in
      AVPoolManager.shared.prefetch(urlString: url)
      NSLog("[ExpoShorts] prefetchShortsVideo: id=\(id) url=\(url)")
    }

    AsyncFunction("releasePool") {
      AVPoolManager.shared.release()
      NSLog("[ExpoShorts] releasePool: drained")
    }

    OnDestroy {
      AVPoolManager.shared.release()
    }

    View(ShortsPlayerView.self) {
      Events("onPlaybackReady", "onBuffering", "onError")

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
    }
  }
}
