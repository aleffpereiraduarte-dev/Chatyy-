package expo.modules.callkit

// ChatMessagingStyleHandler — renders chat_message + chat_reaction pushes
// using NotificationCompat.MessagingStyle (WhatsApp / Telegram style), with
// inline reply via RemoteInput + smart-reply chips + mute-from-notification.
// Called from CallFirebaseMessagingService before falling back to the Expo
// delegate. If this returns false, the caller forwards to Expo normally.
//
// 2026-05-17 — gap_notifications P0+P1 implementation.

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.graphics.drawable.IconCompat
import com.google.firebase.messaging.RemoteMessage
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONArray
import org.json.JSONObject

object ChatMessagingStyleHandler {

    private const val TAG = "ChatMsgStyleHandler"
    private const val PREFS = "chatyy_chat_threads"
    private const val MAX_MESSAGES_PER_THREAD = 8
    /** [led-color, 2026-05-19] SharedPreferences-backed registry of channel
     *  ids we've already created. NotificationChannel.lightColor is immutable
     *  post-creation, so per-conversation LED requires one channel per color.
     *  We dedupe by channel-id (`chat_conv_led_#10b981`) so repeated pushes
     *  to the same conv don't re-create. */
    private const val LED_CHANNELS_PREFS = "chatyy_chat_led_channels"
    private const val LED_CHANNELS_KEY = "created_channel_ids"

    /** [per-chat-tone, 2026-07-02] Per-conversation custom notification tone
     *  (sound Uri) + vibration pattern + LED, WhatsApp-style. A
     *  NotificationChannel's sound/vibration are IMMUTABLE post-creation, so
     *  each distinct (sound+vibration+led) combo needs its own channel. We:
     *    1. Persist the chosen config per conversation as JSON under
     *       `cfg_<convId>` in `chatyy_chat_tone_channels` prefs. The JS
     *       settings sheet writes this via the ExpoCallKit bridge
     *       (setChatNotificationTone) so the channel is created eagerly when
     *       the user picks a tone — and re-created on change (delete old id +
     *       create new, since channels can't mutate).
     *    2. Derive a deterministic channel id `chat_conv_tone_<convId>_<hash>`
     *       from the config so repeat pushes reuse the same channel and a
     *       config change lands on a fresh channel.
     *    3. Read it back in tryHandle to route the notification to the custom
     *       channel. Any failure at any step falls back to the default "chat"
     *       channel — a broken tone can NEVER drop the notification. */
    private const val TONE_PREFS = "chatyy_chat_tone_channels"
    private const val TONE_CREATED_KEY = "created_tone_channel_ids"
    private fun toneCfgKey(convId: String) = "cfg_$convId"

    // RemoteInput keys + intent actions — kept in lockstep with the JS side
    // (see services/pushNotifications.js, response listener).
    const val KEY_REPLY_TEXT = "key_chat_reply_text"
    const val ACTION_QUICK_REPLY = "com.onemundo.mail.ACTION_CHAT_REPLY"
    const val ACTION_MARK_READ = "com.onemundo.mail.ACTION_CHAT_MARK_READ"
    const val ACTION_MUTE_8H = "com.onemundo.mail.ACTION_CHAT_MUTE_8H"
    const val ACTION_SNOOZE_1H = "com.onemundo.mail.ACTION_CHAT_SNOOZE_1H"
    const val ACTION_SMART_REPLY = "com.onemundo.mail.ACTION_CHAT_SMART_REPLY"
    // Missed-call notification "Ligar de volta" tap → broadcast picked up by
    // ChatActionReceiver, which launches the app deep-linked to /call with
    // the caller's email + initiator=1. JS-side mirror: actionId === 'CALL_BACK'
    // in pushNotifications.js (used by both iOS UNNotificationAction and the
    // Android tap-through path).
    const val ACTION_CALL_BACK = "com.onemundo.mail.ACTION_CALL_BACK"

