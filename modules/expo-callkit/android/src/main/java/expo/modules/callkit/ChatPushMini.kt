// [push-minimo 2026-10-24] PUSH MÍNIMO de chat (modelo WhatsApp) — lado Android.
//
// O servidor (push-mini.php, só p/ aparelhos com caps "pmin1" da allowlist) manda um FCM SÓ DE DADOS,
// prioridade alta, no envelope Expo (data["body"] = JSON) com apenas: type, conversation_id, message_id,
// d_ack, pmin="1" + o genérico "Nova mensagem" (title "Chatyy"). Nada de texto/nome/avatar/envelope E2EE
// passa pelo Google. Aqui o aparelho:
//   1. lê a conta do d_ack (campo "e"; a assinatura quem confere é o servidor) e o Bearer dela
//      (ChatNotifStore — o mesmo do Responder/Marcar lida);
//   2. POST chat_push_fetch {d_ack, platform: android} (US, ≤ TIMEOUT_MS) → `env` = o MESMO envelope que o
//      push completo levaria (texto, nome, avatar, bg_* p/ o journal, e2e_c p/ decifrar);
//   3. devolve um RemoteMessage novo com data["body"] = env → o resto do CallFirebaseMessagingService segue
//      igual (journal → ✓✓ chat_push_delivered com persisted → MessagingStyle/E2EE → delegate Expo se o app
//      estiver aberto).
// Falhou (sem Bearer, rede, 4xx/5xx, miss, tempo) → null: segue com o aviso mínimo = "Nova mensagem" e o ✓✓
// de recebimento (mesma semântica de hoje).
// BLOQUEANTE: chamar fora da main thread (onMessageReceived já roda numa worker thread).
// Nunca loga conteúdo, token nem e-mail — só códigos e ms (logcat ChatyyPushT).
package expo.modules.callkit

import android.content.Context
import android.os.Looper
import android.util.Base64
import android.util.Log
import com.google.firebase.messaging.RemoteMessage
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object ChatPushMini {
    const val CAP = "pmin1"
    private const val TAG = "ChatyyPushT"
    private const val TIMEOUT_MS = 3000L
    private const val FETCH_URL = "https://chatyy.com.br/api/email.php?action=chat_push_fetch"
    private const val PREFS = "chatyy_push_mini"
    private val CHAT_TYPES = setOf("chat_message", "chat_mention", "chat_keyword")

    class Expanded(val message: RemoteMessage, val data: Map<String, String>)

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .callTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .cookieJar(okhttp3.CookieJar.NO_COOKIES)
            .cache(null)
            .build()
    }

    /** Campos do aviso mínimo (topo ou envelope Expo), ou null se não é um push mínimo. */
    fun miniFields(data: Map<String, String>): Map<String, String>? {
        if (data["pmin"] == "1") return data
        val raw = data["body"] ?: return null
        if (!raw.trimStart().startsWith("{") || !raw.contains("\"pmin\"")) return null
        return try {
            val j = JSONObject(raw)
            if (j.optString("pmin") != "1") return null
            val out = HashMap<String, String>()
            val it = j.keys()
            while (it.hasNext()) { val k = it.next(); val v = j.opt(k); if (v != null && v != JSONObject.NULL) out[k] = v.toString() }
            out
        } catch (_: Throwable) { null }
    }

    fun isMini(data: Map<String, String>): Boolean = miniFields(data) != null

    /** Conta do payload do d_ack (só p/ escolher o Bearer — quem valida é o servidor). */
    private fun acctOfDack(tok: String): String {
        return try {
            val b = tok.substringBefore('.')
            val j = JSONObject(String(Base64.decode(b, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP), Charsets.UTF_8))
            ChatNotifStore.normEmail(j.optString("e", ""))
        } catch (_: Throwable) { "" }
    }

    private fun bump(ctx: Context, code: String) {
        try {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            sp.edit().putInt("n_" + code.take(24), sp.getInt("n_" + code.take(24), 0) + 1).apply()
        } catch (_: Throwable) {}
    }

    /** Busca a mensagem real. null = fica o aviso genérico. */
    fun expand(ctx: Context, message: RemoteMessage, data: Map<String, String>): Expanded? {
        if (Looper.myLooper() == Looper.getMainLooper()) return null
        val m = miniFields(data) ?: return null
        val t0 = System.currentTimeMillis()
        fun fail(code: String): Expanded? {
            bump(ctx, code)
            Log.i(TAG, "pmin fail=$code ms=${System.currentTimeMillis() - t0}")
            return null
        }
        val type = m["type"].orEmpty()
        if (type !in CHAT_TYPES) return fail("type")
        val dack = m["d_ack"].orEmpty()
        if (!dack.contains('.')) return fail("no_dack")
        val bearer = ChatNotifStore.bearerFor(ctx, acctOfDack(dack)) ?: return fail("no_bearer")
        val body = JSONObject().put("d_ack", dack).put("platform", "android").toString()
        val req = Request.Builder()
            .url(FETCH_URL)
            .post(body.toRequestBody("application/json".toMediaType()))
            .header("Authorization", "Bearer $bearer")
            .header("Accept", "application/json")
            .header("X-Platform", "android")
            .build()
        val env: JSONObject = try {
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return fail("http_" + resp.code)
                val j = JSONObject(resp.body?.string() ?: return fail("empty"))
                if (!j.optBoolean("success", false)) return fail("not_success")
                val d = j.optJSONObject("data") ?: return fail("no_data")
                if (d.optInt("hit", 0) != 1) return fail("miss_" + d.optString("skipped", "?").take(16))
                d.optJSONObject("env") ?: return fail("no_env")
            }
        } catch (t: java.io.InterruptedIOException) {
            return fail("timeout")
        } catch (t: Throwable) {
            return fail("net")
        }
        // Mesmo aviso? (nunca mostra o conteúdo de outra mensagem/conversa)
        if (env.optString("conversation_id") != m["conversation_id"].orEmpty() ||
            env.optString("message_id") != m["message_id"].orEmpty() ||
            env.optString("type") !in CHAT_TYPES) return fail("mismatch")
        val newData = HashMap<String, String>()
        newData["body"] = env.toString()
        val b = RemoteMessage.Builder("chatyy-pmin@fcm.googleapis.com").setData(newData)
        message.messageId?.let { b.setMessageId(it) }
        bump(ctx, "ok")
        Log.i(TAG, "pmin ok ms=${System.currentTimeMillis() - t0} e2e=${if (env.optString("e2e") == "5") 1 else 0}")
        return Expanded(b.build(), newData)
    }
}
