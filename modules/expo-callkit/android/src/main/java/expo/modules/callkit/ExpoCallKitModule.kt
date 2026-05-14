package expo.modules.callkit

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicReference

class ExpoCallKitModule : Module() {

  companion object {
    private const val TAG = "ExpoCallKit"
    private const val PREFS_NAME = "expo_callkit_prefs"
    private const val KEY_PENDING_CALL = "pending_accepted_call"

    // Static reference so IncomingCallActivity and CallActionReceiver can send events (thread-safe)
    private val instance = AtomicReference<ExpoCallKitModule?>(null)

    // Foreground state — read by CallFirebaseMessagingService to suppress native UI
    // when JS is already showing the in-app incoming call modal. Without this, both
    // the native IncomingCallActivity AND the JS Modal fire simultaneously.
    @Volatile
    var isAppForeground: Boolean = false

    // Track call IDs currently in the accept flow so that the deleteIntent
    // wired into the foreground call notification (which fires
    // ACTION_DECLINE_CALL when the notification is auto-dismissed by
    // stopForeground) does NOT bubble up as a call_end to JS. Without this,
    // accepting on the native screen propagated stopRinging → service onDestroy
    // → notification dismissed → deleteIntent → emitCallEnded → JS onEnd
    // → WS call_end to caller A → A sees "call ended" while B is connecting.
    private val acceptingCallIds = java.util.concurrent.ConcurrentHashMap<String, Long>()

    fun markCallAccepting(callId: String) {
      if (callId.isEmpty()) return
      acceptingCallIds[callId] = System.currentTimeMillis()
      Log.d(TAG, "markCallAccepting: callId=$callId")
    }

    fun isCallAccepting(callId: String): Boolean {
      if (callId.isEmpty()) return false
      // Cleanup stale entries (>30s old) so we don't suppress decline forever
      val now = System.currentTimeMillis()
      val entries = acceptingCallIds.entries.iterator()
      while (entries.hasNext()) {
        val e = entries.next()
        if (now - e.value > 30_000L) entries.remove()
      }
      return acceptingCallIds.containsKey(callId)
    }

    fun emitCallAnswered(callId: String) {
      markCallAccepting(callId)
      val inst = instance.get()
      if (inst != null) {
        inst.sendEvent("onCallAnswered", mapOf("callId" to callId))
      }
      // Always log for debugging
      Log.d(TAG, "emitCallAnswered: callId=$callId, instanceReady=${inst != null}")
    }

    fun emitCallEnded(callId: String) {
      val inst = instance.get()
      if (inst != null) {
        inst.sendEvent("onCallEnded", mapOf("callId" to callId))
      }
    }

    /**
     * Save accepted call data to SharedPreferences so JS can read it on cold start.
     * Called from IncomingCallActivity and CallActionReceiver when instance is null.
     */
    fun savePendingAcceptedCall(context: Context, callId: String, callerName: String, callerEmail: String, conversationId: String, hasVideo: Boolean) {
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val data = org.json.JSONObject().apply {
        put("callId", callId)
        put("callerName", callerName)
        put("callerEmail", callerEmail)
        put("conversationId", conversationId)
        put("hasVideo", hasVideo)
        put("timestamp", System.currentTimeMillis())
      }
      prefs.edit().putString(KEY_PENDING_CALL, data.toString()).apply()
      Log.d(TAG, "Saved pending accepted call: $callId callerEmail=$callerEmail")
    }
  }

  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("ExpoCallKit")

    Events("onCallAnswered", "onCallEnded", "onVoipTokenReceived", "onIncomingCall")

    OnCreate {
      instance.set(this@ExpoCallKitModule)
    }

    OnDestroy {
      instance.compareAndSet(this@ExpoCallKitModule, null)
    }

    // Track foreground/background so the FCM service can decide whether to show
    // the native incoming call UI. When app is foreground we let the JS Modal
    // (IncomingCallListener) handle the whole flow — showing native + JS at the
    // same time confuses the user (incidente 2026-05-12).
    OnActivityEntersForeground { isAppForeground = true }
    OnActivityEntersBackground { isAppForeground = false }

