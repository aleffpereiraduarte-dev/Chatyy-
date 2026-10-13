package expo.modules.callkit

// [2026-10-13 push-token-always] PushTokenRegistrar — re-registra o token FCM
// NATIVO no servidor quando o Firebase o renova (onNewToken), mesmo com o app
// FECHADO (sem JS). Antes o token novo só chegava ao servidor na próxima
// abertura do app → até lá todo push ia p/ um token morto.
//
//   • Persiste o token em SharedPreferences ("expo_callkit_prefs") com a marca
//     "pendente" e tenta POSTar register_push_token p/ CADA conta logada no
//     aparelho (bearers do ChatNotifStore; fallback = bearer legado auth_token).
//   • device_id + versão do app vêm do JS (setPushRegistrationInfo) — o mesmo
//     device_id que o JS usa, p/ o servidor substituir o token antigo deste
//     aparelho em vez de acumular.
//   • Falhou (sem rede)? Fica pendente; flushPending() re-tenta no próximo
//     push recebido / próxima renovação, e o JS re-registra ao abrir o app.
//   • Nunca lança; nunca loga o token.

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

object PushTokenRegistrar {
    private const val TAG = "PushTokenRegistrar"
    private const val PREFS = "expo_callkit_prefs"
    private const val KEY_TOKEN = "push_fcm_native_token"
    private const val KEY_PENDING = "push_fcm_native_pending"     // JSON array de emails pendentes
    private const val KEY_DEVICE_ID = "push_device_id"
    private const val KEY_APP_VERSION = "push_app_version"
    private const val KEY_TOKENS = "chat_auth_tokens"             // ChatNotifStore: {email: bearer}
    private const val KEY_LAST_FLUSH = "push_fcm_native_last_flush"

    fun setInfo(ctx: Context, deviceId: String?, appVersion: String?) {
        try {
            val ed = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            if (!deviceId.isNullOrBlank()) ed.putString(KEY_DEVICE_ID, deviceId.take(100))
            if (!appVersion.isNullOrBlank()) ed.putString(KEY_APP_VERSION, appVersion.take(40))
            ed.apply()
        } catch (_: Throwable) {}
    }

    /** Chamado pelo CallFirebaseMessagingService.onNewToken. */
    fun onNewToken(ctx: Context, token: String) {
        if (token.isBlank()) return
        try {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val accounts = accountBearers(ctx)
            val pending = JSONArray()
            for (email in accounts.keys) pending.put(email)
            sp.edit()
                .putString(KEY_TOKEN, token)
                .putString(KEY_PENDING, pending.toString())
                .apply()
        } catch (t: Throwable) {
            Log.w(TAG, "persist failed: ${t.message}")
        }
        Thread({ flushNow(ctx.applicationContext) }, "chatyy-push-reg").apply { isDaemon = true }.start()
    }

    /** Re-tenta registros pendentes (barato quando não há nada; ≤ 1×/5 min). */
    fun flushPending(ctx: Context) {
        try {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val pend = sp.getString(KEY_PENDING, "[]") ?: "[]"
            if (pend == "[]" || pend.isBlank()) return
            val now = System.currentTimeMillis()
            if (now - sp.getLong(KEY_LAST_FLUSH, 0L) < 5 * 60 * 1000L) return
            sp.edit().putLong(KEY_LAST_FLUSH, now).apply()
            Thread({ flushNow(ctx.applicationContext) }, "chatyy-push-reg").apply { isDaemon = true }.start()
        } catch (_: Throwable) {}
    }

    @Synchronized
    private fun flushNow(ctx: Context) {
        try {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val token = sp.getString(KEY_TOKEN, "") ?: ""
            if (token.isBlank()) return
            val pendArr = try { JSONArray(sp.getString(KEY_PENDING, "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
            if (pendArr.length() == 0) return
            val bearers = accountBearers(ctx)
            val deviceId = sp.getString(KEY_DEVICE_ID, "") ?: ""
            val appVer = sp.getString(KEY_APP_VERSION, "") ?: ""
            // Sempre o master US (tokens.json mora lá; o edge só repassaria).
            val base = "https://chatyy.com.br"
            val still = JSONArray()
            val all = JSONArray()
            for (e in bearers.keys) all.put(e)
            for (i in 0 until pendArr.length()) {
                val email = pendArr.optString(i, "")
                val bearer = bearers[email]
                if (email.isBlank() || bearer.isNullOrBlank()) continue   // conta saiu do aparelho
                val body = JSONObject()
                    .put("token", token)
                    .put("platform", "android")
                    .put("token_type", "fcm_device")
                    .put("source", "native_on_new_token")
                    .put("caps", "fcm_native_v1")
                    .put("device_accounts", all)
                if (deviceId.isNotBlank()) body.put("device_id", deviceId)
                if (appVer.isNotBlank()) body.put("app_version", appVer)
                if (!post("$base/api/email.php?action=register_push_token", bearer, body)) still.put(email)
            }
            sp.edit().putString(KEY_PENDING, still.toString()).apply()
            Log.d(TAG, "flush done pending=${still.length()}")
        } catch (t: Throwable) {
            Log.w(TAG, "flush failed: ${t.message}")
        }
    }

    /** {email normalizado: bearer} de todas as contas logadas (ChatNotifStore) + legado. */
    private fun accountBearers(ctx: Context): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        try {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val j = try { JSONObject(sp.getString(KEY_TOKENS, "{}") ?: "{}") } catch (_: Throwable) { JSONObject() }
            val it = j.keys()
            while (it.hasNext()) {
                val k = it.next()
                val v = j.optString(k, "")
                if (k.isNotBlank() && v.isNotBlank()) out[ChatNotifStore.normEmail(k)] = v
            }
            if (out.isEmpty()) {
                val act = ChatNotifStore.activeEmail(ctx)
                val legacy = sp.getString("auth_token", "") ?: ""
                if (act.isNotBlank() && legacy.isNotBlank()) out[act] = legacy
            }
        } catch (_: Throwable) {}
        return out
    }

    private fun post(url: String, bearer: String, body: JSONObject): Boolean {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 6_000
                readTimeout = 10_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer $bearer")
            }
            conn.outputStream.use { it.write(body.toString().toByteArray(StandardCharsets.UTF_8)) }
            val code = conn.responseCode
            Log.d(TAG, "register_push_token HTTP $code")
            // 2xx = gravado; 401/403 = bearer morto (conta saiu) → não insiste.
            code in 200..299 || code == 401 || code == 403
        } catch (t: Throwable) {
            Log.w(TAG, "post failed: ${t.message}")
            false
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }
}
