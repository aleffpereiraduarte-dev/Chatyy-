package expo.modules.chatyytransport

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.net.URI
import java.util.ArrayDeque
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

/**
 * [2026-10-15 native-transport] Transporte realtime NATIVO do Chatyy.
 *
 * O WebSocket com o hub Go (:8084, direto em ws.chatyy.com.br ou pela entrada
 * regional api-<região>.chatyy.com.br) deixa de morar no JS. O JS
 * (services/websocket.js) continua dono da lógica de negócio e enxerga isto
 * como um WebSocket "lógico" (shim em services/nativeTransport.js) que NÃO cai
 * quando o fio físico cai:
 *
 *   - conecta e AUTENTICA sozinho (frame de auth recebido do JS — token só em
 *     memória, nunca persistido aqui); a cada reconexão física reenvia o auth
 *     antes de qualquer outra coisa, sem esperar a thread JS;
 *   - keepalive: ping de app ({type:ping}) no intervalo pedido pelo JS
 *     (idle 20 s / conversa 5 s / chamada 8 s); cada ping arma um prazo; nenhum
 *     frame até o prazo = socket zumbi (half-open) → reconecta. Pong vira um
 *     frame sintético {type:pong, rtt} (RTT medido aqui, sem atraso de JS);
 *   - reconexão com backoff + jitter (0 → ~300 ms → ~1 s → ~2 s → exponencial
 *     até 10 s), IMEDIATA na troca de rede (ConnectivityManager default
 *     network) e na volta ao primeiro plano (sonda de 2,5 s se o socket ainda
 *     parece vivo); pausa enquanto offline / em segundo plano (igual ao JS);
 *   - entrada regional preferida com queda para a US (mesma regra do JS:
 *     regional falhou antes do auth → próxima tentativa US; US autenticou logo
 *     depois → regional bloqueada 15 min);
 *   - fila de saída: frames enviados pelo JS enquanto o fio está caído ficam
 *     aqui (dedupe por client_message_id / msg_id / req_id — o servidor também
 *     dedupa) e saem logo após o próximo auth_success;
 *   - frames recebidos são classificados numa thread de fundo e entregues ao
 *     JS em LOTE (um evento com array, janela de 16 ms);
 *   - estado exposto ao JS (connecting/open/authed/reconnecting/offline/
 *     paused/auth_wait/closed/failed).
 *
 * Fechamentos 4000-4999 do hub (4002 session_replaced, 4009 superseded…) são
 * decisões de NEGÓCIO → repassados ao JS como close do socket lógico.
 * Todo estado vive numa única thread ("chatyy-transport") → sem locks.
 */
internal object ChatTransport {
  private const val TAG = "ChatyyTransport"
  const val VERSION = 1

  private val exec = ScheduledThreadPoolExecutor(1) { r ->
    Thread(r, "chatyy-transport").apply { isDaemon = true }
  }.apply { removeOnCancelPolicy = true }

  /** (eventName, body) → Module.sendEvent. Setado no OnCreate do módulo. */
  @Volatile var emitter: ((String, Map<String, Any?>) -> Unit)? = null

  private var inited = false
  private var session: Session? = null

  // Estado do aparelho (só na thread do transporte).
  internal var foreground = true
  internal var netUp = true
  internal var currentNetwork: Network? = null
  private var cm: ConnectivityManager? = null

  // Fallback regional→US (por processo, como no JS).
  internal var regionalFailPending = false
  internal var regionalBlockedUntil = 0L

  internal val stats = HashMap<String, Long>()

  internal val client: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(10, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .writeTimeout(15, TimeUnit.SECONDS)
      .pingInterval(0, TimeUnit.MILLISECONDS) // keepalive é o ping de app (o hub pinga a cada 25 s e o OkHttp responde)
      .retryOnConnectionFailure(false)
      .build()
  }

  internal fun now(): Long = SystemClock.elapsedRealtime()

  internal fun bump(k: String, n: Long = 1) {
    stats[k] = (stats[k] ?: 0L) + n
  }

  internal fun post(fn: () -> Unit) {
    try {
      exec.execute { guard(fn) }
    } catch (_: RejectedExecutionException) {}
  }

  internal fun schedule(ms: Long, fn: () -> Unit): ScheduledFuture<*>? = try {
    exec.schedule({ guard(fn) }, max(0L, ms), TimeUnit.MILLISECONDS)
  } catch (_: RejectedExecutionException) { null }

  internal fun scheduleRepeating(ms: Long, fn: () -> Unit): ScheduledFuture<*>? = try {
    exec.scheduleWithFixedDelay({ guard(fn) }, ms, ms, TimeUnit.MILLISECONDS)
  } catch (_: RejectedExecutionException) { null }

