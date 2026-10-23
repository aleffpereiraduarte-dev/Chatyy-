package expo.modules.chatyytransport

import android.content.Context
import android.net.Network
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.IOException
import java.net.Inet4Address
import java.net.InetAddress
import java.net.URI
import java.util.concurrent.atomic.AtomicInteger

/**
 * [2026-10-23 quic-proto F-Q2/F-N1] Fio QUIC + Noise IK do transporte nativo — protótipo ESCURO.
 *
 * Contrato: /root/quic-noise-2026-10-23/PROTOCOLO.md (chatyy/1, versão 1-proto). Núcleo em Rust
 * (native/chatyy-net: quinn + snow), JNI cru em libchatyy_net.so. Entra como mais um "fio físico"
 * debaixo do MESMO WebSocket lógico: [QuicRaceSocket] implementa okhttp3.WebSocket e chama o
 * MESMO WebSocketListener da Session — auth, ping, zumbi, outbox, lote para o JS não mudam.
 *
 * DESLIGADO POR PADRÃO. Só tenta QUIC quando TUDO isto vale:
 *   1. a .so está no binário e carregou (senão → WSS, sem crash: loadLibrary em try/catch);
 *   2. flag LOCAL ligada (SharedPreferences "chatyy_quic_proto"/"enabled", via
 *      ChatyyTransport.quicProtoSet(true)) — padrão false;
 *   3. o SERVIDOR disse que a conta está na allowlist: cfg.quic.transport {quic:1, noise:1} que o JS
 *      repassa do client-lb.php (PROTOCOLO §1: `transport` só vem para contas da allowlist);
 *   4. a região anuncia QUIC (cfg.quic.region {q:1, qp:443, nk:"t1"}) e o host é api-<reg>
 *      (US/ws.chatyy.com.br não tem QUIC nesta fase);
 *   5. a chave pinada existe para o kid: hoje SÓ a de TESTE t1, e só com transport.noise_test=1;
 *   6. nada de go_ws/noise_fail recente p/ (conta, região) e UDP não marcado bloqueado nesta rede;
 *   7. JS não mandou o kill (cfg.quic ausente ou false = WSS de sempre).
 *
 * Corrida (PROTOCOLO §1): QUIC primeiro; sem Noise pronto em raceMs (250) → WSS em paralelo; fica
 * o 1º que abrir. Falha do QUIC antes de abrir → WSS na hora (mesmo socket lógico, sem custo de UX).
 * Depois de aberto: 4001 go_ws / 4003 / 4004, ou erro antes do auth_success → onFailure com
 * prefixo [FALLBACK] → a Session reconecta JÁ (sem backoff, sem marcar a regional como ruim) e o
 * portão daqui manda para o WSS.
 *
 * Migração: troca da rede padrão com o fio QUIC autenticado → Endpoint::rebind() com um socket
 * UDP amarrado à Network nova (android_setsocknetwork) + 1 ping de sonda; sem reconectar.
 */
internal object ChatyyNetJni {
  @JvmStatic external fun nativeVersion(): String?
  @JvmStatic external fun nativeKeypair(): ByteArray?
  @JvmStatic external fun nativeConnect(
    sni: String, ip: String, port: Int, region: String, keyId: String,
    serverPub: ByteArray, clientPriv: ByteArray, netHandle: Long, timeoutMs: Int,
    tlsVerify: Boolean, keepAliveMs: Int, dev: String, ua: String,
  ): Long
  @JvmStatic external fun nativeSend(h: Long, op: Int, data: ByteArray): Boolean
  @JvmStatic external fun nativePoll(h: Long, timeoutMs: Int): ByteArray?
  @JvmStatic external fun nativeMigrate(h: Long, netHandle: Long): Boolean
  @JvmStatic external fun nativeClose(h: Long, code: Int, reason: String, abort: Boolean)
  @JvmStatic external fun nativeQueued(h: Long): Long
  @JvmStatic external fun nativeStats(h: Long): String?
  @JvmStatic external fun nativeFree(h: Long)
}

