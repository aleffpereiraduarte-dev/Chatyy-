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
    // [2026-10-18 calls-data] "<token sha1 prefix>|<email>" já gravados (2xx).
    private const val KEY_DONE = "push_fcm_native_done"
    @Volatile private var ensureInFlight = false
    @Volatile private var lastEnsureAt = 0L

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

    /**
     * [2026-10-18 calls-data] fcm_first_launch (call_res_flags). Instalação nova:
     * o onNewToken roda ANTES do login (nenhuma conta → nada pendente) e o
     * fcm_device só subia pelo JS — que perdia corridas (4xpub0bxw, 6s4pjdjtu:
     * 21 min só com token Expo → sem toque nativo). Agora, assim que há bearer
     * (persistAuthForNativeCall / setNativeUserEmail / setPushRegistrationInfo):
     * pega o token FCM do SO e registra fcm_device p/ cada conta que AINDA não
     * tem ESTE token gravado (marca por token+conta; depois disso é no-op).
     * Nunca lança; ≤ 1×/20 s.
     */
    fun ensureRegistered(ctx: Context, reason: String) {
        try {
            val app = ctx.applicationContext
            if (!CallResilience.flags(app).fcmFirstLaunch) return
            val now = System.currentTimeMillis()
            if (ensureInFlight || now - lastEnsureAt < 20_000L) return
            lastEnsureAt = now
            ensureInFlight = true
            val done: (String?) -> Unit = { tok ->
                try {
                    if (!tok.isNullOrBlank()) {
                        Thread({
                            try { queueMissing(app, tok, reason) } catch (_: Throwable) {}
                            ensureInFlight = false
                        }, "chatyy-push-reg").apply { isDaemon = true }.start()
                    } else {
                        ensureInFlight = false
                    }
                } catch (_: Throwable) { ensureInFlight = false }
            }
            try {
                com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                    .addOnCompleteListener { t ->
                        val tok = try { if (t.isSuccessful) t.result else null } catch (_: Throwable) { null }
                        done(tok)
                    }
            } catch (t: Throwable) {
                Log.w(TAG, "ensureRegistered: FCM token unavailable: ${t.message}")
                // Firebase não inicializado: usa o último token persistido.
                val cached = try { app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null) } catch (_: Throwable) { null }
                done(cached)
            }
        } catch (_: Throwable) { ensureInFlight = false }
    }

    private fun tokenTag(token: String): String = try {
        val md = java.security.MessageDigest.getInstance("SHA-1")
        md.digest(token.toByteArray(StandardCharsets.UTF_8)).take(6).joinToString("") { "%02x".format(it) }
    } catch (_: Throwable) { token.takeLast(8) }

    private fun queueMissing(ctx: Context, token: String, reason: String) {
        val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val accounts = accountBearers(ctx)
        if (accounts.isEmpty()) return
        val tag = tokenTag(token)
        val doneArr = try { JSONArray(sp.getString(KEY_DONE, "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
        val doneSet = HashSet<String>()
        for (i in 0 until doneArr.length()) doneSet.add(doneArr.optString(i, ""))
        val pendArr = try { JSONArray(sp.getString(KEY_PENDING, "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
        val pendSet = LinkedHashSet<String>()
        for (i in 0 until pendArr.length()) pendArr.optString(i, "").takeIf { it.isNotBlank() }?.let { pendSet.add(it) }
        val oldTok = sp.getString(KEY_TOKEN, "") ?: ""
        var added = 0
        for (email in accounts.keys) {
            if (doneSet.contains("$tag|$email")) continue
            if (pendSet.add(email)) added++
        }
        if (added == 0 && oldTok == token) return
        val out = JSONArray()
        for (e in pendSet) out.put(e)
        sp.edit().putString(KEY_TOKEN, token).putString(KEY_PENDING, out.toString()).apply()
        Log.d(TAG, "ensureRegistered($reason): queued=$added pending=${pendSet.size}")
        try { CallDiag.log("push_fcm_ensure", "", "reason=$reason queued=$added", ctx) } catch (_: Throwable) {}
        if (pendSet.isNotEmpty()) flushNow(ctx)
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
            val doneNow = ArrayList<String>()
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
                    .put("caps", "fcm_native_v1,fcm_native_call," + ChatPushMini.CAP) // [push-minimo 2026-10-24] binário que busca o push mínimo
                    .put("device_accounts", all)
                if (deviceId.isNotBlank()) body.put("device_id", deviceId)
                if (appVer.isNotBlank()) body.put("app_version", appVer)
                val code = post("$base/api/email.php?action=register_push_token", bearer, body)
                if (code in 200..299) {
                    doneNow.add("${tokenTag(token)}|$email")
                } else if (code != 401 && code != 403) {
                    still.put(email) // rede / 5xx → tenta de novo; 401/403 = bearer morto
                }
            }
            val ed = sp.edit().putString(KEY_PENDING, still.toString())
            if (doneNow.isNotEmpty()) {
                // [2026-10-18 calls-data] marca token+conta gravados (≤ 24 entradas).
                val prev = try { JSONArray(sp.getString(KEY_DONE, "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
                val all2 = ArrayList<String>()
                for (i in 0 until prev.length()) prev.optString(i, "").takeIf { it.isNotBlank() && it !in doneNow }?.let { all2.add(it) }
                all2.addAll(doneNow)
                val keep = JSONArray()
                for (x in all2.takeLast(24)) keep.put(x)
                ed.putString(KEY_DONE, keep.toString())
            }
            ed.apply()
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
                // [2026-10-18 calls-data] 1º launch: ChatNotifStore ainda vazio →
                // e-mail do setNativeUserEmail + bearer do persistAuthForNativeCall.
                if (out.isEmpty() && legacy.isNotBlank() && CallResilience.flags(ctx).fcmFirstLaunch) {
                    val de = sp.getString("diag_user_email", "") ?: ""
                    if (de.isNotBlank()) out[ChatNotifStore.normEmail(de)] = legacy
                }
            }
        } catch (_: Throwable) {}
        return out
    }

    /** HTTP status (-1 = rede). */
    private fun post(url: String, bearer: String, body: JSONObject): Int {
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
            code
        } catch (t: Throwable) {
            Log.w(TAG, "post failed: ${t.message}")
            -1
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }
}
