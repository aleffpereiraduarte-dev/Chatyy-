package expo.modules.callkit

// ChatActionReceiver — backs the chat notification action buttons (inline
// reply via RemoteInput, mark-as-read, mute 8h, snooze 1h, swipe-dismiss).
// Posts the action to the backend with the bearer of the account the push was
// addressed to and updates the notification in place, app killed or not.
//
// 2026-05-17 — gap_notifications P0+P1.
// [2026-10-07 recv-native] Fixes:
//   • bearer came from SharedPreferences "RCTAsyncLocalStorage" — that file
//     never exists (AsyncStorage is SQLite), so EVERY inline Reply / Mark as
//     read silently did nothing ("no bearer token available"). Now read from
//     ChatNotifStore (expo_callkit_prefs, written by JS), per account.
//   • goAsync() keeps the process alive for the HTTP round-trip (a plain
//     coroutine after onReceive returned could be killed mid-request).
//   • reply = WhatsApp: shows "Você: …" in the MessagingStyle, sends with a
//     client_message_id (server dedupe on retry), then marks the chat read.
//   • endpoint = email.php?action=… (chat.php called directly returns 200 with
//     an EMPTY body — only email.php routes to the handler).

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.RemoteInput
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.UUID

class ChatActionReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "ChatActionReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        // [native-crash-hardening 2026-05-26] An uncaught exception in
        // onReceive runs on the main thread and crashes the whole process.
        try {
            onReceiveInner(context.applicationContext ?: context, intent)
        } catch (t: Throwable) {
            Log.e(TAG, "onReceive crashed for action=${intent.action}: ${t.message}", t)
        }
    }

    private fun onReceiveInner(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val convId = intent.getStringExtra("conversation_id") ?: ""
        val notifId = intent.getIntExtra("notif_id", -1)
        val meta = if (convId.isNotEmpty()) ChatMessagingStyleHandler.metaFor(context, convId) else null
        val recipient = intent.getStringExtra("recipient_email")?.takeIf { it.isNotEmpty() }
            ?: meta?.optString("recipient", "") ?: ""
        val lastMid = intent.getStringExtra("message_id")?.takeIf { it.isNotEmpty() }
            ?: meta?.optString("last_mid", "") ?: ""
        val lang = meta?.optString("lang", "pt") ?: "pt"
        Log.d(TAG, "received action=$action conv=$convId notifId=$notifId")

        when (action) {
            ChatMessagingStyleHandler.ACTION_QUICK_REPLY -> {
                val text = RemoteInput.getResultsFromIntent(intent)
                    ?.getCharSequence(ChatMessagingStyleHandler.KEY_REPLY_TEXT)
                    ?.toString()
                    ?.trim()
                if (text.isNullOrEmpty() || convId.isEmpty()) {
                    Log.w(TAG, "Empty quick-reply text / conv — ignoring")
                    return
                }
                val bearer = ChatNotifStore.bearerFor(context, recipient)
                if (bearer == null) {
                    // Never post as the wrong account. Keep the notification,
                    // tell the user to open the app (tap = deep link).
                    Log.w(TAG, "no bearer for recipient account — not sending")
                    ChatMessagingStyleHandler.render(context, convId, alert = false,
                        subText = ChatMessagingStyleHandler.openAppToReplyLabel(lang))
                    return
                }
                // Optimistic: the reply shows in the conversation notification
                // immediately (Android guidance for RemoteInput replies — the
                // spinner on the action stops once the notification updates).
                ChatMessagingStyleHandler.appendOwnReply(context, convId, text)
                ChatMessagingStyleHandler.render(context, convId, alert = false, subText = null)
                val cmid = "notif-" + UUID.randomUUID().toString()
                runAsync {
                    var ok = false
                    for (attempt in 0 until 2) {
                        val r = apiPost(context, bearer, "chat_send", mapOf(
                            "conversation_id" to convId,
                            "type" to "text",
                            "content" to text,
                            "client_message_id" to cmid,
                        ))
                        if (r.ok) { ok = true; break }
                        if (r.code in 400..499) break // auth/validation — retry won't help
                    }
                    if (ok) {
                        // Replying = you read the chat (WhatsApp).
                        apiPost(context, bearer, "chat_mark_read", mapOf(
                            "conversation_id" to convId,
                            "message_id" to (lastMid.toLongOrNull() ?: 0L),
                        ))
                    } else {
                        ChatMessagingStyleHandler.render(context, convId, alert = false,
                            subText = ChatMessagingStyleHandler.sendFailedLabel(lang))
                    }
                }
            }

            ChatMessagingStyleHandler.ACTION_MARK_READ -> {
                if (convId.isEmpty()) { cancelNotification(context, notifId); return }
                ChatMessagingStyleHandler.cancelConversation(context, convId)
                val bearer = ChatNotifStore.bearerFor(context, recipient) ?: run {
                    Log.w(TAG, "mark_read: no bearer for recipient account")
                    return
                }
                runAsync {
                    for (attempt in 0 until 2) {
                        val r = apiPost(context, bearer, "chat_mark_read", mapOf(
                            "conversation_id" to convId,
                            "message_id" to (lastMid.toLongOrNull() ?: 0L),
                        ))
                        if (r.ok || r.code in 400..499) break
                    }
                }
            }

            ChatMessagingStyleHandler.ACTION_MUTE_8H -> {
                if (convId.isNotEmpty()) ChatMessagingStyleHandler.cancelConversation(context, convId)
                else cancelNotification(context, notifId)
                val bearer = ChatNotifStore.bearerFor(context, recipient) ?: return
                val muteUntilIso = isoUtc(System.currentTimeMillis() + 8 * 60 * 60 * 1000L)
                runAsync {
                    apiPost(context, bearer, "chat_user_conv_settings_set", mapOf(
                        "conversation_id" to convId,
                        "mute_until" to muteUntilIso,
                    ))
                }
            }

            ChatMessagingStyleHandler.ACTION_SNOOZE_1H -> {
                cancelNotification(context, notifId)
                val bearer = ChatNotifStore.bearerFor(context, recipient) ?: return
                runAsync {
                    apiPost(context, bearer, "chat_user_snooze_set", mapOf("minutes" to 60))
                }
            }

            // Swipe-away: forget the cached thread so the next message starts
            // a fresh stack (the dismissed ones were seen in the shade).
            ChatMessagingStyleHandler.ACTION_DISMISSED -> {
                if (convId.isNotEmpty()) ChatMessagingStyleHandler.clearThread(context, convId)
            }

            // "Ligar de volta" tap on a missed-call notification. Cancels
            // the notification and launches the app deep-linked into
            // /call with the caller's email + initiator=1.
            ChatMessagingStyleHandler.ACTION_CALL_BACK -> {
                cancelNotification(context, notifId)
                val callerEmail = intent.getStringExtra("caller_email") ?: ""
                val callerName = intent.getStringExtra("caller_name") ?: ""
                val isVideo = intent.getBooleanExtra("video", false)
                if (callerEmail.isEmpty()) {
                    Log.w(TAG, "ACTION_CALL_BACK without caller_email — ignoring")
                    return
                }
                try {
                    val openIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        putExtra("deep_link_route", "/call")
                        putExtra("call_back", true)
                        putExtra("caller_email", callerEmail)
                        putExtra("caller_name", callerName)
                        putExtra("video", isVideo)
                        putExtra("initiator", true)
                    }
                    if (openIntent != null) {
                        context.startActivity(openIntent)
                    } else {
                        Log.w(TAG, "ACTION_CALL_BACK: no launch intent for ${context.packageName}")
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "ACTION_CALL_BACK startActivity failed: ${t.message}")
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

    /** Run off the main thread while keeping the receiver alive (goAsync). */
    private fun runAsync(block: () -> Unit) {
        val pending = try { goAsync() } catch (_: Throwable) { null }
        Thread({
            try { block() } catch (t: Throwable) { Log.w(TAG, "background action failed: ${t.message}") }
            finally { try { pending?.finish() } catch (_: Throwable) {} }
        }, "chatyy-notif-action").start()
    }

    // ---- backend POST -------------------------------------------------------

    private data class ApiResult(val ok: Boolean, val code: Int)

    private fun apiPost(ctx: Context, bearer: String, action: String, params: Map<String, Any>): ApiResult {
        var conn: HttpURLConnection? = null
        return try {
            val url = ChatNotifStore.apiBase(ctx) + "/api/email.php?action=" + action
            val body = JSONObject().apply {
                put("action", action)
                for ((k, v) in params) put(k, v)
            }.toString()
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 5000
                readTimeout = 8000
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer $bearer")
            }
            conn.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
            val code = conn.responseCode
            val resp = try {
                (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.use { it.readText() } ?: ""
            } catch (_: Throwable) { "" }
            // email.php answers {"success":true,...}; an empty 200 means the
            // action was not routed — treat as failure.
            val ok = code in 200..299 && try { JSONObject(resp).optBoolean("success", false) } catch (_: Throwable) { false }
            Log.d(TAG, "POST $action → HTTP $code ok=$ok")
            ApiResult(ok, code)
        } catch (t: Throwable) {
            Log.w(TAG, "POST $action failed: ${t.message}")
            ApiResult(false, -1)
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }

    private fun isoUtc(ms: Long): String {
        val sdf = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US)
        sdf.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return sdf.format(java.util.Date(ms))
    }
}
