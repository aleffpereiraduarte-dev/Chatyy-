package expo.modules.callkit

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject

/**
 * [2026-10-18 call-resilience] WhatsApp-level in-call resilience helpers for
 * the native 1:1 call screen (CallActivity). Twin of ios/CallResilience.swift.
 * Self-contained (android.* + org.json only) so a bad change is contained and
 * every feature has a kill switch:
 *
 *   SharedPreferences "expo_callkit_prefs", key "call_res_flags" = JSON string
 *   written by ExpoCallKit.setCallResilienceFlags(json) (JS mirrors
 *   globalThis.__chatyy_call_res via OTA). Missing / unparsable = defaults.
 *
 *   {"enabled":true,          master switch (false = legacy behaviour)
 *    "reconnect_tone":true,   soft beep while "Reconectando…"
 *    "peer_grace_s":30,       wait for a peer that left the SFU (legacy 15)
 *    "hold_cap_s":45,         hard cap of continuous "Reconectando…" (0 = off)
 *    "end_notice":true,       "Chamada encerrada — conexão perdida"
 *    "video_autopause":true,  pause OUR camera when the uplink is very poor
 *    "vpause_after_s":12,     poor/lost this long → pause
 *    "vresume_after_s":8}     good this long → resume (x2, x4 after flaps)
 */
object CallResilience {
  private const val TAG = "CallResilience"
  const val PREFS = "expo_callkit_prefs"
  const val KEY = "call_res_flags"

  data class Flags(
    val enabled: Boolean = true,
    val reconnectTone: Boolean = true,
    val peerGraceMs: Long = 30_000L,
    val holdCapMs: Long = 45_000L,
    val endNotice: Boolean = true,
    val videoAutoPause: Boolean = true,
    val videoPauseAfterMs: Long = 12_000L,
    val videoResumeAfterMs: Long = 8_000L,
  )

  private fun clampS(v: Double, lo: Double, hi: Double): Long {
    val x = if (v.isNaN()) lo else v
    return (x.coerceIn(lo, hi) * 1000.0).toLong()
  }

  fun flags(ctx: Context?): Flags {
    val def = Flags()
    if (ctx == null) return def
    val raw = try {
      ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
    } catch (_: Throwable) { null }
    if (raw.isNullOrBlank()) return def
    return try {
      val o = JSONObject(raw)
      val enabled = o.optBoolean("enabled", def.enabled)
      if (!enabled) {
        // Master OFF = exactly the pre-2026-10-18 behaviour.
        Flags(
          enabled = false, reconnectTone = false, peerGraceMs = 15_000L, holdCapMs = 0L,
          endNotice = false, videoAutoPause = false,
        )
      } else {
        val hold = o.optDouble("hold_cap_s", def.holdCapMs / 1000.0)
        Flags(
          enabled = true,
          reconnectTone = o.optBoolean("reconnect_tone", def.reconnectTone),
          peerGraceMs = clampS(o.optDouble("peer_grace_s", def.peerGraceMs / 1000.0), 10.0, 90.0),
          holdCapMs = if (hold.isNaN() || hold <= 0.0) 0L else clampS(hold, 20.0, 120.0),
          endNotice = o.optBoolean("end_notice", def.endNotice),
          videoAutoPause = o.optBoolean("video_autopause", def.videoAutoPause),
          videoPauseAfterMs = clampS(o.optDouble("vpause_after_s", def.videoPauseAfterMs / 1000.0), 4.0, 60.0),
          videoResumeAfterMs = clampS(o.optDouble("vresume_after_s", def.videoResumeAfterMs / 1000.0), 3.0, 60.0),
        )
      }
    } catch (t: Throwable) {
      Log.w(TAG, "flags parse failed — defaults: ${t.message}")
      def
    }
  }

  /** Persist the JSON from JS. "" = back to defaults. false = not a JSON object. */
  fun save(ctx: Context, json: String): Boolean {
    val t = json.trim()
    return try {
      val p = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      if (t.isEmpty()) {
        p.edit().remove(KEY).apply()
      } else {
        JSONObject(t) // validate
        p.edit().putString(KEY, t).apply()
      }
      true
    } catch (_: Throwable) { false }
  }

