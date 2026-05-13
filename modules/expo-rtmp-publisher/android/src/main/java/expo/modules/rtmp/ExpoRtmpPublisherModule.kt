package expo.modules.rtmp

import android.content.Context
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// -----------------------------------------------------------------------------
// ExpoRtmpPublisherModule (SKELETON)
//
// Native RTMP/RTMPS publisher for Expo on Android. The real implementation will
// use pedroSG94's RootEncoder (https://github.com/pedroSG94/RootEncoder) —
// formerly "rtmp-rtsp-stream-client-java" — which handles Camera2, MediaCodec
// H264/AAC encoding, OpenGL filters, auth and adaptive bitrate.
//
// This file is intentionally stubbed — every native method resolves
// immediately and just flips local state. Replace the TODO bodies with
// RootEncoder calls.
//
// Reference flow once wired up:
//   1. val rtmpCamera = RtmpCamera2(context, callback)
//      // (or RtmpCamera1 if we need to support older devices)
//   2. rtmpCamera.prepareAudio(audioBitrate, sampleRate, isStereo=true)
//   3. rtmpCamera.prepareVideo(width, height, fps, videoBitrate, iFrameInterval=2, rotation)
//   4. rtmpCamera.startStream("$url/$streamKey")
//   5. rtmpCamera.switchCamera() / rtmpCamera.disableAudio() etc.
//
// Note: RootEncoder needs a SurfaceView/TextureView to attach the camera. For a
// "no preview" headless publish, use OpenGlView with `surfaceTextureManager`
// or RtmpCamera2(context, OpenGlView). For preview, host app must mount a
// view manager (out of scope for v1 skeleton).
// -----------------------------------------------------------------------------

class ExpoRtmpPublisherModule : Module() {

  private enum class Status(val raw: String) {
    IDLE("idle"),
    CONNECTING("connecting"),
    PUBLISHING("publishing"),
    RECONNECTING("reconnecting"),
    STOPPED("stopped"),
    ERROR("error"),
  }

  @Volatile private var status: Status = Status.IDLE
  @Volatile private var currentCamera: String = "back"
  @Volatile private var lastStats: Map<String, Any?>? = null

  // TODO: hold RootEncoder reference once integrated.
  // private var rtmpCamera: RtmpCamera2? = null

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context unavailable")

