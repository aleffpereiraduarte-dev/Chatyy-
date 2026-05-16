package expo.modules.nativetoolkit

import android.content.Context
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min

/**
 * ExpoNativeAudioModule — Android port (2026-05-16).
 *
 * Mirrors the iOS Swift module's API surface so JS calls the same functions on
 * both platforms. Replaces the expo-audio fallback that was costing voice
 * recording 200-400 ms of bridge latency on Android.
 *
 * Capture: MediaRecorder (AAC 44.1 kHz mono, 96 kbps). A Dispatchers.Default
 * coroutine polls MediaRecorder.maxAmplitude every 1000/sampleHz ms and emits
 * `onLevel` events. The latest amplitude is also kept in a volatile field so
 * `currentLevelSync` matches the iOS contract.
 *
 * Playback: MediaPlayer pool keyed by an Int handle; `onComplete` events carry
 * the handle id so JS can correlate.
 *
 * Lifecycle:
 *   - OnCreate seeds the module instance pointer
 *   - OnDestroy releases any active recorder/player so the activity teardown
 *     (rotation, app-bg kill) doesn't leak the mic.
 *
 * Known caveat: MediaRecorder.maxAmplitude returns 0 on the very first read on
 * some OEMs (Samsung One UI, Huawei EMUI) — the first 30-50 ms of waveform may
 * be flat. We emit those zeros anyway so the JS waveform sampler stays at a
 * fixed cadence; the visual gap is < 1 frame.
 */
class ExpoNativeAudioModule : Module() {

  companion object {
    private const val TAG = "ExpoNativeAudio"
    private const val DEFAULT_SAMPLE_HZ = 30
    private const val MAX_SHORT = 32767.0
  }

  // ── Recorder state ──────────────────────────────────────────────────
  private var recorder: MediaRecorder? = null
  private var recordFile: File? = null
  private var recordStartedAtMs: Long = 0L
  private var recordPausedAccumMs: Long = 0L
  private var recordPausedAtMs: Long = 0L
  private var isPaused: Boolean = false

  @Volatile private var latestAmplitude: Int = 0
  @Volatile private var latestLevel: Float = 0f
  private val samples: MutableList<Float> = mutableListOf()

  private val recordScope = CoroutineScope(Dispatchers.Default)
  private var pollJob: Job? = null
  // Monotonic session id — coroutine cancels itself if a newer session started
  // before it scheduled (covers stop+start back-to-back races).
  private val sessionCounter = AtomicInteger(0)
  private val stateLock = Any()

  // ── Player state ────────────────────────────────────────────────────
  private val players = ConcurrentHashMap<Int, MediaPlayer>()
  private val playerCounter = AtomicInteger(0)

  private val ctx: Context get() = appContext.reactContext!!

  override fun definition() = ModuleDefinition {
    Name("ExpoNativeAudio")

    // Events surfaced to JS. iOS doesn't ship these (uses sync polling) but
    // emitting them on Android removes the JS-side setInterval reading
    // currentLevelSync — saves one bridge hop per sample.
    Events("onLevel", "onComplete", "onError")

    OnCreate {
      Log.d(TAG, "OnCreate")
    }

    OnDestroy {
      // Activity is going away — clean up so the mic / file handles don't leak.
      releaseAll()
    }

    // ── Recording ─────────────────────────────────────────────────────

    AsyncFunction("startRecording") { filePath: String?, sampleHz: Int? ->
      synchronized(stateLock) {
        if (recorder != null) {
          throw IllegalStateException("Already recording")
        }
      }
      val hz = (sampleHz ?: DEFAULT_SAMPLE_HZ).coerceIn(5, 120)
      val pollIntervalMs = (1000L / hz).coerceAtLeast(1L)

      val outFile = if (!filePath.isNullOrBlank()) {
        File(filePath.removePrefix("file://"))
      } else {
        File(ctx.cacheDir, "voice_${UUID.randomUUID()}.m4a")
      }
      outFile.parentFile?.mkdirs()

      val rec = buildRecorder(outFile)
      try {
        rec.prepare()
        rec.start()
      } catch (t: Throwable) {
        try { rec.release() } catch (_: Throwable) {}
        try { outFile.delete() } catch (_: Throwable) {}
        sendEventSafe("onError", mapOf("message" to (t.message ?: "start_failed")))
        throw t
      }

      val mySession = sessionCounter.incrementAndGet()
      synchronized(stateLock) {
        recorder = rec
        recordFile = outFile
        recordStartedAtMs = System.currentTimeMillis()
        recordPausedAccumMs = 0L
        recordPausedAtMs = 0L
        isPaused = false
        latestAmplitude = 0
        latestLevel = 0f
        samples.clear()
      }

      // 30 Hz amplitude poll loop. Reads MediaRecorder.maxAmplitude (which
      // resets after each call — that's the desired peak-since-last-poll
      // behavior). Converts to dB via 20*log10(amp/32767) so the JS layer
      // gets the same float[0..1] envelope the iOS path produces.
      pollJob?.cancel()
      pollJob = recordScope.launch {
        while (isActive) {
          val current = synchronized(stateLock) {
            if (sessionCounter.get() != mySession || recorder == null) {
              return@launch
            }
            if (isPaused) null else recorder
          }
          if (current == null) {
            delay(pollIntervalMs)
            continue
          }
          val amp = try { current.maxAmplitude } catch (_: Throwable) { 0 }
          latestAmplitude = amp
          // dB normalization matches iOS: -50 dB → 0, 0 dB → 1.
          val db = if (amp > 0) 20.0 * log10(amp / MAX_SHORT) else -160.0
          val normalized = max(0.0, min(1.0, (db + 50.0) / 50.0)).toFloat()
          latestLevel = normalized
          synchronized(stateLock) {
            if (sessionCounter.get() == mySession) samples.add(normalized)
          }
          sendEventSafe(
            "onLevel",
            mapOf(
              "level" to normalized.toDouble(),
              "amplitude" to amp,
              "db" to db
            )
          )
          delay(pollIntervalMs)
        }
      }

      "file://${outFile.absolutePath}"
    }

    AsyncFunction("stopRecording") {
      runBlocking {
        withContext(Dispatchers.Default) { stopRecordingInternal(deleteFile = false) }
      }
    }

    AsyncFunction("cancelRecording") {
      runBlocking {
        withContext(Dispatchers.Default) { stopRecordingInternal(deleteFile = true) }
      }
      Unit
    }

    AsyncFunction("pauseRecording") {
      synchronized(stateLock) {
        val r = recorder ?: throw IllegalStateException("Not recording")
        if (!isPaused) {
          if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            throw UnsupportedOperationException("pause requires Android 7+")
          }
          try { r.pause() } catch (t: Throwable) {
            throw IllegalStateException("pause failed: ${t.message}")
          }
          isPaused = true
          recordPausedAtMs = System.currentTimeMillis()
        }
      }
    }