  fun raw(ctx: Context): String = try {
    ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "") ?: ""
  } catch (_: Throwable) { "" }

  // ─── Strings (own table: CallStrings stays untouched)

  private val T: Map<String, Map<String, String>> = mapOf(
    "pt-BR" to mapOf("connectionLost" to "Chamada encerrada — conexão perdida", "videoPaused" to "Vídeo pausado — conexão fraca"),
    "pt-PT" to mapOf("connectionLost" to "Chamada terminada — ligação perdida", "videoPaused" to "Vídeo em pausa — ligação fraca"),
    "en" to mapOf("connectionLost" to "Call ended — connection lost", "videoPaused" to "Video paused — poor connection"),
    "es" to mapOf("connectionLost" to "Llamada finalizada — se perdió la conexión", "videoPaused" to "Video en pausa — conexión débil"),
    "fr" to mapOf("connectionLost" to "Appel terminé — connexion perdue", "videoPaused" to "Vidéo en pause — connexion faible"),
    "de" to mapOf("connectionLost" to "Anruf beendet — Verbindung verloren", "videoPaused" to "Video pausiert — schwache Verbindung"),
    "it" to mapOf("connectionLost" to "Chiamata terminata — connessione persa", "videoPaused" to "Video in pausa — connessione debole"),
    "ja" to mapOf("connectionLost" to "通話終了 — 接続が切れました", "videoPaused" to "ビデオ一時停止 — 接続が不安定です"),
    "ar" to mapOf("connectionLost" to "انتهت المكالمة — انقطع الاتصال", "videoPaused" to "تم إيقاف الفيديو مؤقتًا — اتصال ضعيف"),
    "id" to mapOf("connectionLost" to "Panggilan berakhir — koneksi terputus", "videoPaused" to "Video dijeda — koneksi lemah"),
    "hi" to mapOf("connectionLost" to "कॉल समाप्त — कनेक्शन टूट गया", "videoPaused" to "वीडियो रुका — कमज़ोर कनेक्शन"),
  )

  fun text(key: String, lang: String): String = T[lang]?.get(key) ?: T["en"]?.get(key) ?: key

  fun text(key: String): String {
    val l = try { GroupCallStrings.lang() } catch (_: Throwable) { "en" }
    return text(key, l)
  }
}

/**
 * Main thread only. Owned by CallActivity for one call. Polls
 * [isReconnecting] (the screen's own truth: LK Reconnecting, SFU rejoin or the
 * peer-gone grace) every 500 ms, so no existing code path has to call it:
 * soft tone, trail diag (call_reconnect_begin/_end/_giveup) and the hold cap.
 */
class CallReconnectGuard(
  private val flags: CallResilience.Flags,
  private val isReconnecting: () -> Boolean,
  private val mediaConnected: () -> Boolean,
  private val onGiveUp: () -> Unit,
  private val diag: (String, String) -> Unit,
) {
  private val handler = Handler(Looper.getMainLooper())
  private var running = false
  private var since = 0L
  private var episodes = 0
  private var gaveUp = false
  private var tone: ToneGenerator? = null
  private var lastBeepAt = 0L

  private val tick = object : Runnable {
    override fun run() {
      if (!running) return
      try { step() } catch (t: Throwable) { Log.w("CallReconnectGuard", "tick: ${t.message}") }
      if (running) handler.postDelayed(this, 500L)
    }
  }

  fun start() {
    if (!flags.enabled || running) return
    running = true
    handler.postDelayed(tick, 500L)
  }

  fun stop() {
    running = false
    handler.removeCallbacks(tick)
    releaseTone()
    if (since > 0L) {
      val ms = System.currentTimeMillis() - since
      since = 0L
      diag("call_reconnect_end", "ok=0 why=stopped ms=$ms n=$episodes")
    }
  }

  private fun step() {
    val rec = isReconnecting()
    val live = mediaConnected()
    val now = System.currentTimeMillis()
    if (rec && live) {
      if (since == 0L) {
        since = now
        episodes++
        gaveUp = false
        lastBeepAt = 0L
        diag("call_reconnect_begin", "n=$episodes tone=${if (flags.reconnectTone) 1 else 0} cap=${flags.holdCapMs / 1000}")
      }
      if (flags.reconnectTone && now - lastBeepAt >= 3_000L) {
        lastBeepAt = now
        beep()
      }
      if (flags.holdCapMs > 0L && !gaveUp && now - since >= flags.holdCapMs) {
        gaveUp = true
        val ms = now - since
        since = 0L
        releaseTone()
        diag("call_reconnect_giveup", "ms=$ms n=$episodes")
        onGiveUp()
      }
    } else if (since > 0L) {
      val ms = now - since
      since = 0L
      releaseTone()
      diag("call_reconnect_end", "ok=${if (rec) 0 else 1} ms=$ms n=$episodes")
    }
  }

  /** Two soft beeps on the VOICE_CALL stream (follows earpiece/speaker/BT). */
  private fun beep() {
    try {
      val tg = tone ?: ToneGenerator(AudioManager.STREAM_VOICE_CALL, 35).also { tone = it }
      tg.startTone(ToneGenerator.TONE_PROP_BEEP2, 260)
    } catch (t: Throwable) {
      Log.w("CallReconnectGuard", "beep failed: ${t.message}")
      releaseTone()
    }
  }

  private fun releaseTone() {
    val tg = tone ?: return
    tone = null
    try { tg.stopTone() } catch (_: Throwable) {}
    try { tg.release() } catch (_: Throwable) {}
  }
}

