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
        // [2026-05-15] Use commit() (synchronous) instead of apply() (async).
        // apply() returns before the disk write completes — when
        // CallActionReceiver reads isCallAcceptingPersisted() a few ms later
        // (deleteIntent fires basically the moment we cancelNotification),
        // the read can race with the in-flight write and see the old empty
        // value → phantom decline gets through. The ~5ms commit() penalty
        // is worth the correctness on cold-start accept.
        prefs.edit().putString(KEY_ACCEPTED_CALLS, obj.toString()).commit()
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

    // [2026-05-15 #992] LiveKit native pre-connect events. NativeCallRoom
    // is a singleton that owns the Room and emits events through these
    // companion methods so the Expo Module instance doesn't need to be alive
    // at the time of the event (cold-start: room connects before RN bundle
    // parses, the module subscribes when JS finally mounts and replays).
    fun emitLkConnected(callId: String, snapshot: Map<String, Any?>) {
      val inst = instance.get()
      if (inst != null) {
        inst.sendEvent("onLkConnected", mapOf("callId" to callId, "snapshot" to snapshot))
      } else {
        Log.d(TAG, "emitLkConnected: no JS instance yet — snapshot will be served via adoptNativeRoom()")
      }
    }
    fun emitLkParticipantConnected(callId: String, identity: String, sid: String) {
      instance.get()?.sendEvent("onLkParticipantConnected",
        mapOf("callId" to callId, "identity" to identity, "sid" to sid))
    }
    fun emitLkParticipantDisconnected(callId: String, identity: String) {
      instance.get()?.sendEvent("onLkParticipantDisconnected",
        mapOf("callId" to callId, "identity" to identity))
    }
    fun emitLkTrackSubscribed(callId: String, identity: String, kind: String, sid: String) {
      instance.get()?.sendEvent("onLkTrackSubscribed",
        mapOf("callId" to callId, "identity" to identity, "kind" to kind, "sid" to sid))
    }
    fun emitLkTrackUnsubscribed(callId: String, identity: String, kind: String) {
      instance.get()?.sendEvent("onLkTrackUnsubscribed",
        mapOf("callId" to callId, "identity" to identity, "kind" to kind))
    }
    fun emitLkConnectionQuality(callId: String, identity: String, quality: String) {
      instance.get()?.sendEvent("onLkConnectionQuality",
        mapOf("callId" to callId, "identity" to identity, "quality" to quality))
    }
    fun emitLkDisconnected(callId: String, reason: String) {
      instance.get()?.sendEvent("onLkDisconnected",
        mapOf("callId" to callId, "reason" to reason))
    }
    fun emitLkDataReceived(callId: String, identity: String, data: String) {
      instance.get()?.sendEvent("onLkDataReceived",
        mapOf("callId" to callId, "identity" to identity, "data" to data))
    }
    fun emitLkError(callId: String, message: String) {
      instance.get()?.sendEvent("onLkError",
        mapOf("callId" to callId, "message" to message))
    }

    /**
     * Save accepted call data to SharedPreferences so JS can read it on cold start.
     * Called from IncomingCallActivity and CallActionReceiver when instance is null.
     */
    /**
     * [#1175 2026-05-18] Copy the persisted auth_token + api_base from
     * SharedPreferences into the Intent so the receiving Activity has an
     * independent copy. Helps LkTokenFetcher resolve credentials via the
     * "Intent extras" fallback (source B) even if SharedPreferences was
     * wiped between intent creation and the activity reading them (rare
     * but observed during "Clear cache" + "Reset app preferences" tests).
     *
     * Idempotent — safe to call on any intent, even one that already
     * has the extras (last value wins, identical writes are no-ops).
     */
    fun enrichIntentWithAuth(context: Context, intent: Intent) {
      try {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val tk = prefs.getString("auth_token", null)
        val base = prefs.getString("api_base", null)
        if (!tk.isNullOrEmpty()) intent.putExtra("auth_token", tk)
        if (!base.isNullOrEmpty()) intent.putExtra("api_base", base)
      } catch (t: Throwable) {
        Log.w(TAG, "enrichIntentWithAuth failed: ${t.message}")
      }
    }

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
      // [2026-05-15] commit() (sync) — JS reads this on cold-start launch and
      // we cannot afford a race where the read fires before the disk write
      // settled. ~5ms is acceptable; this only runs once per accept.
      prefs.edit().putString(KEY_PENDING_CALL, data.toString()).commit()
      Log.d(TAG, "Saved pending accepted call: $callId callerEmail=$callerEmail")
    }
  }

  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("ExpoCallKit")

    Events(
      "onCallAnswered", "onCallEnded", "onVoipTokenReceived", "onIncomingCall",
      // [2026-05-15 #992] Native LiveKit Room events fired by NativeCallRoom.
      "onLkConnected", "onLkParticipantConnected", "onLkParticipantDisconnected",
      "onLkTrackSubscribed", "onLkTrackUnsubscribed", "onLkConnectionQuality",
      "onLkDisconnected", "onLkDataReceived", "onLkError"
    )

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

      // [Telecom integration, 2026-05-17] Register the Chatyy PhoneAccount with
      // TelecomManager so the OS recognises us as a calling app. Idempotent —
      // safe to call on every setup. Pre-O devices no-op silently.
      try {
        ChatyyInCallService.registerPhoneAccount(context)
      } catch (t: Throwable) {
        Log.w(TAG, "registerPhoneAccount failed: ${t.message}")
      }

      // [2026-05-17 RNNoise + MediaPipe] Touch processor singletons so the
      // reflective class lookups + native lib loads run at setup time, not
      // at first frame (which would block the audio thread for ~200ms).
      try {
        val n = expo.modules.callkit.audio.RNNoiseProcessor.shared()
        val v = expo.modules.callkit.video.BackgroundProcessor.get(context.applicationContext)
        // Apply persisted toggle states so the very first Room inherits them.
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        n.enabled = prefs.getBoolean("rnnoise_enabled", true)
        val mode = prefs.getString("bg_mode", "off")
        v.mode = when (mode) {
          "blur_low" -> expo.modules.callkit.video.BackgroundProcessor.Mode.BLUR_LOW
          "blur_medium", "blur" -> expo.modules.callkit.video.BackgroundProcessor.Mode.BLUR_MEDIUM
          "blur_high" -> expo.modules.callkit.video.BackgroundProcessor.Mode.BLUR_HIGH
          "image" -> expo.modules.callkit.video.BackgroundProcessor.Mode.IMAGE
          else -> expo.modules.callkit.video.BackgroundProcessor.Mode.OFF
        }
        v.imageAsset = prefs.getString("bg_image", null)?.takeIf { it.isNotEmpty() }
        Log.d(TAG, "setup: processors ready — rnnoise.available=${n.available} bg.available=${v.available}")
      } catch (t: Throwable) {
        Log.w(TAG, "processor preload failed: ${t.message}")
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
        "ringingServiceActive" to (CallRingingService.currentCallId.get() != null),
        "lkNativeRoomConnected" to NativeCallRoom.isConnected(),
        "lkNativeCallId" to (NativeCallRoom.currentCallId() ?: "")
      )
    }

    // ─── Native LiveKit Room (Stage 1 #992) ───────────────────────────────
    //
    // Allow JS to persist auth + base URL into SharedPreferences so Kotlin
    // can fetch a LiveKit token without waiting for the JS bridge to be alive.
    // Called from services/api.js on login success.
    AsyncFunction("persistAuthForNativeCall") { token: String, baseUrl: String ->
      try {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
          .putString("auth_token", token)
          .putString("api_base", baseUrl)
          .apply()
        Log.d(TAG, "persistAuthForNativeCall: stashed token len=${token.length} base=$baseUrl")
        // [P0 2026-05-18 #1132] Now that we have a fresh bearer in prefs,
        // open the native CallSignalWs eagerly so inbound `call_invite`
        // frames can launch CallRingingService even if the JS WS path is
        // broken/paused.
        try { CallSignalWs.warmConnect(context.applicationContext) } catch (_: Throwable) {}
      } catch (t: Throwable) {
        Log.e(TAG, "persistAuthForNativeCall failed: ${t.message}")
      }
    }

    // Pre-stash a fetched LK token+url so IncomingCallActivity.onAccept can
    // use it without re-fetching (saves ~300ms on the critical path).
    // Called from IncomingCallListener when JS handles the call_invite WS
    // event ahead of the OS push delivery (warm path).
    AsyncFunction("persistPendingLkToken") { roomName: String, token: String, url: String ->
      LkTokenFetcher.setCached(context, roomName, token, url)
    }

    Function("isNativeRoomConnected") {
      NativeCallRoom.isConnected()
    }

    // [#992] JS calls this when /call.js mounts. If native already has a
    // connected Room for the callId, returns a snapshot and JS skips its
    // own Room.connect → no dual-Room race. Otherwise returns null and JS
    // falls back to its legacy connect path.
    AsyncFunction("adoptNativeRoom") { callId: String ->
      if (!NativeCallRoom.isConnected()) return@AsyncFunction null
      if (NativeCallRoom.currentCallId() != callId) {
        Log.w(TAG, "adoptNativeRoom: native room is for ${NativeCallRoom.currentCallId()}, not $callId — declining adoption")
        return@AsyncFunction null
      }
      NativeCallRoom.getSnapshot()
    }

    // JS-initiated connect (outgoing calls — Stage 5). Native is happy to
    // either pre-connect (incoming, from onAccept) or be told to connect
    // (outgoing, from chat-conversation tap "ligar").
    AsyncFunction("lkConnect") { url: String, token: String, callId: String, hasVideo: Boolean ->
      NativeCallRoom.connect(context.applicationContext, url, token, callId, hasVideo)
    }

    AsyncFunction("lkDisconnect") {
      NativeCallRoom.disconnect()
    }

    AsyncFunction("lkSetMicEnabled") { enabled: Boolean ->
      NativeCallRoom.setMicEnabled(enabled)
    }

    AsyncFunction("lkSetCameraEnabled") { enabled: Boolean ->
      NativeCallRoom.setCameraEnabled(enabled)
    }

    // [host-mute, 2026-05-17] Host-issued mute of a remote participant.
    //
    // See ios/ExpoCallKitModule.swift for the full protocol — the LK Room is
    // JS-owned, so this is a thin pass-through: the host's JS calls
    // `chatCallMuteParticipant` (HTTP), backend validates host role + fans
    // a `call_mute_request` WS event to the target client; the target's
    // /call.js handles the event and locally toggles
    // `room.localParticipant.setMicrophoneEnabled(false)`.
    //
    // We expose this bridge so call sites stay symmetric across platforms
    // and so a future native LK Room owner can switch from no-op to the
    // real SFU mute action without touching JS.
    AsyncFunction("muteParticipant") { roomName: String, identity: String ->
      android.util.Log.i(TAG, "muteParticipant room=$roomName identity=$identity — JS owns the HTTP path, this is a no-op shim")
      true
    }

    // ─── RNNoise ML noise suppression (2026-05-17) ─────────────────────────
    //
    // Per-user toggle, default ON. The actual frame-by-frame processing lives
    // in expo.modules.callkit.audio.RNNoiseProcessor (loaded reflectively
    // from the prebuilt livekit/rnnoise-android AAR). The processor is a
    // singleton — flipping the toggle here flips it for any active Room.
    //
    // Per-user persistence lives in SharedPreferences (KEY_RNNOISE) so a
    // returning user inherits their last choice. JS bridges
    // services/api.js login/restore should call setNoiseSuppression(true)
    // once on first launch to seed the default.
    Function("setNoiseSuppression") { enabled: Boolean ->
      try {
        val proc = expo.modules.callkit.audio.RNNoiseProcessor.shared()
        proc.enabled = enabled
        // Persist per-user. The actual user-id key would be account email,
        // but the toggle is per-device today (matches Krisp's UX where the
        // setting is also tied to the install, not the account).
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putBoolean("rnnoise_enabled", enabled).apply()
        Log.d(TAG, "setNoiseSuppression: $enabled (rnnoise.available=${proc.available})")
        true
      } catch (t: Throwable) {
        Log.w(TAG, "setNoiseSuppression failed: ${t.message}")
        false
      }
    }

    Function("getNoiseSuppression") {
      try {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        // Default to true — match the JS-side `noiseSuppression: true`
        // constraint and the iOS default.
        prefs.getBoolean("rnnoise_enabled", true)
      } catch (_: Throwable) { true }
    }

    Function("isNoiseSuppressionAvailable") {
      try { expo.modules.callkit.audio.RNNoiseProcessor.shared().available }
      catch (_: Throwable) { false }
    }

    // ─── MediaPipe background blur / virtual background (2026-05-17) ──────
    //
    // Mode + asset are state on the singleton BackgroundProcessor; the
    // actual VideoProcessor binding lives on LiveKit's LocalVideoTrack and
    // is registered when CallActivity attaches its local camera. UI sets
    // the mode here; the processor picks it up on the next frame.
    Function("setBackgroundMode") { mode: String, imageAsset: String? ->
      try {
        val proc = expo.modules.callkit.video.BackgroundProcessor.get(context.applicationContext)
        proc.mode = when (mode.lowercase()) {
          "off", "none" -> expo.modules.callkit.video.BackgroundProcessor.Mode.OFF
          "blur_low", "blur-low" -> expo.modules.callkit.video.BackgroundProcessor.Mode.BLUR_LOW
          "blur_medium", "blur-medium", "blur" -> expo.modules.callkit.video.BackgroundProcessor.Mode.BLUR_MEDIUM
          "blur_high", "blur-high" -> expo.modules.callkit.video.BackgroundProcessor.Mode.BLUR_HIGH
          "image", "wallpaper" -> expo.modules.callkit.video.BackgroundProcessor.Mode.IMAGE
          else -> expo.modules.callkit.video.BackgroundProcessor.Mode.OFF
        }
        proc.imageAsset = imageAsset
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit()
          .putString("bg_mode", mode)
          .putString("bg_image", imageAsset ?: "")
          .apply()
        Log.d(TAG, "setBackgroundMode: $mode asset=$imageAsset available=${proc.available}")
        true
      } catch (t: Throwable) {
        Log.w(TAG, "setBackgroundMode failed: ${t.message}")
        false
      }
    }

    Function("getBackgroundMode") {
      try {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        mapOf(
          "mode" to (prefs.getString("bg_mode", "off") ?: "off"),
          "imageAsset" to (prefs.getString("bg_image", "") ?: ""),
        )
      } catch (_: Throwable) {
        mapOf("mode" to "off", "imageAsset" to "")
      }
    }

    Function("isBackgroundProcessorAvailable") {
      try { expo.modules.callkit.video.BackgroundProcessor.get(context.applicationContext).available }
      catch (_: Throwable) { false }
    }

    Function("getBackgroundWallpapers") {
      expo.modules.callkit.video.BackgroundProcessor.BUILTIN_WALLPAPERS
    }

    // ─── Screen share native trigger (Stage 4, 2026-05-17) ───────────────
    //
    // Higher-level screen-share entry exposed to JS. Internally just delegates
    // to expo-screen-share (which already owns the MediaProjection dance), but
    // gives JS a single bridge to call regardless of platform. `audioShare` is
    // accepted for parity with iOS — on Android system-audio capture requires
    // AudioPlaybackCaptureConfiguration which we haven't wired yet, so it's
    // logged + ignored for now.
    AsyncFunction("startScreenshare") { audioShare: Boolean ->
      try {
        // Look up the expo-screen-share module by name via the host appContext
        // registry. We avoid a hard import to keep this module compilable
        // even if expo-screen-share is excluded from a build variant.
        val cls = Class.forName("expo.modules.screenshare.ExpoScreenShareModule")
        val nameField = cls.getDeclaredMethod("definition")
        // The actual presentBroadcastPicker AsyncFunction is on the module's
        // Expo runtime registration — we cannot invoke it via Java reflection
        // without the Promise infrastructure. Instead we send an intent the
        // app's RN bridge already knows how to handle: ScreenShareService
        // ACTION_REQUEST_PICKER. Falls back gracefully if missing.
        val intent = Intent("expo.modules.screenshare.REQUEST_PICKER")
        intent.setPackage(context.packageName)
        intent.putExtra("audio", audioShare)
        context.sendBroadcast(intent)
        Log.d(TAG, "startScreenshare: dispatched picker request audio=$audioShare ref=${nameField.name}")
        true
      } catch (t: Throwable) {
        Log.w(TAG, "startScreenshare failed: ${t.message}")
        false
      }
    }

    AsyncFunction("stopScreenshare") {
      try {
        val intent = Intent("expo.modules.screenshare.REQUEST_STOP")
        intent.setPackage(context.packageName)
        context.sendBroadcast(intent)
        true
      } catch (t: Throwable) {
        Log.w(TAG, "stopScreenshare failed: ${t.message}")
        false
      }
    }

    // [2026-05-15 Day 1 full-native] Launch the native call screen (CallActivity)
    // directly from JS. Replaces `router.push('/call')` — the RN /call.js path
    // is the source of the cold-start race that drops incoming calls. Native
    // owns the entire UX: caller avatar, mute/hangup/video toggle. JS only
    // launches and listens for onCallEnded.
    //
    // Outgoing flow (Stage 5): chat-conversation "Ligar" tap → openNativeCall.
    // Incoming flow (Stage 4): IncomingCallActivity.onAccept will also call
    // into here once the migration is complete — for now the legacy MainActivity
    // path still runs.
    AsyncFunction("openNativeCall") {
      callId: String,
      callerName: String,
      callerEmail: String,
      hasVideo: Boolean,
      lkUrl: String?,
      lkToken: String?
      ->
      try {
        // [#1172 native-call-in-background fix, 2026-05-18] When MainActivity
        // is foreground (user tapping "Ligar" from chat), launching with just
        // FLAG_ACTIVITY_NEW_TASK + manifest singleTop is NOT enough — the OS
        // sees the new task but keeps MainActivity's task on top because
        // taskAffinity="" puts CallActivity in its own affinity-less task and
        // the launcher task stays "more important". Result: native UI builds
        // (LK Room connects, audio captures) but the user never sees it,
        // they only see the JS "Conectando..." stale state.
        //
        // FLAG_ACTIVITY_REORDER_TO_FRONT forces the OS to bring CallActivity's
        // task to the foreground even if MainActivity's task currently owns
        // it. FLAG_ACTIVITY_SINGLE_TOP avoids a second instance when the
        // activity is already active (e.g. user navigates back to chat and
        // re-taps Ligar within the same call). Combined with the manifest
        // singleTop launchMode this guarantees exactly one foreground
        // CallActivity instance per call.
        val intent = Intent(context, CallActivity::class.java).apply {
          addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
              or Intent.FLAG_ACTIVITY_SINGLE_TOP
              or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
              or Intent.FLAG_ACTIVITY_CLEAR_TOP
          )
          putExtra(CallActivity.EXTRA_CALL_ID, callId)
          putExtra(CallActivity.EXTRA_CALLER_NAME, callerName)
          putExtra(CallActivity.EXTRA_CALLER_EMAIL, callerEmail)
          putExtra(CallActivity.EXTRA_HAS_VIDEO, hasVideo)
          if (lkUrl != null) putExtra(CallActivity.EXTRA_LK_URL, lkUrl)
          if (lkToken != null) putExtra(CallActivity.EXTRA_LK_TOKEN, lkToken)
          // [#1175 2026-05-18] Carry auth in the intent so CallActivity
          // has an independent copy even if SharedPreferences is wiped
          // between this launch and onCreate (rare but possible during
          // "Clear cache" or "Reset app preferences").
          enrichIntentWithAuth(context, this)
        }
        context.startActivity(intent)
        Log.d(TAG, "openNativeCall: launched CallActivity callId=$callId with foreground flags")
      } catch (t: Throwable) {
        Log.e(TAG, "openNativeCall failed: ${t.message}", t)
      }
    }

    // ─── Stage #996 outgoing native flow (2026-05-17) ────────────────────
    //
    // Higher-level outgoing-call entry point. Encapsulates the steps the JS
    // side used to do inline (generate callId, mint LK token, openNativeCall):
    //
    //   1. Accept a JS-supplied call_id (so the JS layer and server share
    //      the same identifier), otherwise generate one.
    //   2. Launch CallActivity with EXTRA_IS_OUTGOING=true so the activity
    //      fires call_invite via CallSignalWs and plays the standard ringback
    //      tone (TONE_SUP_RINGTONE) while waiting for the callee to answer.
    //   3. If JS pre-fetched the LK token (warm path), forward it through
    //      EXTRA_LK_URL/EXTRA_LK_TOKEN. Otherwise CallActivity will skip
    //      Room.connect and JS can mint+forward later via lkConnect.
    //
    // Returns true once the activity intent is dispatched (fire-and-forget).
    // Android has no analog to CXStartCallAction's "system tracks the call
    // in Recents" — we approximate by relying on the chat history bubbles
    // server-side (call_status row + WS broadcast).
    AsyncFunction("startOutgoingCall") { params: Map<String, Any> ->
      val calleeEmail = (params["callee_email"] as? String) ?: ""
      if (calleeEmail.isEmpty()) {
        throw IllegalArgumentException("callee_email required")
      }
      val calleeName = (params["callee_name"] as? String) ?: calleeEmail
      // [#1176 polish, 2026-05-18] Avatar URL forwarded into CallActivity so
      // the Compose UI can paint the real photo instead of just an initial
      // letter while LiveKit Room is still negotiating.
      val calleeAvatar = (params["callee_avatar"] as? String) ?: ""
      val callerName = (params["caller_name"] as? String) ?: ""
      val isVideo = (params["is_video"] as? Boolean) ?: false
      val roomName = (params["room_name"] as? String) ?: ""
      val conversationId = (params["conversation_id"] as? String) ?: ""
      val lkUrl = params["lk_url"] as? String
      val lkToken = params["lk_token"] as? String
      val callId: String = (params["call_id"] as? String)?.takeIf { it.isNotEmpty() }
        ?: "call_${System.currentTimeMillis()}_${java.util.UUID.randomUUID().toString().substring(0, 8)}"

      try {
        // [#1172 native-call-in-background fix, 2026-05-18] Same foreground-
        // forcing flag set as openNativeCall above. Without REORDER_TO_FRONT
        // the OS keeps MainActivity's task on top and CallActivity (in its
        // own affinity-less task) builds invisibly in the background — user
        // sees only the JS "Calling…" overlay even though LK Room is alive.
        val intent = Intent(context, CallActivity::class.java).apply {
          addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
              or Intent.FLAG_ACTIVITY_SINGLE_TOP
              or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
              or Intent.FLAG_ACTIVITY_CLEAR_TOP
          )
          putExtra(CallActivity.EXTRA_CALL_ID, callId)
          // For an outgoing call the "caller_name" displayed on the screen is
          // actually the *callee* — that's who we're calling. Mirroring iOS.
          putExtra(CallActivity.EXTRA_CALLER_NAME, calleeName)
          putExtra(CallActivity.EXTRA_CALLER_EMAIL, calleeEmail)
          putExtra(CallActivity.EXTRA_HAS_VIDEO, isVideo)
          putExtra(CallActivity.EXTRA_IS_OUTGOING, true)
          putExtra(CallActivity.EXTRA_CONVERSATION_ID, conversationId)
          if (calleeAvatar.isNotEmpty()) {
            putExtra(CallActivity.EXTRA_CALLER_AVATAR, calleeAvatar)
          }
          if (!lkUrl.isNullOrEmpty()) putExtra(CallActivity.EXTRA_LK_URL, lkUrl)
          if (!lkToken.isNullOrEmpty()) putExtra(CallActivity.EXTRA_LK_TOKEN, lkToken)
          // [#1175 2026-05-18] Carry auth in the intent — same rationale
          // as openNativeCall above.
          enrichIntentWithAuth(context, this)
        }
        context.startActivity(intent)
        Log.d(TAG, "startOutgoingCall: started CallActivity callId=$callId callee=$calleeEmail video=$isVideo hasToken=${!lkToken.isNullOrEmpty()} hasAvatar=${calleeAvatar.isNotEmpty()}")
        return@AsyncFunction true
      } catch (t: Throwable) {
        Log.e(TAG, "startOutgoingCall failed: ${t.message}", t)
        throw t
      }
    }

    // [2026-05-16] Group call launcher — sibling of openNativeCall, but for
    // the N-way GroupCallActivity. Replaces /group-call.js (RN WebView). JS
    // passes a JSON-stringified participants list so the activity can pre-seed
    // placeholder tiles before LiveKit's ParticipantConnected events arrive.
    AsyncFunction("openGroupCall") {
      roomName: String,
      lkUrl: String,
      lkToken: String,
      participantsJson: String,
      hasVideo: Boolean
      ->
      try {
        // [#1172 fix, 2026-05-18] Force GroupCallActivity to the foreground —
        // mirrors openNativeCall. Without REORDER_TO_FRONT the group-call
        // task lives behind MainActivity (silent LK Room, no UI visible).
        val intent = Intent(context, GroupCallActivity::class.java).apply {
          addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
              or Intent.FLAG_ACTIVITY_SINGLE_TOP
              or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
              or Intent.FLAG_ACTIVITY_CLEAR_TOP
          )
          putExtra(GroupCallActivity.EXTRA_ROOM_NAME, roomName)
          putExtra(GroupCallActivity.EXTRA_LK_URL, lkUrl)
          putExtra(GroupCallActivity.EXTRA_LK_TOKEN, lkToken)
          putExtra(GroupCallActivity.EXTRA_PARTICIPANTS_JSON, participantsJson)
          putExtra(GroupCallActivity.EXTRA_HAS_VIDEO, hasVideo)
          // [#1175 2026-05-18] Carry auth — same rationale as CallActivity.
          enrichIntentWithAuth(context, this)
        }
        context.startActivity(intent)
      } catch (t: Throwable) {
        Log.e(TAG, "openGroupCall failed: ${t.message}", t)
      }
    }

    // ─── Native WS call signaling (Stage 1, 2026-05-16) ──────────────────
    //
    // JS-callable bridge to CallSignalWs (raw OkHttp WebSocket to
    // wss://ws.chatyy.com.br/ws). These are sync Function — fire-and-forget;
    // the WS layer queues + auto-reconnects internally.
    //
    // Stage 1 only stands up the bridge. Stage 2 (separate work) will wire
    // CallActivity.onAccept / onHangup to call these directly so the call
    // signaling path no longer touches the JS bridge. Until then, the
    // JS-side WS (services/api.js) remains the primary path and these are
    // a no-op until JS opts in.
    Function("fireCallInviteNative") { callId: String, conversationId: String, calleeEmail: String, hasVideo: Boolean ->
      CallSignalWs.fireCallInvite(context.applicationContext, callId, conversationId, calleeEmail, hasVideo)
    }

    Function("fireCallAnsweredNative") { callId: String, conversationId: String ->
      CallSignalWs.fireCallAnswered(context.applicationContext, callId, conversationId)
    }

    Function("fireCallEndNative") { callId: String, conversationId: String, reason: String ->
      CallSignalWs.fireCallEnd(context.applicationContext, callId, conversationId, reason)
    }

    // [P0 2026-05-18 #1132] Eagerly open the native CallSignalWs so it can
    // receive inbound `call_invite` frames and launch CallRingingService
    // even if the JS WS path is broken / paused / lazy-loading. Idempotent;
    // safe to call from any JS hook (login, foreground, even on every render).
    Function("warmCallSignalWs") {
      try { CallSignalWs.warmConnect(context.applicationContext) } catch (_: Throwable) {}
    }
  }
}
