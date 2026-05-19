package expo.modules.callkit

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * [2026-05-16] CallOngoingService — foreground service that keeps the app
 * process alive while a call is IN PROGRESS (post-accept).
 *
 * Distinct from CallRingingService:
 *   - CallRingingService = incoming RING (channel "incoming_calls",
 *     importance HIGH, sound + vibration, FSI).
 *   - CallOngoingService = active call (channel "chatyy_calls_ongoing",
 *     importance LOW, silent, persistent notification).
 *
 * Why a separate FGS:
 *   1. When the user swipes home during a call, Android can aggressively
 *      kill the app process (especially on Xiaomi/Oppo/Vivo) — without an
 *      ongoing FGS the LiveKit Room WS + ICE die mid-conversation.
 *   2. Android 14+ requires foregroundServiceType="phoneCall" for any
 *      service holding a microphone capture during background. Without
 *      it the OS revokes mic access ~5s after the activity backgrounds.
 *   3. Tapping the persistent notification returns the user to the
 *      CallActivity (singleTop), matching WhatsApp behavior.
 *
 * Lifecycle:
 *   - Started by CallActivity.onCreate after setContentView.
 *   - Stopped by CallActivity.finishCall() BEFORE Room.disconnect so the
 *     notification disappears as soon as the user taps hangup.
 */
class CallOngoingService : Service() {

    companion object {
        private const val TAG = "CallOngoingService"
        const val CHANNEL_ID = "chatyy_calls_ongoing"
        const val NOTIFICATION_ID = 0x0A11C411 // arbitrary, distinct from RINGING

        const val EXTRA_CALL_ID = "call_id"
        const val EXTRA_CALLER_NAME = "caller_name"
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val callId = intent?.getStringExtra(EXTRA_CALL_ID) ?: ""
        val callerName = intent?.getStringExtra(EXTRA_CALLER_NAME)?.takeIf { it.isNotBlank() }
            ?: "Chamada em andamento"

        Log.d(TAG, "onStartCommand callId=$callId caller=$callerName")

        createNotificationChannel(this)
        val notification = buildOngoingNotification(callId, callerName)

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
                )
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            Log.d(TAG, "Foreground service started for in-progress call")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start foreground service", e)
            stopSelf()
            return START_NOT_STICKY
        }

        // START_NOT_STICKY — if killed, don't restart; CallActivity owns
        // the lifecycle and will re-start the service on next onCreate.
        return START_NOT_STICKY
    }

    private fun buildOngoingNotification(callId: String, callerName: String): Notification {
        // Tap → return to CallActivity. singleTop on the manifest means this
        // reuses the existing instance rather than spawning a second one.
        val contentIntent = Intent(this, CallActivity::class.java).apply {
            putExtra(CallActivity.EXTRA_CALL_ID, callId)
            putExtra(CallActivity.EXTRA_CALLER_NAME, callerName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val pi = PendingIntent.getActivity(
            this,
            callId.hashCode(),
            contentIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // [hangup-from-notif, 2026-05-19] "Encerrar" action button — fires
        // ACTION_HANGUP on CallActionReceiver, which broadcasts ACTION_CLOSE
        // to CallActivity, stops this very service, and emits onCallEnded to
        // JS so the WS layer tears down the remote side too. Lets the user
        // hangup without re-opening the full-screen call UI.
        val hangupIntent = Intent(this, CallActionReceiver::class.java).apply {
            action = CallActionReceiver.ACTION_HANGUP
            putExtra("call_id", callId)
        }
        val hangupPI = PendingIntent.getBroadcast(
            this,
            callId.hashCode() + 1,
            hangupIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val smallIconRes = try {
            resources.getIdentifier("ic_notification", "drawable", packageName)
        } catch (_: Exception) { 0 }
        val iconRes = if (smallIconRes != 0) smallIconRes else applicationInfo.icon

        // Try to resolve a call-end drawable. If the project doesn't ship one,
        // fall back to a stock framework icon — the label "Encerrar" still
        // makes the action unambiguous.
        val hangupIconRes = try {
            resources.getIdentifier("ic_call_end", "drawable", packageName)
                .takeIf { it != 0 } ?: android.R.drawable.ic_menu_close_clear_cancel
        } catch (_: Exception) { android.R.drawable.ic_menu_close_clear_cancel }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(iconRes)
            .setContentTitle("Chamada em andamento")
            .setContentText(callerName)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setContentIntent(pi)
            .addAction(hangupIconRes, "Encerrar", hangupPI)
            .build()
    }

    /**
     * [2026-05-16] Create the in-call channel. LOW importance keeps it
     * silent and out of heads-up — distinct from the HIGH-importance
     * "incoming_calls" channel owned by CallNotificationService.
     */
    private fun createNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val name = "Chamadas em andamento"
            val description = "Notificacao persistente enquanto uma chamada esta ativa"
            val importance = NotificationManager.IMPORTANCE_LOW

            val channel = NotificationChannel(CHANNEL_ID, name, importance).apply {
                this.description = description
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            }

            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        // [#1179 cleanup, 2026-05-19] Explicit stopForeground(REMOVE) so the
        // "Chamada em andamento" notification disappears immediately when
        // CallActivity.finishCall stops this service. Without REMOVE, on some
        // OEMs (Xiaomi MIUI 14, OnePlus Oxygen 13, Vivo OriginOS) the
        // notification lingered for 2-5s after the user tapped hangup, which
        // contributed to the "native ainda aberto pós-desligar" complaint —
        // user sees the in-call notification persist as a system pill even
        // though the activity is already gone.
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
        // Belt-and-suspenders: cancel the notification by id directly in case
        // the system delayed the foreground tear-down.
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(NOTIFICATION_ID)
        } catch (t: Throwable) {
            Log.w(TAG, "cancel(NOTIFICATION_ID) failed: ${t.message}")
        }
        Log.d(TAG, "Ongoing service destroyed")
        super.onDestroy()
    }
}
