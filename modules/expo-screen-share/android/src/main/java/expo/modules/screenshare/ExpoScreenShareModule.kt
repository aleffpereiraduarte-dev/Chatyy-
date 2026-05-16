package expo.modules.screenshare

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-05-16 Android screenshare] Native bridge to MediaProjection +
 * ScreenShareService. The JS layer (modules/expo-screen-share/index.ts) does
 * not differentiate iOS/Android API surface — it calls
 * presentBroadcastPicker / isBroadcasting / requestStopBroadcast on both
 * platforms. Android implementation maps as follows:
 *
 *   presentBroadcastPicker  → launch MediaProjectionManager system dialog,
 *                             on OK start ScreenShareService.
 *   isBroadcasting          → ScreenShareService.isRunning
 *   requestStopBroadcast    → stop ScreenShareService (which kills the
 *                             MediaProjection token and unpublishes the LK
 *                             screenshare track in Stage 2).
 *   startReceivingFrames    → no-op (Android pumps frames inside the SDK,
 *                             not via App Group file drop like iOS).
 *   stopReceivingFrames     → no-op.
 *
 * The dialog itself is launched via the host Activity's startActivityForResult
 * and the result is intercepted by `OnActivityResult` in the ModuleDefinition.
 * We use a fixed request code (SCREEN_CAPTURE_REQUEST_CODE) and resolve the
 * pending Promise from the same module instance.
 */
class ExpoScreenShareModule : Module() {

  companion object {
    private const val TAG = "ExpoScreenShareModule"
    // Arbitrary; high range to avoid colliding with other Expo modules that
    // also use startActivityForResult. Picker results are dispatched to ALL
    // OnActivityResult listeners — we filter by this code.
    private const val SCREEN_CAPTURE_REQUEST_CODE = 0x53435253 // "SCRS"
  }

  private var pendingPromise: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("ExpoScreenShare")

    Events("onBroadcastStarted", "onBroadcastFrame", "onBroadcastStopped", "onBroadcastError")

    Function("isSupported") {
      // MediaProjectionManager.createScreenCaptureIntent is API 21+. minSdk=24
      // so this is structurally always true — kept for parity with the iOS
      // gate (which checks ReplayKit availability).
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP
    }

    Function("isBroadcasting") {
      ScreenShareService.isRunning
    }

    Function("startReceivingFrames") { /* no-op on Android */ }
    Function("stopReceivingFrames") { /* no-op on Android */ }

    AsyncFunction("presentBroadcastPicker") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject(
          CodedException(
            "ERR_NO_ACTIVITY",
            "No current Activity — cannot launch MediaProjection dialog",
            null
          )
        )
        return@AsyncFunction
      }

      // Refuse a second concurrent request — the user can only hold one
      // pending MediaProjection consent at a time and reusing a fresh token
      // is the only correct path (revoked tokens cannot be replayed).
      if (pendingPromise != null) {
        promise.reject(
          CodedException(
            "ERR_BUSY",
            "Another screenshare request is already in flight",
            null
          )
        )
        return@AsyncFunction
      }

      if (ScreenShareService.isRunning) {
        // Already broadcasting — resolve immediately, JS layer treats this as
        // success (idempotent start).
        promise.resolve(null)
        return@AsyncFunction
      }

      val mpm = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      val intent = mpm.createScreenCaptureIntent()
      pendingPromise = promise
      try {
        activity.startActivityForResult(intent, SCREEN_CAPTURE_REQUEST_CODE)
      } catch (t: Throwable) {
        pendingPromise = null
        Log.e(TAG, "startActivityForResult failed: ${t.message}", t)
        promise.reject(
          CodedException("ERR_LAUNCH_FAILED", t.message ?: "Failed to launch picker", t)
        )
      }
    }

    AsyncFunction("requestStopBroadcast") { promise: Promise ->
      val ctx = appContext.reactContext
      if (ctx == null) {
        promise.resolve(null)
        return@AsyncFunction
      }
      val intent = Intent(ctx, ScreenShareService::class.java).apply {
        action = ScreenShareService.ACTION_STOP
      }
      try {
        // Send through startService so the FGS handles it inside its existing
        // process — stopService alone skips the cleanup branch we run in
        // onStartCommand(ACTION_STOP) (which unregisters callbacks, etc.).
        ContextCompat.startForegroundService(ctx, intent)
      } catch (t: Throwable) {
        Log.w(TAG, "requestStopBroadcast send failed: ${t.message}")
        // Fallback: blunt stop. Service onDestroy still cleans up resources.
        try { ctx.stopService(Intent(ctx, ScreenShareService::class.java)) } catch (_: Throwable) {}
      }
      promise.resolve(null)
    }

    OnActivityResult { _: Activity, payload ->
      if (payload.requestCode != SCREEN_CAPTURE_REQUEST_CODE) return@OnActivityResult
      val promise = pendingPromise
      pendingPromise = null
      val ctx = appContext.reactContext
      if (ctx == null) {
        promise?.reject(CodedException("ERR_NO_CONTEXT", "ReactContext gone", null))
        return@OnActivityResult
      }

      if (payload.resultCode != Activity.RESULT_OK || payload.data == null) {
        Log.d(TAG, "MediaProjection denied or cancelled (code=${payload.resultCode})")
        promise?.reject(
          CodedException("ERR_DENIED", "User denied screen capture", null)
        )
        sendEvent("onBroadcastStopped", mapOf("reason" to "user_cancelled"))
        return@OnActivityResult
      }

      Log.d(TAG, "MediaProjection granted — starting ScreenShareService")
      val svcIntent = Intent(ctx, ScreenShareService::class.java).apply {
        putExtra(ScreenShareService.EXTRA_RESULT_CODE, payload.resultCode)
        putExtra(ScreenShareService.EXTRA_RESULT_DATA, payload.data)
      }
      try {
        ContextCompat.startForegroundService(ctx, svcIntent)
      } catch (t: Throwable) {
        Log.e(TAG, "startForegroundService failed: ${t.message}", t)
        promise?.reject(
          CodedException("ERR_FGS_START_FAILED", t.message ?: "FGS start failed", t)
        )
        sendEvent("onBroadcastError", mapOf("message" to (t.message ?: "FGS start failed")))
        return@OnActivityResult
      }

      sendEvent("onBroadcastStarted", mapOf("extensionBundleId" to "android.mediaprojection"))
      promise?.resolve(null)
    }
  }
}
