package expo.modules.callkit

import android.app.PictureInPictureParams
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.Color
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.Rational
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.renderer.SurfaceViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
// [2026-05-16 Stage 2 Android screenshare wiring] Publish the active Room into
// the screen-share holder so ScreenShareService can flip on LK screen-share
// publishing without a circular module dep. See module-level KDoc on
// LiveKitRoomHolder for the why.
import expo.modules.screenshare.LiveKitRoomHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * CallActivity — full-native in-call screen (2026-05-16 Day 2 — LiveKit wired).
 *
 * Owns the entire call UX: caller avatar/name + LiveKit Room. Replaces
 * /call.js: audio/video flow without ever crossing the RN bridge — eliminates
 * the cold-start race that drops incoming calls within the first second.
 *
 * Architecture:
 *   - On accept, ExpoCallKitModule.openNativeCall starts this activity with
 *     extras { call_id, caller_name, lk_url, lk_token, has_video, ... }.
 *   - In onCreate, we create `Room` via LiveKit.create(applicationContext)
 *     and immediately launch a coroutine that:
 *       1. Subscribes to room.events (Flow) so we react to Connected /
 *          Disconnected / TrackSubscribed / ParticipantConnected.
 *       2. Calls room.connect(url, token) — suspends until the WS handshake +
 *          ICE is established.
 *       3. Enables mic (always) and camera (when hasVideo=true).
 *   - For video calls, two SurfaceViewRenderers are added:
 *       - `remoteRenderer` (fullscreen) — gets the first remote VideoTrack
 *         that the room subscribes to.
 *       - `localRenderer` (PiP top-right) — gets the local camera track once
 *         setCameraEnabled completes. Bound via the LocalTrackPublished event.
 *   - Mute / camera-toggle buttons re-invoke setMicrophoneEnabled /
 *     setCameraEnabled inside lifecycleScope.launch so the suspend functions
 *     run on the activity's coroutine context.
 *   - Hangup or onDestroy → room.disconnect() (suspend, but fire-and-forget
 *     since the activity is dying anyway).
 *
 * Intent extras (set by ExpoCallKitModule.openNativeCall):
 *   - call_id (String)        required
 *   - caller_name (String)
 *   - caller_email (String)
 *   - has_video (Boolean)
 *   - lk_url (String)         required for LK connect
 *   - lk_token (String)       required for LK connect
 */
class CallActivity : ComponentActivity() {

  companion object {
    private const val TAG = "CallActivity"
    const val ACTION_CLOSE = "expo.modules.callkit.CLOSE_CALL_ACTIVITY"

    const val EXTRA_CALL_ID = "call_id"
    const val EXTRA_CALLER_NAME = "caller_name"
    const val EXTRA_CALLER_EMAIL = "caller_email"
    const val EXTRA_HAS_VIDEO = "has_video"
    const val EXTRA_LK_URL = "lk_url"
    const val EXTRA_LK_TOKEN = "lk_token"
    // [2026-05-16] Outgoing-call flag. When true, CallActivity plays a
    // ringback tone (TONE_SUP_RINGTONE) from bringUpRoom until the remote
    // participant joins, hangup, or 30s safety cap. Defaults false so the
    // incoming-accept path (callee) NEVER hears ringback.
    const val EXTRA_IS_OUTGOING = "is_outgoing"
    // [2026-05-16 Stage 2 native WS signaling] Chat conversation row this
    // call belongs to. CallActivity uses it as the second key (alongside
    // call_id) when firing call_invite / call_end via CallSignalWs. May be
    // empty when the call originates outside a chat (dialer flow) — server
    // dedupes by call_id alone in that case.
    const val EXTRA_CONVERSATION_ID = "conversation_id"
  }

  private var callId: String = ""
  private var callerName: String = ""
  private var callerEmail: String = ""
  private var hasVideo: Boolean = false
  private var lkUrl: String? = null
  private var lkToken: String? = null
  private var isOutgoing: Boolean = false
  // [2026-05-16 Stage 2] Captured from EXTRA_CONVERSATION_ID; passed into
  // every CallSignalWs.fire* call below. Empty string is valid (server
  // tolerates it for dialer-style calls).
  private var conversationId: String = ""

