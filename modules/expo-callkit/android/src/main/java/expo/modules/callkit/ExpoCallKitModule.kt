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

    // [2026-05-15 #977 cold-start phantom decline]
    // The in-memory `acceptingCallIds` HashMap doesn't survive a process
    // kill. FCM cold-start scenarios can recycle the JVM mid-accept (e.g.,
    // Android tears down the FCM-spawned process once the service stops),
    // leaving the new process with an empty map → any phantom decline that
    // fires AFTER cold-start (notification cleared by system, retry intent
    // delivered, etc.) gets through the guard and emits onCallEnded → JS
    // ships WS call_end → caller hangs up. Persist the accept timestamp
    // to SharedPreferences so the guard survives process death. Cleanup
    // expired entries opportunistically on each read.
    private const val KEY_ACCEPTED_CALLS = "accepted_call_ids"
    private const val ACCEPT_TTL_MS = 60_000L

    fun persistCallAccepting(context: Context, callId: String) {
      if (callId.isEmpty()) return
      try {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_ACCEPTED_CALLS, "{}") ?: "{}"
        val obj = try { org.json.JSONObject(raw) } catch (_: Exception) { org.json.JSONObject() }
        val now = System.currentTimeMillis()
        // Cleanup stale
        val keys = obj.keys()
        val toRemove = mutableListOf<String>()
        while (keys.hasNext()) {
          val k = keys.next()
          if (now - obj.optLong(k, 0L) > ACCEPT_TTL_MS) toRemove.add(k)
        }
        toRemove.forEach { obj.remove(it) }
        obj.put(callId, now)
        prefs.edit().putString(KEY_ACCEPTED_CALLS, obj.toString()).apply()
        Log.d(TAG, "persistCallAccepting: callId=$callId (TTL=${ACCEPT_TTL_MS}ms)")
      } catch (e: Exception) {
        Log.w(TAG, "persistCallAccepting failed: ${e.message}")
      }
    }

    fun isCallAcceptingPersisted(context: Context, callId: String): Boolean {
      if (callId.isEmpty()) return false
      try {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_ACCEPTED_CALLS, null) ?: return false
        val obj = org.json.JSONObject(raw)
        val ts = obj.optLong(callId, 0L)
        if (ts == 0L) return false
        return (System.currentTimeMillis() - ts) <= ACCEPT_TTL_MS
      } catch (e: Exception) {
        Log.w(TAG, "isCallAcceptingPersisted failed: ${e.message}")
        return false
      }
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

    // WhatsApp-grade cold-start: JS calls this when the in-app /call screen
    // is mounted + ready to render. We broadcast CLOSE_CALL_ACTIVITY so the
    // IncomingCallActivity overlay ("Conectando com X...") can finish itself
    // cleanly. Without this the activity sits behind MainActivity stealing
    // gestures until the 8s safety timeout fires.
    Function("notifyAppReady") {
      try {
        val closeIntent = Intent("expo.modules.callkit.CLOSE_CALL_ACTIVITY")
        context.sendBroadcast(closeIntent)
      } catch (_: Exception) {}
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
      // Multi-device cancel: dismiss the IncomingCallActivity overlay too.
      // Without this broadcast, when the user answers on phone A, phone B
      // keeps its full-screen IncomingCallActivity sitting on top until the
      // 30s missed-call timeout. The activity already registers a receiver
      // for this exact action and finishes cleanly.
      try {
        val closeIntent = Intent("expo.modules.callkit.CLOSE_CALL_ACTIVITY")
        context.sendBroadcast(closeIntent)
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

    // [2026-05-15 #977] JS-side belt-and-suspenders. IncomingCallListener
    // calls this from the onCallEnded handler — if the callId is in our
    // persisted accept set (within 60s TTL), the end is almost certainly a
    // phantom from the cold-start cancelNotification race and JS must NOT
    // ship a WS call_end (which would echo back and end the real call).
    Function("isAcceptingPersisted") { callId: String ->
      isCallAcceptingPersisted(context, callId)
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
