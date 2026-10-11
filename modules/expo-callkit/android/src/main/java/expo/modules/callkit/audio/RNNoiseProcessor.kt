package expo.modules.callkit.audio

import android.util.Log
import io.livekit.android.audio.AudioProcessorInterface
import io.livekit.android.room.Room
import java.nio.ByteBuffer

/**
 * RNNoiseProcessor — REAL ML noise suppression for native LiveKit calls.
 *
 * [2026-10-11 noise] Rewritten. The previous version reflected into
 * `org.xiph.rnnoise.RNNoise` from a JitPack AAR that was removed on 2026-05-18
 * (401) → it was a permanent pass-through. RNNoise (Xiph/Mozilla, BSD-3,
 * v0.1.1, default model compiled in) is now vendored C shared with iOS
 * (modules/expo-callkit/ios/ChatyyNS) and built into `libchatyyns.so` by this
 * module's CMakeLists.txt.
 *
 * Hook (verified against livekit-android 2.24.1 sources + webrtc-sdk m144):
 *   room.audioProcessingController.capturePostProcessor = RNNoiseProcessor.shared()
 *   → WebRTC APM calls processAudio(numBands, numFrames, buffer) every 10 ms,
 *     AFTER WebRTC's AEC/NS/AGC. `buffer` is a DIRECT ByteBuffer over APM's
 *     channel-0 float samples (int16 scale) — denoised IN PLACE in C (JNI
 *     GetDirectBufferAddress), no copies/allocations on the audio thread.
 *   RNNoise needs 480-sample frames @ 48 kHz = exactly one 10 ms APM frame, so
 *   numFrames == 480 is processed and anything else (16/32 kHz APM rate, e.g.
 *   Bluetooth SCO) passes through untouched (WebRTC NS still active).
 *
 * Failure-safe: `System.loadLibrary` / native alloc failure → available=false
 * → every callback is a no-op (= previous behaviour). The C side never blocks
 * (try-lock), never allocates per frame, and restores the raw frame if the
 * model ever outputs NaN/Inf. Any Throwable in processAudio disables us.
 *
 * Toggle: `enabled` (process-wide, atomic in C). Persisted by callers in the
 * module SharedPreferences key `rnnoise_enabled` (default true) — see
 * ExpoCallKitModule.setNoiseSuppression / CallActivity.
 */
class RNNoiseProcessor private constructor() : AudioProcessorInterface {

  companion object {
    private const val TAG = "RNNoiseProcessor"
    /** Frame size required by RNNoise (10 ms @ 48 kHz). */
    private const val FRAME_SIZE = 480
    /** Sample rate expected by the model. */
    const val SAMPLE_RATE = 48000
    /** getName() — anything but "krisp_noise_cancellation" (that one makes
     *  LiveKit advertise TF_ENHANCED_NOISE_CANCELLATION to the SFU). */
    const val NAME = "chatyy_rnnoise"

    @Volatile
    private var instance: RNNoiseProcessor? = null

    fun shared(): RNNoiseProcessor {
      val cur = instance
      if (cur != null) return cur
      synchronized(this) {
        val again = instance
        if (again != null) return again
        val fresh = RNNoiseProcessor()
        instance = fresh
        return fresh
      }
    }

    /**
     * Attach the shared processor to a Room's capture APM (call right after
     * LiveKit.create, before the mic is published). Never throws.
     */
    fun attachTo(room: Room?) {
      if (room == null) return
      try {
        val p = shared()
        if (!p.available) {
          Log.w(TAG, "attachTo: RNNoise unavailable — WebRTC NS only")
          return
        }
        val ctl = room.audioProcessingController
        if (ctl.capturePostProcessor !== p) ctl.capturePostProcessor = p
        Log.i(TAG, "attachTo: capture post-processor installed (enabled=${p.enabled})")
      } catch (t: Throwable) {
        Log.w(TAG, "attachTo failed (pass-through): ${t.message}")
      }
    }

    @JvmStatic private external fun nativeCreate(): Long
    @JvmStatic private external fun nativeReset(handle: Long)
    @JvmStatic private external fun nativeProcess(handle: Long, buffer: ByteBuffer, numFrames: Int): Int
    @JvmStatic private external fun nativeSetEnabled(enabled: Boolean)
  }

  /** Native chatyy_ns handle; 0 == unavailable. Lives for the process (never freed,
   *  so a late audio callback can never touch freed memory). */
  @Volatile
  private var handle: Long = 0

  /** True once libchatyyns.so loaded and the RNNoise state was allocated. */
  @Volatile
  var available: Boolean = false
    private set

  /** User toggle (default true). Applied live to the native stage. */
  @Volatile
  var enabled: Boolean = true
    set(value) {
      field = value
      if (available) {
        try { nativeSetEnabled(value) } catch (_: Throwable) {}
      }
    }

  init {
    available = try {
      System.loadLibrary("chatyyns")
      handle = nativeCreate()
      handle != 0L
    } catch (t: Throwable) {
      Log.w(TAG, "libchatyyns unavailable — pass-through: ${t.message}")
      handle = 0L
      false
    }
    if (available) {
      try { nativeSetEnabled(enabled) } catch (_: Throwable) {}
      Log.i(TAG, "RNNoise ready (frame=$FRAME_SIZE @ $SAMPLE_RATE Hz)")
    }
  }

  // ─── AudioProcessorInterface (WebRTC APM thread) ────────────────────────

  /** LiveKit calls every method regardless of isEnabled(); we gate in C. */
  override fun isEnabled(): Boolean = available && enabled

  override fun getName(): String = NAME

  override fun initializeAudioProcessing(sampleRateHz: Int, numChannels: Int) {
    val h = handle
    if (h != 0L) try { nativeReset(h) } catch (_: Throwable) {}
  }

  override fun resetAudioProcessing(newRate: Int) {
    val h = handle
    if (h != 0L) try { nativeReset(h) } catch (_: Throwable) {}
  }

  override fun processAudio(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
    val h = handle
    if (h == 0L || numFrames != FRAME_SIZE) return
    try {
      nativeProcess(h, buffer, numFrames)
    } catch (t: Throwable) {
      // Never let a JNI surprise kill the capture thread — degrade forever.
      Log.w(TAG, "processAudio failed — disabling: ${t.message}")
      handle = 0L
      available = false
    }
  }
}