    /**
     * Try to handle the FCM message as a chat message rendered with
     * MessagingStyle. Returns true if we displayed our own notification (and
     * the caller should NOT forward to Expo), false otherwise.
     */
    fun tryHandle(ctx: Context, message: RemoteMessage): Boolean {
        val data = message.data
        val type = data["type"] ?: return false
        if (type != "chat_message" && type != "chat_mention" && type != "chat_reaction") return false

        // Silent / snoozed pushes: backend sets `_silent: "1"` when user is in
        // global snooze. We still hydrate the thread so the message list is
        // up to date on next open, but skip notification display.
        val isSilent = data["_silent"] == "1"

        try {
            val conversationId = data["conversation_id"] ?: return false
            val senderEmail = data["sender_email"] ?: data["reactor_email"] ?: ""
            val senderName = pickSenderName(data, senderEmail)
            val body = if (type == "chat_reaction") {
                (data["emoji"] ?: "❤️") + " " + (message.notification?.body ?: data["body"] ?: "")
            } else {
                message.notification?.body ?: data["body"] ?: ""
            }
            val avatarUrl = data["sender_avatar"] ?: data["image"] ?: ""
            val isGroup = (data["thread_id"] ?: "").startsWith("chat_") && data.containsKey("group_name")
            val convName = data["group_name"] ?: senderName
            val isKeywordHit = data["keyword_match"] == "1"

            // Avatar bitmap (best-effort, 1s timeout). Falls back to a
            // monochrome circle generated by NotificationCompat when null.
            val avatarBitmap: Bitmap? = if (avatarUrl.isNotEmpty()) downloadBitmap(avatarUrl) else null
            val senderPerson = Person.Builder()
                .setName(senderName)
                .setKey(senderEmail.ifEmpty { senderName })
                .apply { if (avatarBitmap != null) setIcon(IconCompat.createWithBitmap(avatarBitmap)) }
                .build()

            // Persist this message into the thread so subsequent pushes for
            // the same conversation render as a stack (WhatsApp pattern).
            val now = System.currentTimeMillis()
            appendMessageToThread(ctx, conversationId, senderName, body, now)

            // Channel: chat (or chat_keyword if user matched a keyword and
            // wanted a distinct sound). Both are pre-created in JS via
            // expo-notifications setNotificationChannelAsync.
            //
            // [led-color, 2026-05-19] When the push payload carries a
            // `led_color` hex (#RRGGBB), route through a dynamic channel
            // whose lightColor matches. NotificationChannel.lightColor is
            // immutable post-creation, so we have to spawn one channel per
            // distinct color. Keyword channel still wins (sound > LED).
            val ledColor = data["led_color"]?.takeIf { isValidHex(it) }
            // [per-chat-tone] A user-chosen per-conversation tone (custom sound
            // + vibration, optionally + LED) wins over the payload LED channel.
            // Keyword sound still trumps everything (documented behaviour:
            // sound > tone > LED). ensureToneChannel returns null on any
            // failure, so we transparently fall through to the LED/default path.
            val toneChannelId = if (!isKeywordHit) ensureToneChannel(ctx, conversationId) else null
            val channelId = when {
                isKeywordHit -> "chat_keyword"
                toneChannelId != null -> toneChannelId
                ledColor != null -> ensureLedChannel(ctx, ledColor)
                else -> "chat"
            }

            // Build MessagingStyle from the thread cache.
            val mePerson = Person.Builder()
                .setName("Você")
                .setKey("me")
                .build()
            val style = NotificationCompat.MessagingStyle(mePerson)
                .setGroupConversation(isGroup)
            if (isGroup) style.conversationTitle = convName
            for (m in loadThread(ctx, conversationId)) {
                val p = Person.Builder()
                    .setName(m.senderName)
                    .setKey(m.senderName)
                    .apply { if (avatarBitmap != null && m.senderName == senderName) setIcon(IconCompat.createWithBitmap(avatarBitmap)) }
                    .build()
                style.addMessage(m.text, m.timestamp, p)
            }

            val notifId = (conversationId.hashCode() and 0x7FFFFFFF)

            // RemoteInput for inline quick reply (typed message)
            val remoteInput = RemoteInput.Builder(KEY_REPLY_TEXT)
                .setLabel("Mensagem...")
                .build()

            val replyIntent = Intent(ACTION_QUICK_REPLY).apply {
                setPackage(ctx.packageName)
                putExtra("conversation_id", conversationId)
                putExtra("notif_id", notifId)
            }
            val replyPendingIntent = PendingIntent.getBroadcast(
                ctx,
                notifId,
                replyIntent,
                pendingIntentFlags(mutable = true)
            )
            val replyAction = NotificationCompat.Action.Builder(
                android.R.drawable.ic_menu_send,
                "Responder",
                replyPendingIntent
            )
                .addRemoteInput(remoteInput)
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                .setAllowGeneratedReplies(true)
                .build()

            // Mark-as-read action
            val markReadIntent = Intent(ACTION_MARK_READ).apply {
                setPackage(ctx.packageName)
                putExtra("conversation_id", conversationId)
                putExtra("notif_id", notifId)
            }
            val markReadPI = PendingIntent.getBroadcast(
                ctx,
                notifId + 1,
                markReadIntent,
                pendingIntentFlags(mutable = false)
            )
            val markReadAction = NotificationCompat.Action.Builder(
                android.R.drawable.ic_menu_view,
                "Marcar como lido",
                markReadPI
            )
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
                .build()

            // Mute 8h action
            val muteIntent = Intent(ACTION_MUTE_8H).apply {
                setPackage(ctx.packageName)
                putExtra("conversation_id", conversationId)
                putExtra("notif_id", notifId)
            }
            val mutePI = PendingIntent.getBroadcast(
                ctx,
                notifId + 2,
                muteIntent,
                pendingIntentFlags(mutable = false)
            )
            val muteAction = NotificationCompat.Action.Builder(
                android.R.drawable.ic_lock_silent_mode,
                "Silenciar 8h",
                mutePI
            ).build()

            // Snooze 1h action — silent push reroute for an hour
            val snoozeIntent = Intent(ACTION_SNOOZE_1H).apply {
                setPackage(ctx.packageName)
                putExtra("notif_id", notifId)
            }
            val snoozePI = PendingIntent.getBroadcast(
                ctx,
                notifId + 3,
                snoozeIntent,
                pendingIntentFlags(mutable = false)
            )
            val snoozeAction = NotificationCompat.Action.Builder(
                android.R.drawable.ic_menu_recent_history,
                "Soneca 1h",
                snoozePI
            ).build()

            // Tap intent — open the chat conversation
            val openIntent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.apply {
                putExtra("conversation_id", conversationId)
                putExtra("sender_email", senderEmail)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            val openPI = openIntent?.let {
                PendingIntent.getActivity(ctx, notifId + 100, it, pendingIntentFlags(mutable = false))
            }

            val builder = NotificationCompat.Builder(ctx, channelId)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setStyle(style)
                .setShortcutId("chat_$conversationId")
                .setLocusId(androidx.core.content.LocusIdCompat("chat_$conversationId"))
                .setAutoCancel(true)
                .setOnlyAlertOnce(false)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setGroup("chat_$conversationId")
                .setPriority(if (isKeywordHit) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_HIGH)
                .addAction(replyAction)
                .addAction(markReadAction)
                .addAction(muteAction)
                .addAction(snoozeAction)
            if (openPI != null) builder.setContentIntent(openPI)
            if (avatarBitmap != null) builder.setLargeIcon(avatarBitmap)

            // [notif-p0p1] Smart reply chips in the bubble above the keyboard.
            // Wear OS auto-pulls these via the same RemoteInput once a single
            // choice list is attached — no extra wiring needed.
            val smartReplies = parseSmartReplies(data["smart_replies"])
            if (smartReplies.isNotEmpty()) {
                val choices = smartReplies.toTypedArray<CharSequence>()
                val srRemoteInput = RemoteInput.Builder(KEY_REPLY_TEXT)
                    .setLabel("Sugestões")
                    .setChoices(choices)
                    .build()
                // Replace the existing reply action's RemoteInput so the
                // choices appear as one-tap chips. Android merges them with
                // the typed input.
                builder.clearActions()
                val replyWithChoices = NotificationCompat.Action.Builder(
                    android.R.drawable.ic_menu_send,
                    "Responder",
                    replyPendingIntent
                )
                    .addRemoteInput(srRemoteInput)
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                    .setAllowGeneratedReplies(true)
                    .build()
                builder.addAction(replyWithChoices)
                builder.addAction(markReadAction)
                builder.addAction(muteAction)
                builder.addAction(snoozeAction)
            }

            if (isSilent) {
                // Persisted the thread, but don't display. Caller still
                // returns true so we don't double-render via Expo.
                Log.d(TAG, "Silent push (snoozed) — thread updated, no display")
                return true
            }

            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(notifId, builder.build())
            Log.d(TAG, "Posted MessagingStyle notification for conv=$conversationId notifId=$notifId smartReplies=${smartReplies.size}")
            return true
        } catch (t: Throwable) {
            Log.w(TAG, "tryHandle failed — falling back to Expo delegate: ${t.message}", t)
            return false
        }
    }

    private fun pickSenderName(data: Map<String, String>, email: String): String {
        val raw = data["sender_name"]?.takeIf { it.isNotBlank() }
            ?: email.substringBefore('@').takeIf { it.isNotBlank() }
            ?: "Contato"
        // Cap to keep MessagingStyle title clean
        return raw.take(40)
    }

    private fun parseSmartReplies(raw: String?): List<String> {
        if (raw.isNullOrBlank()) return emptyList()
        return try {
            // FCM stringifies arrays — backend ships JSON. Decode here.
            val arr = JSONArray(raw)
            val out = mutableListOf<String>()
            for (i in 0 until arr.length().coerceAtMost(3)) {
                val s = arr.optString(i, "").trim().take(40)
                if (s.isNotEmpty()) out.add(s)
            }
            out
        } catch (t: Throwable) {
            // If backend sent comma-separated, try that fallback
            raw.split(",", "|").map { it.trim().take(40) }.filter { it.isNotEmpty() }.take(3)
        }
    }

    // ---- thread cache (SharedPreferences-backed) -----------------------------

    private data class ThreadMsg(val senderName: String, val text: String, val timestamp: Long)

    private fun appendMessageToThread(ctx: Context, conversationId: String, sender: String, text: String, ts: Long) {
        try {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val key = "thread_$conversationId"
            val existing = sp.getString(key, "") ?: ""
            val arr = if (existing.isEmpty()) JSONArray() else try { JSONArray(existing) } catch (_: Throwable) { JSONArray() }
            arr.put(JSONArray().put(sender).put(text).put(ts))
            // Trim oldest to cap
            val trimmed = if (arr.length() > MAX_MESSAGES_PER_THREAD) {
                val keep = JSONArray()
                val start = arr.length() - MAX_MESSAGES_PER_THREAD
                for (i in start until arr.length()) keep.put(arr.get(i))
                keep
            } else arr
            sp.edit().putString(key, trimmed.toString()).apply()
        } catch (t: Throwable) {
            Log.w(TAG, "appendMessageToThread failed: ${t.message}")
        }
    }

    private fun loadThread(ctx: Context, conversationId: String): List<ThreadMsg> {
        return try {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val raw = sp.getString("thread_$conversationId", "") ?: ""
            if (raw.isEmpty()) return emptyList()
            val arr = JSONArray(raw)
            val out = mutableListOf<ThreadMsg>()
            for (i in 0 until arr.length()) {
                val item = arr.optJSONArray(i) ?: continue
                out.add(ThreadMsg(item.optString(0), item.optString(1), item.optLong(2)))
            }
            out
        } catch (t: Throwable) {
            emptyList()
        }
    }

    /** Public: drop the thread cache when user marks the chat read. */
    fun clearThread(ctx: Context, conversationId: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().remove("thread_$conversationId").apply()
    }

    // ---- bitmap downloader (synchronous, 1s timeout) ------------------------

    private fun downloadBitmap(url: String): Bitmap? {
        return try {
            val parsed = URL(if (url.startsWith("http")) url else "https://chatyy.com.br$url")
            val conn = parsed.openConnection() as HttpURLConnection
            conn.connectTimeout = 1000
            conn.readTimeout = 1500
            conn.doInput = true
            conn.connect()
            val bm = BitmapFactory.decodeStream(conn.inputStream)
            conn.disconnect()
            bm
        } catch (t: Throwable) {
            Log.w(TAG, "downloadBitmap failed for $url: ${t.message}")
            null
        }
    }

    // ---- per-conversation LED channels --------------------------------------
    //
    // NotificationChannel.lightColor is **immutable** after the channel is
    // created (only `name`, `description`, and `lightsEnabled` can mutate
    // post-creation). Per-conversation LED therefore needs one channel per
    // distinct color. We:
    //   1. Build a deterministic id `chat_conv_led_#RRGGBB` so repeat pushes
    //      land on the same channel without re-querying NotificationManager.
    //   2. Persist the set of created ids in SharedPreferences so we don't
    //      pay the NotificationManager round-trip + IPC on every push (the
    //      OS dedupes silently when creating an existing channel, but
    //      avoiding the call is still ~1ms per push and the registry doubles
    //      as a record we can crawl later for cleanup if needed).
    //   3. Fall back to "chat" if hex parsing fails — defensive.

    private fun isValidHex(s: String): Boolean {
        if (s.length != 7) return false
        if (s[0] != '#') return false
        for (i in 1..6) {
            val c = s[i]
            val ok = (c in '0'..'9') || (c in 'a'..'f') || (c in 'A'..'F')
            if (!ok) return false
        }
        return true
    }

    private fun ensureLedChannel(ctx: Context, ledColorHex: String): String {
        val normalized = ledColorHex.lowercase()
        val channelId = "chat_conv_led_$normalized"

        // Pre-O has no channel concept — just return the id; NotificationCompat
        // ignores channels there. lightColor was on the Notification builder
        // pre-O so the value still has effect via setLights().
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return channelId

        val sp = ctx.getSharedPreferences(LED_CHANNELS_PREFS, Context.MODE_PRIVATE)
        val created = sp.getStringSet(LED_CHANNELS_KEY, emptySet()) ?: emptySet()
        if (channelId in created) return channelId

        try {
            val color = try { Color.parseColor(normalized) } catch (_: Throwable) { return "chat" }
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                channelId,
                "Chat ($normalized)",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Mensagens de chat com cor LED personalizada"
                enableLights(true)
                lightColor = color
                enableVibration(true)
                setShowBadge(true)
            }
            nm.createNotificationChannel(channel)
            // Persist the new id. SharedPreferences requires a fresh set for
            // mutation; we build a new HashSet from the existing one.
            val next = HashSet(created)
            next.add(channelId)
            sp.edit().putStringSet(LED_CHANNELS_KEY, next).apply()
            Log.d(TAG, "Created LED channel $channelId color=$normalized")
        } catch (t: Throwable) {
            Log.w(TAG, "ensureLedChannel($normalized) failed: ${t.message}")
            return "chat"
        }
        return channelId
    }

