package expo.modules.livenative

import android.content.Context
import android.content.Intent
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicReference

/**
 * ExpoLiveNativeModule — Stage 1 scaffold (2026-05-16).
 *
 * Bridges JS calls to the native Live host/viewer activities. Stage 1 ships
 * black placeholder activities so we can validate that the module wires up
 * end-to-end (JS call → native Activity launch → onLiveEnded event back to
 * JS). Stage 2 will wire LiveKit publish (host) and subscribe (viewer)
 * against the io.livekit:livekit-android dependency declared in build.gradle.
 *
 * Mirrors the modules/expo-callkit/ExpoCallKitModule.kt pattern:
 *   - Events("onLiveEnded", ...) declared up front
 *   - AsyncFunction("openHost"/"openViewer") starts the Activity with extras
 *   - Static `instance` AtomicReference so the activities can emit events
 *     back to JS without holding a hard module reference.
 */
class ExpoLiveNativeModule : Module() {

  companion object {
    private const val TAG = "ExpoLiveNative"

    /** Thread-safe handle so LiveHostActivity / LiveViewerActivity can post events. */
    private val instance = AtomicReference<ExpoLiveNativeModule?>(null)

    fun emitLiveEnded(roomName: String?, reason: String?) {
      val inst = instance.get() ?: return
      try {
        inst.sendEvent(
          "onLiveEnded",
          mapOf(
            "roomName" to (roomName ?: ""),
            "reason" to (reason ?: "")
          )
        )
      } catch (t: Throwable) {
        Log.w(TAG, "emitLiveEnded failed: ${t.message}")
      }
    }

    fun emitLiveError(roomName: String?, message: String) {
      val inst = instance.get() ?: return
      try {
        inst.sendEvent(
          "onLiveError",
          mapOf(
            "roomName" to (roomName ?: ""),
            "message" to message
          )
        )
      } catch (t: Throwable) {
        Log.w(TAG, "emitLiveError failed: ${t.message}")
      }
    }

    fun emitViewerJoined(roomName: String?, identity: String, name: String?) {
      val inst = instance.get() ?: return
      try {
        inst.sendEvent(
          "onViewerJoined",
          mapOf(
            "roomName" to (roomName ?: ""),
            "identity" to identity,
            "name" to (name ?: "")
          )
        )
      } catch (t: Throwable) {
        Log.w(TAG, "emitViewerJoined failed: ${t.message}")
      }
    }

    fun emitLikeReceived(roomName: String?, identity: String?, count: Int) {
      val inst = instance.get() ?: return
      try {
        inst.sendEvent(
          "onLikeReceived",
          mapOf(
            "roomName" to (roomName ?: ""),
            "identity" to (identity ?: ""),
            "count" to count
          )
        )
      } catch (t: Throwable) {
        Log.w(TAG, "emitLikeReceived failed: ${t.message}")
      }
    }
  }

  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("ExpoLiveNative")

    Events(
      "onLiveEnded",
      "onLiveError",
      "onViewerJoined",
      "onLikeReceived"
    )

    OnCreate {
      instance.set(this@ExpoLiveNativeModule)
      Log.d(TAG, "OnCreate — module registered")
    }

    OnDestroy {
      if (instance.get() === this@ExpoLiveNativeModule) {
        instance.set(null)
      }
    }

    /**
     * Open the native Live host activity. Stage 1 just starts a black
     * placeholder; Stage 2 will pass extras through to a LiveKit publisher.
     */
    AsyncFunction("openHost") {
      lkToken: String,
      lkUrl: String,
      roomName: String,
      hostEmail: String,
      title: String?,
      audience: String?
      ->
      try {
        Log.d(TAG, "openHost: room=$roomName host=$hostEmail audience=$audience")
        val intent = Intent(context, LiveHostActivity::class.java).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          putExtra(LiveHostActivity.EXTRA_LK_TOKEN, lkToken)
          putExtra(LiveHostActivity.EXTRA_LK_URL, lkUrl)
          putExtra(LiveHostActivity.EXTRA_ROOM_NAME, roomName)
          putExtra(LiveHostActivity.EXTRA_HOST_EMAIL, hostEmail)
          if (title != null) putExtra(LiveHostActivity.EXTRA_TITLE, title)
          if (audience != null) putExtra(LiveHostActivity.EXTRA_AUDIENCE, audience)
        }
        context.startActivity(intent)
      } catch (t: Throwable) {
        Log.e(TAG, "openHost failed: ${t.message}", t)
        emitLiveError(roomName, t.message ?: "openHost failed")
      }
    }

    /**
     * Open the native Live viewer activity. Stage 1 placeholder; Stage 2
     * subscribes to the host's tracks.
     */
    AsyncFunction("openViewer") {
      lkToken: String,
      lkUrl: String,
      roomName: String,
      hostName: String?,
      hostAvatarUrl: String?
      ->
      try {
        Log.d(TAG, "openViewer: room=$roomName host=$hostName")
        val intent = Intent(context, LiveViewerActivity::class.java).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          putExtra(LiveViewerActivity.EXTRA_LK_TOKEN, lkToken)
          putExtra(LiveViewerActivity.EXTRA_LK_URL, lkUrl)
          putExtra(LiveViewerActivity.EXTRA_ROOM_NAME, roomName)
          if (hostName != null) putExtra(LiveViewerActivity.EXTRA_HOST_NAME, hostName)
          if (hostAvatarUrl != null) putExtra(LiveViewerActivity.EXTRA_HOST_AVATAR_URL, hostAvatarUrl)
        }
        context.startActivity(intent)
      } catch (t: Throwable) {
        Log.e(TAG, "openViewer failed: ${t.message}", t)
        emitLiveError(roomName, t.message ?: "openViewer failed")
      }
    }

    /**
     * Best-effort close. Stage 1 just emits onLiveEnded — Stage 2 will
     * actually finish() any currently-running host/viewer activity.
     */
    AsyncFunction("closeLive") {
      Log.d(TAG, "closeLive")
      emitLiveEnded(null, "closeLive")
    }
  }
}
