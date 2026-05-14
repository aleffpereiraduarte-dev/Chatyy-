package expo.modules.screenshare

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android stub. The Android screen-share path uses MediaProjection +
 * a foreground service, which is a different architecture (no separate
 * extension process). It will land in a follow-up session — until then
 * this stub exists so the autolink doesn't fail and JS can call
 * isSupported() to gate the UI.
 *
 * When implemented:
 *   - presentBroadcastPicker -> startActivityForResult MediaProjectionManager
 *   - frames -> VirtualDisplay rendered to a SurfaceTexture and fed into a
 *     custom VideoCapturer for the WebRTC PeerConnection
 *   - foreground service required since Android 14 for media projection
 */
class ExpoScreenShareModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("ExpoScreenShare")

        Events("onBroadcastStarted", "onBroadcastFrame", "onBroadcastStopped", "onBroadcastError")

        AsyncFunction("presentBroadcastPicker") {
            throw Exception("Android screen share not yet implemented — pending MediaProjection foreground service")
        }

        Function("isBroadcasting") { false }
        Function("startReceivingFrames") { /* no-op */ }
        Function("stopReceivingFrames") { /* no-op */ }
        Function("requestStopBroadcast") { /* no-op */ }
    }
}
