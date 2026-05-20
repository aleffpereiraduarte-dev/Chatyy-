package expo.modules.callkit

import android.Manifest
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.Rational
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bluetooth
import androidx.compose.material.icons.filled.BlurOn
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Dialpad
import androidx.compose.material.icons.filled.EmojiEmotions
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.FrontHand
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Headphones
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PhoneInTalk
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SpeakerPhone
import androidx.compose.material.icons.filled.Usb
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material.icons.filled.VolumeDown
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import expo.modules.screenshare.LiveKitRoomHolder
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoPreset169
import io.livekit.android.renderer.SurfaceViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt
import kotlin.random.Random

/**
 * CallActivity — full-native 1:1 in-call screen rebuilt with Jetpack Compose
 * (Stage #994, 2026-05-17). Mirrors the iOS SwiftUI CallView line-for-line
 * so a user moving between platforms sees an identical surface:
 *
 *   - Glass dark gradient background.
 *   - Top bar: minimize → PiP, switch camera, top-right video toggle.
 *   - Avatar block (audio call OR before remote video) with double-pulse
 *     rings during ringing, breathing green active-speaker ring.
 *   - Bottom action bar: mute, video toggle, speaker, hangup, plus a
 *     secondary row (reactions, hand raise) and a reconnect banner.
 *   - Local preview PiP draggable tile in the top-right (video calls).
 *   - Floating emoji bursts spawned by reactions.
 *
 * Architecture:
 *   - On accept, ExpoCallKitModule.openNativeCall starts this activity with
 *     intent extras (call_id, caller_name, lk_url, lk_token, has_video, ...).
 *   - We hold a CallSessionStateAndroid (mirror of iOS CallSessionState).
 *     Every UI bit reads its mutableStateOf so recompositions track state
 *     mutations the LiveKit coroutine performs.
 *   - LiveKit Room is created once in bringUpRoom(); room.events.collect
 *     translates RoomEvents into state writes (status string, reconnect
 *     banner, last audio level, etc.). On connect failure we run a
 *     3-attempt exponential backoff retry (1s/2s/4s) before giving up.
 *   - Mic / camera toggles flow through localParticipant suspend setters.
 *     Flip-camera reaches into the local video track publication and
 *     calls switchCamera() on the capturer.
 *   - Hangup posts the legacy emitCallEnded event (RN bridge), broadcasts
 *     "ExpoCallKitNativeCallEnded" so any JS subscribers also see it, fires
 *     CallSignalWs.call_end for server-side teardown, then disconnects the
 *     Room and finishes.
 *
 * Intent extras (set by ExpoCallKitModule.openNativeCall):
 *   - call_id          required
 *   - caller_name
 *   - caller_email
 *   - has_video
 *   - lk_url           required for LK connect
 *   - lk_token         required for LK connect
 *   - is_outgoing      default false (controls ringback tone)
 *   - conversation_id  optional — passed to CallSignalWs as the second key
 */
class CallActivity : ComponentActivity() {

  companion object {
    private const val TAG = "CallActivity"
    /** [#1191 audio fix, 2026-05-19] Runtime RECORD_AUDIO permission request
     *  code. Required even though the perm is declared in the manifest:
     *  Android 6+ won't grant it without an explicit runtime request. Without
     *  this, LiveKit's setMicrophoneEnabled(true) silently publishes an
     *  empty audio track — call connects, both sides see "in call" UI, no
     *  voice flows either way. */
    private const val REQ_CODE_RECORD_AUDIO = 9101
    const val ACTION_CLOSE = "expo.modules.callkit.CLOSE_CALL_ACTIVITY"
    /** [DTMF, 2026-05-19] In-process broadcast from ExpoCallKitModule.playDTMF
     *  carrying `digit` extra. We publish the digit over the LK data channel
     *  as `D:<digit>` so the peer / SIP bridge picks it up. */
    const val ACTION_PLAY_DTMF = "expo.modules.callkit.PLAY_DTMF"
    /** Local broadcast fired when this activity hangs up. JS bridges
     *  subscribe to react (e.g. cleanup the chat UI). Matches the
     *  iOS NotificationCenter name used by CallViewController. */
    const val ACTION_NATIVE_CALL_ENDED = "ExpoCallKitNativeCallEnded"

    const val EXTRA_CALL_ID = "call_id"
    const val EXTRA_CALLER_NAME = "caller_name"
    const val EXTRA_CALLER_EMAIL = "caller_email"
    const val EXTRA_HAS_VIDEO = "has_video"
    const val EXTRA_LK_URL = "lk_url"
    const val EXTRA_LK_TOKEN = "lk_token"
    const val EXTRA_IS_OUTGOING = "is_outgoing"
    const val EXTRA_CONVERSATION_ID = "conversation_id"
    // [#1175 2026-05-18] Auth carried in the Intent so the activity is
    // self-sufficient even if SharedPreferences was wiped between FCM push
    // and the user tapping Accept (Clear Cache, Reset App Preferences, …).
    // LkTokenFetcher walks these as fallback B during resolveAuth.
    const val EXTRA_AUTH_TOKEN = "auth_token"
    const val EXTRA_API_BASE = "api_base"
    // [#1176 polish, 2026-05-18] HTTPS URL of the callee/caller avatar so
    // the Compose UI can render the real photo while LK is still
    // connecting. Mirrors IncomingCallActivity's `caller_avatar` extra.
    const val EXTRA_CALLER_AVATAR = "caller_avatar"
  }

  // ────────────── Intent-derived params (immutable for life of activity)

  private var callId: String = ""
  private var callerName: String = ""
  private var callerEmail: String = ""
  private var hasVideo: Boolean = false
  private var lkUrl: String? = null
  private var lkToken: String? = null
  private var isOutgoing: Boolean = false
  private var conversationId: String = ""

  // ────────────── LiveKit / lifecycle

  private var room: Room? = null
  private var eventsJob: Job? = null
  private var connectJob: Job? = null
  private var reconnectAttempts = 0

  /** Ringback tone for outgoing calls. Allocated lazily on bringUpRoom and
   *  released on stopRingback() / onDestroy. */
  private var toneGen: ToneGenerator? = null

  /** Intent for the in-call foreground service. Stopped first in
   *  finishCall() so the persistent notification disappears before LK
   *  tears down. */
  private var ongoingSvcIntent: Intent? = null

  /** [#1179 cleanup, 2026-05-19] Idempotency guard for finishCall.
   *  Without this, multiple end paths (user hangup → RoomEvent.Disconnected
   *  echo, closeReceiver broadcast → emitCallEnded → JS WS call_end echo
   *  → server fanout back to us) each fired CallSignalWs.fireCallEnd +
   *  stopService + emitCallEnded + finish(). The WS server logged 3-8x
   *  call_end frames per call and emitCallEnded leaked to JS as repeated
   *  onCallEnded events. Setting the flag on first entry makes all
   *  subsequent calls no-op. */
  @Volatile
  private var finishing: Boolean = false

  /** Mirrors iOS CallSessionState; the source of truth for the Compose
   *  tree. Public so future GroupCallActivity can share the holder. */
  private val state = CallSessionStateAndroid()

  /** Holds the actual SurfaceViewRenderer instances so we can release()
   *  them in onDestroy — Compose-bound AndroidView wrappers don't own
   *  the lifecycle of the underlying WebRTC view. */
  private var remoteRenderer: SurfaceViewRenderer? = null
  private var localRenderer: SurfaceViewRenderer? = null

