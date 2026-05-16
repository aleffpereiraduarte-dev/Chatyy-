package expo.modules.livenative

import android.content.Context
import android.content.Intent
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicReference

/**
 * JS bridge for the native Live broadcast Activities. Exposes three async
 * functions — [openHost], [openViewer], [closeLive] — and forwards four
 * events back to JS:
 *   - onLiveEnded
 *   - onLiveError
 *   - onViewerJoined
 *   - onLikeReceived
 *
 * Wired up so the JS `services/liveNative.js` thin wrapper can call these
 * without caring about platform specifics. iOS implementation lands later
 * (see expo-module.config.json — iOS module name is reserved).
 */
class ExpoLiveNativeModule : Module() {

    companion object {
        private const val TAG = "ExpoLiveNative"
        private val instance = AtomicReference<ExpoLiveNativeModule?>(null)
    }

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
            // Hook LiveRoomConnection callbacks → JS events.
            LiveRoomConnection.onEnded = {
                try {
                    instance.get()?.sendEvent("onLiveEnded", mapOf<String, Any?>())
                } catch (t: Throwable) {
                    Log.w(TAG, "emit onLiveEnded failed", t)
                }
            }
            LiveRoomConnection.onError = { msg ->
                try {
                    instance.get()?.sendEvent("onLiveError", mapOf("message" to msg))
                } catch (t: Throwable) {
                    Log.w(TAG, "emit onLiveError failed", t)
                }
            }
            LiveRoomConnection.onViewerJoined = { identity ->
                try {
                    instance.get()?.sendEvent(
                        "onViewerJoined",
                        mapOf("identity" to identity)
                    )
                } catch (t: Throwable) {
                    Log.w(TAG, "emit onViewerJoined failed", t)
                }
            }
            LiveRoomConnection.onLikeReceived = { from ->
                try {
                    instance.get()?.sendEvent(
                        "onLikeReceived",
                        mapOf("from" to from)
                    )
                } catch (t: Throwable) {
                    Log.w(TAG, "emit onLikeReceived failed", t)
                }
            }
        }

        OnDestroy {
            instance.compareAndSet(this@ExpoLiveNativeModule, null)
            // Don't null out LiveRoomConnection.onXxx here — JVM teardown will
            // GC them. If the module is recreated, OnCreate reassigns.
        }

        AsyncFunction("openHost") { token: String, url: String, roomName: String, hostName: String? ->
            val ctx = appContext.reactContext ?: throw IllegalStateException("No app context")
            val intent = Intent(ctx, LiveHostActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                putExtra(LiveHostActivity.EXTRA_TOKEN, token)
                putExtra(LiveHostActivity.EXTRA_URL, url)
                putExtra(LiveHostActivity.EXTRA_ROOM_NAME, roomName)
                putExtra(LiveHostActivity.EXTRA_HOST_NAME, hostName.orEmpty())
            }
            ctx.startActivity(intent)
        }

        AsyncFunction("openViewer") { token: String, url: String, roomName: String, viewerCount: Int, hostName: String?, hostAvatarUrl: String? ->
            val ctx = appContext.reactContext ?: throw IllegalStateException("No app context")
            val intent = Intent(ctx, LiveViewerActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                putExtra(LiveViewerActivity.EXTRA_TOKEN, token)
                putExtra(LiveViewerActivity.EXTRA_URL, url)
                putExtra(LiveViewerActivity.EXTRA_ROOM_NAME, roomName)
                putExtra(LiveViewerActivity.EXTRA_HOST_NAME, hostName.orEmpty())
                putExtra(LiveViewerActivity.EXTRA_HOST_AVATAR, hostAvatarUrl.orEmpty())
                putExtra(LiveViewerActivity.EXTRA_VIEWER_COUNT, viewerCount)
            }
            ctx.startActivity(intent)
        }

        Function("closeLive") {
            // Tears down the room; the Activity's onDestroy is the canonical
            // shutdown but JS may want a forced close for tab-switch /
            // navigation away. We disconnect the room which will fire
            // RoomEvent.Disconnected → onEnded → JS onLiveEnded.
            LiveRoomConnection.disconnect()
        }

        Function("getMode") {
            return@Function when (LiveRoomConnection.currentMode()) {
                LiveRoomConnection.Mode.HOST -> "host"
                LiveRoomConnection.Mode.VIEWER -> "viewer"
                LiveRoomConnection.Mode.NONE -> "none"
            }
        }
    }
}
