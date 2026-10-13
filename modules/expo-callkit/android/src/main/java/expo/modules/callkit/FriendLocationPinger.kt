package expo.modules.callkit

// [2026-10-12 find-my] Mapa de amigos — lado Android nativo.
//
// • "Pedir atualização" de um amigo → servidor manda FCM data-only de alta
//   prioridade {type: location_ping} → CallFirebaseMessagingService chama
//   onPing() (thread de trabalho do FCM; podemos bloquear ~10 s) → posição
//   única (LocationManager.getCurrentLocation, timeout) → POST nativo em
//   email.php?action=chat_friend_location_share_update. Não depende do JS.
//
// LIMITAÇÃO (Google, Android 10+): sem ACCESS_BACKGROUND_LOCATION (removida do
// manifest por exigência da Play), a localização só é entregue quando o app
// está "em uso" — Activity visível OU foreground service do tipo location
// iniciado com o app em 1º plano (ex.: localização ao vivo da conversa).
// Com o app fechado o AppOps devolve null e registramos "no_bg_permission".
// Iniciar um foreground service tipo location a partir do push NÃO resolve:
// desde o Android 11 um FGS iniciado em 2º plano não ganha acesso "durante o
// uso" (FCM de alta prioridade não está nas exceções) e no Android 14+ o
// startForeground(type=location) lança SecurityException nesse caso.
//
// Se o founder decidir pedir ACCESS_BACKGROUND_LOCATION (+ declaração na Play
// Console), este mesmo código passa a funcionar com o app fechado sem mudar
// nada: onPing responde e syncPassive() registra atualizações PASSIVAS
// (custo de bateria ~zero: só reaproveita posições que o sistema/Play Services
// já calcularam) via PendingIntent → FriendLocationReceiver.

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

object FriendLocationPinger {
    private const val TAG = "FriendLocation"
    private const val PREFS = "expo_callkit_prefs"
    private const val KEY_ENABLED = "fl_enabled"
    private const val KEY_ACCT = "fl_acct"
    private const val KEY_LAST_POST = "fl_last_post_at"
    private const val KEY_LAST_RESULT = "fl_last_result"
    private const val KEY_PASSIVE = "fl_passive_on"
    private const val BG_PERMISSION = "android.permission.ACCESS_BACKGROUND_LOCATION"
    private const val PASSIVE_REQ_CODE = 73012
    private const val PASSIVE_MIN_MS = 5 * 60 * 1000L
    private const val PASSIVE_MIN_M = 300f
    private const val AUTO_GAP_MS = 60 * 1000L
    private const val PING_FRESH_MS = 45 * 1000L
    private const val CACHE_MAX_AGE_MS = 3 * 60 * 1000L

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun setEnabled(ctx: Context, on: Boolean, acct: String?) {
        try {
            val ed = prefs(ctx).edit().putBoolean(KEY_ENABLED, on)
            val a = ChatNotifStore.normEmail(acct)
            if (on && a.isNotEmpty()) ed.putString(KEY_ACCT, a)
            ed.apply()
        } catch (t: Throwable) { Log.w(TAG, "setEnabled: ${t.message}") }
    }

    fun isEnabled(ctx: Context): Boolean =
        try { prefs(ctx).getBoolean(KEY_ENABLED, false) } catch (_: Throwable) { false }

    private fun granted(ctx: Context, perm: String): Boolean =
        try { ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED } catch (_: Throwable) { false }