  private fun guard(fn: () -> Unit) {
    try {
      fn()
    } catch (t: Throwable) {
      Log.w(TAG, "internal error", t)
      bump("internalErrors")
      try { session?.fail("internal: " + (t.message ?: t.javaClass.simpleName)) } catch (_: Throwable) {}
    }
  }

  internal fun emit(name: String, body: Map<String, Any?>) {
    try { emitter?.invoke(name, body) } catch (t: Throwable) { Log.w(TAG, "emit $name failed", t) }
  }

  // ─── Ciclo de vida / rede ────────────────────────────────────────────────

  fun init(ctx: Context) {
    val appCtx = ctx.applicationContext ?: ctx
    // Primeiro plano inicial ANTES de registrar (contador de activities parte dele).
    val fg = isProcessForeground(appCtx)
    post {
      if (inited) return@post
      inited = true
      foreground = fg
      registerNetwork(appCtx)
    }
    registerLifecycle(appCtx, fg)
  }

  private fun isProcessForeground(ctx: Context): Boolean = try {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
  } catch (_: Throwable) { true }

  @Volatile private var lifecycleRegistered = false

  private fun registerLifecycle(ctx: Context, initialFg: Boolean) {
    if (lifecycleRegistered) return
    val app = ctx as? Application ?: return
    lifecycleRegistered = true
    try {
      app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
        // Só tocado na main thread. Parte de 1 se já estávamos visíveis (o módulo
        // nasce depois da MainActivity) → CallActivity por cima não vira "background".
        private var started = if (initialFg) 1 else 0
        override fun onActivityStarted(activity: Activity) {
          started++
          if (started == 1) post { setForeground(true) }
        }
        override fun onActivityStopped(activity: Activity) {
          started = max(0, started - 1)
          if (started == 0) post { setForeground(false) }
        }
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
      })
    } catch (t: Throwable) {
      Log.w(TAG, "lifecycle callbacks unavailable", t)
    }
  }

  private fun registerNetwork(ctx: Context) {
    val c = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    cm = c
    try {
      currentNetwork = c.activeNetwork
      netUp = currentNetwork != null
    } catch (_: Throwable) {}
    try {
      c.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { post { onNetAvailable(network) } }
        override fun onLost(network: Network) { post { onNetLost(network) } }
      })
    } catch (t: Throwable) {
      // Sem callback (permissão/limite de callbacks) → segue sem reação a rede;
      // o keepalive continua detectando socket morto.
      Log.w(TAG, "network callback unavailable", t)
      netUp = true
    }
  }

  private fun onNetAvailable(network: Network) {
    if (netUp && currentNetwork == network) return
    val wasDown = !netUp
    currentNetwork = network
    netUp = true
    bump("netChanges")
    session?.onNetwork(if (wasDown) "net_up" else "net_change")
  }

  private fun onNetLost(network: Network) {
    if (network != currentNetwork) return
    currentNetwork = null
    netUp = false
    bump("netLost")
    session?.onNetDown()
  }

  private var bgAt = 0L

  private fun setForeground(fg: Boolean) {
    if (foreground == fg) return
    foreground = fg
    val bgMs = if (fg && bgAt > 0) now() - bgAt else 0L
    if (!fg) bgAt = now()
    session?.onForeground(fg, bgMs)
  }

  // ─── API (chamada pela thread JS → posta na thread do transporte) ───────

  /** Valida já (lança → JS cai para o WebSocket JS) e abre a sessão. */
  fun open(sid: String, cfg: Map<String, Any?>) {
    val urls = (cfg["urls"] as? List<*>)?.mapNotNull { it as? String }?.filter { it.isNotEmpty() } ?: emptyList()
    require(urls.isNotEmpty()) { "no urls" }
    for (u in urls) require(isAllowedUrl(u)) { "url not allowed: $u" }
    val c = SessionConfig(
      urls = urls.take(2),
      authFrame = cfg["authFrame"] as? String,
      pingIntervalMs = num(cfg["pingIntervalMs"], 20000L, 2000L, 120000L),
      pongDeadlineMs = num(cfg["pongDeadlineMs"], 10000L, 1500L, 60000L),
      authWatchdogMs = num(cfg["authWatchdogMs"], 6000L, 2000L, 30000L),
      connectTimeoutMs = num(cfg["connectTimeoutMs"], 10000L, 3000L, 30000L),
      fgProbeMs = num(cfg["fgProbeMs"], 2500L, 1000L, 10000L),
      batchMs = num(cfg["batchMs"], 16L, 0L, 250L),
      outboxMax = num(cfg["outboxMax"], 500L, 10L, 2000L).toInt(),
    )
    post {
      session?.close(1000, "replaced", emitClosed = false)
      val s = Session(sid, c)
      session = s
      bump("sessions")
      s.connect("open")
    }
  }

  fun send(sid: String, text: String): Boolean {
    post { session?.takeIf { it.sid == sid }?.sendFromJs(text) }
    return true
  }

  fun close(sid: String, code: Int, reason: String) {
    post {
      val s = session ?: return@post
      if (s.sid != sid) return@post
      s.close(code, reason, emitClosed = false)
      session = null
    }
  }

  fun setHeartbeat(sid: String, intervalMs: Long, deadlineMs: Long) {
    post { session?.takeIf { it.sid == sid }?.setHeartbeat(intervalMs, deadlineMs) }
  }

  fun probe(sid: String, ms: Long) {
    post { session?.takeIf { it.sid == sid }?.probe(ms, "js_probe") }
  }

  fun kick(sid: String, reason: String, force: Boolean) {
    post { session?.takeIf { it.sid == sid }?.kick(reason, force) }
  }

  fun setAuthToken(sid: String, token: String) {
    post { session?.takeIf { it.sid == sid }?.setAuthToken(token) }
  }

  fun closeAll(reason: String) {
    post {
      session?.close(1001, reason, emitClosed = false)
      session = null
    }
  }

  internal fun sessionEnded(s: Session) {
    if (session === s) session = null
  }

  /** Snapshot síncrono (diagnóstico). Lê da thread do transporte com timeout curto. */
  fun snapshot(): Map<String, Any?> = try {
    exec.submit<Map<String, Any?>> {
      val m = HashMap<String, Any?>()
      for ((k, v) in stats) m[k] = v.toDouble()
      m["version"] = VERSION
      m["foreground"] = foreground
      m["netUp"] = netUp
      m["regionalBlockedMs"] = max(0L, regionalBlockedUntil - now()).toDouble()
      session?.let { m.putAll(it.snapshot()) }
      m
    }.get(300, TimeUnit.MILLISECONDS)
  } catch (_: Throwable) { mapOf("version" to VERSION, "busy" to true) }

  private fun isAllowedUrl(u: String): Boolean = try {
    val uri = URI(u)
    val host = (uri.host ?: "").lowercase()
    uri.scheme == "wss" && (host == "chatyy.com.br" || host.endsWith(".chatyy.com.br"))
  } catch (_: Throwable) { false }

  private fun num(v: Any?, def: Long, lo: Long, hi: Long): Long {
    val d = (v as? Number)?.toDouble() ?: return def
    if (d.isNaN() || d.isInfinite()) return def
    return min(hi, max(lo, d.toLong()))
  }
}

