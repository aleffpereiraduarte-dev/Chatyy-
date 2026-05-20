package expo.modules.screenshare

import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentLinkedDeque
import java.util.concurrent.atomic.AtomicLong

/**
 * [2026-05-20 Wave 17.6 F2 follow-up] ScreenAudioMixer — process-wide ring of
 * 48kHz stereo PCM16 frames captured from MediaProjection's
 * AudioPlaybackCaptureConfiguration (started by [ScreenShareService]).
 *
 * Why a separate helper and not direct LK publish:
 *
 *   1. LiveKit Android 2.10.3 does NOT expose a public AudioCustomSource yet —
 *      the only blessed extension point is [io.livekit.android.audio.MixerAudioBufferCallback],
 *      which mixes custom PCM INTO the existing local mic track. Peer ends up
 *      hearing mic+screen merged (WhatsApp/Zoom default for screen-share too).
 *
 *   2. Cross-module ownership: capture lives in `expo-screen-share` while the
 *      Room + mic track live in `expo-callkit` (CallActivity). A circular
 *      Gradle dep is unacceptable, so we marshal samples through this static
 *      ring + CallActivity reads them at LK mixer pace via [drainInto].
 *
 *   3. Frame-rate impedance: capture pumps in ~10ms tics at 48000Hz stereo
 *      PCM16 (~960 samples * 2ch * 2B = 3840B per tic). LK's mixer callback
 *      asks for variable-size buffers (typically 10ms WebRTC frames at
 *      whatever sample rate the mic is at, usually 48kHz mono). So we keep
 *      a small bounded deque and drop oldest on overflow — a missed-frame
 *      glitch is acceptable, accumulating latency is not.
 *
 * Capacity: 50 chunks × ~4KB ≈ 200KB max, ≈ 500ms of buffered audio. If
 * the LK mixer is reading slower than capture (e.g. screen audio active but
 * peer connection paused), we trim from the head — that's by design.
 *
 * Thread-safety: ConcurrentLinkedDeque + AtomicLong counters. Single producer
 * (capture coroutine) + single consumer (LK audio thread) — no contention in
 * the steady state.
 */
object ScreenAudioMixer {
    private const val TAG = "ScreenAudioMixer"
    private const val MAX_BUFFERED_CHUNKS = 50

    // PCM16 stereo @ 48kHz — must match ScreenShareService.startScreenAudioCapture.
    const val SAMPLE_RATE_HZ = 48_000
    const val CHANNEL_COUNT = 2
    const val BITS_PER_SAMPLE = 16

    private val ring: ConcurrentLinkedDeque<ByteArray> = ConcurrentLinkedDeque()

    @Volatile private var enabled: Boolean = false
    private val pushedChunks = AtomicLong(0)
    private val droppedOverflow = AtomicLong(0)
    private val drainedBytes = AtomicLong(0)

    /** ScreenShareService toggles this when capture starts / stops. */
    fun setEnabled(on: Boolean) {
        enabled = on
        if (!on) ring.clear()
        Log.d(TAG, "enabled=$on ring=${ring.size}")
    }

    fun isEnabled(): Boolean = enabled

    /**
     * Push a chunk of 48kHz stereo PCM16 samples. Called from
     * ScreenShareService.pumpAppAudio on the IO coroutine. `len` is the
     * number of valid bytes inside `buffer`. We copy because the producer
     * reuses its array — keeping a reference would leak audio across reads.
     */
    fun push(buffer: ByteArray, len: Int) {
        if (!enabled || len <= 0) return
        val copy = ByteArray(len)
        System.arraycopy(buffer, 0, copy, 0, len)
        ring.addLast(copy)
        pushedChunks.incrementAndGet()
        // Drop-oldest on overflow — latency is more harmful than a gap.
        while (ring.size > MAX_BUFFERED_CHUNKS) {
            ring.pollFirst()
            droppedOverflow.incrementAndGet()
        }
    }