    fun hasForegroundPermission(ctx: Context): Boolean =
        granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION) || granted(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)

    fun hasBackgroundPermission(ctx: Context): Boolean {
        if (!hasForegroundPermission(ctx)) return false
        return if (Build.VERSION.SDK_INT < 29) true else granted(ctx, BG_PERMISSION)
    }

    private fun setResult(ctx: Context, r: String) {
        try { prefs(ctx).edit().putString(KEY_LAST_RESULT, r).apply() } catch (_: Throwable) {}
    }

    fun status(ctx: Context): Map<String, Any?> {
        return try {
            val p = prefs(ctx)
            mapOf(
                "enabled" to p.getBoolean(KEY_ENABLED, false),
                "monitoring" to p.getBoolean(KEY_PASSIVE, false),
                "auth" to when {
                    hasBackgroundPermission(ctx) -> "always"
                    hasForegroundPermission(ctx) -> "whenInUse"
                    else -> "denied"
                },
                "backgroundPermission" to hasBackgroundPermission(ctx),
                "lastPostAt" to (p.getLong(KEY_LAST_POST, 0L) / 1000.0),
                "lastResult" to (p.getString(KEY_LAST_RESULT, "") ?: ""),
            )
        } catch (_: Throwable) { mapOf("enabled" to false) }
    }

    /** location_ping? Formato FCM direto (type no topo) ou Expo (JSON em data["body"]). */
    fun isPing(data: Map<String, String>): Boolean {
        if (data["type"] == "location_ping") return true
        val b = data["body"] ?: return false
        if (!b.trimStart().startsWith("{")) return false
        return try { JSONObject(b).optString("type", "") == "location_ping" } catch (_: Throwable) { false }
    }

    /**
     * Push "Pedir atualização". Retorna false quando o envio nativo está
     * desligado (o chamador segue o caminho antigo → JS). Bloqueia ≤ ~10 s —
     * chamar só fora da main thread (onMessageReceived já é).
     */
    fun onPing(ctx: Context): Boolean {
        if (!isEnabled(ctx)) return false
        if (!hasForegroundPermission(ctx)) { setResult(ctx, "no_permission"); return true }
        val now = System.currentTimeMillis()
        val last = try { prefs(ctx).getLong(KEY_LAST_POST, 0L) } catch (_: Throwable) { 0L }
        if (now - last < PING_FRESH_MS) return true
        val loc = currentLocation(ctx, 9000L) ?: lastKnownFresh(ctx, CACHE_MAX_AGE_MS)
        if (loc == null) {
            setResult(ctx, if (hasBackgroundPermission(ctx)) "ping_no_fix" else "ping_no_bg_permission")
            return true
        }
        publish(ctx, loc, "android_ping")
        return true
    }

    /** Atualização passiva (FriendLocationReceiver) — só com permissão de 2º plano. */
    fun onPassive(ctx: Context, loc: Location) {
        if (!isEnabled(ctx)) { stopPassive(ctx); return }
        val now = System.currentTimeMillis()
        val last = try { prefs(ctx).getLong(KEY_LAST_POST, 0L) } catch (_: Throwable) { 0L }
        if (now - last < AUTO_GAP_MS) return
        if (now - loc.time > 10 * 60 * 1000L) return
        publish(ctx, loc, "android_passive")
    }

    /** JS "requestOnce" (diagnóstico). Bloqueante — chamar fora da main thread. */
    fun publishNowBlocking(ctx: Context): Boolean {
        if (!hasForegroundPermission(ctx)) return false
        val loc = currentLocation(ctx, 9000L) ?: lastKnownFresh(ctx, CACHE_MAX_AGE_MS) ?: return false
        return publish(ctx, loc, "android_manual")
    }

    @SuppressLint("MissingPermission")
    private fun currentLocation(ctx: Context, timeoutMs: Long): Location? {
        if (Build.VERSION.SDK_INT < 30) return null
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        val provider = try {
            when {
                lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
                lm.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
                else -> null
            }
        } catch (_: Throwable) { null } ?: return null
        val ref = AtomicReference<Location?>(null)
        val latch = CountDownLatch(1)
        val cancel = CancellationSignal()
        val exec = Executors.newSingleThreadExecutor()
        try {
            lm.getCurrentLocation(provider, cancel, exec) { l: Location? ->
                ref.set(l)
                latch.countDown()
            }
            if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                try { cancel.cancel() } catch (_: Throwable) {}
            }
        } catch (t: Throwable) {
            Log.w(TAG, "getCurrentLocation: ${t.message}")
        } finally {
            try { exec.shutdown() } catch (_: Throwable) {}
        }
        return ref.get()
    }

    @SuppressLint("MissingPermission")
    private fun lastKnownFresh(ctx: Context, maxAgeMs: Long): Location? {
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        var best: Location? = null
        for (p in listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.PASSIVE_PROVIDER)) {
            val l = try { lm.getLastKnownLocation(p) } catch (_: Throwable) { null } ?: continue
            if (best == null || l.time > best.time) best = l
        }
        val b = best ?: return null
        return if (System.currentTimeMillis() - b.time <= maxAgeMs) b else null
    }

    private fun publish(ctx: Context, loc: Location, source: String): Boolean {
        val acct = try { prefs(ctx).getString(KEY_ACCT, "") ?: "" } catch (_: Throwable) { "" }
        val bearer = ChatNotifStore.bearerFor(ctx, acct)
        if (bearer.isNullOrBlank()) { setResult(ctx, "no_bearer"); return false }
        try { prefs(ctx).edit().putLong(KEY_LAST_POST, System.currentTimeMillis()).apply() } catch (_: Throwable) {}
        var conn: HttpURLConnection? = null
        val ok = try {
            val body = JSONObject().apply {
                put("action", "chat_friend_location_share_update")
                put("latitude", loc.latitude)
                put("longitude", loc.longitude)
                if (loc.hasAccuracy()) put("accuracy", loc.accuracy.toDouble())
                if (loc.hasBearing()) put("heading", loc.bearing.toDouble())
                if (loc.hasSpeed()) put("speed", loc.speed.toDouble())
                put("source", source)
            }.toString()
            val url = ChatNotifStore.apiBase(ctx) + "/api/email.php?action=chat_friend_location_share_update"
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
            code in 200..299 && try { JSONObject(resp).optBoolean("success", false) } catch (_: Throwable) { false }
        } catch (t: Throwable) {
            Log.w(TAG, "post failed: ${t.message}")
            false
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
        setResult(ctx, if (ok) "ok" else "post_fail")
        Log.d(TAG, "post $source ok=$ok")
        return ok
    }

    // ---- atualizações passivas (só com ACCESS_BACKGROUND_LOCATION) ----------

    private fun passiveIntent(ctx: Context): PendingIntent {
        val i = Intent(ctx, FriendLocationReceiver::class.java).setPackage(ctx.packageName)
        // MUTABLE: o LocationManager anexa a posição como extra.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(ctx, PASSIVE_REQ_CODE, i, flags)
    }

    /** Liga/desliga as atualizações passivas conforme flag + permissão. */
    @SuppressLint("MissingPermission")
    fun syncPassive(ctx: Context) {
        try {
            if (!isEnabled(ctx) || !hasBackgroundPermission(ctx)) { stopPassive(ctx); return }
            val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return
            lm.requestLocationUpdates(LocationManager.PASSIVE_PROVIDER, PASSIVE_MIN_MS, PASSIVE_MIN_M, passiveIntent(ctx))
            prefs(ctx).edit().putBoolean(KEY_PASSIVE, true).apply()
        } catch (t: Throwable) { Log.w(TAG, "syncPassive: ${t.message}") }
    }

    fun stopPassive(ctx: Context) {
        try {
            if (!prefs(ctx).getBoolean(KEY_PASSIVE, false)) return
            val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            lm?.removeUpdates(passiveIntent(ctx))
            prefs(ctx).edit().putBoolean(KEY_PASSIVE, false).apply()
        } catch (t: Throwable) { Log.w(TAG, "stopPassive: ${t.message}") }
    }
}