internal data class SessionConfig(
  val urls: List<String>,
  val authFrame: String?,
  val pingIntervalMs: Long,
  val pongDeadlineMs: Long,
  val authWatchdogMs: Long,
  val connectTimeoutMs: Long,
  val fgProbeMs: Long,
  val batchMs: Long,
  val outboxMax: Int,
)

/** Uma sessão LÓGICA (= um `new WebSocket()` do JS). Só tocada na thread do transporte. */
internal class Session(val sid: String, private val cfg: SessionConfig) {
  companion object {
    private const val STABLE_MS = 10_000L
    private const val HTTP_REJECT_STOP = 4
    private const val BG_STALE_MS = 20_000L
  }

  private enum class Phys { IDLE, CONNECTING, OPEN, AUTHED }

  private class Out(val text: String, val type: String, val key: String?, val at: Long, val ttl: Long)

  private var phys = Phys.IDLE
  private var ws: WebSocket? = null
  private var gen = 0
  private var curUrl: String? = null
  private var closed = false
  private var everOpened = false
  private var everAuthed = false
  private var authFrame: String? = cfg.authFrame
  private var authSentGen = -1
  private var authRejected = false
  private var attempt = 0

  private var pingIntervalMs = cfg.pingIntervalMs
  private var pongDeadlineMs = cfg.pongDeadlineMs

  private var reconnectTask: ScheduledFuture<*>? = null
  private var connectTimeoutTask: ScheduledFuture<*>? = null
  private var authWatchdogTask: ScheduledFuture<*>? = null
  private var pingTask: ScheduledFuture<*>? = null
  private val deadlineTasks = ArrayList<ScheduledFuture<*>>()
  private var flushTask: ScheduledFuture<*>? = null

  private var lastInboundAt = 0L
  private var lastPingSentAt = 0L
  private var lastGraceAt = 0L
  private var connectStartedAt = 0L
  private var lostAt = 0L
  private var lastRttMs = -1L
  private var lastReconnectMs = -1L
  // Anti-loop: tentativa só zera depois de o socket ficar ESTÁVEL (autenticado
  // por STABLE_MS) — hub que aceita e derruba logo em seguida não vira laço de
  // reconexão a cada 0-200 ms. Rejeições HTTP no handshake contam à parte.
  private var stableTask: ScheduledFuture<*>? = null
  private var httpRejects = 0

