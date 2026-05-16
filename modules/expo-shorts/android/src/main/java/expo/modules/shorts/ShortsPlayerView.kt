package expo.modules.shorts

import android.content.Context
import android.graphics.Color
import android.util.Log
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

// Event payload records (must be `Record` subclasses with @Field annotated
// properties — Expo Modules serialises them via reflection).
class BufferingEventPayload(
  @Field val progress: Double
) : Record

class ErrorEventPayload(
  @Field val message: String
) : Record

// -----------------------------------------------------------------------------
// ShortsPlayerView — Stage 2 (2026-05-16)
//
// Wraps a media3 PlayerView whose Player is loaned from ExoPoolManager.
// View itself is stateless — all heavy lifting (ExoPlayer construction,
// MediaSource, buffering) lives in the singleton pool.
//
// Lifecycle:
//   - Prop setVideoUrl arrives    → ask pool for a player for that URL,
//                                    attach our PlayerView to it, install
//                                    listener, evaluate play/pause.
//   - Prop setPlayWhenInFocus     → flip playWhenReady on the bound player.
//                                    Player stays attached so re-focus is
//                                    instant.
//   - View detaches               → DO NOT release the player (it's pooled).
//                                    Just detach the surface so the same
//                                    player can drive a different PlayerView
//                                    in a different reel.
//
// Fallback: if anything in the pool path throws, we fall back to the Stage 1
// black placeholder text. The reel just won't play but the feed won't crash.
// -----------------------------------------------------------------------------

@UnstableApi
class ShortsPlayerView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {

  companion object {
    private const val TAG = "ShortsPlayerView"
  }

  private val onPlaybackReady by EventDispatcher<Unit>()
  private val onBuffering by EventDispatcher<BufferingEventPayload>()
  private val onError by EventDispatcher<ErrorEventPayload>()

  private val container: FrameLayout
  private val playerView: PlayerView
  private val fallbackLabel: TextView

  private var videoUrl: String? = null
  private var playWhenInFocus: Boolean = false
  private var muted: Boolean = true // WhatsApp/IG default
  private var playbackRate: Double = 1.0

  private var boundPlayer: ExoPlayer? = null

  /**
   * One Player.Listener instance, rebound across players. Captures `this` so
   * it can dispatch events to JS.
   */
  private val listener = object : Player.Listener {
    override fun onPlaybackStateChanged(state: Int) {
      when (state) {
        Player.STATE_READY -> {
          onPlaybackReady(Unit)
        }
        Player.STATE_BUFFERING -> {
          // We don't have a precise progress value from media3 here; we
          // emit 0 so the JS spinner can decide its own animation. JS
          // layer treats any onBuffering call as "still loading".
          onBuffering(BufferingEventPayload(progress = 0.0))
        }
        else -> { /* IDLE / ENDED — no-op */ }
      }
    }

    override fun onPlayerError(error: PlaybackException) {
      Log.w(TAG, "onPlayerError: ${error.errorCodeName} ${error.message}")
      onError(ErrorEventPayload(message = error.message ?: error.errorCodeName))
    }
  }

  init {
    container = FrameLayout(context).apply {
      setBackgroundColor(Color.BLACK)
      layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    }

    playerView = PlayerView(context).apply {
      useController = false // Reels has no transport controls
      setShutterBackgroundColor(Color.BLACK)
      resizeMode = androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_ZOOM
      layoutParams = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
      )
    }

    fallbackLabel = TextView(context).apply {
      text = "Shorts player"
      setTextColor(Color.WHITE)
      textSize = 14f
      val lp = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.WRAP_CONTENT,
        FrameLayout.LayoutParams.WRAP_CONTENT
      )
      lp.gravity = Gravity.CENTER
      layoutParams = lp
      visibility = android.view.View.GONE
    }

    container.addView(playerView)
    container.addView(fallbackLabel)
    addView(container)
  }

  // ---------------------------------------------------------------------------
  // prop setters (called from ExpoShortsModule)
  // ---------------------------------------------------------------------------

  fun setVideoUrl(url: String?) {
    if (url == videoUrl && boundPlayer != null) return
    videoUrl = url
    if (url.isNullOrBlank()) {
      detachPlayer()
      return
    }
    attachPlayerForUrl(url)
  }

  fun setPlayWhenInFocus(enabled: Boolean) {
    playWhenInFocus = enabled
    boundPlayer?.playWhenReady = enabled
  }

  fun setMuted(value: Boolean) {
    muted = value
    boundPlayer?.volume = if (value) 0f else 1f
  }

  fun setPlaybackRate(rate: Double) {
    playbackRate = rate
    try {
      boundPlayer?.setPlaybackSpeed(rate.toFloat())
    } catch (t: Throwable) {
      Log.w(TAG, "setPlaybackRate failed: ${t.message}")
    }
  }

  // ---------------------------------------------------------------------------
  // view lifecycle
  // ---------------------------------------------------------------------------

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    // Detach the surface so the player can be reused elsewhere, but do NOT
    // release — the pool owns it.
    detachPlayer()
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private fun attachPlayerForUrl(url: String) {
    try {
      val player = ExoPoolManager.getPlayerForUrl(context, url)
      // If this is the same player we already had (e.g. re-focus), just
      // resync prop state.
      if (boundPlayer !== player) {
        // Unhook old listener from previous player.
        boundPlayer?.removeListener(listener)
        boundPlayer = player
        player.addListener(listener)
      }
      playerView.player = player
      player.volume = if (muted) 0f else 1f
      try { player.setPlaybackSpeed(playbackRate.toFloat()) } catch (_: Throwable) {}
      player.playWhenReady = playWhenInFocus
      fallbackLabel.visibility = android.view.View.GONE
      playerView.visibility = android.view.View.VISIBLE
    } catch (t: Throwable) {
      Log.e(TAG, "attachPlayerForUrl failed, falling back to placeholder", t)
      playerView.visibility = android.view.View.GONE
      fallbackLabel.visibility = android.view.View.VISIBLE
      onError(ErrorEventPayload(message = t.message ?: "pool init failed"))
    }
  }

  private fun detachPlayer() {
    try {
      boundPlayer?.removeListener(listener)
    } catch (_: Throwable) {}
    boundPlayer = null
    playerView.player = null
  }
}