  override fun definition() = ModuleDefinition {
    Name("ExpoRtmpPublisher")

    Events(
      "onStatusChange",
      "onStats",
      "onError",
      "onConnected",
      "onDisconnected",
    )

    // -------------------------------------------------------------------------
    // start(opts)
    // -------------------------------------------------------------------------
    AsyncFunction("start") { opts: Map<String, Any?> ->
      val url = (opts["url"] as? String)?.takeIf { it.isNotBlank() }
        ?: throw IllegalArgumentException("url is required")
      val streamKey = (opts["streamKey"] as? String)?.takeIf { it.isNotBlank() }
        ?: throw IllegalArgumentException("streamKey is required")

      val videoBitrate = (opts["videoBitrate"] as? Number)?.toInt() ?: 2_500_000
      val audioBitrate = (opts["audioBitrate"] as? Number)?.toInt() ?: 128_000
      val width = (opts["width"] as? Number)?.toInt() ?: 1280
      val height = (opts["height"] as? Number)?.toInt() ?: 720
      val fps = (opts["fps"] as? Number)?.toInt() ?: 30
      val sampleRate = (opts["sampleRate"] as? Number)?.toInt() ?: 44100
      val camera = (opts["camera"] as? String) ?: "back"
      currentCamera = camera

      // TODO: real implementation
      //
      //   import com.pedro.rtplibrary.rtmp.RtmpCamera2
      //   import com.pedro.rtplibrary.view.OpenGlView
      //   import com.pedro.rtmp.utils.ConnectCheckerRtmp
      //
      //   val callback = object : ConnectCheckerRtmp {
      //     override fun onAuthErrorRtmp() = sendError("auth_error", "RTMP auth failed")
      //     override fun onAuthSuccessRtmp() {}
      //     override fun onConnectionFailedRtmp(reason: String) {
      //       setStatus(Status.ERROR, reason); sendError("connect_failed", reason)
      //     }
      //     override fun onConnectionStartedRtmp(url: String) = setStatus(Status.CONNECTING)
      //     override fun onConnectionSuccessRtmp() {
      //       setStatus(Status.PUBLISHING)
      //       sendEvent("onConnected", mapOf("url" to url))
      //     }
      //     override fun onDisconnectRtmp() {
      //       setStatus(Status.STOPPED)
      //       sendEvent("onDisconnected", mapOf("reason" to "remote"))
      //     }
      //     override fun onNewBitrateRtmp(bitrate: Long) {
      //       lastStats = mapOf("bitrateBps" to bitrate, "fps" to fps)
      //       sendEvent("onStats", lastStats!!)
      //     }
      //   }
      //
      //   rtmpCamera = RtmpCamera2(context, callback) // needs Activity context + Surface
      //   if (camera == "front") rtmpCamera!!.switchCamera()
      //   val prepared = rtmpCamera!!.prepareVideo(width, height, fps, videoBitrate, 2, 0)
      //         && rtmpCamera!!.prepareAudio(audioBitrate, sampleRate, true)
      //   if (!prepared) throw IllegalStateException("Failed to prepare encoders")
      //   rtmpCamera!!.startStream("$url/$streamKey")
      //
      // For now the stub just flips state.

      setStatus(Status.CONNECTING)
      setStatus(Status.PUBLISHING)
      sendEvent("onConnected", mapOf("url" to url))
      Log.i(TAG, "start() stub: url=$url key=*** ${width}x${height}@${fps} v=${videoBitrate} a=${audioBitrate}")
    }

    // -------------------------------------------------------------------------
    // stop()
    // -------------------------------------------------------------------------
    AsyncFunction("stop") {
      // TODO:
      //   rtmpCamera?.stopStream()
      //   rtmpCamera?.stopPreview()
      //   rtmpCamera = null
      setStatus(Status.STOPPED)
      sendEvent("onDisconnected", mapOf("reason" to "user_stop"))
      Log.i(TAG, "stop() stub")
    }

    // -------------------------------------------------------------------------
    // switchCamera()
    // -------------------------------------------------------------------------
    AsyncFunction("switchCamera") {
      currentCamera = if (currentCamera == "front") "back" else "front"
      // TODO: rtmpCamera?.switchCamera()
      Log.i(TAG, "switchCamera() → $currentCamera")
    }

    // -------------------------------------------------------------------------
    // setMuted(muted)
    // -------------------------------------------------------------------------
    AsyncFunction("setMuted") { muted: Boolean ->
      // TODO:
      //   if (muted) rtmpCamera?.disableAudio() else rtmpCamera?.enableAudio()
      Log.i(TAG, "setMuted($muted) stub")
    }

    // -------------------------------------------------------------------------
    // setVideoEnabled(enabled)
    // -------------------------------------------------------------------------
    AsyncFunction("setVideoEnabled") { enabled: Boolean ->
      // TODO:
      //   if (enabled) rtmpCamera?.enableVideo() else rtmpCamera?.disableVideo()
      Log.i(TAG, "setVideoEnabled($enabled) stub")
    }

    // -------------------------------------------------------------------------
    // getStatus()
    // -------------------------------------------------------------------------
    Function("getStatus") {
      status.raw
    }

    // -------------------------------------------------------------------------
    // getStats()
    // -------------------------------------------------------------------------
    Function("getStats") {
      lastStats
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private fun setStatus(next: Status, reason: String? = null) {
    status = next
    val payload = mutableMapOf<String, Any?>("status" to next.raw)
    if (reason != null) payload["reason"] = reason
    try { sendEvent("onStatusChange", payload) } catch (_: Throwable) {}
  }

  @Suppress("unused")
  private fun sendError(code: String, message: String) {
    try {
      sendEvent("onError", mapOf("code" to code, "message" to message))
    } catch (_: Throwable) {}
  }

  companion object {
    private const val TAG = "ExpoRtmpPublisher"
  }
}
