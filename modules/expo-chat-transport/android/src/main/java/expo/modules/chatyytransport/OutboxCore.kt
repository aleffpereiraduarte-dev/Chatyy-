package expo.modules.chatyytransport

import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import okio.BufferedSink
import okio.ForwardingSink
import okio.buffer
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * [2026-10-15 fase 4] Motor da FILA DE ENVIO NATIVA (outbox) — puro Kotlin
 * (org.json + OkHttp): roda igual no app e na JVM (harness contra o hub real).
 * Espelho: ChatOutbox.swift.
 *
 * Cada item (texto ou mídia) é gravado no SQLite da conta (tabela `outbox` do
 * expo-chat-store) com o client_message_id ANTES de qualquer tentativa → mata o
 * app no meio do envio e o item continua lá; quem reenvia é o nativo (WS do
 * transporte nativo → `chat_send` com ack no mesmo socket; sem ack em ~4 s ou
 * sem socket → HTTP `email.php?action=chat_send`). O servidor deduplica por
 * (remetente, client_message_id): reenvio NUNCA duplica.
 *
 * Ordem: FIFO por conversa (1 em voo por conversa; item em espera de backoff
 * segura os de trás). Mídia sobe em paralelo (estado 'uploading' não segura a
 * fila) e depois entra na ordem pelo seq dela (mesma regra da fila JS).
 * Transitório (rede/5xx/timeout/401/429) nunca vira falha; só 4xx definitivo.
 * Offline: não conta tentativa.
 *
 * Toda a lógica roda no executor de 1 thread `exec` (sem locks).
 */