  // [2026-05-16] Ringback tone player. Allocated in startRingback() once
  // bringUpRoom is invoked on outgoing calls; released in stopRingback().
  // Routed via STREAM_VOICE_CALL so it follows the call audio path
  // (earpiece by default, BT/speaker if user toggles).
  private var toneGen: ToneGenerator? = null

  private var micEnabled = true
  private var camEnabled = true

  private lateinit var nameText: TextView
  private lateinit var statusText: TextView
  private lateinit var muteBtn: ImageButton
  private var videoBtn: ImageButton? = null

  // Renderers only created when the call has video.
  private var remoteRenderer: SurfaceViewRenderer? = null
  private var localRenderer: SurfaceViewRenderer? = null

  // [2026-05-16] Views hidden when entering PiP so the picture-in-picture
  // tile shows only the remote video. Restored on exit.
  private var controlsRow: View? = null
  private var nameRow: View? = null

  private var room: Room? = null
  private var eventsJob: Job? = null
  private var connectJob: Job? = null

  // [2026-05-16] Intent reference for the in-call foreground service.
  // Started in onCreate after setContentView, stopped in finishCall before
  // LiveKit disconnect so the persistent notification disappears promptly.
  private var ongoingSvcIntent: Intent? = null

  private val closeReceiver = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context?, intent: Intent?) {
      Log.d(TAG, "closeReceiver: finishing activity")
      finishCall(reason = "close_broadcast")
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Show over lockscreen + keep screen on while connecting/in call.
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
    // Default false: incoming-accept path (callee) must NOT hear ringback.
    // JS bridge (ExpoCallKit.openNativeCall) must pass true for outgoing.
    isOutgoing = extras.getBoolean(EXTRA_IS_OUTGOING, false)
    conversationId = extras.getString(EXTRA_CONVERSATION_ID) ?: ""

    Log.d(TAG, "onCreate: callId=$callId caller=$callerName video=$hasVideo " +
      "outgoing=$isOutgoing convId=$conversationId " +
      "hasUrl=${!lkUrl.isNullOrEmpty()} hasToken=${!lkToken.isNullOrEmpty()}")

    // [2026-05-16 Stage 2 native WS signaling] Fire call_invite from native
    // for outgoing calls as soon as we have the intent extras — BEFORE the
    // JS bundle parses the openNativeCall promise resolution. CallSignalWs
    // queues if the WS isn't yet authed (Stage 1 plumbing); the server
    // dedupes by call_id, so this fire racing the JS-side
    // services/api.js call_invite is fine — whichever lands first wins,
    // the other is a no-op. Empty conversation_id is tolerated (dialer flow).
    if (isOutgoing) {
      CallSignalWs.fireCallInvite(
        this, callId, conversationId, callerEmail, hasVideo
      )
    }

    setContentView(buildRootView())

    // [2026-05-16] Start the in-call foreground service so the process
    // survives backgrounding (swipe home). foregroundServiceType=phoneCall
    // is required by Android 14+ to keep mic capture alive while the
    // activity is not visible. Stopped first in finishCall().
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

    // Listen for external close (e.g., remote hangup, accept on another device).
    val filter = IntentFilter(ACTION_CLOSE)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(closeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      registerReceiver(closeReceiver, filter)
    }

    // Bring up LiveKit. If url/token are missing we still show the screen so
    // the user sees "Conectando…" rather than a black activity — the connect
    // call will be skipped and the screen will idle until hangup. Day 4
    // outgoing flow will inject these via openNativeCall extras.
    if (!lkUrl.isNullOrEmpty() && !lkToken.isNullOrEmpty()) {
      bringUpRoom(lkUrl!!, lkToken!!)
    } else {
      Log.w(TAG, "missing lk_url or lk_token in intent — skipping connect")
      statusText.text = "Sem token"
    }
  }

  private fun bringUpRoom(url: String, token: String) {
    val r = LiveKit.create(applicationContext)
    room = r
    // [2026-05-16 Stage 2 Android screenshare wiring] Publish the Room handle
    // to the process-wide holder so ScreenShareService.publishToLiveKit() can
    // flip on setScreenShareEnabled(true) once the user grants
    // MediaProjection. Cleared in onDestroy to drop the WeakReference.
    LiveKitRoomHolder.set(r)

    // Register the renderers BEFORE connect so the EGL contexts exist when
    // remote tracks arrive. initVideoRenderer is the LiveKit-specific entry
    // point that replaces the bare WebRTC SurfaceViewRenderer.init() call.
    remoteRenderer?.let { r.initVideoRenderer(it) }
    localRenderer?.let { r.initVideoRenderer(it) }

    // Subscribe to events FIRST so we don't miss Connected (the connect call
    // emits it before returning from suspend on a fast network).
    eventsJob = lifecycleScope.launch {
      r.events.collect { event ->
        when (event) {
          is RoomEvent.Connected -> {
            Log.d(TAG, "RoomEvent.Connected")
            statusText.text = "Conectado"
          }
          is RoomEvent.Reconnecting -> {
            Log.d(TAG, "RoomEvent.Reconnecting")
            statusText.text = "Reconectando…"
          }
          is RoomEvent.Reconnected -> {
            Log.d(TAG, "RoomEvent.Reconnected")
            statusText.text = "Conectado"
          }
          is RoomEvent.Disconnected -> {
            Log.d(TAG, "RoomEvent.Disconnected reason=${event.reason} err=${event.error}")
            // Always stop ringback before tearing down — no-op if never started.
            stopRingback()
            finishCall(reason = "room_disconnect")
          }
          is RoomEvent.ParticipantConnected -> {
            Log.d(TAG, "ParticipantConnected ${event.participant.identity}")
            // Callee answered and joined the LK room — kill the ringback.
            stopRingback()
          }
          is RoomEvent.TrackSubscribed -> {
            val t = event.track
            if (t is VideoTrack) {
              Log.d(TAG, "TrackSubscribed (video) sid=${event.publication.sid}")
              remoteRenderer?.let { rv -> t.addRenderer(rv) }
            } else {
              Log.d(TAG, "TrackSubscribed (audio) sid=${event.publication.sid}")
            }
          }
          else -> {
            // No-op for the rest in Day 2. Day 3 polish wires
            // ConnectionQualityChanged → status pill, TrackMuted etc.
          }
        }
      }
    }

    // [2026-05-16] For outgoing calls, kick off the ringback tone BEFORE the
    // connect coroutine fires so the caller hears the standard PSTN "trim
    // trim trim" while the WS handshake + callee accept races complete.
    // Stopped on RoomEvent.ParticipantConnected (callee joined), Disconnected,
    // finishCall (hangup), or the 30s safety cap inside ToneGenerator.
    if (isOutgoing) {
      startRingback()
    }

    connectJob = lifecycleScope.launch {
      try {
        r.connect(url, token)
        // Both are suspend in LK Android 2.x — they return when the publisher
        // has signaled and the track is published. Order: mic first (audio
        // calls connect <500ms), camera second (video has heavier setup).
        r.localParticipant.setMicrophoneEnabled(true)
        if (hasVideo) {
          r.localParticipant.setCameraEnabled(true)
        }
        Log.d(TAG, "LK connect + publish OK")
      } catch (t: Throwable) {
        Log.e(TAG, "LK connect failed: ${t.message}", t)
        statusText.text = "Erro de conexão"
      }
    }
  }

  /**
   * [2026-05-16] Start the standard Android ringback tone for outgoing calls.
   *
   * TONE_SUP_RINGTONE = ITU-T E.180 call-progress ringback ("trim trim trim"),
   * the same tone the PSTN uses, so callers hear the familiar pattern while
   * the callee's phone is ringing. Routed via STREAM_VOICE_CALL so it shares
   * the call audio path (earpiece by default, BT/speaker if toggled).
   *
   * Duration cap = 30 000 ms — if the callee never answers, the tone stops
   * itself even if our event-driven stopRingback() path somehow misses.
   *
   * ToneGenerator's ctor can throw RuntimeException on emulators that lack
   * a hardware audio path or expose a non-standard MediaPlayerService — we
   * swallow it and no-op so the call setup is never blocked.
   */
  private fun startRingback() {
    if (toneGen != null) return // idempotent — never double-start
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

  @OptIn(DelicateCoroutinesApi::class)
  override fun onDestroy() {
    try { unregisterReceiver(closeReceiver) } catch (_: Exception) {}
    // Safety: if we somehow reach onDestroy with the tone still running
    // (e.g. activity killed without going through finishCall), kill it.
    stopRingback()
    eventsJob?.cancel()
    connectJob?.cancel()
    // Room.disconnect() is suspend in LK 2.x and lifecycleScope is already
    // cancelled at onDestroy. Fire-and-forget on GlobalScope/Dispatchers.IO so
    // the WS+ICE teardown completes cleanly in the background after the
    // activity is gone. The Room instance is GC'd once disconnect resolves.
    val r = room
    room = null
    if (r != null) {
      GlobalScope.launch(Dispatchers.IO) {
        try { r.disconnect() } catch (t: Throwable) {
          Log.w(TAG, "room.disconnect() threw: ${t.message}")
        }
      }
    }
    remoteRenderer?.release()
    localRenderer?.release()
    // [2026-05-16 Stage 2 Android screenshare wiring] Drop the screen-share
    // holder's WeakReference to this Room. ScreenShareService.current() will
    // return null after this, so a late-arriving permission grant won't try
    // to publish into a torn-down Room.
    LiveKitRoomHolder.clear()
    super.onDestroy()
  }

  private fun finishCall(reason: String) {
    Log.d(TAG, "finishCall reason=$reason callId=$callId")
    // [2026-05-16] Stop the ringback BEFORE LK disconnect / FGS teardown so
    // the caller doesn't hear a half-second of "trim" after pressing hangup.
    stopRingback()
    // [2026-05-16 Stage 2 native WS signaling] Fire call_end from native
    // BEFORE we tear down the activity. Done before finish() so the WS send
    // happens while the process is still healthy (the WS layer queues on
    // CallSignalWs.scope which survives activity death anyway, but this
    // gets the frame into the queue faster). JS-side fallback in
    // services/api.js call_end fires in parallel — server dedupes by call_id.
    CallSignalWs.fireCallEnd(this, callId, conversationId, reason)
    // [2026-05-16] Tear down the in-call FGS FIRST so the persistent
    // notification disappears immediately, then cancel coroutines, then
    // let onDestroy disconnect the Room. Ordering matters: if we stop the
    // service after Room.disconnect the user sees a stale "Chamada em
    // andamento" notification for ~200ms while LK tears down.
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

  private fun buildRootView(): View {
    val density = resources.displayMetrics.density
    fun dp(v: Int) = (v * density).toInt()

    val root = FrameLayout(this).apply {
      setBackgroundColor(Color.parseColor("#0B141A"))
      layoutParams = ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }

    // For video calls, the remote renderer fills the screen behind everything.
    if (hasVideo) {
      remoteRenderer = SurfaceViewRenderer(this).apply {
        layoutParams = FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.MATCH_PARENT
        )
      }
      root.addView(remoteRenderer)

      // Local camera PiP top-right.
      val pipSize = dp(96)
      val pipMargin = dp(16)
      localRenderer = SurfaceViewRenderer(this).apply {
        layoutParams = FrameLayout.LayoutParams(pipSize, dp(160)).apply {
          gravity = Gravity.TOP or Gravity.END
          topMargin = dp(40)
          rightMargin = pipMargin
        }
      }
      root.addView(localRenderer)
    }

    val column = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      setPadding(dp(24), dp(80), dp(24), dp(48))
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }
    root.addView(column)
    // [2026-05-16] Save the whole text column so we can hide it in PiP.
    nameRow = column

    // Avatar shows only on audio calls (video has the remote feed behind).
    if (!hasVideo) {
      val avatar = TextView(this).apply {
        val size = dp(120)
        layoutParams = LinearLayout.LayoutParams(size, size).apply {
          bottomMargin = dp(32)
        }
        gravity = Gravity.CENTER
        setBackgroundColor(Color.parseColor("#1F2C34"))
        setTextColor(Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 48f)
        text = (callerName.firstOrNull()?.uppercase() ?: "?")
      }
      column.addView(avatar)
    } else {
      // Push name/status down a bit on video so they don't sit on the status bar.
      column.addView(View(this).apply {
        layoutParams = LinearLayout.LayoutParams(0, dp(40))
      })
    }

    nameText = TextView(this).apply {
      text = callerName.ifEmpty { callerEmail.ifEmpty { "Chamada" } }
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
      gravity = Gravity.CENTER
      layoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply { bottomMargin = dp(8) }
    }
    column.addView(nameText)

    statusText = TextView(this).apply {
      text = "Conectando…"
      setTextColor(Color.parseColor("#8696A0"))
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
      gravity = Gravity.CENTER
      layoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      )
    }
    column.addView(statusText)

    // Spacer that pushes controls to the bottom.
    column.addView(View(this).apply {
      layoutParams = LinearLayout.LayoutParams(0, 0, 1f)
    })

    // Controls row: [mic] [hangup] [video?]
    val controls = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
      layoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      )
    }
    column.addView(controls)
    // [2026-05-16] Save controls row so PiP transition can hide it.
    controlsRow = controls

    muteBtn = makeCircleButton(dp(64), Color.parseColor("#1F2C34")) {
      micEnabled = !micEnabled
      muteBtn.alpha = if (micEnabled) 1f else 0.5f
      lifecycleScope.launch {
        try { room?.localParticipant?.setMicrophoneEnabled(micEnabled) }
        catch (t: Throwable) { Log.w(TAG, "setMicrophoneEnabled failed: ${t.message}") }
      }
    }
    val muteWrap = LinearLayout.LayoutParams(dp(64), dp(64)).apply {
      marginEnd = dp(24)
    }
    controls.addView(muteBtn, muteWrap)

    val hangupBtn = makeCircleButton(dp(72), Color.parseColor("#E53935")) {
      finishCall(reason = "user_hangup")
    }
    val hangupWrap = LinearLayout.LayoutParams(dp(72), dp(72))
    controls.addView(hangupBtn, hangupWrap)

    if (hasVideo) {
      val vb = makeCircleButton(dp(64), Color.parseColor("#1F2C34")) {
        camEnabled = !camEnabled
        videoBtn?.alpha = if (camEnabled) 1f else 0.5f
        lifecycleScope.launch {
          try { room?.localParticipant?.setCameraEnabled(camEnabled) }
          catch (t: Throwable) { Log.w(TAG, "setCameraEnabled failed: ${t.message}") }
        }
      }
      val videoWrap = LinearLayout.LayoutParams(dp(64), dp(64)).apply {
        marginStart = dp(24)
      }
      controls.addView(vb, videoWrap)
      videoBtn = vb
    }

    return root
  }

  private fun makeCircleButton(size: Int, bg: Int, onClick: () -> Unit): ImageButton {
    return ImageButton(this).apply {
      setBackgroundColor(bg)
      layoutParams = ViewGroup.LayoutParams(size, size)
      setOnClickListener { onClick() }
    }
  }

  override fun onBackPressed() {
    // Block accidental back press during call — hangup must be intentional.
    Log.d(TAG, "back press ignored — use hangup button")
  }

  // [2026-05-16] PiP support — auto-enter when the user presses home or
  // app-switcher during a VIDEO call. Audio calls don't need PiP (the
  // ongoing notification + chronometer is enough).
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (!hasVideo) return
    if (remoteRenderer == null) return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (isInPictureInPictureMode) return
    try {
      val params = PictureInPictureParams.Builder()
        .setAspectRatio(Rational(9, 16)) // portrait video frame
        .build()
      enterPictureInPictureMode(params)
      Log.d(TAG, "Entered PiP via onUserLeaveHint")
    } catch (t: Throwable) {
      Log.w(TAG, "enterPictureInPictureMode failed: ${t.message}")
    }
  }

  override fun onPictureInPictureModeChanged(
    isInPictureInPictureMode: Boolean,
    newConfig: Configuration
  ) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    // Hide controls + name/status while in PiP so only the remote video
    // tile is visible. Restore on exit.
    val vis = if (isInPictureInPictureMode) View.GONE else View.VISIBLE
    controlsRow?.visibility = vis
    nameRow?.visibility = vis
    // Local PiP camera tile also looks cluttered inside a tiny PiP window;
    // hide it too so the remote feed gets the whole frame.
    localRenderer?.visibility = vis
    Log.d(TAG, "onPictureInPictureModeChanged isInPip=$isInPictureInPictureMode")
  }
}
