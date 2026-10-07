package expo.modules.nativetoolkit

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * [2026-10-07 voice-native] WhatsApp-grade voice-note player (Android).
 *
 * Owned by ExpoNativeAudioModule (functions `voice*`, events `onVoiceStatus` /
 * `onVoiceProximity`). The JS singleton (services/voiceNotePlayer.js) decides
 * WHAT plays; this class decides HOW:
 *
 *  - MediaPlayer, local file:// / content:// AND remote http(s) — m4a/AAC (new
 *    and old notes), mp3, ogg/opus, wav.
 *  - Status every 250 ms + on each state change; JS interpolates on the UI
 *    thread between ticks (no React render per tick).
 *  - Raise-to-ear: while playing with no headset, the PROXIMITY sensor is
 *    watched and a PROXIMITY_SCREEN_OFF_WAKE_LOCK is held (the system blanks
 *    the screen at the ear). Near → AudioManager MODE_IN_COMMUNICATION +
 *    setCommunicationDevice(earpiece) (API 31+) / speakerphone off (older) and
 *    the player is re-prepared with USAGE_VOICE_COMMUNICATION at the same
 *    position (USAGE_MEDIA ignores the communication route on many OEMs).
 *    Lowering the phone pauses (WhatsApp) and restores the previous mode.
 *  - Never touches the audio mode when it is already IN_CALL/IN_COMMUNICATION
 *    and we did not set it (a call owns it — call routing lives in
 *    expo-callkit's AudioRouter, which this file does not touch).
 *
 * Threading: EVERY public method must run on the main looper (the module
 * declares `.runOnQueue(Queues.MAIN)`); MediaPlayer/sensor/focus callbacks are
 * delivered on the main looper too, so no locking is needed.
 */
class VoiceNotePlayer(
  private val context: Context,
  private val emit: (String, Map<String, Any?>) -> Unit
) : SensorEventListener {

  companion object {
    private const val TAG = "VoiceNotePlayer"
    private const val TICK_MS = 250L
  }

  private val main = Handler(Looper.getMainLooper())
  private var player: MediaPlayer? = null
  private var prepared = false
  private var uri: String? = null
  private var token = 0
  private var rate = 1f
  private var playing = false
  private var startWhenPrepared = false
  private var pendingSeekMs = 0
  private var durationMs = 0
  private var attrsDirty = false

  private var proximityWanted = false
  private var sensorRegistered = false
  private var earpiece = false
  private var weSetMode = false
  private var prevMode = AudioManager.MODE_NORMAL
  private var wakeLock: PowerManager.WakeLock? = null
  private var focusRequest: AudioFocusRequest? = null
  private var hasFocus = false

  private val audioManager: AudioManager?
    get() = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  private val ticker = object : Runnable {
    override fun run() {
      if (!playing) return
      emitStatus(null)
      main.postDelayed(this, TICK_MS)
    }
  }

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
      hasFocus = false
      if (playing) pauseInternal("focus")
    }
  }

  // ── Public API (main looper) ─────────────────────────────────────────

  fun play(newUri: String, startMs: Int, newRate: Double, newToken: Int) {
    uri = newUri
    token = newToken
    rate = newRate.toFloat().coerceIn(0.5f, 3f)
    durationMs = 0
    attrsDirty = false
    // A new note keeps the current route: if the user is already at the ear
    // (auto-advance), it continues on the earpiece.
    buildPlayer(startMs.coerceAtLeast(0), true)
  }

  fun pause() {
    pauseInternal(null)
  }

  fun resume() {
    val mp = player ?: return
    if (attrsDirty || !prepared) {
      var pos = pendingSeekMs
      if (prepared) {
        try {
          pos = mp.currentPosition
        } catch (_: Throwable) {
        }
      }
      buildPlayer(pos, true)
      return
    }
    try {
      if (durationMs > 0 && mp.currentPosition >= durationMs - 50) mp.seekTo(0)
    } catch (_: Throwable) {
    }
    startInternal(mp)
  }

  fun seek(ms: Int) {
    val mp = player ?: return
    val target = ms.coerceAtLeast(0)
    if (!prepared) {
      pendingSeekMs = target
      return
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        mp.seekTo(target.toLong(), MediaPlayer.SEEK_CLOSEST)
      } else {
        mp.seekTo(target)
      }
    } catch (t: Throwable) {
      Log.w(TAG, "seek failed: ${t.message}")
    }
    emitStatus(mapOf("seeked" to true))
  }

  fun setRate(r: Double) {
    rate = r.toFloat().coerceIn(0.5f, 3f)
    val mp = player
    if (mp != null && prepared && playing) applyRate(mp)
    emitStatus(null)
  }

  fun stop() {
    releasePlayer()
    playing = false
    main.removeCallbacks(ticker)
    if (earpiece) {
      earpiece = false
      routeEarpiece(false)
    }
    updateProximity()
    abandonFocus()
    emitStatus(mapOf("stopped" to true))
  }

  fun setProximityEnabled(on: Boolean) {
    proximityWanted = on
    updateProximity()
  }

  fun status(): Map<String, Any?> = statusBody()

  fun release() {
    proximityWanted = false
    releasePlayer()
    playing = false
    main.removeCallbacks(ticker)
    if (earpiece) {
      earpiece = false
      routeEarpiece(false)
    }
    updateProximity()
    abandonFocus()
  }

  // ── Player lifecycle ─────────────────────────────────────────────────

  private fun buildPlayer(startMs: Int, autoStart: Boolean) {
    releasePlayer()
    val src = uri ?: return
    val mp = MediaPlayer()
    player = mp
    prepared = false
    pendingSeekMs = startMs
    startWhenPrepared = autoStart
    attrsDirty = false
    try {
      val usage = if (earpiece) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA
      mp.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(usage)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
      if (src.startsWith("file://")) {
        val path = Uri.parse(src).path ?: src.removePrefix("file://")
        mp.setDataSource(path)
      } else if (src.startsWith("/")) {
        mp.setDataSource(src)
      } else {
        mp.setDataSource(context, Uri.parse(src))
      }
      mp.setOnPreparedListener { p ->
        if (player !== p) return@setOnPreparedListener
        prepared = true
        try {
          durationMs = p.duration.coerceAtLeast(0)
        } catch (_: Throwable) {
        }
        if (pendingSeekMs > 0) {
          try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
              p.seekTo(pendingSeekMs.toLong(), MediaPlayer.SEEK_CLOSEST)
            } else {
              p.seekTo(pendingSeekMs)
            }
          } catch (_: Throwable) {
          }
        }
        if (startWhenPrepared) startInternal(p) else emitStatus(null)
      }
      mp.setOnCompletionListener { p ->
        if (player !== p) return@setOnCompletionListener
        playing = false
        main.removeCallbacks(ticker)
        // Route stays (earpiece keeps earpiece) so an auto-advanced next note
        // continues at the ear; JS calls voiceStop when the chain ends.
        emitStatus(mapOf("ended" to true, "positionMs" to durationMs))
        updateProximity()
      }
      mp.setOnErrorListener { p, what, extra ->
        if (player === p) {
          playing = false
          main.removeCallbacks(ticker)
          emitStatus(mapOf("error" to "media_error_${what}_$extra"))
          updateProximity()
        }
        true
      }
      mp.prepareAsync()
    } catch (t: Throwable) {
      Log.w(TAG, "build failed: ${t.message}")
      releasePlayer()
      playing = false
      emitStatus(mapOf("error" to (t.message ?: "prepare_failed")))
      updateProximity()
    }
  }

  private fun startInternal(mp: MediaPlayer) {
    requestFocus()
    try {
      mp.start()
      applyRate(mp)
      playing = true
    } catch (t: Throwable) {
      Log.w(TAG, "start failed: ${t.message}")
      playing = false
      emitStatus(mapOf("error" to (t.message ?: "start_failed")))
      updateProximity()
      return
    }
    main.removeCallbacks(ticker)
    main.post(ticker)
    updateProximity()
  }

  private fun applyRate(mp: MediaPlayer) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    try {
      // Only after start(): on a prepared-but-idle player a non-zero speed
      // would start playback by itself.
      mp.playbackParams = mp.playbackParams.setSpeed(rate)
    } catch (t: Throwable) {
      Log.w(TAG, "rate failed: ${t.message}")
    }
  }

  private fun pauseInternal(reason: String?) {
    val mp = player
    if (mp != null && prepared) {
      try {
        if (mp.isPlaying) mp.pause()
      } catch (_: Throwable) {
      }
    }
    if (!prepared) startWhenPrepared = false
    playing = false
    main.removeCallbacks(ticker)
    if (earpiece) {
      // Back to loudspeaker: re-prepare with USAGE_MEDIA on the next resume.
      earpiece = false
      routeEarpiece(false)
      attrsDirty = true
    }
    abandonFocus()
    updateProximity()
    emitStatus(if (reason != null) mapOf("reason" to reason) else null)
  }

  private fun releasePlayer() {
    val mp = player ?: return
    player = null
    prepared = false
    try {
      mp.setOnPreparedListener(null)
      mp.setOnCompletionListener(null)
      mp.setOnErrorListener(null)
    } catch (_: Throwable) {
    }
    try {
      mp.reset()
    } catch (_: Throwable) {
    }
    try {
      mp.release()
    } catch (_: Throwable) {
    }
  }

  private fun currentPositionSafe(): Int {
    val mp = player ?: return 0
    if (!prepared) return pendingSeekMs
    var pos = 0
    try {
      pos = mp.currentPosition
    } catch (_: Throwable) {
    }
    return pos
  }

  private fun statusBody(): Map<String, Any?> = mapOf(
    "token" to token,
    "positionMs" to currentPositionSafe().toDouble(),
    "durationMs" to durationMs.toDouble(),
    "playing" to playing,
    "earpiece" to earpiece,
    "rate" to rate.toDouble()
  )

  private fun emitStatus(extra: Map<String, Any?>?) {
    val body = HashMap<String, Any?>(statusBody())
    if (extra != null) {
      for ((k, v) in extra) {
        body[k] = if (v is Int) v.toDouble() else v
      }
    }
    emit("onVoiceStatus", body)
  }

  // ── Audio focus ──────────────────────────────────────────────────────

  private fun requestFocus() {
    if (hasFocus) return
    val am = audioManager ?: return
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
          .setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_MEDIA)
              .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
              .build()
          )
          .setOnAudioFocusChangeListener(focusListener, main)
          .build()
        focusRequest = req
        hasFocus = am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
      } else {
        @Suppress("DEPRECATION")
        val r = am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        hasFocus = r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
      }
    } catch (t: Throwable) {
      Log.w(TAG, "focus request failed: ${t.message}")
    }
  }

  private fun abandonFocus() {
    val am = audioManager ?: return
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val req = focusRequest
        if (req != null) am.abandonAudioFocusRequest(req)
      } else {
        @Suppress("DEPRECATION")
        am.abandonAudioFocus(focusListener)
      }
    } catch (_: Throwable) {
    }
    focusRequest = null
    hasFocus = false
  }

  // ── Routing ──────────────────────────────────────────────────────────

  /** True when a call (not us) owns the communication mode. */
  private fun callOwnsAudio(): Boolean {
    if (weSetMode) return false
    val mode = audioManager?.mode ?: return false
    return mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION
  }

  private fun headsetConnected(): Boolean {
    val am = audioManager ?: return false
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      @Suppress("DEPRECATION")
      return am.isWiredHeadsetOn || am.isBluetoothA2dpOn || am.isBluetoothScoOn
    }
    var found = false
    try {
      for (d in am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
        val t = d.type
        if (t == AudioDeviceInfo.TYPE_WIRED_HEADSET || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
          t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
          t == AudioDeviceInfo.TYPE_USB_HEADSET
        ) {
          found = true
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && t == AudioDeviceInfo.TYPE_BLE_HEADSET) {
          found = true
        }
      }
    } catch (_: Throwable) {
    }
    return found
  }

  private fun routeEarpiece(on: Boolean) {
    val am = audioManager ?: return
    try {
      if (on) {
        if (!weSetMode) prevMode = am.mode
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        weSetMode = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          var ear: AudioDeviceInfo? = null
          for (d in am.availableCommunicationDevices) {
            if (d.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) ear = d
          }
          if (ear != null) am.setCommunicationDevice(ear)
        } else {
          @Suppress("DEPRECATION")
          am.isSpeakerphoneOn = false
        }
      } else if (weSetMode) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          am.clearCommunicationDevice()
        }
        val restore = if (prevMode == AudioManager.MODE_IN_CALL || prevMode == AudioManager.MODE_IN_COMMUNICATION) {
          AudioManager.MODE_NORMAL
        } else {
          prevMode
        }
        // Only undo our own change — if something else (a call) moved the
        // mode since, leave it alone.
        if (am.mode == AudioManager.MODE_IN_COMMUNICATION) am.mode = restore
        weSetMode = false
      }
    } catch (t: Throwable) {
      Log.w(TAG, "route failed: ${t.message}")
    }
  }

  // ── Proximity ────────────────────────────────────────────────────────

  private fun updateProximity() {
    val should = proximityWanted && player != null && (playing || earpiece) &&
      !headsetConnected() && !callOwnsAudio()
    if (should) {
      registerSensor()
      acquireWakeLock()
    } else {
      unregisterSensor()
      releaseWakeLock()
    }
  }

  private fun registerSensor() {
    if (sensorRegistered) return
    val sm = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
    val sensor = sm.getDefaultSensor(Sensor.TYPE_PROXIMITY) ?: return
    try {
      sensorRegistered = sm.registerListener(this, sensor, SensorManager.SENSOR_DELAY_NORMAL, main)
    } catch (_: Throwable) {
      sensorRegistered = false
    }
  }

  private fun unregisterSensor() {
    if (!sensorRegistered) return
    sensorRegistered = false
    val sm = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
    try {
      sm.unregisterListener(this)
    } catch (_: Throwable) {
    }
  }

  private fun acquireWakeLock() {
    var wl = wakeLock
    if (wl == null) {
      val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
      if (!pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
      try {
        wl = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "chatyy:voiceNoteProximity")
        wl.setReferenceCounted(false)
        wakeLock = wl
      } catch (_: Throwable) {
        return
      }
    }
    try {
      if (wl != null && !wl.isHeld) wl.acquire(10 * 60 * 1000L)
    } catch (_: Throwable) {
    }
  }

  private fun releaseWakeLock() {
    val wl = wakeLock ?: return
    try {
      // WAIT_FOR_NO_PROXIMITY: if the note ends while still at the ear the
      // screen stays off until the phone is lowered (no cheek-taps).
      if (wl.isHeld) wl.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY)
    } catch (_: Throwable) {
    }
  }

  override fun onSensorChanged(event: SensorEvent?) {
    val e = event ?: return
    if (e.sensor?.type != Sensor.TYPE_PROXIMITY || e.values.isEmpty()) return
    val maxRange = e.sensor.maximumRange
    val threshold = if (maxRange > 0f) minOf(maxRange, 5f) else 5f
    val near = e.values[0] < threshold
    if (near && playing && !earpiece && !headsetConnected() && !callOwnsAudio()) {
      earpiece = true
      routeEarpiece(true)
      // USAGE_MEDIA ignores the communication route on many OEMs → re-prepare
      // the same file with USAGE_VOICE_COMMUNICATION at the same position.
      buildPlayer(currentPositionSafe(), true)
      emit("onVoiceProximity", mapOf("near" to true, "earpiece" to true, "token" to token))
    } else if (!near && earpiece) {
      // WhatsApp: lowering the phone pauses.
      pauseInternal("proximity")
      emit("onVoiceProximity", mapOf("near" to false, "earpiece" to false, "token" to token))
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}
