package expo.modules.shorts

import android.util.Log
import androidx.media3.common.util.UnstableApi
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// -----------------------------------------------------------------------------
// ExpoShortsModule — Stage 2 (2026-05-16)
//
// Wires the native Shorts/Reels player. Stage 2 changes:
//   - prefetchShortsVideo now binds the URL to a free ExoPlayer in
//     ExoPoolManager and calls prepare() (no play).
//   - releasePool tears the whole pool down — call from JS on memory
//     warning / unmount of the Reels feed.
//   - View prop setters route through the pooled players.
// -----------------------------------------------------------------------------

@UnstableApi
class ExpoShortsModule : Module() {

  companion object {
    private const val TAG = "ExpoShorts"
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoShorts")

    // Warm-up the player pool for `url`. Stage 1 was a no-op log.
    AsyncFunction("prefetchShortsVideo") { id: String, url: String ->
      try {
        val ctx = appContext.reactContext ?: return@AsyncFunction
        ExoPoolManager.prefetch(ctx, url)
        Log.d(TAG, "prefetchShortsVideo: id=$id url=$url")
      } catch (t: Throwable) {
        Log.w(TAG, "prefetchShortsVideo failed: ${t.message}")
      }
    }

    // Cleanup hook — call when the user navigates away from Reels.
    AsyncFunction("releasePool") {
      try {
        ExoPoolManager.release()
        Log.d(TAG, "releasePool: pool released")
      } catch (t: Throwable) {
        Log.w(TAG, "releasePool failed: ${t.message}")
      }
    }

    // Audio-session helpers — iOS sets AVAudioSession.playback so lock-screen
    // audio keeps going. Android handles that via the MediaSession + audio
    // focus in ExoPlayer, which is already on by default. We expose stubs so
    // the JS surface is platform-agnostic.
    AsyncFunction("setAudioSessionPlayback") {
      Log.d(TAG, "setAudioSessionPlayback: noop on Android (ExoPlayer handles focus)")
    }

    AsyncFunction("restoreAudioSession") {
      Log.d(TAG, "restoreAudioSession: noop on Android")
    }

    // Module lifecycle: drain the pool when the module is destroyed by RN
    // (full reload / app teardown).
    OnDestroy {
      try {
        ExoPoolManager.release()
      } catch (_: Throwable) {}
    }

    View(ShortsPlayerView::class) {
      Events("onPlaybackReady", "onBuffering", "onError", "onTime")

      Prop("videoUrl") { view: ShortsPlayerView, value: String? ->
        view.setVideoUrl(value)
      }

      Prop("playWhenInFocus") { view: ShortsPlayerView, value: Boolean? ->
        view.setPlayWhenInFocus(value == true)
      }

      Prop("muted") { view: ShortsPlayerView, value: Boolean? ->
        // Default true (WhatsApp/IG start muted)
        view.setMuted(value ?: true)
      }

      Prop("playbackRate") { view: ShortsPlayerView, value: Double? ->
        view.setPlaybackRate(value ?: 1.0)
      }

      // View-bound async function: drives the JS scrubber by seeking the
      // pooled ExoPlayer attached to this surface.
      AsyncFunction("seek") { view: ShortsPlayerView, ms: Double ->
        view.seekToMs(ms)
      }
    }
  }
}
