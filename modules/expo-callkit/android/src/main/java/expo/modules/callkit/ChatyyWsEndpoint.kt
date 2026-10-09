package expo.modules.callkit

import android.content.Context
import android.util.Log

/**
 * [2026-10-09 native-transport] Entrada REGIONAL do WebSocket para os sockets
 * nativos (ChatCoreSocket, CallSignalWs, RelayWakeService) — mesma regra do JS
 * (services/websocket.js `_pickWsUrl`):
 *  - o JS escolhe a região (services/api.js: region_hint + probe com histerese)
 *    e a repassa via ChatyyChatCore.setWsRegion("us"|"br"|"eu"); persistida em
 *    SharedPreferences → vale também no cold start por FCM (RelayWakeService);
 *  - br/eu → wss://api-<região>.chatyy.com.br/ws (TLS termina no edge, que leva
 *    o upgrade pelo túnel WireGuard até o MESMO hub Go do US);
 *  - fallback: socket regional que fecha sem auth_success → a próxima tentativa
 *    vai pro US; se o US autenticar logo em seguida (= problema era do edge) a
 *    regional fica bloqueada 15 min. Se o US também falhar (= rede), volta a
 *    tentar a regional.
 * Só hosts fixos (nenhuma URL arbitrária vinda do JS). Thread-safe.
 */
object ChatyyWsEndpoint {
    private const val TAG = "ChatyyWsEndpoint"
    const val US_URL = "wss://ws.chatyy.com.br/ws"
    private val REGIONAL = mapOf(
        "br" to "wss://api-br.chatyy.com.br/ws",
        "eu" to "wss://api-eu.chatyy.com.br/ws",
    )
    private const val PREFS = "expo_callkit_prefs"
    private const val KEY_REGION = "chatyy_ws_region"
    private const val BLOCK_MS = 15 * 60 * 1000L

    @Volatile private var cachedRegion: String? = null
    private var blockedUntil = 0L
    private var failPending = false

    /** Chamado pelo JS (ChatyyChatCore.setWsRegion). Região desconhecida → "us". */
    fun setRegion(ctx: Context?, region: String) {
        val r = region.lowercase()
        val v = if (REGIONAL.containsKey(r)) r else "us"
        cachedRegion = v
        try {
            ctx?.applicationContext
                ?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                ?.edit()?.putString(KEY_REGION, v)?.apply()
        } catch (_: Throwable) {}
    }

    fun region(ctx: Context?): String {
        cachedRegion?.let { return it }
        val v = try {
            ctx?.applicationContext
                ?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                ?.getString(KEY_REGION, null)
        } catch (_: Throwable) { null }
        if (v != null) cachedRegion = v
        return v ?: "us"
    }

    /** URL para a PRÓXIMA conexão. */
    @Synchronized
    fun pick(ctx: Context?): String {
        if (failPending || System.currentTimeMillis() < blockedUntil) return US_URL
        return REGIONAL[region(ctx)] ?: US_URL
    }

    fun isRegional(url: String?): Boolean = url != null && url != US_URL

    /** Socket em [url] fechou/falhou ANTES do auth_success. */
    @Synchronized
    fun noteFailedBeforeAuth(url: String?) {
        if (isRegional(url)) {
            failPending = true
        } else if (failPending) {
            failPending = false // US também falhou → rede, não o edge
        }
    }

    /** Socket em [url] recebeu auth_success. */
    @Synchronized
    fun noteAuthed(url: String?) {
        if (!isRegional(url) && failPending) {
            blockedUntil = System.currentTimeMillis() + BLOCK_MS
            Log.w(TAG, "regional falhou e US autenticou → regional bloqueada 15 min")
        }
        failPending = false
    }

    @Synchronized
    fun snapshot(ctx: Context?): Map<String, Any?> = mapOf(
        "region" to region(ctx),
        "failPending" to failPending,
        "blockedUntilMs" to blockedUntil.toDouble(),
        "url" to (if (failPending || System.currentTimeMillis() < blockedUntil) US_URL else (REGIONAL[region(ctx)] ?: US_URL)),
    )
}
