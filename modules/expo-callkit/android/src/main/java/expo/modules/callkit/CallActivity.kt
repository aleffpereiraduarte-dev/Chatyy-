package expo.modules.callkit

import android.app.PictureInPictureParams
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
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
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.EmojiEmotions
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.FrontHand
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Refresh
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
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.renderer.SurfaceViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalVideoTrack
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
    const val ACTION_CLOSE = "expo.modules.callkit.CLOSE_CALL_ACTIVITY"
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

    Log.d(TAG, "onCreate: callId=$callId caller=$callerName video=$hasVideo " +
      "outgoing=$isOutgoing convId=$conversationId " +
      "hasUrl=${!lkUrl.isNullOrEmpty()} hasToken=${!lkToken.isNullOrEmpty()}")

    // Seed the session state from intent extras so the first frame draws
    // with the right name + status string.
    state.callerName = callerName
    state.callerEmail = callerEmail
    state.isVideo = hasVideo
    state.status = if (isOutgoing) "Chamando…" else "Conectando…"
    state.isCameraOn = hasVideo

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
            lifecycleScope.launch {
              try { room?.localParticipant?.setMicrophoneEnabled(desired) }
              catch (t: Throwable) { Log.w(TAG, "setMicrophoneEnabled: ${t.message}") }
            }
          },
          onToggleCam = { desired ->
            state.isCameraOn = desired
            lifecycleScope.launch {
              try { room?.localParticipant?.setCameraEnabled(desired) }
              catch (t: Throwable) { Log.w(TAG, "setCameraEnabled: ${t.message}") }
            }
          },
          onToggleSpeaker = { desired ->
            state.isSpeakerOn = desired
            applyAudioRoute(desired)
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

    // Bring up LiveKit. If url/token missing, the screen just idles on
    // "Conectando…" so the user can still hangup gracefully.
    if (!lkUrl.isNullOrEmpty() && !lkToken.isNullOrEmpty()) {
      bringUpRoom(lkUrl!!, lkToken!!)
    } else {
      Log.w(TAG, "missing lk_url or lk_token — skipping connect")
      state.status = "Sem token"
    }
  }

  @OptIn(DelicateCoroutinesApi::class)
  override fun onDestroy() {
    try { unregisterReceiver(closeReceiver) } catch (_: Exception) {}
    stopRingback()
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
    super.onDestroy()
  }

  override fun onBackPressed() {
    // Hangup must be intentional; ignore stray back-press.
    Log.d(TAG, "back press ignored — use hangup button")
  }

  // ────────────── LiveKit room lifecycle

  private fun bringUpRoom(url: String, token: String) {
    val r = LiveKit.create(applicationContext)
    room = r
    LiveKitRoomHolder.set(r)

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
      r.localParticipant.setMicrophoneEnabled(!state.isMuted)
      if (hasVideo) {
        r.localParticipant.setCameraEnabled(state.isCameraOn)
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
      is RoomEvent.LocalTrackPublished -> {
        val track = event.publication.track
        if (track is LocalVideoTrack) {
          Log.d(TAG, "LocalTrackPublished (video)")
          state.hasLocalVideo = true
          localRenderer?.let { lv -> track.addRenderer(lv) }
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
    eventsJob?.cancel()
    connectJob?.cancel()
    ExpoCallKitModule.emitCallEnded(callId)
    finish()
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
        } catch (_: Throwable) {}
      }
    }
  }

  // ────────────── Audio routing

  private fun applyAudioRoute(speakerOn: Boolean) {
    try {
      val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
      am.mode = AudioManager.MODE_IN_COMMUNICATION
      am.isSpeakerphoneOn = speakerOn
      if (state.audioOutputPreferBluetooth && !speakerOn) {
        @Suppress("DEPRECATION")
        am.startBluetoothSco()
        @Suppress("DEPRECATION")
        am.isBluetoothScoOn = true
      } else {
        @Suppress("DEPRECATION")
        am.isBluetoothScoOn = false
        @Suppress("DEPRECATION")
        am.stopBluetoothSco()
      }
    } catch (t: Throwable) {
      Log.w(TAG, "applyAudioRoute failed: ${t.message}")
    }
  }

  // ────────────── Reactions

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
  }

  // ────────────── PiP

  private fun tryEnterPip() {
    if (!hasVideo) return
    if (remoteRenderer == null) return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (isInPictureInPictureMode) return
    try {
      val params = PictureInPictureParams.Builder()
        .setAspectRatio(Rational(9, 16))
        .build()
      enterPictureInPictureMode(params)
      Log.d(TAG, "Entered PiP")
    } catch (t: Throwable) {
      Log.w(TAG, "enterPictureInPictureMode failed: ${t.message}")
    }
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
) {
  var elapsedSeconds by remember { mutableStateOf(0) }
  var showReactions by remember { mutableStateOf(false) }

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
        onPickAudioOutput = onPickAudioOutput,
        onHangup = onHangup,
        onToggleHand = onToggleHand,
        onShowReactions = { showReactions = !showReactions },
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

      // Avatar circle with breathing halo.
      AvatarCircle(name = state.callerName.ifEmpty { state.callerEmail })
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
private fun AvatarCircle(name: String) {
  val initial = name.trim().firstOrNull()?.uppercase() ?: "?"
  Box(
    modifier = Modifier
      .size(180.dp)
      .clip(CircleShape)
      .background(ChipColor),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = initial,
      color = Color.White,
      fontSize = 72.sp,
      fontWeight = FontWeight.Normal,
    )
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
) {
  Column(
    modifier = Modifier
      .fillMaxWidth()
      .padding(horizontal = 16.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    // Secondary row: reactions, hand raise, audio output picker.
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
      ActionPill(
        icon = Icons.Filled.Bluetooth,
        label = "Áudio",
        active = state.audioOutputPreferBluetooth,
        onClick = onPickAudioOutput,
      )
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

private val QuickEmojis = listOf("❤️", "👍", "👏", "😂", "🎉", "🔥")

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
  // Rises from the bottom-center upward and fades. Lifetime is bounded by
  // the activity scope which removes the reaction from the list at ~3s.
  val rise = remember { Animatable(0f) }
  val fade = remember { Animatable(1f) }
  LaunchedEffect(reaction.id) {
    launch {
      rise.animateTo(targetValue = 1f, animationSpec = tween(durationMillis = 2400, easing = LinearEasing))
    }
    launch {
      fade.animateTo(targetValue = 0f, animationSpec = tween(durationMillis = 2400, easing = LinearEasing))
    }
  }
  Box(modifier = Modifier.fillMaxSize()) {
    Text(
      text = reaction.emoji,
      fontSize = 44.sp,
      modifier = Modifier
        .align(Alignment.BottomCenter)
        .padding(bottom = 220.dp)
        .offset {
          IntOffset(
            reaction.xOffset.roundToInt(),
            -(rise.value * 320f).roundToInt(),
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