  private val outbox = ArrayDeque<Out>()
  private val buf = ArrayList<String>()
  private var bufBytes = 0

  private fun now() = ChatTransport.now()

  // ─── conexão física ──────────────────────────────────────────────────────

  fun connect(reason: String) {
    if (closed || ws != null) return
    cancel(reconnectTask); reconnectTask = null
    if (!ChatTransport.netUp) { emitState("offline", mapOf("reason" to reason)); return }
    if (!ChatTransport.foreground) { emitState("paused", mapOf("reason" to reason)); return }
    val url = pickUrl()
    gen++
    val g = gen
    phys = Phys.CONNECTING
    curUrl = url
    connectStartedAt = now()
    ChatTransport.bump("connects")
    emitState("connecting", mapOf("url" to url, "attempt" to attempt, "reason" to reason))
    val req = try {
      Request.Builder().url(url).build()
    } catch (t: Throwable) {
      fail("bad url: " + (t.message ?: "")); return
    }
    ws = ChatTransport.client.newWebSocket(req, Listener(this, g))
    connectTimeoutTask = ChatTransport.schedule(cfg.connectTimeoutMs) {
      if (g == gen && phys == Phys.CONNECTING) {
        ChatTransport.bump("connectTimeouts")
        onDrop(g, 0, "connect_timeout")
      }
    }
  }