/**
 * Main thread only. Sustained poor/lost uplink while our camera is on →
 * pause it (publication mute via the caller's [pause]); sustained good →
 * [resume]. Repeated flaps double the resume wait (x2, x4).
 */
class CallVideoAutoPause(
  private val flags: CallResilience.Flags,
  /** Camera on by the USER and published. */
  private val cameraWanted: () -> Boolean,
  /** May we pause right now (1:1, LiveKit media, not reconnecting / hold / sharing). */
  private val eligible: () -> Boolean,
  private val pause: () -> Unit,
  private val resume: () -> Unit,
  private val changed: (Boolean) -> Unit,
  private val diag: (String, String) -> Unit,
) {
  private val handler = Handler(Looper.getMainLooper())
  private var running = false
  @Volatile private var score = -1
  private var badSince = 0L
  private var goodSince = 0L
  private var flaps = 0
  var paused = false
    private set

  private val tick = object : Runnable {
    override fun run() {
      if (!running) return
      try { step() } catch (t: Throwable) { Log.w("CallVideoAutoPause", "tick: ${t.message}") }
      if (running) handler.postDelayed(this, 1_000L)
    }
  }

  fun start() {
    if (!flags.videoAutoPause || running) return
    running = true
    handler.postDelayed(tick, 1_000L)
  }

  fun stop() {
    running = false
    handler.removeCallbacks(tick)
  }

  /** Local ConnectionQuality: 0 lost, 1 poor, 2 good, 3 excellent, -1 unknown. */
  fun noteLocalQuality(s: Int) { score = s }

  /** The user toggled the camera by hand: their choice wins, forget ours. */
  fun userToggledCamera() {
    badSince = 0L
    goodSince = 0L
    if (paused) {
      paused = false
      diag("video_autopause_clear", "why=user_toggle")
      changed(false)
    }
  }

  private fun step() {
    val now = System.currentTimeMillis()
    val s = score
    if (!paused) {
      goodSince = 0L
      if (!cameraWanted() || !eligible() || s < 0 || s > 1) { badSince = 0L; return }
      if (badSince == 0L) badSince = now
      if (now - badSince >= flags.videoPauseAfterMs) {
        badSince = 0L
        paused = true
        diag("video_autopause_on", "score=$s after=${flags.videoPauseAfterMs / 1000} flaps=$flaps")
        pause()
        changed(true)
      }
    } else {
      badSince = 0L
      if (!cameraWanted()) {
        paused = false
        goodSince = 0L
        diag("video_autopause_clear", "why=camera_off")
        changed(false)
        return
      }
      if (s < 2) { goodSince = 0L; return }
      if (goodSince == 0L) goodSince = now
      val wait = flags.videoResumeAfterMs * (1L shl minOf(flaps, 2))
      if (now - goodSince >= wait) {
        goodSince = 0L
        paused = false
        flaps++
        diag("video_autopause_off", "score=$s flaps=$flaps")
        resume()
        changed(false)
      }
    }
  }
}
