package expo.modules.callkit

import android.content.Context
import android.util.Log
import java.net.URI

/**
 * [2026-10-09 native-transport] Entrada REGIONAL do WebSocket para os sockets
 * nativos (ChatCoreSocket, CallSignalWs, RelayWakeService) — mesma regra do JS
 * (services/websocket.js `_pickWsUrl`):
 *  - o JS escolhe a região (services/api.js / clientLb.js) e a repassa via
 *    ChatyyChatCore.setWsRegion("us"|"br"|"eu") (API 1) ou
 *    ChatyyChatCore.setWsEndpoint(region, url) (API 2, qualquer região válida);
 *    persistida em SharedPreferences → vale também no cold start por FCM
 *    (RelayWakeService);
 *  - regional → wss://api-<id>.chatyy.com.br/ws (TLS termina no edge);
 *  - fallback: socket regional que fecha sem auth_success → a próxima tentativa
 *    vai pro US; se o US autenticar logo em seguida (= problema era do edge)
 *    AQUELA entrada regional fica bloqueada 15 min (bloqueio POR host, como o
 *    websocket.js com client-lb). Se o US também falhar (= rede), volta a
 *    tentar a regional.
 * [2026-10-21 any-region] URL vinda do JS só é aceita se passar validação
 * estrita ([isValidWsUrl]): wss, host ws.chatyy.com.br ou api-<id>.chatyy.com.br
 * (id ^[a-z][a-z0-9]{1,7}$), caminho /ws, sem porta/userinfo/query/fragmento.
 * Thread-safe.
 */
object ChatyyWsEndpoint {
    private const val TAG = "ChatyyWsEndpoint"
    /** Versão da API exposta ao JS (ChatyyChatCore.wsEndpointApi()).
     *  1 = só setWsRegion(br|eu|us); 2 = + setWsEndpoint(region, url). */
    const val API_VERSION = 2
    const val US_URL = "wss://ws.chatyy.com.br/ws"
    private const val US_HOST = "ws.chatyy.com.br"
    private val REGIONAL = mapOf(
        "br" to "wss://api-br.chatyy.com.br/ws",
        "eu" to "wss://api-eu.chatyy.com.br/ws",
    )
    private const val PREFS = "expo_callkit_prefs"
    private const val KEY_REGION = "chatyy_ws_region"
    private const val KEY_URL = "chatyy_ws_url" // API 2 (ausente = mapa fixo da API 1)
    private const val BLOCK_MS = 15 * 60 * 1000L

    private val REGION_RE = Regex("us|[a-z][a-z0-9]{1,7}")
    private val URL_RE = Regex("wss://(ws\\.chatyy\\.com\\.br|api-[a-z][a-z0-9]{1,7}\\.chatyy\\.com\\.br)/ws")

    @Volatile private var cachedRegion: String? = null
    /** "" = sem URL da API 2 (usa REGIONAL[região]); null = ainda não lido. */
    @Volatile private var cachedUrl: String? = null
    /** host regional → bloqueado até (ms) */
    private val blockedUntil = HashMap<String, Long>()
    /** host regional que falhou antes do auth (aguardando o resultado do US) */
    private var failPendingHost: String? = null

    // ── Validação ───────────────────────────────────────────────────────────
    fun isValidRegion(r: String): Boolean = r.length <= 8 && REGION_RE.matches(r)

    /** Validação estrita (string inteira + conferência pelos componentes). */
    fun isValidWsUrl(s: String?): Boolean {
        if (s == null || s.length > 64 || !URL_RE.matches(s)) return false
        return try {
            val u = URI(s)
            u.scheme == "wss" && u.port == -1 && u.rawUserInfo == null && u.rawQuery == null &&
                u.rawFragment == null && u.rawPath == "/ws" && u.host != null &&
                (u.host == US_HOST || (u.host.startsWith("api-") && u.host.endsWith(".chatyy.com.br")))
        } catch (_: Throwable) { false }
    }

    private fun hostOf(url: String?): String? = try { if (url == null) null else URI(url).host } catch (_: Throwable) { null }

    private fun prefs(ctx: Context?) = try {
        ctx?.applicationContext?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    } catch (_: Throwable) { null }