    AsyncFunction("resumeRecording") {
      synchronized(stateLock) {
        val r = recorder ?: throw IllegalStateException("Not recording")
        if (isPaused) {
          if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            throw UnsupportedOperationException("resume requires Android 7+")
          }
          try { r.resume() } catch (t: Throwable) {
            throw IllegalStateException("resume failed: ${t.message}")
          }
          // Accumulate paused time so durationMs subtracts it on stop.
          if (recordPausedAtMs > 0L) {
            recordPausedAccumMs += System.currentTimeMillis() - recordPausedAtMs
            recordPausedAtMs = 0L
          }
          isPaused = false
        }
      }
    }

    Function("getAmplitude") {
      // Synchronous instant read for pre-poll waveform fill-ins (matches iOS
      // currentLevelSync semantics but returns the raw amplitude too).
      latestAmplitude
    }

    Function("currentLevelSync") {
      latestLevel.toDouble()
    }

    Function("currentDurationMsSync") {
      synchronized(stateLock) {
        if (recorder == null) 0
        else {
          val pausedNow = if (isPaused && recordPausedAtMs > 0L)
            System.currentTimeMillis() - recordPausedAtMs else 0L
          (System.currentTimeMillis() - recordStartedAtMs - recordPausedAccumMs - pausedNow).toInt()
        }
      }
    }

    // ── Playback ──────────────────────────────────────────────────────

    AsyncFunction("playAudio") { uri: String ->
      val cleaned = uri.removePrefix("file://")
      val player = MediaPlayer()
      val id = playerCounter.incrementAndGet()
      try {
        if (cleaned.startsWith("http://") || cleaned.startsWith("https://") || cleaned.startsWith("content://")) {
          player.setDataSource(ctx, Uri.parse(cleaned))
        } else {
          player.setDataSource(cleaned)
        }
        player.setOnCompletionListener {
          players.remove(id)?.let { p -> try { p.release() } catch (_: Throwable) {} }
          sendEventSafe("onComplete", mapOf("id" to id))
        }
        player.setOnErrorListener { _, what, extra ->
          players.remove(id)?.let { p -> try { p.release() } catch (_: Throwable) {} }
          sendEventSafe("onError", mapOf("id" to id, "what" to what, "extra" to extra))
          true
        }
        player.prepare()
        player.start()
        players[id] = player
      } catch (t: Throwable) {
        try { player.release() } catch (_: Throwable) {}
        sendEventSafe("onError", mapOf("id" to id, "message" to (t.message ?: "play_failed")))
        throw t
      }
      id
    }

    // Alias matching the iOS naming — same impl, but takes a "fileUrl" arg
    // shape (so the existing playFile JS callsite works unchanged on Android).
    AsyncFunction("playFile") { fileUrl: String ->
      val cleaned = fileUrl.removePrefix("file://")
      // Replace any currently-playing handle so playback semantics match iOS
      // (which has a single AVAudioPlayer and stops it on each playFile).
      stopAllPlayers()
      val player = MediaPlayer()
      val id = playerCounter.incrementAndGet()
      try {
        player.setDataSource(cleaned)
        player.setOnCompletionListener {
          players.remove(id)?.let { p -> try { p.release() } catch (_: Throwable) {} }
          sendEventSafe("onComplete", mapOf("id" to id))
        }
        player.prepare()
        player.start()
        players[id] = player
      } catch (t: Throwable) {
        try { player.release() } catch (_: Throwable) {}
        throw t
      }
    }

    AsyncFunction("stopAudio") { id: Int ->
      players.remove(id)?.let { p ->
        try { p.stop() } catch (_: Throwable) {}
        try { p.release() } catch (_: Throwable) {}
      }
    }

    AsyncFunction("pausePlayback") {
      players.values.forEach { p -> try { if (p.isPlaying) p.pause() } catch (_: Throwable) {} }
    }

    AsyncFunction("stopPlayback") {
      stopAllPlayers()
    }

    AsyncFunction("setPlaybackRate") { rate: Double ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        players.values.forEach { p ->
          try {
            val params = p.playbackParams
            params.speed = rate.toFloat()
            p.playbackParams = params
          } catch (_: Throwable) {}
        }
      }
    }

    Function("isPlayingSync") {
      players.values.any { try { it.isPlaying } catch (_: Throwable) { false } }
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private fun buildRecorder(outFile: File): MediaRecorder {
    // MediaRecorder API was split in 31; the deprecated parameterless ctor is
    // still fine on older devices, but on 31+ we hand it a Context for the
    // session-attribution work the framework now does.
    val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      MediaRecorder(ctx)
    } else {
      @Suppress("DEPRECATION")
      MediaRecorder()
    }
    rec.setAudioSource(MediaRecorder.AudioSource.MIC)
    rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
    rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
    rec.setAudioSamplingRate(44100)
    rec.setAudioChannels(1)
    rec.setAudioEncodingBitRate(96_000)
    rec.setOutputFile(outFile.absolutePath)
    return rec
  }

  private fun stopRecordingInternal(deleteFile: Boolean): Map<String, Any?> {
    val rec: MediaRecorder?
    val outFile: File?
    val durationMs: Int
    val snapshotSamples: List<Float>

    synchronized(stateLock) {
      // Invalidate the poll loop immediately so it stops touching the recorder.
      sessionCounter.incrementAndGet()
      rec = recorder
      outFile = recordFile
      val pausedNow = if (isPaused && recordPausedAtMs > 0L)
        System.currentTimeMillis() - recordPausedAtMs else 0L
      durationMs = if (recordStartedAtMs == 0L) 0
      else (System.currentTimeMillis() - recordStartedAtMs - recordPausedAccumMs - pausedNow).toInt()
      snapshotSamples = samples.toList()
      recorder = null
      recordFile = null
      recordStartedAtMs = 0L
      recordPausedAccumMs = 0L
      recordPausedAtMs = 0L
      isPaused = false
      samples.clear()
      latestAmplitude = 0
      latestLevel = 0f
    }

    pollJob?.cancel()
    pollJob = null

    try { rec?.stop() } catch (_: Throwable) {
      // stop() throws if no audio data was captured (record button mashed).
      // Swallowing is consistent with the iOS path which silences the symmetric
      // AVAudioRecorder failure.
    }
    try { rec?.release() } catch (_: Throwable) {}

    var sizeBytes = 0L
    val pathOut: String
    if (deleteFile) {
      try { outFile?.delete() } catch (_: Throwable) {}
      pathOut = ""
    } else {
      pathOut = outFile?.let { "file://${it.absolutePath}" } ?: ""
      sizeBytes = outFile?.length() ?: 0L
    }

    return mapOf(
      "path" to pathOut,
      "uri" to pathOut,
      "durationMs" to durationMs,
      "sizeBytes" to sizeBytes,
      "samples" to snapshotSamples.map { it.toDouble() }
    )
  }

  private fun stopAllPlayers() {
    val snapshot = players.values.toList()
    players.clear()
    for (p in snapshot) {
      try { if (p.isPlaying) p.stop() } catch (_: Throwable) {}
      try { p.release() } catch (_: Throwable) {}
    }
  }

  private fun releaseAll() {
    pollJob?.cancel()
    pollJob = null
    try { recorder?.stop() } catch (_: Throwable) {}
    try { recorder?.release() } catch (_: Throwable) {}
    recorder = null
    recordFile = null
    stopAllPlayers()
  }

  private fun sendEventSafe(name: String, payload: Map<String, Any?>) {
    try { sendEvent(name, payload) } catch (t: Throwable) {
      // sendEvent throws if the bridge is already torn down; ignore.
      Log.v(TAG, "sendEvent($name) suppressed: ${t.message}")
    }
  }
}