    AsyncFunction("setup") {
      // Create the notification channel for calls
      CallNotificationService.createNotificationChannel(context)

      // Check and log full-screen intent permission status
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val canUseFSI = nm.canUseFullScreenIntent()
        Log.d(TAG, "Full-screen intent permission: $canUseFSI")
        if (!canUseFSI) {
          Log.w(TAG, "Full-screen intent NOT granted. Call notifications may not show full-screen UI on Android 14+.")
        }
      }
    }

    AsyncFunction("displayIncomingCall") { callId: String, callerName: String, hasVideo: Boolean, callerEmail: String?, conversationId: String? ->
      // Start the foreground ringing service (preferred) or fall back to direct notification
      val email = callerEmail ?: ""
      val convId = conversationId ?: ""
      try {
        val serviceIntent = Intent(context, CallRingingService::class.java).apply {
          putExtra("call_id", callId)
          putExtra("caller_name", callerName)
          putExtra("has_video", hasVideo)
          putExtra("caller_email", email)
          putExtra("conversation_id", convId)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(serviceIntent)
        } else {
          context.startService(serviceIntent)
        }
      } catch (e: Exception) {
        Log.e(TAG, "Failed to start ringing service, falling back", e)
        CallNotificationService.showIncomingCallNotification(
          context,
          callId,
          callerName,
          hasVideo,
          email,
          convId
        )
      }
    }

    Function("endCall") { callId: String ->
      // JS calls this both after the user accepts (to dismiss the native UI)
      // and on real hangup. Mark the call as accepting so the deleteIntent
      // bound to the foreground call notification doesn't fire decline →
      // emitCallEnded → JS onEnd → WS call_end (which closes the caller side).
      // The flag self-expires after 30s so a real later hangup still works.
      ExpoCallKitModule.markCallAccepting(callId)
      // Cancel the notification and stop the ringing service
      CallNotificationService.cancelNotification(context, callId)
      try {
        val stopIntent = Intent(context, CallRingingService::class.java)
        context.stopService(stopIntent)
      } catch (_: Exception) {}
    }

    Function("registerVoipPush") {
      // No-op on Android - uses FCM
    }

    Function("getVoipToken") {
      // No-op on Android - uses FCM token instead
      null as String?
    }

    /**
     * Check if full-screen intent permission is granted (Android 14+).
     * Returns true on Android 13 and below (always granted).
     */
    AsyncFunction("canUseFullScreenIntent") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.canUseFullScreenIntent()
      } else {
        true
      }
    }

    /**
     * Open the system settings page where the user can grant full-screen intent permission.
     * Only needed on Android 14+ when the permission is not auto-granted.
     */
    AsyncFunction("requestFullScreenIntentPermission") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (!nm.canUseFullScreenIntent()) {
          try {
            val intent = Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT).apply {
              addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            true
          } catch (e: Exception) {
            Log.e(TAG, "Could not open full-screen intent settings", e)
            false
          }
        } else {
          true // Already granted
        }
      } else {
        true // Not needed on older versions
      }
    }

    /**
     * Read and clear pending accepted call from SharedPreferences.
     * JS calls this on startup to check if a call was accepted while app was dead.
     */
    Function("consumePendingCall") {
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val json = prefs.getString(KEY_PENDING_CALL, null)
      prefs.edit().remove(KEY_PENDING_CALL).apply()

      if (json != null) {
        try {
          val data = org.json.JSONObject(json)
          val ts = data.optLong("timestamp", 0)
          // Only valid for 60 seconds
          if (System.currentTimeMillis() - ts < 60_000) {
            Log.d(TAG, "consumePendingCall: found pending call ${data.optString("callId")}")
            return@Function mapOf(
              "callId" to data.optString("callId", ""),
              "callerName" to data.optString("callerName", ""),
              "callerEmail" to data.optString("callerEmail", ""),
              "conversationId" to data.optString("conversationId", ""),
              "hasVideo" to data.optBoolean("hasVideo", false)
            )
          } else {
            Log.d(TAG, "consumePendingCall: expired (${System.currentTimeMillis() - ts}ms old)")
          }
        } catch (e: Exception) {
          Log.e(TAG, "consumePendingCall: parse error", e)
        }
      }
      null as Map<String, Any>?
    }

    Function("getDiagnostics") {
      val canUseFSI = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.canUseFullScreenIntent()
      } else {
        true
      }

      mapOf(
        "platform" to "android",
        "channelCreated" to true,
        "instanceReady" to (instance.get() != null),
        "canUseFullScreenIntent" to canUseFSI,
        "apiLevel" to Build.VERSION.SDK_INT,
        "ringingServiceActive" to (CallRingingService.currentCallId.get() != null)
      )
    }
  }
}