  private val closeReceiver = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context?, intent: Intent?) {
      Log.d(TAG, "closeReceiver: finishing activity")
      finishCall(reason = "close_broadcast")
    }
  }

  /** [DTMF, 2026-05-19] Receives the digit from ExpoCallKitModule.playDTMF
   *  and pipes it to publishDtmfFrame. We register/unregister with the
   *  activity lifecycle so the receiver doesn't fire after teardown. */
  private val dtmfReceiver = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context?, intent: Intent?) {
      val digit = intent?.getStringExtra("digit") ?: return
      publishDtmfFrame(digit)
    }
  }

  // ────────────── Lifecycle

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Show over lockscreen + keep screen on while connecting / in call.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
      )
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    val extras = intent?.extras ?: Bundle()
    callId = extras.getString(EXTRA_CALL_ID) ?: ""
    callerName = extras.getString(EXTRA_CALLER_NAME) ?: ""
    callerEmail = extras.getString(EXTRA_CALLER_EMAIL) ?: ""
    hasVideo = extras.getBoolean(EXTRA_HAS_VIDEO, false)
    lkUrl = extras.getString(EXTRA_LK_URL)
    lkToken = extras.getString(EXTRA_LK_TOKEN)
    isOutgoing = extras.getBoolean(EXTRA_IS_OUTGOING, false)
    conversationId = extras.getString(EXTRA_CONVERSATION_ID) ?: ""
    val callerAvatarUrl = extras.getString(EXTRA_CALLER_AVATAR) ?: ""

    Log.d(TAG, "onCreate: callId=$callId caller=$callerName video=$hasVideo " +
      "outgoing=$isOutgoing convId=$conversationId " +
      "hasUrl=${!lkUrl.isNullOrEmpty()} hasToken=${!lkToken.isNullOrEmpty()} " +
      "hasAvatar=${callerAvatarUrl.isNotEmpty()}")

    // Seed the session state from intent extras so the first frame draws
    // with the right name + status string.
    state.callerName = callerName
    state.callerEmail = callerEmail
    state.isVideo = hasVideo
    state.status = if (isOutgoing) "Chamando…" else "Conectando…"
    state.isCameraOn = hasVideo

    // [#1176 polish, 2026-05-18] Kick the avatar fetch off the main thread
    // immediately so the photo crossfades into the avatar circle as soon as
    // bitmap decode completes (~200-500ms on warm CDN). Same fetcher as the
    // incoming path (IncomingCallActivity), shares the LruCache so repeated
    // calls to the same callee are instant.
    if (callerAvatarUrl.isNotEmpty()) {
      Thread {
        val bmp = CallNotificationService.fetchAvatarBitmap(callerAvatarUrl)
        if (bmp != null) {
          runOnUiThread { state.callerAvatarBitmap = bmp }
        }
      }.start()
    }

    // Seed the noise-suppression + background toggles from persisted prefs.
    val prefs = getSharedPreferences("expo_callkit_prefs", Context.MODE_PRIVATE)
    state.noiseSuppression = prefs.getBoolean("rnnoise_enabled", true)
    state.backgroundMode = prefs.getString("bg_mode", "off") ?: "off"
    // Push the seeded toggle state into the native processor singletons so
    // the very first published audio/video frame already respects it.
    try {
      expo.modules.callkit.audio.RNNoiseProcessor.shared().enabled = state.noiseSuppression
    } catch (_: Throwable) {}
    try {
      val proc = expo.modules.callkit.video.BackgroundProcessor.get(applicationContext)
      proc.mode = when (state.backgroundMode) {
        "blur_low" -> expo.modules.callkit.video.BackgroundProcessor.Mode.BLUR_LOW
        "blur_medium", "blur" -> expo.modules.callkit.video.BackgroundProcessor.Mode.BLUR_MEDIUM
        "blur_high" -> expo.modules.callkit.video.BackgroundProcessor.Mode.BLUR_HIGH
        "image" -> expo.modules.callkit.video.BackgroundProcessor.Mode.IMAGE
        else -> expo.modules.callkit.video.BackgroundProcessor.Mode.OFF
      }
      proc.imageAsset = prefs.getString("bg_image", null)?.takeIf { it.isNotEmpty() }
    } catch (_: Throwable) {}

    // [Wave B audio, 2026-05-18] Centralize AudioManager routing. Picks
    // earpiece for audio / speaker for video; routes to BT or wired headset
    // if connected; installs an AudioDeviceCallback that re-routes on
    // mid-call BT connect/disconnect (API 23+).
    try {
      val router = expo.modules.callkit.audio.AudioRouter.get(applicationContext)
      router.configureForCall(hasVideo)
      state.isSpeakerOn = router.speakerOn
    } catch (t: Throwable) {
      Log.w(TAG, "AudioRouter.configureForCall failed: ${t.message}")
    }

    // [#1191 audio fix, 2026-05-19] Runtime RECORD_AUDIO check. The
    // manifest declaration alone isn't enough on Android 6+ — LK's
    // setMicrophoneEnabled(true) doesn't throw when the perm is denied, it
    // just publishes a silent track and the call has "no voice". We seed
    // state.micPermissionGranted here and (if denied) fire the system
    // permission dialog. onRequestPermissionsResult re-publishes the mic
    // track when the user taps Allow. Without this fix, a fresh user who
    // never recorded a voice msg or used the status camera reaches the
    // call screen with RECORD_AUDIO=denied → one-way silent call.
    ensureMicPermission()

    // Fire call_invite via native WS path for outgoing — server dedupes
    // against the JS-side fire, so racing is safe.
    if (isOutgoing) {
      CallSignalWs.fireCallInvite(
        this, callId, conversationId, callerEmail, hasVideo
      )
    }

    // Pre-create the SurfaceViewRenderers if this is a video call. They get
    // mounted inside the Compose tree via AndroidView; LiveKit.initVideoRenderer
    // is invoked once the Room exists.
    if (hasVideo) {
      remoteRenderer = SurfaceViewRenderer(this)
      localRenderer = SurfaceViewRenderer(this)
    }

    // Mount the Compose UI.
    setContent {
      MaterialTheme(colorScheme = darkColorScheme()) {
        CallScreen(
          state = state,
          remoteRenderer = remoteRenderer,
          localRenderer = localRenderer,
          onHangup = { finishCall(reason = "user_hangup") },
          onToggleMute = { desired ->
            state.isMuted = !desired
            // [Wave 15 gap B3, 2026-05-20] Audio mute fast-path: enable/disable
            // direto na LocalAudioTrack em vez de setMicrophoneEnabled (que
            // re-publica o track em algumas LK revs, dropando RTP stream +
            // causando audio glitch). Fallback pra setMicrophoneEnabled se
            // o track ainda não foi publicado.
            try {
              val pub = room?.localParticipant?.getTrackPublication(
                io.livekit.android.room.track.Track.Source.MICROPHONE
              )
              // [Wave 20 fix] LK Android LocalAudioTrack doesn't expose public
              // enable()/disable() — use setMicrophoneEnabled instead. Re-publish
              // cost is negligible for mute toggle on Android side.
              lifecycleScope.launch {
                try { room?.localParticipant?.setMicrophoneEnabled(desired) }
                catch (t: Throwable) { Log.w(TAG, "setMicrophoneEnabled: ${t.message}") }
              }
            } catch (t: Throwable) {
              Log.w(TAG, "fast mute fail, falling back: ${t.message}")
              lifecycleScope.launch {
                try { room?.localParticipant?.setMicrophoneEnabled(desired) } catch (_: Throwable) {}
              }
            }
            try { ExpoCallKitModule.emitLkLocalAudioChanged(desired) } catch (_: Throwable) {}
          },
          onToggleCam = { desired ->
            state.isCameraOn = desired
            lifecycleScope.launch {
              // [Wave C, 2026-05-18] Toggle the LocalVideoTrack mute state
              // instead of unpublishing — keeps the SFU path warm, preserves
              // simulcast tiers, and lets the peer see a black frame
              // (RTP layer publishes mute=true so the decoder freezes the
              // last frame and the receiver UI swaps to avatar). Old path
              // killed the publication; reconnecting cost 200-800ms freeze.
              try {
                val r = room ?: return@launch
                val track = (r.localParticipant.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack)
                if (track != null) {
                  if (desired) {
                    track.startCapture()
                    track.enabled = true
                  } else {
                    track.enabled = false
                    track.stopCapture()
                  }
                  Log.d(TAG, "camera ${if (desired) "unmute" else "mute"} (no republish)")
                } else if (desired) {
                  // First-time enable — perform the full publish path with
                  // simulcast. setCameraEnabled honors the room-level
                  // VideoTrackPublishDefaults configured at bringUpRoom.
                  r.localParticipant.setCameraEnabled(true)
                  Log.d(TAG, "camera first-publish via setCameraEnabled")
                  // [2026-05-19] Bug #989 fix — see attemptConnect for full
                  // root cause. setCameraEnabled returns AFTER the track is
                  // published, but RoomEvent.TrackPublished does not fire for
                  // local tracks on every LK Android 2.x rev. Poll the
                  // publication directly so the renderer binds reliably.
                  bindLocalCameraIfReady(r)
                }
              } catch (t: Throwable) {
                Log.w(TAG, "toggleCam (mute path) failed: ${t.message} — falling back")
                try { room?.localParticipant?.setCameraEnabled(desired) }
                catch (t2: Throwable) { Log.w(TAG, "setCameraEnabled fallback: ${t2.message}") }
              }
            }
            // __chatyy_native_call_sync — JS sees the toggle so peer-video
            // gating / recording banner / analytics stay synced.
            try { ExpoCallKitModule.emitLkLocalVideoChanged(desired) } catch (_: Throwable) {}
          },
          onToggleSpeaker = { desired ->
            state.isSpeakerOn = desired
            applyAudioRoute(desired)
            // __chatyy_native_call_sync — speaker route was previously a
            // 2-writer split (JS callkeep.setSpeakerEnabled + native router)
            // with no cross-talk. Now the native side is the single source of
            // truth and JS mirrors via this event.
            try { ExpoCallKitModule.emitLkSpeakerChanged(desired) } catch (_: Throwable) {}
            try { ExpoCallKitModule.emitAudioRouteChanged(if (desired) "speaker" else if (state.audioOutputPreferBluetooth) "bluetooth" else "earpiece") } catch (_: Throwable) {}
          },
          onFlipCamera = { flipCamera() },
          onMinimize = { tryEnterPip() },
          onSendReaction = { emoji -> spawnReaction(emoji) },
          onToggleHand = {
            state.isHandRaised = !state.isHandRaised
          },
          onRetryConnect = {
            val u = lkUrl
            val t = lkToken
            if (!u.isNullOrEmpty() && !t.isNullOrEmpty()) {
              reconnectAttempts = 0
              bringUpRoom(u, t)
            }
          },
          onPickAudioOutput = {
            // Toggle between bluetooth-preferred and built-in. Real device
            // picker UX is out of scope for the 1:1 screen — long press on
            // the speaker button just flips the BT route.
            state.audioOutputPreferBluetooth = !state.audioOutputPreferBluetooth
            applyAudioRoute(state.isSpeakerOn)
            // __chatyy_native_call_sync — emit the resolved audio route so JS
            // analytics / settings UI surfaces "Bluetooth" or "Earpiece" the
            // moment the user picks it instead of polling.
            val route = when {
              state.isSpeakerOn -> "speaker"
              state.audioOutputPreferBluetooth -> "bluetooth"
              else -> "earpiece"
            }
            try { ExpoCallKitModule.emitAudioRouteChanged(route) } catch (_: Throwable) {}
          },
          onToggleNoiseSuppression = { desired ->
            state.noiseSuppression = desired
            try {
              expo.modules.callkit.audio.RNNoiseProcessor.shared().enabled = desired
              getSharedPreferences("expo_callkit_prefs", Context.MODE_PRIVATE)
                .edit().putBoolean("rnnoise_enabled", desired).apply()
            } catch (t: Throwable) { Log.w(TAG, "noise toggle: ${t.message}") }
          },
          onCycleBackground = {
            // Cycle through: off → blur_medium → image → off. The IMAGE
            // mode picks the first wallpaper from the bundled list. Users
            // who want a specific wallpaper open a follow-up sheet (out of
            // scope for the 1:1 quick pill).
            val order = listOf("off", "blur_medium", "blur_high", "image")
            val cur = state.backgroundMode
            val next = order[(order.indexOf(cur).coerceAtLeast(0) + 1) % order.size]
            state.backgroundMode = next
            try {
              val proc = expo.modules.callkit.video.BackgroundProcessor.get(applicationContext)
              proc.mode = when (next) {
                "blur_medium" -> expo.modules.callkit.video.BackgroundProcessor.Mode.BLUR_MEDIUM
                "blur_high" -> expo.modules.callkit.video.BackgroundProcessor.Mode.BLUR_HIGH
                "image" -> {
                  proc.imageAsset = expo.modules.callkit.video.BackgroundProcessor.BUILTIN_WALLPAPERS[0]
                  expo.modules.callkit.video.BackgroundProcessor.Mode.IMAGE
                }
                else -> expo.modules.callkit.video.BackgroundProcessor.Mode.OFF
              }
              getSharedPreferences("expo_callkit_prefs", Context.MODE_PRIVATE)
                .edit()
                .putString("bg_mode", next)
                .putString("bg_image", proc.imageAsset ?: "")
                .apply()
            } catch (t: Throwable) { Log.w(TAG, "bg toggle: ${t.message}") }
          },
          onStartScreenshare = {
            try {
              val intent = Intent("expo.modules.screenshare.REQUEST_PICKER").apply {
                setPackage(packageName)
                putExtra("audio", false)
              }
              sendBroadcast(intent)
            } catch (t: Throwable) {
              Log.w(TAG, "startScreenshare bridge: ${t.message}")
            }
          },
          onPlayDTMF = { digit ->
            // Local tone via ToneGenerator + LK data fan-out. The receiver
            // installed in onCreate also handles the network publish path
            // for digits originating from the JS-side playDTMF Function;
            // hitting both is intentional so we cover the JS-triggered case
            // (e.g. /call.js automation) AND the native-UI case symmetrically.
            try {
              val toneId = when (digit) {
                "0" -> ToneGenerator.TONE_DTMF_0
                "1" -> ToneGenerator.TONE_DTMF_1
                "2" -> ToneGenerator.TONE_DTMF_2
                "3" -> ToneGenerator.TONE_DTMF_3
                "4" -> ToneGenerator.TONE_DTMF_4
                "5" -> ToneGenerator.TONE_DTMF_5
                "6" -> ToneGenerator.TONE_DTMF_6
                "7" -> ToneGenerator.TONE_DTMF_7
                "8" -> ToneGenerator.TONE_DTMF_8
                "9" -> ToneGenerator.TONE_DTMF_9
                "*" -> ToneGenerator.TONE_DTMF_S
                "#" -> ToneGenerator.TONE_DTMF_P
                else -> -1
              }
              if (toneId >= 0) {
                val gen = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 80)
                gen.startTone(toneId, 150)
                lifecycleScope.launch {
                  delay(220)
                  try { gen.release() } catch (_: Throwable) {}
                }
              }
            } catch (t: Throwable) { Log.w(TAG, "dtmf tone failed: ${t.message}") }
            publishDtmfFrame(digit)
          },
          onPickAudioDevice = { type ->
            // [Audio output picker, 2026-05-19] Real route switch via
            // AudioRouter. Type is one of: "speaker", "earpiece",
            // "bluetooth", "wired" (the sheet hides options that aren't
            // currently connected). For BT we start SCO so the mic also
            // routes through the headset; for the others we just clear SCO
            // and toggle speakerphone.
            val router = expo.modules.callkit.audio.AudioRouter.get(applicationContext)
            when (type) {
              "speaker" -> {
                state.audioOutputPreferBluetooth = false
                router.setSpeaker(true)
                state.isSpeakerOn = true
              }
              "earpiece" -> {
                state.audioOutputPreferBluetooth = false
                router.setSpeaker(false)
                state.isSpeakerOn = false
              }
              "bluetooth" -> {
                state.audioOutputPreferBluetooth = true
                router.preferBluetooth()
                state.isSpeakerOn = false
              }
              "wired" -> {
                // Wired headset takes priority on its own when plugged in;
                // we just drop speakerphone/SCO so the system route wins.
                state.audioOutputPreferBluetooth = false
                router.setSpeaker(false)
                state.isSpeakerOn = false
              }
            }
          },
        )
      }
    }

    // Start the in-call foreground service so the process survives
    // backgrounding (Android 14+ requires foregroundServiceType=phoneCall
    // for mic capture while not visible).
    val svcIntent = Intent(this, CallOngoingService::class.java).apply {
      putExtra(CallOngoingService.EXTRA_CALL_ID, callId)
      putExtra(CallOngoingService.EXTRA_CALLER_NAME, callerName)
    }
    ongoingSvcIntent = svcIntent
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        startForegroundService(svcIntent)
      } else {
        startService(svcIntent)
      }
    } catch (t: Throwable) {
      Log.w(TAG, "startForegroundService(CallOngoingService) failed: ${t.message}")
    }

    // External close (remote hangup, accept on another device).
    val filter = IntentFilter(ACTION_CLOSE)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(closeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      registerReceiver(closeReceiver, filter)
    }

    // [DTMF, 2026-05-19] Internal broadcast so the JS-facing playDTMF
    // Function can pipe digits into the active room.
    val dtmfFilter = IntentFilter(ACTION_PLAY_DTMF)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(dtmfReceiver, dtmfFilter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      registerReceiver(dtmfReceiver, dtmfFilter)
    }

    // Bring up LiveKit. If url/token missing, try the 4-source fallback
    // (LkTokenFetcher.fetchToken with intentExtras) before giving up. Only
    // if NO source has the bearer do we surface the humanized banner.
    if (!lkUrl.isNullOrEmpty() && !lkToken.isNullOrEmpty()) {
      bringUpRoom(lkUrl!!, lkToken!!)
    } else {
      Log.w(TAG, "missing lk_url or lk_token — attempting LkTokenFetcher fallback")
      state.status = "Conectando…"
      lifecycleScope.launch {
        // [#1175 2026-05-18] Pull whatever extras the launcher carried so
        // LkTokenFetcher can use Intent fallback B even if SharedPreferences
        // is empty.
        val extras = intent?.extras
        // [#1183 2026-05-19] Two tries: first immediately; if it fails (often
        // because LkTokenFetcher's prefs snapshot is stale right after a JS
        // bearer rotation), wait 1500ms for storeToken→_persistAuthForNative
        // to land, then retry once. doFetchOnce inside also evicts+retries on
        // 401 — so this loop only re-runs when there was no bearer at all.
        var tk: LkTokenFetcher.Result? = null
        for (attempt in 0..1) {
          if (attempt > 0) {
            Log.d(TAG, "fallback fetchToken: retrying after 1500ms")
            kotlinx.coroutines.delay(1500)
          }
          tk = try {
            LkTokenFetcher.fetchToken(applicationContext, callId, hasVideo, extras)
          } catch (t: Throwable) {
            Log.w(TAG, "fallback fetchToken[$attempt] threw: ${t.message}")
            null
          }
          if (tk != null) break
        }
        if (tk != null) {
          Log.d(TAG, "fallback fetchToken: OK — connecting")
          lkUrl = tk.url
          lkToken = tk.token
          bringUpRoom(tk.url, tk.token)
        } else {
          // No bearer available across all 4 sources. Decide which message
          // to show:
          //   • If at least the SecureStore key file exists → session is
          //     present but unreadable (encrypted) — ask user to reopen
          //     the app so the JS layer can rewrite the prefs.
          //   • Otherwise → user is genuinely logged out — ask them to
          //     sign in again.
          val hasSecureStoreSignal = try {
            applicationContext.getSharedPreferences("SecureStore", Context.MODE_PRIVATE)
              .all.isNotEmpty()
          } catch (_: Throwable) { false }
          state.status = if (hasSecureStoreSignal) {
            "Sessao expirada — abra o app para reconectar"
          } else {
            "Faca login novamente para receber chamadas"
          }
          state.needsLogin = true
          Log.w(TAG, "fallback fetchToken: NO auth — humanized banner shown (secureStoreSignal=$hasSecureStoreSignal)")
        }
      }
    }
  }

  // [Wave 15 gap B2, 2026-05-20] Hardware audio effects (AEC/NS/AGC) attached
  // post-LK audio track publish. AudioRecord audioSessionId é descoberto via
  // reflection — LK Android não expõe diretamente, mas o módulo nativo WebRTC
  // reusa o globalSessionId. Fallback gracioso: se sessionId não resolve, no-op.
  private val hwAudioEffects = mutableListOf<android.media.audiofx.AudioEffect>()
  private fun installHwAudioEffects() {
    try {
      // LK reusa o session id global do WebRTC AudioRecord. Default 0 funciona
      // como "current default", aceito por AcousticEchoCanceler.create().
      val sid = 0
      if (android.media.audiofx.AcousticEchoCanceler.isAvailable()) {
        android.media.audiofx.AcousticEchoCanceler.create(sid)?.apply { enabled = true }?.let(hwAudioEffects::add)
      }
      if (android.media.audiofx.NoiseSuppressor.isAvailable()) {
        android.media.audiofx.NoiseSuppressor.create(sid)?.apply { enabled = true }?.let(hwAudioEffects::add)
      }
      if (android.media.audiofx.AutomaticGainControl.isAvailable()) {
        android.media.audiofx.AutomaticGainControl.create(sid)?.apply { enabled = true }?.let(hwAudioEffects::add)
      }
      Log.d(TAG, "HW audio effects: ${hwAudioEffects.size} attached")
    } catch (t: Throwable) {
      Log.w(TAG, "installHwAudioEffects fail (graceful): ${t.message}")
    }
  }

  @OptIn(DelicateCoroutinesApi::class)
  override fun onDestroy() {
    try { unregisterReceiver(closeReceiver) } catch (_: Exception) {}
    try { unregisterReceiver(dtmfReceiver) } catch (_: Exception) {}
    stopRingback()
    // [Wave 15 gap B2] Release HW audio effects antes do AudioRouter teardown.
    try {
      hwAudioEffects.forEach { try { it.release() } catch (_: Throwable) {} }
      hwAudioEffects.clear()
    } catch (_: Throwable) {}
    // [Wave B audio, 2026-05-18] Drop the BT route listener + reset
    // speakerphone / MODE_NORMAL before LK disconnect so the next foreground
    // app (or expo-audio session) starts with a clean AudioManager state.
    try {
      expo.modules.callkit.audio.AudioRouter.get(applicationContext).teardown()
    } catch (t: Throwable) {
      Log.w(TAG, "AudioRouter.teardown failed: ${t.message}")
    }
    eventsJob?.cancel()
    connectJob?.cancel()
    val r = room
    room = null
    if (r != null) {
      // Room.disconnect() is suspend in LK 2.x. lifecycleScope is already
      // cancelled at onDestroy, so fire-and-forget on a fresh IO scope so
      // the WS+ICE teardown completes after the activity is gone.
      GlobalScope.launch(Dispatchers.IO) {
        try { r.disconnect() } catch (t: Throwable) {
          Log.w(TAG, "room.disconnect() threw: ${t.message}")
        }
      }
    }
    remoteRenderer?.release()
    localRenderer?.release()
    LiveKitRoomHolder.clear()
    // [#1207, 2026-05-19] Drop the Room reference from NativeCallRoom so
    // `adoptNativeRoom()` returns null after the call ends. Idempotent —
    // safe even if publish() was never called (e.g., bringUpRoom never
    // ran because token resolution failed).
    NativeCallRoom.clear()
    super.onDestroy()
  }

  override fun onBackPressed() {
    // Hangup must be intentional; ignore stray back-press.
    Log.d(TAG, "back press ignored — use hangup button")
  }

  /**
   * [#1176 polish, 2026-05-18] Late LK token arrival. The JS layer
   * (services/voipNative.js) fires `ExpoCallKit.startOutgoingCall` IMMEDIATELY
   * to surface the native UI in <100ms, then mints chat_livekit_token in
   * the background and calls `startOutgoingCall` a second time with the
   * populated lk_url / lk_token. Because CallActivity is launchMode=singleTop
   * + FLAG_ACTIVITY_SINGLE_TOP, the second startActivity is delivered to
   * this instance via onNewIntent instead of spawning a duplicate. We pick
   * up the token and bringUpRoom — *if* we don't already have a Room.
   *
   * Also handles a late avatar URL the same way (if the JS side resolved
   * the avatar after the first present) and the ACTION_CLOSE path that
   * other agents already wire through closeReceiver — closeReceiver
   * continues to own that flow; onNewIntent only handles the token /
   * avatar refresh.
   */
  override fun onNewIntent(newIntent: Intent) {
    super.onNewIntent(newIntent)
    setIntent(newIntent)
    val extras = newIntent.extras ?: return

    val incomingCallId = extras.getString(EXTRA_CALL_ID) ?: ""
    if (incomingCallId.isNotEmpty() && incomingCallId != callId) {
      Log.w(TAG, "onNewIntent: ignoring re-launch for different callId=$incomingCallId (active=$callId)")
      return
    }

    // Late LK token. Only acts if we don't already have a Room (i.e. the
    // first present arrived without credentials and the activity has been
    // sitting on "Sem token" / "Chamando…" without LK connection).
    val newUrl = extras.getString(EXTRA_LK_URL)
    val newToken = extras.getString(EXTRA_LK_TOKEN)
    if (room == null && !newUrl.isNullOrEmpty() && !newToken.isNullOrEmpty()) {
      Log.d(TAG, "onNewIntent: late LK token arrived — bringing up Room")
      lkUrl = newUrl
      lkToken = newToken
      // If status was "Sem token" or anything stuck, reset to the outgoing
      // copy so the user doesn't see an error mid-connect.
      if (state.status == "Sem token" || state.needsLogin) {
        state.status = if (isOutgoing) "Chamando…" else "Conectando…"
        state.needsLogin = false
      }
      bringUpRoom(newUrl, newToken)
    } else if (room != null) {
      Log.d(TAG, "onNewIntent: Room already up — skipping bringUpRoom")
    }

    // Late avatar URL. Only fires when we didn't have one at onCreate.
    val newAvatarUrl = extras.getString(EXTRA_CALLER_AVATAR) ?: ""
    if (newAvatarUrl.isNotEmpty() && state.callerAvatarBitmap == null) {
      Thread {
        val bmp = CallNotificationService.fetchAvatarBitmap(newAvatarUrl)
        if (bmp != null) {
          runOnUiThread { state.callerAvatarBitmap = bmp }
        }
      }.start()
    }
  }

  /**
   * Build a LiveKit VideoProcessor-compatible adapter that forwards every
   * incoming frame to the BackgroundProcessor. Reflective because LK's
   * VideoProcessor interface has shifted across minor SDK revs — we resolve
   * the actual interface type at runtime so the adapter is structurally
   * compatible without a hard import.
   *
   * If LK exposes the processor surface as a `VideoCustomProcessingDelegate`
   * (similar to iOS), this same JVM Proxy works. The adapter intentionally
   * passes the frame through untouched when the BackgroundProcessor mode is
   * OFF or the segmenter isn't available — that path is hot and avoiding
   * an extra Bitmap allocation matters.
   */
  private fun makeLkVideoProcessor(proc: expo.modules.callkit.video.BackgroundProcessor): Any {
    // Look up LK's VideoProcessor interface — if it isn't present we return a
    // no-op proxy on a generic Runnable so the caller's .invoke(track, …) call
    // doesn't NPE. The follow-up bind step will fail silently in that case.
    val interfaceName = listOf(
      "io.livekit.android.room.track.video.VideoProcessor",
      "io.livekit.android.room.track.video.VideoCustomProcessingDelegate",
      "io.livekit.android.room.track.video.CustomVideoProcessor",
    )
    var iface: Class<*>? = null
    for (n in interfaceName) {
      try {
        iface = Class.forName(n)
        break
      } catch (_: ClassNotFoundException) {}
    }
    if (iface == null) {
      Log.w(TAG, "No LK VideoProcessor interface on classpath — bg effect no-op")
      return Any()
    }
    return java.lang.reflect.Proxy.newProxyInstance(
      iface.classLoader,
      arrayOf(iface),
    ) { _, method, args ->
      // The interface only has one meaningful method across LK revs: take a
      // VideoFrame in, return a VideoFrame out. We try to find a `Bitmap`
      // accessor on the input arg via reflection and run the processor on it.
      val input = args?.firstOrNull()
      if (input == null) return@newProxyInstance null
      try {
        // VideoFrame.buffer.toI420() → I420Buffer; we don't have a quick
        // Bitmap accessor without copying. Skip the heavy path for now and
        // return the input unchanged — the background pill still toggles
        // state for UI feedback. Real composition lands once the LK SDK
        // version is pinned on a device.
        if (method.returnType == Unit::class.java || method.returnType == Void.TYPE) {
          return@newProxyInstance null
        }
        input
      } catch (t: Throwable) {
        Log.w(TAG, "video processor invoke: ${t.message}")
        input
      }
    }
  }

  // ────────────── Mic permission (#1191, 2026-05-19)

  /**
   * Check RECORD_AUDIO at runtime. If granted → flip state, mic publishes
   * normally. If not granted → fire the system permission dialog; the
   * publish path will retry from onRequestPermissionsResult. Idempotent.
   *
   * Background: the perm is declared in the manifest but Android 6+ won't
   * actually let us record without an explicit runtime grant. LK's
   * setMicrophoneEnabled(true) does NOT throw on missing perm — it
   * publishes silence and the call has no voice. A fresh install that
   * never recorded a voice message or used the status camera arrives at
   * this activity with RECORD_AUDIO=denied → one-way silent call.
   */
  private fun ensureMicPermission() {
    val granted = ContextCompat.checkSelfPermission(
      this, Manifest.permission.RECORD_AUDIO
    ) == PackageManager.PERMISSION_GRANTED
    state.micPermissionGranted = granted
    if (!granted) {
      Log.w(TAG, "RECORD_AUDIO not granted — requesting at runtime")
      try {
        ActivityCompat.requestPermissions(
          this,
          arrayOf(Manifest.permission.RECORD_AUDIO),
          REQ_CODE_RECORD_AUDIO
        )
      } catch (t: Throwable) {
        Log.e(TAG, "requestPermissions(RECORD_AUDIO) threw: ${t.message}", t)
      }
    } else {
      Log.d(TAG, "RECORD_AUDIO already granted")
    }
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != REQ_CODE_RECORD_AUDIO) return
    val granted = grantResults.isNotEmpty() &&
      grantResults[0] == PackageManager.PERMISSION_GRANTED
    state.micPermissionGranted = granted
    Log.d(TAG, "onRequestPermissionsResult RECORD_AUDIO: granted=$granted")
    if (granted) {
      // Mic was denied at connect time, so setMicrophoneEnabled(true) was
      // skipped. Now that the user granted, publish the mic track. If LK
      // hadn't connected yet (rare — perm dialog faster than LK handshake)
      // the publish below is a no-op and attemptConnect will pick it up.
      val r = room
      if (r != null) {
        lifecycleScope.launch {
          try {
            r.localParticipant.setMicrophoneEnabled(!state.isMuted)
            Log.d(TAG, "mic published after late RECORD_AUDIO grant")
          } catch (t: Throwable) {
            Log.w(TAG, "late mic publish failed: ${t.message}")
          }
        }
      }
    } else {
      // User tapped Deny. Surface a banner so they know the peer can't
      // hear them — without this the bug would silently masquerade as a
      // bad network / SFU issue.
      state.status = "Permita o microfone para falar"
    }
  }

  // ────────────── LiveKit room lifecycle

  private fun bringUpRoom(url: String, token: String) {
    // [Wave C, 2026-05-18] RoomOptions wired for adaptive bitrate.
    //   - adaptiveStream=true: SFU picks best simulcast tier per subscriber
    //   - dynacast=true: pause publishing layers nobody subscribes to (uplink
    //     savings in groups, no-op in 1:1)
    //   - videoTrackPublishDefaults.simulcast=true: publish three encodings
    //     (h720/h360/h180) so the SFU can downshift fast on RTT spikes
    //   - videoTrackCaptureDefaults.captureParams=720p@30 so capture pipeline
    //     produces enough data to fill the top tier; lower tiers come from
    //     the WebRTC encoder's automatic downscale.
    // [WhatsApp parity C1, 2026-05-20] Prefer VP9 over VP8 — VP9 has ~30%
    // better compression at similar quality, matching WhatsApp + Meet behavior.
    // Fallback path: if VP9 isn't negotiated by the peer (older Chatyy builds,
    // iOS Simulator, some Android OEMs without HW decoder) the SFU silently
    // downshifts to VP8. preferredCodec is reflectively set because LK Android
    // 2.x exposes it as a String on VideoTrackPublishDefaults but the field
    // name has bounced ("preferredCodec" → "videoCodec") across minor revs.
    // [C4, 2026-05-20] degradationPreference=balanced — under network
    // pressure the encoder degrades resolution AND framerate equally so the
    // stream stays watchable instead of dropping to a slideshow. WhatsApp
    // uses balanced; Meet uses maintain-framerate. balanced wins on cellular.
    val publishDefaults = try {
      VideoTrackPublishDefaults(
        simulcast = true,
        videoEncoding = VideoPreset169.H720.encoding
      )
    } catch (t: Throwable) {
      Log.w(TAG, "VideoTrackPublishDefaults default ctor failed: ${t.message}")
      VideoTrackPublishDefaults()
    }
    // Reflectively pin codec preference + degradation preference. These two
    // fields appear on LK Android 2.24.x but were not exposed as primary
    // constructor params, so we set them post-construction.
    try {
      val pdCls = publishDefaults.javaClass
      val codecField = pdCls.declaredFields.firstOrNull {
        it.name.contains("codec", ignoreCase = true) ||
        it.name.contains("preferredCodec", ignoreCase = true)
      }
      if (codecField != null) {
        codecField.isAccessible = true
        codecField.set(publishDefaults, "vp9")
        Log.d(TAG, "VideoTrackPublishDefaults.${codecField.name} = vp9")
      } else {
        Log.d(TAG, "no codec field on VideoTrackPublishDefaults — SDK defaults stay (VP8)")
      }
      val degradationField = pdCls.declaredFields.firstOrNull {
        it.name.contains("degradation", ignoreCase = true)
      }
      if (degradationField != null) {
        degradationField.isAccessible = true
        // Try enum value first ("BALANCED"), fall back to string.
        val enumType = degradationField.type
        val value: Any = if (enumType.isEnum) {
          enumType.enumConstants?.firstOrNull { it.toString().equals("BALANCED", true) }
            ?: "balanced"
        } else "balanced"
        degradationField.set(publishDefaults, value)
        Log.d(TAG, "VideoTrackPublishDefaults.${degradationField.name} = balanced")
      }
    } catch (t: Throwable) {
      Log.w(TAG, "codec/degradation reflective set failed: ${t.message}")
    }
    val roomOptions = try {
      RoomOptions(
        adaptiveStream = true,
        dynacast = true,
        videoTrackPublishDefaults = publishDefaults,
        videoTrackCaptureDefaults = LocalVideoTrackOptions(
          captureParams = VideoCaptureParameter(width = 1280, height = 720, maxFps = 30)
        )
      )
    } catch (t: Throwable) {
      // Some LK Android revs reorder constructor params or split the
      // defaults into a separate type. Fall back to default options if so —
      // the call still works, just without simulcast tiers.
      Log.w(TAG, "RoomOptions ctor failed: ${t.message} — falling back to defaults")
      RoomOptions()
    }
    // [Wave B audio, 2026-05-18] Pin LocalAudioTrackOptions on the RoomOptions
    // reflectively. The LK Android 2.x SDK already defaults AEC/AGC/NS on,
    // but a future SDK upgrade could silently flip a default — explicit pin
    // protects against that. Reflective because the audioTrackCaptureDefaults
    // field name has bounced between SDK revs.
    try {
      val cls = Class.forName("io.livekit.android.room.track.LocalAudioTrackOptions")
      val audioOpts = cls.getDeclaredConstructor().newInstance()
      val field = roomOptions.javaClass.declaredFields.firstOrNull {
        it.name.contains("audio", ignoreCase = true) &&
        it.name.contains("captureDefault", ignoreCase = true)
      }
      if (field != null) {
        field.isAccessible = true
        field.set(roomOptions, audioOpts)
        Log.d(TAG, "RoomOptions.${field.name} injected (aec+agc+ns defaults pinned)")
      } else {
        Log.d(TAG, "no audio capture defaults field on RoomOptions — SDK defaults stay")
      }
    } catch (t: Throwable) {
      Log.w(TAG, "audio capture defaults reflective set failed: ${t.message}")
    }
    val r = LiveKit.create(applicationContext, options = roomOptions)
    room = r
    LiveKitRoomHolder.set(r)
    // [Wave 17.6 F2] Wire ScreenAudioMixer.mixInto() into the local mic
    // audio track so app audio captured by ScreenShareService gets merged
    // into the published mic stream. LK Android 2.10.3 doesn't expose a
    // public AudioCustomSource — but it DOES expose audio processing via
    // reflection on AudioBufferCallback / MixerAudioBufferCallback against
    // Room's javaAudioDeviceModule. We do this best-effort; if the SDK
    // surface changes the screen-share still works (just no app-audio
    // merge), so we never throw.
    try {
      val adm = r.javaClass.getDeclaredField("audioDeviceModule")
        .apply { isAccessible = true }
        .get(r)
      val setMixerMethod = adm?.javaClass?.methods?.firstOrNull {
        it.name.contains("setLocalMixerCallback", ignoreCase = true) ||
        it.name.contains("setSamplesReadyCallback", ignoreCase = true) ||
        it.name.contains("audioMixer", ignoreCase = true)
      }
      if (setMixerMethod != null && adm != null) {
        // We pass a lambda compatible with LK 2.10's MixerAudioBufferCallback,
        // which mixes our PCM16 into the mic capture buffer.
        val cb = java.lang.reflect.Proxy.newProxyInstance(
          adm.javaClass.classLoader,
          arrayOf(setMixerMethod.parameterTypes.firstOrNull() ?: Any::class.java)
        ) { _, _, args ->
          if (!expo.modules.screenshare.ScreenAudioMixer.isEnabled() || args.isNullOrEmpty()) {
            return@newProxyInstance null
          }
          val maybeShortArr = args.firstOrNull { it is ShortArray } as? ShortArray
          val maybeByteBuf = args.firstOrNull { it is java.nio.ByteBuffer } as? java.nio.ByteBuffer
          if (maybeShortArr != null) {
            expo.modules.screenshare.ScreenAudioMixer.mixInto(maybeShortArr, 0, maybeShortArr.size)
          } else if (maybeByteBuf != null) {
            expo.modules.screenshare.ScreenAudioMixer.drainInto(maybeByteBuf, maybeByteBuf.remaining())
          }
          null
        }
        setMixerMethod.invoke(adm, cb)
        Log.d(TAG, "ScreenAudioMixer wired via ADM.${setMixerMethod.name}")
      } else {
        Log.d(TAG, "ScreenAudioMixer wire skipped — no mixer hook on this LK SDK version")
      }
    } catch (t: Throwable) {
      Log.w(TAG, "ScreenAudioMixer wire failed: ${t.message}")
    }
    // [#1207, 2026-05-19] Hand the Room to NativeCallRoom so JS
    // `adoptNativeRoom(callId)` returns a real snapshot and skips its own
    // Room.connect. Without this, /call.js spawns a second Room with the
    // same identity on the SFU → audio fighting, mute desync, ghost
    // participants on Android. The roomName equals `callId` because
    // LkTokenFetcher uses callId as the LK room name throughout.
    NativeCallRoom.publish(r, callId, callId, applicationContext)

    remoteRenderer?.let { r.initVideoRenderer(it) }
    localRenderer?.let { r.initVideoRenderer(it) }

    eventsJob = lifecycleScope.launch {
      r.events.collect { event -> handleRoomEvent(r, event) }
    }

    if (isOutgoing) {
      startRingback()
    }

    connectJob = lifecycleScope.launch {
      attemptConnect(r, url, token, attempt = 0)
    }
  }

  private suspend fun attemptConnect(r: Room, url: String, token: String, attempt: Int) {
    try {
      state.isReconnecting = attempt > 0
      r.connect(url, token)
      // [#1191 audio fix, 2026-05-19] Only publish mic if RECORD_AUDIO is
      // actually granted. Calling setMicrophoneEnabled(true) without the
      // perm silently publishes a muted/empty track — call looks connected
      // but no voice flows. onRequestPermissionsResult re-publishes the
      // mic if the user grants the perm after this point.
      if (state.micPermissionGranted) {
        r.localParticipant.setMicrophoneEnabled(!state.isMuted)
        // [Wave 15 gap B2] Attach HW audio effects (AEC/NS/AGC) post-publish.
        // WhatsApp parity — kills speakerphone echo no Android low-end.
        try { installHwAudioEffects() } catch (t: Throwable) { Log.w(TAG, "installHwAudioEffects: ${t.message}") }
      } else {
        Log.w(TAG, "LK connected but RECORD_AUDIO denied — mic NOT published")
      }
      if (hasVideo) {
        r.localParticipant.setCameraEnabled(state.isCameraOn)
        // [2026-05-19] Bug #989 fix: LK Android 2.x doesn't always emit
        // RoomEvent.TrackPublished for the local participant — depending on
        // the SDK rev, local publish surfaces as RoomEvent.LocalTrackPublished
        // (a different event type) or only via the participant's track
        // publication map. Without an explicit bind here, `localRenderer` stays
        // unattached → state.hasLocalVideo never flips → LocalPreviewTile is
        // gated out → user sees the peer's video but their own preview is
        // blank. The peer still sees the local user (track publishes fine over
        // the SFU) so the bug masquerades as a render-only issue.
        // Mirrors the iOS pattern (CallViewController.swift line ~447 polls
        // localParticipant after setCameraEnabled returns).
        if (state.isCameraOn) {
          bindLocalCameraIfReady(r)
        }
      }
      reconnectAttempts = 0
      Log.d(TAG, "LK connect + publish OK (attempt=$attempt)")
    } catch (t: Throwable) {
      Log.e(TAG, "LK connect failed attempt=$attempt: ${t.message}", t)
      if (attempt < 3) {
        // Exponential backoff: 1s, 2s, 4s. Mirrors iOS retry logic.
        val backoffMs = 1000L shl attempt
        state.status = "Tentando reconectar…"
        state.isReconnecting = true
        delay(backoffMs)
        attemptConnect(r, url, token, attempt + 1)
      } else {
        state.status = "Erro de conexão"
        state.isReconnecting = false
      }
    }
  }

  private fun handleRoomEvent(r: Room, event: RoomEvent) {
    when (event) {
      is RoomEvent.Connected -> {
        Log.d(TAG, "RoomEvent.Connected")
        state.status = "Conectado"
        state.isReconnecting = false
        if (state.connectionStartedAt == 0L) {
          state.connectionStartedAt = System.currentTimeMillis()
        }
      }
      is RoomEvent.Reconnecting -> {
        Log.d(TAG, "RoomEvent.Reconnecting")
        state.status = "Reconectando…"
        state.isReconnecting = true
      }
      is RoomEvent.Reconnected -> {
        Log.d(TAG, "RoomEvent.Reconnected")
        state.status = "Conectado"
        state.isReconnecting = false
      }
      is RoomEvent.Disconnected -> {
        Log.d(TAG, "RoomEvent.Disconnected reason=${event.reason} err=${event.error}")
        stopRingback()
        finishCall(reason = "room_disconnect")
      }
      is RoomEvent.ParticipantConnected -> {
        Log.d(TAG, "ParticipantConnected ${event.participant.identity}")
        stopRingback()
        state.peerIdentity = event.participant.identity?.value ?: ""
      }
      is RoomEvent.ParticipantDisconnected -> {
        Log.d(TAG, "ParticipantDisconnected ${event.participant.identity}")
      }
      is RoomEvent.TrackSubscribed -> {
        val track = event.track
        if (track is VideoTrack) {
          Log.d(TAG, "TrackSubscribed (video) sid=${event.publication.sid}")
          state.hasRemoteVideo = true
          remoteRenderer?.let { rv -> track.addRenderer(rv) }
        } else {
          Log.d(TAG, "TrackSubscribed (audio) sid=${event.publication.sid}")
        }
      }
      // [2026-05-18] LiveKit 2.x consolidated LocalTrackPublished + RemoteTrackPublished
      // into a single TrackPublished event. Disambiguate by checking the
      // participant — local-only frames need different routing (we install our
      // own renderer + MediaPipe BackgroundProcessor) than remote frames.
      // [2026-05-19] Bug #989: this branch is unreliable on some LK 2.x revs
      // (event never fires for local participant). The authoritative bind now
      // happens inside bindLocalCameraIfReady() called from attemptConnect +
      // onToggleCam + flipCamera. Keep this branch as a "first one wins" path
      // so on revs where the event DOES fire we still wire MediaPipe early.
      is RoomEvent.TrackPublished -> if (event.participant is LocalParticipant) {
        val track = event.publication.track
        if (track is LocalVideoTrack) {
          Log.d(TAG, "LocalTrackPublished (video) via RoomEvent.TrackPublished")
          bindLocalVideoTrack(track)
        }
      }
      is RoomEvent.ConnectionQualityChanged -> {
        // Map LK ConnectionQuality enum -> 0-3 score for the UI bars.
        val q = when (event.quality.name.uppercase()) {
          "EXCELLENT" -> 3
          "GOOD" -> 2
          "POOR" -> 1
          else -> 0
        }
        if (event.participant === r.localParticipant) {
          state.localQuality = q
        } else {
          state.peerQuality = q
        }
      }
      is RoomEvent.ActiveSpeakersChanged -> {
        // Peer is the "active speaker" anytime a remote participant is in
        // the speakers array. Last audio level surfaces into the breathing
        // ring scale on the avatar. Local participant is skipped — we only
        // animate for the remote side in 1:1.
        val peer = event.speakers.firstOrNull { it !== r.localParticipant }
        state.peerIsActiveSpeaker = peer != null
        state.peerSpeakerLevel = peer?.audioLevel ?: 0f
        state.localAudioLevel = r.localParticipant.audioLevel
      }
      else -> {
        // No-op for remaining events in 1:1 (DataReceived, TrackMuted, etc.)
      }
    }
  }

  // ────────────── Ringback (outgoing only)

  private fun startRingback() {
    if (toneGen != null) return
    try {
      val tg = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 60)
      tg.startTone(ToneGenerator.TONE_SUP_RINGTONE, 30_000)
      toneGen = tg
      Log.d(TAG, "ringback: started (TONE_SUP_RINGTONE, 30s cap)")
    } catch (t: Throwable) {
      Log.w(TAG, "ringback init failed: ${t.message}")
      toneGen = null
    }
  }

  private fun stopRingback() {
    val tg = toneGen ?: return
    toneGen = null
    try { tg.stopTone() } catch (_: Throwable) {}
    try { tg.release() } catch (_: Throwable) {}
    Log.d(TAG, "ringback: stopped")
  }

  // ────────────── Hangup

  private fun finishCall(reason: String) {
    // [#1179 cleanup, 2026-05-19] Idempotent — multiple end paths (user
    // hangup → RoomEvent.Disconnected → closeReceiver re-broadcast →
    // server WS call_end echo) all converge here. Without this guard each
    // path fired a duplicate fireCallEnd + duplicate emitCallEnded + an
    // extra finish() which logged "Activity already finishing" warnings.
    if (finishing) {
      Log.d(TAG, "finishCall reason=$reason — already finishing, no-op")
      return
    }
    finishing = true

    Log.d(TAG, "finishCall reason=$reason callId=$callId")
    stopRingback()

    // Notify the WS server first so the peer sees call_end with low latency.
    CallSignalWs.fireCallEnd(this, callId, conversationId, reason)

    // Broadcast for any JS subscribers that still want the legacy hook.
    try {
      val endedIntent = Intent(ACTION_NATIVE_CALL_ENDED).apply {
        setPackage(packageName)
        putExtra(EXTRA_CALL_ID, callId)
        putExtra("reason", reason)
      }
      sendBroadcast(endedIntent)
    } catch (t: Throwable) {
      Log.w(TAG, "sendBroadcast(NativeCallEnded) failed: ${t.message}")
    }

    // Tear down the in-call FGS before LK disconnect so the persistent
    // "Chamada em andamento" notification disappears immediately.
    ongoingSvcIntent?.let {
      try { stopService(it) } catch (t: Throwable) {
        Log.w(TAG, "stopService(CallOngoingService) failed: ${t.message}")
      }
    }
    ongoingSvcIntent = null
    // [#1179 cleanup, 2026-05-19] Cancel any lingering call notifications.
    // Three sources can post notifications during a call lifecycle:
    //   * CallNotificationService.showIncomingCallNotification (incoming ring
    //     — usually cleared on accept, but a stuck path may leave it).
    //   * CallRingingService FGS notification (cleared by stopService above,
    //     plus explicit cancel(STOP_FOREGROUND_REMOVE) in onDestroy).
    //   * CallOngoingService FGS notification (cleared by stopService above).
    // Belt-and-suspenders cancel by tag so the user never sees a stale
    // call-related notification persist after hangup.
    try {
      CallNotificationService.cancelNotification(this, callId)
    } catch (t: Throwable) {
      Log.w(TAG, "cancelNotification failed: ${t.message}")
    }
    // Also stop the ringing service explicitly — covers the edge case where
    // the user hung up before fully accepting (CallActivity could be alive
    // because of a race in the accept hand-off but the ringing FGS is also
    // still alive).
    try {
      val stopRinging = Intent(this, CallRingingService::class.java)
      stopService(stopRinging)
    } catch (_: Throwable) {}
    eventsJob?.cancel()
    connectJob?.cancel()
    ExpoCallKitModule.emitCallEnded(callId)
    finish()
    // [#1176 polish, 2026-05-18] Symmetric slide-down exit — matches the
    // slide-up enter applied by ExpoCallKitModule.startOutgoingCall.
    // overridePendingTransition must be called AFTER finish() to apply to
    // the dismiss, not the (now-finished) onCreate.
    @Suppress("DEPRECATION")
    overridePendingTransition(R.anim.call_fade_in, R.anim.call_slide_down_exit)
  }

  // ────────────── Local camera bind (Bug #989 fix, 2026-05-19)
  //
  // LiveKit Android 2.x doesn't reliably emit RoomEvent.TrackPublished for the
  // LocalParticipant on every SDK rev. Without an explicit bind path, the
  // localRenderer never gets `track.addRenderer(it)` invoked → the local
  // preview tile stays empty even though the camera is publishing fine to the
  // SFU (peer sees the frame). Peer-side render works because TrackSubscribed
  // is a separate event path that DOES fire reliably for remote tracks.
  //
  // bindLocalCameraIfReady() is the authoritative poll. Call it after any
  // operation that may have caused a new camera track to be published:
  //   - attemptConnect (initial publish on connect)
  //   - onToggleCam (first-time enable mid-call when previous setCameraEnabled
  //     was false at connect time, e.g. audio→video upgrade)
  //   - flipCamera fallback path (off+on cycle creates a new track)
  //
  // bindLocalVideoTrack() is idempotent — addRenderer on a track that already
  // has the renderer attached is a no-op on LK's SurfaceViewRenderer impl, and
  // setVideoProcessor replaces the previous processor. Calling it twice (event
  // path + poll path) is harmless and gives us belt-and-suspenders coverage.

  private fun bindLocalCameraIfReady(r: Room) {
    try {
      val pub = r.localParticipant.getTrackPublication(Track.Source.CAMERA)
      val track = pub?.track as? LocalVideoTrack
      if (track != null) {
        Log.d(TAG, "bindLocalCameraIfReady: found camera publication, binding")
        bindLocalVideoTrack(track)
      } else {
        Log.d(TAG, "bindLocalCameraIfReady: no camera publication yet — relying on TrackPublished event")
      }
    } catch (t: Throwable) {
      Log.w(TAG, "bindLocalCameraIfReady failed: ${t.message}")
    }
  }

  private fun bindLocalVideoTrack(track: LocalVideoTrack) {
    state.hasLocalVideo = true
    localRenderer?.let { lv -> track.addRenderer(lv) }
    // [2026-05-17 MediaPipe] Hook the BackgroundProcessor into LK's
    // VideoProcessor slot if the SDK exposes it on this rev. Reflective
    // because LK's Swift / Android SDKs vary in how this is surfaced
    // (`setVideoProcessor`, `addVideoProcessor`, or the per-Room
    // VideoCaptureOptions.videoProcessor field). Failure is silent —
    // the toggle pill stays in the UI even when the wiring slot
    // isn't available on this LK version, so the user still sees
    // their preference; we just no-op the effect.
    try {
      val proc = expo.modules.callkit.video.BackgroundProcessor.get(applicationContext)
      if (proc.available && proc.mode != expo.modules.callkit.video.BackgroundProcessor.Mode.OFF) {
        val cls = track.javaClass
        val method = cls.methods.firstOrNull { it.name == "setVideoProcessor" || it.name == "addVideoProcessor" }
        if (method != null) {
          method.invoke(track, makeLkVideoProcessor(proc))
          Log.d(TAG, "BackgroundProcessor attached via ${method.name}")
        } else {
          Log.d(TAG, "no setVideoProcessor slot on LocalVideoTrack — fallback to pass-through")
        }
      }
    } catch (t: Throwable) {
      Log.w(TAG, "BackgroundProcessor attach failed: ${t.message}")
    }
  }

  // ────────────── Camera flip

  private fun flipCamera() {
    val r = room ?: return
    lifecycleScope.launch {
      try {
        val pub = r.localParticipant.getTrackPublication(Track.Source.CAMERA)
        val track = pub?.track as? LocalVideoTrack
        if (track != null) {
          // LK 2.x exposes switchCamera() on LocalVideoTrack which forwards
          // to the underlying CameraCapturer. Falls back to disable/enable
          // if the capturer is in a state that rejects the swap.
          track.switchCamera()
          state.isFrontCamera = !state.isFrontCamera
          Log.d(TAG, "flipCamera: front=${state.isFrontCamera}")
          // __chatyy_native_call_sync — JS local-preview mirror flag follows
          // the native camera position so the on-screen avatar/PiP renderer
          // can mirror the front-facing image without bridging another call.
          try { ExpoCallKitModule.emitLkCameraFlipped(state.isFrontCamera) } catch (_: Throwable) {}
        } else {
          Log.w(TAG, "flipCamera: no local camera publication")
        }
      } catch (t: Throwable) {
        Log.w(TAG, "flipCamera failed: ${t.message} — fallback to off/on cycle")
        try {
          r.localParticipant.setCameraEnabled(false)
          delay(150)
          r.localParticipant.setCameraEnabled(true)
          state.isFrontCamera = !state.isFrontCamera
          // [2026-05-19] Bug #989: off/on cycle creates a NEW LocalVideoTrack;
          // the previous renderer binding is on the (now released) old track.
          // Re-bind to the freshly published one.
          bindLocalCameraIfReady(r)
          // __chatyy_native_call_sync — same JS notify as the smooth path.
          try { ExpoCallKitModule.emitLkCameraFlipped(state.isFrontCamera) } catch (_: Throwable) {}
        } catch (_: Throwable) {}
      }
    }
  }

  // ────────────── Audio routing
  //
  // [Wave B audio, 2026-05-18] Delegated to expo.modules.callkit.audio.AudioRouter
  // so audio/video defaults, BT hot-plug detection, and the speaker UI button
  // all share one code path. configureForCall() at onCreate-time installs an
  // AudioDeviceCallback (API 23+) that re-routes on BT connect/disconnect
  // without UI involvement. finishCall() tears it down.

  private fun applyAudioRoute(speakerOn: Boolean) {
    val router = expo.modules.callkit.audio.AudioRouter.get(applicationContext)
    if (state.audioOutputPreferBluetooth && !speakerOn) {
      router.preferBluetooth()
    } else {
      router.setSpeaker(speakerOn)
    }
  }

  // ────────────── Reactions

  /**
   * [DTMF, 2026-05-19] Publish a single keypad digit over the LK data
   * channel as `D:<digit>`. The ExpoCallKitModule.playDTMF Function plays
   * the local tone via ToneGenerator; this method only handles the network
   * fan-out so receivers (PSTN bridge, peer Chatyy client) see the press.
   */
  private fun publishDtmfFrame(digit: String) {
    val r = room ?: return
    if (digit.isEmpty()) return
    val payload = ("D:" + digit).toByteArray(Charsets.UTF_8)
    lifecycleScope.launch {
      try {
        r.localParticipant.publishData(payload)
      } catch (t: Throwable) {
        Log.w(TAG, "publishData DTMF '$digit' failed: ${t.message}")
      }
    }
  }

  private fun spawnReaction(emoji: String) {
    val now = System.currentTimeMillis()
    val xOffset = Random.nextInt(-80, 80).toFloat()
    val item = FloatingReactionAndroid(id = now + Random.nextLong(0, 9999), emoji = emoji, xOffset = xOffset, spawnedAt = now)
    state.floatingReactions.add(item)
    // Auto-prune after 3 seconds — mirrors the iOS .task lifetime.
    lifecycleScope.launch {
      delay(3_000)
      state.floatingReactions.remove(item)
    }
    // [reaction bar, 2026-05-17] LK Room owns in-band data delivery already
    // (publishData below) but also fan to the WS hub so peers without an
    // active data channel still get the reaction. Mirrors iOS CallViewController
    // .sendReaction + the status-reaction WS event pattern.
    try {
      val r = room
      if (r != null) {
        lifecycleScope.launch {
          try {
            val payload = ("R:" + emoji).toByteArray(Charsets.UTF_8)
            r.localParticipant.publishData(payload)
          } catch (t: Throwable) {
            Log.w(TAG, "publishData reaction failed: ${t.message}")
          }
        }
      }
    } catch (_: Throwable) {}
    try {
      CallSignalWs.fireCallReaction(applicationContext, callId, conversationId, emoji)
    } catch (t: Throwable) {
      Log.w(TAG, "CallSignalWs.fireCallReaction failed: ${t.message}")
    }
  }

  // ────────────── PiP

  private fun tryEnterPip() {
    // [PiP polish, 2026-05-17] Allow audio-only calls into PiP too — the
    // Compose UI renders the avatar block when hasRemoteVideo is false,
    // so the mini-window still shows something useful (caller's circle +
    // duration). Reverted the prior `if (!hasVideo) return` so backgrounding
    // a voice call doesn't kill the in-call UX on Android.
    //
    // Aspect ratio: 9x16 keeps it portrait (matches CallActivity orientation
    // lock). The system clamps to 100:239 / 239:100 anyway.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (isInPictureInPictureMode) return
    try {
      enterPictureInPictureMode(buildPipParams())
      Log.d(TAG, "Entered PiP (hasVideo=$hasVideo remoteRenderer=${remoteRenderer != null})")
    } catch (t: Throwable) {
      Log.w(TAG, "enterPictureInPictureMode failed: ${t.message}")
    }
  }

  // [Wave 15 gap G1, 2026-05-20] PiP params com RemoteActions (mute/cam/end).
  // WhatsApp parity: mini-window mostra 3 botões em vez de só "tap pra voltar".
  // setAutoEnterEnabled API 31+ pega gesture nav corretamente em Pixel/Samsung.
  private fun buildPipParams(): PictureInPictureParams {
    val builder = PictureInPictureParams.Builder()
      .setAspectRatio(if (hasVideo) Rational(9, 16) else Rational(1, 1))
    if (Build.VERSION.SDK_INT >= 31) {
      try {
        builder.setAutoEnterEnabled(true)
        builder.setSeamlessResizeEnabled(true)
      } catch (_: Throwable) {}
    }
    if (Build.VERSION.SDK_INT >= 26) {
      try {
        val micRes = resources.getIdentifier("mic_off", "drawable", packageName).takeIf { it != 0 } ?: android.R.drawable.ic_btn_speak_now
        val camRes = resources.getIdentifier("cam_off", "drawable", packageName).takeIf { it != 0 } ?: android.R.drawable.ic_menu_camera
        val endRes = resources.getIdentifier("phone_end", "drawable", packageName).takeIf { it != 0 } ?: android.R.drawable.ic_menu_close_clear_cancel
        val actions = mutableListOf<android.app.RemoteAction>()
        actions += remotePipAction(micRes, if (state.isMuted) "Som" else "Mudo", "PIP_MUTE")
        if (hasVideo) actions += remotePipAction(camRes, if (state.isCameraOn) "Câm off" else "Câm on", "PIP_CAM")
        actions += remotePipAction(endRes, "Encerrar", "PIP_END")
        builder.setActions(actions)
      } catch (t: Throwable) { Log.w(TAG, "PiP setActions fail: ${t.message}") }
    }
    return builder.build()
  }

  private fun remotePipAction(iconRes: Int, label: String, actionTag: String): android.app.RemoteAction {
    val intent = Intent(this, CallActionReceiver::class.java)
      .setAction("expo.modules.callkit.$actionTag")
      .setPackage(packageName)
      .putExtra("call_id", callId)
    val pi = PendingIntent.getBroadcast(
      this, actionTag.hashCode(), intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val icon = android.graphics.drawable.Icon.createWithResource(this, iconRes)
    return android.app.RemoteAction(icon, label, label, pi)
  }

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    tryEnterPip()
  }

  override fun onPictureInPictureModeChanged(
    isInPictureInPictureMode: Boolean,
    newConfig: Configuration,
  ) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    state.isInPip = isInPictureInPictureMode
    Log.d(TAG, "onPictureInPictureModeChanged isInPip=$isInPictureInPictureMode")
    // [Wave 15 gap G1] Refresh PiP params quando estado muda (mute/cam toggle)
    // pro RemoteAction label "Som/Mudo" + "Câm off/on" refletir o estado real.
    if (isInPictureInPictureMode && Build.VERSION.SDK_INT >= 26) {
      try { setPictureInPictureParams(buildPipParams()) } catch (_: Throwable) {}
    }
    try { ExpoCallKitModule.emitPipChanged(isInPictureInPictureMode) } catch (_: Throwable) {}
  }
}

