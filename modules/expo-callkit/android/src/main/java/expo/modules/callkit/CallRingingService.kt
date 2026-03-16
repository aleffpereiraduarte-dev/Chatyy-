package expo.modules.callkit

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
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
        private const val RINGING_TIMEOUT_MS = 60_000L // 60 seconds

        // Track the currently ringing call so we can stop from outside (thread-safe)
        val currentCallId = AtomicReference<String?>(null)
    }

    private var callId: String? = null
    private val timeoutRunnable = Runnable {
        Log.d(TAG, "Ringing timed out for callId=$callId")
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
        callId = intent.getStringExtra("call_id") ?: run {
            Log.e(TAG, "No call_id provided, stopping service")
            stopSelf()
            return START_NOT_STICKY
        }
        val callerName = intent.getStringExtra("caller_name") ?: "Unknown"
        val callerEmail = intent.getStringExtra("caller_email") ?: ""
        val conversationId = intent.getStringExtra("conversation_id") ?: ""
        val hasVideo = intent.getBooleanExtra("has_video", false)

        currentCallId.set(callId)

        Log.d(TAG, "Starting ringing for callId=$callId, caller=$callerName")

        // Create the notification channel (idempotent)
        CallNotificationService.createNotificationChannel(this)

        // Build the call notification
        val notification = CallNotificationService.buildIncomingCallNotification(
            this,
            callId!!,
            callerName,
            callerEmail,
            conversationId,
            hasVideo
        )

        // Start as foreground with the call notification.
        // On Android 14+ (API 34), we must specify the foreground service type.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    callId.hashCode(),
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
                )
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    callId.hashCode(),
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
                )
            } else {
                startForeground(callId.hashCode(), notification)
            }
            Log.d(TAG, "Foreground service started successfully")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start foreground", e)
            // Even if foreground fails, try to show the notification directly
            CallNotificationService.showIncomingCallNotification(
                this,
                callId!!,
                callerName,
                hasVideo,
                callerEmail,
                conversationId
            )
            stopSelf()
            return START_NOT_STICKY
        }

        // Auto-stop after timeout (missed call)
        handler.postDelayed(timeoutRunnable, RINGING_TIMEOUT_MS)

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        currentCallId.set(null)
        Log.d(TAG, "Ringing service destroyed for callId=$callId")
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
