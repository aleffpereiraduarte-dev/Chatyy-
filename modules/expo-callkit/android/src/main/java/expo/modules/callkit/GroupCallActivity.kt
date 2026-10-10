package expo.modules.callkit

import android.app.AlertDialog
import android.app.PictureInPictureParams
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Rational
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.events.DisconnectReason
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.renderer.SurfaceViewRenderer
import livekit.org.webrtc.RendererCommon  // [video-quality 2026-10-06] aspect-fill tiles
import io.livekit.android.room.Room
import io.livekit.android.room.participant.AudioTrackPublishDefaults
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.VideoTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.participant.LocalParticipant
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * GroupCallActivity — full-native N-way in-call screen.
 *
 * Launched by:
 *   - IncomingCallActivity accept of a GROUP call (is_group=1 push), live
 *     since 2026-05-25 (#1359);
 *   - ExpoCallKitModule.openGroupCall (legacy) / openNativeGroupCall
 *     (2026-10-09, JS services/nativeGroupCall.js — outgoing / join-ongoing).
 *
 * [2026-10-09 native-group-call] WhatsApp-level rewrite of the 2026-05-16
 * scaffold (same file, same extras, same lifecycle):
 *   - real icons + monochrome round buttons: mic, camera, flip, speaker,
 *     add person, hang up (the scaffold shipped blank ImageButtons);
 *   - local preview actually bound to the published camera track;
 *   - per-tile mic-muted badge, raised-hand badge, active-speaker ring;
 *   - tap a tile → spotlight (big tile on top, the rest below); in big grids
 *     (> 9) whoever is speaking is pulled to the top (throttled 1.5 s);
 *   - add participant = native contact list → chat_call_add (CallContacts);
 *   - speaker / earpiece via the shared AudioRouter (BT/wired wins);
 *   - reconnect: LK resume first ("Reconectando…"), then up to 2 rejoins
 *     with a FRESH token before giving up; DUPLICATE_IDENTITY / removed /
 *     room deleted end the screen right away;
 *   - outgoing: ringback + 60 s "ninguém atendeu";
 *   - shared data contract (topic chatyy.call JSON reaction / raise_hand /
 *     lower_hand) received from web / JS / iOS peers;
 *   - status pill: "mm:ss · N participantes";
 *   - leaving NEVER sends call_end (the call goes on for the others).
 *
 * adaptiveStream + dynacast stay on: RemoteVideoTrack.addRenderer(View)
 * auto-wires ViewVisibility, so each tile only pulls the layer it renders.
 */
class GroupCallActivity : ComponentActivity() {

  companion object {
    private const val TAG = "GroupCallActivity"
    const val ACTION_CLOSE = "expo.modules.callkit.CLOSE_GROUP_CALL_ACTIVITY"

    const val EXTRA_ROOM_NAME = "room_name"
    const val EXTRA_LK_URL = "lk_url"
    const val EXTRA_LK_TOKEN = "lk_token"
    const val EXTRA_PARTICIPANTS_JSON = "participants_json"
    const val EXTRA_HAS_VIDEO = "has_video"
    /** [ringback, 2026-05-19] When true the caller hears TONE_SUP_RINGTONE
     *  while waiting for any other invitee to join (mirror of CallActivity). */
    const val EXTRA_IS_OUTGOING = "is_outgoing"
    /** [2026-10-09] chat conversation id (chat_call_add context). */
    const val EXTRA_CONVERSATION_ID = "conversation_id"
    /** [2026-10-09] Header title (group name). */
    const val EXTRA_TITLE = "title"

    /** Hard cap on participants per group call (WhatsApp 2025 parity). */
    const val MAX_PARTICIPANTS = 32

    /** LiveKit data topic shared with /call.js and /livekit-room.html. */
    const val DATA_TOPIC = "chatyy.call"
    /** Contract version reported to JS (supportsNativeGroupCallUI). */
    const val NATIVE_GROUP_UI_VERSION = 1

    private const val NO_ANSWER_MS = 60_000L
    private const val REORDER_THROTTLE_MS = 1_500L
    private const val SPOKE_RECENT_MS = 4_000L

    fun bareEmail(identity: String): String =
      identity.substringBefore('#').trim().lowercase()
  }

  // Intent state.
  private var roomName: String = ""
  private var lkUrl: String? = null
  private var lkToken: String? = null
  private var hasVideo: Boolean = false
  private var conversationId: String = ""
  private var title: String = ""

  private data class InvitedParticipant(
    val email: String,
    val name: String,
    val avatarUrl: String?,
  )
  private val invited: MutableList<InvitedParticipant> = mutableListOf()

  /** One UI tile per *remote* participant identity. The local participant
   *  gets the floating preview instead of a grid tile. */
  private data class Tile(
    val frame: FrameLayout,
    val renderer: SurfaceViewRenderer,
    val nameLabel: TextView,
    val micBadge: View,
    var hasVideo: Boolean = false,
    // [2026-10-08 call-video-fix] Opaque initial-letter placeholder shown
    // while there is no live video (no track / camera muted).
    val avatar: TextView? = null,
    val handBadge: View? = null,
    var displayName: String = "",
  )

  /** [2026-10-08 call-video-fix] Show the live video (true) or the avatar. */
  private fun setTileVideo(tile: Tile, on: Boolean) {
    tile.hasVideo = on
    tile.avatar?.visibility = if (on) View.GONE else View.VISIBLE
    if (!on) { try { tile.renderer.clearImage() } catch (_: Throwable) {} }
  }
  private val tilesByIdentity: LinkedHashMap<String, Tile> = LinkedHashMap()

  // Local controls state.
  private var micEnabled = true
  private var camEnabled = true
  private var speakerOn = true

  // Views.
  private lateinit var grid: GridLayout
  private lateinit var statusText: TextView
  private lateinit var titleText: TextView
  private lateinit var muteBtn: ImageButton
  private var videoBtn: ImageButton? = null
  private var switchCamBtn: ImageButton? = null
  private var speakerBtn: ImageButton? = null
  private var reactionLayer: FrameLayout? = null

  // Local participant preview (only when hasVideo).
  private var localRenderer: SurfaceViewRenderer? = null
  private var boundLocalTrack: LocalVideoTrack? = null

  // Hidden during PiP entry so only the remote video tiles are shown.
  private var controlsRow: View? = null
  private var statusBar: View? = null

  // LiveKit.
  private var room: Room? = null
  private var eventsJob: Job? = null
  private var connectJob: Job? = null
  private var rejoinAttempts = 0
  private var finished = false

  // Status / timers.
  private val ui = Handler(Looper.getMainLooper())
  private var connectedAtMs = 0L
  private var statusOverride: String? = GroupCallStrings.s("connecting")
  private val ticker = object : Runnable {
    override fun run() {
      renderStatus()
      ui.postDelayed(this, 1000)
    }
  }
  private val noAnswerRunnable = Runnable {
    if (!finished && (room?.remoteParticipants?.isEmpty() != false)) {
      statusOverride = GroupCallStrings.s("noAnswer")
      renderStatus()
      ui.postDelayed({ finishCall(reason = "no_answer") }, 1200)
    }
  }

  // Spotlight / speaker ordering.
  private var pinnedIdentity: String? = null
  private val lastSpokeAt: HashMap<String, Long> = HashMap()
  private var lastReorderAt = 0L

  /** [ringback, 2026-05-19] Outgoing ringback tone. */
  private var isOutgoing: Boolean = false
  private var toneGen: ToneGenerator? = null

  // In-call foreground service handle.
  private var ongoingSvcIntent: Intent? = null

  private val closeReceiver = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context?, intent: Intent?) {
      val target = intent?.getStringExtra("call_id")
      if (!target.isNullOrEmpty() && roomName.isNotEmpty() && target != roomName) {
        Log.d(TAG, "closeReceiver: ignoring close for other call $target")
        return
      }
      Log.d(TAG, "closeReceiver: finishing activity")
      finishCall(reason = "close_broadcast")
    }
  }

  private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

  private fun drawable(name: String, fallback: Int): Int {
    val id = try { resources.getIdentifier(name, "drawable", packageName) } catch (_: Throwable) { 0 }
    return if (id != 0) id else fallback
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // [2026-10-10 group-call-i18n] Idioma do app (espelhado pelo JS) p/ os textos.
    GroupCallStrings.load(applicationContext)
    statusOverride = GroupCallStrings.s("connecting")

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
    try { window.statusBarColor = Color.BLACK } catch (_: Throwable) {}

    val extras = intent?.extras ?: Bundle()
    roomName = extras.getString(EXTRA_ROOM_NAME) ?: ""
    lkUrl = extras.getString(EXTRA_LK_URL)
    lkToken = extras.getString(EXTRA_LK_TOKEN)
    hasVideo = extras.getBoolean(EXTRA_HAS_VIDEO, false)
    isOutgoing = extras.getBoolean(EXTRA_IS_OUTGOING, false)
    conversationId = extras.getString(EXTRA_CONVERSATION_ID)
      ?: (if (roomName.startsWith("group_")) roomName.removePrefix("group_") else "")
    title = extras.getString(EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: GroupCallStrings.s("groupCall")
    camEnabled = hasVideo
    parseInvitedParticipants(extras.getString(EXTRA_PARTICIPANTS_JSON))

    Log.d(
      TAG,
      "onCreate: roomName=$roomName video=$hasVideo outgoing=$isOutgoing invited=${invited.size} " +
        "hasUrl=${!lkUrl.isNullOrEmpty()} hasToken=${!lkToken.isNullOrEmpty()}"
    )

    setContentView(buildRootView())

    // Pre-seed placeholder tiles for each invited participant (keyed by bare
    // email; upgraded in place when their "<email>#<device>" identity joins).
    invited.forEach { p ->
      if (!tilesByIdentity.containsKey(p.email)) {
        addTile(identity = p.email, displayName = p.name)
      }
    }
    relayoutGrid()

    // Keep process alive when backgrounded mid-call.
    val svcIntent = Intent(this, CallOngoingService::class.java).apply {
      putExtra(CallOngoingService.EXTRA_CALL_ID, roomName)
      putExtra(CallOngoingService.EXTRA_CALLER_NAME, title)
      putExtra(CallOngoingService.EXTRA_IS_GROUP, true)
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

    val filter = IntentFilter(ACTION_CLOSE)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(closeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      registerReceiver(closeReceiver, filter)
    }

    // Audio: shared router (speaker default for video, BT/wired wins).
    try {
      val router = expo.modules.callkit.audio.AudioRouter.get(applicationContext)
      router.configureForCall(hasVideo)
      speakerOn = router.speakerOn
    } catch (t: Throwable) {
      Log.w(TAG, "AudioRouter.configureForCall failed: ${t.message}")
    }
    refreshControlStates()
    ui.post(ticker)

    val url = lkUrl
    val token = lkToken
    if (!url.isNullOrEmpty() && !token.isNullOrEmpty()) {
      // Warm the per-token ICE memo when JS stashed one (openNativeGroupCall).
      try { LkTokenFetcher.getCached(applicationContext, roomName) } catch (_: Throwable) {}
      bringUpRoom(url, token)
    } else {
      fetchTokenAndConnect()
    }
    if (isOutgoing) ui.postDelayed(noAnswerRunnable, NO_ANSWER_MS)
  }

  private fun parseInvitedParticipants(json: String?) {
    invited.clear()
    if (json.isNullOrEmpty()) return
    val me = try {
      getSharedPreferences("expo_callkit_prefs", Context.MODE_PRIVATE).getString("user_email", "")?.lowercase() ?: ""
    } catch (_: Throwable) { "" }
    try {
      val arr = JSONArray(json)
      for (i in 0 until arr.length()) {
        val o = arr.optJSONObject(i) ?: continue
        val raw = o.optString("email", "").ifEmpty { o.optString("identity", "") }
        val email = bareEmail(raw)
        if (email.isEmpty() || email == me) continue
        val name = o.optString("name", email).ifEmpty { email }
        val avatar = if (o.has("avatarUrl") && !o.isNull("avatarUrl")) o.optString("avatarUrl") else null
        invited.add(InvitedParticipant(email = email, name = name, avatarUrl = avatar))
      }
    } catch (t: Throwable) {
      Log.w(TAG, "parseInvitedParticipants failed: ${t.message}")
    }
  }

  private fun fetchTokenAndConnect() {
    statusOverride = GroupCallStrings.s("connecting")
    renderStatus()
    lifecycleScope.launch {
      val res = try {
        LkTokenFetcher.fetchToken(applicationContext, roomName, hasVideo, intent?.extras)
      } catch (t: Throwable) {
        Log.w(TAG, "fetchToken threw: ${t.message}"); null
      }
      if (finished) return@launch
      if (res == null) {
        statusOverride = GroupCallStrings.s("noConnection")
        renderStatus()
        handleConnectFailure()
        return@launch
      }
      lkUrl = res.url
      lkToken = res.token
      bringUpRoom(res.url, res.token)
    }
  }

  private fun bringUpRoom(url: String, token: String) {
    // [Wave C] adaptive stream + dynacast: each tile subscribes to the layer
    // it renders; dynacast pauses layers nobody's looking at.
    val roomOptions = try {
      RoomOptions(
        adaptiveStream = true,
        dynacast = true,
        // [video-quality 2026-10-06] GROUP540 = 960x540@30, 700 kbps per tile.
        videoTrackPublishDefaults = CallVideoQuality.publishDefaults(CallVideoQuality.Profile.GROUP540),
        // [HD tuning 2026-05-26] Opus dtx + red, 48 kbps mono HD voice.
        audioTrackPublishDefaults = AudioTrackPublishDefaults(
          audioBitrate = 48_000,
          dtx = true,
          red = true
        ),
        videoTrackCaptureDefaults = CallVideoQuality.captureDefaults(applicationContext, isGroup = true),
        screenShareTrackCaptureDefaults = CallVideoQuality.screenShareCaptureDefaults(),
        screenShareTrackPublishDefaults = CallVideoQuality.screenSharePublishDefaults()
      )
    } catch (t: Throwable) {
      Log.w(TAG, "RoomOptions ctor failed: ${t.message} — defaults")
      RoomOptions()
    }
    val r = LiveKit.create(applicationContext, options = roomOptions)
    room = r

    localRenderer?.let { r.initVideoRenderer(it) }
    tilesByIdentity.values.forEach { tile -> r.initVideoRenderer(tile.renderer) }

    eventsJob = lifecycleScope.launch {
      r.events.collect { event ->
        if (room !== r) return@collect
        when (event) {
          is RoomEvent.Connected -> {
            Log.d(TAG, "RoomEvent.Connected — room=${r.name}")
            rejoinAttempts = 0
            if (connectedAtMs == 0L) connectedAtMs = System.currentTimeMillis()
            statusOverride = null
            r.remoteParticipants.values.forEach { rp -> onParticipantPresent(rp) }
            // Late join: attach tracks that were already subscribed.
            r.remoteParticipants.values.forEach { rp -> attachExistingTracks(rp) }
            if (r.remoteParticipants.isNotEmpty()) {
              stopRingback(); ui.removeCallbacks(noAnswerRunnable)
            }
            try { expo.modules.callkit.audio.AudioRouter.get(applicationContext).attachLiveKit(r, hasVideo) } catch (_: Throwable) {}
            renderStatus()
          }
          is RoomEvent.Reconnecting -> {
            statusOverride = GroupCallStrings.s("reconnecting"); renderStatus()
          }
          is RoomEvent.Reconnected -> {
            statusOverride = null; renderStatus()
          }
          is RoomEvent.Disconnected -> {
            Log.d(TAG, "RoomEvent.Disconnected reason=${event.reason} err=${event.error}")
            stopRingback()
            if (finished) return@collect
            when (event.reason) {
              DisconnectReason.CLIENT_INITIATED,
              DisconnectReason.DUPLICATE_IDENTITY,
              DisconnectReason.PARTICIPANT_REMOVED,
              DisconnectReason.ROOM_DELETED,
              DisconnectReason.ROOM_CLOSED -> finishCall(reason = "room_disconnect_${event.reason}")
              else -> handleConnectFailure()
            }
          }
          is RoomEvent.ParticipantConnected -> {
            Log.d(TAG, "ParticipantConnected ${event.participant.identity}")
            // First peer in stops the caller's ringback + no-answer timer.
            stopRingback()
            ui.removeCallbacks(noAnswerRunnable)
            onParticipantPresent(event.participant)
            renderStatus()
          }
          is RoomEvent.ParticipantDisconnected -> {
            val id = event.participant.identity?.value ?: ""
            Log.d(TAG, "ParticipantDisconnected $id")
            removeTile(id)
            renderStatus()
          }
          is RoomEvent.TrackSubscribed -> {
            val t = event.track
            val id = event.participant.identity?.value ?: ""
            if (t is VideoTrack) {
              // Screen share only takes the tile when the camera is off
              // (dedicated screen tile = follow-up).
              val isScreen = event.publication.source == Track.Source.SCREEN_SHARE
              val tile = tileFor(id, event.participant)
              val cameraLive = event.participant.getTrackPublication(Track.Source.CAMERA)
                ?.let { !it.muted && it.track != null } ?: false
              if (tile != null && !(isScreen && cameraLive)) {
                t.addRenderer(tile.renderer)
                setTileVideo(tile, !event.publication.muted)
              }
            } else {
              tilesByIdentity[id]?.let { tile ->
                tile.micBadge.visibility = if (event.publication.muted) View.VISIBLE else View.GONE
              }
            }
          }
          is RoomEvent.TrackUnsubscribed -> {
            val t = event.track
            val id = event.participant.identity?.value ?: ""
            if (t is VideoTrack) {
              tilesByIdentity[id]?.let { tile ->
                try { t.removeRenderer(tile.renderer) } catch (_: Throwable) {}
                setTileVideo(tile, false)
              }
            }
          }
          // [2026-10-08 call-video-fix] Remote camera off/on WITHOUT
          // unsubscribe (mute) — avatar and back. Mic mute → badge.
          is RoomEvent.TrackMuted -> if (event.participant !is LocalParticipant) {
            val pub = event.publication
            val tile = tilesByIdentity[event.participant.identity?.value ?: ""]
            if (pub.source == Track.Source.CAMERA || pub.track is VideoTrack) {
              tile?.let { setTileVideo(it, false) }
            } else if (pub.source == Track.Source.MICROPHONE) {
              tile?.micBadge?.visibility = View.VISIBLE
            }
          }
          is RoomEvent.TrackUnmuted -> if (event.participant !is LocalParticipant) {
            val pub = event.publication
            val tile = tilesByIdentity[event.participant.identity?.value ?: ""]
            if (pub.source == Track.Source.CAMERA || pub.track is VideoTrack) {
              tile?.let { tt ->
                val vt = pub.track as? VideoTrack
                if (vt != null) { try { vt.addRenderer(tt.renderer) } catch (_: Throwable) {} }
                setTileVideo(tt, vt != null)
              }
            } else if (pub.source == Track.Source.MICROPHONE) {
              tile?.micBadge?.visibility = View.GONE
            }
          }
          // Local camera publish → bind the floating preview.
          is RoomEvent.TrackPublished -> if (event.participant is LocalParticipant) {
            val track = event.publication.track
            if (track is LocalVideoTrack) bindLocalVideoTrack(track)
          }
          is RoomEvent.ActiveSpeakersChanged -> onActiveSpeakers(event.speakers)
          is RoomEvent.DataReceived -> onDataReceived(event.data, event.participant?.identity?.value)
          else -> { /* no-op */ }
        }
      }
    }

    if (isOutgoing && connectedAtMs == 0L) startRingback()

    connectJob = lifecycleScope.launch {
      try {
        r.connect(url, token, LkTokenFetcher.connectOptionsFor(token))
        r.localParticipant.setMicrophoneEnabled(micEnabled)
        if (hasVideo && camEnabled) {
          r.localParticipant.setCameraEnabled(true)
          bindLocalCameraIfReady(r)
        }
        Log.d(TAG, "LK group connect + publish OK")
      } catch (t: Throwable) {
        Log.e(TAG, "LK group connect failed: ${t.message}", t)
        if (room === r && !finished) handleConnectFailure()
      }
    }
  }

  /** Bounded rejoin with a FRESH token (old one may be expired / its
   *  identity slot dead). Gives up after 2 attempts. */
  @OptIn(DelicateCoroutinesApi::class)
  private fun handleConnectFailure() {
    if (finished) return
    if (rejoinAttempts >= 2) {
      statusOverride = GroupCallStrings.s("connectionFailed")
      renderStatus()
      ui.postDelayed({ finishCall(reason = "connect_failed") }, 1500)
      return
    }
    rejoinAttempts += 1
    statusOverride = GroupCallStrings.s("reconnecting")
    renderStatus()
    val old = room
    room = null
    eventsJob?.cancel()
    connectJob?.cancel()
    boundLocalTrack = null
    if (old != null) {
      GlobalScope.launch(Dispatchers.IO) { try { old.disconnect() } catch (_: Throwable) {} }
    }
    try { LkTokenFetcher.clearCached(applicationContext, roomName) } catch (_: Throwable) {}
    lkToken = null
    ui.postDelayed({ if (!finished) fetchTokenAndConnect() }, 1200L * rejoinAttempts)
  }

  // ────────────── Ringback (outgoing only)

  private fun startRingback() {
    if (toneGen != null) return
    try {
      val tg = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 60)
      tg.startTone(ToneGenerator.TONE_SUP_RINGTONE, 30_000)
      toneGen = tg
    } catch (t: Throwable) {
      Log.w(TAG, "group ringback init failed: ${t.message}")
      toneGen = null
    }
  }

  private fun stopRingback() {
    val tg = toneGen ?: return
    toneGen = null
    try { tg.stopTone() } catch (_: Throwable) {}
    try { tg.release() } catch (_: Throwable) {}
  }

  // ────────────── Participants / tiles

  /** Tile for a LiveKit identity; adopts the roster placeholder keyed by the
   *  bare email, or creates one. */
  private fun tileFor(identity: String, p: Participant?): Tile? {
    if (identity.isEmpty()) return null
    tilesByIdentity[identity]?.let { return it }
    val bare = bareEmail(identity)
    val placeholder = tilesByIdentity[bare]
    if (placeholder != null) {
      // Re-key bare email → LK identity, keeping the tile's grid position.
      val ordered = LinkedHashMap<String, Tile>()
      tilesByIdentity.forEach { (k, v) -> ordered[if (k == bare) identity else k] = v }
      tilesByIdentity.clear()
      tilesByIdentity.putAll(ordered)
      val name = displayNameFor(identity, p)
      placeholder.displayName = name
      placeholder.nameLabel.text = name
      if (pinnedIdentity == bare) pinnedIdentity = identity
      return placeholder
    }
    addTile(identity = identity, displayName = displayNameFor(identity, p))
    relayoutGrid()
    return tilesByIdentity[identity]
  }

  private fun onParticipantPresent(p: Participant) {
    val id = p.identity?.value ?: return
    tileFor(id, p)
    tilesByIdentity[id]?.micBadge?.visibility =
      if (p.getTrackPublication(Track.Source.MICROPHONE)?.muted == true) View.VISIBLE else View.GONE
  }

  private fun attachExistingTracks(p: Participant) {
    val id = p.identity?.value ?: return
    val tile = tilesByIdentity[id] ?: return
    val pub = p.getTrackPublication(Track.Source.CAMERA) ?: return
    val vt = pub.track as? VideoTrack ?: return
    try { vt.addRenderer(tile.renderer) } catch (_: Throwable) {}
    setTileVideo(tile, !pub.muted)
  }

  private fun displayNameFor(identity: String, p: Participant?): String {
    val n = p?.name?.takeIf { it.isNotEmpty() && it != identity && !it.contains('#') }
    if (n != null) return n
    val bare = bareEmail(identity)
    val invitedMatch = invited.firstOrNull { it.email.equals(bare, ignoreCase = true) }
    return invitedMatch?.name ?: bare.substringBefore('@').ifEmpty { identity }
  }

  private fun onActiveSpeakers(speakers: List<Participant>) {
    val now = System.currentTimeMillis()
    val ids = speakers.mapNotNull { it.identity?.value }.toSet()
    ids.forEach { lastSpokeAt[it] = now }
    tilesByIdentity.forEach { (id, tile) ->
      tile.frame.foreground = if (ids.contains(id)) speakerRing() else null
    }
    // Big grids: keep the people talking on screen.
    if (tilesByIdentity.size > 9 && pinnedIdentity == null && now - lastReorderAt > REORDER_THROTTLE_MS) {
      val firstPage = tilesByIdentity.keys.take(6).toSet()
      val recent = tilesByIdentity.keys.filter { now - (lastSpokeAt[it] ?: 0L) < SPOKE_RECENT_MS }
      if (recent.any { it !in firstPage }) {
        lastReorderAt = now
        val ordered = LinkedHashMap<String, Tile>()
        recent.forEach { k -> tilesByIdentity[k]?.let { ordered[k] = it } }
        tilesByIdentity.forEach { (k, v) -> if (!ordered.containsKey(k)) ordered[k] = v }
        tilesByIdentity.clear()
        tilesByIdentity.putAll(ordered)
        rebuildGridChildren()
      }
    }
  }

  private fun speakerRing(): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    cornerRadius = dp(12).toFloat()
    setStroke(dp(3), Color.WHITE)
    setColor(Color.TRANSPARENT)
  }

  private fun onDataReceived(data: ByteArray, fromIdentity: String?) {
    val txt = try { String(data, Charsets.UTF_8) } catch (_: Throwable) { "" }
    if (txt.isEmpty()) return
    if (txt.startsWith("R:")) { showReaction(txt.removePrefix("R:")); return }
    if (txt.startsWith("H:")) { setHand(fromIdentity, txt == "H:1"); return }
    try {
      val obj = JSONObject(txt)
      when (obj.optString("type")) {
        "reaction" -> showReaction(obj.optString("emoji"))
        "raise_hand" -> setHand(fromIdentity ?: obj.optString("email"), true)
        "lower_hand" -> setHand(fromIdentity ?: obj.optString("email"), false)
        "hand_raise" -> setHand(fromIdentity, obj.optBoolean("raised", false))
      }
    } catch (_: Throwable) { /* not ours */ }
  }

  private fun setHand(identity: String?, raised: Boolean) {
    val key = bareEmail(identity ?: "")
    if (key.isEmpty()) return
    tilesByIdentity.entries.firstOrNull { bareEmail(it.key) == key }?.value?.handBadge?.visibility =
      if (raised) View.VISIBLE else View.GONE
  }

  /** Floating reaction (user content) rising over the grid for ~2.5 s. */
  private fun showReaction(emoji: String) {
    val layer = reactionLayer ?: return
    if (emoji.isBlank()) return
    val tv = TextView(this).apply {
      text = emoji.take(16)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 34f)
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply {
        gravity = Gravity.BOTTOM or Gravity.START
        leftMargin = dp(24 + (Math.random() * 220).toInt())
        bottomMargin = dp(150)
      }
    }
    layer.addView(tv)
    tv.animate().translationY(-dp(260).toFloat()).alpha(0f).setDuration(2500)
      .withEndAction { try { layer.removeView(tv) } catch (_: Throwable) {} }
      .start()
  }

  private fun addTile(identity: String, displayName: String) {
    val frame = FrameLayout(this).apply {
      background = GradientDrawable().apply {
        cornerRadius = dp(12).toFloat()
        setColor(Color.parseColor("#1C1C1E"))
      }
      clipToOutline = true
      setOnClickListener { togglePin(identity) }
    }

    val renderer = SurfaceViewRenderer(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
      // [video-quality 2026-10-06] fill the tile (no letterbox bars).
      try { setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL) } catch (_: Throwable) {}
    }
    frame.addView(renderer)
    room?.initVideoRenderer(renderer)

    val avatar = TextView(this).apply {
      gravity = Gravity.CENTER
      setBackgroundColor(Color.parseColor("#1C1C1E"))
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 36f)
      text = (displayName.firstOrNull()?.uppercase() ?: "?")
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }
    frame.addView(avatar)

    // Name pill — bottom-left.
    val name = TextView(this).apply {
      text = displayName
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      maxLines = 1
      background = GradientDrawable().apply {
        cornerRadius = dp(12).toFloat()
        setColor(Color.parseColor("#99000000"))
      }
      setPadding(dp(8), dp(3), dp(8), dp(3))
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply {
        gravity = Gravity.BOTTOM or Gravity.START
        leftMargin = dp(8)
        bottomMargin = dp(8)
      }
    }
    frame.addView(name)

    // Mic-muted badge — top-left.
    val mic = ImageView(this).apply {
      setImageResource(drawable("mic_off", android.R.drawable.ic_lock_silent_mode))
      imageTintList = ColorStateList.valueOf(Color.WHITE)
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(Color.parseColor("#99000000"))
      }
      setPadding(dp(4), dp(4), dp(4), dp(4))
      visibility = View.GONE
      layoutParams = FrameLayout.LayoutParams(dp(24), dp(24)).apply {
        gravity = Gravity.TOP or Gravity.START
        leftMargin = dp(8)
        topMargin = dp(8)
      }
    }
    frame.addView(mic)

    // Raised-hand badge — top-right.
    val hand = ImageView(this).apply {
      setImageResource(drawable("gc_hand", android.R.drawable.star_on))
      imageTintList = ColorStateList.valueOf(Color.BLACK)
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(Color.WHITE)
      }
      setPadding(dp(5), dp(5), dp(5), dp(5))
      visibility = View.GONE
      layoutParams = FrameLayout.LayoutParams(dp(26), dp(26)).apply {
        gravity = Gravity.TOP or Gravity.END
        rightMargin = dp(8)
        topMargin = dp(8)
      }
    }
    frame.addView(hand)

    tilesByIdentity[identity] = Tile(frame, renderer, name, mic, hasVideo = false, avatar = avatar, handBadge = hand, displayName = displayName)
    grid.addView(frame)
  }

  private fun removeTile(identity: String) {
    val tile = tilesByIdentity.remove(identity) ?: return
    try { grid.removeView(tile.frame) } catch (_: Throwable) {}
    try { tile.renderer.release() } catch (_: Throwable) {}
    lastSpokeAt.remove(identity)
    if (pinnedIdentity == identity) pinnedIdentity = null
    relayoutGrid()
  }

  private fun togglePin(identity: String) {
    // tileFor() may have re-keyed the placeholder → resolve current key.
    val key = if (tilesByIdentity.containsKey(identity)) identity
      else tilesByIdentity.keys.firstOrNull { bareEmail(it) == bareEmail(identity) } ?: return
    if (tilesByIdentity.size < 2 && pinnedIdentity == null) return
    pinnedIdentity = if (pinnedIdentity == key) null else key
    rebuildGridChildren()
  }

  /** Re-add children in map order (GridLayout lays out by child index). */
  private fun rebuildGridChildren() {
    try {
      grid.removeAllViews()
      val pinned = pinnedIdentity?.let { tilesByIdentity[it] }
      if (pinned != null) grid.addView(pinned.frame)
      tilesByIdentity.forEach { (k, t) -> if (k != pinnedIdentity) grid.addView(t.frame) }
    } catch (t: Throwable) {
      Log.w(TAG, "rebuildGridChildren failed: ${t.message}")
    }
    relayoutGrid()
  }

  /**
   * Rows/columns per tile count (WhatsApp-like):
   *   1 → full screen · 2 → vertical split · 3-4 → 2×2 · 5-9 → 3 cols ·
   *   10+ → 2 cols scrolling. Spotlight (pinned): pinned tile spans the full
   *   width with 3× weight, the others below in up to 3 columns.
   */
  private fun relayoutGrid() {
    val n = tilesByIdentity.size.coerceAtMost(MAX_PARTICIPANTS)
    if (n == 0) {
      grid.columnCount = 1
      grid.rowCount = 1
      return
    }
    val gutter = dp(3)
    val pinned = pinnedIdentity?.takeIf { tilesByIdentity.containsKey(it) && n >= 2 }
    if (pinned != null) {
      val others = n - 1
      val cols = others.coerceIn(1, 3)
      val otherRows = (others + cols - 1) / cols
      grid.columnCount = cols
      grid.rowCount = 1 + otherRows
      var i = 0
      tilesByIdentity.forEach { (k, tile) ->
        val lp = if (k == pinned) {
          GridLayout.LayoutParams(
            GridLayout.spec(0, 1, GridLayout.FILL, 3f),
            GridLayout.spec(0, cols, GridLayout.FILL, 1f)
          )
        } else {
          val row = 1 + i / cols
          val col = i % cols
          i++
          GridLayout.LayoutParams(
            GridLayout.spec(row, 1, GridLayout.FILL, 1f),
            GridLayout.spec(col, 1, GridLayout.FILL, 1f)
          )
        }
        lp.width = 0; lp.height = 0
        lp.setMargins(gutter, gutter, gutter, gutter)
        tile.frame.layoutParams = lp
      }
      grid.requestLayout()
      return
    }
    val cols: Int
    val rows: Int
    when {
      n == 1 -> { cols = 1; rows = 1 }
      n == 2 -> { cols = 1; rows = 2 }
      n <= 4 -> { cols = 2; rows = 2 }
      n <= 9 -> { cols = 3; rows = ((n + 2) / 3) }
      else   -> { cols = 2; rows = ((n + 1) / 2) }
    }
    grid.columnCount = cols
    grid.rowCount = rows
    val tileH = if (n > 9) dp(200) else 0
    tilesByIdentity.values.toList().forEachIndexed { i, tile ->
      val lp = GridLayout.LayoutParams(
        GridLayout.spec(i / cols, 1, GridLayout.FILL, if (n > 9) 0f else 1f),
        GridLayout.spec(i % cols, 1, GridLayout.FILL, 1f)
      ).apply {
        width = 0
        height = tileH
        setMargins(gutter, gutter, gutter, gutter)
      }
      tile.frame.layoutParams = lp
    }
    grid.requestLayout()
  }

  // ─── Local preview ────────────────────────────────────────────────────────

  private fun bindLocalCameraIfReady(r: Room) {
    val lt = r.localParticipant.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack ?: return
    bindLocalVideoTrack(lt)
  }

  private fun bindLocalVideoTrack(track: LocalVideoTrack) {
    val lr = localRenderer ?: return
    if (boundLocalTrack === track) return
    try { boundLocalTrack?.removeRenderer(lr) } catch (_: Throwable) {}
    try {
      track.addRenderer(lr)
      boundLocalTrack = track
      lr.visibility = if (camEnabled) View.VISIBLE else View.GONE
    } catch (t: Throwable) {
      Log.w(TAG, "bind local preview failed: ${t.message}")
    }
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  private fun renderStatus() {
    if (!::statusText.isInitialized) return
    val override = statusOverride
    if (override != null) { statusText.text = override; return }
    val count = (room?.remoteParticipants?.size ?: 0) + 1
    val secs = if (connectedAtMs > 0) ((System.currentTimeMillis() - connectedAtMs) / 1000).toInt() else 0
    val mmss = String.format(java.util.Locale.US, "%02d:%02d", secs / 60, secs % 60)
    statusText.text = if (count <= 1) GroupCallStrings.s("waitingOthers") else "$mmss · ${GroupCallStrings.participants(count)}"
  }

  // ─── Build view tree ──────────────────────────────────────────────────────

  private fun roundButton(sizeDp: Int, bg: Int, iconRes: Int, iconTint: Int, desc: String, onClick: () -> Unit): ImageButton {
    return ImageButton(this).apply {
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(bg)
      }
      setImageResource(iconRes)
      imageTintList = ColorStateList.valueOf(iconTint)
      scaleType = ImageView.ScaleType.CENTER_INSIDE
      val pad = dp(sizeDp) / 4
      setPadding(pad, pad, pad, pad)
      contentDescription = desc
      layoutParams = ViewGroup.LayoutParams(dp(sizeDp), dp(sizeDp))
      setOnClickListener { onClick() }
    }
  }

  private fun setButtonState(btn: ImageButton?, on: Boolean, iconOn: Int, iconOff: Int) {
    btn ?: return
    // "on" = default state (dark button, white glyph); off = inverted (white
    // button, black glyph) — WhatsApp-style toggles, monochrome.
    (btn.background as? GradientDrawable)?.setColor(if (on) Color.parseColor("#2C2C2E") else Color.WHITE)
    btn.setImageResource(if (on) iconOn else iconOff)
    btn.imageTintList = ColorStateList.valueOf(if (on) Color.WHITE else Color.BLACK)
  }

  private fun refreshControlStates() {
    val micOn = drawable("gc_mic", android.R.drawable.ic_btn_speak_now)
    val micOff = drawable("mic_off", android.R.drawable.ic_lock_silent_mode)
    setButtonState(muteBtn, micEnabled, micOn, micOff)
    val camOn = drawable("gc_videocam", android.R.drawable.ic_menu_camera)
    val camOff = drawable("cam_off", android.R.drawable.ic_menu_camera)
    setButtonState(videoBtn, camEnabled, camOn, camOff)
    val spk = drawable("gc_volume_up", android.R.drawable.ic_lock_silent_mode_off)
    val ear = drawable("gc_hearing", android.R.drawable.ic_menu_call)
    // Speaker: highlighted (white) when ON, like the iOS screen.
    speakerBtn?.let { b ->
      (b.background as? GradientDrawable)?.setColor(if (speakerOn) Color.WHITE else Color.parseColor("#2C2C2E"))
      b.setImageResource(if (speakerOn) spk else ear)
      b.imageTintList = ColorStateList.valueOf(if (speakerOn) Color.BLACK else Color.WHITE)
    }
    localRenderer?.visibility = if (hasVideo && camEnabled && boundLocalTrack != null) View.VISIBLE else View.GONE
  }

  private fun buildRootView(): View {
    val root = FrameLayout(this).apply {
      setBackgroundColor(Color.BLACK)
      layoutParams = ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }

    // Grid area between the header and the controls.
    val gridScroll = android.widget.ScrollView(this).apply {
      isFillViewport = true
      overScrollMode = View.OVER_SCROLL_NEVER
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ).apply {
        topMargin = dp(92)
        bottomMargin = dp(124)
        leftMargin = dp(6)
        rightMargin = dp(6)
      }
    }
    grid = GridLayout(this).apply {
      columnCount = 1
      rowCount = 1
      layoutParams = ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }
    gridScroll.addView(grid)
    root.addView(gridScroll)

    // Header: minimize · title / status.
    val header = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(12), dp(36), dp(12), dp(8))
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply { gravity = Gravity.TOP }
    }
    val minimize = roundButton(40, Color.parseColor("#2C2C2E"),
      drawable("gc_minimize", android.R.drawable.arrow_down_float), Color.WHITE, GroupCallStrings.s("minimize")) {
      minimizeCall()
    }
    header.addView(minimize, LinearLayout.LayoutParams(dp(40), dp(40)))
    val titles = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(12), 0, dp(12), 0)
    }
    titleText = TextView(this).apply {
      text = title
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
      maxLines = 1
      typeface = android.graphics.Typeface.DEFAULT_BOLD
    }
    statusText = TextView(this).apply {
      text = GroupCallStrings.s("connecting")
      setTextColor(Color.parseColor("#9E9E9E"))
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      maxLines = 1
    }
    titles.addView(titleText)
    titles.addView(statusText)
    header.addView(titles, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    root.addView(header)
    statusBar = header

    // Local preview (only when video) — top-right over the grid.
    if (hasVideo) {
      localRenderer = SurfaceViewRenderer(this).apply {
        layoutParams = FrameLayout.LayoutParams(dp(96), dp(132)).apply {
          gravity = Gravity.TOP or Gravity.END
          topMargin = dp(100)
          rightMargin = dp(14)
        }
        try { setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL) } catch (_: Throwable) {}
        try { setMirror(true) } catch (_: Throwable) {}
        try { setZOrderMediaOverlay(true) } catch (_: Throwable) {}
        visibility = View.GONE
      }
      root.addView(localRenderer)
    }

    // Reactions float in their own non-interactive layer.
    reactionLayer = FrameLayout(this).apply {
      isClickable = false
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }
    root.addView(reactionLayer)

    // Controls: mic · camera · flip · speaker · add · hang up.
    val controls = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
      setPadding(dp(8), dp(14), dp(8), dp(34))
      background = GradientDrawable().apply {
        cornerRadii = floatArrayOf(dp(24).toFloat(), dp(24).toFloat(), dp(24).toFloat(), dp(24).toFloat(), 0f, 0f, 0f, 0f)
        setColor(Color.parseColor("#121212"))
      }
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply { gravity = Gravity.BOTTOM }
    }
    root.addView(controls)
    controlsRow = controls

    val gap = dp(10)
    fun addCtl(v: View, size: Int) {
      controls.addView(v, LinearLayout.LayoutParams(dp(size), dp(size)).apply {
        marginStart = gap / 2; marginEnd = gap / 2
      })
    }

    muteBtn = roundButton(52, Color.parseColor("#2C2C2E"), drawable("gc_mic", android.R.drawable.ic_btn_speak_now), Color.WHITE, GroupCallStrings.s("microphone")) {
      micEnabled = !micEnabled
      refreshControlStates()
      lifecycleScope.launch {
        try { room?.localParticipant?.setMicrophoneEnabled(micEnabled) }
        catch (t: Throwable) { Log.w(TAG, "setMicrophoneEnabled failed: ${t.message}") }
      }
    }
    addCtl(muteBtn, 52)

    if (hasVideo) {
      val vb = roundButton(52, Color.parseColor("#2C2C2E"), drawable("gc_videocam", android.R.drawable.ic_menu_camera), Color.WHITE, GroupCallStrings.s("camera")) {
        camEnabled = !camEnabled
        refreshControlStates()
        lifecycleScope.launch {
          try {
            val r = room ?: return@launch
            // [2026-10-08 call-video-fix] Mute the PUBLICATION (peers swap to
            // the avatar) instead of track.enabled (frozen last frame).
            r.localParticipant.setCameraEnabled(camEnabled)
            if (camEnabled) bindLocalCameraIfReady(r)
            refreshControlStates()
          } catch (t: Throwable) {
            Log.w(TAG, "toggleCam failed: ${t.message}")
          }
        }
      }
      addCtl(vb, 52)
      videoBtn = vb

      val sc = roundButton(52, Color.parseColor("#2C2C2E"), drawable("gc_flip_camera", android.R.drawable.ic_menu_rotate), Color.WHITE, GroupCallStrings.s("flipCamera")) {
        // [2026-10-08 call-video-fix] Swap the device on the same track.
        lifecycleScope.launch {
          try {
            val lt = room?.localParticipant?.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack
            if (lt != null) {
              val target = if (lt.options.position == io.livekit.android.room.track.CameraPosition.BACK)
                io.livekit.android.room.track.CameraPosition.FRONT
              else io.livekit.android.room.track.CameraPosition.BACK
              lt.switchCamera(position = target)
              try { localRenderer?.setMirror(target == io.livekit.android.room.track.CameraPosition.FRONT) } catch (_: Throwable) {}
            }
          } catch (t: Throwable) {
            Log.w(TAG, "switch camera failed: ${t.message}")
          }
        }
      }
      addCtl(sc, 52)
      switchCamBtn = sc
    }

    val spk = roundButton(52, Color.parseColor("#2C2C2E"), drawable("gc_volume_up", android.R.drawable.ic_lock_silent_mode_off), Color.WHITE, GroupCallStrings.s("speaker")) {
      try {
        speakerOn = expo.modules.callkit.audio.AudioRouter.get(applicationContext).setSpeaker(!speakerOn)
      } catch (t: Throwable) {
        Log.w(TAG, "setSpeaker failed: ${t.message}")
      }
      refreshControlStates()
    }
    addCtl(spk, 52)
    speakerBtn = spk

    val add = roundButton(52, Color.parseColor("#2C2C2E"), drawable("gc_person_add", android.R.drawable.ic_menu_add), Color.WHITE, GroupCallStrings.s("addPerson")) {
      showAddParticipant()
    }
    addCtl(add, 52)

    val hangupBtn = roundButton(60, Color.parseColor("#E53935"), drawable("phone_end", android.R.drawable.ic_menu_close_clear_cancel), Color.WHITE, GroupCallStrings.s("leaveCall")) {
      finishCall(reason = "user_hangup")
    }
    addCtl(hangupBtn, 60)

    return root
  }

  // ─── Add participant ──────────────────────────────────────────────────────

  private fun showAddParticipant() {
    val extras = intent?.extras
    val present = HashSet<String>()
    room?.remoteParticipants?.values?.forEach { p -> p.identity?.value?.let { present.add(bareEmail(it)) } }
    Toast.makeText(this, GroupCallStrings.s("loadingContacts"), Toast.LENGTH_SHORT).show()
    lifecycleScope.launch {
      val contacts = withContext(Dispatchers.IO) {
        try { CallContacts.fetchContacts(applicationContext, extras) } catch (_: Throwable) { emptyList() }
      }.filter { bareEmail(it.email) !in present }
      if (finished || isFinishing) return@launch
      if (contacts.isEmpty()) {
        Toast.makeText(this@GroupCallActivity, GroupCallStrings.s("noContacts"), Toast.LENGTH_SHORT).show()
        return@launch
      }
      val labels = contacts.map { c -> c.name.ifEmpty { c.email } }.toTypedArray()
      try {
        AlertDialog.Builder(this@GroupCallActivity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
          .setTitle(GroupCallStrings.s("addToCall"))
          .setItems(labels) { _, which ->
            val c = contacts.getOrNull(which) ?: return@setItems
            lifecycleScope.launch {
              val ok = withContext(Dispatchers.IO) {
                try {
                  CallContacts.ringIntoCall(applicationContext, roomName, conversationId, c.email, hasVideo, extras)
                } catch (_: Throwable) { false }
              }
              if (!finished) {
                Toast.makeText(
                  this@GroupCallActivity,
                  if (ok) GroupCallStrings.s("calling", "name" to labels[which]) else GroupCallStrings.s("couldNotCall"),
                  Toast.LENGTH_SHORT
                ).show()
              }
              if (ok) {
                val bare = bareEmail(c.email)
                if (tilesByIdentity.keys.none { bareEmail(it) == bare }) {
                  invited.add(InvitedParticipant(bare, labels[which], null))
                  addTile(identity = bare, displayName = labels[which])
                  relayoutGrid()
                }
              }
            }
          }
          .setNegativeButton(GroupCallStrings.s("cancel"), null)
          .show()
      } catch (t: Throwable) {
        Log.w(TAG, "add participant dialog failed: ${t.message}")
      }
    }
  }

  // ─── Lifecycle / teardown ─────────────────────────────────────────────────

  @OptIn(DelicateCoroutinesApi::class)
  override fun onDestroy() {
    try { unregisterReceiver(closeReceiver) } catch (_: Exception) {}
    ui.removeCallbacksAndMessages(null)
    stopRingback()
    eventsJob?.cancel()
    connectJob?.cancel()
    val r = room
    room = null
    if (r != null) {
      GlobalScope.launch(Dispatchers.IO) {
        try { r.disconnect() } catch (t: Throwable) {
          Log.w(TAG, "room.disconnect() threw: ${t.message}")
        }
      }
    }
    if (!finished) {
      // Killed without a hangup (system / swipe) → still report the end.
      finished = true
      ongoingSvcIntent?.let { try { stopService(it) } catch (_: Throwable) {} }
      endTelecom("destroyed")
      try { ExpoCallKitModule.emitCallEnded(roomName) } catch (_: Throwable) {}
    }
    try { expo.modules.callkit.audio.AudioRouter.get(applicationContext).teardown() } catch (_: Throwable) {}
    tilesByIdentity.values.forEach { tile ->
      try { tile.renderer.release() } catch (_: Throwable) {}
    }
    tilesByIdentity.clear()
    try { localRenderer?.release() } catch (_: Throwable) {}
    super.onDestroy()
  }

  private fun finishCall(reason: String) {
    if (finished) { finish(); return }
    finished = true
    Log.d(TAG, "finishCall reason=$reason room=$roomName")
    ui.removeCallbacksAndMessages(null)
    stopRingback()
    ongoingSvcIntent?.let {
      try { stopService(it) } catch (t: Throwable) {
        Log.w(TAG, "stopService(CallOngoingService) failed: ${t.message}")
      }
    }
    ongoingSvcIntent = null
    eventsJob?.cancel()
    connectJob?.cancel()
    endTelecom(reason)
    // Leaving ≠ ending for everyone: no call_end. JS closes our history row.
    ExpoCallKitModule.emitCallEnded(roomName)
    finish()
  }

  /** The incoming group ring registered a self-managed Telecom connection
   *  (FCM → addNewIncomingCall); end it so Telecom doesn't keep a ghost
   *  ACTIVE call after we leave (CallActivity does the same). */
  private fun endTelecom(reason: String) {
    if (roomName.isEmpty()) return
    try {
      val cause = if (reason == "close_broadcast") android.telecom.DisconnectCause.REMOTE
                  else android.telecom.DisconnectCause.LOCAL
      IncomingCallRegistry.endTelecom(roomName, cause, "group_activity:$reason")
      IncomingCallRegistry.forget(roomName)
    } catch (t: Throwable) {
      Log.w(TAG, "endTelecom failed: ${t.message}")
    }
  }

  private fun minimizeCall() {
    if (hasVideo && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      enterPip()
    } else {
      // Audio: back to the app; the ongoing-call notification brings us back.
      bringHostAppToFront()
      moveTaskToBack(true)
    }
  }

  @Deprecated("Back = minimize (the call keeps running)")
  override fun onBackPressed() {
    minimizeCall()
  }

  // ─── PiP ───────────────────────────────────────────────────────────────────

  private fun bringHostAppToFront() {
    // [BUG 2 fix 2026-05-26] This activity runs in an isolated empty-affinity
    // task; bring the host RN app to front so the user isn't left on a dead
    // surface behind the mini-window.
    try {
      val launch = packageManager.getLaunchIntentForPackage(packageName)
      if (launch != null) {
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        startActivity(launch)
      }
    } catch (t: Throwable) { Log.w(TAG, "bring app to front failed: ${t.message}") }
  }

  private fun enterPip() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (isInPictureInPictureMode) return
    bringHostAppToFront()
    try {
      val params = PictureInPictureParams.Builder()
        .setAspectRatio(Rational(9, 16))
        .build()
      enterPictureInPictureMode(params)
    } catch (t: Throwable) {
      Log.w(TAG, "enterPictureInPictureMode failed: ${t.message}")
    }
  }

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (!hasVideo || finished) return
    enterPip()
  }

  override fun onPictureInPictureModeChanged(
    isInPictureInPictureMode: Boolean,
    newConfig: Configuration
  ) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    val vis = if (isInPictureInPictureMode) View.GONE else View.VISIBLE
    controlsRow?.visibility = vis
    statusBar?.visibility = vis
    if (isInPictureInPictureMode) {
      localRenderer?.visibility = View.GONE
    } else {
      refreshControlStates()
    }
    // [Bridge #2 2026-05-19] Same JS bridge as 1:1 CallActivity.
    try { ExpoCallKitModule.emitPipChanged(isInPictureInPictureMode) } catch (_: Throwable) {}
  }
}