class OutboxCore(
  private val storage: Storage,
  private val net: Net,
  private val exec: ScheduledExecutorService,
  httpClient: OkHttpClient? = null,
) {
  interface Storage {
    /** Insere (idempotente). "new" ou o estado atual. "" = falhou. */
    fun put(account: String, item: JSONObject): String
    fun all(account: String): JSONArray
    fun patch(account: String, cmi: String, p: JSONObject)
    fun remove(account: String, cmi: String)
    fun recover(account: String): Int
    fun sent(account: String, cmi: String, conv: String, server: JSONObject)
    fun failed(account: String, cmi: String, conv: String)
  }

  interface Net {
    fun online(): Boolean
    /** Socket nativo autenticado nesta conta + hub com `native_send`. */
    fun wsReady(account: String): Boolean
    fun wsSend(account: String, text: String): Boolean
    /** [e2ee5 WP-08b] hub com a cap `e2ee5_ns` (aceita envelope pelo WS, §5.3). Sem ela: HTTP. */
    fun wsE2ee(account: String): Boolean = false
  }

  /**
   * [e2ee5 WP-08b] Cifra itens de conversa E2EE ANTES de gravar (nunca texto puro no SQLite).
   * Chamado FORA do executor (bloqueia: estado da conversa + núcleo). Sem sealer = hoje.
   */
  interface Sealer {
    /** Item pronto p/ gravar (cifrado ou o mesmo); null = é E2EE e não deu → não grava ("" ao chamador). */
    fun seal(account: String, item: JSONObject): JSONObject?
    /** Recusa `e2ee5_*` do servidor/hub. Item re-selado (reenviar) ou null (falha definitiva). */
    fun reseal(account: String, item: JSONObject, code: String): JSONObject?
  }

  class Creds(val account: String, val token: String, val base: String)

  companion object {
    val BACKOFF_MS = longArrayOf(1000, 2000, 4000, 8000, 15000, 30000, 60000, 120000, 300000)
    const val WS_ACK_MS = 4000L
    const val MAX_UPLOADS = 2
    const val SENT_KEEP_MS = 7L * 24 * 3600 * 1000
    /** [2026-10-18 outbox-progress] US origin: upload fallback when the regional base keeps failing. */
    const val US_ORIGIN = "https://chatyy.com.br"
    /** Consecutive upload failures on the regional `up.base` before switching to [US_ORIGIN]. */
    const val REGIONAL_UPLOAD_MAX_FAILS = 2L
    /** Progress events: at most one per this many ms (plus the 100% one). */
    const val PROGRESS_MIN_MS = 150L
    /** [2026-10-18 net-change] upload sem bytes há mais que isso na troca de rede = preso → reinicia. */
    const val NET_CHANGE_UPLOAD_IDLE_MS = 3000L
    /** [2026-10-18 upload-4xx] 4xx definitivo no upload: tentativas antes de 'failed'. */
    const val UPLOAD_4XX_MAX_TRIES = 3L
    private val HARD_RE = Regex("\\b403\\b|forbidden|not.?a.?member|no_permission|permission_denied|conversation.?deleted|admin.?only", RegexOption.IGNORE_CASE)
    private val JSON_MT = "application/json; charset=utf-8".toMediaType()
    fun isUsableBase(b: String): Boolean = b.startsWith("https://") && (b.removePrefix("https://").substringBefore('/').let { h -> h == "chatyy.com.br" || h.endsWith(".chatyy.com.br") })
  }

  /** (evento, corpo) → JS (onOutboxState). Nulo com o JS morto. */
  @Volatile var emitter: ((Map<String, Any?>) -> Unit)? = null
  /** Carrega credenciais persistidas (2º plano sem JS). */
  @Volatile var credsLoader: ((String) -> Creds?)? = null
  /** Contas com fila (persistidas) p/ o dreno em 2º plano. */
  @Volatile var accountsLoader: (() -> List<String>)? = null
  /** Teste: base HTTP alternativa (proxy local). */
  @Volatile var baseOverride: String? = null
  /** [e2ee5 WP-08b] cifra antes de persistir (null = comportamento de hoje). */
  @Volatile var sealer: Sealer? = null

  private val http: OkHttpClient = httpClient ?: OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS)
    .callTimeout(40, TimeUnit.SECONDS).retryOnConnectionFailure(true).build()
  private val upHttp: OkHttpClient = http.newBuilder().callTimeout(6, TimeUnit.MINUTES).writeTimeout(5, TimeUnit.MINUTES).build()

  private class Attempt(val account: String, val cmi: String, val conv: String, var phase: String, var timer: ScheduledFuture<*>? = null, var call: Call? = null) {
    /** [2026-10-18 net-change] último sinal de vida do request (início / bytes enviados). */
    @Volatile var lastIoAt: Long = System.currentTimeMillis()
  }

  private val creds = HashMap<String, Creds>()
  private val accounts = LinkedHashSet<String>()
  private val recovered = HashSet<String>()
  private val inflight = HashMap<String, Attempt>() // cmi → envio em voo
  private val uploads = HashMap<String, Attempt>() // cmi → upload em voo
  private val authWaitUntil = HashMap<String, Long>()
  private var wake: ScheduledFuture<*>? = null
  private var wakeAt = 0L
  private var pumpQueued = false
  val stats = HashMap<String, Long>()

  private fun bump(k: String, n: Long = 1) { stats[k] = (stats[k] ?: 0L) + n }
  private fun now() = System.currentTimeMillis()
  private fun norm(a: String) = a.trim().lowercase()
  private fun key(a: String, c: String) = "$a|$c"

  private fun emit(m: Map<String, Any?>) { try { emitter?.invoke(m) } catch (_: Throwable) {} }

  private fun post(fn: () -> Unit) { try { exec.execute { try { fn() } catch (_: Throwable) { bump("errors") } } } catch (_: Throwable) {} }

  // ─── API (qualquer thread) ───────────────────────────────────────────────

  fun configure(account: String, token: String, base: String) {
    val a = norm(account)
    if (a.isEmpty() || token.isEmpty()) return
    val b = if (isUsableBase(base)) base.trimEnd('/') else "https://chatyy.com.br"
    post {
      creds[a] = Creds(a, token, b)
      accounts.add(a)
      authWaitUntil.remove(a)
      schedulePump()
    }
  }

  /** Enfileira (idempotente por cmi). Bloqueia até gravar no SQLite (≤ 4 s). */
  fun submit(account: String, item: JSONObject): String {
    val a = norm(account)
    if (a.isEmpty()) return ""
    // [e2ee5 WP-08b] conversa E2EE: grava SÓ o envelope; não deu p/ cifrar → "" (o JS assume)
    val toPut = sealer?.let { s -> try { s.seal(a, item) } catch (_: Throwable) { null } ?: run { bump("e2eeSealFail"); return "" } } ?: item
    val st = storage.put(a, toPut)
    post {
      accounts.add(a)
      if (st == "new") { bump("submitted"); emit(mapOf("account" to a, "cmi" to item.optString("cmi"), "conv" to item.optString("conv"), "state" to "queued", "tries" to 0)) }
      schedulePump()
    }
    return st
  }

  fun kick(reason: String = "kick") {
    post {
      // reconexão / rede voltou / primeiro plano: tudo que está em espera vira devido
      for (a in accounts.toList()) {
        val items = try { storage.all(a) } catch (_: Throwable) { continue }
        for (i in 0 until items.length()) {
          val it = items.optJSONObject(i) ?: continue
          val st = it.optString("state")
          if ((st == "queued" || st == "uploading") && it.optLong("next_at") > now() && !it.optString("err").startsWith("rl429")) {
            storage.patch(a, it.optString("cmi"), JSONObject().put("next_at", 0))
          }
        }
      }
      bump("kicks")
      pumpNow()
    }
  }

  /** Usuário tocou em "reenviar" num item 'failed'. */
  fun retry(account: String, cmi: String) {
    val a = norm(account)
    post {
      storage.patch(a, cmi, JSONObject().put("state", "queued").put("next_at", 0).put("tries", 0).put("err", JSONObject.NULL))
      accounts.add(a); pumpNow()
    }
  }

  /** JS já conciliou o 'sent'/'failed' → apaga. */
  fun ack(account: String, cmi: String) {
    val a = norm(account)
    post { if (!inflight.containsKey(cmi) && !uploads.containsKey(cmi)) storage.remove(a, cmi) }
  }

  fun cancel(account: String, cmi: String) {
    val a = norm(account)
    post {
      inflight.remove(cmi)?.let { it.timer?.cancel(false); it.call?.cancel() }
      uploads.remove(cmi)?.let { it.call?.cancel() }
      storage.remove(a, cmi)
      pumpNow()
    }
  }

  fun list(account: String): String = try { storage.all(norm(account)).toString() } catch (_: Throwable) { "[]" }

  /** Frame do hub chegou no socket nativo (chat_send_ack / chat_send_fallback). */
  fun onWsFrame(account: String, obj: JSONObject) {
    val type = obj.optString("type")
    val cmi = obj.optString("client_message_id")
    if (cmi.isEmpty()) return
    post {
      val at = inflight[cmi] ?: return@post
      if (at.phase != "ws" || at.account != norm(account)) return@post
      at.timer?.cancel(false)
      val row = obj.optJSONObject("message")
      // [e2ee5 WP-08b] §5.4: recusa definitiva no WS — NÃO reenviar por HTTP o mesmo conteúdo
      if (type == "chat_send_error") {
        bump("wsSendErrors")
        e2eeRefused(at, obj.optString("code").ifEmpty { "chat_send_error" }, obj.optInt("http", 409))
        return@post
      }
      if (type == "chat_send_ack" && row != null && idOf(row) > 0) {
        bump("wsAcks")
        done(at, row, "ws")
      } else {
        bump("wsFallbacks")
        httpSend(at)
      }
    }
  }

  fun onNetwork(up: Boolean) { if (up) kick("net_up") }

  /**
   * [2026-10-18 net-change] Troca de rede (wifi↔4G) ou rede de volta: o request
   * HTTP em voo ficou preso na interface velha até o timeout (30/40 s). Cancela,
   * devolve à fila SEM contar tentativa (o servidor deduplica por
   * client_message_id) e bombeia já. Envios aguardando ack do WS também voltam
   * (o socket velho caiu junto). Upload só é cancelado se estiver parado
   * (sem bytes há > NET_CHANGE_UPLOAD_IDLE_MS): um upload que continua andando
   * (interface velha ainda viva) não perde o que já subiu.
   */
  fun onNetChange(reason: String = "net_change") {
    post {
      val t = now()
      for (at in inflight.values.toList()) {
        if (at.phase != "http" && at.phase != "ws") continue
        inflight.remove(at.cmi)
        at.timer?.cancel(false)
        try { at.call?.cancel() } catch (_: Throwable) {}
        storage.patch(at.account, at.cmi, JSONObject().put("state", "queued").put("next_at", 0).put("err", reason))
        bump("netChangeRequeued")
        emit(mapOf("account" to at.account, "cmi" to at.cmi, "conv" to at.conv, "state" to "queued", "err" to reason, "retryInMs" to 0))
      }
      for (at in uploads.values.toList()) {
        if (t - at.lastIoAt < NET_CHANGE_UPLOAD_IDLE_MS) continue
        uploads.remove(at.cmi)
        try { at.call?.cancel() } catch (_: Throwable) {}
        storage.patch(at.account, at.cmi, JSONObject().put("state", "uploading").put("next_at", 0).put("err", reason))
        bump("netChangeUploadRequeued")
        emit(mapOf("account" to at.account, "cmi" to at.cmi, "conv" to at.conv, "state" to "uploading"))
      }
    }
    kick(reason)
  }

  /** Executor do outbox: há algo pendente (pra agendar o dreno em 2º plano)? */
  fun pendingCount(): Int {
    var n = 0
    for (a in accounts.toList()) {
      val items = try { storage.all(a) } catch (_: Throwable) { continue }
      for (i in 0 until items.length()) { val st = items.optJSONObject(i)?.optString("state"); if (st == "queued" || st == "sending" || st == "uploading") n++ }
    }
    return n
  }

  fun inflightCount(): Int = inflight.size + uploads.size

  fun snapshot(): Map<String, Any?> = HashMap<String, Any?>().also { m ->
    for ((k, v) in stats) m[k] = v.toDouble()
    m["inflight"] = inflight.size; m["uploads"] = uploads.size; m["accounts"] = accounts.size
  }

  /**
   * Dreno síncrono p/ 2º plano (Worker do Android / teste): carrega contas e
   * credenciais persistidas, bombeia e espera até não ter nada devido em voo ou
   * estourar `maxMs`. true = ainda há itens pendentes (reagendar).
   */
  fun drainBlocking(maxMs: Long): Boolean {
    val deadline = now() + maxMs
    try {
      exec.submit {
        accountsLoader?.invoke()?.forEach { accounts.add(norm(it)) }
        pumpNow()
      }.get(10, TimeUnit.SECONDS)
    } catch (_: Throwable) {}
    while (now() < deadline) {
      Thread.sleep(250)
      val busy = try { exec.submit<Boolean> { inflight.isNotEmpty() || uploads.isNotEmpty() || hasDueLocked() }.get(5, TimeUnit.SECONDS) } catch (_: Throwable) { false }
      if (!busy) break
    }
    return try { exec.submit<Int> { pendingCount() }.get(5, TimeUnit.SECONDS) > 0 } catch (_: Throwable) { true }
  }

  // ─── bomba (só no exec) ─────────────────────────────────────────────────

  private fun schedulePump() {
    if (pumpQueued) return
    pumpQueued = true
    post { pumpQueued = false; pumpNow() }
  }

  private fun credsFor(a: String): Creds? {
    creds[a]?.let { return it }
    val c = try { credsLoader?.invoke(a) } catch (_: Throwable) { null } ?: return null
    creds[a] = c
    return c
  }

  private fun hasDueLocked(): Boolean {
    val t = now()
    for (a in accounts) {
      val items = try { storage.all(a) } catch (_: Throwable) { continue }
      for (i in 0 until items.length()) {
        val it = items.optJSONObject(i) ?: continue
        val st = it.optString("state")
        if ((st == "queued" || st == "uploading") && it.optLong("next_at") <= t && net.online()) return true
      }
    }
    return false
  }

  private fun pumpNow() {
    val t = now()
    var nextWake = Long.MAX_VALUE
    for (a in accounts.toList()) {
      if (a !in recovered) {
        recovered.add(a)
        val n = try { storage.recover(a) } catch (_: Throwable) { 0 }
        if (n > 0) bump("recovered", n.toLong())
      }
      val items = try { storage.all(a) } catch (_: Throwable) { continue }
      val blocked = HashSet<String>()
      for (i in 0 until items.length()) {
        val it = items.optJSONObject(i) ?: continue
        val cmi = it.optString("cmi"); val conv = it.optString("conv")
        val st = it.optString("state"); val due = it.optLong("next_at")
        when (st) {
          "sent", "failed" -> {
            // conciliado pelo JS (ack) ou velho demais → some
            if (t - it.optLong("updated_at") > SENT_KEEP_MS) storage.remove(a, cmi)
          }
          "uploading" -> {
            if (uploads.containsKey(cmi)) continue
            if (due > t) { nextWake = minOf(nextWake, due); continue }
            if (uploads.size < MAX_UPLOADS && net.online()) startUpload(a, it)
          }
          "sending" -> {
            // em voo (deste processo) ou órfão recém-recuperado: segura a conversa
            blocked.add(conv)
            if (!inflight.containsKey(cmi)) {
              storage.patch(a, cmi, JSONObject().put("state", "queued").put("next_at", 0))
              nextWake = minOf(nextWake, t + 200)
            }
          }
          "queued" -> {
            if (it.optString("kind") == "media" && !hasFileUrl(it)) {
              // bytes ainda não estão no CDN → sobe em paralelo (não segura a conversa)
              storage.patch(a, cmi, JSONObject().put("state", "uploading").put("next_at", 0))
              if (uploads.size < MAX_UPLOADS && net.online()) startUpload(a, it)
              continue
            }
            if (conv in blocked || inflight.containsKey(cmi)) { blocked.add(conv); continue }
            blocked.add(conv) // FIFO: só a cabeça da conversa sai
            if (due > t) { nextWake = minOf(nextWake, due); continue }
            if (inflight.values.any { x -> x.account == a && x.conv == conv }) continue
            if (!net.online()) continue // rede volta → kick
            val wait = authWaitUntil[a] ?: 0L
            if (wait > t) { nextWake = minOf(nextWake, wait); continue }
            startSend(a, it)
          }
        }
      }
    }
    armWake(nextWake)
  }

  private fun armWake(at: Long) {
    if (at == Long.MAX_VALUE) return
    val t = now()
    val due = maxOf(at, t + 200)
    if (wake != null && wakeAt in 1..due) return
    wake?.cancel(false)
    wakeAt = due
    wake = exec.schedule({ wake = null; wakeAt = 0; try { pumpNow() } catch (_: Throwable) {} }, due - t, TimeUnit.MILLISECONDS)
  }

  private fun hasFileUrl(it: JSONObject): Boolean {
    val b = parseObj(it.opt("body"))
    return b.optString("file_url").isNotEmpty() && b.optString("file_url") != "null"
  }

  private fun parseObj(v: Any?): JSONObject = when (v) {
    is JSONObject -> v
    is String -> try { JSONObject(v) } catch (_: Throwable) { JSONObject() }
    else -> JSONObject()
  }

  private fun idOf(row: JSONObject): Long {
    val v = row.opt("id")
    return when (v) { is Number -> v.toLong(); is String -> v.toLongOrNull() ?: 0L; else -> 0L }
  }

  // ─── envio ──────────────────────────────────────────────────────────────

  private fun startSend(a: String, it: JSONObject) {
    val cmi = it.optString("cmi"); val conv = it.optString("conv")
    val at = Attempt(a, cmi, conv, "ws")
    inflight[cmi] = at
    storage.patch(a, cmi, JSONObject().put("state", "sending"))
    emit(mapOf("account" to a, "cmi" to cmi, "conv" to conv, "state" to "sending", "tries" to it.optLong("tries")))
    bump("attempts")
    val frame = it.optString("frame")
    // [e2ee5 WP-08b] envelope pelo WS só se o hub tem `e2ee5_ns` (§5.3); senão HTTP (que impõe igual)
    val wsOk = !frame.contains("{\\\"e2e\\\":") || net.wsE2ee(a)
    if (frame.isNotEmpty() && frame != "null" && wsOk && net.wsReady(a) && net.wsSend(a, frame)) {
      bump("wsSends")
      at.timer = exec.schedule({ if (inflight[cmi] === at && at.phase == "ws") { bump("wsTimeouts"); httpSend(at) } }, WS_ACK_MS, TimeUnit.MILLISECONDS)
      return
    }
    httpSend(at)
  }

  private fun httpSend(at: Attempt) {
    at.phase = "http"
    val c = credsFor(at.account)
    if (c == null) { authWaitUntil[at.account] = now() + 15000; transient(at, "no_creds", offline = false, auth = true); return }
    val row = findItem(at.account, at.cmi) ?: run { inflight.remove(at.cmi); return }
    val body = parseObj(row.opt("body"))
    val base = baseOverride ?: c.base
    val req = Request.Builder()
      .url("$base/api/email.php?action=chat_send")
      .post(body.toString().toRequestBody(JSON_MT))
      .header("Authorization", "Bearer " + c.token)
      .header("X-Chatyy-Outbox", "native")
      .build()
    bump("httpSends")
    val call = http.newCall(req)
    at.call = call
    call.enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        post { if (inflight[at.cmi] === at) transient(at, "net: " + (e.message ?: "io"), offline = !net.online()) }
      }
      override fun onResponse(call: Call, response: Response) {
        val code = response.code
        val text = try { response.body?.string() ?: "" } catch (_: Throwable) { "" } finally { try { response.close() } catch (_: Throwable) {} }
        post { if (inflight[at.cmi] === at) onHttp(at, code, text) }
      }
    })
  }

  private fun onHttp(at: Attempt, code: Int, text: String) {
    val j = try { JSONObject(text) } catch (_: Throwable) { null }
    val ok = j != null && j.optBoolean("success", false)
    val data = j?.optJSONObject("data")
    if (code in 200..299 && ok && data != null && idOf(data) > 0) { done(at, data, "http"); return }
    val msg = j?.optString("message")?.ifEmpty { j.optString("error") } ?: ""
    // [e2ee5 WP-08b] recusa por E2EE (§8.4): estado da conversa mudou → recifra 1× ou falha (nunca texto puro)
    val e5 = data?.optString("code").orEmpty()
    if (e5.startsWith("e2ee5_") && code in 400..499) { e2eeRefused(at, e5, code); return }
    when {
      code == 401 -> { authWaitUntil[at.account] = now() + 10000; transient(at, "http_401", offline = false, auth = true) }
      code == 429 -> {
        val ra = (data?.optDouble("retry_after", 0.0) ?: 0.0).let { if (it > 0) it else (j?.optDouble("retry_after", 0.0) ?: 0.0) }
        val ms = (if (ra > 0) ra * 1000 else 5000.0).toLong().coerceIn(1000, 65000)
        transient(at, "rl429: " + msg.take(80), offline = false, fixedMs = ms)
      }
      code >= 500 || code == 408 || code == 425 || code == 0 -> transient(at, "http_$code", offline = false)
      code in 400..499 -> hard(at, "http_$code " + msg.take(120))
      code in 200..299 && j != null && HARD_RE.containsMatchIn(msg) -> hard(at, msg.take(120))
      else -> transient(at, "http_$code " + msg.take(80), offline = false)
    }
  }

  /**
   * [e2ee5 WP-08b] Servidor/hub recusou por E2EE. `e2ee5_plaintext_refused` com o item ainda em
   * claro (estado velho da conversa) → o sealer recifra fora do executor e o item volta à fila;
   * 2ª recusa, `e2ee5_not_e2ee`, `e2ee5_bad_request` etc. → falha definitiva ("!", reenviável).
   */
  private fun e2eeRefused(at: Attempt, code: String, http: Int) {
    inflight.remove(at.cmi)
    val s = sealer
    val row = findItem(at.account, at.cmi)
    val again = row?.optString("err").orEmpty().startsWith("e2ee5_resealed")
    if (s == null || row == null || again || code != "e2ee5_plaintext_refused") {
      inflight[at.cmi] = at
      try { s?.reseal(at.account, JSONObject().put("conv", at.conv).put("cmi", at.cmi).put("probe", true), code) } catch (_: Throwable) {}
      hard(at, "$code http_$http")
      return
    }
    // segura o item (não sai de novo em claro) enquanto recifra
    storage.patch(at.account, at.cmi, JSONObject().put("state", "queued").put("next_at", now() + 120_000L).put("err", "e2ee5_resealing"))
    bump("e2eeReseal")
    val acct = at.account
    Thread({
      val n = try { s.reseal(acct, row, code) } catch (_: Throwable) { null }
      post {
        if (n != null) {
          val p = JSONObject().put("state", "queued").put("next_at", 0).put("err", "e2ee5_resealed")
          n.opt("body")?.let { b -> p.put("body", b.toString()) }
          // frame cifrado (ou vazio → só HTTP): o texto puro não sai de novo
          p.put("frame", n.optString("frame").ifEmpty { "" })
          storage.patch(acct, at.cmi, p)
          pumpNow()
        } else {
          inflight[at.cmi] = at
          hard(at, "$code reseal_failed")
        }
      }
    }, "chatyy-outbox-e2ee").start()
  }

  private fun findItem(a: String, cmi: String): JSONObject? {
    val items = try { storage.all(a) } catch (_: Throwable) { return null }
    for (i in 0 until items.length()) { val it = items.optJSONObject(i) ?: continue; if (it.optString("cmi") == cmi) return it }
    return null
  }

  private fun done(at: Attempt, server: JSONObject, via: String) {
    inflight.remove(at.cmi)
    at.timer?.cancel(false)
    try { storage.sent(at.account, at.cmi, at.conv, server) } catch (_: Throwable) {}
    bump("sent")
    emit(mapOf("account" to at.account, "cmi" to at.cmi, "conv" to at.conv, "state" to "sent", "via" to via, "server" to server.toString()))
    pumpNow()
  }

  private fun hard(at: Attempt, err: String) {
    inflight.remove(at.cmi)
    storage.patch(at.account, at.cmi, JSONObject().put("state", "failed").put("err", err))
    try { storage.failed(at.account, at.cmi, at.conv) } catch (_: Throwable) {}
    bump("hardFails")
    emit(mapOf("account" to at.account, "cmi" to at.cmi, "conv" to at.conv, "state" to "failed", "kind" to "hard", "err" to err))
    pumpNow()
  }

  private fun transient(at: Attempt, err: String, offline: Boolean, auth: Boolean = false, fixedMs: Long = -1) {
    inflight.remove(at.cmi)
    val row = findItem(at.account, at.cmi)
    val tries = (row?.optLong("tries") ?: 0L) + (if (offline) 0 else 1)
    val delay = when {
      fixedMs >= 0 -> fixedMs
      offline -> 30000L
      else -> { val b = BACKOFF_MS[minOf((tries - 1).toInt().coerceAtLeast(0), BACKOFF_MS.size - 1)]; (b * (0.8 + Math.random() * 0.4)).toLong() }
    }
    storage.patch(at.account, at.cmi, JSONObject().put("state", "queued").put("tries", tries).put("next_at", now() + delay).put("err", err))
    bump(if (offline) "offlineRetries" else "transient")
    emit(mapOf("account" to at.account, "cmi" to at.cmi, "conv" to at.conv, "state" to "queued", "tries" to tries, "err" to err, "retryInMs" to delay))
    if (auth) emit(mapOf("account" to at.account, "state" to "auth_needed"))
    pumpNow()
  }

  // ─── mídia: upload único (Rust /api/rust/upload) e depois chat_send ─────

  private fun startUpload(a: String, it: JSONObject) {
    val cmi = it.optString("cmi"); val conv = it.optString("conv")
    val up = parseObj(it.opt("up"))
    val path = it.optString("file").removePrefix("file://")
    val f = File(path)
    if (path.isEmpty() || !f.exists()) {
      val at = Attempt(a, cmi, conv, "upload"); inflight[cmi] = at
      hard(at, "no_local_file"); return
    }
    val c = credsFor(a)
    if (c == null) { authWaitUntil[a] = now() + 15000; storage.patch(a, cmi, JSONObject().put("next_at", now() + 15000)); emit(mapOf("account" to a, "state" to "auth_needed")); return }
    val at = Attempt(a, cmi, conv, "upload")
    uploads[cmi] = at
    emit(mapOf("account" to a, "cmi" to cmi, "conv" to conv, "state" to "uploading"))
    // [2026-10-18 outbox-progress] Regional media edge (`up.base`, set by JS)
    // first; after REGIONAL_UPLOAD_MAX_FAILS consecutive failed uploads (every
    // earlier try of this item went to the regional base) → US origin. `tries`
    // is persisted, so this survives process death; retry() resets it.
    val regional = up.optString("base").let { b -> if (isUsableBase(b)) b.trimEnd('/') else "" }
    val tries = it.optLong("tries")
    val base = baseOverride ?: when {
      regional.isEmpty() -> c.base
      tries >= REGIONAL_UPLOAD_MAX_FAILS && regional != US_ORIGIN -> { bump("uploadUsFallback"); US_ORIGIN }
      else -> regional
    }
    val name = up.optString("filename").ifEmpty { f.name }
    val mime = up.optString("mime").ifEmpty { "application/octet-stream" }
    // [2026-10-23 midia-wa] BUILD: PUT DIRETO no R2 (URL pré-assinada que o JS pôs em up.put_url,
    // services/r2DirectUpload.presignFor). Bytes celular → R2, sem multipart nem PHP/Rust. Só 1 tentativa:
    // falha → up.put_fails=1 e a próxima volta usa o caminho de sempre (/api/rust/upload).
    val putUrl = directPutUrl(up)
    if (putUrl == null && up.optString("put_url").isNotEmpty()) {
      up.remove("put_url"); up.put("put_fails", 1) // vencida/inválida: o uploadDone não confunde esta resposta com a do PUT
      storage.patch(a, cmi, JSONObject().put("up", up.toString()))
    }
    val putHeaders = parseObj(up.opt("put_headers"))
    val putCt = putHeaders.optString("Content-Type").ifEmpty { putHeaders.optString("content-type") }.ifEmpty { "application/octet-stream" }
    // [2026-10-18 outbox-progress] REAL bytes-sent progress for the bubble ring
    // (was a fake 10% → 50% → 100%). Throttled; posted on exec and dropped if
    // the attempt is no longer current. Old JS ignores state "progress".
    var lastAt = 0L
    var lastPct = -1
    // PUT: o tipo do corpo É o Content-Type assinado (o OkHttp grava o do corpo no cabeçalho)
    val fileBody = ProgressRequestBody(f.asRequestBody((if (putUrl != null) putCt else mime).toMediaType())) { sent, total ->
      val pct = if (total > 0L) ((sent * 100L) / total).toInt().coerceIn(0, 100) else 0
      val t = now()
      at.lastIoAt = t // [net-change] bytes andando = upload vivo (thread do OkHttp; @Volatile)
      if (pct != lastPct && (pct >= 100 || t - lastAt >= PROGRESS_MIN_MS)) {
        lastAt = t
        lastPct = pct
        post {
          if (uploads[cmi] === at) {
            emit(mapOf("account" to a, "cmi" to cmi, "conv" to conv, "state" to "progress", "sent" to sent, "total" to total, "pct" to pct))
          }
        }
      }
    }
    val req = if (putUrl != null) {
      val rb = Request.Builder().url(putUrl).put(fileBody)
      val ks = putHeaders.keys()
      while (ks.hasNext()) { val k = ks.next(); if (!k.equals("content-type", true) && !k.equals("content-length", true) && !k.equals("host", true)) rb.header(k, putHeaders.optString(k)) }
      bump("uploadsPut")
      rb.build()
    } else {
      val mb = MultipartBody.Builder().setType(MultipartBody.FORM)
        .addFormDataPart("file", name, fileBody)
        .addFormDataPart("user_email", up.optString("user_email").ifEmpty { a })
        .addFormDataPart("context", up.optString("context").ifEmpty { "chat" })
        .addFormDataPart("filename", name)
        .build()
      Request.Builder().url("$base/api/rust/upload").post(mb).header("Authorization", "Bearer " + c.token).build()
    }
    bump("uploads")
    val call = upHttp.newCall(req)
    at.call = call
    call.enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) { post { if (uploads[cmi] === at) uploadDone(at, 0, "") } }
      override fun onResponse(call: Call, response: Response) {
        val code = response.code
        val text = try { response.body?.string() ?: "" } catch (_: Throwable) { "" } finally { try { response.close() } catch (_: Throwable) {} }
        post { if (uploads[cmi] === at) uploadDone(at, code, text) }
      }
    })
  }

  /** Também chamado pelo iOS-equivalente (sessão em 2º plano) — aqui só Android/JVM. */
  /** [2026-10-23 midia-wa] BUILD: URL de PUT pré-assinado válida em up? (https R2, não vencida, sem falha anterior) */
  private fun directPutUrl(up: JSONObject): String? {
    val u = up.optString("put_url")
    if (u.isEmpty() || up.optLong("put_fails") >= 1 || up.optString("cdn_url").isEmpty()) return null
    val host: String = (try { java.net.URI(u).let { if (it.scheme == "https") it.host else null } } catch (_: Throwable) { null }) ?: return null
    if (!host.endsWith(".r2.cloudflarestorage.com")) return null
    val exp = up.optLong("put_exp") // epoch s
    if (exp > 0L && exp * 1000L < now() + 60000L) return null
    return u
  }

  private fun uploadDone(at: Attempt, code: Int, text: String) {
    uploads.remove(at.cmi)
    // [2026-10-23 midia-wa] BUILD: resposta do PUT direto no R2 (corpo vazio; cdn_url veio do presign).
    // put_url só fica na linha enquanto o PUT é a tentativa em curso (startUpload limpa se não usar).
    val prow = findItem(at.account, at.cmi)
    val pup = parseObj(prow?.opt("up"))
    if (prow != null && pup.optString("put_url").isNotEmpty() && pup.optLong("put_fails") < 1L) {
      val cdnP = pup.optString("cdn_url")
      if (code in 200..299 && cdnP.isNotEmpty()) {
        val body = parseObj(prow.opt("body"))
        body.put("file_url", cdnP)
        body.put("file_name", pup.optString("filename"))
        if (pup.optLong("put_size") > 0L) body.put("file_size", pup.optLong("put_size"))
        storage.patch(at.account, at.cmi, JSONObject().put("body", body.toString()).put("state", "queued").put("next_at", 0).put("err", JSONObject.NULL))
        bump("uploaded"); bump("uploadedPut")
        emit(mapOf("account" to at.account, "cmi" to at.cmi, "conv" to at.conv, "state" to "uploaded", "cdn_url" to cdnP))
        pumpNow(); return
      }
      pup.remove("put_url"); pup.put("put_fails", 1)
      storage.patch(at.account, at.cmi, JSONObject().put("up", pup.toString()).put("state", "uploading").put("next_at", 0).put("err", "put_http_$code"))
      bump("putFallback")
      pumpNow(); return
    }
    val j = try { JSONObject(text) } catch (_: Throwable) { null }
    val cdn = j?.optString("cdn_url") ?: ""
    if (code in 200..299 && j != null && j.optBoolean("success", false) && cdn.isNotEmpty()) {
      val row = findItem(at.account, at.cmi) ?: return
      val body = parseObj(row.opt("body"))
      val up = parseObj(row.opt("up"))
      body.put("file_url", cdn)
      body.put("file_name", j.optString("filename").ifEmpty { up.optString("filename") })
      if (j.has("size")) body.put("file_size", j.optLong("size"))
      storage.patch(at.account, at.cmi, JSONObject().put("body", body.toString()).put("state", "queued").put("next_at", 0).put("err", JSONObject.NULL))
      bump("uploaded")
      emit(mapOf("account" to at.account, "cmi" to at.cmi, "conv" to at.conv, "state" to "uploaded", "cdn_url" to cdn))
      pumpNow(); return
    }
    if (code == 413 || code == 415) {
      inflight[at.cmi] = at
      hard(at, "upload_http_$code"); return
    }
    val row = findItem(at.account, at.cmi)
    val tries = (row?.optLong("tries") ?: 0L) + (if (net.online()) 1 else 0)
    // [2026-10-18 upload-4xx] 400/403/404/422… não se curam sozinhos: limite de
    // tentativas e depois 'failed' ("!", reenviável). 401/408/429 seguem transitórios.
    if (code in 400..499 && code != 401 && code != 408 && code != 429 && tries >= UPLOAD_4XX_MAX_TRIES) {
      inflight[at.cmi] = at
      hard(at, "upload_http_$code"); return
    }
    val delay = if (!net.online()) 30000L else BACKOFF_MS[minOf((tries - 1).toInt().coerceAtLeast(0), BACKOFF_MS.size - 1)]
    storage.patch(at.account, at.cmi, JSONObject().put("state", "uploading").put("tries", tries).put("next_at", now() + delay).put("err", "upload_http_$code"))
    if (code == 401) emit(mapOf("account" to at.account, "state" to "auth_needed"))
    bump("uploadRetries")
    pumpNow()
  }
}

/**
 * [2026-10-18 outbox-progress] Wraps the file part and reports the bytes OkHttp
 * actually wrote to the socket (onProgress(sent, total), on OkHttp's writer
 * thread). A retried write (OkHttp re-sends the body) simply starts again at 0
 * — the JS ring is monotonic.
 */
private class ProgressRequestBody(
  private val inner: RequestBody,
  private val onProgress: (Long, Long) -> Unit,
) : RequestBody() {
  override fun contentType(): MediaType? = inner.contentType()
  override fun contentLength(): Long = inner.contentLength()
  override fun isOneShot(): Boolean = inner.isOneShot()
  override fun writeTo(sink: BufferedSink) {
    val total = contentLength()
    val counting = object : ForwardingSink(sink) {
      private var sent = 0L
      override fun write(source: Buffer, byteCount: Long) {
        super.write(source, byteCount)
        sent += byteCount
        try { onProgress(sent, total) } catch (_: Throwable) {}
      }
    }
    val buffered = counting.buffer()
    inner.writeTo(buffered)
    buffered.flush()
  }
}