    // ---- per-conversation custom tone + vibration channels ------------------
    //
    // Public API (called from ExpoCallKitModule bridge):
    //   setChatNotificationTone(convId, sound, vibration[], vibrationOff, led)
    //   clearChatNotificationTone(convId)
    //   listNotificationSounds()  → real device notification sounds
    //
    // All entry points are wrapped so a failure is a no-op that leaves the
    // default "chat" channel behavior intact.

    /**
     * Persist + (re)create a per-conversation notification channel carrying a
     * custom sound + vibration + optional LED. Returns the channel id created,
     * or null on any failure (caller should keep using defaults).
     *
     * @param soundRaw  a real content:// / android.resource:// / file:// Uri
     *                  string, or the sentinel "default" / "" (system default
     *                  notification sound) or "silent" (no sound).
     * @param vibration explicit vibration pattern in ms (WhatsApp preset or a
     *                  user-recorded rhythm); empty = channel default vibration.
     * @param vibrationOff true → vibration disabled for this conversation.
     * @param led       "#RRGGBB" LED color or null.
     */
    fun setConversationTone(
        ctx: Context,
        conversationId: String,
        soundRaw: String?,
        vibration: LongArray?,
        vibrationOff: Boolean,
        led: String?,
    ): String? {
        return try {
            if (conversationId.isBlank()) return null
            val sound = (soundRaw ?: "default").trim().ifEmpty { "default" }
            val vib = vibration?.takeIf { it.isNotEmpty() }
            val ledHex = led?.takeIf { isValidHex(it) }
            val channelId = computeToneChannelId(conversationId, sound, vib, vibrationOff, ledHex)

            // If a previous channel for this conversation exists and the config
            // changed, drop it — channels are immutable so a stale one would
            // keep the old sound. Best-effort; ignore if already gone.
            val sp = ctx.getSharedPreferences(TONE_PREFS, Context.MODE_PRIVATE)
            val prev = readToneConfig(ctx, conversationId)
            if (prev != null && prev.channelId != channelId) {
                deleteToneChannel(ctx, prev.channelId)
            }

            // Persist the new config BEFORE creating the channel so a push that
            // races in still finds it (ensureToneChannel will create on demand).
            val json = JSONObject().apply {
                put("sound", sound)
                put("vibOff", vibrationOff)
                if (vib != null) {
                    val arr = JSONArray()
                    for (v in vib) arr.put(v)
                    put("vib", arr)
                }
                if (ledHex != null) put("led", ledHex)
                put("channelId", channelId)
            }
            sp.edit().putString(toneCfgKey(conversationId), json.toString()).apply()

            // Create the channel now (idempotent — createNotificationChannel
            // on an existing id is a no-op on the OS side).
            ensureToneChannel(ctx, conversationId)
        } catch (t: Throwable) {
            Log.w(TAG, "setConversationTone failed: ${t.message}")
            null
        }
    }

