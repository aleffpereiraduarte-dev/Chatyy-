package expo.modules.livenative

import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import io.livekit.android.room.track.VideoTrack
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer

/**
 * AndroidView wrapper that hosts a WebRTC [SurfaceViewRenderer] inside Compose
 * and pins it to a single [VideoTrack]. We re-add/remove the renderer as a
 * sink when the underlying track changes.
 *
 * The scaffold uses LiveKit's bundled WebRTC; the SurfaceViewRenderer comes
 * from `org.webrtc` shipped inside the livekit-android AAR. We rely on the
 * fact that LiveKit publishes a singleton EglBase context internally and that
 * its tracks already call `addRenderer(...)` to attach sinks — so we don't
 * need to manually call `init(eglBase, ...)`. If the LiveKit SDK ever stops
 * doing that auto-init we will need to fetch the context via
 * `LiveKit.getDefaultsManager().eglBase` or similar.
 */
@Composable
fun LiveVideoTrackView(
    track: VideoTrack,
    mirror: Boolean,
    modifier: Modifier = Modifier
) {
    val tag = "LiveVideoTrackView"

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            SurfaceViewRenderer(ctx).apply {
                try {
                    // EglBase from LiveKit's singleton — see KDoc on this file
                    // for the fallback path if this stops working.
                    setEnableHardwareScaler(true)
                    setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
                    setMirror(mirror)
                    // init() will be called lazily by LiveKit on first frame.
                } catch (t: Throwable) {
                    Log.w(tag, "factory init failed", t)
                }
            }
        },
        update = { renderer ->
            try {
                renderer.setMirror(mirror)
                // Attach this renderer to the track. LiveKit dedups internally.
                track.addRenderer(renderer)
            } catch (t: Throwable) {
                Log.w(tag, "update attach failed", t)
            }
        },
        onRelease = { renderer ->
            try {
                track.removeRenderer(renderer)
                renderer.release()
            } catch (t: Throwable) {
                Log.w(tag, "release failed", t)
            }
        }
    )
}
