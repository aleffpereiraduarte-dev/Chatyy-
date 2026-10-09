package expo.modules.callkit

// [2026-10-09 notif-native] ChatBubbleActivity — expanded view of an Android 11+
// conversation BUBBLE (chat head). Native mini-chat, no React Native (a bubble
// can't host the singleTask RN MainActivity):
//   • first paint from the notification thread cache (ChatMessagingStyleHandler),
//     then the last 30 messages from email.php?action=chat_messages, polled every
//     5 s while visible;
//   • send box → email.php?action=chat_send (client_message_id → server dedupe)
//     with the bearer of the account the conversation belongs to
//     (ChatNotifStore — never posts as another account);
//   • opening the bubble = reading → chat_mark_read (watermark);
//   • "Abrir" opens the full conversation in the app (deep link).
// Black & white, follows the system dark mode. Launched only via the bubble
// PendingIntent (exported=false; allowEmbedded/resizeable/documentLaunchMode in
// the module AndroidManifest).

import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.annotation.RequiresApi
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.UUID

@RequiresApi(Build.VERSION_CODES.R)
class ChatBubbleActivity : Activity() {

    companion object {
        const val EXTRA_CONV_ID = "chatyy_bubble_conv_id"
        private const val TAG = "ChatBubbleActivity"
        private const val POLL_MS = 5000L
        /** Conversation shown by a RESUMED bubble (read by the push handler). */
        @Volatile var resumedConv: String? = null
    }

    private data class Msg(val id: Long, val mine: Boolean, val sender: String, val text: String)

    private var convId = ""
    private var recipient = ""
    private var lang = "pt"
    private var isGroup = false
    private var dark = false
    private var lastReadSent = 0L
    private var resumed = false
    private val main = Handler(Looper.getMainLooper())
    private val msgs = ArrayList<Msg>()
    private val pendingMine = ArrayList<Msg>()

    private lateinit var list: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var input: EditText

    private val poll = object : Runnable {
        override fun run() {
            if (!resumed) return
            fetch()
            main.postDelayed(this, POLL_MS)
        }
    }

    // ---- palette (B&W) ------------------------------------------------------
    private val bg get() = if (dark) Color.BLACK else Color.WHITE
    private val fg get() = if (dark) Color.WHITE else Color.BLACK
    private val muted get() = if (dark) Color.parseColor("#8E8E93") else Color.parseColor("#6B6B6B")
    private val theirsBg get() = if (dark) Color.parseColor("#1C1C1E") else Color.parseColor("#F2F2F2")
    private val divider get() = if (dark) Color.parseColor("#2C2C2E") else Color.parseColor("#E5E5E5")

    private fun dp(v: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        convId = intent?.getStringExtra(EXTRA_CONV_ID) ?: ""
        if (convId.isEmpty()) { finish(); return }
        val meta = ChatMessagingStyleHandler.metaFor(this, convId)
        recipient = meta?.optString("recipient", "") ?: ""
        lang = meta?.optString("lang", "pt") ?: "pt"
        isGroup = meta?.optBoolean("group", false) ?: false
        dark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        buildUi(meta?.optString("name", "Chatyy") ?: "Chatyy")

        // First paint: the notification thread cache.
        for (row in ChatMessagingStyleHandler.threadSnapshot(this, convId)) {
            msgs.add(Msg(0L, row[0] == "me", row[1], row[2]))
        }
        renderList()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        resumedConv = convId
        main.removeCallbacks(poll)
        main.post(poll)
    }

    override fun onPause() {
        resumed = false
        if (resumedConv == convId) resumedConv = null
        main.removeCallbacks(poll)
        super.onPause()
    }

    // ---- UI -----------------------------------------------------------------