    /** Drop the per-conversation tone → future pushes use the default channel. */
    fun clearConversationTone(ctx: Context, conversationId: String) {
        try {
            val prev = readToneConfig(ctx, conversationId)
            if (prev != null) deleteToneChannel(ctx, prev.channelId)
            ctx.getSharedPreferences(TONE_PREFS, Context.MODE_PRIVATE)
                .edit().remove(toneCfgKey(conversationId)).apply()
        } catch (t: Throwable) {
            Log.w(TAG, "clearConversationTone failed: ${t.message}")
        }
    }

    /** Real device notification sounds for the JS tone picker: [{title, uri}]. */
    fun listNotificationSounds(ctx: Context): List<Map<String, String>> {
        val out = ArrayList<Map<String, String>>()
        try {
            out.add(mapOf("title" to "Padrão", "uri" to "default"))
            out.add(mapOf("title" to "Silencioso", "uri" to "silent"))
            val rm = RingtoneManager(ctx)
            rm.setType(RingtoneManager.TYPE_NOTIFICATION)
            val cursor = rm.cursor
            var guard = 0
            while (cursor.moveToNext() && guard < 200) {
                guard++
                val title = cursor.getString(RingtoneManager.TITLE_COLUMN_INDEX) ?: continue
                val uri = rm.getRingtoneUri(cursor.position)?.toString() ?: continue
                out.add(mapOf("title" to title, "uri" to uri))
            }
        } catch (t: Throwable) {
            Log.w(TAG, "listNotificationSounds failed: ${t.message}")
        }
        return out
    }

