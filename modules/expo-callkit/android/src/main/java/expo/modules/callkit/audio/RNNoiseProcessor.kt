package expo.modules.callkit.audio

import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * RNNoiseProcessor — ML noise suppression replacement for Krisp.
 *
 * Backed by the open-source RNNoise model (Xiph, BSD license — https://github.com/xiph/rnnoise).
 * On Android we use the LiveKit-built prebuilt AAR (`com.github.livekit:rnnoise-android`, Apache 2)
 * which bundles the libRNNoise.so per ABI and exposes a JNI surface with:
 *   - long  RNNoise.create()                       // alloc a session
 *   - int   RNNoise.processFrame(handle, short[] pcm)   // in-place, 480-sample frame @ 48k
 *   - void  RNNoise.destroy(handle)
 *
 * If the prebuilt JNI is missing at runtime (library swap, gradle skip, etc.) we degrade to a
 * pass-through processor so audio still flows. Toggle owns its on/off state — every 480-sample
 * frame is suppressed when enabled, untouched otherwise.
 *
 * Integration path (Android):
 *   - LiveKit Android exposes `AudioProcessorOptions` on the `LiveKitOverrides`-backed
 *     RoomOptions.audioCaptureOptions. The processor wraps a webrtc PCM frame
 *     (signed 16-bit little-endian @ 48 kHz mono) and runs RNNoise in 480-sample chunks.
 *   - The processor is registered globally once in ExpoCallKitModule.setup() so every Room
 *     instance picks it up. Per-user persistence lives in SharedPreferences (key:
 *     `rnnoise_enabled`, default true).
 *
 * Frame size: RNNoise expects exactly 480 samples per call at 48 kHz (10 ms). We buffer
 * partial frames between calls and drain in 480-chunks; remaining tail is held over to
 * the next process call.
 *
 * Thread safety: NOT thread-safe — LiveKit's audio thread is the single caller. Construct
 * on UI / module setup and pin to one Room.
 */
class RNNoiseProcessor {

  companion object {
    private const val TAG = "RNNoiseProcessor"
    /** Frame size required by RNNoise. */
    private const val FRAME_SIZE = 480
    /** Sample rate expected by the model. */
    const val SAMPLE_RATE = 48000

    /** Singleton handle so the processor survives Room recreation. */
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
  }

  /** JNI handle to the underlying RNNoise denoise_state. 0 == not allocated / unavailable. */
  @Volatile
  private var handle: Long = 0

  /** Toggle owned by JS / UI. When false, processFrame() returns immediately. */
  @Volatile
  var enabled: Boolean = true

  /** True once we successfully loaded the .so and allocated a session. */
  @Volatile
  var available: Boolean = false
    private set

  /** Carry-over buffer for partial frames smaller than FRAME_SIZE. */
  private val tail = ShortArray(FRAME_SIZE)
  private var tailLength = 0

  init {
    available = tryLoadAndCreate()
    if (!available) {
      Log.w(TAG, "RNNoise JNI unavailable — falling back to pass-through")
    } else {
      Log.i(TAG, "RNNoise session ready (handle=$handle, frameSize=$FRAME_SIZE)")
    }
  }

  /**
   * Try to load the prebuilt libRNNoise.so and allocate a session. The native class lives at
   * `org.xiph.rnnoise.RNNoise` per the LiveKit AAR; we use reflection so a missing dep
   * degrades gracefully instead of failing the whole app.
   */
  private fun tryLoadAndCreate(): Boolean {
    return try {
      val cls = Class.forName("org.xiph.rnnoise.RNNoise")
      val createMethod = cls.getMethod("create")
      val h = createMethod.invoke(null) as? Long ?: 0L
      handle = h
      h != 0L
    } catch (t: Throwable) {
      Log.w(TAG, "tryLoadAndCreate failed: ${t.message}")
      0L.also { handle = it }
      false
    }
  }

  /**
   * Process a chunk of mono 48 kHz signed-16 PCM samples in place. The chunk can be any
   * length — we buffer partial frames internally and only call into RNNoise on full
   * 480-sample chunks. Disabled / unavailable → no-op.
   */
  fun process(pcm: ShortArray, offset: Int = 0, length: Int = pcm.size) {
    if (!enabled || !available || handle == 0L) return
    var idx = offset
    val end = offset + length

    // Drain any leftover tail first so the next process call starts aligned.
    if (tailLength > 0) {
      val need = FRAME_SIZE - tailLength
      val take = minOf(need, end - idx)
      System.arraycopy(pcm, idx, tail, tailLength, take)
      tailLength += take
      idx += take
      if (tailLength == FRAME_SIZE) {
        runFrame(tail, 0)
        // Copy denoised frame back into the caller's buffer at the same position. We
        // overwrite the original samples we consumed; this preserves the in-place
        // contract LiveKit's AudioProcessor expects.
        System.arraycopy(tail, 0, pcm, idx - FRAME_SIZE, FRAME_SIZE)
        tailLength = 0
      }
    }

    // Process every full 480-sample frame.
    while (end - idx >= FRAME_SIZE) {
      runFrame(pcm, idx)
      idx += FRAME_SIZE
    }

    // Stash anything left over in `tail` for the next call.
    val rem = end - idx
    if (rem > 0) {
      System.arraycopy(pcm, idx, tail, 0, rem)
      tailLength = rem
    }
  }

  /** Reflection call into RNNoise.processFrame. The native side denoises in place. */
  private fun runFrame(buf: ShortArray, offset: Int) {
    try {
      val cls = Class.forName("org.xiph.rnnoise.RNNoise")
      val proc = cls.getMethod("processFrame", Long::class.javaPrimitiveType, ShortArray::class.java)
      // The AAR's processFrame takes the whole array starting at index 0. We
      // copy the 480-sample window into a fixed scratch to honour that contract
      // when offset != 0.
      if (offset == 0 && buf.size == FRAME_SIZE) {
        proc.invoke(null, handle, buf)
      } else {
        // Stack-allocated buffer for the frame window.
        val window = ShortArray(FRAME_SIZE)
        System.arraycopy(buf, offset, window, 0, FRAME_SIZE)
        proc.invoke(null, handle, window)
        System.arraycopy(window, 0, buf, offset, FRAME_SIZE)
      }
    } catch (t: Throwable) {
      Log.w(TAG, "runFrame failed (disabling): ${t.message}")
      available = false
    }
  }

  /**
   * Convenience entry for callers that hand us a ByteBuffer rather than a ShortArray. LiveKit's
   * AudioProcessor APIs vary across SDK rev — both shapes are common.
   */
  fun process(byteBuffer: ByteBuffer) {
    if (!enabled || !available || handle == 0L) return
    byteBuffer.order(ByteOrder.LITTLE_ENDIAN)
    val samples = byteBuffer.remaining() / 2
    val pcm = ShortArray(samples)
    byteBuffer.mark()
    for (i in 0 until samples) pcm[i] = byteBuffer.short
    process(pcm)
    byteBuffer.reset()
    for (i in 0 until samples) byteBuffer.putShort(pcm[i])
  }

  fun release() {
    val h = handle
    if (h == 0L) return
    handle = 0L
    available = false
    try {
      val cls = Class.forName("org.xiph.rnnoise.RNNoise")
      val destroy = cls.getMethod("destroy", Long::class.javaPrimitiveType)
      destroy.invoke(null, h)
    } catch (_: Throwable) {}
  }
}
