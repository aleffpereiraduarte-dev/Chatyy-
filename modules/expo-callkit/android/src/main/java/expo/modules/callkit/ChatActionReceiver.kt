package expo.modules.callkit

// ChatActionReceiver — backs the chat notification action buttons (inline
// reply via RemoteInput, mark-as-read, mute 8h, snooze 1h). Posts the
// action back to the backend via the user's stored bearer token (in
// SharedPreferences / App Group equivalent) and updates the notification
// in place so the user sees instant feedback even with the app killed.
//
// 2026-05-17 — gap_notifications P0+P1.

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

class ChatActionReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "ChatActionReceiver"
        private const val BACKEND_BASE = "https://chatyy.com.br/api/email.php"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val convId = intent.getStringExtra("conversation_id") ?: ""
        val notifId = intent.getIntExtra("notif_id", -1)
        Log.d(TAG, "received action=$action conv=$convId notifId=$notifId")

        when (action) {
            ChatMessagingStyleHandler.ACTION_QUICK_REPLY -> {
                val remoteText = RemoteInput.getResultsFromIntent(intent)
                    ?.getCharSequence(ChatMessagingStyleHandler.KEY_REPLY_TEXT)
                    ?.toString()
                    ?.trim()
                if (remoteText.isNullOrEmpty()) {
                    Log.w(TAG, "Empty quick-reply text — ignoring")
                    return
                }
                appendOwnMessageToThread(context, convId, remoteText)
                updateNotificationOptimistically(context, convId, notifId, remoteText)
                sendInBackground(context) {
                    apiPost(context, "chat", mapOf(
                        "action" to "chat_send",
                        "conversation_id" to convId,
                        "type" to "text",
                        "content" to remoteText,
                        "client_action_id" to "notif_quickreply_${System.currentTimeMillis()}",
                    ))
                }
            }

            ChatMessagingStyleHandler.ACTION_MARK_READ -> {
                cancelNotification(context, notifId)
                ChatMessagingStyleHandler.clearThread(context, convId)
                sendInBackground(context) {
                    apiPost(context, "chat", mapOf(
                        "action" to "chat_mark_read",
                        "conversation_id" to convId,
                    ))
                }
            }

            ChatMessagingStyleHandler.ACTION_MUTE_8H -> {
                cancelNotification(context, notifId)
                val nowMs = System.currentTimeMillis()
                val muteUntilIso = isoUtc(nowMs + 8 * 60 * 60 * 1000L)
                sendInBackground(context) {
                    apiPost(context, "chat", mapOf(
                        "action" to "chat_user_conv_settings_set",
                        "conversation_id" to convId,
                        "mute_until" to muteUntilIso,
                    ))
                }
            }

            ChatMessagingStyleHandler.ACTION_SNOOZE_1H -> {
                cancelNotification(context, notifId)
                sendInBackground(context) {
                    apiPost(context, "chat", mapOf(
                        "action" to "chat_user_snooze_set",
                        "minutes" to "60",
                    ))
                }
            }
        }
    }

    private fun cancelNotification(ctx: Context, notifId: Int) {
        if (notifId < 0) return
        try {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(notifId)
        } catch (t: Throwable) {
            Log.w(TAG, "cancelNotification failed: ${t.message}")
        }
    }

    /**
     * Append the user's just-sent reply to the SharedPreferences thread
     * cache (so subsequent pushes still render the full convo) and update
     * the live notification so the user sees their message immediately.
     * Cheaper than waiting for the WS roundtrip + server push echo.
     */
    private fun appendOwnMessageToThread(ctx: Context, convId: String, text: String) {
        try {
            // Reuse the same JSONArray cache structure.
            val sp = ctx.getSharedPreferences("chatyy_chat_threads", Context.MODE_PRIVATE)
            val key = "thread_$convId"
            val existing = sp.getString(key, "") ?: ""
            val arr = if (existing.isEmpty()) org.json.JSONArray() else try { org.json.JSONArray(existing) } catch (_: Throwable) { org.json.JSONArray() }
            arr.put(org.json.JSONArray().put("Você").put(text).put(System.currentTimeMillis()))
            sp.edit().putString(key, arr.toString()).apply()
        } catch (_: Throwable) {}
    }

    private fun updateNotificationOptimistically(ctx: Context, convId: String, notifId: Int, replyText: String) {
        if (notifId < 0) return
        try {
            val me = Person.Builder().setName("Você").setKey("me").build()
            val style = NotificationCompat.MessagingStyle(me)
            style.addMessage(replyText, System.currentTimeMillis(), null as Person?)
            val nb = NotificationCompat.Builder(ctx, "chat")
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setStyle(style)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setGroup("chat_$convId")
            (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(notifId, nb.build())
        } catch (_: Throwable) {}
    }

    // ---- backend POST -------------------------------------------------------

    private fun sendInBackground(ctx: Context, block: () -> Unit) {
        CoroutineScope(Dispatchers.IO).launch {
            try { block() } catch (t: Throwable) { Log.w(TAG, "background send failed: ${t.message}") }
        }
    }

    private fun apiPost(ctx: Context, _routeIgnored: String, params: Map<String, String>) {
        // Auth bearer + user email read from EncryptedSharedPreferences mirror
        // populated by JS on login. Falls back to the App-Group equivalent
        // shared with ShareExtension if main prefs are empty.
        val sp = ctx.getSharedPreferences("RCTAsyncLocalStorage", Context.MODE_PRIVATE)
        val token = sp.getString("auth_token", "")
            ?: ctx.getSharedPreferences("auth", Context.MODE_PRIVATE).getString("token", "")
            ?: ""
        if (token.isEmpty()) {
            Log.w(TAG, "no bearer token available — skipping API call")
            return
        }

        val body = JSONObject(params as Map<*, *>).toString()
        val conn = (URL(BACKEND_BASE).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 5000
            readTimeout = 5000
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Authorization", "Bearer $token")
        }
        try {
            conn.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
            val code = conn.responseCode
            Log.d(TAG, "POST ${params["action"]} → HTTP $code")
        } finally {
            conn.disconnect()
        }
    }

    private fun isoUtc(ms: Long): String {
        val sdf = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US)
        sdf.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return sdf.format(java.util.Date(ms))
    }
}
