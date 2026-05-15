package expo.modules.callkit

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Primary FCM message handler with priority=10 (higher than Expo's -1).
 *
 * When the app is killed, Android only delivers FCM messages to ONE service —
 * the one with the highest intent-filter priority. Since our priority (10) is
 * higher than Expo's ExpoFirebaseMessagingService (-1), we receive ALL messages.
 *
 * For incoming_call messages: we start a foreground service that shows the
 * full-screen call notification with ringtone and vibration.
 *
 * For all other messages: we forward them to Expo's notification handler
 * via expo.modules.notifications.service.FirebaseMessagingDelegate, ensuring
 * regular push notifications continue to work.
 */
class CallFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "CallFCMService"
        // Cache the resolved delegate to avoid repeated reflection
        private var cachedDelegate: Any? = null
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val type = data["type"] ?: ""

        Log.d(TAG, "FCM message received: type=$type, dataKeys=${data.keys}")

        if (type == "incoming_call") {
            val callId = data["call_id"] ?: data["room_id"] ?: return
            val callerEmail = data["caller_email"] ?: ""
            // [bug 2026-05-15 #978-2 root-fix] Previously defaulted to literal
            // "Unknown" when the FCM payload lacked caller_name — that string
            // then leaked all the way through IncomingCallActivity → JS and
            // surfaced as "Contato desconhecido". Fall back to the email's
            // local-part instead so the lock-screen UI shows something
            // recognizable even when the backend omits the display name.
            val callerName = data["caller_name"]?.takeIf { it.isNotBlank() }
                ?: callerEmail.substringBefore('@').takeIf { it.isNotBlank() }
                ?: "Chamada"
            val conversationId = data["conversation_id"] ?: ""
            val hasVideo = data["video"] == "1"
            // Avatar URL ships in the FCM payload (backend adds caller_avatar
            // pointing to email.php?action=get_avatar). Without it, native
            // call screen + heads-up render only a "?" initial; with it we
            // download the bitmap async on the activity side.
            val callerAvatar = data["caller_avatar"] ?: ""

            Log.d(TAG, "Incoming call from $callerName ($callerEmail) callId=$callId video=$hasVideo avatar=${callerAvatar.isNotEmpty()}")

            // If the app is foreground, JS Modal (IncomingCallListener) handles
            // the call UI via the WS `call_invite` event. Showing the native
            // IncomingCallActivity on top results in BOTH screens stacking and
            // confusing the user (incidente 2026-05-12).
            //
            // Use ActivityManager to ask the OS — relying only on
            // ExpoCallKitModule.isAppForeground had a race: FCM arrives BEFORE
            // OnActivityEntersForeground fires on cold open, so the flag was
            // still false. Combine both signals + a real ActivityManager
            // check so we catch ALL foreground cases.
            if (ExpoCallKitModule.isAppForeground || isProcessForeground()) {
                Log.d(TAG, "App is foreground — skipping native ring service, JS will handle")
                return
            }

            try {
                val serviceIntent = Intent(applicationContext, CallRingingService::class.java).apply {
                    putExtra("call_id", callId)
                    putExtra("caller_name", callerName)
                    putExtra("caller_email", callerEmail)
                    putExtra("conversation_id", conversationId)
                    putExtra("has_video", hasVideo)
                    putExtra("caller_avatar", callerAvatar)
                }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(serviceIntent)
                } else {
                    startService(serviceIntent)
                }

                Log.d(TAG, "Started CallRingingService for callId=$callId")
            } catch (e: Throwable) {
                // [2026-05-15] Explicit branches for the two failure modes we
                // can actually observe in the wild on Android 12+/14+:
                //   - ForegroundServiceStartNotAllowedException (API 31+):
                //     FCM was delivered as a normal-priority push (no
                //     high-priority budget left, or the message itself was
                //     downgraded), so we can't start a FGS from background.
                //     Direct heads-up notification still works.
                //   - SecurityException: USE_FULL_SCREEN_INTENT was revoked
                //     by the user (Android 14+ runtime grant) — the system
                //     refuses to honor setFullScreenIntent. We still post
                //     the notification; it will surface as heads-up only.
                // Note: we avoid a literal `is ForegroundServiceStartNotAllowedException`
                // pattern because the class doesn't exist on API < 31 and
                // some ART verifiers reject the bytecode at class-load time.
                // Comparing the simple name is the safe portable check.
                val cls = e.javaClass.simpleName
                when {
                    Build.VERSION.SDK_INT >= 31 && cls == "ForegroundServiceStartNotAllowedException" -> {
                        Log.w(TAG, "FGS not allowed (background start blocked), falling back to direct notification", e)
                    }
                    e is SecurityException -> {
                        Log.w(TAG, "SecurityException starting FGS — likely USE_FULL_SCREEN_INTENT denied or FGS type policy", e)
                    }
                    else -> {
                        Log.e(TAG, "Failed to start foreground service, falling back to direct notification", e)
                    }
                }
                CallNotificationService.showIncomingCallNotification(
                    applicationContext,
                    callId,
                    callerName,
                    hasVideo,
                    callerEmail,
                    conversationId,
                    callerAvatar
                )
            }
        } else {
            // Forward non-call messages to Expo's notification handler.
            // We use reflection to call FirebaseMessagingDelegate since we can't
            // directly depend on expo-notifications at compile time.
            // The resolved delegate is cached to avoid repeated reflection.
            try {
                val delegate = cachedDelegate ?: run {
                    val delegateClass = Class.forName(
                        "expo.modules.notifications.service.delegates.FirebaseMessagingDelegate"
                    )
                    // Try the static companion approach first (Expo SDK 51+)
                    try {
                        val companionField = delegateClass.getDeclaredField("Companion")
                        val companion = companionField.get(null)
                        // Verify the method exists before caching
                        companion.javaClass.getDeclaredMethod(
                            "handleMessageReceived",
                            android.content.Context::class.java,
                            RemoteMessage::class.java
                        )
                        cachedDelegate = companion
                        Log.d(TAG, "Cached Expo delegate (static companion)")
                        companion
                    } catch (e: Exception) {
                        // Fallback: try creating an instance with context
                        try {
                            val constructor = delegateClass.getDeclaredConstructor(
                                android.content.Context::class.java
                            )
                            val instance = constructor.newInstance(applicationContext)
                            cachedDelegate = instance
                            Log.d(TAG, "Cached Expo delegate (instance)")
                            instance
                        } catch (e2: Exception) {
                            Log.w(TAG, "Could not resolve Expo delegate, trying ExpoFirebaseMessagingService directly", e2)
                            // Last resort: ExpoFirebaseMessagingService
                            val expoServiceClass = Class.forName(
                                "expo.modules.notifications.service.ExpoFirebaseMessagingService"
                            )
                            val expoService = expoServiceClass.getDeclaredConstructor().newInstance()
                            cachedDelegate = expoService
                            Log.d(TAG, "Cached ExpoFirebaseMessagingService as delegate")
                            expoService
                        }
                    }
                }

                // Invoke the appropriate method on the cached delegate
                try {
                    val handleMethod = delegate.javaClass.getDeclaredMethod(
                        "handleMessageReceived",
                        android.content.Context::class.java,
                        RemoteMessage::class.java
                    )
                    handleMethod.invoke(delegate, applicationContext, message)
                    Log.d(TAG, "Forwarded message to Expo delegate (static)")
                } catch (e: Exception) {
                    try {
                        val onMsgMethod = delegate.javaClass.getDeclaredMethod(
                            "onMessageReceived",
                            RemoteMessage::class.java
                        )
                        onMsgMethod.invoke(delegate, message)
                        Log.d(TAG, "Forwarded message to Expo delegate (instance)")
                    } catch (e2: Exception) {
                        Log.e(TAG, "All delegation attempts failed for non-call FCM message", e2)
                        // Invalidate cache so next attempt retries reflection
                        cachedDelegate = null
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "FirebaseMessagingDelegate class not found", e)
                cachedDelegate = null
            }
        }
    }

    /**
     * Ask the OS whether our process is currently foreground. Used as a
     * race-proof complement to ExpoCallKitModule.isAppForeground (the flag
     * is set by Activity lifecycle, which fires AFTER FCM delivery on cold
     * opens — leaving a tiny window where the flag is still false even
     * though the user has the app open).
     */
    private fun isProcessForeground(): Boolean {
        return try {
            val am = applicationContext.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
                ?: return false
            val procs = am.runningAppProcesses ?: return false
            val myPkg = applicationContext.packageName
            for (p in procs) {
                if (p.processName != myPkg) continue
                // [2026-05-15] Accept IMPORTANCE_VISIBLE (200) as foreground
                // too. Previously we only matched IMPORTANCE_FOREGROUND (100),
                // missing the case where the app is in Recents / behind a
                // system dialog — still interactive enough for the JS Modal
                // (IncomingCallListener) to render the in-app call sheet
                // correctly, so showing the native IncomingCallActivity on
                // top creates the same dual-UI bug we saw 2026-05-12. Lower
                // importance value == higher priority in Android's scale.
                if (p.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE) {
                    return true
                }
            }
            false
        } catch (e: Exception) {
            Log.w(TAG, "isProcessForeground check failed", e)
            false
        }
    }

    override fun onNewToken(token: String) {
        Log.d(TAG, "New FCM token received")
        // Forward to Expo's token handler
        try {
            val delegateClass = Class.forName(
                "expo.modules.notifications.service.delegates.FirebaseMessagingDelegate"
            )
            try {
                val companionField = delegateClass.getDeclaredField("Companion")
                val companion = companionField.get(null)
                val handleMethod = companion.javaClass.getDeclaredMethod(
                    "handleNewToken",
                    android.content.Context::class.java,
                    String::class.java
                )
                handleMethod.invoke(companion, applicationContext, token)
                Log.d(TAG, "Forwarded new token to Expo delegate")
            } catch (e: Exception) {
                try {
                    val constructor = delegateClass.getDeclaredConstructor(
                        android.content.Context::class.java
                    )
                    val delegate = constructor.newInstance(applicationContext)
                    val handleMethod = delegateClass.getDeclaredMethod(
                        "onNewToken",
                        String::class.java
                    )
                    handleMethod.invoke(delegate, token)
                    Log.d(TAG, "Forwarded new token to Expo delegate (instance)")
                } catch (e2: Exception) {
                    Log.e(TAG, "Could not forward new token to Expo", e2)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "FirebaseMessagingDelegate class not found for token forwarding", e)
        }
    }
}
