package expo.modules.callkit

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.os.Build
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import java.util.concurrent.atomic.AtomicReference

/**
 * Foreground service that keeps the process alive while showing an incoming call
 * notification with full-screen intent, ringtone, and vibration.
 *
 * Why a foreground service is needed:
 * 1. When the app is killed and a high-priority FCM data message arrives,
 *    the system briefly starts the process to deliver the message. Without
 *    a foreground service, the process can be killed before the user sees
 *    the notification or the full-screen activity launches.
 * 2. On Android 12+, starting activities from background is restricted.
 *    A foreground service with FOREGROUND_SERVICE_TYPE_PHONE_CALL gets
 *    exemptions for launching full-screen intents.
 * 3. The foreground service notification IS the call notification — we use
 *    the same high-priority notification with full-screen intent that
 *    CallNotificationService builds.
 *
 * Lifecycle:
 * - Started by CallFirebaseMessagingService.onMessageReceived()
 * - Stopped when the user accepts/declines the call (via CallActionReceiver)
 *   or after a 60-second timeout (missed call)
 */
class CallRingingService : Service() {

    companion object {
        private const val TAG = "CallRingingService"
        // [WAVE 161B 2026-05-24] Aligned with iOS kRingTimeoutSeconds=45 and
        // caller-side outgoing 45s. Three independent timers used to drift
        // (iOS 30s, Android 60s, outgoing 45s) producing tardy "missed call"
        // and orphan ring states. Single source: 45s end-to-end.
        private const val RINGING_TIMEOUT_MS = 45_000L

        // Track the currently ringing call so we can stop from outside (thread-safe).
        // Mirrors the last call set as primary — kept for backward compat with
        // ExpoCallKitModule.getDiagnostics().ringingServiceActive (consumer checks
        // != null only). For the actual set of active rings we now use ringingCallIds.
        val currentCallId = AtomicReference<String?>(null)

        // [2026-05-15] Track ALL ringing callIds, not just the most recent.
        // Previously each onStartCommand did `currentCallId.set(callId)`,
        // which wiped the prior call when a 2nd FCM arrived back-to-back.
        // The 2nd call would then proceed but any external code reading
        // currentCallId saw only the latest. Now we keep a Set so the
        // diagnostics + outside-stop helpers can reason about concurrent
        // rings (rare but possible: two devices, two incoming calls).
        val ringingCallIds: MutableSet<String> =
            java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>())
    }

    private var callId: String? = null
    private var callerEmail: String = ""
    private var callerName: String = ""
    private var conversationId: String = ""
    private var callerAvatar: String = ""
    // [#1359 group-answer routing 2026-05-25] Group-call flag + label threaded
    // from the FCM payload so the FSI/accept intents launch IncomingCallActivity
    // with is_group=true → onAccept routes to GroupCallActivity.
    private var isGroup: Boolean = false
    private var groupName: String = ""
    // [STAGE-B 2026-05-20] Vibrator handle. Moved here from
    // IncomingCallActivity so vibration survives the user dismissing the
    // FSI without accepting (which previously killed the activity but
    // left the OS notification ring playing — now we own both as the
    // single FGS that holds the ringtone audio policy).
    private var vibrator: Vibrator? = null
    private val timeoutRunnable = Runnable {
        val cid = callId
        Log.d(TAG, "Ringing timed out for callId=$cid — broadcasting missed event")
        // [A1 gap Android, 2026-05-20] BEFORE stopSelf (which tears down the
        // ringing notification + FGS), post the missed-call notification on
        // its own channel so the user sees "Chamada perdida" in their tray
        // — matching iOS CallKit's `reportEndedCall(reason: unanswered)`
        // post-call surface and WhatsApp's missed-call notification.
        // Stable per-call notification ID inside showMissedCallNotification
        // (XORed with a "MISS" tag bit) so concurrent missed calls don't
        // overwrite each other.
        if (!cid.isNullOrEmpty()) {
            try {
                CallNotificationService.showMissedCallNotification(
                    context = this,
                    callId = cid,
                    callerName = callerName,
                    callerEmail = callerEmail,
                    conversationId = conversationId,
                    callerAvatarUrl = callerAvatar,
                    isVideo = false  // captured at notify time; ringing service
                                     // doesn't keep video flag in state (matches
                                     // hasVideo intent extra but not worth threading)
                )
            } catch (t: Throwable) {
                Log.w(TAG, "showMissedCallNotification failed: ${t.message}")
            }
        }

        // Notify the rest of the system that this call was missed. Without
        // this, the service used to silently stopSelf and the JS layer /
        // call history never recorded the missed call (caller still rings,
        // user sees nothing). Sender is local so any in-process receiver
        // (CallActionReceiver, JS bridge) can react.
        try {
            val missedIntent = Intent("expo.modules.callkit.CALL_MISSED").apply {
                setPackage(packageName)
                putExtra("call_id", cid ?: "")
                putExtra("caller_email", callerEmail)
                putExtra("caller_name", callerName)
                putExtra("conversation_id", conversationId)
                putExtra("reason", "timeout")
            }
            sendBroadcast(missedIntent)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to broadcast CALL_MISSED", e)
        }
        stopSelf()
    }
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val intent = intent ?: run {
            Log.e(TAG, "Null intent received, stopping service")
            stopSelf()
            return START_NOT_STICKY
        }
        val safeCallId = intent.getStringExtra("call_id") ?: run {
            Log.e(TAG, "No call_id provided, stopping service")
            stopSelf()
            return START_NOT_STICKY
        }
        callId = safeCallId
        callerEmail = intent.getStringExtra("caller_email") ?: ""
        // [#978-2] Same email-fallback as CallFirebaseMessagingService so the
        // ringing notification + heads-up overlay never display "Unknown".
        callerName = intent.getStringExtra("caller_name")?.takeIf { it.isNotBlank() }
            ?: callerEmail.substringBefore('@').takeIf { it.isNotBlank() }
            ?: "Chamada"
        conversationId = intent.getStringExtra("conversation_id") ?: ""
        callerAvatar = intent.getStringExtra("caller_avatar") ?: ""
        val hasVideo = intent.getBooleanExtra("has_video", false)
        // [Goal 1 ring-fix 2026-05-25] "Modo silencioso para ligações" — server
        // sets mute_ringtone=1 (forwarded by CallFirebaseMessagingService /
        // displayIncomingCall). Routes the notification through the silent twin
        // channel AND suppresses our authoritative MediaPlayer ringtone below.
        val muteRingtone = intent.getBooleanExtra("mute_ringtone", false)
        isGroup = intent.getBooleanExtra("is_group", false)
        groupName = intent.getStringExtra("group_name") ?: ""

        // [2026-05-15] Add to the Set FIRST (allows concurrent rings to be
        // reasoned about), then use compareAndSet on currentCallId so we
        // only stamp the "primary" reference if it was empty. If another
        // ring is already primary, we still ring (the FGS notification has
        // a unique id == callId.hashCode()), we just don't overwrite the
        // outside-visible pointer.
        ringingCallIds.add(safeCallId)
        currentCallId.compareAndSet(null, safeCallId)

        Log.d(TAG, "Starting ringing for callId=$safeCallId, caller=$callerName, ringing=${ringingCallIds.size}")

        // Create the notification channel (idempotent)
        CallNotificationService.createNotificationChannel(this)

        // Build the call notification (use safeCallId — guaranteed non-null)
        val notification = CallNotificationService.buildIncomingCallNotification(
            this,
            safeCallId,
            callerName,
            callerEmail,
            conversationId,
            hasVideo,
            callerAvatar,
            muteRingtone = muteRingtone,
            isGroup = isGroup,
            groupName = groupName
        )

        // Start as foreground with the call notification.
        // On Android 14+ (API 34), we must specify the foreground service type.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    safeCallId.hashCode(),
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
                )
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    safeCallId.hashCode(),
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
                )
            } else {
                startForeground(safeCallId.hashCode(), notification)
            }
            Log.d(TAG, "Foreground service started successfully")

            // Async fetch + re-emit notification with real avatar Bitmap so the
            // heads-up & full-screen renderiza a foto do caller em vez da
            // inicial colorida. Acontece em background thread; o NotificationId
            // é o mesmo, então o sistema substitui in-place sem flicker.
            if (callerAvatar.isNotEmpty()) {
                Thread {
                    val bmp = CallNotificationService.fetchAvatarBitmap(callerAvatar) ?: return@Thread
                    try {
                        val updated = CallNotificationService.buildIncomingCallNotification(
                            this@CallRingingService,
                            safeCallId, callerName, callerEmail, conversationId,
                            hasVideo, callerAvatar, bmp,
                            muteRingtone = muteRingtone,
                            isGroup = isGroup,
                            groupName = groupName
                        )
                        val nm = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
                        nm.notify("call_notification", safeCallId.hashCode(), updated)
                    } catch (e: Exception) {
                        Log.w(TAG, "Avatar refresh failed: ${e.message}")
                    }
                }.start()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start foreground", e)
            // Even if foreground fails, try to show the notification directly.
            // [Goal 1 ring-fix 2026-05-25] Also start the authoritative ringer
            // here — the FGS failed but the process is alive long enough to play
            // sound (the FCM fallback path also starts it; IncomingRinger.start
            // is idempotent so the duplicate is a no-op).
            CallNotificationService.showIncomingCallNotification(
                this,
                safeCallId,
                callerName,
                hasVideo,
                callerEmail,
                conversationId,
                callerAvatar,
                muteRingtone
            )
            try { IncomingRinger.start(applicationContext, muteRingtone) } catch (_: Throwable) {}
            stopSelf()
            return START_NOT_STICKY
        }

        // [Goal 1 ring-fix 2026-05-25] AUTHORITATIVE looping ringtone. Start it
        // the instant the FGS is up — BEFORE the FCM service hands the call to
        // Telecom (addNewIncomingCall fires AFTER startForegroundService
        // returns). Our MediaPlayer owns the sound on STREAM_RING /
        // USAGE_NOTIFICATION_RINGTONE, so the ring no longer depends on the
        // NotificationChannel sound posting (which goes silent when FSI is
        // denied, the FGS-from-background start is blocked, or the Telecom
        // self-managed Connection grabs/changes voice-call audio focus).
        // Ringer-mode + mute-flag aware inside IncomingRinger. Idempotent.
        try { IncomingRinger.start(applicationContext, muteRingtone) } catch (t: Throwable) {
            Log.w(TAG, "IncomingRinger.start failed: ${t.message}")
        }

        // [STAGE-B 2026-05-20] Vibrate from the FGS, not the Activity.
        // Now that Telecom can launch the FSI on its own schedule (the
        // user may never see IncomingCallActivity if they accept from a
        // BT headset / Auto), the vibration source has to live in the
        // FGS so it starts the instant FCM arrives and stops on Connection
        // .onAnswer / Connection.onReject — independent of the Activity's
        // own lifecycle.
        try {
            vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
                vm.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            }
            val pattern = longArrayOf(0, 1000, 1000)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator?.vibrate(
                    VibrationEffect.createWaveform(pattern, 0),
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .build()
                )
            } else {
                @Suppress("DEPRECATION")
                vibrator?.vibrate(pattern, 0)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "[STAGE-B] vibrator start failed: ${t.message}")
        }

        // Auto-stop after timeout (missed call)
        handler.postDelayed(timeoutRunnable, RINGING_TIMEOUT_MS)

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        // [Goal 1 ring-fix 2026-05-25] Stop + release the authoritative ringtone.
        // onDestroy fires on every teardown path: answer (IncomingCallActivity
        // .onAccept → stopRingingService), decline (CallActionReceiver →
        // stopSelf), stopRingingForCall, and the 45s missed-call timeout. So
        // this single stop() covers answer / decline / destroy / timeout.
        try { IncomingRinger.stop() } catch (_: Throwable) {}
        // [STAGE-B 2026-05-20] Stop vibration alongside FGS teardown.
        try {
            vibrator?.cancel()
            vibrator = null
        } catch (_: Throwable) {}
        // [#1179 cleanup, 2026-05-19] Explicit stopForeground(REMOVE) so the
        // ringing heads-up notification disappears the instant the service is
        // stopped. Without this, on some OEMs a stale "Chamada de X" pill
        // could persist for 2-3s after accept/decline, occasionally racing
        // the system back into showing the full-screen intent again — i.e.
        // the rare "ringing screen reappears after I answered" report.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "stopForeground(REMOVE) failed: ${t.message}")
        }
        // Also cancel by id in case the system delayed FGS tear-down.
        val cid = callId
        if (cid != null) {
            try {
                val nm = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
                nm.cancel(cid.hashCode())
                // CallNotificationService posts with a tag — cancel that too.
                nm.cancel("call_notification", cid.hashCode())
            } catch (t: Throwable) {
                Log.w(TAG, "cancel(callNotif) failed: ${t.message}")
            }
            ringingCallIds.remove(cid)
            // Only clear the "primary" pointer if we were it — otherwise
            // another concurrent ring is still the active primary.
            currentCallId.compareAndSet(cid, null)
        } else {
            currentCallId.set(null)
        }
        Log.d(TAG, "Ringing service destroyed for callId=$cid, remaining=${ringingCallIds.size}")
        super.onDestroy()
    }

    /**
     * Stop ringing for a specific call ID. Called from CallActionReceiver.
     */
    fun stopRingingForCall(stopCallId: String) {
        if (callId == stopCallId) {
            stopSelf()
        }
    }
}