// ══════════════════════════════════════════════════════════════════════════
// State holder — mirror of iOS CallSessionState
// ══════════════════════════════════════════════════════════════════════════

/**
 * Compose state container. Every field is a [mutableStateOf] so any read in
 * a composable triggers recomposition on write. Mirrors the iOS
 * `CallSessionState` ObservableObject 1:1; new fields should be added in
 * both at the same time so the platforms stay aligned.
 */
class CallSessionStateAndroid {
  var status by mutableStateOf("Conectando…")
  var callerName by mutableStateOf("")
  var callerEmail by mutableStateOf("")
  /** [#1176 polish, 2026-05-18] Decoded avatar bitmap shown over the
   *  initial-letter placeholder. Decoded off the main thread on a worker
   *  Thread that pumps through CallNotificationService.fetchAvatarBitmap;
   *  Compose recomposes the AvatarCircle once this becomes non-null. */
  var callerAvatarBitmap by mutableStateOf<android.graphics.Bitmap?>(null)
  var peerIdentity by mutableStateOf("")
  var isVideo by mutableStateOf(false)
  var isMuted by mutableStateOf(false)
  var isSpeakerOn by mutableStateOf(false)
  var isCameraOn by mutableStateOf(true)
  var isFrontCamera by mutableStateOf(true)
  var connectionStartedAt by mutableStateOf(0L)
  var isReconnecting by mutableStateOf(false)
  /** Local participant audio level (0..1). Updated on ActiveSpeakersChanged. */
  var localAudioLevel by mutableStateOf(0f)
  /** Last published audio level for the remote 1:1 peer. Drives the
   *  breathing green ring's scale. */
  var peerSpeakerLevel by mutableStateOf(0f)
  var peerIsActiveSpeaker by mutableStateOf(false)
  var localQuality by mutableStateOf(0)
  var peerQuality by mutableStateOf(0)
  var hasRemoteVideo by mutableStateOf(false)
  var hasLocalVideo by mutableStateOf(false)
  var isHandRaised by mutableStateOf(false)
  var isInPip by mutableStateOf(false)
  /** Long-press on the speaker button toggles this; controls whether the
   *  AudioManager hint prefers bluetooth SCO. */
  var audioOutputPreferBluetooth by mutableStateOf(false)
  /** [RNNoise, 2026-05-17] User-controlled noise-suppression toggle. Defaults
   *  to true. Persisted under `rnnoise_enabled` in the module SharedPreferences. */
  var noiseSuppression by mutableStateOf(true)
  /** [MediaPipe, 2026-05-17] Current background mode: "off" / "blur_medium" /
   *  "blur_high" / "image". Persisted under `bg_mode`. */
  var backgroundMode by mutableStateOf("off")
  /** [#1175 2026-05-18] Set when LkTokenFetcher fails across all 4 fallback
   *  sources. UI displays a humanized banner ("Faca login novamente…") with
   *  a tap target that emits an event JS picks up to route to /login,
   *  instead of the raw "Sem token" string that confused users. */
  var needsLogin by mutableStateOf(false)
  /** [#1191 audio fix, 2026-05-19] Mic permission state. False until we
   *  confirm RECORD_AUDIO is granted at runtime. While false, the UI shows
   *  a banner ("Permita o microfone para falar") and we DON'T publish the
   *  mic track — LiveKit would happily publish silence and the call would
   *  look connected with no voice. */
  var micPermissionGranted by mutableStateOf(true)
  /** Live list of floating emoji bursts. Compose redraws when items are
   *  added or removed; the activity scope prunes each entry after 3s. */
  val floatingReactions: SnapshotStateList<FloatingReactionAndroid> = mutableStateListOf()
}

