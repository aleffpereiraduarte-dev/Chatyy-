// [e2ee5 WP-10 2026-10-21] Prévia decifrada do push E2EE no Android (CONTRATO §7). Par do
// plugins/notification-service/NotificationServiceE2EE.swift (iOS): mesmas regras e o mesmo render.
//
// Falha FECHADO (→ null, o handler mostra "Nova mensagem" do servidor):
//   núcleo ausente (stub do expo-chatyy-crypto) · flags e2ee5_native / e2ee5_push_decrypt da conta
//   (ChatyyCryptoPush.eligible) · conversa trancada (locked=1) · prévia oculta (só e2e_np="0"
//   explícito libera) · conta do push sem uid mapeado · store inexistente (o push nunca cria) ·
//   UTD depois de 1 sync · tipo sem prévia · estouro do teto (DEADLINE_MS).
// O texto decifrado NUNCA vai a disco: o ChatMessagingStyleHandler guarda no cache de thread só o
// genérico + marca e2e, e o texto real fica num mapa em memória (some com o processo).
// Métricas só com código + ms (SharedPreferences "chatyy_e2ee5_push"). Nunca loga conteúdo.
//
// BLOQUEANTE: chamar fora da main thread (onMessageReceived já roda numa worker thread).
package expo.modules.callkit

import android.content.Context
import android.os.Looper
import expo.modules.chatyycrypto.ChatyyCryptoAuth
import expo.modules.chatyycrypto.ChatyyCryptoFlags
import expo.modules.chatyycrypto.ChatyyCryptoPush
import expo.modules.chatyycrypto.ChatyyCryptoSecrets
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.TimeUnit