    private fun buildUi(title: String) {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(bg)
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(12), dp(8), dp(12))
        }
        header.addView(TextView(this).apply {
            text = title
            setTextColor(fg)
            textSize = 17f
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(TextView(this).apply {
            text = label("open")
            setTextColor(fg)
            textSize = 15f
            setPadding(dp(12), dp(6), dp(12), dp(6))
            setOnClickListener { openInApp() }
        })
        root.addView(header)
        root.addView(View(this).apply { setBackgroundColor(divider) },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1))

        scroll = ScrollView(this).apply { isFillViewport = true }
        list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), dp(8), dp(10), dp(8))
        }
        scroll.addView(list)
        root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(8), dp(10), dp(10))
        }
        input = EditText(this).apply {
            hint = label("placeholder")
            setHintTextColor(muted)
            setTextColor(fg)
            textSize = 16f
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            maxLines = 4
            imeOptions = EditorInfo.IME_ACTION_SEND
            setPadding(dp(14), dp(10), dp(14), dp(10))
            background = GradientDrawable().apply {
                cornerRadius = dp(20).toFloat()
                setColor(theirsBg)
            }
        }
        bar.addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(TextView(this).apply {
            text = label("send")
            setTextColor(bg)
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(10), dp(16), dp(10))
            background = GradientDrawable().apply {
                cornerRadius = dp(20).toFloat()
                setColor(fg)
            }
            setOnClickListener { send() }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            leftMargin = dp(8)
        })
        root.addView(bar)

        // Edge-to-edge (targetSdk 35): pad for system bars + keyboard.
        root.setOnApplyWindowInsetsListener { v, insets ->
            val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsets.CONSUMED
        }
        setContentView(root, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    private fun renderList() {
        list.removeAllViews()
        var prevSender = ""
        for (m in msgs + pendingMine) {
            if (isGroup && !m.mine && m.sender != prevSender) {
                list.addView(TextView(this).apply {
                    text = m.sender
                    setTextColor(muted)
                    textSize = 12f
                    setPadding(dp(6), dp(6), dp(6), dp(2))
                })
            }
            prevSender = if (m.mine) "" else m.sender
            val tv = TextView(this).apply {
                text = m.text
                textSize = 15f
                setTextColor(if (m.mine) bg else fg)
                setPadding(dp(12), dp(8), dp(12), dp(8))
                background = GradientDrawable().apply {
                    cornerRadius = dp(16).toFloat()
                    setColor(if (m.mine) fg else theirsBg)
                }
                maxWidth = (resources.displayMetrics.widthPixels * 0.78f).toInt()
                if (m.id == -1L) alpha = 0.6f
            }
            list.addView(tv, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = if (m.mine) Gravity.END else Gravity.START
                topMargin = dp(3)
            })
        }
        scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
    }

    // ---- network ------------------------------------------------------------

    private fun bearer(): String? = ChatNotifStore.bearerFor(this, recipient)

    private fun me(): String = ChatNotifStore.normEmail(recipient.ifEmpty { ChatNotifStore.activeEmail(this) })

    private fun fetch() {
        val token = bearer() ?: return
        val base = ChatNotifStore.apiBase(this)
        Thread(task@{
            val url = base + "/api/email.php?action=chat_messages&limit=30&conversation_id=" +
                URLEncoder.encode(convId, "UTF-8")
            val body = http("GET", url, token, null) ?: return@task
            val parsed = parseMessages(body) ?: return@task
            main.post {
                if (isFinishing || isDestroyed) return@post
                msgs.clear()
                msgs.addAll(parsed)
                // Drop optimistic rows the server already returned.
                pendingMine.removeAll { p -> parsed.any { it.mine && it.text == p.text } }
                renderList()
                val maxId = parsed.maxOfOrNull { it.id } ?: 0L
                if (maxId > lastReadSent) {
                    lastReadSent = maxId
                    markRead(maxId)
                }
            }
        }, "chatyy-bubble-fetch").start()
    }

    private fun parseMessages(raw: String): List<Msg>? {
        return try {
            val j = JSONObject(raw)
            if (!j.optBoolean("success", false)) return null
            val data = j.opt("data")
            val arr = when (data) {
                is JSONObject -> data.optJSONArray("messages")
                is org.json.JSONArray -> data
                else -> null
            } ?: return null
            val mine = me()
            val out = ArrayList<Msg>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val sender = ChatNotifStore.normEmail(o.optString("sender_email", ""))
                val name = o.optString("sender_name", "").ifEmpty { sender.substringBefore('@') }
                out.add(Msg(o.optLong("id", 0L), mine.isNotEmpty() && sender == mine, name, describe(o)))
            }
            out.sortBy { it.id }
            out
        } catch (t: Throwable) {
            Log.w(TAG, "parse failed: ${t.message}")
            null
        }
    }

    private fun describe(o: JSONObject): String {
        if (!o.isNull("deleted_at") && o.optString("deleted_at", "").isNotEmpty()) return label("deleted")
        val type = o.optString("type", "text")
        val content = o.optString("content", "")
        return when (type) {
            "text", "" -> content
            "image", "photo" -> label("photo") + if (content.isNotBlank() && !content.startsWith("http")) " · $content" else ""
            "video" -> label("video")
            "audio", "voice" -> label("voice")
            "location", "live_location" -> label("location")
            "sticker" -> label("sticker")
            "file", "document" -> o.optString("file_name", "").ifEmpty { label("file") }
            else -> content.ifBlank { label("message") }
        }
    }

    private fun send() {
        val text = input.text?.toString()?.trim() ?: ""
        if (text.isEmpty()) return
        val token = bearer() ?: run { openInApp(); return }
        input.setText("")
        val optimistic = Msg(-1L, true, "", text)
        pendingMine.add(optimistic)
        renderList()
        ChatMessagingStyleHandler.appendOwnReply(this, convId, text)
        val base = ChatNotifStore.apiBase(this)
        val cmid = "bubble-" + UUID.randomUUID().toString()
        Thread({
            var ok = false
            for (attempt in 0 until 2) {
                val body = JSONObject().apply {
                    put("action", "chat_send")
                    put("conversation_id", convId)
                    put("type", "text")
                    put("content", text)
                    put("client_message_id", cmid)
                }.toString()
                val r = http("POST", "$base/api/email.php?action=chat_send", token, body)
                ok = r != null && try { JSONObject(r).optBoolean("success", false) } catch (_: Throwable) { false }
                if (ok) break
            }
            main.post {
                if (isFinishing || isDestroyed) return@post
                if (ok) fetch() else {
                    pendingMine.remove(optimistic)
                    pendingMine.add(Msg(-1L, true, "", text + "  · " + label("failed")))
                    renderList()
                }
            }
        }, "chatyy-bubble-send").start()
    }

    private fun markRead(maxId: Long) {
        val token = bearer() ?: return
        val base = ChatNotifStore.apiBase(this)
        Thread({
            val body = JSONObject().apply {
                put("action", "chat_mark_read")
                put("conversation_id", convId)
                put("message_id", maxId)
            }.toString()
            http("POST", "$base/api/email.php?action=chat_mark_read", token, body)
        }, "chatyy-bubble-read").start()
    }

    /** Returns the body on HTTP 2xx, null otherwise. */
    private fun http(method: String, url: String, token: String, body: String?): String? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 6000
                readTimeout = 10000
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer $token")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
            }
            if (body != null) conn.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) return null
            conn.inputStream.bufferedReader().use { it.readText() }
        } catch (t: Throwable) {
            Log.w(TAG, "$method failed: ${t.message}")
            null
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }

    private fun openInApp() {
        try {
            val meta = ChatMessagingStyleHandler.metaFor(this, convId)
            val name = meta?.optString("name", "") ?: ""
            val email = if (isGroup) "" else (meta?.optString("sender_email", "") ?: "")
            val uri = ChatMessagingStyleHandler.conversationUri(convId, isGroup, name, email, recipient)
            startActivity(Intent(Intent.ACTION_VIEW, uri).apply {
                setPackage(packageName)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            })
        } catch (t: Throwable) {
            Log.w(TAG, "openInApp failed: ${t.message}")
        }
    }

    private fun label(k: String): String {
        val en = lang.startsWith("en")
        val es = lang.startsWith("es")
        return when (k) {
            "open" -> if (en) "Open" else "Abrir"
            "send" -> if (en) "Send" else "Enviar"
            "placeholder" -> if (en) "Message" else if (es) "Mensaje" else "Mensagem"
            "photo" -> if (en) "Photo" else "Foto"
            "video" -> if (en) "Video" else "Vídeo"
            "voice" -> if (en) "Voice message" else if (es) "Mensaje de voz" else "Mensagem de voz"
            "location" -> if (en) "Location" else if (es) "Ubicación" else "Localização"
            "sticker" -> if (en) "Sticker" else if (es) "Sticker" else "Figurinha"
            "file" -> if (en) "Document" else "Documento"
            "deleted" -> if (en) "Message deleted" else if (es) "Mensaje eliminado" else "Mensagem apagada"
            "failed" -> if (en) "not sent" else if (es) "no enviado" else "não enviada"
            else -> if (en) "Message" else if (es) "Mensaje" else "Mensagem"
        }
    }
}