    /**
     * Drain up to `outBuf.remaining()` bytes of mixable PCM16 into `outBuf`.
     * Returns bytes actually written (0..outBuf.remaining()).
     *
     * Expected to be called from a LiveKit MixerAudioBufferCallback or a
     * CustomAudioProcessingFactory hook on CallActivity:
     *
     * ```kotlin
     * room.audioProcessingController.setLocalMixerCallback {
     *     buffer, _, _, _, bytesRead, _ ->
     *     if (!ScreenAudioMixer.isEnabled()) return@setLocalMixerCallback
     *     ScreenAudioMixer.drainInto(buffer, bytesRead)
     * }
     * ```
     *
     * The mixer expects PCM16 little-endian samples; we honor that since the
     * AudioRecord in ScreenShareService is configured the same way.
     *
     * If outBuf is smaller than the head chunk, we copy what fits and push
     * the leftover BACK to the head so the next call picks up where we left
     * off — gapless playback at the cost of a tiny extra allocation per
     * partial-drain. Worst case ≈ 1 alloc per 10ms frame at steady state.
     */
    fun drainInto(outBuf: ByteBuffer, requested: Int): Int {
        if (!enabled) return 0
        val want = minOf(requested, outBuf.remaining())
        if (want <= 0) return 0
        outBuf.order(ByteOrder.LITTLE_ENDIAN)

        var written = 0
        while (written < want) {
            val head = ring.pollFirst() ?: break
            val need = want - written
            if (head.size <= need) {
                outBuf.put(head)
                written += head.size
            } else {
                outBuf.put(head, 0, need)
                written += need
                // Push leftover back to front (gapless).
                val leftover = ByteArray(head.size - need)
                System.arraycopy(head, need, leftover, 0, leftover.size)
                ring.addFirst(leftover)
            }
        }
        drainedBytes.addAndGet(written.toLong())
        return written
    }

    /**
     * Mix into a short[] buffer (LK's older callback signature uses ShortBuffer).
     * Sums in PCM16 with hard clip — simpler than dynamic range compression,
     * still better than overflow wraparound on signed 16-bit.
     *
     * `inOut[offset..offset+len)` contains the existing mic samples; we add
     * the screen samples in-place. If we have no screen samples buffered we
     * simply return — the mic passes through unchanged.
     */
    fun mixInto(inOut: ShortArray, offset: Int, len: Int): Int {
        if (!enabled || len <= 0) return 0
        val byteLen = len * 2
        var read = 0
        // Build a temporary byte buffer by pulling from ring head.
        val tmp = ByteArray(byteLen)
        while (read < byteLen) {
            val head = ring.pollFirst() ?: break
            val need = byteLen - read
            if (head.size <= need) {
                System.arraycopy(head, 0, tmp, read, head.size)
                read += head.size
            } else {
                System.arraycopy(head, 0, tmp, read, need)
                read += need
                val leftover = ByteArray(head.size - need)
                System.arraycopy(head, need, leftover, 0, leftover.size)
                ring.addFirst(leftover)
            }
        }
        if (read == 0) return 0

        // Walk tmp as little-endian PCM16 + sum into inOut with clip.
        var i = 0
        var written = 0
        while (i + 1 < read && written < len) {
            val s = (tmp[i].toInt() and 0xFF) or (tmp[i + 1].toInt() shl 8)
            val signed = if (s >= 0x8000) s - 0x10000 else s
            val mixed = inOut[offset + written].toInt() + signed
            val clipped = when {
                mixed > Short.MAX_VALUE -> Short.MAX_VALUE.toInt()
                mixed < Short.MIN_VALUE -> Short.MIN_VALUE.toInt()
                else -> mixed
            }
            inOut[offset + written] = clipped.toShort()
            i += 2
            written++
        }
        drainedBytes.addAndGet(read.toLong())
        return written
    }

    fun stats(): String = "pushed=${pushedChunks.get()} dropped=${droppedOverflow.get()} drainedB=${drainedBytes.get()} ringSize=${ring.size}"
}