internal class QuicTarget(
  val host: String,
  val region: String,
  val port: Int,
  val kid: String,
  val pub: ByteArray,
  val clientPriv: ByteArray,
  val dev: String,
  val ua: String,
  val timeoutMs: Int,
  val account: String,
)

internal object QuicWire {
  private const val TAG = "ChatyyQuic"
  /** Motivo de onFailure que a Session trata como "volte para o WSS já" (ver ChatTransport.onDrop). */
  const val FALLBACK = "quic_fallback"
  private const val PREFS = "chatyy_quic_proto"
  private const val K_ON = "enabled"
  private const val K_CK = "ck"

  // PROTOCOLO.md §1 — chave de região de TESTE (X25519). Mesma nas 11 regiões; vale SÓ com
  // transport.noise_test=1 do servidor (conta na allowlist). Produção = cert assinado pela raiz (F-N1).
  private const val TEST_KID = "t1"
  private const val TEST_PUB_B64 = "inKsxZ/WSbIq8+QcY/3DDTrbxDdiRQ3t6lHsyYinlh8="

  private val REGION_RE = Regex("^api-([a-z0-9]{2,8})\\.chatyy\\.com\\.br$")
  private const val HOUR = 3_600_000L

  // ─── lib nativa ───────────────────────────────────────────────────────────
  @Volatile private var libState = 0 // 0 = não tentou, 1 = ok, -1 = ausente/quebrada
  @Volatile private var libVersion: String? = null

  fun libAvailable(): Boolean {
    if (libState == 0) synchronized(this) { loadLibLocked() }
    return libState == 1
  }

  private fun loadLibLocked() {
    if (libState != 0) return
    libState = try {
      System.loadLibrary("chatyy_net")
      val v = ChatyyNetJni.nativeVersion()
      libVersion = v
      if (v != null && v.startsWith("chatyy-net/")) 1 else -1
    } catch (t: Throwable) {
      // UnsatisfiedLinkError (binário sem a .so / ABI faltando) ou símbolo ausente → WSS.
      Log.i(TAG, "libchatyy_net ausente: ${t.javaClass.simpleName}")
      -1
    }
  }

  // ─── flag local ───────────────────────────────────────────────────────────
  @Volatile private var localOn: Boolean? = null

  fun localEnabled(ctx: Context): Boolean {
    localOn?.let { return it }
    val v = try { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(K_ON, false) } catch (_: Throwable) { false }
    localOn = v
    return v
  }

  fun setLocalEnabled(ctx: Context, on: Boolean) {
    try { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(K_ON, on).apply() } catch (_: Throwable) {}
    localOn = on
    if (!on) clearGate()
  }

  /** Par X25519 do aparelho (privada 32 || pública 32), criado 1 vez. Não é a chave E2EE. */
  private fun clientKey(ctx: Context): ByteArray? = synchronized(this) {
    try {
      val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val cur = sp.getString(K_CK, null)?.let { Base64.decode(it, Base64.NO_WRAP) }
      if (cur != null && cur.size == 64) return cur
      val kp = ChatyyNetJni.nativeKeypair() ?: return null
      if (kp.size != 64) return null
      sp.edit().putString(K_CK, Base64.encodeToString(kp, Base64.NO_WRAP)).apply()
      kp
    } catch (_: Throwable) { null }
  }

  // ─── portão (memória de recusas) ──────────────────────────────────────────
  private val deny = HashMap<String, Long>() // "conta|região" → até (elapsedRealtime)
  private var udpBlockedEpoch = -1
  private var udpBlockedUntil = 0L
  private var lastWhy = ""
  private var strikes = 0

  private fun now() = SystemClock.elapsedRealtime()

  @Synchronized private fun denied(account: String, region: String): Boolean {
    val k = "$account|$region"
    val until = deny[k] ?: return false
    if (now() < until) return true
    deny.remove(k)
    return false
  }

