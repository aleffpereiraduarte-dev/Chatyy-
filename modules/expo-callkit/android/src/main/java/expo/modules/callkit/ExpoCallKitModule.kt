package expo.modules.callkit

import android.app.ActivityOptions
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

    // ────────────── [CALL_E2EE, flag-gated, default OFF] ──────────────
    // Pending E2EE shared keys, keyed by callId. The JS layer calls
    // setCallE2EEKey(callId, keyBase64) BEFORE the Room connects — but ONLY
    // when the CALL_E2EE feature flag is ON and it has already negotiated a
    // symmetric key with the peer (via the encrypted envelope channel). The
    // value stored is the RAW decoded key bytes (base64 → bytes).
    //
    // NativeCallRoom reads this map at Room-create time. If there is NO entry
    // for the callId (flag off / key never set / decode failed), the Room is
    // created EXACTLY as before — plaintext, zero behavior change. This is the
    // hard guarantee: no key ⇒ today's behavior.
    private val pendingE2EEKeys = java.util.concurrent.ConcurrentHashMap<String, ByteArray>()

    fun setPendingE2EEKey(callId: String, key: ByteArray) {
      if (callId.isEmpty() || key.isEmpty()) return
      pendingE2EEKeys[callId] = key
      Log.i(TAG, "setPendingE2EEKey: stored ${key.size}-byte key for callId=$callId")
    }

    /** Read (without removing) the pending E2EE key for [callId], or null. Kept
     *  across reconnects; cleared via [clearPendingE2EEKey] on call teardown. */
    fun pendingE2EEKey(callId: String?): ByteArray? {
      if (callId.isNullOrEmpty()) return null
      return pendingE2EEKeys[callId]
    }

    fun clearPendingE2EEKey(callId: String?) {
      if (callId.isNullOrEmpty()) return
      pendingE2EEKeys.remove(callId)
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

    /**
     * [foreground gate, 2026-05-21] Bridge for CallSignalWs.kt: when a
     * `call_invite` WS frame arrives while the app is in the foreground,
     * the native ring path is suppressed (JS owns the UI). We still emit
     * `onIncomingCall` so any listener wired through ExpoCallKit picks up
     * the call metadata. JS-side primary subscription is `mailWs.on
     * 'call_invite'` in IncomingCallListener — this is a belt-and-suspenders
     * bridge so cold-bundle / Suspense races still see the invite.
     */
    fun emitIncomingCallForeground(
      callId: String,
      callerName: String,
      callerEmail: String,
      conversationId: String,
      hasVideo: Boolean
    ) {
      val inst = instance.get()
      if (inst != null) {
        inst.sendEvent("onIncomingCall", mapOf(
          "callId" to callId,
          "callerName" to callerName,
          "callerEmail" to callerEmail,
          "conversationId" to conversationId,
          "hasVideo" to hasVideo,
          "foreground" to true,
          "source" to "ws"
        ))
      } else {
        Log.d(TAG, "emitIncomingCallForeground: no JS instance — JS WS subscription is primary anyway")
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
    // [2026-05-21] LiveKit reconnect lifecycle events. JS subscribers show a
    // "Reconnecting..." banner so users don't think the call has dropped when
    // the SFU briefly loses the WS (Wi-Fi → cellular, tunnel reset, etc.).
    fun emitLkReconnecting(callId: String) {
      instance.get()?.sendEvent("nativeCallRoomReconnecting",
        mapOf("callId" to callId))
    }
    fun emitLkReconnected(callId: String) {
      instance.get()?.sendEvent("nativeCallRoomReconnected",
        mapOf("callId" to callId))
    }

    // __chatyy_native_call_sync 2026-05-19 — control-state mirrors fired by
    // CallActivity (Compose) so JS overlays/analytics see the SAME state the
    // native UI is rendering. Without these the native pill toggles (mute,
    // cam, speaker, hold, PiP, route, camera flip) were silent black holes
    // from the JS side and the post-call rating + recording banner drifted.
    fun emitLkLocalAudioChanged(enabled: Boolean) {
      instance.get()?.sendEvent("onLkLocalAudioChanged", mapOf("enabled" to enabled))
    }
    fun emitLkLocalVideoChanged(enabled: Boolean) {
      instance.get()?.sendEvent("onLkLocalVideoChanged", mapOf("enabled" to enabled))
    }
    fun emitLkSpeakerChanged(enabled: Boolean) {
      instance.get()?.sendEvent("onLkSpeakerChanged", mapOf("enabled" to enabled))
    }
    fun emitLkCameraFlipped(front: Boolean) {
      instance.get()?.sendEvent("onLkCameraFlipped", mapOf("front" to front))
    }
    fun emitAudioRouteChanged(route: String) {
      instance.get()?.sendEvent("onAudioRouteChanged", mapOf("route" to route))
    }
    // [STAGE-B 2026-05-20] Overload — Telecom's onCallAudioStateChanged
    // hands us both the active route AND the muted flag. JS-side
    // /call.js mute pill should reflect Telecom mute (lockscreen / Auto /
    // Wear mute taps go through Telecom, not through our Compose buttons),
    // so emit both fields together.
    fun emitAudioRouteChanged(route: String, muted: Boolean) {
      instance.get()?.sendEvent("onAudioRouteChanged",
        mapOf("route" to route, "muted" to muted))
    }
    fun emitCallHoldChanged(held: Boolean) {
      instance.get()?.sendEvent("onCallHoldChanged", mapOf("held" to held))
    }
    fun emitPipChanged(inPip: Boolean) {
      instance.get()?.sendEvent("onPipChanged", mapOf("inPip" to inPip))
    }

    /** [Wave C-1, 2026-05-21] Emitted when the user taps the chat icon in the
     *  native Compose CallActivity. JS subscriber in callkeep.js calls
     *  router.push('/chat-conversation?id=<conversationId>'). */
    fun emitOpenChat(callId: String, conversationId: String) {
      instance.get()?.sendEvent("onOpenChat", mapOf(
        "callId" to callId,
        "conversationId" to conversationId
      ))
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

    /**
     * [STAGE-B 2026-05-20] Register the self-managed ConnectionService
     * PhoneAccount with TelecomManager. Idempotent (TelecomManager dedupes
     * by handle). Returns true iff the account is now registered.
     *
     * The companion `ChatyyInCallService.registerPhoneAccount` already
     * registers a sibling account for the InCallService side. We register
     * BOTH so the OS can bind the InCallService for the dialer Recents UI
     * AND bind the ConnectionService for the actual Call lifecycle.
     */
    fun registerConnectionServicePhoneAccount(ctx: Context): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        Log.i(TAG, "registerConnectionServicePhoneAccount: pre-O — skipping")
        return false
      }
      return try {
        val tm = ctx.getSystemService(Context.TELECOM_SERVICE) as? android.telecom.TelecomManager
          ?: return false.also { Log.w(TAG, "TelecomManager unavailable") }
        val handle = ChatyyConnectionService.phoneAccountHandle(ctx)
        val account = android.telecom.PhoneAccount.builder(handle, "Chatyy Calls")
          .setCapabilities(
            android.telecom.PhoneAccount.CAPABILITY_SELF_MANAGED or
            android.telecom.PhoneAccount.CAPABILITY_SUPPORTS_VIDEO_CALLING or
            android.telecom.PhoneAccount.CAPABILITY_VIDEO_CALLING
          )
          .setShortDescription("Chatyy voice + video (self-managed)")
          .build()
        tm.registerPhoneAccount(account)
        Log.i(TAG, "ConnectionService PhoneAccount registered: ${handle.id}")
        true
      } catch (t: Throwable) {
        Log.w(TAG, "registerConnectionServicePhoneAccount failed: ${t.message}")
        false
      }
    }

    /**
     * [STAGE-B 2026-05-20] Drive the Telecom self-managed path for an
     * incoming call. The FCM service AND the JS `displayIncomingCall`
     * AsyncFunction both go through this so the call surfaces in the
     * system call UI (lock-screen FSI, Auto, Wear) the same way for
     * push-driven AND WS-driven invites.
     *
     * On API ≥ O with the PhoneAccount registered, we hand the call to
     * TelecomManager.addNewIncomingCall. The OS then binds our
     * ConnectionService.onCreateIncomingConnection, which returns a
     * Connection in STATE_RINGING. If addNewIncomingCall throws (e.g.
     * MANAGE_OWN_CALLS denied, or another self-managed app is currently
     * holding the audio) we fall back to the Stage A
     * CallRingingService + IncomingCallActivity path.
     */
    fun startTelecomIncomingCall(
      ctx: Context,
      callId: String,
      callerName: String,
      callerEmail: String,
      conversationId: String,
      hasVideo: Boolean,
      callerAvatar: String,
      lkUrl: String?,
      lkToken: String?,
      // [A2 gap, 2026-05-20] Caller's E.164 phone (from chat_phone_registry).
      // Optional — when present we drive a `tel:` URI in the Telecom address
      // so the system dialer attributes the call as if it came from a real
      // phone number (Recents tab parity with WhatsApp).
      callerPhoneE164: String? = null,
    ): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
      return try {
        val tm = ctx.getSystemService(Context.TELECOM_SERVICE) as? android.telecom.TelecomManager
          ?: return false
        val handle = ChatyyConnectionService.phoneAccountHandle(ctx)
        val inner = ChatyyConnectionService.buildIncomingExtras(
          callId, callerName, callerEmail, conversationId, hasVideo,
          callerAvatar, lkUrl, lkToken, callerPhoneE164
        )
        val outer = android.os.Bundle().apply {
          putBundle(android.telecom.TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, inner)
        }
        tm.addNewIncomingCall(handle, outer)
        Log.i(TAG, "addNewIncomingCall dispatched: callId=$callId")
        true
      } catch (t: Throwable) {
        Log.w(TAG, "startTelecomIncomingCall failed: ${t.message}")
        false
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
      "onLkDisconnected", "onLkDataReceived", "onLkError",
      // [2026-05-21] LK reconnect lifecycle — banner in /call UI.
      "nativeCallRoomReconnecting", "nativeCallRoomReconnected",
      // __chatyy_native_call_sync 2026-05-19 — native call-state changes
      // mirrored to JS (mute / cam / speaker / route / camera-flip / hold /
      // PiP) so the JS overlay, analytics, recording banner, and post-call
      // rating share state with the native Compose UI. Without these the
      // native button taps were silent black holes from the JS side.
      "onLkLocalAudioChanged", "onLkLocalVideoChanged", "onLkSpeakerChanged",
      "onLkCameraFlipped", "onAudioRouteChanged", "onCallHoldChanged",
      "onPipChanged",
      // [Wave C-1, 2026-05-21] Back-to-chat button in native call UI.
      // Payload: { callId: String, conversationId: String? }.
      // JS subscriber in callkeep.js pushes /chat-conversation?id=...
      "onOpenChat"
    )

    OnCreate {
      instance.set(this@ExpoCallKitModule)
      // [native-crash-visibility 2026-05-26] Install a process-wide
      // uncaught-exception handler so NATIVE Kotlin crashes (which bypass the
      // JS ErrorUtils handler in services/crashReporter.js) get recorded to the
      // same push_diag.log channel before the OS tears the process down. This
      // module is guaranteed to load early, so OnCreate is a reliable install
      // point. Guarded internally — can never crash boot. See NativeCrashReporter.
      try {
        NativeCrashReporter.install(context.applicationContext)
      } catch (t: Throwable) {
        Log.w(TAG, "NativeCrashReporter install failed: ${t.message}")
      }
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

      // [STAGE-B 2026-05-20] Register the self-managed ConnectionService
      // PhoneAccount. This is the OTHER half of the Telecom integration —
      // ChatyyInCallService registered the dialer/UI side; this one
      // registers the audio-focus + lifecycle owner side. With both
      // accounts present, addNewIncomingCall(handle) succeeds and the
      // Connection.onAnswer → setActive() → MODE_IN_COMMUNICATION chain
      // works without us touching AudioManager directly.
      try {
        registerConnectionServicePhoneAccount(context)
      } catch (t: Throwable) {
        Log.w(TAG, "registerConnectionServicePhoneAccount failed: ${t.message}")
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

    AsyncFunction("displayIncomingCall") { callId: String, callerName: String, hasVideo: Boolean, callerEmail: String?, conversationId: String?, lkToken: String?, lkUrl: String? ->
      // [STAGE-B 2026-05-20] WhatsApp parity path. We do THREE things in
      // parallel:
      //   1. Start CallRingingService — owns the ringtone + vibration FGS
      //      with FOREGROUND_SERVICE_TYPE_PHONE_CALL. Required to keep the
      //      process alive past the FCM service's brief grant.
      //   2. Pre-warm LiveKit Room.connect via NativeCallRoom.preconnect
      //      so by the time the user taps Accept, audio is ~50ms away.
      //   3. Hand the call to TelecomManager.addNewIncomingCall via the
      //      self-managed ConnectionService. The OS surfaces its own FSI
      //      (immune to USE_FULL_SCREEN_INTENT runtime grants on A14+) and
      //      claims STREAM_VOICE_CALL focus when the user accepts.
      // If Telecom path fails (pre-O, MANAGE_OWN_CALLS denied, already
      // holding the audio), Stage A IncomingCallActivity covers us.
      val email = callerEmail ?: ""
      val convId = conversationId ?: ""

      // 1. Ringtone foreground service (Stage A — still required).
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
          context, callId, callerName, hasVideo, email, convId
        )
      }

      // 2. [STAGE-B] Pre-warm LK Room. Best effort — if we don't have
      // creds (rare; backend mints them in the FCM payload via
      // _mintLivekitTokenForUser), skip. NativeCallRoom guards against
      // duplicate calls for the same callId.
      try {
        if (!lkUrl.isNullOrBlank() && !lkToken.isNullOrBlank()) {
          NativeCallRoom.preconnect(context.applicationContext, lkUrl, lkToken, callId)
        }
      } catch (t: Throwable) {
        Log.w(TAG, "preconnect skipped: ${t.message}")
      }

      // 3. [STAGE-B] Drive Telecom self-managed path.
      try {
        ExpoCallKitModule.startTelecomIncomingCall(
          context.applicationContext, callId, callerName, email, convId, hasVideo,
          callerAvatar = "", lkUrl = lkUrl, lkToken = lkToken
        )
      } catch (t: Throwable) {
        Log.w(TAG, "Telecom addNewIncomingCall failed (Stage A fallback active): ${t.message}")
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
      // [#1179 cleanup, 2026-05-19] Also stop the in-progress FGS. If hangup
      // runs from JS while CallActivity is destroyed (rare: user hung up
      // from a different RN screen via callKeep.endCall after the call
      // screen was already torn down, OR app was killed mid-call and JS
      // is replaying cleanup on next launch), CallActivity.finishCall never
      // ran so CallOngoingService is still alive — its persistent "Chamada
      // em andamento" notification lingers and the FGS keeps the process
      // pinned in the background. Stop it explicitly here so the same JS
      // endCall path serves as a system-wide call-state purge.
      try {
        val stopOngoing = Intent(context, CallOngoingService::class.java)
        context.stopService(stopOngoing)
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

    // [Wave Bridge-Surface, 2026-05-21 / Agent 9] Read-only call snapshot.
    //
    // SYNCHRONOUS — must be `Function`, NOT `AsyncFunction`. JS polls every
    // 1s from services/call-state-reader.js plus on event triggers.
    //
    // Returns `null` when no call is in progress. Otherwise returns the
    // canonical [CallStateSnapshot] as a Map (Expo Modules serializes
    // primitive maps reliably across SDK versions).
    //
    // The native side is the source of truth: this reads live values from
    // [CurrentCallTracker], [NativeCallRoom], and the audio router.
    // JS never gets a handle to any of those — only the snapshot.
    //
    // See docs/whatsapp-migration/IMPL-bridge-surface-policy.md before
    // expanding this API.
    Function("getCurrentCallSnapshot") {
      val tracker = CurrentCallTracker.snapshotOrNull()
      if (tracker == null) return@Function null
      val lkConnected = NativeCallRoom.isConnected()
      val snap = CallStateSnapshot(
        callId = tracker.callId,
        contactEmail = tracker.contactEmail,
        contactName = tracker.contactName,
        isVideo = tracker.isVideo,
        mic = tracker.mic,
        speaker = tracker.speaker,
        durationSec = tracker.durationSec(),
        lkConnected = lkConnected,
        ringState = tracker.ringState,
      )
      snap.toMap()
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

    // DEPRECATED — to be removed in v2.5.0
    // Replaced by getCurrentCallSnapshot().lkConnected. Standalone existence
    // encouraged JS to poll LK state independently of the rest of call
    // state, causing the "Connecting..." eterno desync.
    Function("isNativeRoomConnected") {
      NativeCallRoom.isConnected()
    }

    // DEPRECATED — to be removed in v2.5.0
    // [Wave Bridge-Surface, 2026-05-21 / Agent 9] Leaked Room handle data
    // (participants, identity, roomName). JS /call.js on mobile is going
    // away — Compose InCallScreen owns the UI. Replacement: read minimal
    // info via getCurrentCallSnapshot().
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

    // DEPRECATED — to be removed in v2.5.0
    // Native owns Room.connect (CallActivity + NativeCallRoom). JS must
    // not initiate connect on mobile from v2.5.0. Kept for OTA-shipped
    // bundles still in the wild.
    // JS-initiated connect (outgoing calls — Stage 5). Native is happy to
    // either pre-connect (incoming, from onAccept) or be told to connect
    // (outgoing, from chat-conversation tap "ligar").
    AsyncFunction("lkConnect") { url: String, token: String, callId: String, hasVideo: Boolean ->
      NativeCallRoom.connect(context.applicationContext, url, token, callId, hasVideo)
    }

    // DEPRECATED — to be removed in v2.5.0
    // Use endCall(callId, reason) which goes through Telecom Connection
    // teardown; direct disconnect bypassed Telecom so the notification
    // pill stayed visible.
    AsyncFunction("lkDisconnect") {
      NativeCallRoom.disconnect()
    }

    // DEPRECATED — to be removed in v2.5.0
    // Mic state is Telecom-driven (Connection.setActive / setOnHold +
    // AudioManager). JS reads via getCurrentCallSnapshot().mic and
    // toggles via toggleMute() fire-and-forget (lands in v2.4.x).
    AsyncFunction("lkSetMicEnabled") { enabled: Boolean ->
      NativeCallRoom.setMicEnabled(enabled)
    }

    // DEPRECATED — to be removed in v2.5.0
    // Camera state is native-owned. JS should not poke the LK track
    // directly. Replacement: toggleCamera() lands in v2.4.x.
    AsyncFunction("lkSetCameraEnabled") { enabled: Boolean ->
      NativeCallRoom.setCameraEnabled(enabled)
    }

    // [CALL_E2EE, flag-gated, default OFF] Stash a per-call E2EE shared key so
    // NativeCallRoom enables LiveKit frame encryption when it creates/connects
    // the Room for this callId. JS calls this ONLY when the CALL_E2EE flag is
    // ON and it has already exchanged the symmetric key via the encrypted
    // envelope channel — BEFORE connecting. If JS never calls this (flag off),
    // no key is stored and the Room connects plaintext exactly as today.
    // keyBase64 is the base64 of the raw key bytes; we decode and store bytes.
    Function("setCallE2EEKey") { callId: String, keyBase64: String ->
      try {
        val bytes = android.util.Base64.decode(keyBase64, android.util.Base64.DEFAULT)
        if (callId.isNotEmpty() && bytes != null && bytes.isNotEmpty()) {
          setPendingE2EEKey(callId, bytes)
        } else {
          Log.w(TAG, "setCallE2EEKey: empty callId or key — ignoring (no E2EE)")
        }
      } catch (t: Throwable) {
        // Decode failure ⇒ no key stored ⇒ Room stays plaintext (today's path).
        Log.w(TAG, "setCallE2EEKey: base64 decode failed (${t.message}) — no E2EE for callId=$callId")
      }
    }

    // [#1205 live muting fix, 2026-05-19] Reset AudioManager mode before
    // live-broadcast.js calls getUserMedia. Symptom: "a live tá ficando muda"
    // — the host's mic becomes progressively quieter and eventually silent
    // mid-broadcast. Root cause is a leaked `MODE_IN_COMMUNICATION` from a
    // prior CallActivity / IncomingCallActivity.onAccept path that never
    // ran AudioRouter.teardown() (call ended via process kill, system swipe,
    // CXEndCall race, etc). With the device still in IN_COMMUNICATION mode,
    // Android's voice-call AEC chain assumes a far-end reference stream
    // exists; with no far-end (live broadcast is one-way send), the AEC
    // adaptive gate over-suppresses the local mic to "near silence".
    //
    // We do NOT touch focus here — the live broadcast doesn't claim
    // STREAM_VOICE_CALL focus, so the next foreground app inherits clean
    // STREAM_MUSIC state. We only flip the mode back so AEC stops treating
    // this as a phone call.
    Function("prepareAudioForLive") {
      try {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
        // Force MODE_NORMAL so the WebRTC AudioRecord opens with media
        // capture defaults (no voice-call AEC over-gating). Idempotent;
        // safe to call even if mode is already NORMAL.
        if (am.mode != android.media.AudioManager.MODE_NORMAL) {
          Log.d(TAG, "prepareAudioForLive: AudioManager.mode was ${am.mode} → resetting to MODE_NORMAL")
          am.mode = android.media.AudioManager.MODE_NORMAL
        }
        // Also drop any leaked speakerphone / BT SCO state from a previous
        // CallActivity that didn't tear down cleanly.
        try { am.isSpeakerphoneOn = false } catch (_: Throwable) {}
        try {
          @Suppress("DEPRECATION")
          am.isBluetoothScoOn = false
          @Suppress("DEPRECATION")
          am.stopBluetoothSco()
        } catch (_: Throwable) {}
        true
      } catch (t: Throwable) {
        Log.w(TAG, "prepareAudioForLive failed: ${t.message}")
        false
      }
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
        // [#1217 2026-05-19] FULL NATIVE — gate reverted per user decision.
        // Always launch CallActivity for every call (incoming or outgoing,
        // foreground or background). The dual-UI approach (JS when
        // foreground, native when background) caused too many edge cases.
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
      // [CALL-TRACE 2026-05-20 WAVE42] Step 3/12 — native module receives the
      // outgoing call request from JS. Grep `CallTrace` (no space). Logs the
      // raw incoming params BEFORE we synthesize callId/avatar/intent so we
      // can correlate JS-side step 2 with native-side intent dispatch.
      Log.i("CallTrace", "[3/12] native startOutgoingCall callId=${params["call_id"] ?: "<gen>"} callee=$calleeEmail video=${params["is_video"]} hasLkToken=${!(params["lk_token"] as? String).isNullOrEmpty()} ts=${System.currentTimeMillis()}")
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

      // [BUG 1 fix 2026-05-26 — REVERTED preconnect, kept clean teardown only]
      // Do NOT preconnect for OUTGOING here. preconnect() actually does
      // r.connect() to the SFU (NativeCallRoom.kt:541); CallActivity.bringUpRoom
      // still cold-creates its OWN Room (we did NOT wire adoption for outgoing,
      // because the warm Room lacks bringUpRoom's tuned roomOptions — h264 pin,
      // simulcast ladder, Opus dtx/red). Preconnecting WITHOUT adoption =
      // two connected Rooms with the SAME identity → SFU duplicate-identity
      // eviction (regression #1207) on EVERY outgoing call, not just redials.
      // The real redial lag is the previous engine's teardown racing the new
      // connect — fixed by the synchronous NativeCallRoom.disconnect() in
      // CallActivity.finishCall(). That alone is the safe win; no orphan Room.

      try {
        // [#1217 2026-05-19] FULL NATIVE — gate reverted. Always launch
        // CallActivity for outgoing calls.
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
        // [#1176 polish, 2026-05-18] Slide-up enter animation so the
        // transition reads as a modal surface coming on top of the chat,
        // not the default "whoosh from right" Activity transition. Uses the
        // calling Activity when available so the framework can apply the
        // matching exit animation to the chat screen behind us. Falls back
        // to context.startActivity (no anim) when called from background.
        val opts = ActivityOptions.makeCustomAnimation(
          context,
          R.anim.call_slide_up_enter,
          R.anim.call_fade_out,
        )
        val act = appContext.currentActivity
        if (act != null) {
          act.startActivity(intent, opts.toBundle())
        } else {
          context.startActivity(intent, opts.toBundle())
        }
        Log.d(TAG, "startOutgoingCall: started CallActivity callId=$callId callee=$calleeEmail video=$isVideo hasToken=${!lkToken.isNullOrEmpty()} hasAvatar=${calleeAvatar.isNotEmpty()}")
        return@AsyncFunction true
      } catch (t: Throwable) {
        Log.e(TAG, "startOutgoingCall failed: ${t.message}", t)
        throw t
      }
    }

    // [Wave 17 A4 gap, 2026-05-20] Telecom-routed outgoing call. Hands the
    // call to TelecomManager.placeCall so the system tracks it as a
    // self-managed call (audio focus, Recents, BT/Auto/Wear answer, cellular
    // arbitration) instead of CallActivity bypassing Telecom and racing
    // with any in-progress cellular call. JS-callable counterpart of
    // startTelecomIncomingCall. On API < 26 or when MANAGE_OWN_CALLS is
    // unavailable, returns false so the caller can fall back to the
    // pre-Telecom startOutgoingCall path. Fire-and-forget: the actual
    // Connection arrives in ChatyyConnectionService.onCreateOutgoingConnection.
    AsyncFunction("startTelecomOutgoingCall") { callId: String, calleeIdentifier: String, isVideo: Boolean ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        Log.i(TAG, "startTelecomOutgoingCall: pre-O — skipping (Telecom self-managed requires API 26+)")
        return@AsyncFunction false
      }
      if (calleeIdentifier.isEmpty()) {
        Log.w(TAG, "startTelecomOutgoingCall: empty calleeIdentifier — rejecting")
        return@AsyncFunction false
      }
      try {
        val tm = context.getSystemService(Context.TELECOM_SERVICE) as? android.telecom.TelecomManager
          ?: return@AsyncFunction false.also { Log.w(TAG, "startTelecomOutgoingCall: TelecomManager unavailable") }
        val handle = ChatyyConnectionService.phoneAccountHandle(context)
        // Pick the URI scheme based on whether the callee is a phone number
        // or an email. tel: gets richer Recents UI; sip: keeps Telecom happy
        // for email-only callees.
        val looksLikePhone = calleeIdentifier.matches(Regex("^\\+?[0-9 ()\\-]+$"))
        val uri = if (looksLikePhone) {
          android.net.Uri.fromParts("tel", calleeIdentifier.replace(Regex("[^+0-9]"), ""), null)
        } else {
          android.net.Uri.fromParts("sip", calleeIdentifier, null)
        }
        // Inner bundle = our payload (read in onCreateOutgoingConnection).
        val inner = android.os.Bundle().apply {
          putString("call_id", callId)
          putString("callee_email", calleeIdentifier)
          putString("callee_name", calleeIdentifier)
          putBoolean("is_video", isVideo)
        }
        val outer = android.os.Bundle().apply {
          putParcelable(android.telecom.TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
          putBundle(android.telecom.TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, inner)
          if (isVideo) {
            putInt(
              android.telecom.TelecomManager.EXTRA_START_CALL_WITH_VIDEO_STATE,
              android.telecom.VideoProfile.STATE_BIDIRECTIONAL
            )
          } else {
            putInt(
              android.telecom.TelecomManager.EXTRA_START_CALL_WITH_VIDEO_STATE,
              android.telecom.VideoProfile.STATE_AUDIO_ONLY
            )
          }
        }
        tm.placeCall(uri, outer)
        Log.i(TAG, "startTelecomOutgoingCall: placeCall dispatched callId=$callId callee=$calleeIdentifier video=$isVideo uri=$uri")
        return@AsyncFunction true
      } catch (t: Throwable) {
        // SecurityException (MANAGE_OWN_CALLS denied) or any other Telecom
        // failure — caller should fall back to the legacy startOutgoingCall.
        Log.w(TAG, "startTelecomOutgoingCall failed: ${t.message}")
        return@AsyncFunction false
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
    // DEPRECATED — to be removed in v2.5.0
    // [Wave Bridge-Surface, 2026-05-21 / Agent 9] JS-initiated signaling
    // emission. Native CallSignalWs emits call_invite when the outgoing
    // Connection is created — JS should not be the source of these frames.
    Function("fireCallInviteNative") { callId: String, conversationId: String, calleeEmail: String, hasVideo: Boolean ->
      CallSignalWs.fireCallInvite(context.applicationContext, callId, conversationId, calleeEmail, hasVideo)
    }

    // DEPRECATED — to be removed in v2.5.0
    // Native fires answered signal when Connection.onAnswer fulfils, not
    // when JS asks. JS-initiated double-answer caused SFU duplicate joins.
    Function("fireCallAnsweredNative") { callId: String, conversationId: String ->
      CallSignalWs.fireCallAnswered(context.applicationContext, callId, conversationId)
    }

    // DEPRECATED — to be removed in v2.5.0
    // Use endCall(callId, reason) which routes through Telecom Connection
    // teardown. Direct frame emission left the system notification pill
    // visible after hangup.
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

    // ─── DTMF keypad (2026-05-19) ────────────────────────────────────────
    //
    // Mirrors the iOS playDTMF Function. Two-tier dispatch:
    //   1. ToneGenerator.startTone(...) plays the matching DTMF beep
    //      locally so the user hears their tap registered.
    //   2. LocalBroadcastManager-style broadcast routes the digit into
    //      the active CallActivity which forwards it onto the LK Room
    //      data channel as `D:<digit>` (peer / SIP bridge consumes).
    //
    // Valid chars: 0-9, *, #, A-D. Anything else is silently dropped.
    Function("playDTMF") { digit: String ->
      val trimmed = digit.trim()
      if (trimmed.isEmpty()) return@Function
      val ch = trimmed[0]
      val toneId = when (ch) {
        '0' -> android.media.ToneGenerator.TONE_DTMF_0
        '1' -> android.media.ToneGenerator.TONE_DTMF_1
        '2' -> android.media.ToneGenerator.TONE_DTMF_2
        '3' -> android.media.ToneGenerator.TONE_DTMF_3
        '4' -> android.media.ToneGenerator.TONE_DTMF_4
        '5' -> android.media.ToneGenerator.TONE_DTMF_5
        '6' -> android.media.ToneGenerator.TONE_DTMF_6
        '7' -> android.media.ToneGenerator.TONE_DTMF_7
        '8' -> android.media.ToneGenerator.TONE_DTMF_8
        '9' -> android.media.ToneGenerator.TONE_DTMF_9
        '*' -> android.media.ToneGenerator.TONE_DTMF_S
        '#' -> android.media.ToneGenerator.TONE_DTMF_P
        'A' -> android.media.ToneGenerator.TONE_DTMF_A
        'B' -> android.media.ToneGenerator.TONE_DTMF_B
        'C' -> android.media.ToneGenerator.TONE_DTMF_C
        'D' -> android.media.ToneGenerator.TONE_DTMF_D
        else -> -1
      }
      if (toneId < 0) return@Function
      try {
        val gen = android.media.ToneGenerator(
          android.media.AudioManager.STREAM_VOICE_CALL,
          80
        )
        gen.startTone(toneId, 150)
        // Release after 200ms so concurrent presses don't pile up
        // resources. ToneGenerator is single-shot per instance.
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
          try { gen.release() } catch (_: Throwable) {}
        }, 220)
      } catch (_: Throwable) {}

      // Forward to CallActivity if it's currently up. Implicit-action
      // broadcast inside our own package + setPackage() makes this safe
      // without the BROADCAST_PACKAGE_REPLACED permission.
      try {
        val intent = android.content.Intent("expo.modules.callkit.PLAY_DTMF").apply {
          setPackage(context.applicationContext.packageName)
          putExtra("digit", ch.toString())
        }
        context.applicationContext.sendBroadcast(intent)
      } catch (_: Throwable) {}
    }
  }
}
