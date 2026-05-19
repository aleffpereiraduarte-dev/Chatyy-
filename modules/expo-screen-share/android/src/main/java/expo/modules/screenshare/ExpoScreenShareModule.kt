package expo.modules.screenshare

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.localbroadcastmanager.content.LocalBroadcastManager
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

  // [Bridge #1 2026-05-19] LocalBroadcast receiver that catches
  // ScreenShareService.ACTION_STOPPED (fired from stopSelfClean) and turns
  // it into an `onBroadcastStopped` JS event. Without this, when the user
  // taps "Stop sharing" in the system status bar the MediaProjection
  // Callback.onStop teardown runs entirely inside the service process and
  // JS never learns the broadcast ended — UI shows "Sharing…" forever.
  private val stoppedReceiver = object : android.content.BroadcastReceiver() {
    override fun onReceive(ctx: Context?, intent: Intent?) {
      if (intent?.action != ScreenShareService.ACTION_STOPPED) return
      val reason = intent.getStringExtra(ScreenShareService.EXTRA_STOP_REASON) ?: "unknown"
      Log.d(TAG, "stoppedReceiver: reason=$reason")
      try {
        sendEvent("onBroadcastStopped", mapOf("reason" to reason))
      } catch (t: Throwable) {
        Log.w(TAG, "sendEvent onBroadcastStopped failed: ${t.message}")
      }
    }
  }

  // [2026-05-17 Stage 4 bridge] expo-callkit's startScreenshare() dispatches
  // a broadcast that we observe here. Lifecycle is tied to the module
  // instance via OnCreate/OnDestroy in the ModuleDefinition.
  private val bridgeReceiver = object : android.content.BroadcastReceiver() {
    override fun onReceive(ctx: Context?, intent: Intent?) {
      val action = intent?.action ?: return
      Log.d(TAG, "bridgeReceiver: $action")
      when (action) {
        "expo.modules.screenshare.REQUEST_PICKER" -> {
          val activity = appContext.currentActivity ?: return
          if (ScreenShareService.isRunning) return
          val mpm = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
          val pickerIntent = mpm.createScreenCaptureIntent()
          try {
            activity.startActivityForResult(pickerIntent, SCREEN_CAPTURE_REQUEST_CODE)
          } catch (t: Throwable) {
            Log.w(TAG, "bridgeReceiver picker launch failed: ${t.message}")
            sendEvent("onBroadcastError", mapOf("message" to (t.message ?: "picker launch failed")))
          }
        }
        "expo.modules.screenshare.REQUEST_STOP" -> {
          val ctxOk = appContext.reactContext ?: return
          val stopIntent = Intent(ctxOk, ScreenShareService::class.java).apply {
            this.action = ScreenShareService.ACTION_STOP
          }
          try { ContextCompat.startForegroundService(ctxOk, stopIntent) } catch (_: Throwable) {}
        }
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoScreenShare")

    Events("onBroadcastStarted", "onBroadcastFrame", "onBroadcastStopped", "onBroadcastError")

    OnCreate {
      try {
        val ctx = appContext.reactContext ?: return@OnCreate
        val filter = android.content.IntentFilter().apply {
          addAction("expo.modules.screenshare.REQUEST_PICKER")
          addAction("expo.modules.screenshare.REQUEST_STOP")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          ctx.registerReceiver(bridgeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
          @Suppress("UnspecifiedRegisterReceiverFlag")
          ctx.registerReceiver(bridgeReceiver, filter)
        }
        // [Bridge #1 2026-05-19] LocalBroadcastManager bus for in-process
        // service → module signalling. Separate from bridgeReceiver above
        // because that one rides the OS broadcast bus (cross-process); the
        // STOPPED event is purely intra-app and benefits from the LBM's
        // synchronous delivery + no manifest gymnastics.
        LocalBroadcastManager.getInstance(ctx).registerReceiver(
          stoppedReceiver,
          android.content.IntentFilter(ScreenShareService.ACTION_STOPPED)
        )
      } catch (t: Throwable) {
        Log.w(TAG, "bridgeReceiver register failed: ${t.message}")
      }
    }

    OnDestroy {
      try {
        appContext.reactContext?.unregisterReceiver(bridgeReceiver)
      } catch (_: Throwable) {}
      try {
        appContext.reactContext?.let {
          LocalBroadcastManager.getInstance(it).unregisterReceiver(stoppedReceiver)
        }
      } catch (_: Throwable) {}
    }

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
