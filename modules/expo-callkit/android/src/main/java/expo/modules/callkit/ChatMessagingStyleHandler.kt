package expo.modules.callkit

// ChatMessagingStyleHandler — renders chat pushes natively with
// NotificationCompat.MessagingStyle (WhatsApp pattern): one notification per
// conversation, sender Person + avatar, conversation shortcut (Android 11+
// "Conversas" section), inline Reply that sends in background, Mark as read,
// Mute 8h, grouped summary "N mensagens de M conversas".
//
// Called from CallFirebaseMessagingService BEFORE the Expo delegate. Returns
// false → caller forwards to Expo (expo-notifications renders + JS handles).
//
// 2026-05-17 — gap_notifications P0+P1 implementation.
// [2026-10-07 recv-native] Rewrite of the render path:
//   • Expo-routed payloads (CHAT_PUSH_ANDROID_PREFER_EXPO — the PROD route:
//     our data nested as JSON in data["body"]) are now handled too. Before,
//     tryHandle only matched a top-level data["type"], so EVERY prod chat push
//     fell through to expo-notifications (plain banner, no avatar, no shortcut).
//   • App visible → return false (JS owns foreground UX: in-app toast, open-chat
//     suppression); open chat == this conversation → swallowed natively.
//   • Channels chat_dm / chat_group / chat_mention / chat_keyword / chat_reaction
//     are ensured natively before posting (was hard-coded "chat" → group rang
//     like a DM, and a missing channel = notification silently dropped).
//   • Tap = deep link onemundomail://chat-conversation?id=… (was the bare launch
//     intent → app opened on the home tab).
//   • Person avatars from a small on-disk cache + long-lived dynamic shortcut
//     per conversation (ShortcutManagerCompat.pushDynamicShortcut + LocusId).
//   • Thread cache dedupes by message_id and keeps the user's own replies as
//     MessagingStyle "self" messages (person = null).

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.RectF
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.FileProvider
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import com.google.firebase.messaging.RemoteMessage
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
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
     *       channel. Any failure at any step falls back to the default
     *       channel — a broken tone can NEVER drop the notification. */
    private const val TONE_PREFS = "chatyy_chat_tone_channels"
    private const val TONE_CREATED_KEY = "created_tone_channel_ids"
    private fun toneCfgKey(convId: String) = "cfg_$convId"

    // RemoteInput keys + intent actions (ChatActionReceiver + manifest).
    const val KEY_REPLY_TEXT = "key_chat_reply_text"
    const val ACTION_QUICK_REPLY = "com.onemundo.mail.ACTION_CHAT_REPLY"
    const val ACTION_MARK_READ = "com.onemundo.mail.ACTION_CHAT_MARK_READ"
    const val ACTION_MUTE_8H = "com.onemundo.mail.ACTION_CHAT_MUTE_8H"
    const val ACTION_SNOOZE_1H = "com.onemundo.mail.ACTION_CHAT_SNOOZE_1H"
    const val ACTION_SMART_REPLY = "com.onemundo.mail.ACTION_CHAT_SMART_REPLY"
    /** [2026-10-07 recv-native] Swipe-away → forget the cached thread. */
    const val ACTION_DISMISSED = "com.onemundo.mail.ACTION_CHAT_DISMISSED"
    // Missed-call notification "Ligar de volta" tap → broadcast picked up by
    // ChatActionReceiver, which launches the app deep-linked to /call with
    // the caller's email + initiator=1. JS-side mirror: actionId === 'CALL_BACK'
    // in pushNotifications.js (used by both iOS UNNotificationAction and the
    // Android tap-through path).
    const val ACTION_CALL_BACK = "com.onemundo.mail.ACTION_CALL_BACK"

    /** All chat notifications share ONE group so Android stacks them under a
     *  single summary ("N mensagens de M conversas") — WhatsApp layout. */
    private const val CHAT_GROUP_KEY = "com.onemundo.mail.CHATS"
    private const val SUMMARY_ID = 0x43484154 // "CHAT"
    private const val EXTRA_CONV_ID = "chatyy_conv_id"
    private const val EXTRA_MSG_COUNT = "chatyy_msg_count"
    private const val APP_SCHEME = "onemundomail"
    private const val API_HOST = "https://chatyy.com.br"

    private val CHAT_TYPES = setOf("chat_message", "chat_mention", "chat_keyword", "chat_reaction")

    /** [2026-10-12 push-parity] Silent data push from the server (no title):
     *  kind=read (up_to = last read id — read on ANOTHER device / the web),
     *  kind=deleted (message_id deleted for everyone), kind=edited (message_id +
     *  msg_preview). Always consumed natively (also in foreground): it only
     *  updates or removes the conversation's MessagingStyle notification. */
    const val CLEAR_TYPE = "chat_notif_clear"

    @Volatile private var baseChannelsEnsured = false

    fun notifIdFor(conversationId: String): Int = (conversationId.hashCode() and 0x7FFFFFFF)

    // =========================================================================
    // Entry points
    // =========================================================================

    /**
     * Try to handle the FCM message as a chat message rendered with
     * MessagingStyle. Returns true if we displayed (or deliberately swallowed)
     * the notification — the caller must NOT forward to Expo — false otherwise.
     */
    fun tryHandle(ctx: Context, message: RemoteMessage): Boolean {
        val data = try { normalize(message) } catch (t: Throwable) { null } ?: return false
        return try {
            tryHandleData(ctx, data)
        } catch (t: Throwable) {
            Log.w(TAG, "tryHandle failed — falling back to Expo delegate: ${t.message}", t)
            false
        }
    }

    /** True when this FCM frame is (possibly) a chat push we can render. */
    fun looksLikeChatPush(data: Map<String, String>): Boolean {
        val t = data["type"]
        if (!t.isNullOrEmpty()) return t in CHAT_TYPES || t == CLEAR_TYPE
        val b = data["body"] ?: return false
        return b.trimStart().startsWith("{") && b.contains("conversation_id")
    }

    /**
     * Flatten the two wire shapes into one map:
     *  - FCM-direct: our data at top level (+ optional notification block).
     *  - Expo-routed: our data as a JSON string in data["body"], title in
     *    data["title"], display text in data["message"].
     * Internal keys: __title, __text, __route.
     */
    private fun normalize(message: RemoteMessage): Map<String, String>? {
        val raw = message.data
        val out = HashMap<String, String>()
        val nested = raw["body"]
        if (raw["type"].isNullOrEmpty() && nested != null && nested.trimStart().startsWith("{")) {
            val j = try { JSONObject(nested) } catch (_: Throwable) { null } ?: return null
            val it = j.keys()
            while (it.hasNext()) {
                val k = it.next()
                val v = j.opt(k)
                if (v != null && v != JSONObject.NULL) out[k] = v.toString()
            }
            raw["title"]?.let { out["__title"] = it }
            raw["message"]?.let { out["__text"] = it }
            out["__route"] = "expo"
        } else {
            out.putAll(raw)
            message.notification?.title?.let { out["__title"] = it }
            (message.notification?.body ?: raw["body"])?.let { out["__text"] = it }
            out["__route"] = "fcm"
        }
        val type = out["type"] ?: return null
        if (type !in CHAT_TYPES && type != CLEAR_TYPE) return null
        if (out["conversation_id"].isNullOrBlank()) return null
        return out
    }

    private fun tryHandleData(ctx: Context, d: Map<String, String>): Boolean {
        val type = d["type"] ?: return false
        val conversationId = d["conversation_id"] ?: return false

        // [2026-10-12 push-parity] Read elsewhere / deleted / edited → update or
        // remove this conversation's notification. Before any foreground gate:
        // the shade must match on every device, app open or not.
        if (type == CLEAR_TYPE) {
            try { handleClear(ctx, conversationId, d) } catch (t: Throwable) { Log.w(TAG, "handleClear failed: ${t.message}") }
            return true
        }

        // [2026-10-09 notif-native] A chat BUBBLE (ChatBubbleActivity) is our
        // process in the foreground but it is not the RN app: its own chat →
        // swallow (it polls); another chat → render natively as usual.
        val bubbleConv = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ChatBubbleActivity.resumedConv else null
        if (bubbleConv != null && bubbleConv == conversationId) {
            Log.d(TAG, "conv=$conversationId is open in its bubble — no notification")
            return true
        }
        // Foreground: the JS layer owns the UX (in-app toast + open-chat gate).
        // The open conversation renders the bubble itself → swallow natively.
        if (bubbleConv == null && ChatNotifStore.isAppVisibleToUser(ctx)) {
            if (ChatNotifStore.activeConversation(ctx) == conversationId) {
                Log.d(TAG, "conv=$conversationId is open on screen — no notification")
                return true
            }
            return false
        }

        val isSilent = d["_silent"] == "1"
        val locked = d["locked"] == "1"
        val lang = (d["lang"] ?: "pt").lowercase()
        val isGroup = d["is_group"] == "1" || d["is_group"] == "true" ||
            d["conversation_type"] == "group" || d.containsKey("group_name")
        val senderEmail = d["sender_email"] ?: d["reactor_email"] ?: ""
        val senderName = if (locked) "Chatyy" else pickSenderName(d, senderEmail)
        val convName = when {
            locked -> "Chatyy"
            isGroup -> (d["group_name"] ?: d["conversation_name"] ?: d["__title"] ?: senderName).take(60)
            else -> senderName
        }
        // [2026-10-12] A reaction's message_id is the REACTED message → two
        // reactions to it were deduped as one push. Key them per reactor+emoji.
        val messageId = if (type == "chat_reaction")
            "rx:" + (d["message_id"] ?: "") + ":" + senderEmail + ":" + (d["emoji"] ?: "")
        else d["message_id"] ?: ""

        // [e2ee5 WP-10 2026-10-21] Conversa E2EE (e2e=5): decifra a prévia no aparelho
        // (ChatPushE2EE, núcleo chatyy-crypto, falha fechado → genérico do servidor). Só na 1ª
        // entrega (redelivery já está no cache). O texto real fica SÓ em memória (e2ePlain).
        val isE2E = d["e2e"] == "5"
        val e2eText: String? = if (isE2E && !locked && !threadHasMid(ctx, conversationId, messageId)) {
            val uid = try { ChatPushE2EE.candidateUid(ctx, d) } catch (_: Throwable) { null }
            if (uid != null) try { ChatPushE2EE.preview(ctx, uid, d, lang) } catch (_: Throwable) { null } else null
        } else null

        // Text without the sender prefix (MessagingStyle shows the Person) and
        // without the Expo-route "N mensagens não lidas" 2nd line.
        var text = e2eText ?: d["msg_preview"]?.takeIf { it.isNotBlank() } ?: run {
            var t = d["__text"] ?: d["body"] ?: ""
            if (d["__route"] == "expo" && (d["unread_count"]?.toIntOrNull() ?: 0) >= 2 && t.contains('\n')) {
                t = t.substringBeforeLast('\n')
            }
            if (isGroup && t.startsWith("$senderName: ")) t = t.removePrefix("$senderName: ")
            t
        }
        // [2026-10-12] The server body already says "reagiu ❤️ …" — only prefix
        // the emoji for older payloads that don't carry it in the text.
        if (type == "chat_reaction" && !isE2E) {
            val e = d["emoji"] ?: ""
            if (e.isNotEmpty() && !text.contains(e)) text = "$e $text"
        }
        if (text.isBlank()) text = newMessageLabel(lang)

        // [2026-10-18 push-thumb] Real media (image_is_avatar=0: photo / gif /
        // video poster, chat.php sendPush) → inline thumbnail on the message
        // (MessagingStyle.Message.setData), WhatsApp style. Never for locked
        // chats / hidden previews; any failure → plain text, as before.
        // Skipped for FCM/Expo redeliveries (already-cached message_id).
        val mediaUrl = d["image"]?.trim().orEmpty()
        val imgPath = if (!locked && d["image_is_avatar"] == "0" && mediaUrl.isNotEmpty() &&
            d["preview_when"] != "never" && type != "chat_reaction" &&
            !threadHasMid(ctx, conversationId, messageId))
            ChatPushImageCache.fetch(ctx, mediaUrl) ?: "" else ""

        // Persist (dedupe by message_id — FCM/Expo can redeliver).
        // [e2ee5 WP-10] linha E2EE decifrada: no disco só o genérico (+ marca e2e); o texto real
        // vai para o mapa em memória ANTES de gravar (o render relê o cache).
        val e2eRow = e2eText != null && messageId.isNotEmpty()
        if (e2eRow) e2ePut(conversationId, messageId, text.take(1000))
        val isNew = appendMessageToThread(
            ctx, conversationId,
            ThreadMsg(senderEmail.ifEmpty { senderName }, senderName, text.take(1000), System.currentTimeMillis(), messageId, imgPath,
                e2e = e2eRow, stored = if (e2eRow) newMessageLabel(lang) else "")
        )
        if (!isNew) {
            Log.d(TAG, "duplicate push conv=$conversationId mid=$messageId — skip")
            return true
        }

        // Avatars (best-effort, cached on disk). Warm the cache now so render()
        // — also used by ChatActionReceiver with no network — finds them.
        val senderAvatarUrl = if (locked) "" else (d["sender_avatar"]?.takeIf { it.isNotBlank() }
            ?: (if (d["image_is_avatar"] == "1") d["image"] else null)
            ?: avatarUrlForEmail(senderEmail))
        val groupAvatarUrl = if (locked || !isGroup) "" else (d["group_avatar"] ?: "")
        if (senderAvatarUrl.isNotEmpty()) ChatAvatarCache.get(ctx, senderAvatarUrl, fetch = true)
        if (groupAvatarUrl.isNotEmpty()) ChatAvatarCache.get(ctx, groupAvatarUrl, fetch = true)

        val isKeywordHit = type == "chat_keyword" || d["keyword_match"] == "1"
        val baseChannel = when {
            isKeywordHit -> "chat_keyword"
            type == "chat_mention" -> "chat_mention"
            type == "chat_reaction" -> "chat_reaction"
            isGroup -> "chat_group"
            else -> "chat_dm"
        }
        ensureBaseChannels(ctx)
        // [per-chat-tone] user-chosen per-conversation tone wins over the base
        // channel; keyword still trumps everything. LED-only channels are HIGH
        // importance with sound, so they are applied to DMs only (groups stay
        // in the quiet bucket unless the user picked a tone for that group).
        val ledColor = d["led_color"]?.takeIf { isValidHex(it) }
        val toneChannelId = if (!isKeywordHit) ensureToneChannel(ctx, conversationId, isGroup) else null
        val channelId = when {
            isKeywordHit -> "chat_keyword"
            toneChannelId != null -> toneChannelId
            ledColor != null && !isGroup && baseChannel == "chat_dm" -> ensureLedChannel(ctx, ledColor)
            else -> baseChannel
        }

        val meta = JSONObject().apply {
            put("name", convName)
            put("group", isGroup)
            put("locked", locked)
            put("lang", lang)
            put("channel", channelId)
            put("recipient", d["recipient_email"] ?: "")
            put("sender_email", senderEmail)
            put("sender_name", senderName)
            put("sender_avatar", senderAvatarUrl)
            put("group_avatar", groupAvatarUrl)
            put("last_mid", messageId)
            put("unread", d["unread_count"] ?: "")
            put("smart", d["smart_replies"] ?: "")
            put("lock_vis", d["lockscreen_visibility"] ?: "")
            put("hide_preview", d["preview_when"] == "never")
        }
        saveMeta(ctx, conversationId, meta)

        if (isSilent) {
            Log.d(TAG, "Silent push (snoozed) — thread updated, no display")
            return true
        }
        return render(ctx, conversationId, alert = true, subText = null)
    }

    /**
     * (Re)build and post the conversation notification from the thread cache
     * + saved meta. alert=false → setOnlyAlertOnce (used after an inline reply
     * so the update doesn't buzz again). No network here.
     */
    fun render(ctx: Context, conversationId: String, alert: Boolean, subText: String?): Boolean {
        val meta = loadMeta(ctx, conversationId) ?: return false
        val thread = loadThread(ctx, conversationId)
        if (thread.isEmpty()) return false
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val notifId = notifIdFor(conversationId)

        val lang = meta.optString("lang", "pt")
        val isGroup = meta.optBoolean("group", false)
        val locked = meta.optBoolean("locked", false)
        val convName = meta.optString("name", "Chatyy")
        val senderEmail = meta.optString("sender_email", "")
        val senderName = meta.optString("sender_name", convName)
        val recipient = meta.optString("recipient", "")
        val channelId = meta.optString("channel", if (isGroup) "chat_group" else "chat_dm")
        val lastMid = meta.optString("last_mid", "")

        val senderBmp = ChatAvatarCache.get(ctx, meta.optString("sender_avatar", ""), fetch = false)
        val groupBmp = if (isGroup) (ChatAvatarCache.get(ctx, meta.optString("group_avatar", ""), fetch = false)
            ?: ChatAvatarCache.letterAvatar(convName)) else null

        val senderPerson = Person.Builder()
            .setName(senderName)
            .setKey(senderEmail.ifEmpty { senderName })
            .setImportant(!isGroup)
            .apply { if (senderBmp != null) setIcon(IconCompat.createWithBitmap(senderBmp)) }
            .build()

        val me = Person.Builder().setName(meLabel(lang)).setKey("me").build()
        val style = NotificationCompat.MessagingStyle(me).setGroupConversation(isGroup)
        if (isGroup) style.conversationTitle = convName
        var otherCount = 0
        // [2026-10-18 push-thumb] Only the newest message carries its picture
        // (older ones stay text: the shade shows one inline image, like WhatsApp).
        val imageUri = if (locked || meta.optBoolean("hide_preview", false)) null
            else thread.last().takeIf { it.key != "me" }?.img?.let { ChatPushImageCache.contentUri(ctx, it) }
        for ((idx, m) in thread.withIndex()) {
            if (m.key == "me") {
                style.addMessage(m.text, m.timestamp, null as Person?)
                continue
            }
            otherCount++
            val bmp = if (m.key == senderPerson.key) senderBmp
                else if (!locked && m.key.contains('@')) ChatAvatarCache.get(ctx, avatarUrlForEmail(m.key), fetch = false)
                else null
            val p = Person.Builder()
                .setName(m.senderName)
                .setKey(m.key.ifEmpty { m.senderName })
                .apply { if (bmp != null) setIcon(IconCompat.createWithBitmap(bmp)) }
                .build()
            val msg = NotificationCompat.MessagingStyle.Message(m.text, m.timestamp, p)
            if (imageUri != null && idx == thread.lastIndex) {
                try { msg.setData("image/jpeg", imageUri) } catch (_: Throwable) {}
            }
            style.addMessage(msg)
        }

        // Tap → deep link straight into the conversation.
        val deepLink = conversationUri(conversationId, isGroup, if (locked) "" else convName,
            if (isGroup || locked) "" else senderEmail, recipient)
        val openIntent = Intent(Intent.ACTION_VIEW, deepLink).apply {
            setPackage(ctx.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra("conversation_id", conversationId)
            putExtra("sender_email", senderEmail)
        }
        val openPI = PendingIntent.getActivity(ctx, notifId + 100, openIntent, pendingIntentFlags(mutable = false))

        // Conversation shortcut (Android 11+ "Conversas" section, priority
        // conversations, bubbles eligibility). Locked chats never get one.
        val shortcutId = if (locked) null else pushConversationShortcut(
            ctx, conversationId, convName, if (isGroup) emptyList() else listOf(senderPerson),
            if (isGroup) groupBmp else senderBmp, deepLink
        )

        // Actions — Reply (inline, background send), Mark as read, Mute 8h.
        val smartReplies = parseSmartReplies(meta.optString("smart", ""))
        val remoteInput = RemoteInput.Builder(KEY_REPLY_TEXT)
            .setLabel(replyPlaceholder(lang))
            .apply { if (smartReplies.isNotEmpty()) setChoices(smartReplies.toTypedArray<CharSequence>()) }
            .build()
        val replyPI = PendingIntent.getBroadcast(ctx, notifId, actionIntent(ctx, ACTION_QUICK_REPLY, conversationId, notifId, recipient, lastMid),
            pendingIntentFlags(mutable = true))
        val replyAction = NotificationCompat.Action.Builder(android.R.drawable.ic_menu_send, replyLabel(lang), replyPI)
            .addRemoteInput(remoteInput)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .setAllowGeneratedReplies(true)
            .build()
        val markReadPI = PendingIntent.getBroadcast(ctx, notifId + 1, actionIntent(ctx, ACTION_MARK_READ, conversationId, notifId, recipient, lastMid),
            pendingIntentFlags(mutable = false))
        val markReadAction = NotificationCompat.Action.Builder(android.R.drawable.ic_menu_view, markReadLabel(lang), markReadPI)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build()
        val mutePI = PendingIntent.getBroadcast(ctx, notifId + 2, actionIntent(ctx, ACTION_MUTE_8H, conversationId, notifId, recipient, lastMid),
            pendingIntentFlags(mutable = false))
        val muteAction = NotificationCompat.Action.Builder(android.R.drawable.ic_lock_silent_mode, muteLabel(lang), mutePI)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MUTE)
            .setShowsUserInterface(false)
            .build()
        val dismissPI = PendingIntent.getBroadcast(ctx, notifId + 3, actionIntent(ctx, ACTION_DISMISSED, conversationId, notifId, recipient, lastMid),
            pendingIntentFlags(mutable = false))

        val extras = Bundle().apply {
            putString(EXTRA_CONV_ID, conversationId)
            putInt(EXTRA_MSG_COUNT, otherCount)
        }
        val builder = NotificationCompat.Builder(ctx, channelId)
            .setSmallIcon(smallIcon(ctx))
            .setStyle(style)
            .setContentTitle(convName)
            .setContentText(thread.last().text)
            .setContentIntent(openPI)
            .setDeleteIntent(dismissPI)
            .setAutoCancel(true)
            .setOnlyAlertOnce(!alert)
            .setShowWhen(true)
            .setWhen(thread.last().timestamp)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setGroup(CHAT_GROUP_KEY)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setPriority(if (channelId == "chat_keyword") NotificationCompat.PRIORITY_MAX
                else if (isGroup) NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_HIGH)
            .addExtras(extras)
            .addAction(replyAction)
            .addAction(markReadAction)
            .addAction(muteAction)
        if (shortcutId != null) {
            builder.setShortcutId(shortcutId)
            builder.setLocusId(LocusIdCompat(shortcutId))
        }
        (if (isGroup) groupBmp else senderBmp)?.let { builder.setLargeIcon(it) }
        // [2026-10-09 notif-native] Bubbles (Android 11+): a conversation
        // notification (MessagingStyle + long-lived shortcut + Person) can float
        // as a chat head when the user allows bubbles for Chatyy / this chat.
        // Expanded view = ChatBubbleActivity (native mini-chat). Never for
        // locked chats or hidden previews.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && shortcutId != null && !locked &&
            !meta.optBoolean("hide_preview", false)) {
            try {
                val bubbleIntent = Intent(ctx, ChatBubbleActivity::class.java).apply {
                    action = Intent.ACTION_VIEW
                    data = Uri.parse("chatyy-bubble://conversation/" + Uri.encode(conversationId))
                    putExtra(ChatBubbleActivity.EXTRA_CONV_ID, conversationId)
                }
                val bubblePI = PendingIntent.getActivity(ctx, notifId + 4, bubbleIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                val bmp = if (isGroup) groupBmp else senderBmp
                val icon = if (bmp != null) IconCompat.createWithAdaptiveBitmap(ChatAvatarCache.adaptive(bmp))
                    else IconCompat.createWithResource(ctx, smallIcon(ctx))
                builder.setBubbleMetadata(
                    NotificationCompat.BubbleMetadata.Builder(bubblePI, icon)
                        .setDesiredHeight(600)
                        .setAutoExpandBubble(false)
                        .setSuppressNotification(false)
                        .build()
                )
            } catch (t: Throwable) {
                Log.w(TAG, "bubble metadata failed: ${t.message}")
            }
        }
        meta.optString("unread", "").toIntOrNull()?.takeIf { it > 0 }?.let { builder.setNumber(it) }
        if (!subText.isNullOrEmpty()) builder.setSubText(subText)

        // Lock-screen privacy (profile setting / preview "never" / locked chat).
        val lockVis = meta.optString("lock_vis", "")
        val hide = locked || meta.optBoolean("hide_preview", false) || lockVis == "private" || lockVis == "hide_content"
        when {
            lockVis == "secret" || lockVis == "hidden" || lockVis == "none" ->
                builder.setVisibility(NotificationCompat.VISIBILITY_SECRET)
            hide -> {
                builder.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                builder.setPublicVersion(
                    NotificationCompat.Builder(ctx, channelId)
                        .setSmallIcon(smallIcon(ctx))
                        .setContentTitle("Chatyy")
                        .setContentText(newMessageLabel(lang))
                        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                        .build()
                )
            }
        }

        nm.notify(notifId, builder.build())
        postSummary(ctx, lang, channelId)
        Log.d(TAG, "Posted MessagingStyle conv=$conversationId notifId=$notifId ch=$channelId msgs=${thread.size} shortcut=${shortcutId != null}")
        return true
    }

    /**
     * [2026-10-12 push-parity] Server-driven update of a posted conversation:
     *  read    → drop incoming messages with id <= up_to (all when up_to absent);
     *  deleted → drop message_id;   edited → replace its text with msg_preview.
     * No incoming message left → cancel. Otherwise re-post silently, and only if
     * the notification is still in the shade (a swiped one stays gone).
     */
    private fun handleClear(ctx: Context, conversationId: String, d: Map<String, String>) {
        val kind = d["kind"] ?: "read"
        val mid = d["message_id"] ?: ""
        val upTo = d["up_to"]?.toLongOrNull() ?: 0L
        val thread = loadThread(ctx, conversationId)
        if (thread.isEmpty()) {
            if (kind == "read") cancelConversation(ctx, conversationId)
            return
        }
        val next: List<ThreadMsg> = when (kind) {
            "read" -> if (upTo <= 0L) emptyList() else thread.filter { m ->
                if (m.key == "me") true else {
                    // reactions ("rx:…") and legacy rows without an id go too
                    val id = m.mid.toLongOrNull()
                    id != null && id > upTo
                }
            }
            "deleted" -> if (mid.isEmpty()) thread else thread.filter { it.mid != mid }
            "edited" -> {
                val meta = loadMeta(ctx, conversationId)
                val hidden = meta == null || meta.optBoolean("locked", false) || meta.optBoolean("hide_preview", false)
                val txt = d["msg_preview"]?.trim().orEmpty()
                if (mid.isEmpty() || txt.isEmpty() || hidden) thread
                else thread.map { if (it.mid == mid) it.copy(text = txt.take(1000)) else it }
            }
            else -> thread
        }
        if (next.none { it.key != "me" }) {
            cancelConversation(ctx, conversationId)
            Log.d(TAG, "clear kind=$kind conv=$conversationId → cancelled")
            return
        }
        if (next == thread) return
        saveThread(ctx, conversationId, next)
        if (isPosted(ctx, notifIdFor(conversationId))) {
            render(ctx, conversationId, alert = false, subText = null)
            Log.d(TAG, "clear kind=$kind conv=$conversationId → re-posted ${next.size} msgs")
        }
    }

    private fun isPosted(ctx: Context, notifId: Int): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        return try {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.activeNotifications.any { it.id == notifId }
        } catch (_: Throwable) { true }
    }

    /** Cancel one conversation's notification (read here / elsewhere / opened). */
    fun cancelConversation(ctx: Context, conversationId: String) {
        try {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(notifIdFor(conversationId))
            // [2026-10-15 notif-read-sync] Banners desenhados pelo expo-notifications
            // (app em 1º plano / binários antigos) usam tag = "chat_<cid>" → saem juntos.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                try {
                    val tag = "chat_$conversationId"
                    for (sbn in nm.activeNotifications) {
                        if (sbn.tag == tag) nm.cancel(sbn.tag, sbn.id)
                    }
                } catch (_: Throwable) {}
            }
            clearThread(ctx, conversationId)
            postSummary(ctx, "pt", null)
        } catch (t: Throwable) {
            Log.w(TAG, "cancelConversation failed: ${t.message}")
        }
    }

    /** Recipient account / last message id saved for an action intent fallback. */
    fun metaFor(ctx: Context, conversationId: String): JSONObject? = loadMeta(ctx, conversationId)

    // =========================================================================
    // Group summary ("N mensagens de M conversas")
    // =========================================================================

    private fun postSummary(ctx: Context, lang: String, channelHint: String?) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        try {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val children = nm.activeNotifications.filter {
                it.id != SUMMARY_ID && it.notification.group == CHAT_GROUP_KEY &&
                    (it.notification.flags and Notification.FLAG_GROUP_SUMMARY) == 0
            }
            if (children.isEmpty()) { nm.cancel(SUMMARY_ID); return }
            var msgs = 0
            val inbox = NotificationCompat.InboxStyle()
            for (sbn in children.take(6)) {
                val ex = sbn.notification.extras
                msgs += ex.getInt(EXTRA_MSG_COUNT, 1).coerceAtLeast(1)
                val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
                val txt = ex.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""
                inbox.addLine(if (title.isNotEmpty()) "$title: $txt" else txt)
            }
            for (sbn in children.drop(6)) msgs += sbn.notification.extras.getInt(EXTRA_MSG_COUNT, 1).coerceAtLeast(1)
            val summaryText = summaryLabel(lang, msgs, children.size)
            inbox.setSummaryText(summaryText)
            val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            val ch = channelHint ?: (children.first().notification.let {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) it.channelId else null
            } ?: "chat_dm")
            val b = NotificationCompat.Builder(ctx, ch)
                .setSmallIcon(smallIcon(ctx))
                .setContentTitle("Chatyy")
                .setContentText(summaryText)
                .setStyle(inbox)
                .setGroup(CHAT_GROUP_KEY)
                .setGroupSummary(true)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            if (launch != null) b.setContentIntent(PendingIntent.getActivity(ctx, SUMMARY_ID, launch, pendingIntentFlags(mutable = false)))
            nm.notify(SUMMARY_ID, b.build())
        } catch (t: Throwable) {
            Log.w(TAG, "postSummary failed: ${t.message}")
        }
    }

    // =========================================================================
    // Channels / shortcuts / intents
    // =========================================================================

    /** Create the chat channels if missing (JS creates the same ids with the
     *  same settings; whoever runs first wins — channels are immutable). */
    fun ensureBaseChannels(ctx: Context) {
        if (baseChannelsEnsured || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            fun mk(id: String, name: String, desc: String, importance: Int, sound: Boolean, vib: LongArray?, light: String) {
                if (nm.getNotificationChannel(id) != null) return
                val ch = NotificationChannel(id, name, importance).apply {
                    description = desc
                    setShowBadge(true)
                    enableLights(true)
                    try { lightColor = Color.parseColor(light) } catch (_: Throwable) {}
                    if (!sound) setSound(null, null)
                    if (vib != null) { enableVibration(true); vibrationPattern = vib } else enableVibration(false)
                }
                nm.createNotificationChannel(ch)
            }
            mk("chat_dm", "Mensagens diretas", "Notificações de conversas individuais (1:1)",
                NotificationManager.IMPORTANCE_HIGH, true, longArrayOf(0, 150, 80, 150), "#10b981")
            mk("chat_group", "Grupos", "Notificações de conversas em grupo",
                NotificationManager.IMPORTANCE_DEFAULT, false, null, "#3b82f6")
            mk("chat_mention", "Chat — Menções", "Quando alguém menciona você (@) em uma conversa",
                NotificationManager.IMPORTANCE_HIGH, true, longArrayOf(0, 200, 100, 200), "#A582F7")
            mk("chat_keyword", "Chat — Palavras-chave", "Mensagens que contêm uma palavra-chave que você configurou",
                NotificationManager.IMPORTANCE_MAX, true, longArrayOf(0, 200, 100, 200, 100, 200), "#ef4444")
            mk("chat_reaction", "Chat — Reações", "Quando alguém reage a uma mensagem sua",
                NotificationManager.IMPORTANCE_LOW, false, null, "#f59e0b")
            mk("chat", "Chat Messages", "Notifications for new chat messages",
                NotificationManager.IMPORTANCE_HIGH, true, longArrayOf(0, 150, 80, 150), "#10b981")
            baseChannelsEnsured = true
        } catch (t: Throwable) {
            Log.w(TAG, "ensureBaseChannels failed: ${t.message}")
        }
    }

    private fun pushConversationShortcut(
        ctx: Context, conversationId: String, label: String, persons: List<Person>, icon: Bitmap?, uri: Uri,
    ): String? {
        return try {
            val id = "chat_$conversationId"
            val intent = Intent(Intent.ACTION_VIEW, uri).setPackage(ctx.packageName)
            val b = ShortcutInfoCompat.Builder(ctx, id)
                .setShortLabel(label.ifBlank { "Chatyy" }.take(40))
                .setLongLabel(label.ifBlank { "Chatyy" })
                .setLongLived(true)
                .setIntent(intent)
                .setLocusId(LocusIdCompat(id))
                // [2026-10-09 notif-native] + Sharing Shortcuts category → the
                // conversation also shows in the system share sheet row
                // (<share-target> in plugins/with-app-shortcuts.js).
                .setCategories(setOf("android.shortcut.conversation", ctx.packageName + ".category.SHARE_TARGET"))
            if (persons.isNotEmpty()) b.setPersons(persons.toTypedArray())
            if (icon != null) b.setIcon(IconCompat.createWithBitmap(icon))
            ShortcutManagerCompat.pushDynamicShortcut(ctx, b.build())
            id
        } catch (t: Throwable) {
            Log.w(TAG, "pushConversationShortcut failed: ${t.message}")
            null
        }
    }

    private fun actionIntent(ctx: Context, action: String, conversationId: String, notifId: Int, recipient: String, lastMid: String): Intent =
        Intent(ctx, ChatActionReceiver::class.java).apply {
            this.action = action
            setPackage(ctx.packageName)
            putExtra("conversation_id", conversationId)
            putExtra("notif_id", notifId)
            putExtra("recipient_email", recipient)
            putExtra("message_id", lastMid)
        }

    /** onemundomail://chat-conversation?id=…&type=…&name=…&email=…&acct=… */
    fun conversationUri(conversationId: String, isGroup: Boolean, name: String, email: String, acct: String): Uri {
        val b = Uri.Builder().scheme(APP_SCHEME).authority("chat-conversation")
            .appendQueryParameter("id", conversationId)
            .appendQueryParameter("type", if (isGroup) "group" else "direct")
        if (name.isNotEmpty()) b.appendQueryParameter("name", name)
        if (email.isNotEmpty()) b.appendQueryParameter("email", email)
        if (acct.isNotEmpty()) b.appendQueryParameter("acct", acct)
        b.appendQueryParameter("src", "notif")
        return b.build()
    }

    private fun smallIcon(ctx: Context): Int {
        return try {
            val id = ctx.resources.getIdentifier("notification_icon", "drawable", ctx.packageName)
            if (id != 0) id else android.R.drawable.ic_dialog_email
        } catch (_: Throwable) { android.R.drawable.ic_dialog_email }
    }

    fun avatarUrlForEmail(email: String): String =
        if (email.contains('@')) "$API_HOST/api/email.php?action=get_avatar&email=" + URLEncoder.encode(email, "UTF-8") else ""

    // ---- localized labels (pt default; backend ships `lang`) -----------------

    // [2026-10-12 push-parity] 11 app languages (pt-BR/pt-PT share "pt"). The
    // backend ships the recipient's `lang` (2 letters); unknown → pt.
    private val LBL: Map<String, Map<String, String>> = mapOf(
        "pt" to mapOf("me" to "Você", "reply" to "Responder", "ph" to "Mensagem", "read" to "Marcar como lida", "mute" to "Silenciar 8h", "new" to "Nova mensagem", "fail" to "Não enviada. Toque para abrir", "open" to "Abra o Chatyy para responder", "m1" to "mensagem", "mN" to "mensagens", "c1" to "conversa", "cN" to "conversas", "sum" to "{m} {msgs} de {c} {convs}"),
        "en" to mapOf("me" to "You", "reply" to "Reply", "ph" to "Message", "read" to "Mark as read", "mute" to "Mute 8h", "new" to "New message", "fail" to "Not sent. Tap to open", "open" to "Open Chatyy to reply", "m1" to "message", "mN" to "messages", "c1" to "chat", "cN" to "chats", "sum" to "{m} {msgs} from {c} {convs}"),
        "es" to mapOf("me" to "Tú", "reply" to "Responder", "ph" to "Mensaje", "read" to "Marcar como leído", "mute" to "Silenciar 8 h", "new" to "Nuevo mensaje", "fail" to "No enviado. Toca para abrir", "open" to "Abre Chatyy para responder", "m1" to "mensaje", "mN" to "mensajes", "c1" to "chat", "cN" to "chats", "sum" to "{m} {msgs} de {c} {convs}"),
        "fr" to mapOf("me" to "Vous", "reply" to "Répondre", "ph" to "Message", "read" to "Marquer comme lu", "mute" to "Silence 8 h", "new" to "Nouveau message", "fail" to "Non envoyé. Touchez pour ouvrir", "open" to "Ouvrez Chatyy pour répondre", "m1" to "message", "mN" to "messages", "c1" to "discussion", "cN" to "discussions", "sum" to "{m} {msgs} de {c} {convs}"),
        "de" to mapOf("me" to "Du", "reply" to "Antworten", "ph" to "Nachricht", "read" to "Als gelesen markieren", "mute" to "8 Std. stumm", "new" to "Neue Nachricht", "fail" to "Nicht gesendet. Zum Öffnen tippen", "open" to "Öffne Chatyy zum Antworten", "m1" to "Nachricht", "mN" to "Nachrichten", "c1" to "Chat", "cN" to "Chats", "sum" to "{m} {msgs} aus {c} {convs}"),
        "it" to mapOf("me" to "Tu", "reply" to "Rispondi", "ph" to "Messaggio", "read" to "Segna come letto", "mute" to "Silenzia 8 h", "new" to "Nuovo messaggio", "fail" to "Non inviato. Tocca per aprire", "open" to "Apri Chatyy per rispondere", "m1" to "messaggio", "mN" to "messaggi", "c1" to "chat", "cN" to "chat", "sum" to "{m} {msgs} da {c} {convs}"),
        "ja" to mapOf("me" to "あなた", "reply" to "返信", "ph" to "メッセージ", "read" to "既読にする", "mute" to "8時間ミュート", "new" to "新着メッセージ", "fail" to "送信できませんでした。タップして開く", "open" to "Chatyyを開いて返信", "m1" to "件のメッセージ", "mN" to "件のメッセージ", "c1" to "件のチャット", "cN" to "件のチャット", "sum" to "{c}{convs}から{m}{msgs}"),
        "ar" to mapOf("me" to "أنت", "reply" to "رد", "ph" to "رسالة", "read" to "وضع علامة كمقروءة", "mute" to "كتم 8 ساعات", "new" to "رسالة جديدة", "fail" to "لم تُرسل. اضغط للفتح", "open" to "افتح Chatyy للرد", "m1" to "رسالة", "mN" to "رسائل", "c1" to "محادثة", "cN" to "محادثات", "sum" to "{m} {msgs} من {c} {convs}"),
        "id" to mapOf("me" to "Anda", "reply" to "Balas", "ph" to "Pesan", "read" to "Tandai dibaca", "mute" to "Bisukan 8 jam", "new" to "Pesan baru", "fail" to "Tidak terkirim. Ketuk untuk membuka", "open" to "Buka Chatyy untuk membalas", "m1" to "pesan", "mN" to "pesan", "c1" to "obrolan", "cN" to "obrolan", "sum" to "{m} {msgs} dari {c} {convs}"),
        "hi" to mapOf("me" to "आप", "reply" to "जवाब दें", "ph" to "मैसेज", "read" to "पढ़ा हुआ मार्क करें", "mute" to "8 घंटे म्यूट", "new" to "नया मैसेज", "fail" to "नहीं भेजा गया। खोलने के लिए टैप करें", "open" to "जवाब देने के लिए Chatyy खोलें", "m1" to "मैसेज", "mN" to "मैसेज", "c1" to "चैट", "cN" to "चैट", "sum" to "{c} {convs} से {m} {msgs}"),
    )
    private fun lbl(lang: String, key: String): String {
        val l = lang.lowercase().take(2)
        return LBL[l]?.get(key) ?: LBL["pt"]?.get(key) ?: key
    }
    private fun meLabel(lang: String) = lbl(lang, "me")
    private fun replyLabel(lang: String) = lbl(lang, "reply")
    private fun replyPlaceholder(lang: String) = lbl(lang, "ph")
    private fun markReadLabel(lang: String) = lbl(lang, "read")
    private fun muteLabel(lang: String) = lbl(lang, "mute")
    fun newMessageLabel(lang: String) = lbl(lang, "new")
    fun sendFailedLabel(lang: String) = lbl(lang, "fail")
    fun openAppToReplyLabel(lang: String) = lbl(lang, "open")
    private fun summaryLabel(lang: String, msgs: Int, convs: Int): String =
        lbl(lang, "sum")
            .replace("{m}", msgs.toString())
            .replace("{c}", convs.toString())
            .replace("{msgs}", lbl(lang, if (msgs == 1) "m1" else "mN"))
            .replace("{convs}", lbl(lang, if (convs == 1) "c1" else "cN"))

    private fun pickSenderName(data: Map<String, String>, email: String): String {
        val raw = data["sender_name"]?.takeIf { it.isNotBlank() }
            ?: email.substringBefore('@').takeIf { it.isNotBlank() }
            ?: "Contato"
        return raw.take(40)
    }

    private fun parseSmartReplies(raw: String?): List<String> {
        if (raw.isNullOrBlank()) return emptyList()
        return try {
            val arr = JSONArray(raw)
            val out = mutableListOf<String>()
            for (i in 0 until arr.length().coerceAtMost(3)) {
                val s = arr.optString(i, "").trim().take(40)
                if (s.isNotEmpty()) out.add(s)
            }
            out
        } catch (t: Throwable) {
            raw.split(",", "|").map { it.trim().take(40) }.filter { it.isNotEmpty() }.take(3)
        }
    }

    // =========================================================================
    // Thread cache (SharedPreferences) — [name, text, ts, key, mid]
    // =========================================================================

    /** img = absolute path of a cached media thumbnail (cacheDir/chat_push_img), "" = none. */
    /** e2e=true: [text] é o decifrado (só memória); [stored] = o que vai ao disco (genérico). */
    private data class ThreadMsg(val key: String, val senderName: String, val text: String, val timestamp: Long, val mid: String, val img: String = "",
                                 val e2e: Boolean = false, val stored: String = "") {
        val diskText: String get() = if (e2e) stored else text
    }

    // [e2ee5 WP-10] Texto decifrado por "conv|mid" — SÓ em memória (nunca SharedPreferences/disco).
    // Processo morto → as linhas E2EE antigas voltam como "Nova mensagem" (seguro).
    private val e2ePlain = object : LinkedHashMap<String, String>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean = size > 300
    }
    private fun e2ePut(conv: String, mid: String, text: String) { synchronized(e2ePlain) { e2ePlain["$conv|$mid"] = text } }
    private fun e2eGet(conv: String, mid: String): String? = synchronized(e2ePlain) { e2ePlain["$conv|$mid"] }
    private fun e2eDrop(conv: String) { synchronized(e2ePlain) { e2ePlain.keys.removeAll { it.startsWith("$conv|") } } }

    /** Read-only dedupe probe (saves a media download on FCM/Expo redelivery). */
    private fun threadHasMid(ctx: Context, conversationId: String, mid: String): Boolean =
        mid.isNotEmpty() && loadThread(ctx, conversationId).any { it.mid == mid }

    /** Returns false when message_id was already cached (duplicate push). */
    @Synchronized
    private fun appendMessageToThread(ctx: Context, conversationId: String, m: ThreadMsg): Boolean {
        return try {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val key = "thread_$conversationId"
            val existing = sp.getString(key, "") ?: ""
            val arr = if (existing.isEmpty()) JSONArray() else try { JSONArray(existing) } catch (_: Throwable) { JSONArray() }
            if (m.mid.isNotEmpty()) {
                for (i in 0 until arr.length()) {
                    if (arr.optJSONArray(i)?.optString(4, "") == m.mid) return false
                }
            }
            arr.put(JSONArray().put(m.senderName).put(m.diskText).put(m.timestamp).put(m.key).put(m.mid).put(m.img).put(if (m.e2e) "1" else ""))
            val trimmed = if (arr.length() > MAX_MESSAGES_PER_THREAD) {
                val keep = JSONArray()
                for (i in (arr.length() - MAX_MESSAGES_PER_THREAD) until arr.length()) keep.put(arr.get(i))
                keep
            } else arr
            sp.edit().putString(key, trimmed.toString()).apply()
            true
        } catch (t: Throwable) {
            Log.w(TAG, "appendMessageToThread failed: ${t.message}")
            true
        }
    }

    /** The user's own inline reply → MessagingStyle "self" message. */
    fun appendOwnReply(ctx: Context, conversationId: String, text: String) {
        appendMessageToThread(ctx, conversationId, ThreadMsg("me", "me", text.take(1000), System.currentTimeMillis(), ""))
    }

    /** [2026-10-09 notif-native] Cached thread for ChatBubbleActivity's first
     *  paint: [key ("me" = own reply), senderName, text, timestamp]. */
    fun threadSnapshot(ctx: Context, conversationId: String): List<Array<String>> =
        loadThread(ctx, conversationId).map { arrayOf(it.key, it.senderName, it.text, it.timestamp.toString()) }

    private fun loadThread(ctx: Context, conversationId: String): List<ThreadMsg> {
        return try {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val raw = sp.getString("thread_$conversationId", "") ?: ""
            if (raw.isEmpty()) return emptyList()
            val arr = JSONArray(raw)
            val out = mutableListOf<ThreadMsg>()
            for (i in 0 until arr.length()) {
                val item = arr.optJSONArray(i) ?: continue
                val name = item.optString(0)
                // Legacy rows ([name, text, ts]) + legacy own reply ("Você").
                val key = item.optString(3, "").ifEmpty { if (name == "Você") "me" else name }
                val mid = item.optString(4, "")
                val stored = item.optString(1)
                if (item.optString(6, "") == "1") {
                    out.add(ThreadMsg(key, name, e2eGet(conversationId, mid) ?: stored, item.optLong(2), mid, item.optString(5, ""), e2e = true, stored = stored))
                } else {
                    out.add(ThreadMsg(key, name, stored, item.optLong(2), mid, item.optString(5, "")))
                }
            }
            out
        } catch (t: Throwable) {
            emptyList()
        }
    }

    @Synchronized
    private fun saveThread(ctx: Context, conversationId: String, list: List<ThreadMsg>) {
        try {
            val arr = JSONArray()
            for (m in list.takeLast(MAX_MESSAGES_PER_THREAD)) {
                arr.put(JSONArray().put(m.senderName).put(m.diskText).put(m.timestamp).put(m.key).put(m.mid).put(m.img).put(if (m.e2e) "1" else ""))
            }
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("thread_$conversationId", arr.toString()).apply()
        } catch (t: Throwable) {
            Log.w(TAG, "saveThread failed: ${t.message}")
        }
    }

    /** Public: drop the thread cache when user marks the chat read. */
    fun clearThread(ctx: Context, conversationId: String) {
        e2eDrop(conversationId)
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().remove("thread_$conversationId").apply()
    }

    private fun saveMeta(ctx: Context, conversationId: String, meta: JSONObject) {
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("meta_$conversationId", meta.toString()).apply()
        } catch (_: Throwable) {}
    }

    private fun loadMeta(ctx: Context, conversationId: String): JSONObject? {
        return try {
            val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("meta_$conversationId", null) ?: return null
            JSONObject(raw)
        } catch (_: Throwable) { null }
    }

    // =========================================================================
    // [2026-10-18 push-thumb] Media thumbnail cache (cacheDir/chat_push_img)
    // =========================================================================

    /**
     * Downloads the push `image` (photo / gif / video poster) for an inline
     * MessagingStyle thumbnail. Hard ~3 s budget on a worker thread (the FCM
     * service thread just waits on the Future, so a slow CDN can't eat the
     * ~10 s onMessageReceived window), ≤ 4 MB on the wire, downsampled and
     * re-encoded to a ≤ 1024 px JPEG (so the mime is always image/jpeg).
     * Exposed through expo-file-system's FileProvider
     * (<pkg>.FileSystemFileProvider, cache-path "." → grantUriPermissions=true);
     * NotificationManager grants SystemUI read access to MessagingStyle data
     * URIs (API 28+), and we also grant it explicitly. Old files are pruned
     * (48 h / 40 files). Any failure → null → text-only notification.
     */
    object ChatPushImageCache {
        private const val LOG_TAG = "ChatPushImageCache"
        private const val DIR = "chat_push_img"
        private const val BUDGET_MS = 3000L
        private const val MAX_BYTES = 4 * 1024 * 1024
        private const val MAX_PX = 1024
        private const val TTL_MS = 48L * 60 * 60 * 1000
        private const val MAX_FILES = 40
        private val exec = Executors.newCachedThreadPool { r -> Thread(r, "chatyy-push-img").apply { isDaemon = true } }

        fun fetch(ctx: Context, url: String): String? {
            val abs = when {
                url.startsWith("https://") -> url
                url.startsWith("/") -> API_HOST + url
                else -> return null
            }
            val dir = File(ctx.cacheDir, DIR)
            val f = File(dir, ChatAvatarCache.md5(abs) + ".jpg")
            if (f.exists() && f.length() > 0) return f.absolutePath
            val fut = try { exec.submit<String?> { download(abs, dir, f) } } catch (_: Throwable) { return null }
            return try {
                fut.get(BUDGET_MS, TimeUnit.MILLISECONDS)
            } catch (t: Throwable) {
                fut.cancel(true)
                Log.w(LOG_TAG, "thumb fetch gave up: ${t.javaClass.simpleName}")
                null
            } finally {
                try { exec.execute { prune(dir) } } catch (_: Throwable) {}
            }
        }

        fun contentUri(ctx: Context, path: String): Uri? {
            if (path.isEmpty()) return null
            return try {
                val f = File(path)
                if (!f.exists() || f.length() == 0L) return null
                val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".FileSystemFileProvider", f)
                try {
                    ctx.grantUriPermission("com.android.systemui", uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                } catch (_: Throwable) {}
                uri
            } catch (t: Throwable) {
                Log.w(LOG_TAG, "contentUri failed: ${t.message}")
                null
            }
        }

        private fun download(url: String, dir: File, dest: File): String? {
            var conn: HttpURLConnection? = null
            return try {
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 2000
                    readTimeout = 2500
                    instanceFollowRedirects = true
                    doInput = true
                }
                if (conn.responseCode !in 200..299) return null
                val ct = conn.contentType?.lowercase() ?: ""
                if (ct.isNotEmpty() && !ct.startsWith("image/") && !ct.startsWith("application/octet-stream")) return null
                if (conn.contentLengthLong > MAX_BYTES) return null
                val bytes = conn.inputStream.use { input ->
                    val bos = ByteArrayOutputStream()
                    val buf = ByteArray(16 * 1024)
                    var total = 0
                    while (true) {
                        if (Thread.currentThread().isInterrupted) return null
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_BYTES) return null
                        bos.write(buf, 0, n)
                    }
                    bos.toByteArray()
                }
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
                var sample = 1
                while (bounds.outWidth / (sample * 2) >= MAX_PX || bounds.outHeight / (sample * 2) >= MAX_PX) sample *= 2
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size,
                    BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
                dir.mkdirs()
                val tmp = File(dir, dest.name + ".tmp")
                FileOutputStream(tmp).use { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }
                bmp.recycle()
                if (!tmp.renameTo(dest)) { tmp.delete(); return null }
                dest.absolutePath
            } catch (t: Throwable) {
                Log.w(LOG_TAG, "thumb download failed: ${t.message}")
                null
            } finally {
                try { conn?.disconnect() } catch (_: Throwable) {}
            }
        }

        private fun prune(dir: File) {
            try {
                val files = dir.listFiles() ?: return
                val now = System.currentTimeMillis()
                val keep = files.filter { f ->
                    val old = now - f.lastModified() > TTL_MS
                    if (old) f.delete()
                    !old
                }.sortedByDescending { it.lastModified() }
                keep.drop(MAX_FILES).forEach { it.delete() }
            } catch (_: Throwable) {}
        }
    }

    // =========================================================================
    // Avatar cache — small circular bitmaps on disk (cacheDir/chat_avatars)
    // =========================================================================

    object ChatAvatarCache {
        private const val LOG_TAG = "ChatAvatarCache"
        private const val HOST = "https://chatyy.com.br"
        private const val MAX_PX = 192
        private const val TTL_MS = 24L * 60 * 60 * 1000
        private const val MAX_BYTES = 3 * 1024 * 1024

        fun get(ctx: Context, url: String?, fetch: Boolean): Bitmap? {
            if (url.isNullOrBlank()) return null
            val abs = when {
                url.startsWith("https://") -> url
                url.startsWith("/") -> HOST + url
                else -> return null
            }
            val dir = File(ctx.cacheDir, "chat_avatars")
            val f = File(dir, md5(abs) + ".png")
            val fresh = f.exists() && (System.currentTimeMillis() - f.lastModified() < TTL_MS)
            if (fresh || (f.exists() && !fetch)) {
                BitmapFactory.decodeFile(f.absolutePath)?.let { return it }
            }
            if (!fetch) return null
            val bmp = download(abs)
            if (bmp != null) {
                try {
                    dir.mkdirs()
                    FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
                } catch (_: Throwable) {}
                return bmp
            }
            // Network failed → stale copy is better than none.
            return if (f.exists()) BitmapFactory.decodeFile(f.absolutePath) else null
        }

        private fun download(url: String): Bitmap? {
            var conn: HttpURLConnection? = null
            return try {
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 2500
                    readTimeout = 3500
                    instanceFollowRedirects = true
                    doInput = true
                }
                if (conn.responseCode !in 200..299) return null
                val bytes = conn.inputStream.use { input ->
                    val bos = ByteArrayOutputStream()
                    val buf = ByteArray(16 * 1024)
                    var total = 0
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_BYTES) return null
                        bos.write(buf, 0, n)
                    }
                    bos.toByteArray()
                }
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (bounds.outWidth / (sample * 2) >= MAX_PX && bounds.outHeight / (sample * 2) >= MAX_PX) sample *= 2
                val opts = BitmapFactory.Options().apply { inSampleSize = sample }
                val raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
                circle(raw)
            } catch (t: Throwable) {
                Log.w(LOG_TAG, "avatar download failed: ${t.message}")
                null
            } finally {
                try { conn?.disconnect() } catch (_: Throwable) {}
            }
        }

        private fun circle(src: Bitmap): Bitmap {
            val size = minOf(src.width, src.height, MAX_PX)
            val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(out)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            canvas.drawOval(RectF(0f, 0f, size.toFloat(), size.toFloat()), paint)
            paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
            val side = minOf(src.width, src.height)
            val left = (src.width - side) / 2
            val top = (src.height - side) / 2
            canvas.drawBitmap(src, Rect(left, top, left + side, top + side), Rect(0, 0, size, size), paint)
            return out
        }

        /** Adaptive-icon canvas (108 units, safe zone 72) around a round avatar
         *  so the bubble launcher mask doesn't crop the face. */
        fun adaptive(src: Bitmap): Bitmap {
            val size = 216
            val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(out)
            canvas.drawColor(Color.WHITE)
            val inner = 144
            val off = (size - inner) / 2
            canvas.drawBitmap(src, Rect(0, 0, src.width, src.height), Rect(off, off, off + inner, off + inner),
                Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
            return out
        }

        /** Initial-letter circle for groups without a photo. */
        fun letterAvatar(name: String): Bitmap? {
            return try {
                val size = 128
                val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(out)
                val palette = intArrayOf(0xFF10B981.toInt(), 0xFF3B82F6.toInt(), 0xFFA582F7.toInt(), 0xFFF59E0B.toInt(), 0xFFEF4444.toInt(), 0xFF14B8A6.toInt())
                val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette[(name.hashCode() and 0x7FFFFFFF) % palette.size] }
                canvas.drawOval(RectF(0f, 0f, size.toFloat(), size.toFloat()), bg)
                val letter = name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "#"
                val tp = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.WHITE
                    textSize = size * 0.45f
                    textAlign = Paint.Align.CENTER
                    isFakeBoldText = true
                }
                val y = size / 2f - (tp.descent() + tp.ascent()) / 2f
                canvas.drawText(letter, size / 2f, y, tp)
                out
            } catch (_: Throwable) { null }
        }

        internal fun md5(s: String): String {
            val d = MessageDigest.getInstance("MD5").digest(s.toByteArray(Charsets.UTF_8))
            return d.joinToString("") { "%02x".format(it) }
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
        // [2026-10-18 tone-conv] API 30+: suffix marks channels created WITH
        // setConversationId (a channel's conversation link is immutable, so the
        // pre-suffix ones are migrated to a fresh id in ensureToneChannel).
        val suffix = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) TONE_CONV_SUFFIX else ""
        return "chat_conv_tone_${safeConv}_$hash$suffix"
    }

    private const val TONE_CONV_SUFFIX = "_cv"

    /**
     * Ensure the per-conversation tone channel exists (create-if-missing) and
     * return its id, or null if this conversation has no custom tone / the OS
     * rejected it. Called from both the bridge and the push path so the channel
     * is guaranteed to exist before we post on it.
     */
    private fun ensureToneChannel(ctx: Context, conversationId: String, isGroupHint: Boolean? = null): String? {
        var cfg = readToneConfig(ctx, conversationId) ?: return null
        // Pre-O has no channels; custom per-conv sound isn't applied there and
        // we fall back to the default channel (acceptable — Android 7 and older
        // is a vanishingly small install base). Returning null routes to "chat".
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
        // [2026-10-18 tone-conv] Channel created before conversation linking →
        // move to a fresh id (same sound/vibration/LED) that carries it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !cfg.channelId.endsWith(TONE_CONV_SUFFIX)) {
            try {
                val newId = computeToneChannelId(conversationId, cfg.sound, cfg.vib, cfg.vibOff, cfg.led)
                val sp0 = ctx.getSharedPreferences(TONE_PREFS, Context.MODE_PRIVATE)
                val raw = sp0.getString(toneCfgKey(conversationId), null)
                if (raw != null && newId != cfg.channelId) {
                    deleteToneChannel(ctx, cfg.channelId)
                    sp0.edit().putString(toneCfgKey(conversationId), JSONObject(raw).put("channelId", newId).toString()).apply()
                    cfg = cfg.copy(channelId = newId)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "tone channel conv migration failed: ${t.message}")
            }
        }
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
                // [2026-10-18 tone-conv] Android 11+: link the channel to the
                // conversation shortcut ("chat_<id>", pushConversationShortcut)
                // so it is listed under Conversas / priority-conversation
                // settings instead of a loose "Chat (personalizado)" category.
                // Parent = the base channel this chat would use without a tone.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    try {
                        val isGroup = isGroupHint
                            ?: (loadMeta(ctx, conversationId)?.optBoolean("group", false) == true)
                        setConversationId(if (isGroup) "chat_group" else "chat_dm", "chat_$conversationId")
                    } catch (_: Throwable) {}
                }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ensureBaseChannels(ctx)
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
