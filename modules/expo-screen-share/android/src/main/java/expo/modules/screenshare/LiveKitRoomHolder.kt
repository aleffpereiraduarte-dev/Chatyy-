package expo.modules.screenshare

import io.livekit.android.room.Room
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicReference

/**
 * [2026-05-16 Stage 1] LiveKitRoomHolder — process-wide weak handle to the
 * active LiveKit Room owned by CallActivity (per-call) or LiveHostActivity
 * (per-live, Stage 2).
 *
 * Why a holder and not a direct lookup:
 *   - CallActivity is in module `expo-callkit`. We cannot import it from
 *     `expo-screen-share` without a circular dep (callkit already pulls in
 *     livekit; we'd have to depend on callkit which depends on us if we
 *     ever fired screenshare events back).
 *   - The Room is bound to the activity lifecycle (Day 2 wiring). Stage 2
 *     of this work needs CallActivity.onCreate to call
 *     `LiveKitRoomHolder.set(room)` after `LiveKit.create()` and
 *     `LiveKitRoomHolder.clear()` in onDestroy. That is NOT wired today —
 *     this file does not modify CallActivity (per the task constraints).
 *
 * Until Stage 2 wires CallActivity, `current()` returns null and the
 * ScreenShareService will start the FGS + acquire MediaProjection but skip
 * the actual track publish. The MediaProjection token is held alive so a
 * follow-up commit can plug it into the Room without re-prompting the user.
 *
 * Thread safety: AtomicReference for set/clear, WeakReference inside so a
 * leaked Activity GC reclaims the Room. `current()` returns the strong ref
 * snapshot — safe to use for one call site.
 */
object LiveKitRoomHolder {
  private val ref = AtomicReference<WeakReference<Room>?>(null)

  fun set(room: Room) {
    ref.set(WeakReference(room))
  }

  fun clear() {
    ref.set(null)
  }

  fun current(): Room? {
    return ref.get()?.get()
  }
}