    // ── Escrita (JS) ────────────────────────────────────────────────────────
    /** API 1 (compat): ChatyyChatCore.setWsRegion. Região desconhecida → "us".
     *  Limpa a URL da API 2 → comportamento idêntico ao binário antigo. */
    fun setRegion(ctx: Context?, region: String) {
        val r = region.lowercase()
        val v = if (REGIONAL.containsKey(r)) r else "us"
        cachedRegion = v
        cachedUrl = ""
        try { prefs(ctx)?.edit()?.putString(KEY_REGION, v)?.remove(KEY_URL)?.apply() } catch (_: Throwable) {}
    }

    /** API 2: ChatyyChatCore.setWsEndpoint(region, url). Inválido → false e nada
     *  muda. region "us" (ou URL do US) → volta ao US. */
    fun setEndpoint(ctx: Context?, region: String, url: String): Boolean {
        val r = region.lowercase()
        if (!isValidRegion(r) || !isValidWsUrl(url)) return false
        val toUs = r == "us" || url == US_URL
        val v = if (toUs) "us" else r
        cachedRegion = v
        cachedUrl = if (toUs) "" else url
        try {
            val e = prefs(ctx)?.edit()?.putString(KEY_REGION, v)
            if (toUs) e?.remove(KEY_URL) else e?.putString(KEY_URL, url)
            e?.apply()
        } catch (_: Throwable) {}
        return true
    }

    // ── Leitura ─────────────────────────────────────────────────────────────
    fun region(ctx: Context?): String {
        cachedRegion?.let { return it }
        val v = try { prefs(ctx)?.getString(KEY_REGION, null) } catch (_: Throwable) { null }
        if (v != null) cachedRegion = v
        return v ?: "us"
    }

    /** URL regional configurada (sem fallback/bloqueio). null = US. */
    private fun configuredUrl(ctx: Context?): String? {
        var u = cachedUrl
        if (u == null) {
            u = (try { prefs(ctx)?.getString(KEY_URL, null) } catch (_: Throwable) { null }) ?: ""
            cachedUrl = u
        }
        if (u.isNotEmpty()) {
            // revalida o que veio do disco
            return if (isValidWsUrl(u) && u != US_URL) u else null
        }
        return REGIONAL[region(ctx)]
    }

    private fun pickLocked(ctx: Context?): String {
        val u = configuredUrl(ctx) ?: return US_URL
        val h = hostOf(u) ?: return US_URL
        if (failPendingHost == h) return US_URL
        if (System.currentTimeMillis() < (blockedUntil[h] ?: 0L)) return US_URL
        return u
    }

    /** URL para a PRÓXIMA conexão. */
    @Synchronized
    fun pick(ctx: Context?): String = pickLocked(ctx)

    fun isRegional(url: String?): Boolean = url != null && url != US_URL

    /** Socket em [url] fechou/falhou ANTES do auth_success. */
    @Synchronized
    fun noteFailedBeforeAuth(url: String?) {
        if (isRegional(url)) {
            failPendingHost = hostOf(url) ?: failPendingHost
        } else if (failPendingHost != null) {
            failPendingHost = null // US também falhou → rede, não o edge
        }
    }

    /** Socket em [url] recebeu auth_success. */
    @Synchronized
    fun noteAuthed(url: String?) {
        val h = failPendingHost
        if (!isRegional(url) && h != null) {
            blockedUntil[h] = System.currentTimeMillis() + BLOCK_MS
            Log.w(TAG, "regional $h falhou e US autenticou → bloqueada 15 min")
        }
        failPendingHost = null
    }

    @Synchronized
    fun snapshot(ctx: Context?): Map<String, Any?> {
        val now = System.currentTimeMillis()
        val cur = configuredUrl(ctx)
        val curHost = hostOf(cur)
        val blocked = HashMap<String, Double>()
        var curBlock = 0.0
        for ((h, until) in blockedUntil) {
            if (until > now) {
                blocked[h] = until.toDouble()
                if (h == curHost) curBlock = until.toDouble()
            }
        }
        return mapOf(
            "api" to API_VERSION,
            "region" to region(ctx),
            "configuredUrl" to (cur ?: US_URL),
            "failPending" to (failPendingHost != null),
            "blockedUntilMs" to curBlock,
            "blocked" to blocked,
            "url" to pickLocked(ctx),
        )
    }
}