object ChatPushE2EE {
    /** Teto total (buscar envelope + abrir store + decifrar + 1 sync). */
    const val DEADLINE_MS = 4500L
    private const val FETCH_TIMEOUT_MS = 2500L
    private const val PREFS = "chatyy_e2ee5_push"
    private val PUSH_TYPES = setOf("chat_message", "chat_mention", "chat_reaction")

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(FETCH_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(FETCH_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .callTimeout(FETCH_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .cookieJar(okhttp3.CookieJar.NO_COOKIES)
            .cache(null)
            .build()
    }

    private fun isDec(v: String) = v.isNotEmpty() && v.length <= 19 && v[0] != '0' && v.all { it in '0'..'9' }

    private fun conv(d: Map<String, String>) = d["e2e_conv"].orEmpty().ifEmpty { d["conversation_id"].orEmpty() }

    /** uid do destinatário se ESTE push pode ser decifrado aqui (sem rede); null = genérico.
     *  [WP-10c 2026-10-22] push e2e=5 que cai no genérico conta o motivo (`skip_<código>`). */
    fun candidateUid(ctx: Context, d: Map<String, String>): String? {
        if (d["e2e"] != "5" || d["type"] !in PUSH_TYPES) return null
        val why: String = run {
            if (!ChatyyCryptoPush.CORE_LINKED) return@run "no_core"
            if (d["locked"] == "1") return@run "locked"
            if (d["e2e_np"] != "0") return@run "np"
            if (!isDec(conv(d)) || !isDec(d["e2e_mid"].orEmpty()) || !isDec(d["e2e_sender_uid"].orEmpty())) return@run "ids"
            val env = d["e2e_c"].orEmpty()
            if (!env.startsWith("{\"e2e\":5") && d["e2e_fetch"] != "1") return@run "no_env"
            val acct = d["recipient_email"].orEmpty().trim().lowercase()
            if (acct.isEmpty()) return@run "no_acct"
            val uid = try { ChatyyCryptoPush.uidForAccount(ctx, acct) } catch (_: Throwable) { null } ?: return@run "no_uid_acct"
            if (try { ChatyyCryptoPush.eligible(ctx, uid) } catch (_: Throwable) { false }) return uid
            // motivo fino (só leitura de flags/arquivos, sem rede)
            try {
                when {
                    !ChatyyCryptoFlags.native(ctx, uid) -> "native_off"
                    !ChatyyCryptoFlags.pushDecrypt(ctx, uid) -> "flag_off"
                    !ChatyyCryptoSecrets.exists(ctx, uid) -> "no_store"
                    else -> "ineligible"
                }
            } catch (_: Throwable) { "ineligible" }
        }
        recordSkip(ctx, why)
        return null
    }

    /** [WP-10c] o handler entregou o genérico porque a decifragem passou do teto / falhou antes do núcleo. */
    @Synchronized
    fun recordSkip(ctx: Context, code: String) {
        try {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val counts = try { JSONObject(sp.getString("counts", "{}") ?: "{}") } catch (_: Throwable) { JSONObject() }
            val k = "skip_" + code.take(30)
            if (counts.has(k) || counts.length() < 40) counts.put(k, counts.optInt(k, 0) + 1)
            sp.edit().putString("counts", counts.toString()).apply()
        } catch (_: Throwable) {}
    }

    /** [WP-10c] Lê e ZERA as métricas (o app sobe no boot via e2ee5_metrics). {"counts":{…},"ms":[…]} */
    @Synchronized
    fun takeMetrics(ctx: Context): String {
        return try {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val out = JSONObject()
                .put("counts", try { JSONObject(sp.getString("counts", "{}") ?: "{}") } catch (_: Throwable) { JSONObject() })
                .put("ms", try { JSONArray(sp.getString("ms", "[]") ?: "[]") } catch (_: Throwable) { JSONArray() })
            sp.edit().remove("counts").remove("ms").apply()
            out.toString()
        } catch (_: Throwable) { "{}" }
    }

    /** Texto da prévia decifrada (só memória) ou null. `lang` = d["lang"] do servidor. */
    fun preview(ctx: Context, uid: String, d: Map<String, String>, lang: String): String? {
        if (Looper.myLooper() == Looper.getMainLooper()) return null
        val t0 = System.currentTimeMillis()
        var outcome = "ok"
        val text: String? = try {
            val cid = conv(d)
            val mid = d["e2e_mid"].orEmpty()
            val inline = d["e2e_c"].orEmpty()
            val env = if (inline.startsWith("{\"e2e\":5")) inline else fetchEnvelope(ctx, uid, cid, mid, t0)
            if (env == null) {
                outcome = "fetch_fail"; null
            } else {
                val left = DEADLINE_MS - (System.currentTimeMillis() - t0)
                val payload = if (left < 500) null else ChatyyCryptoPush.decryptPreview(
                    ctx, uid, cid, mid, d["e2e_cmid"].orEmpty(), d["e2e_sender_uid"].orEmpty(), env, left)
                if (payload == null) {
                    outcome = if (left < 500) "timeout" else "decrypt_null"; null
                } else {
                    render(payload, lang).also { if (it == null) outcome = "no_preview_type" }
                }
            }
        } catch (t: Throwable) {
            outcome = "error:" + t.javaClass.simpleName.take(24); null
        }
        record(ctx, outcome, System.currentTimeMillis() - t0)
        return text
    }

    // ── e2e_fetch → busca a mensagem pelo mid (HTTP curto, Bearer do app) ────────────────────

    private fun fetchEnvelope(ctx: Context, uid: String, cid: String, mid: String, t0: Long): String? {
        val auth = try { ChatyyCryptoAuth.resolve(ctx.applicationContext, uid) } catch (_: Throwable) { null } ?: return null
        // [sgu F0 2026-10-23] sgu_why/device_id: só p/ o contador sgu_body_reads do servidor (motivo
        // fetch_push, por aparelho); campos ignorados por servidor antigo. Nada mais muda no fetch.
        val bodyObj = JSONObject().put("conversation_id", cid.toLong()).put("message_id", mid.toLong())
            .put("before", 1).put("after", 0).put("sgu_why", "fetch_push")
        try {
            val dev = expo.modules.chatyycrypto.ChatyyCryptoSecrets.deviceId(ctx.applicationContext, uid)
            if (Regex("^[A-Z][A-Z2-7]{12}$").matches(dev)) bodyObj.put("device_id", dev)
        } catch (_: Throwable) {}
        val body = bodyObj.toString()
        // 2 tentativas: a réplica regional pode ainda não ter a linha (alguns 100 ms de atraso).
        for (attempt in 0 until 2) {
            if (attempt > 0) {
                if (System.currentTimeMillis() - t0 > DEADLINE_MS - 1500) return null
                Thread.sleep(450)
            }
            val req = Request.Builder()
                .url(auth.base + "/api/email.php?action=chat_load_around")
                .header("Authorization", "Bearer " + auth.bearer)
                .header("Accept", "application/json")
                .post(body.toRequestBody("application/json".toMediaType()))
                .build()
            val raw = try {
                http.newCall(req).execute().use { r -> if (r.isSuccessful) r.body?.string() else null }
            } catch (_: Throwable) { null } ?: return null
            envelopeIn(raw, mid)?.let { return it }
        }
        return null
    }

    private fun envelopeIn(raw: String, mid: String): String? {
        val j = try { JSONObject(raw) } catch (_: Throwable) { return null }
        if (!j.optBoolean("success", false)) return null
        val msgs = j.optJSONObject("data")?.optJSONArray("messages") ?: return null
        for (i in 0 until msgs.length()) {
            val m = msgs.optJSONObject(i) ?: continue
            if (m.opt("id")?.toString() != mid) continue
            val c = m.optString("content", "")
            return if (c.startsWith("{\"e2e\":5")) c else null
        }
        return null
    }

    // ── payload v1 → texto (CONTRATO §2.3/§2.4) — mesmo render da NSE iOS ───────────────────

    fun render(payloadJson: String, lang: String): String? {
        val o = try { JSONObject(payloadJson) } catch (_: Throwable) { return null }
        if (o.optInt("v", 0) != 1) return null
        val L = { k: String -> label(lang, k) }
        fun str(src: JSONObject?, k: String): String =
            (src?.opt(k) as? String)?.trim().orEmpty()
        val media = o.optJSONArray("media") ?: JSONArray()
        val first = media.optJSONObject(0)
        val viewOnce = o.optBoolean("vo", false)
        val out: String = when (o.optString("t", "")) {
            "text", "edit" -> str(o, "body")
            "image" -> when {
                viewOnce -> L("vo_photo")
                media.length() > 1 -> str(o, "caption").ifEmpty { String.format(Locale.ROOT, L("photos_n"), media.length()) }
                else -> str(o, "caption").ifEmpty { L("photo") }
            }
            "video" -> if (viewOnce) L("vo_video")
                else str(o, "caption").ifEmpty { L(if (o.optBoolean("round", false)) "video_note" else "video") }
            "gif" -> L("gif")
            "sticker" -> L("sticker")
            "voice" -> {
                val dur = first?.optDouble("dur", 0.0)?.takeIf { !it.isNaN() } ?: 0.0
                if (dur > 0) {
                    val s = Math.round(dur).toInt()
                    L("voice") + String.format(Locale.ROOT, " (%d:%02d)", s / 60, s % 60)
                } else L("voice")
            }
            "audio" -> str(first, "title").ifEmpty { str(o, "title") }.ifEmpty { L("audio") }
            "file" -> str(first, "name").ifEmpty { str(o, "name") }.ifEmpty { L("file") }
            "location" -> if (o.has("live")) L("live_location") else str(o, "name").ifEmpty { L("location") }
            "contact" -> {
                val n = str(o.optJSONArray("contacts")?.optJSONObject(0), "name")
                if (n.isEmpty()) L("contact") else L("contact") + ": " + n
            }
            "poll" -> str(o, "question").let { if (it.isEmpty()) L("poll") else L("poll") + ": " + it }
            "meetup" -> str(o, "title").let { if (it.isEmpty()) L("meetup") else L("meetup") + ": " + it }
            "reaction" -> str(o, "emoji").let { if (it.isEmpty()) L("reacted") else String.format(Locale.ROOT, L("reacted_with"), it) }
            else -> return null // poll_vote e tipos desconhecidos: fica o genérico
        }
        val clean = out.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        return if (clean.isEmpty()) null else clean.take(300)
    }

    private val STRINGS: Map<String, Map<String, String>> = mapOf(
        "pt" to mapOf("photo" to "Foto", "photos_n" to "%d fotos", "vo_photo" to "Foto de visualização única", "video" to "Vídeo",
            "vo_video" to "Vídeo de visualização única", "video_note" to "Vídeo-recado", "gif" to "GIF", "sticker" to "Figurinha",
            "voice" to "Mensagem de voz", "audio" to "Áudio", "file" to "Arquivo", "location" to "Localização",
            "live_location" to "Localização em tempo real", "contact" to "Contato", "poll" to "Enquete", "meetup" to "Encontro",
            "reacted" to "Reagiu à sua mensagem", "reacted_with" to "Reagiu com %s à sua mensagem"),
        "en" to mapOf("photo" to "Photo", "photos_n" to "%d photos", "vo_photo" to "View once photo", "video" to "Video",
            "vo_video" to "View once video", "video_note" to "Video message", "gif" to "GIF", "sticker" to "Sticker",
            "voice" to "Voice message", "audio" to "Audio", "file" to "File", "location" to "Location",
            "live_location" to "Live location", "contact" to "Contact", "poll" to "Poll", "meetup" to "Event",
            "reacted" to "Reacted to your message", "reacted_with" to "Reacted %s to your message"),
        "es" to mapOf("photo" to "Foto", "photos_n" to "%d fotos", "vo_photo" to "Foto de visualización única", "video" to "Video",
            "vo_video" to "Video de visualización única", "video_note" to "Videomensaje", "gif" to "GIF", "sticker" to "Sticker",
            "voice" to "Mensaje de voz", "audio" to "Audio", "file" to "Archivo", "location" to "Ubicación",
            "live_location" to "Ubicación en tiempo real", "contact" to "Contacto", "poll" to "Encuesta", "meetup" to "Evento",
            "reacted" to "Reaccionó a tu mensaje", "reacted_with" to "Reaccionó con %s a tu mensaje"),
    )

    private fun label(lang: String, k: String): String {
        val l = lang.lowercase().let { if (it.startsWith("en")) "en" else if (it.startsWith("es")) "es" else "pt" }
        return STRINGS[l]?.get(k) ?: STRINGS["pt"]?.get(k) ?: k
    }

    // ── métricas (só código + ms; o app lê/zera — WP-18) ─────────────────────────────────────

    @Synchronized
    private fun record(ctx: Context, outcome: String, ms: Long) {
        try {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val counts = try { JSONObject(sp.getString("counts", "{}") ?: "{}") } catch (_: Throwable) { JSONObject() }
            val k = outcome.take(40)
            if (counts.has(k) || counts.length() < 40) counts.put(k, counts.optInt(k, 0) + 1)
            val lat = try { JSONArray(sp.getString("ms", "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
            lat.put(ms)
            val keep = JSONArray()
            for (i in maxOf(0, lat.length() - 100) until lat.length()) keep.put(lat.optLong(i))
            sp.edit().putString("counts", counts.toString()).putString("ms", keep.toString()).apply()
        } catch (_: Throwable) {}
    }
}