  @Synchronized private fun udpBlocked(epoch: Int): Boolean = epoch == udpBlockedEpoch && now() < udpBlockedUntil

  @Synchronized fun denyFor(t: QuicTarget, why: String, ms: Long) {
    deny["${t.account}|${t.region}"] = now() + ms
    lastWhy = why
  }

  /** Falha ANTES do Noise pronto (PROTOCOLO §6: CloseWithError 0x101…0x109, timeout, rede). */
  @Synchronized fun noteHandshakeFail(t: QuicTarget, why: String, epoch: Int) {
    lastWhy = why
    when {
      why == "quic_timeout" -> { udpBlockedEpoch = epoch; udpBlockedUntil = now() + 24 * HOUR } // UDP bloqueado nesta rede
      why.contains("0x101") || why.contains("go_ws") -> denyFor(t, why, HOUR)
      why.contains("0x102") || why.contains("noise_auth_failed") -> denyFor(t, why, HOUR) // sem laço; anti-downgrade = WSS, nunca modo P
      why.contains("0x104") -> denyFor(t, why, 5 * 60_000L)
      why.contains("0x106") -> {} // draining: próxima tentativa decide
      else -> denyFor(t, why, 10 * 60_000L)
    }
  }

  /** Fio QUIC aberto morreu: sessões que caem logo seguidas → descansa o QUIC por 30 min. */
  @Synchronized fun noteDrop(t: QuicTarget, aliveMs: Long, why: String) {
    if (aliveMs < 15_000L) strikes++ else strikes = 0
    if (strikes >= 2) { denyFor(t, "strikes:$why", 30 * 60_000L); strikes = 0 }
  }

  @Synchronized fun noteGood() { strikes = 0 }

  @Synchronized private fun clearGate() {
    deny.clear()
    udpBlockedUntil = 0L
  }

  @Synchronized private fun gateInfo(m: HashMap<String, Any?>) {
    m["lastWhy"] = lastWhy
    m["denied"] = deny.filterValues { it > now() }.size
    m["udpBlocked"] = now() < udpBlockedUntil
  }

  // ─── decisão + criação do fio ─────────────────────────────────────────────

  private fun truthy(v: Any?): Boolean = v == true || (v is Number && v.toInt() == 1) || v == "1"

  private fun pinFor(kid: String, noiseTest: Boolean): ByteArray? {
    if (kid == TEST_KID && noiseTest) return try { Base64.decode(TEST_PUB_B64, Base64.NO_WRAP).takeIf { it.size == 32 } } catch (_: Throwable) { null }
    return null // chaves de produção (cert assinado pela raiz) = F-N1
  }

  /** null = usar o WSS. Chamado na thread do transporte. */
  fun target(url: String, quic: Map<String, Any?>?, account: String, authFrame: String?): QuicTarget? {
    if (quic == null || account.isEmpty() || authFrame == null) return null
    val ctx = ChatTransport.appCtx ?: return null
    if (!localEnabled(ctx)) return null
    val tr = quic["transport"] as? Map<*, *> ?: return null
    if (!truthy(tr["quic"]) || !truthy(tr["noise"])) return null
    val host = try { URI(url).host?.lowercase() } catch (_: Throwable) { null } ?: return null
    val region = REGION_RE.matchEntire(host)?.groupValues?.get(1) ?: return null
    val rg = quic["region"] as? Map<*, *> ?: return null
    if (!truthy(rg["q"])) return null
    val port = (rg["qp"] as? Number)?.toInt() ?: 443
    if (port !in 1..65535) return null
    val kid = rg["nk"] as? String ?: return null
    val pub = pinFor(kid, truthy(tr["noise_test"])) ?: return null
    if (denied(account, region) || udpBlocked(ChatTransport.netEpoch)) return null
    if (!libAvailable()) return null
    val ck = clientKey(ctx) ?: return null
    val dev = try { JSONObject(authFrame).optString("e2ee5_device", "") } catch (_: Throwable) { "" }
    val ua = "Chatyy-Android/${Build.VERSION.RELEASE} ${libVersion ?: ""}".take(120)
    val tmo = ((quic["hsTimeoutMs"] as? Number)?.toInt() ?: 3000).coerceIn(1000, 10_000)
    return QuicTarget(host, region, port, kid, pub, ck.copyOfRange(0, 32), dev, ua, tmo, account)
  }