  private class Listener(val s: Session, val g: Int) : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      ChatTransport.post { s.onOpen(g) }
    }
    override fun onMessage(webSocket: WebSocket, text: String) {
      ChatTransport.post { s.onText(g, text) }
    }
    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      // Hub só manda binário depois de upgrade_msgpack/CWP, que o modo nativo
      // nunca negocia (o JS desliga essas flags quando usa este transporte).
      ChatTransport.post { if (g == s.currentGen()) { s.markInbound(); ChatTransport.bump("binaryDropped") } }
    }
    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      try { webSocket.close(1000, null) } catch (_: Throwable) {}
      ChatTransport.post { s.onDrop(g, code, reason) }
    }
    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      ChatTransport.post { s.onDrop(g, code, reason) }
    }
    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      // response != null = handshake respondido com HTTP (não-101): 400/401/403/5xx.
      val http = response?.code ?: 0
      ChatTransport.post { s.onDrop(g, 1006, "failure: " + (t.message ?: t.javaClass.simpleName), http) }
    }
  }

  fun currentGen() = gen
  fun markInbound() { lastInboundAt = now() }

  private fun onOpen(g: Int) {
    if (g != gen || closed) return
    cancel(connectTimeoutTask); connectTimeoutTask = null
    phys = Phys.OPEN
    lastInboundAt = now()
    ChatTransport.bump("opens")
    val first = !everOpened
    everOpened = true
    // Auth PRIMEIRO, sem esperar o JS (no 1º open o JS também manda o dele —
    // dedupe em sendFromJs). Depois o estado.
    sendAuthIfPossible()
    emitState("open", mapOf("first" to first, "url" to curUrl, "connectMs" to (now() - connectStartedAt)))
  }

  private fun sendAuthIfPossible() {
    val a = authFrame ?: return
    val w = ws ?: return
    if (phys != Phys.OPEN || authSentGen == gen) return
    if (w.send(a)) {
      authSentGen = gen
      armAuthWatchdog()
    }
  }

  private fun armAuthWatchdog() {
    cancel(authWatchdogTask)
    val g = gen
    authWatchdogTask = ChatTransport.schedule(cfg.authWatchdogMs) {
      if (g == gen && phys == Phys.OPEN && !authRejected) {
        ChatTransport.bump("authTimeouts")
        forceReconnect("auth_watchdog")
      }
    }
  }

  private fun onText(g: Int, text: String) {
    if (g != gen || closed) return
    lastInboundAt = now()
    ChatTransport.bump("framesIn")
    ChatTransport.bump("bytesIn", text.length.toLong())
    // Classificação barata: só frames pequenos com a "agulha" passam pelo parser.
    // Go serializa map com chaves em ordem alfabética, então "type" não é o 1º
    // campo — a agulha + parse confirma o type de TOPO.
    var type: String? = null
    if (text.length < 8192 && (text.contains("\"pong\"") || text.contains("\"auth_success\"") || text.contains("\"auth_error\""))) {
      type = topType(text)
    }
    when (type) {
      "pong" -> {
        val rtt = if (lastPingSentAt > 0) now() - lastPingSentAt else -1L
        lastRttMs = rtt
        ChatTransport.bump("pongs")
        enqueueFrame("{\"type\":\"pong\",\"native\":1,\"rtt\":$rtt}")
      }
      "auth_success" -> {
        enqueueFrame(text)
        onAuthSuccess()
      }
      "auth_error" -> {
        authRejected = true
        cancel(authWatchdogTask); authWatchdogTask = null
        ChatTransport.bump("authErrors")
        enqueueFrame(text)
        flushFrames()
      }
      else -> enqueueFrame(text)
    }
  }

  private fun onAuthSuccess() {
    cancel(authWatchdogTask); authWatchdogTask = null
    phys = Phys.AUTHED
    httpRejects = 0
    authRejected = false
    cancel(stableTask)
    val sg = gen
    stableTask = ChatTransport.schedule(STABLE_MS) { if (sg == gen && phys == Phys.AUTHED) attempt = 0 }
    val regionalBlocked = noteAuthed(curUrl)
    val t = now()
    val since = if (lostAt > 0) t - lostAt else t - connectStartedAt
    if (everAuthed) {
      lastReconnectMs = since
      ChatTransport.bump("reconnects")
      ChatTransport.bump("reconnectMsTotal", since)
    }
    everAuthed = true
    lostAt = 0
    flushOutbox()
    startHeartbeat()
    emitState("authed", mapOf("url" to curUrl, "reconnectMs" to since, "regionalBlocked" to regionalBlocked))
  }

  /** Socket físico acabou (close/falha/timeout). */
  fun onDrop(g: Int, code: Int, reason: String, http: Int = 0) {
    if (g != gen || closed) return
    val was = phys
    val url = curUrl
    teardownSocket(null)
    if (was == Phys.CONNECTING || was == Phys.OPEN) noteFailedBeforeAuth(url)
    ChatTransport.bump("drops")
    if (http in 400..499) {
      ChatTransport.bump("httpRejects")
      if (http == 401 || http == 403) {
        // Token recusado no handshake: NÃO reconecta em laço. O JS trata como
        // auth_error (1 refresh do bearer; persistindo → para e pede re-login).
        endLogical(4401, "handshake http=$http")
        return
      }
      httpRejects++
      if (httpRejects >= HTTP_REJECT_STOP) {
        // 4xx repetido no handshake (cabeçalho/caminho recusado pelo edge/hub):
        // devolve ao JS, que desliga o fio nativo neste processo e usa o WebSocket JS.
        endLogical(4400, "handshake_rejected http=$http x$httpRejects")
        return
      }
      attempt = max(attempt, 6) // pula direto pro degrau longo do backoff
      scheduleReconnect("http_$http", 1006, false, http = http)
      return
    }
    if (code in 4000..4999) {
      // Decisão de negócio do hub → close do socket LÓGICO; o JS decide.
      endLogical(code, reason)
      return
    }
    if (was == Phys.AUTHED && lostAt == 0L) lostAt = now()
    scheduleReconnect(reason, code, was == Phys.AUTHED)
  }

  /** Fecha o socket LÓGICO (decisão do JS a partir daqui). */
  private fun endLogical(code: Int, reason: String) {
    closed = true
    flushFrames()
    emitState("closed", mapOf("code" to code, "reason" to reason))
    cancelAll()
    ChatTransport.sessionEnded(this)
  }

  /** Derruba o socket atual (sem reconectar). */
  private fun teardownSocket(closeCode: Int?) {
    gen++ // callbacks atrasados do socket velho viram no-op
    val w = ws
    ws = null
    phys = Phys.IDLE
    stopHeartbeat()
    cancel(stableTask); stableTask = null
    cancel(connectTimeoutTask); connectTimeoutTask = null
    cancel(authWatchdogTask); authWatchdogTask = null
    if (w != null) {
      try {
        if (closeCode != null) {
          if (!w.close(closeCode, null)) w.cancel()
        } else {
          w.cancel()
        }
      } catch (_: Throwable) {}
    }
  }

  /** resetAttempt só p/ gatilhos EXTERNOS (troca de rede, pedido urgente do JS);
   *  auth_watchdog / pong / sonda mantêm a escada do backoff (sem laço). */
  private fun forceReconnect(reason: String, resetAttempt: Boolean = false) {
    if (closed) return
    val wasAuthed = phys == Phys.AUTHED
    if (wasAuthed && lostAt == 0L) lostAt = now()
    teardownSocket(null)
    if (resetAttempt) attempt = 0
    scheduleReconnect(reason, 0, wasAuthed)
  }

  private fun scheduleReconnect(reason: String, code: Int, wasAuthed: Boolean, delayOverride: Long = -1, http: Int = 0) {
    cancel(reconnectTask); reconnectTask = null
    if (closed || ws != null) return
    val base = mapOf<String, Any?>("reason" to reason, "code" to code, "wasAuthed" to wasAuthed, "http" to http)
    if (!ChatTransport.netUp) { emitState("offline", base); return }
    if (!ChatTransport.foreground) { emitState("paused", base); return }
    if (authRejected) { emitState("auth_wait", base); return }
    val delay = if (delayOverride >= 0) delayOverride else backoff(attempt)
    attempt++
    emitState("reconnecting", base + mapOf("attempt" to attempt, "nextRetryMs" to delay))
    reconnectTask = ChatTransport.schedule(delay) {
      reconnectTask = null
      connect("retry")
    }
  }

  /** 0 → ~300 ms → ~1 s → ~2 s → exponencial (equal-jitter) até 10 s; depois de
   *  10 tentativas seguidas sem estabilizar, teto 30 s. Nunca laço apertado. */
  private fun backoff(a: Int): Long {
    val early = longArrayOf(0, 300, 1000, 2000)
    if (a < early.size) return early[a] + Random.nextLong(0, 200)
    val ceiling = if (a >= 10) 30000L else 10000L
    val cap = min(1000L * (1L shl min(a - 2, 6)), ceiling)
    return cap / 2 + Random.nextLong(0, cap / 2 + 1)
  }

  // ─── keepalive / zumbi ───────────────────────────────────────────────────

  fun setHeartbeat(intervalMs: Long, deadlineMs: Long) {
    val i = min(120000L, max(2000L, intervalMs))
    val d = min(60000L, max(1500L, deadlineMs))
    if (i == pingIntervalMs && d == pongDeadlineMs) return
    pingIntervalMs = i
    pongDeadlineMs = d
    if (phys == Phys.AUTHED) startHeartbeat()
  }

  private fun startHeartbeat() {
    stopHeartbeat()
    if (phys != Phys.AUTHED || !ChatTransport.foreground) return
    pingTask = ChatTransport.scheduleRepeating(pingIntervalMs) { tick() }
  }

  private fun stopHeartbeat() {
    cancel(pingTask); pingTask = null
    for (t in deadlineTasks) cancel(t)
    deadlineTasks.clear()
  }

  private fun sendPing(): Long {
    val w = ws ?: return 0L
    val t = now()
    lastPingSentAt = t
    ChatTransport.bump("pings")
    w.send("{\"type\":\"ping\",\"ts\":" + System.currentTimeMillis() + "}")
    return t
  }

  private fun tick() {
    if (phys != Phys.AUTHED || ws == null) return
    val g = gen
    val sent = sendPing()
    val deadline = pongDeadlineMs
    var task: ScheduledFuture<*>? = null
    task = ChatTransport.schedule(deadline) {
      task?.let { deadlineTasks.remove(it) }
      if (g != gen || phys != Phys.AUTHED || !ChatTransport.foreground) return@schedule
      if (now() - sent > deadline * 2 + 2000) return@schedule // processo congelado: veredito inválido
      if (lastInboundAt >= sent) return@schedule
      // Uplink saturado (nossos frames ainda na fila do socket): 1 ciclo de
      // tolerância por minuto antes de condenar.
      val q = try { ws?.queueSize() ?: 0L } catch (_: Throwable) { 0L }
      if (q > 0 && now() - lastGraceAt > 60000) {
        lastGraceAt = now()
        ChatTransport.bump("pongGrace")
        return@schedule
      }
      ChatTransport.bump("zombies")
      forceReconnect("pong_deadline")
    }
    task?.let { deadlineTasks.add(it) }
  }

  fun probe(ms: Long, reason: String) {
    if (closed) return
    if (phys != Phys.AUTHED) { kick(reason, false); return }
    val g = gen
    val sent = sendPing()
    val dl = min(20000L, max(1000L, ms))
    ChatTransport.bump("probes")
    ChatTransport.schedule(dl) {
      if (g != gen || phys != Phys.AUTHED || !ChatTransport.foreground) return@schedule
      if (now() - sent > dl * 3 + 2000) return@schedule
      if (lastInboundAt >= sent) return@schedule
      ChatTransport.bump("zombies")
      ChatTransport.bump("probeDead")
      forceReconnect("probe_dead_$reason")
    }
  }

  fun kick(reason: String, force: Boolean) {
    if (closed) return
    if (force) {
      if (phys != Phys.IDLE) { forceReconnect(reason, true); return }
      attempt = 0
      scheduleReconnect(reason, 0, false)
      return
    }
    if (phys == Phys.IDLE) {
      attempt = 0
      scheduleReconnect(reason, 0, false)
    }
  }

  // ─── rede / primeiro plano ───────────────────────────────────────────────

  fun onNetwork(kind: String) {
    if (closed) return
    if (kind == "net_up") {
      if (phys == Phys.AUTHED) { probe(2000, kind); return }
      if (phys == Phys.IDLE) {
        attempt = 0
        // jitter curto: frota não bate no hub em lockstep depois de queda compartilhada
        scheduleReconnect(kind, 0, false, Random.nextLong(0, 400))
      }
      return
    }
    // Troca da rede padrão (Wi-Fi↔4G): o socket está preso à interface velha,
    // que o Android derruba (linger) → reconecta JÁ na nova.
    if (phys != Phys.IDLE) {
      forceReconnect(kind, true)
    } else {
      attempt = 0
      scheduleReconnect(kind, 0, false, Random.nextLong(0, 250))
    }
  }

  fun onNetDown() {
    if (closed) return
    val wasAuthed = phys == Phys.AUTHED
    if (wasAuthed && lostAt == 0L) lostAt = now()
    if (phys != Phys.IDLE) teardownSocket(null)
    cancel(reconnectTask); reconnectTask = null
    emitState("offline", mapOf("reason" to "net_down", "wasAuthed" to wasAuthed))
  }

  fun onForeground(fg: Boolean, bgMs: Long = 0L) {
    if (closed) return
    if (!fg) {
      stopHeartbeat()
      if (phys == Phys.IDLE) {
        cancel(reconnectTask); reconnectTask = null
        emitState("paused", mapOf("reason" to "background"))
      }
      return
    }
    when (phys) {
      Phys.AUTHED -> {
        if (bgMs >= BG_STALE_MS) {
          // Ficou fora mais que o ciclo de ping do hub (25 s): o socket quase
          // sempre morreu (NAT/rádio/SO). Reconecta JÁ em vez de gastar a sonda.
          ChatTransport.bump("fgReconnects")
          forceReconnect("foreground_stale", true)
        } else {
          startHeartbeat(); probe(cfg.fgProbeMs, "foreground")
        }
      }
      Phys.IDLE -> { attempt = 0; scheduleReconnect("foreground", 0, false) }
      else -> {}
    }
  }

  /** Bearer deslizou (mesma conta): vale na PRÓXIMA reconexão física. */
  fun setAuthToken(token: String) {
    if (closed || token.isEmpty()) return
    val a = authFrame ?: return
    authFrame = try { JSONObject(a).put("token", token).toString() } catch (_: Throwable) { a }
    if (authRejected) {
      authRejected = false
      if (phys == Phys.IDLE && reconnectTask == null) { attempt = 0; scheduleReconnect("auth_update", 0, false) }
    }
  }

  // ─── saída ───────────────────────────────────────────────────────────────

  fun sendFromJs(text: String) {
    if (closed) return
    val obj = try { JSONObject(text) } catch (_: Throwable) { null }
    val type = obj?.optString("type", "") ?: ""
    when (type) {
      "auth" -> {
        authFrame = text
        authRejected = false
        if (phys == Phys.OPEN && authSentGen != gen) {
          sendAuthIfPossible()
        } else {
          ChatTransport.bump("authDedup")
          if (phys == Phys.IDLE && reconnectTask == null) scheduleReconnect("auth_update", 0, false)
        }
        return
      }
      "ping" -> {
        if (phys == Phys.AUTHED || phys == Phys.OPEN) {
          lastPingSentAt = now()
          ws?.send(text)
        }
        return
      }
    }
    if (phys == Phys.AUTHED) {
      val w = ws
      if (w != null && w.send(text)) {
        ChatTransport.bump("framesOut")
        return
      }
    }
    enqueueOut(text, type, obj)
  }

  private fun enqueueOut(text: String, type: String, obj: JSONObject?) {
    // Efêmeros não valem nada depois da reconexão.
    if (type == "typing" || type == "stopped_typing" || type == "pong" || type.isEmpty()) {
      ChatTransport.bump("outboxSkipped"); return
    }
    val key = obj?.let {
      it.optString("client_message_id", "").ifEmpty { it.optString("msg_id", "").ifEmpty { it.optString("req_id", "") } }
    }?.ifEmpty { null }
    if (type == "presence") {
      outbox.removeAll { it.type == "presence" }
    } else if (key != null) {
      outbox.removeAll { it.key == key && it.type == type }
    }
    val ttl = if (type.startsWith("call_") || type.startsWith("ice") || type == "webrtc_signal") 45_000L else 600_000L
    outbox.addLast(Out(text, type, key, now(), ttl))
    while (outbox.size > cfg.outboxMax) {
      outbox.pollFirst()
      ChatTransport.bump("outboxDropped")
    }
    ChatTransport.bump("outboxQueued")
  }

  private fun flushOutbox() {
    val w = ws ?: return
    val t = now()
    var n = 0L
    while (outbox.isNotEmpty() && phys == Phys.AUTHED) {
      val o = outbox.peekFirst() ?: break
      if (t - o.at > o.ttl) { outbox.pollFirst(); ChatTransport.bump("outboxExpired"); continue }
      if (!w.send(o.text)) break
      outbox.pollFirst()
      n++
    }
    if (n > 0) ChatTransport.bump("outboxFlushed", n)
  }

  // ─── entrega ao JS (lote) ────────────────────────────────────────────────

  private fun enqueueFrame(text: String) {
    buf.add(text)
    bufBytes += text.length
    if (buf.size >= 64 || bufBytes >= 256 * 1024 || cfg.batchMs <= 0L) {
      flushFrames()
    } else if (flushTask == null) {
      flushTask = ChatTransport.schedule(cfg.batchMs) { flushTask = null; flushFrames() }
    }
  }

  private fun flushFrames() {
    cancel(flushTask); flushTask = null
    if (buf.isEmpty()) return
    val list = ArrayList(buf)
    buf.clear()
    bufBytes = 0
    ChatTransport.bump("batches")
    ChatTransport.emit("onTransportFrames", mapOf("sid" to sid, "frames" to list, "n" to list.size))
  }

  private fun emitState(state: String, extra: Map<String, Any?> = emptyMap()) {
    flushFrames() // ordem: frames anteriores chegam ANTES da mudança de estado
    val m = HashMap<String, Any?>(extra)
    m["sid"] = sid
    m["state"] = state
    if (lastRttMs >= 0) m["rttMs"] = lastRttMs
    m["outbox"] = outbox.size
    ChatTransport.emit("onTransportState", m)
  }

  // ─── fim ─────────────────────────────────────────────────────────────────

  fun close(code: Int, reason: String, emitClosed: Boolean) {
    if (closed) return
    closed = true
    val c = if (code == 1000 || code in 3000..4999) code else 1000
    teardownSocket(c)
    cancelAll()
    outbox.clear()
    buf.clear()
    if (emitClosed) ChatTransport.emit("onTransportState", mapOf("sid" to sid, "state" to "closed", "code" to c, "reason" to reason))
  }

  /** Erro interno → JS marca o transporte nativo como quebrado e volta ao WebSocket JS. */
  fun fail(reason: String) {
    if (closed) return
    ChatTransport.bump("failures")
    closed = true
    try { teardownSocket(1000) } catch (_: Throwable) {}
    cancelAll()
    ChatTransport.emit("onTransportState", mapOf("sid" to sid, "state" to "failed", "reason" to reason))
    ChatTransport.sessionEnded(this)
  }

  private fun cancelAll() {
    cancel(reconnectTask); reconnectTask = null
    cancel(stableTask); stableTask = null
    cancel(flushTask); flushTask = null
    stopHeartbeat()
    cancel(connectTimeoutTask); connectTimeoutTask = null
    cancel(authWatchdogTask); authWatchdogTask = null
  }

  fun snapshot(): Map<String, Any?> = mapOf(
    "sid" to sid,
    "phys" to phys.name.lowercase(),
    "url" to curUrl,
    "attempt" to attempt,
    "outbox" to outbox.size,
    "rttMs" to lastRttMs.toDouble(),
    "lastReconnectMs" to lastReconnectMs.toDouble(),
    "pingIntervalMs" to pingIntervalMs.toDouble(),
    "pongDeadlineMs" to pongDeadlineMs.toDouble(),
    "authRejected" to authRejected,
  )

  // ─── endpoint regional ───────────────────────────────────────────────────

  private fun pickUrl(): String {
    val pref = cfg.urls[0]
    val fb = cfg.urls.getOrNull(1) ?: return pref
    if (ChatTransport.regionalFailPending || now() < ChatTransport.regionalBlockedUntil) return fb
    return pref
  }

  private fun noteFailedBeforeAuth(url: String?) {
    if (cfg.urls.size < 2 || url == null) return
    if (url == cfg.urls[0]) ChatTransport.regionalFailPending = true
    else if (ChatTransport.regionalFailPending) ChatTransport.regionalFailPending = false // US também falhou → rede
  }

  private fun noteAuthed(url: String?): Boolean {
    var blocked = false
    if (cfg.urls.size >= 2 && url != null && url != cfg.urls[0] && ChatTransport.regionalFailPending) {
      ChatTransport.regionalBlockedUntil = now() + 15 * 60 * 1000L
      blocked = true
    }
    ChatTransport.regionalFailPending = false
    return blocked
  }

  private fun cancel(f: ScheduledFuture<*>?) {
    try { f?.cancel(false) } catch (_: Throwable) {}
  }

  private fun topType(text: String): String? = try {
    JSONObject(text).optString("type", "")
  } catch (_: Throwable) { null }
}
