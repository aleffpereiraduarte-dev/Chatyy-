package expo.modules.callkit

import android.app.PictureInPictureParams
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.Color
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
import android.widget.GridLayout
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
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONArray

/**
 * GroupCallActivity — full-native N-way in-call screen (2026-05-16 scaffold).
 *
 * Sibling of CallActivity. Where CallActivity owns the 1:1 UX (single remote
 * SurfaceViewRenderer fullscreen + local PiP), this activity owns the group
 * UX: a dynamic NxN grid of tiles, one per remote participant + local PiP
 * tile in the top-right corner.
 *
 * Layout strategy:
 *   - Background: GridLayout (programmatic, not XML, not RecyclerView). When
 *     the participant set changes we wipe + rebuild children. Cheap because
 *     the SurfaceViewRenderer instances are reused via the tilesByIdentity
 *     map — only the LayoutParams (row/columnSpec) are recomputed.
 *   - 1 remote   → 1 column, 1 row (the tile MATCH_PARENTs the grid).
 *   - 2 remotes  → 1 column, 2 rows (vertical split).
 *   - 3-4        → 2 columns, 2 rows.
 *   - 5+         → 3 columns, ceil(N/3) rows.
 *
 * Tile lifecycle:
 *   - addTileForParticipant(identity, name) creates a FrameLayout containing
 *     a SurfaceViewRenderer (registered with room.initVideoRenderer so the
 *     EGL context exists before any VideoTrack lands on it), a name overlay
 *     and a mic-muted badge. If the participant set is from intent extras we
 *     pre-create placeholder tiles before ParticipantConnected fires so the
 *     user sees "waiting" tiles for everyone in the call.
 *   - RoomEvent.ParticipantConnected upgrades the placeholder (or creates
 *     one if the participant wasn't in the intent — e.g., someone joins
 *     later via WS invite).
 *   - RoomEvent.TrackSubscribed (VideoTrack) calls track.addRenderer(tile.renderer).
 *   - RoomEvent.ParticipantDisconnected removes the tile + relayouts the grid.
 *
 * Notes:
 *   - We do NOT add new gradle deps. Everything is stdlib + the existing
 *     livekit-android 2.24.x + androidx.lifecycle declarations.
 *   - No Jetpack Compose, no RecyclerView — keep build risk minimal.
 *   - openGroupCall extras are bundled by ExpoCallKitModule.openGroupCall.
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
  }

  // Intent state.
  private var roomName: String = ""
  private var lkUrl: String? = null
  private var lkToken: String? = null
  private var hasVideo: Boolean = false

  /** Each invited participant from JS — email is the stable key, name is the
   *  display label. avatarUrl is unused in the skeleton (placeholder tile
   *  shows the first letter of name like CallActivity). */
  private data class InvitedParticipant(
    val email: String,
    val name: String,
    val avatarUrl: String?,
  )
  private val invited: MutableList<InvitedParticipant> = mutableListOf()

  /** One UI tile per *remote* participant identity (email-equivalent). The
   *  local participant gets a dedicated PiP renderer instead of a grid tile. */
  private data class Tile(
    val frame: FrameLayout,
    val renderer: SurfaceViewRenderer,
    val nameLabel: TextView,
    val micBadge: TextView,
    var hasVideo: Boolean = false,
  )
  private val tilesByIdentity: LinkedHashMap<String, Tile> = LinkedHashMap()

  // Local controls state — mirrors CallActivity.
  private var micEnabled = true
  private var camEnabled = true
  private var screenShareEnabled = false

  // Views.
  private lateinit var grid: GridLayout
  private lateinit var statusText: TextView
  private lateinit var muteBtn: ImageButton
  private var videoBtn: ImageButton? = null
  private var screenShareBtn: ImageButton? = null
  private var switchCamBtn: ImageButton? = null

  // Local participant PiP (only when hasVideo).
  private var localRenderer: SurfaceViewRenderer? = null

  // Hidden during PiP entry so only the remote video tiles are shown.
  private var controlsRow: View? = null
  private var statusBar: View? = null

  // LiveKit.
  private var room: Room? = null
  private var eventsJob: Job? = null
  private var connectJob: Job? = null

  // In-call foreground service handle.
  private var ongoingSvcIntent: Intent? = null

  private val closeReceiver = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context?, intent: Intent?) {
      Log.d(TAG, "closeReceiver: finishing activity")
      finishCall(reason = "close_broadcast")
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Same lockscreen + keep-screen-on flags as CallActivity.
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
    roomName = extras.getString(EXTRA_ROOM_NAME) ?: ""
    lkUrl = extras.getString(EXTRA_LK_URL)
    lkToken = extras.getString(EXTRA_LK_TOKEN)
    hasVideo = extras.getBoolean(EXTRA_HAS_VIDEO, false)
    parseInvitedParticipants(extras.getString(EXTRA_PARTICIPANTS_JSON))

    Log.d(
      TAG,
      "onCreate: roomName=$roomName video=$hasVideo invited=${invited.size} " +
        "hasUrl=${!lkUrl.isNullOrEmpty()} hasToken=${!lkToken.isNullOrEmpty()}"
    )

    setContentView(buildRootView())

    // Pre-seed grid with placeholder tiles for each invited participant.
    // ParticipantConnected later upgrades these in-place.
    invited.forEach { p ->
      if (!tilesByIdentity.containsKey(p.email)) {
        addTile(identity = p.email, displayName = p.name)
      }
    }
    relayoutGrid()

    // Keep process alive when backgrounded mid-call.
    val svcIntent = Intent(this, CallOngoingService::class.java).apply {
      putExtra(CallOngoingService.EXTRA_CALL_ID, roomName)
      putExtra(CallOngoingService.EXTRA_CALLER_NAME, "Chamada em grupo")
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

    val url = lkUrl
    val token = lkToken
    if (!url.isNullOrEmpty() && !token.isNullOrEmpty()) {
      bringUpRoom(url, token)
    } else {
      Log.w(TAG, "missing lk_url or lk_token — skipping connect")
      statusText.text = "Sem token"
    }
  }

  private fun parseInvitedParticipants(json: String?) {
    invited.clear()
    if (json.isNullOrEmpty()) return
    try {
      val arr = JSONArray(json)
      for (i in 0 until arr.length()) {
        val o = arr.optJSONObject(i) ?: continue
        val email = o.optString("email", "").trim()
        if (email.isEmpty()) continue
        val name = o.optString("name", email)
        val avatar = if (o.has("avatarUrl") && !o.isNull("avatarUrl")) o.optString("avatarUrl") else null
        invited.add(InvitedParticipant(email = email, name = name, avatarUrl = avatar))
      }
    } catch (t: Throwable) {
      Log.w(TAG, "parseInvitedParticipants failed: ${t.message}")
    }
  }

  private fun bringUpRoom(url: String, token: String) {
    val r = LiveKit.create(applicationContext)
    room = r

    // Register the local PiP renderer up front — remote tile renderers get
    // registered inside addTile() as participants are discovered.
    localRenderer?.let { r.initVideoRenderer(it) }
    tilesByIdentity.values.forEach { tile -> r.initVideoRenderer(tile.renderer) }

    eventsJob = lifecycleScope.launch {
      r.events.collect { event ->
        when (event) {
          is RoomEvent.Connected -> {
            Log.d(TAG, "RoomEvent.Connected — room=${r.name}")
            statusText.text = "Conectado"
            // Some participants may already be in the room when we connect
            // (we joined last). Seed tiles for them.
            r.remoteParticipants.values.forEach { rp ->
              onParticipantPresent(rp)
            }
          }
          is RoomEvent.Reconnecting -> {
            statusText.text = "Reconectando…"
          }
          is RoomEvent.Reconnected -> {
            statusText.text = "Conectado"
          }
          is RoomEvent.Disconnected -> {
            Log.d(TAG, "RoomEvent.Disconnected reason=${event.reason} err=${event.error}")
            finishCall(reason = "room_disconnect")
          }
          is RoomEvent.ParticipantConnected -> {
            Log.d(TAG, "ParticipantConnected ${event.participant.identity}")
            onParticipantPresent(event.participant)
          }
          is RoomEvent.ParticipantDisconnected -> {
            val id = event.participant.identity?.value ?: ""
            Log.d(TAG, "ParticipantDisconnected $id")
            removeTile(id)
          }
          is RoomEvent.TrackSubscribed -> {
            val t = event.track
            val id = event.participant.identity?.value ?: ""
            if (t is VideoTrack) {
              Log.d(TAG, "TrackSubscribed (video) participant=$id sid=${event.publication.sid}")
              // Tile may not exist yet if event ordering put TrackSubscribed
              // before ParticipantConnected for this identity — defensive.
              val tile = tilesByIdentity[id] ?: run {
                addTile(identity = id, displayName = displayNameFor(id, event.participant))
                relayoutGrid()
                tilesByIdentity[id]
              }
              tile?.let { tt ->
                t.addRenderer(tt.renderer)
                tt.hasVideo = true
              }
            } else {
              Log.d(TAG, "TrackSubscribed (audio) participant=$id sid=${event.publication.sid}")
            }
          }
          is RoomEvent.TrackUnsubscribed -> {
            val t = event.track
            val id = event.participant.identity?.value ?: ""
            if (t is VideoTrack) {
              tilesByIdentity[id]?.let { tile ->
                try { t.removeRenderer(tile.renderer) } catch (_: Throwable) {}
                tile.hasVideo = false
              }
            }
          }
          else -> { /* no-op for skeleton */ }
        }
      }
    }

    connectJob = lifecycleScope.launch {
      try {
        r.connect(url, token)
        // Local mic always; camera only when group call is video.
        r.localParticipant.setMicrophoneEnabled(true)
        if (hasVideo) {
          r.localParticipant.setCameraEnabled(true)
        }
        Log.d(TAG, "LK group connect + publish OK")
      } catch (t: Throwable) {
        Log.e(TAG, "LK group connect failed: ${t.message}", t)
        statusText.text = "Erro de conexão"
      }
    }
  }

  /** Called from RoomEvent.Connected (seed) and ParticipantConnected. Adds
   *  a tile for the participant if we don't have one yet (placeholder
   *  invited tiles already exist for known identities). */
  private fun onParticipantPresent(p: Participant) {
    val id = p.identity?.value ?: return
    if (tilesByIdentity.containsKey(id)) return
    addTile(identity = id, displayName = displayNameFor(id, p))
    relayoutGrid()
  }

  private fun displayNameFor(identity: String, p: Participant?): String {
    val n = p?.name?.takeIf { it.isNotEmpty() }
    if (n != null) return n
    val invitedMatch = invited.firstOrNull { it.email.equals(identity, ignoreCase = true) }
    return invitedMatch?.name ?: identity
  }

  // ─── Grid + tile management ───────────────────────────────────────────────

  private fun addTile(identity: String, displayName: String) {
    val density = resources.displayMetrics.density
    fun dp(v: Int) = (v * density).toInt()

    val frame = FrameLayout(this).apply {
      setBackgroundColor(Color.parseColor("#111B21"))
    }

    val renderer = SurfaceViewRenderer(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }
    frame.addView(renderer)
    // EGL init: only safe once room is alive. If we are pre-connect
    // (placeholder tiles created in onCreate), the bringUpRoom call loops
    // existing tiles and registers them then. If we are post-connect (a
    // late ParticipantConnected) we register right here.
    room?.initVideoRenderer(renderer)

    // Placeholder avatar = colored initial circle, shown until a VideoTrack
    // lands. Keeping it as a simple TextView with the letter ensures
    // visibility even when the renderer is fully transparent.
    val avatar = TextView(this).apply {
      gravity = Gravity.CENTER
      setBackgroundColor(Color.parseColor("#1F2C34"))
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 36f)
      text = (displayName.firstOrNull()?.uppercase() ?: "?")
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }
    frame.addView(avatar)

    // Name overlay — bottom-left.
    val name = TextView(this).apply {
      text = displayName
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setBackgroundColor(Color.parseColor("#80000000"))
      setPadding(dp(8), dp(4), dp(8), dp(4))
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

    // Mic-muted badge — top-left, hidden until we wire mic-mute event.
    val mic = TextView(this).apply {
      text = "MUTED"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
      setBackgroundColor(Color.parseColor("#CCE53935"))
      setPadding(dp(6), dp(2), dp(6), dp(2))
      visibility = View.GONE
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply {
        gravity = Gravity.TOP or Gravity.START
        leftMargin = dp(8)
        topMargin = dp(8)
      }
    }
    frame.addView(mic)

    tilesByIdentity[identity] = Tile(frame, renderer, name, mic, hasVideo = false)
    grid.addView(frame)
  }

  private fun removeTile(identity: String) {
    val tile = tilesByIdentity.remove(identity) ?: return
    try { grid.removeView(tile.frame) } catch (_: Throwable) {}
    try { tile.renderer.release() } catch (_: Throwable) {}
    relayoutGrid()
  }

  /**
   * Recompute rows/columns + per-tile LayoutParams based on tile count.
   *
   *   1 → 1 col / 1 row (fullscreen)
   *   2 → 1 col / 2 rows (vertical split)
   *   3-4 → 2 col / 2 row
   *   5+ → 3 col / ceil(N/3)
   *
   * GridLayout's stretch behavior needs explicit columnSpec/rowSpec width=0
   * with weight 1f on each tile so they share the parent's pixels equally.
   * The grid itself is scrollable via an outer ScrollView only when 5+
   * tiles overflow vertical space (handled in buildRootView).
   */
  private fun relayoutGrid() {
    val n = tilesByIdentity.size
    if (n == 0) {
      grid.columnCount = 1
      grid.rowCount = 1
      return
    }
    val cols: Int
    val rows: Int
    when {
      n == 1 -> { cols = 1; rows = 1 }
      n == 2 -> { cols = 1; rows = 2 }
      n <= 4 -> { cols = 2; rows = 2 }
      else   -> { cols = 3; rows = ((n + cols - 1) / cols) }
    }
    grid.columnCount = cols
    grid.rowCount = rows

    val tiles = tilesByIdentity.values.toList()
    tiles.forEachIndexed { i, tile ->
      val row = i / cols
      val col = i % cols
      val lp = GridLayout.LayoutParams(
        GridLayout.spec(row, 1, GridLayout.FILL, 1f),
        GridLayout.spec(col, 1, GridLayout.FILL, 1f)
      ).apply {
        width = 0
        height = 0
        // Small gutter between tiles.
        val gutter = (4 * resources.displayMetrics.density).toInt()
        setMargins(gutter, gutter, gutter, gutter)
      }
      tile.frame.layoutParams = lp
    }
    grid.requestLayout()
  }

  // ─── Build view tree ──────────────────────────────────────────────────────

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

    // Grid fills the screen.
    grid = GridLayout(this).apply {
      columnCount = 1
      rowCount = 1
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    }
    root.addView(grid)

    // Local PiP renderer in top-right (only when video).
    if (hasVideo) {
      localRenderer = SurfaceViewRenderer(this).apply {
        layoutParams = FrameLayout.LayoutParams(dp(96), dp(120)).apply {
          gravity = Gravity.TOP or Gravity.END
          topMargin = dp(40)
          rightMargin = dp(16)
        }
      }
      root.addView(localRenderer)
    }

    // Status pill at top-center.
    statusText = TextView(this).apply {
      text = "Conectando…"
      setTextColor(Color.WHITE)
      setBackgroundColor(Color.parseColor("#80000000"))
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setPadding(dp(12), dp(6), dp(12), dp(6))
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply {
        gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
        topMargin = dp(40)
      }
    }
    root.addView(statusText)
    statusBar = statusText

    // Controls row pinned to the bottom: mute / cam / hangup / screen-share
    // / switch-camera. Same buttons as CallActivity plus the two extras
    // called out in the brief for stage 6.
    val controls = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
      setPadding(dp(16), dp(16), dp(16), dp(32))
      setBackgroundColor(Color.parseColor("#80000000"))
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply {
        gravity = Gravity.BOTTOM
      }
    }
    root.addView(controls)
    controlsRow = controls

    val gap = dp(16)

    muteBtn = makeCircleButton(dp(56), Color.parseColor("#1F2C34")) {
      micEnabled = !micEnabled
      muteBtn.alpha = if (micEnabled) 1f else 0.5f
      lifecycleScope.launch {
        try { room?.localParticipant?.setMicrophoneEnabled(micEnabled) }
        catch (t: Throwable) { Log.w(TAG, "setMicrophoneEnabled failed: ${t.message}") }
      }
    }
    controls.addView(muteBtn, LinearLayout.LayoutParams(dp(56), dp(56)).apply { marginEnd = gap })

    if (hasVideo) {
      val vb = makeCircleButton(dp(56), Color.parseColor("#1F2C34")) {
        camEnabled = !camEnabled
        videoBtn?.alpha = if (camEnabled) 1f else 0.5f
        lifecycleScope.launch {
          try { room?.localParticipant?.setCameraEnabled(camEnabled) }
          catch (t: Throwable) { Log.w(TAG, "setCameraEnabled failed: ${t.message}") }
        }
      }
      controls.addView(vb, LinearLayout.LayoutParams(dp(56), dp(56)).apply { marginEnd = gap })
      videoBtn = vb
    }

    val hangupBtn = makeCircleButton(dp(64), Color.parseColor("#E53935")) {
      finishCall(reason = "user_hangup")
    }
    controls.addView(hangupBtn, LinearLayout.LayoutParams(dp(64), dp(64)).apply { marginEnd = gap })

    if (hasVideo) {
      val ss = makeCircleButton(dp(56), Color.parseColor("#1F2C34")) {
        screenShareEnabled = !screenShareEnabled
        screenShareBtn?.alpha = if (screenShareEnabled) 1f else 0.5f
        // Skeleton only — actual screen-share wiring lands with
        // ReplayKit equivalent (Android MediaProjection) in a follow-up.
        // Hook here so the UI is in place for Stage 6.
        Log.d(TAG, "Screen-share toggle (skeleton): $screenShareEnabled")
      }
      controls.addView(ss, LinearLayout.LayoutParams(dp(56), dp(56)).apply { marginEnd = gap })
      screenShareBtn = ss

      val sc = makeCircleButton(dp(56), Color.parseColor("#1F2C34")) {
        // Switch camera (front/back). LiveKit 2.x exposes this off the
        // local video track; we no-op in the skeleton and just bounce
        // setCameraEnabled which forces a track-republish path.
        lifecycleScope.launch {
          try {
            room?.localParticipant?.setCameraEnabled(false)
            room?.localParticipant?.setCameraEnabled(true)
          } catch (t: Throwable) {
            Log.w(TAG, "switch camera failed: ${t.message}")
          }
        }
      }
      controls.addView(sc, LinearLayout.LayoutParams(dp(56), dp(56)))
      switchCamBtn = sc
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

  // ─── Lifecycle / teardown ─────────────────────────────────────────────────

  @OptIn(DelicateCoroutinesApi::class)
  override fun onDestroy() {
    try { unregisterReceiver(closeReceiver) } catch (_: Exception) {}
    eventsJob?.cancel()
    connectJob?.cancel()
    val r = room
    room = null
    if (r != null) {
      // Same fire-and-forget pattern as CallActivity.onDestroy — Room.disconnect
      // is a suspend fn and lifecycleScope is already torn down.
      GlobalScope.launch(Dispatchers.IO) {
        try { r.disconnect() } catch (t: Throwable) {
          Log.w(TAG, "room.disconnect() threw: ${t.message}")
        }
      }
    }
    tilesByIdentity.values.forEach { tile ->
      try { tile.renderer.release() } catch (_: Throwable) {}
    }
    tilesByIdentity.clear()
    try { localRenderer?.release() } catch (_: Throwable) {}
    super.onDestroy()
  }

  private fun finishCall(reason: String) {
    Log.d(TAG, "finishCall reason=$reason room=$roomName")
    ongoingSvcIntent?.let {
      try { stopService(it) } catch (t: Throwable) {
        Log.w(TAG, "stopService(CallOngoingService) failed: ${t.message}")
      }
    }
    ongoingSvcIntent = null
    eventsJob?.cancel()
    connectJob?.cancel()
    ExpoCallKitModule.emitCallEnded(roomName)
    finish()
  }

  override fun onBackPressed() {
    Log.d(TAG, "back press ignored — use hangup button")
  }

  // ─── PiP ───────────────────────────────────────────────────────────────────

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (!hasVideo) return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (isInPictureInPictureMode) return
    try {
      val params = PictureInPictureParams.Builder()
        .setAspectRatio(Rational(9, 16))
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
    val vis = if (isInPictureInPictureMode) View.GONE else View.VISIBLE
    controlsRow?.visibility = vis
    statusBar?.visibility = vis
    localRenderer?.visibility = vis
    Log.d(TAG, "onPictureInPictureModeChanged isInPip=$isInPictureInPictureMode")
  }
}