  fun maybeRace(req: Request, url: String, quic: Map<String, Any?>?, account: String, authFrame: String?, listener: WebSocketListener): QuicRaceSocket? = try {
    val t = target(url, quic, account, authFrame)
    if (t == null) null else {
      val race = ((quic?.get("raceMs") as? Number)?.toLong() ?: 250L).coerceIn(0L, 3000L)
      val s = QuicRaceSocket(req, listener, t, ChatTransport.currentNetwork, ChatTransport.netEpoch, race)
      ChatTransport.bump("quicAttempts")
      s.start()
      s
    }
  } catch (t: Throwable) {
    Log.w(TAG, "quic off: ${t.javaClass.simpleName}")
    ChatTransport.bump("quicInternal")
    null
  }

  /** Diagnóstico para o JS (ChatyyTransport.quicProtoInfo). Sem chave privada. */
  fun info(ctx: Context?): Map<String, Any?> {
    val m = HashMap<String, Any?>()
    m["lib"] = libAvailable()
    m["libVersion"] = libVersion
    m["enabled"] = ctx?.let { localEnabled(it) } ?: false
    m["testKid"] = TEST_KID
    if (ctx != null && libState == 1 && localEnabled(ctx)) {
      clientKey(ctx)?.let { m["clientPub"] = Base64.encodeToString(it.copyOfRange(32, 64), Base64.NO_WRAP) }
    }
    gateInfo(m)
    return m
  }
}

/**
 * Socket físico "corrida": QUIC (Rust) e, se preciso, WSS (OkHttp) — quem abrir primeiro vira o fio.
 * Thread-safe (lock); os callbacks do listener saem da thread do QUIC ou do OkHttp, e o Listener
 * da Session só posta na thread do transporte (como com o OkHttp puro).
 */