    private data class ToneConfig(
        val sound: String,
        val vib: LongArray?,
        val vibOff: Boolean,
        val led: String?,
        val channelId: String,
    )

    private fun readToneConfig(ctx: Context, conversationId: String): ToneConfig? {
        return try {
            val sp = ctx.getSharedPreferences(TONE_PREFS, Context.MODE_PRIVATE)
            val raw = sp.getString(toneCfgKey(conversationId), null) ?: return null
            val o = JSONObject(raw)
            val sound = o.optString("sound", "default")
            val vibOff = o.optBoolean("vibOff", false)
            val led = o.optString("led", "").takeIf { it.isNotEmpty() && isValidHex(it) }
            val vibArr = o.optJSONArray("vib")
            val vib = if (vibArr != null && vibArr.length() > 0) {
                LongArray(vibArr.length()) { vibArr.optLong(it) }
            } else null
            val channelId = o.optString("channelId", "")
                .ifEmpty { computeToneChannelId(conversationId, sound, vib, vibOff, led) }
            ToneConfig(sound, vib, vibOff, led, channelId)
        } catch (t: Throwable) {
            null
        }
    }

    private fun computeToneChannelId(
        conversationId: String,
        sound: String,
        vib: LongArray?,
        vibOff: Boolean,
        led: String?,
    ): String {
        val sig = buildString {
            append(sound); append('|')
            append(if (vibOff) "off" else vib?.joinToString(",") ?: "def"); append('|')
            append(led ?: "none")
        }
        val hash = (sig.hashCode() and 0x7FFFFFFF).toString(16)
        // Keep the conv id sanitized so it's a valid channel id fragment.
        val safeConv = conversationId.filter { it.isLetterOrDigit() || it == '_' }.take(40)
        return "chat_conv_tone_${safeConv}_$hash"
    }