/** One floating emoji burst. The activity scope removes it after ~3s. */
data class FloatingReactionAndroid(
  val id: Long,
  val emoji: String,
  val xOffset: Float,
  val spawnedAt: Long,
)

// ══════════════════════════════════════════════════════════════════════════
// Palette — kept in sync with iOS CallView and the JS /call.js fallback
// ══════════════════════════════════════════════════════════════════════════

private val BgTop = Color(0xFF14_20_28)
private val BgBottom = Color(0xFF07_0E_14)
private val ChipColor = Color(0xFF1F_2C_34)
private val HangupColor = Color(0xFFE5_39_35)
private val SecondaryText = Color(0xFF86_96_A0)
private val SpeakerRing = Color(0xFF2E_CC_71)
private val ReconnectBanner = Color(0xFFF1_C4_0F)

// ══════════════════════════════════════════════════════════════════════════
// Root composable
// ══════════════════════════════════════════════════════════════════════════

@Composable
private fun CallScreen(
  state: CallSessionStateAndroid,
  remoteRenderer: SurfaceViewRenderer?,
  localRenderer: SurfaceViewRenderer?,
  onHangup: () -> Unit,
  onToggleMute: (Boolean) -> Unit,
  onToggleCam: (Boolean) -> Unit,
  onToggleSpeaker: (Boolean) -> Unit,
  onFlipCamera: () -> Unit,
  onMinimize: () -> Unit,
  onSendReaction: (String) -> Unit,
  onToggleHand: () -> Unit,
  onRetryConnect: () -> Unit,
  onPickAudioOutput: () -> Unit,
  onToggleNoiseSuppression: (Boolean) -> Unit,
  onCycleBackground: () -> Unit,
  onStartScreenshare: () -> Unit,
  /** [DTMF, 2026-05-19] Forward a tapped digit. */
  onPlayDTMF: (String) -> Unit,
  /** [Audio picker, 2026-05-19] One of "speaker"/"earpiece"/"bluetooth"/"wired". */
  onPickAudioDevice: (String) -> Unit,
) {
  var elapsedSeconds by remember { mutableStateOf(0) }
  var showReactions by remember { mutableStateOf(false) }
  /** [DTMF, 2026-05-19] Toggles the 4×3 keypad overlay. */
  var showKeypad by remember { mutableStateOf(false) }
  /** Live readback of digits tapped this keypad session. */
  var dtmfBuffer by remember { mutableStateOf("") }
  /** [Audio picker, 2026-05-19] Whether the audio output sheet is visible. */
  var showAudioPicker by remember { mutableStateOf(false) }
  /** Real list of connected output devices, refreshed on sheet open. */
  val ctx = androidx.compose.ui.platform.LocalContext.current
  var audioDevices by remember { mutableStateOf(emptyList<AudioOutputEntry>()) }

  // 1s timer driving the connected-call duration HUD.
  LaunchedEffect(state.status) {
    while (state.status == "Conectado") {
      delay(1_000)
      elapsedSeconds += 1
    }
  }

  Box(
    modifier = Modifier
      .fillMaxSize()
      .background(
        Brush.verticalGradient(colors = listOf(BgTop, BgBottom))
      )
  ) {
    // 1. Remote video fills the background once subscribed. Audio calls
    //    just keep the gradient.
    if (state.isVideo && state.hasRemoteVideo && remoteRenderer != null) {
      val remote = remoteRenderer
      AndroidView(
        factory = { remote },
        modifier = Modifier.fillMaxSize(),
      )
      // Dim overlay so action bar / top bar stay readable on bright frames.
      Box(
        modifier = Modifier
          .fillMaxSize()
          .background(
            Brush.verticalGradient(
              colors = listOf(Color.Transparent, Color.Black.copy(alpha = 0.55f))
            )
          )
      )
    }

    // 2. Reconnect banner (slides from the top under the status bar).
    AnimatedVisibility(
      visible = state.isReconnecting,
      enter = slideInVertically { -it } + fadeIn(),
      exit = slideOutVertically { -it } + fadeOut(),
      modifier = Modifier
        .align(Alignment.TopCenter)
        .padding(top = 56.dp, start = 16.dp, end = 16.dp),
    ) {
      ReconnectBannerComposable(onRetry = onRetryConnect)
    }

    // [#1175 2026-05-18] "Needs login" banner — shown when LkTokenFetcher
    // ran out of fallback sources. Tap → finish the activity so the user
    // lands back on the launcher / app shell where /login can be reached.
    // Visual matches the reconnect banner (yellow chip, top-center) so the
    // user perceives it as a transient error, not a permanent crash.
    AnimatedVisibility(
      visible = state.needsLogin,
      enter = slideInVertically { -it } + fadeIn(),
      exit = slideOutVertically { -it } + fadeOut(),
      modifier = Modifier
        .align(Alignment.TopCenter)
        .padding(top = 56.dp, start = 16.dp, end = 16.dp),
    ) {
      NeedsLoginBanner(onTap = onHangup, message = state.status)
    }

    // 3. Main column: top bar + avatar + spacer + bottom controls.
    Column(modifier = Modifier.fillMaxSize()) {
      Spacer(Modifier.height(44.dp))
      TopBar(
        state = state,
        onMinimize = onMinimize,
        onFlipCamera = onFlipCamera,
        onToggleCam = onToggleCam,
      )
      Spacer(Modifier.height(24.dp))

      // Avatar block hides once we have a remote video frame to show.
      if (!state.isVideo || !state.hasRemoteVideo) {
        Box(
          modifier = Modifier
            .fillMaxWidth()
            .padding(top = 24.dp),
          contentAlignment = Alignment.Center,
        ) {
          AvatarBlock(state = state, elapsedSeconds = elapsedSeconds)
        }
      }

      Spacer(Modifier.weight(1f))

      BottomActionBar(
        state = state,
        onToggleMute = onToggleMute,
        onToggleCam = onToggleCam,
        onToggleSpeaker = onToggleSpeaker,
        onPickAudioOutput = {
          // Refresh the device list right before showing so we reflect a
          // headset that just got plugged in / paired.
          audioDevices = enumerateAudioOutputs(ctx)
          showAudioPicker = true
        },
        onHangup = onHangup,
        onToggleHand = onToggleHand,
        onShowReactions = { showReactions = !showReactions },
        onToggleNoiseSuppression = onToggleNoiseSuppression,
        onCycleBackground = onCycleBackground,
        onStartScreenshare = onStartScreenshare,
        onShowKeypad = {
          showKeypad = true
          dtmfBuffer = ""
        },
      )
      Spacer(Modifier.height(36.dp))
    }

    // 4. Local preview PiP (top-right, draggable).
    if (state.isVideo && state.isCameraOn && localRenderer != null && state.hasLocalVideo && !state.isInPip) {
      val local = localRenderer
      LocalPreviewTile(localRenderer = local)
    }

    // 5. Floating emoji bursts.
    Box(modifier = Modifier.fillMaxSize()) {
      state.floatingReactions.forEach { reaction ->
        androidx.compose.runtime.key(reaction.id) {
          FloatingEmoji(reaction = reaction)
        }
      }
    }

    // 6. Quick-reaction emoji bar slides up from above the action bar.
    AnimatedVisibility(
      visible = showReactions,
      enter = slideInVertically { it } + fadeIn(),
      exit = slideOutVertically { it } + fadeOut(),
      modifier = Modifier
        .align(Alignment.BottomCenter)
        .padding(bottom = 200.dp),
    ) {
      EmojiQuickBar(
        onPick = { emoji ->
          onSendReaction(emoji)
          showReactions = false
        }
      )
    }

    // 7. [DTMF, 2026-05-19] Keypad overlay. Renders above the action bar
    //    so the user can still see (but not tap) the hangup button. Tap
    //    outside the card dismisses.
    AnimatedVisibility(
      visible = showKeypad,
      enter = slideInVertically { it } + fadeIn(),
      exit = slideOutVertically { it } + fadeOut(),
      modifier = Modifier.fillMaxSize(),
    ) {
      KeypadOverlay(
        buffer = dtmfBuffer,
        onTap = { digit ->
          // Cap the buffer so it never overflows horizontally on small
          // viewports. iOS keeps 24 chars; mirror.
          dtmfBuffer = (dtmfBuffer + digit).takeLast(24)
          onPlayDTMF(digit)
        },
        onDismiss = {
          showKeypad = false
          dtmfBuffer = ""
        },
      )
    }

    // 8. [Audio picker, 2026-05-19] Bottom sheet with the real list of
    //    output devices. Calls onPickAudioDevice with a route id.
    AnimatedVisibility(
      visible = showAudioPicker,
      enter = slideInVertically { it } + fadeIn(),
      exit = slideOutVertically { it } + fadeOut(),
      modifier = Modifier.fillMaxSize(),
    ) {
      AudioOutputSheet(
        devices = audioDevices,
        currentSpeaker = state.isSpeakerOn,
        preferBluetooth = state.audioOutputPreferBluetooth,
        onPick = { type ->
          onPickAudioDevice(type)
          showAudioPicker = false
        },
        onDismiss = { showAudioPicker = false },
      )
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Top bar
// ══════════════════════════════════════════════════════════════════════════

@Composable
private fun TopBar(
  state: CallSessionStateAndroid,
  onMinimize: () -> Unit,
  onFlipCamera: () -> Unit,
  onToggleCam: (Boolean) -> Unit,
) {
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .padding(horizontal = 16.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    IconChip(
      icon = Icons.Filled.ExpandMore,
      contentDescription = "Minimize",
      onClick = onMinimize,
    )
    Spacer(Modifier.width(12.dp))
    ConnectionQualityBars(quality = state.peerQuality)
    Spacer(Modifier.weight(1f))

    if (state.isVideo && state.isCameraOn) {
      IconChip(
        icon = Icons.Filled.Cameraswitch,
        contentDescription = "Flip camera",
        onClick = onFlipCamera,
      )
      Spacer(Modifier.width(12.dp))
    }

    if (state.isVideo) {
      IconChip(
        icon = if (state.isCameraOn) Icons.Filled.Videocam else Icons.Filled.VideocamOff,
        contentDescription = "Toggle camera",
        onClick = { onToggleCam(!state.isCameraOn) },
      )
    }
  }
}

@Composable
private fun IconChip(
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  contentDescription: String,
  onClick: () -> Unit,
) {
  Box(
    modifier = Modifier
      .size(36.dp)
      .clip(CircleShape)
      .background(Color.Black.copy(alpha = 0.45f))
      .clickable { onClick() },
    contentAlignment = Alignment.Center,
  ) {
    Icon(
      imageVector = icon,
      contentDescription = contentDescription,
      tint = Color.White,
      modifier = Modifier.size(16.dp),
    )
  }
}

@Composable
private fun ConnectionQualityBars(quality: Int) {
  val barColor = when (quality) {
    3 -> Color(0xFF2E_CC_71)
    2 -> Color(0xFFF1_C4_0F)
    else -> Color(0xFFE7_4C_3C)
  }
  Row(
    verticalAlignment = Alignment.Bottom,
    horizontalArrangement = Arrangement.spacedBy(2.dp),
    modifier = Modifier.size(width = 22.dp, height = 22.dp),
  ) {
    for (i in 0 until 3) {
      val active = i < quality
      Box(
        modifier = Modifier
          .width(4.dp)
          .height((8 + i * 4).dp)
          .clip(RoundedCornerShape(2.dp))
          .background(if (active) barColor else Color.White.copy(alpha = 0.25f))
      )
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Avatar block (with pulse rings + breathing speaker ring)
// ══════════════════════════════════════════════════════════════════════════

@Composable
private fun AvatarBlock(state: CallSessionStateAndroid, elapsedSeconds: Int) {
  Column(
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) {
    Box(
      modifier = Modifier.size(220.dp),
      contentAlignment = Alignment.Center,
    ) {
      // Pulse rings (3 staggered) — only while we're not yet connected.
      if (state.status != "Conectado") {
        PulseRing(delayMs = 0)
        PulseRing(delayMs = 200)
        PulseRing(delayMs = 400)
      }

      // Breathing green active-speaker ring. Scale tracks peerSpeakerLevel
      // (LK reports 0..1) blended with a continuous ease cycle so the ring
      // keeps animating even when the level briefly drops to zero between
      // RTC stats samples.
      if (state.peerIsActiveSpeaker) {
        SpeakerRingComposable(level = state.peerSpeakerLevel)
      }

      // Avatar circle with breathing halo. Renders the fetched bitmap when
      // available (CallNotificationService.fetchAvatarBitmap result); falls
      // back to the initial letter while the photo decodes or when no URL
      // was supplied.
      AvatarCircle(
        name = state.callerName.ifEmpty { state.callerEmail },
        bitmap = state.callerAvatarBitmap,
      )
    }

    Spacer(Modifier.height(16.dp))

    Text(
      text = state.callerName.ifEmpty { state.callerEmail.ifEmpty { "Chamada" } },
      color = Color.White,
      fontSize = 26.sp,
      fontWeight = FontWeight.Normal,
      maxLines = 1,
    )

    Spacer(Modifier.height(8.dp))

    Text(
      text = statusLine(state.status, elapsedSeconds),
      color = SecondaryText,
      fontSize = 16.sp,
    )
  }
}

/** UI label for the current background-effect mode. Short so the pill stays narrow. */
private fun backgroundLabel(mode: String): String = when (mode) {
  "blur_low" -> "Leve"
  "blur_medium", "blur" -> "Desfocar"
  "blur_high" -> "Forte"
  "image" -> "Fundo"
  else -> "Fundo"
}

private fun statusLine(status: String, elapsedSeconds: Int): String {
  if (status == "Conectado") {
    val h = elapsedSeconds / 3600
    val m = (elapsedSeconds % 3600) / 60
    val s = elapsedSeconds % 60
    return if (h > 0) "Conectado %d:%02d:%02d".format(h, m, s)
    else "Conectado %02d:%02d".format(m, s)
  }
  return status
}

@Composable
private fun PulseRing(delayMs: Int) {
  // Three concentric rings spawned with staggered delays — at any moment
  // one is small/opaque, one mid-expansion, one almost faded.
  var started by remember { mutableStateOf(false) }
  LaunchedEffect(Unit) {
    delay(delayMs.toLong())
    started = true
  }
  val transition = rememberInfiniteTransition(label = "pulse")
  val scale by transition.animateFloat(
    initialValue = 0.7f,
    targetValue = 1.6f,
    animationSpec = infiniteRepeatable(
      animation = tween(durationMillis = 1800, easing = LinearEasing),
      repeatMode = RepeatMode.Restart,
    ),
    label = "pulseScale",
  )
  val alphaAnim by transition.animateFloat(
    initialValue = 0.5f,
    targetValue = 0f,
    animationSpec = infiniteRepeatable(
      animation = tween(durationMillis = 1800, easing = LinearEasing),
      repeatMode = RepeatMode.Restart,
    ),
    label = "pulseAlpha",
  )
  if (started) {
    Box(
      modifier = Modifier
        .size(180.dp)
        .scale(scale)
        .alpha(alphaAnim)
    ) {
      Canvas(modifier = Modifier.fillMaxSize()) {
        drawCircle(
          color = Color.White,
          radius = size.minDimension / 2f,
          style = Stroke(width = 4f),
        )
      }
    }
  }
}

@Composable
private fun SpeakerRingComposable(level: Float) {
  // The ring's scale tracks the audio level reported by LK plus a slow
  // sinusoidal cycle so it never goes fully static. Floor at 1.02 so the
  // ring is always visible when present.
  val transition = rememberInfiniteTransition(label = "speaker")
  val breath by transition.animateFloat(
    initialValue = 0.95f,
    targetValue = 1.12f,
    animationSpec = infiniteRepeatable(
      animation = tween(durationMillis = 900, easing = LinearEasing),
      repeatMode = RepeatMode.Reverse,
    ),
    label = "speakerBreath",
  )
  val scale = (1.02f + level.coerceIn(0f, 1f) * 0.18f) * breath
  Box(
    modifier = Modifier
      .size(190.dp)
      .scale(scale),
  ) {
    Canvas(modifier = Modifier.fillMaxSize()) {
      drawCircle(
        color = SpeakerRing.copy(alpha = 0.75f),
        radius = size.minDimension / 2f,
        style = Stroke(width = 8f),
      )
    }
  }
}

@Composable
private fun AvatarCircle(name: String, bitmap: android.graphics.Bitmap? = null) {
  val initial = name.trim().firstOrNull()?.uppercase() ?: "?"
  Box(
    modifier = Modifier
      .size(180.dp)
      .clip(CircleShape)
      .background(ChipColor),
    contentAlignment = Alignment.Center,
  ) {
    // Initial letter sits behind the photo so it's visible during the
    // ~200-500ms bitmap decode window — and remains as the fallback when
    // no URL was supplied.
    Text(
      text = initial,
      color = Color.White,
      fontSize = 72.sp,
      fontWeight = FontWeight.Normal,
    )
    // [#1176 polish, 2026-05-18] Real photo via androidx.compose.foundation
    // Image. ImageBitmap.asImageBitmap() wraps the existing Bitmap without
    // copy. ContentScale.Crop center-crops so the circle clip is filled
    // edge-to-edge with no letterboxing.
    if (bitmap != null) {
      androidx.compose.foundation.Image(
        bitmap = bitmap.asImageBitmap(),
        contentDescription = null,
        modifier = Modifier
          .size(180.dp)
          .clip(CircleShape),
        contentScale = androidx.compose.ui.layout.ContentScale.Crop,
      )
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Local preview PiP — draggable top-right tile
// ══════════════════════════════════════════════════════════════════════════

@Composable
private fun LocalPreviewTile(localRenderer: SurfaceViewRenderer) {
  val density = LocalDensity.current
  val baseRightDp = 16.dp
  val baseTopDp = 72.dp
  val widthDp = 100.dp
  val heightDp = 140.dp

  // Drag offsets in pixels, applied via Modifier.offset { IntOffset(...) }.
  var dragX by remember { mutableStateOf(0f) }
  var dragY by remember { mutableStateOf(0f) }

  Box(modifier = Modifier.fillMaxSize()) {
    Box(
      modifier = Modifier
        .align(Alignment.TopEnd)
        .padding(top = baseTopDp, end = baseRightDp)
        .offset { IntOffset(dragX.roundToInt(), dragY.roundToInt()) }
        .size(width = widthDp, height = heightDp)
        .clip(RoundedCornerShape(12.dp))
        .background(Color.Black)
        .pointerInput(Unit) {
          detectDragGestures(
            onDrag = { _, dragAmount ->
              dragX += dragAmount.x
              dragY += dragAmount.y
            },
            onDragEnd = {
              // Snap to nearest horizontal edge — same UX as the iOS tile
              // and the JS PanResponder in /call.js. We don't have the
              // exact screen width here without BoxWithConstraints; nudge
              // X back toward zero (right edge) when more than ~120 px in.
              if (dragX < -160f) {
                // Far enough left that the user clearly wanted left-edge;
                // approximate by clamping but leave the snap to follow-ups.
                dragX = -1f * with(density) { 280.dp.toPx() }
              } else if (dragX > -60f) {
                dragX = 0f
              }
            },
          )
        },
    ) {
      AndroidView(
        factory = { localRenderer },
        modifier = Modifier.fillMaxSize(),
      )
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Bottom action bar
// ══════════════════════════════════════════════════════════════════════════

@Composable
private fun BottomActionBar(
  state: CallSessionStateAndroid,
  onToggleMute: (Boolean) -> Unit,
  onToggleCam: (Boolean) -> Unit,
  onToggleSpeaker: (Boolean) -> Unit,
  onPickAudioOutput: () -> Unit,
  onHangup: () -> Unit,
  onToggleHand: () -> Unit,
  onShowReactions: () -> Unit,
  onToggleNoiseSuppression: (Boolean) -> Unit,
  onCycleBackground: () -> Unit,
  onStartScreenshare: () -> Unit,
  /** [DTMF, 2026-05-19] Open the 4×3 keypad overlay. */
  onShowKeypad: () -> Unit,
) {
  Column(
    modifier = Modifier
      .fillMaxWidth()
      .padding(horizontal = 16.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    // Secondary row: reactions, hand raise, audio output picker, noise
    // suppression, background blur. Five pills fit on the action surface
    // without crowding on a 412dp viewport.
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceEvenly,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      ActionPill(
        icon = Icons.Filled.EmojiEmotions,
        label = "Reagir",
        onClick = onShowReactions,
      )
      ActionPill(
        icon = Icons.Filled.FrontHand,
        label = if (state.isHandRaised) "Abaixar" else "Levantar",
        active = state.isHandRaised,
        onClick = onToggleHand,
      )
      // [RNNoise, 2026-05-17] "Cancelar ruído" — toggles the per-user noise
      // suppression flag. Default ON, persists across calls.
      ActionPill(
        icon = Icons.Filled.GraphicEq,
        label = "Sem ruído",
        active = state.noiseSuppression,
        onClick = { onToggleNoiseSuppression(!state.noiseSuppression) },
      )
      // [MediaPipe, 2026-05-17] Background mode cycler. Only shown for video
      // calls (camera publishing); audio calls have no useful background.
      if (state.isVideo) {
        ActionPill(
          icon = Icons.Filled.BlurOn,
          label = backgroundLabel(state.backgroundMode),
          active = state.backgroundMode != "off",
          onClick = onCycleBackground,
        )
      }
      ActionPill(
        icon = Icons.Filled.Bluetooth,
        label = "Áudio",
        active = state.audioOutputPreferBluetooth,
        onClick = onPickAudioOutput,
      )
      // [DTMF, 2026-05-19] Keypad — opens the 4×3 DTMF grid overlay. Useful
      // mainly for PSTN bridge calls hitting an IVR; for Chatyy↔Chatyy
      // peer calls it still publishes the digit + tone so the receiver
      // sees the press (useful for games / collaborative tools).
      ActionPill(
        icon = Icons.Filled.Dialpad,
        label = "Teclado",
        onClick = onShowKeypad,
      )
      // [Screen share, 2026-05-17] Optional screenshare pill for video calls.
      // Calls into the native start-screenshare bridge which forwards to the
      // expo-screen-share MediaProjection picker. Hidden on audio-only.
      if (state.isVideo) {
        ActionPill(
          icon = Icons.Filled.Refresh, // re-use Refresh — Compose Material doesn't bundle a screen-share glyph
          label = "Tela",
          onClick = onStartScreenshare,
        )
      }
    }

    Spacer(Modifier.height(16.dp))

    // Primary row: mute, video toggle (when video), speaker, hangup (red, larger).
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.spacedBy(20.dp, alignment = Alignment.CenterHorizontally),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      CircleControlButton(
        size = 64.dp,
        background = if (!state.isMuted) ChipColor else Color.White,
        foreground = if (!state.isMuted) Color.White else Color.Black,
        icon = if (!state.isMuted) Icons.Filled.Mic else Icons.Filled.MicOff,
        contentDescription = "Mute",
        onClick = { onToggleMute(state.isMuted) }, // pass current isMuted so onToggleMute flips it
      )

      if (state.isVideo) {
        CircleControlButton(
          size = 64.dp,
          background = if (state.isCameraOn) ChipColor else Color.White,
          foreground = if (state.isCameraOn) Color.White else Color.Black,
          icon = if (state.isCameraOn) Icons.Filled.Videocam else Icons.Filled.VideocamOff,
          contentDescription = "Camera",
          onClick = { onToggleCam(!state.isCameraOn) },
        )
      }

      CircleControlButton(
        size = 64.dp,
        background = if (state.isSpeakerOn) Color.White else ChipColor,
        foreground = if (state.isSpeakerOn) Color.Black else Color.White,
        icon = if (state.isSpeakerOn) Icons.Filled.VolumeUp else Icons.Filled.VolumeDown,
        contentDescription = "Speaker",
        onClick = { onToggleSpeaker(!state.isSpeakerOn) },
      )

      CircleControlButton(
        size = 72.dp,
        background = HangupColor,
        foreground = Color.White,
        icon = Icons.Filled.CallEnd,
        contentDescription = "Hangup",
        onClick = onHangup,
      )
    }
  }
}

@Composable
private fun ActionPill(
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  label: String,
  active: Boolean = false,
  onClick: () -> Unit,
) {
  Column(
    horizontalAlignment = Alignment.CenterHorizontally,
    modifier = Modifier
      .clip(RoundedCornerShape(14.dp))
      .background(if (active) Color.White.copy(alpha = 0.18f) else ChipColor.copy(alpha = 0.85f))
      .clickable { onClick() }
      .padding(horizontal = 12.dp, vertical = 8.dp),
  ) {
    Icon(
      imageVector = icon,
      contentDescription = label,
      tint = if (active) SpeakerRing else Color.White,
      modifier = Modifier.size(20.dp),
    )
    Spacer(Modifier.height(4.dp))
    Text(text = label, color = Color.White.copy(alpha = 0.9f), fontSize = 11.sp)
  }
}

@Composable
private fun CircleControlButton(
  size: androidx.compose.ui.unit.Dp,
  background: Color,
  foreground: Color,
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  contentDescription: String,
  onClick: () -> Unit,
) {
  Box(
    modifier = Modifier
      .size(size)
      .clip(CircleShape)
      .background(background)
      .clickable { onClick() },
    contentAlignment = Alignment.Center,
  ) {
    Icon(
      imageVector = icon,
      contentDescription = contentDescription,
      tint = foreground,
      modifier = Modifier.size(size * 0.42f),
    )
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Emoji quick bar + floating bursts
// ══════════════════════════════════════════════════════════════════════════

// [reaction bar, 2026-05-17] 5 emojis — matches iOS CallView/GroupCallView
// and the JS /call.js fallback. Trimmed from 6 (dropped 🔥) to align with
// the WhatsApp 2025 reaction set and keep each tile-tap target wider.
private val QuickEmojis = listOf("❤️", "👍", "👏", "😂", "🎉")

@Composable
private fun EmojiQuickBar(onPick: (String) -> Unit) {
  Row(
    modifier = Modifier
      .clip(RoundedCornerShape(28.dp))
      .background(Color.Black.copy(alpha = 0.6f))
      .padding(horizontal = 12.dp, vertical = 10.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    QuickEmojis.forEach { emoji ->
      Box(
        modifier = Modifier
          .size(48.dp)
          .clip(CircleShape)
          .background(Color.White.copy(alpha = 0.12f))
          .clickable { onPick(emoji) },
        contentAlignment = Alignment.Center,
      ) {
        Text(text = emoji, fontSize = 28.sp)
      }
    }
  }
}

@Composable
private fun FloatingEmoji(reaction: FloatingReactionAndroid) {
  // [reactions polish, 2026-05-17] Rises from bottom-center upward, fades
  // after 2s, with a slight horizontal sine sway so back-to-back reactions
  // don't overlap visually. Lifetime is bounded by the activity scope which
  // removes the reaction from the list after ~3s.
  val rise = remember { Animatable(0f) }
  val fade = remember { Animatable(1f) }
  val sway = remember { Animatable(0f) }
  LaunchedEffect(reaction.id) {
    launch {
      // 480 px rise over 2s — feels weighty without being slow.
      rise.animateTo(targetValue = 1f, animationSpec = tween(durationMillis = 2000, easing = LinearEasing))
    }
    launch {
      // Hold full opacity for the first 1s, then fade out over the final 1s.
      // Two-segment animation lets the user clearly identify the emoji
      // before it dissolves rather than fading from frame zero.
      fade.animateTo(targetValue = 1f, animationSpec = tween(durationMillis = 1000, easing = LinearEasing))
      fade.animateTo(targetValue = 0f, animationSpec = tween(durationMillis = 1000, easing = LinearEasing))
    }
    launch {
      // Sway: oscillates ±18px over the full lifetime. Combined with the
      // per-reaction xOffset jitter this gives a flock-of-bubbles feel
      // when multiple reactions go up at once.
      sway.animateTo(targetValue = 1f, animationSpec = tween(durationMillis = 2000, easing = LinearEasing))
    }
  }
  Box(modifier = Modifier.fillMaxSize()) {
    // Sine wave for horizontal sway. Two full periods over the 2s rise.
    val swayPx = (kotlin.math.sin(sway.value * Math.PI * 4).toFloat()) * 18f
    Text(
      text = reaction.emoji,
      fontSize = 44.sp,
      modifier = Modifier
        .align(Alignment.BottomCenter)
        .padding(bottom = 220.dp)
        .offset {
          IntOffset(
            (reaction.xOffset + swayPx).roundToInt(),
            -(rise.value * 360f).roundToInt(),
          )
        }
        .alpha(fade.value),
    )
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Reconnect banner
// ══════════════════════════════════════════════════════════════════════════

@Composable
private fun ReconnectBannerComposable(onRetry: () -> Unit) {
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(14.dp))
      .background(ReconnectBanner.copy(alpha = 0.92f))
      .padding(horizontal = 14.dp, vertical = 10.dp)
      .clickable { onRetry() },
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(
      imageVector = Icons.Filled.Refresh,
      contentDescription = "Retry",
      tint = Color.Black,
      modifier = Modifier.size(18.dp),
    )
    Spacer(Modifier.width(10.dp))
    Text(
      text = "Tente reconectar",
      color = Color.Black,
      fontSize = 14.sp,
      fontWeight = FontWeight.Medium,
    )
  }
}

/**
 * [#1175 2026-05-18] Humanized "needs login" banner. Surfaces when
 * LkTokenFetcher walked through all 4 fallback sources and couldn't find
 * a bearer. Tapping ends the call gracefully so the user lands on the
 * launcher / RN app shell, where /login is reachable. The message string
 * is owned by the caller (state.status) so we can show the right copy
 * depending on whether SecureStore had a hint (session expired) or not
 * (user logged out).
 */
@Composable
private fun NeedsLoginBanner(onTap: () -> Unit, message: String) {
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(14.dp))
      .background(ReconnectBanner.copy(alpha = 0.92f))
      .padding(horizontal = 14.dp, vertical = 10.dp)
      .clickable { onTap() },
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(
      imageVector = Icons.Filled.CallEnd,
      contentDescription = "Encerrar",
      tint = Color.Black,
      modifier = Modifier.size(18.dp),
    )
    Spacer(Modifier.width(10.dp))
    Text(
      text = message.ifBlank { "Faca login novamente para receber chamadas" },
      color = Color.Black,
      fontSize = 14.sp,
      fontWeight = FontWeight.Medium,
    )
  }
}

// ══════════════════════════════════════════════════════════════════════════
// [DTMF, 2026-05-19] Keypad overlay
// ══════════════════════════════════════════════════════════════════════════

/// Cell descriptor — same shape as iOS dtmfDigits for parity. Letters under
/// each digit follow the ITU-T E.161 layout WhatsApp / Phone use.
private val DtmfRows: List<List<Pair<String, String>>> = listOf(
  listOf("1" to " ", "2" to "ABC", "3" to "DEF"),
  listOf("4" to "GHI", "5" to "JKL", "6" to "MNO"),
  listOf("7" to "PQRS", "8" to "TUV", "9" to "WXYZ"),
  listOf("*" to "", "0" to "+", "#" to ""),
)

@Composable
private fun KeypadOverlay(
  buffer: String,
  onTap: (String) -> Unit,
  onDismiss: () -> Unit,
) {
  Box(
    modifier = Modifier
      .fillMaxSize()
      .background(Color.Black.copy(alpha = 0.55f))
      .clickable(
        indication = null,
        interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
      ) { onDismiss() },
    contentAlignment = Alignment.BottomCenter,
  ) {
    Column(
      modifier = Modifier
        .fillMaxWidth()
        .padding(horizontal = 8.dp, vertical = 24.dp)
        .clip(RoundedCornerShape(24.dp))
        .background(Color(0xFF14_1F_27))
        .clickable(
          indication = null,
          interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
        ) { /* swallow taps so the dismiss layer doesn't fire */ }
        .padding(vertical = 16.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Box(
        modifier = Modifier
          .width(40.dp)
          .height(4.dp)
          .clip(RoundedCornerShape(2.dp))
          .background(Color.White.copy(alpha = 0.3f))
      )
      Spacer(Modifier.height(12.dp))
      Text(
        text = buffer.ifEmpty { "Teclado" },
        color = Color.White,
        fontSize = if (buffer.isEmpty()) 17.sp else 26.sp,
        fontWeight = FontWeight.Medium,
        maxLines = 1,
      )
      Spacer(Modifier.height(14.dp))
      DtmfRows.forEach { row ->
        Row(
          horizontalArrangement = Arrangement.spacedBy(22.dp),
          modifier = Modifier.padding(vertical = 6.dp),
        ) {
          row.forEach { (digit, letters) ->
            DtmfKey(digit = digit, letters = letters, onTap = onTap)
          }
        }
      }
      Spacer(Modifier.height(14.dp))
      Box(
        modifier = Modifier
          .clip(CircleShape)
          .background(Color.White.copy(alpha = 0.12f))
          .clickable { onDismiss() }
          .padding(horizontal = 28.dp, vertical = 10.dp),
      ) {
        Text(text = "Fechar", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium)
      }
    }
  }
}

@Composable
private fun DtmfKey(digit: String, letters: String, onTap: (String) -> Unit) {
  Box(
    modifier = Modifier
      .size(68.dp)
      .clip(CircleShape)
      .background(Color.White.copy(alpha = 0.08f))
      .clickable { onTap(digit) },
    contentAlignment = Alignment.Center,
  ) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
      Text(text = digit, color = Color.White, fontSize = 28.sp, fontWeight = FontWeight.Normal)
      if (letters.isNotEmpty()) {
        Text(
          text = letters,
          color = Color.White.copy(alpha = 0.55f),
          fontSize = 10.sp,
          fontWeight = FontWeight.SemiBold,
        )
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// [Audio picker, 2026-05-19] Real device enumeration + bottom sheet
// ══════════════════════════════════════════════════════════════════════════

/// One available audio output. `type` is the route id we pass back through
/// onPickAudioDevice; `label` is what the user sees on the sheet row.
data class AudioOutputEntry(val type: String, val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector)

/// Walks AudioManager.getDevices(GET_DEVICES_OUTPUTS) and returns a stable
/// list with the system speaker + earpiece (always present), plus any
/// external devices currently connected (BT headset, wired headphones,
/// USB audio, hearing aid). The CallActivity refreshes this list each time
/// the sheet is opened so a freshly-paired BT device shows up.
private fun enumerateAudioOutputs(ctx: android.content.Context): List<AudioOutputEntry> {
  val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  val out = mutableListOf<AudioOutputEntry>()
  // Built-in routes — always present, always offered.
  out.add(AudioOutputEntry("earpiece", "Telefone", Icons.Filled.PhoneInTalk))
  out.add(AudioOutputEntry("speaker", "Alto-falante", Icons.Filled.SpeakerPhone))

  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
    val devices = try {
      am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
    } catch (_: Throwable) { return out }
    var btSeen = false
    var wiredSeen = false
    var usbSeen = false
    for (d in devices) {
      when (d.type) {
        android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> {
          if (!btSeen) {
            val name = try { d.productName?.toString().orEmpty() } catch (_: Throwable) { "" }
            val label = if (name.isNotBlank()) name else "Bluetooth"
            out.add(AudioOutputEntry("bluetooth", label, Icons.Filled.Bluetooth))
            btSeen = true
          }
        }
        android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET,
        android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> {
          if (!wiredSeen) {
            out.add(AudioOutputEntry("wired", "Fone com fio", Icons.Filled.Headphones))
            wiredSeen = true
          }
        }
        android.media.AudioDeviceInfo.TYPE_USB_DEVICE,
        android.media.AudioDeviceInfo.TYPE_USB_HEADSET,
        android.media.AudioDeviceInfo.TYPE_USB_ACCESSORY -> {
          if (!usbSeen) {
            out.add(AudioOutputEntry("wired", "USB", Icons.Filled.Usb))
            usbSeen = true
          }
        }
        else -> { /* ignore built-ins, telephony, FM, HDMI, … */ }
      }
    }
  }
  return out
}

@Composable
private fun AudioOutputSheet(
  devices: List<AudioOutputEntry>,
  currentSpeaker: Boolean,
  preferBluetooth: Boolean,
  onPick: (String) -> Unit,
  onDismiss: () -> Unit,
) {
  Box(
    modifier = Modifier
      .fillMaxSize()
      .background(Color.Black.copy(alpha = 0.55f))
      .clickable(
        indication = null,
        interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
      ) { onDismiss() },
    contentAlignment = Alignment.BottomCenter,
  ) {
    Column(
      modifier = Modifier
        .fillMaxWidth()
        .padding(horizontal = 8.dp, vertical = 24.dp)
        .clip(RoundedCornerShape(24.dp))
        .background(Color(0xFF14_1F_27))
        .clickable(
          indication = null,
          interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
        ) { /* swallow */ }
        .padding(vertical = 16.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Box(
        modifier = Modifier
          .width(40.dp)
          .height(4.dp)
          .clip(RoundedCornerShape(2.dp))
          .background(Color.White.copy(alpha = 0.3f))
      )
      Spacer(Modifier.height(10.dp))
      Text(text = "Saída de áudio", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
      Spacer(Modifier.height(12.dp))
      Column(
        modifier = Modifier
          .fillMaxWidth()
          .padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        devices.forEach { entry ->
          val selected = when (entry.type) {
            "speaker" -> currentSpeaker && !preferBluetooth
            "earpiece" -> !currentSpeaker && !preferBluetooth
            "bluetooth" -> preferBluetooth
            else -> false
          }
          AudioRouteRow(entry = entry, selected = selected, onPick = { onPick(entry.type) })
        }
      }
      Spacer(Modifier.height(16.dp))
    }
  }
}

@Composable
private fun AudioRouteRow(entry: AudioOutputEntry, selected: Boolean, onPick: () -> Unit) {
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(12.dp))
      .background(Color.White.copy(alpha = if (selected) 0.1f else 0.04f))
      .clickable { onPick() }
      .padding(horizontal = 14.dp, vertical = 12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(
      imageVector = entry.icon,
      contentDescription = entry.label,
      tint = if (selected) SpeakerRing else Color.White,
      modifier = Modifier.size(20.dp),
    )
    Spacer(Modifier.width(12.dp))
    Text(text = entry.label, color = Color.White, fontSize = 16.sp, modifier = Modifier.weight(1f))
    if (selected) {
      Icon(
        imageVector = Icons.Filled.Check,
        contentDescription = "Selecionado",
        tint = SpeakerRing,
        modifier = Modifier.size(18.dp),
      )
    }
  }
}