internal class QuicRaceSocket(
  private val req: Request,
  private val listener: WebSocketListener,
  private val t: QuicTarget,
  private val network: Network?,
  private val netEpoch: Int,
  private val raceMs: Long,
) : WebSocket {
  companion object {
    private val seq = AtomicInteger(0)
    private const val NONE = 0
    private const val QUIC = 1
    private const val WSS = 2
  }

  private val lock = Any()
  private var winner = NONE
  private var cancelled = false
  private var cancelAt = 0L
  private var h = 0L
  private var quicDead = false
  private var wss: WebSocket? = null
  private var wssDead = false
  private var wssFail: Pair<Throwable, Response?>? = null
  private var openedAt = 0L
  @Volatile private var sawAuthSuccess = false
  @Volatile var hsMs = -1L
    private set

  private fun post(k: String) = ChatTransport.post { ChatTransport.bump(k) }

  fun start() {
    val th = Thread({ runQuic() }, "chatyy-quic-" + seq.incrementAndGet())
    th.isDaemon = true
    th.start()
    if (raceMs <= 0L) {
      val go = synchronized(lock) { winner == NONE && !cancelled && wss == null }
      if (go) startWss()
    } else {
      ChatTransport.schedule(raceMs) {
        val started = synchronized(lock) {
          if (winner == NONE && !cancelled && wss == null && !quicDead) { startWssLocked(); true } else false
        }
        if (started) ChatTransport.bump("quicRaceWssStarted")
      }
    }
  }

  private fun startWssLocked() {
    wss = ChatTransport.client.newWebSocket(req, WssListener())
  }

  private fun startWss() {
    synchronized(lock) {
      if (winner == NONE && !cancelled && wss == null) startWssLocked()
      Unit
    }
  }

  fun wire(): String = synchronized(lock) { when (winner) { QUIC -> "quic"; WSS -> "wss"; else -> "race" } }
  fun isQuic(): Boolean = synchronized(lock) { winner == QUIC && !quicDead }

  /** Rede padrão trocou: socket UDP novo na Network nova, mesma conexão QUIC. */
  fun migrate(n: Network?): Boolean {
    val qh = synchronized(lock) { if (winner != QUIC || cancelled || quicDead) 0L else h }
    if (qh == 0L) return false
    return try { ChatyyNetJni.nativeMigrate(qh, n?.networkHandle ?: 0L) } catch (_: Throwable) { false }
  }

  // ─── fio QUIC (thread própria) ────────────────────────────────────────────

  private fun resolve(): String? {
    val all: Array<InetAddress> = try { network?.getAllByName(t.host) ?: InetAddress.getAllByName(t.host) } catch (_: Throwable) { return null }
    val a = all.firstOrNull { it is Inet4Address } ?: all.firstOrNull() ?: return null
    return a.hostAddress
  }

  private fun runQuic() {
    var handle = 0L
    try {
      val ip = resolve()
      if (ip == null) { quicFailed("dns"); return }
      handle = ChatyyNetJni.nativeConnect(
        t.host, ip, t.port, t.region, t.kid, t.pub, t.clientPriv,
        network?.networkHandle ?: 0L, t.timeoutMs, true, 0, t.dev, t.ua,
      )
      if (handle == 0L) { quicFailed("bad_params"); return }
      val cancelNow = synchronized(lock) { h = handle; cancelled }
      if (cancelNow) ChatyyNetJni.nativeClose(handle, 1000, "cancel", true)
      loop(handle)
    } catch (e: Throwable) {
      quicFailed("jni_" + e.javaClass.simpleName)
    } finally {
      if (handle != 0L) {
        synchronized(lock) { h = 0L; Unit }
        try { ChatyyNetJni.nativeFree(handle) } catch (_: Throwable) {}
      }
    }
  }

  private fun loop(handle: Long) {
    while (true) {
      val ev = ChatyyNetJni.nativePoll(handle, 1000)
      if (ev == null || ev.isEmpty()) {
        // Rede de segurança: cancelado e o núcleo não terminou em 5 s → solta (nativeFree aborta).
        val stuck = synchronized(lock) { cancelled && cancelAt > 0 && SystemClock.elapsedRealtime() - cancelAt > 5000 }
        if (stuck) return
        continue
      }
      when (ev[0].toInt()) {
        1 -> onQuicOpen(handle, ev)
        2 -> onQuicFrame(ev)
        3 -> {
          val code = if (ev.size >= 3) ((ev[1].toInt() and 0xFF) shl 8) or (ev[2].toInt() and 0xFF) else 1005
          val remote = ev.size >= 4 && ev[3].toInt() != 0
          val reason = if (ev.size > 4) String(ev, 4, ev.size - 4, Charsets.UTF_8) else ""
          onQuicClosed(code, remote, reason)
        }
        4 -> onQuicError(String(ev, 1, ev.size - 1, Charsets.UTF_8))
        5 -> post(if (ev.size >= 2 && ev[1].toInt() != 0) "quicMigrations" else "quicMigrateFail")
        6 -> return
      }
    }
  }

  private fun onQuicOpen(handle: Long, ev: ByteArray) {
    val hs = if (ev.size >= 5) ((ev[1].toLong() and 0xFF) shl 24) or ((ev[2].toLong() and 0xFF) shl 16) or ((ev[3].toLong() and 0xFF) shl 8) or (ev[4].toLong() and 0xFF) else -1L
    val msg2 = if (ev.size > 9) String(ev, 9, ev.size - 9, Charsets.UTF_8) else ""
    // msg2 {"ok":true,...}: ok=false → servidor recusou (trata como falha de handshake)
    val ok = try { msg2.isEmpty() || JSONObject(msg2).optBoolean("ok", true) } catch (_: Throwable) { true }
    if (!ok) {
      try { ChatyyNetJni.nativeClose(handle, 1000, "msg2_not_ok", true) } catch (_: Throwable) {}
      quicFailed("msg2_not_ok")
      return
    }
    var loser: WebSocket? = null
    val win = synchronized(lock) {
      if (cancelled || winner != NONE) false else {
        winner = QUIC
        openedAt = SystemClock.elapsedRealtime()
        hsMs = hs
        loser = wss
        wss = null
        true
      }
    }
    if (!win) {
      try { ChatyyNetJni.nativeClose(handle, 1000, "race_lost", false) } catch (_: Throwable) {}
      post("quicRaceLost")
      return
    }
    try { loser?.cancel() } catch (_: Throwable) {}
    post("quicOpens")
    listener.onOpen(this, Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(101).message("chatyy/1").build())
  }

  private fun onQuicFrame(ev: ByteArray) {
    val live = synchronized(lock) { winner == QUIC && !cancelled }
    if (!live || ev.size < 2) return
    when (ev[1].toInt()) {
      1 -> {
        val text = String(ev, 2, ev.size - 2, Charsets.UTF_8)
        if (!sawAuthSuccess && text.length < 65536 && text.contains("\"auth_success\"")) {
          sawAuthSuccess = true
          QuicWire.noteGood()
        }
        listener.onMessage(this, text)
      }
      2 -> listener.onMessage(this, ev.copyOfRange(2, ev.size).toByteString())
    }
  }

  private fun onQuicClosed(code: Int, remote: Boolean, reason: String) {
    val w = synchronized(lock) { quicDead = true; if (cancelled) -1 else winner }
    when (w) {
      NONE -> quicFailed("closed_$code")
      QUIC -> {
        val alive = SystemClock.elapsedRealtime() - openedAt
        when {
          // PROTOCOLO §6: 4001 go_ws (fora da allowlist / QUIC desligado), 4003 noise_mismatch, 4004 auth_timeout → WSS
          code == 4001 || code == 4003 || code == 4004 -> {
            QuicWire.denyFor(t, "app_$code", 3_600_000L)
            post("quicGoWs")
            listener.onFailure(this, IOException("${QuicWire.FALLBACK} app_$code"), null)
          }
          !sawAuthSuccess -> {
            QuicWire.denyFor(t, "pre_auth_close_$code", 10 * 60_000L)
            listener.onFailure(this, IOException("${QuicWire.FALLBACK} pre_auth_close_$code"), null)
          }
          remote -> {
            if (code != 1000 && code != 1001 && code != 1012) QuicWire.noteDrop(t, alive, "close_$code")
            listener.onClosed(this, code, reason) // a Session decide (1012 restart, 4002 session_replaced…)
          }
          else -> {} // nós fechamos
        }
      }
    }
  }

  private fun onQuicError(msg: String) {
    val w = synchronized(lock) { quicDead = true; if (cancelled) -1 else winner }
    when (w) {
      NONE -> quicFailed(msg)
      QUIC -> {
        val alive = SystemClock.elapsedRealtime() - openedAt
        post("quicDrops")
        if (!sawAuthSuccess) {
          QuicWire.denyFor(t, "pre_auth:$msg", 10 * 60_000L)
          listener.onFailure(this, IOException("${QuicWire.FALLBACK} $msg"), null)
        } else {
          QuicWire.noteDrop(t, alive, msg)
          listener.onFailure(this, IOException("quic: $msg"), null)
        }
      }
    }
  }

  /** QUIC não chegou a abrir: WSS agora (se ainda não começou) e memória do motivo. */
  private fun quicFailed(why: String) {
    QuicWire.noteHandshakeFail(t, why, netEpoch)
    var report: Pair<Throwable, Response?>? = null
    var started = false
    synchronized(lock) {
      quicDead = true
      if (cancelled || winner != NONE) return
      if (wss == null) {
        startWssLocked()
        started = true
      } else if (wssDead) {
        report = wssFail
      }
      Unit
    }
    post("quicHsFails")
    if (started) post("quicFallbackWss")
    report?.let { listener.onFailure(this, it.first, it.second) }
  }

  // ─── fio WSS da corrida ───────────────────────────────────────────────────

  private inner class WssListener : WebSocketListener() {
    private fun mine(ws: WebSocket): Boolean = synchronized(lock) { winner == WSS && ws === wss && !cancelled }

    override fun onOpen(webSocket: WebSocket, response: Response) {
      var qh = 0L
      val win = synchronized(lock) {
        if (cancelled || winner != NONE || webSocket !== wss) false else { winner = WSS; qh = h; true }
      }
      if (!win) { try { webSocket.cancel() } catch (_: Throwable) {}; return }
      if (qh != 0L) try { ChatyyNetJni.nativeClose(qh, 1000, "race_lost", true) } catch (_: Throwable) {}
      post("quicRaceWssWon")
      listener.onOpen(this@QuicRaceSocket, response)
    }
    override fun onMessage(webSocket: WebSocket, text: String) { if (mine(webSocket)) listener.onMessage(this@QuicRaceSocket, text) }
    override fun onMessage(webSocket: WebSocket, bytes: ByteString) { if (mine(webSocket)) listener.onMessage(this@QuicRaceSocket, bytes) }
    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { if (mine(webSocket)) listener.onClosing(this@QuicRaceSocket, code, reason) }
    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (mine(webSocket)) listener.onClosed(this@QuicRaceSocket, code, reason) }
    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      val deliver = synchronized(lock) {
        when {
          cancelled || webSocket !== wss -> false
          winner == WSS -> true
          winner == NONE -> { wssDead = true; wssFail = Pair(t, response); quicDead } // QUIC ainda tentando → espera por ele
          else -> false
        }
      }
      if (deliver) listener.onFailure(this@QuicRaceSocket, t, response)
    }
  }

  // ─── okhttp3.WebSocket ────────────────────────────────────────────────────

  override fun request(): Request = req

  override fun queueSize(): Long {
    val (w, qh, s) = synchronized(lock) { Triple(winner, h, wss) }
    return when (w) {
      QUIC -> if (qh != 0L) try { ChatyyNetJni.nativeQueued(qh) } catch (_: Throwable) { 0L } else 0L
      WSS -> s?.queueSize() ?: 0L
      else -> 0L
    }
  }

  private fun sendQuic(op: Int, data: ByteArray): Boolean {
    val qh = synchronized(lock) { if (winner == QUIC && !cancelled && !quicDead) h else 0L }
    if (qh == 0L) return false
    return try { ChatyyNetJni.nativeSend(qh, op, data) } catch (_: Throwable) { false }
  }

  override fun send(text: String): Boolean {
    val (w, s) = synchronized(lock) { Pair(winner, wss) }
    return when (w) {
      QUIC -> sendQuic(1, text.toByteArray(Charsets.UTF_8))
      WSS -> s?.send(text) ?: false
      else -> false
    }
  }

  override fun send(bytes: ByteString): Boolean {
    val (w, s) = synchronized(lock) { Pair(winner, wss) }
    return when (w) {
      QUIC -> sendQuic(2, bytes.toByteArray())
      WSS -> s?.send(bytes) ?: false
      else -> false
    }
  }

  override fun close(code: Int, reason: String?): Boolean = shut(code, reason ?: "", false)

  override fun cancel() { shut(1006, "cancel", true) }

  private fun shut(code: Int, reason: String, abort: Boolean): Boolean {
    val (qh, s) = synchronized(lock) {
      if (!cancelled) { cancelled = true; cancelAt = SystemClock.elapsedRealtime() }
      Pair(h, wss)
    }
    if (qh != 0L) try { ChatyyNetJni.nativeClose(qh, if (code in 1000..4999) code else 1000, reason, abort) } catch (_: Throwable) {}
    if (s != null) try { if (abort || !s.close(code, reason.ifEmpty { null })) s.cancel() } catch (_: Throwable) { try { s.cancel() } catch (_: Throwable) {} }
    return true
  }
}