    /**
     * Ensure the per-conversation tone channel exists (create-if-missing) and
     * return its id, or null if this conversation has no custom tone / the OS
     * rejected it. Called from both the bridge and the push path so the channel
     * is guaranteed to exist before we post on it.
     */
    private fun ensureToneChannel(ctx: Context, conversationId: String): String? {
        val cfg = readToneConfig(ctx, conversationId) ?: return null
        // Pre-O has no channels; custom per-conv sound isn't applied there and
        // we fall back to the default channel (acceptable — Android 7 and older
        // is a vanishingly small install base). Returning null routes to "chat".
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
        return try {
            val sp = ctx.getSharedPreferences(TONE_PREFS, Context.MODE_PRIVATE)
            val created = sp.getStringSet(TONE_CREATED_KEY, emptySet()) ?: emptySet()
            if (cfg.channelId in created) return cfg.channelId

            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                cfg.channelId,
                "Chat (personalizado)",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Mensagens de chat com som/vibração personalizados"
                setShowBadge(true)
                // Sound
                if (cfg.sound == "silent") {
                    setSound(null, null)
                } else {
                    val uri = resolveSoundUri(ctx, cfg.sound)
                    if (uri != null) {
                        val attrs = AudioAttributes.Builder()
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                            .build()
                        setSound(uri, attrs)
                    }
                }
                // Vibration
                if (cfg.vibOff) {
                    enableVibration(false)
                } else if (cfg.vib != null) {
                    enableVibration(true)
                    vibrationPattern = cfg.vib
                } else {
                    enableVibration(true)
                }
                // LED
                if (cfg.led != null) {
                    try {
                        enableLights(true)
                        lightColor = Color.parseColor(cfg.led)
                    } catch (_: Throwable) {}
                }
            }
            nm.createNotificationChannel(channel)
            val next = HashSet(created)
            next.add(cfg.channelId)
            sp.edit().putStringSet(TONE_CREATED_KEY, next).apply()
            Log.d(TAG, "Created tone channel ${cfg.channelId} for conv=$conversationId")
            cfg.channelId
        } catch (t: Throwable) {
            Log.w(TAG, "ensureToneChannel failed: ${t.message}")
            null
        }
    }

    private fun deleteToneChannel(ctx: Context, channelId: String) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.deleteNotificationChannel(channelId)
            }
            val sp = ctx.getSharedPreferences(TONE_PREFS, Context.MODE_PRIVATE)
            val created = sp.getStringSet(TONE_CREATED_KEY, emptySet()) ?: emptySet()
            if (channelId in created) {
                val next = HashSet(created)
                next.remove(channelId)
                sp.edit().putStringSet(TONE_CREATED_KEY, next).apply()
            }
        } catch (t: Throwable) {
            Log.w(TAG, "deleteToneChannel failed: ${t.message}")
        }
    }

    /**
     * Resolve a sound sentinel/name/uri to a real Uri. "default"/"" → system
     * default notification sound. A real content://, android.resource:// or
     * file:// string is used verbatim. Anything else is treated as a ringtone
     * title and matched against the device's notification sounds; unmatched
     * names fall back to the default sound (never silent by accident).
     */
    private fun resolveSoundUri(ctx: Context, raw: String): Uri? {
        return try {
            if (raw.isEmpty() || raw == "default") {
                RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_NOTIFICATION)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            } else if (raw.startsWith("content://") || raw.startsWith("android.resource://") || raw.startsWith("file://")) {
                Uri.parse(raw)
            } else {
                // Title match against device notification sounds.
                var match: Uri? = null
                try {
                    val rm = RingtoneManager(ctx)
                    rm.setType(RingtoneManager.TYPE_NOTIFICATION)
                    val cursor = rm.cursor
                    var guard = 0
                    while (cursor.moveToNext() && guard < 200) {
                        guard++
                        val title = cursor.getString(RingtoneManager.TITLE_COLUMN_INDEX) ?: continue
                        if (title.equals(raw, ignoreCase = true) || title.contains(raw, ignoreCase = true)) {
                            match = rm.getRingtoneUri(cursor.position)
                            break
                        }
                    }
                } catch (_: Throwable) {}
                match
                    ?: RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_NOTIFICATION)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "resolveSoundUri($raw) failed: ${t.message}")
            null
        }
    }

    private fun pendingIntentFlags(mutable: Boolean): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or (if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE)
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
    }
}
