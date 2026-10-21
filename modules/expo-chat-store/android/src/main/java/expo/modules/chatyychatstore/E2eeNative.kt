package expo.modules.chatyychatstore

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.lang.reflect.InvocationHandler
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.Continuation
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.intrinsics.COROUTINE_SUSPENDED

/**
 * [e2ee5 WP-08b] Ponte NATIVA Android → núcleo E2EE v5 (`expo-chatyy-crypto`, WP-03), SEM JS.
 *
 * Quem usa (todos os caminhos nativos que enviam/recebem mensagem sem o JS):
 *   • fila nativa (expo-chat-transport: E2eeOutboxSealer → OutboxCore) — cifra ANTES de gravar;
 *   • compartilhar (ChatyyShareActivity → fila nativa);
 *   • resposta pela notificação / bolha / sync em 2º plano (expo-callkit, por reflexão:
 *     CallkitE2ee.kt — o expo-callkit não depende deste módulo);
 *   • ingestão do transporte (ChatyyStoreDB.ingestFrames) → decifra para a tabela protegida
 *     `e2e_plain` (noBackupFilesDir; nunca JS/AsyncStorage/backup);
 *   • push FCM (dono WP-10): [pushPreview] decifra a prévia `e2e_c` / busca no `e2e_fetch`.
 *
 * GATES (CONTRATO §9): só liga com (1) o núcleo linkado no binário (classe
 * `expo.modules.chatyycrypto.ChatyyCrypto` existe — modo NÚCLEO do WP-03) e (2) a flag nativa
 * `e2ee5_native` gravada pelo `status()` para o uid da conta, e (3) essa conta é a ativa (último
 * `status()`, a mesma cujo núcleo o JS abriu — não trocamos o núcleo "atual" do JS). Binário sem
 * núcleo / flag desligada = tudo [Seal.Plain]/[Dec.Off] = comportamento de hoje, byte a byte.
 *
 * Reflexão (sem dependência Gradle nova, compila sem o núcleo): `ChatyyCrypto.invoke(ctx, op,
 * argsJson)` é `suspend` → chamado com uma Continuation própria e espera com prazo. O R8 mantém
 * `expo.modules.chatyycrypto.**` (consumer-rules do WP-03).
 *
 * NUNCA loga conteúdo, envelope, payload, bearer ou chave: só ids, códigos e tamanhos.
 * Todas as funções de rede/núcleo BLOQUEIAM: chamar fora da main thread.
 */
object E2eeNative {
  private const val TAG = "ChatyyE2ee"
  private const val C_CRYPTO = "expo.modules.chatyycrypto.ChatyyCrypto"
  private const val C_FLAGS = "expo.modules.chatyycrypto.ChatyyCryptoFlags"
  private const val C_AUTH = "expo.modules.chatyycrypto.ChatyyCryptoAuth"
  const val DEFAULT_BASE = "https://chatyy.com.br"
  private const val ENV_PREFIX = "{\"e2e\":"
  private const val ENV5_PREFIX = "{\"e2e\":5"

  // TTL do estado da conversa (o servidor impõe de qualquer jeito: 409 e2ee5_plaintext_refused).
  private const val TTL_ON_MS = 30_000L        // e2ee_mode=1: membros frescos p/ a chave
  private const val TTL_OFF_MS = 120_000L      // e2ee_mode=0: WS conv_e2ee / recusa invalidam antes
  private const val TTL_SENDER_MS = 10 * 60_000L
  private const val GATE_TTL_MS = 5_000L
  private const val SYNC_MIN_GAP_MS = 3_000L
  private const val PENDING_MAX = 200
  private const val PENDING_AGE_MS = 10 * 60_000L

  // ─── resultados ──────────────────────────────────────────────────────────

  sealed class Seal {
    /** Conversa normal (ou gate desligado / estado desconhecido): segue o caminho de hoje. */
    object Plain : Seal()
    /** Conversa E2EE: `envelope` = `{"e2e":5,…}` p/ o `content`; metadados em claro do §2.5. */
    class Env(val envelope: String, val hasLink: Boolean, val sessionId: String) : Seal()
    /** Conversa E2EE mas não deu para cifrar: NUNCA mandar texto puro — abrir o app / falhar. */
    class Fail(val why: String) : Seal()
  }

  sealed class Dec {
    /** Não é envelope, ou gate desligado. */
    object Off : Dec()
    class Ok(val payloadJson: String, val preview: String, val t: String) : Dec()
    /** Não decifrou (ainda): `retryable` = "Aguardando esta mensagem…". */
    class Utd(val reason: String, val retryable: Boolean) : Dec()
    /** `{"e2e":N}` com N≠5 → "Atualize o Chatyy para ler". */
    class Version(val n: Int) : Dec()
  }

  class ConvState(val conv: String, val mode: Int, val since: Long, val members: List<String>, val at: Long)

  class E5Error(val code: String, val details: JSONObject = JSONObject()) : Exception("e2ee5:$code")

  // ─── reflexão sobre o módulo do núcleo ───────────────────────────────────

  private class Refl(
    val crypto: Any, val invoke: Method, val describe: Method?, val addListener: Method?, val listenerCls: Class<*>?,
    val flags: Any, val nativeM: Method, val lastUidM: Method, val uidForAccountM: Method,
    val authCompanion: Any?, val resolveM: Method?,
    /** opcionais (WP-03 ≥ 21/10 tarde): flag e2ee5_push_decrypt e "store já existe" (o nativo nunca cria aparelho). */
    val pushDecryptM: Method?, val secrets: Any?, val existsM: Method?,
  )

  @Volatile private var reflTried = false
  @Volatile private var refl: Refl? = null

  private fun refl(): Refl? {
    if (reflTried) return refl
    synchronized(this) {
      if (reflTried) return refl
      refl = try {
        val cc = Class.forName(C_CRYPTO)
        val crypto = cc.getField("INSTANCE").get(null)
        val inv = cc.getMethod("invoke", Context::class.java, String::class.java, String::class.java, Continuation::class.java)
        val desc = try { cc.getMethod("describe", Throwable::class.java) } catch (_: Throwable) { null }
        val lc = try { Class.forName("$C_CRYPTO\$Listener") } catch (_: Throwable) { null }
        val addL = lc?.let { try { cc.getMethod("addListener", it) } catch (_: Throwable) { null } }
        val fc = Class.forName(C_FLAGS)
        val flags = fc.getField("INSTANCE").get(null)
        val nat = fc.getMethod("native", Context::class.java, String::class.java)
        val last = fc.getMethod("lastUid", Context::class.java)
        val ufa = fc.getMethod("uidForAccount", Context::class.java, String::class.java)
        var comp: Any? = null; var res: Method? = null
        try {
          val ac = Class.forName(C_AUTH)
          comp = ac.getField("Companion").get(null)
          res = comp.javaClass.getMethod("resolve", Context::class.java, String::class.java)
        } catch (_: Throwable) {}
        val pd = try { fc.getMethod("pushDecrypt", Context::class.java, String::class.java) } catch (_: Throwable) { null }
        var sec: Any? = null; var ex: Method? = null
        try {
          val sc = Class.forName("expo.modules.chatyycrypto.ChatyyCryptoSecrets")
          sec = sc.getField("INSTANCE").get(null)
          ex = sc.getMethod("exists", Context::class.java, String::class.java)
        } catch (_: Throwable) {}
        Refl(crypto, inv, desc, addL, lc, flags, nat, last, ufa, comp, res, pd, sec, ex)
      } catch (_: Throwable) {
        null // binário sem o núcleo (stub do WP-03 não tem ChatyyCrypto) → tudo desligado
      }
      reflTried = true
      return refl
    }
  }

  /** O binário tem o núcleo (modo NÚCLEO do expo-chatyy-crypto)? */
  fun coreLinked(): Boolean = refl() != null

  /** Diagnóstico/teste: o que a reflexão achou (sem segredos). */
  internal fun reflDetail(): String = refl()?.let {
    "invoke=1 describe=${if (it.describe != null) 1 else 0} listener=${if (it.addListener != null) 1 else 0} resolve=${if (it.resolveM != null) 1 else 0}"
  } ?: "none"

  /** Chama uma função `suspend` por reflexão e espera o resultado (≤ timeoutMs). */
  internal fun callSuspend(m: Method, target: Any, args: Array<Any?>, timeoutMs: Long): Any? {
    val latch = CountDownLatch(1)
    val ok = AtomicReference<Any?>(null)
    val err = AtomicReference<Throwable?>(null)
    val cont = object : Continuation<Any?> {
      override val context: CoroutineContext = EmptyCoroutineContext
      override fun resumeWith(result: Result<Any?>) {
        val e = result.exceptionOrNull()
        if (e != null) err.set(e) else ok.set(result.getOrNull())
        latch.countDown()
      }
    }
    val all = arrayOfNulls<Any?>(args.size + 1)
    for (i in args.indices) all[i] = args[i]
    all[args.size] = cont
    val r = try { m.invoke(target, *all) } catch (e: InvocationTargetException) { throw e.targetException ?: e }
    if (r !== COROUTINE_SUSPENDED) return r
    if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) throw E5Error("timeout")
    err.get()?.let { throw it }
    return ok.get()
  }

  /** `ChatyyCrypto.invoke(op, args)` → o `v` do resultado. Erro → [E5Error] com o `.code` do §6.11. */
  private fun core(ctx: Context, op: String, args: JSONObject, timeoutMs: Long): Any? {
    val r = refl() ?: throw E5Error("unsupported")
    val out = try {
      callSuspend(r.invoke, r.crypto, arrayOf(ctx.applicationContext ?: ctx, op, args.toString()), timeoutMs) as? String
    } catch (e: E5Error) {
      throw e
    } catch (t: Throwable) {
      val d = r.describe?.let { dm -> try { dm.invoke(r.crypto, t) as? Pair<*, *> } catch (_: Throwable) { null } }
      val code = d?.first as? String ?: "internal"
      throw E5Error(code, d?.second as? JSONObject ?: JSONObject())
    } ?: throw E5Error("internal")
    return try { JSONObject(out).opt("v") } catch (_: Throwable) { throw E5Error("internal") }
  }

  private fun ensureOpen(ctx: Context, uid: String) {
    core(ctx, "open", JSONObject().put("uid", uid), 8_000L)
    registerListener()
  }

  // ─── gate por conta ──────────────────────────────────────────────────────

  private class GateHit(val uid: String?, val at: Long)
  private val gateCache = ConcurrentHashMap<String, GateHit>()

  fun canonEmail(e: String?): String {
    val s = (e ?: "").trim().lowercase()
    return if (s.endsWith("@onemundo.com.br")) s.removeSuffix("@onemundo.com.br") + "@chatyy.com.br" else s
  }

  private fun aliasEmail(e: String): String =
    if (e.endsWith("@chatyy.com.br")) e.removeSuffix("@chatyy.com.br") + "@onemundo.com.br" else e

  /**
   * uid da conta se o E2EE nativo está LIGADO para ela (núcleo linkado + `e2ee5_native` + conta ativa);
   * null = desligado (caminho de hoje).
   */
  fun uidFor(ctx: Context, account: String?): String? {
    val acct = (account ?: "").trim().lowercase()
    if (acct.isEmpty()) return null
    val now = System.currentTimeMillis()
    gateCache[acct]?.let { if (now - it.at < GATE_TTL_MS) return it.uid }
    val r = refl()
    val uid = if (r == null) null else try {
      val app = ctx.applicationContext ?: ctx
      val c = canonEmail(acct)
      val u = (r.uidForAccountM.invoke(r.flags, app, acct) as? String)
        ?: (r.uidForAccountM.invoke(r.flags, app, c) as? String)
        ?: (r.uidForAccountM.invoke(r.flags, app, aliasEmail(c)) as? String)
      val last = r.lastUidM.invoke(r.flags, app) as? String
      // o nativo NUNCA cria o aparelho/store (quem cria é o open() do JS): sem store = desligado
      val exists = r.existsM?.let { m -> (m.invoke(r.secrets, app, u ?: "") as? Boolean) == true } ?: true
      if (u != null && u == last && exists && (r.nativeM.invoke(r.flags, app, u) as? Boolean) == true) u else null
    } catch (_: Throwable) { null }
    gateCache[acct] = GateHit(uid, now)
    return uid
  }

  fun gateOn(ctx: Context, account: String?): Boolean = uidFor(ctx, account) != null

  /** Logout / troca de conta / flag nova: esquece caches de gate e de estado. */
  fun invalidateAll() { gateCache.clear(); convCache.clear() }

  // ─── credenciais (bearer do app) ─────────────────────────────────────────

  class Auth(val bearer: String, val base: String)

  private fun normBase(b: String?): String {
    val s = (b ?: "").trim().trimEnd('/')
    val host = s.removePrefix("https://").substringBefore('/').substringBefore(':').lowercase()
    return if (s.startsWith("https://") && (host == "chatyy.com.br" || host.endsWith(".chatyy.com.br"))) s else DEFAULT_BASE
  }

  /** Bearer passado pelo chamador ou o do núcleo (ChatyyCryptoAuth.resolve: atual / por uid / ChatOutbox). */
  private fun authFor(ctx: Context, uid: String, bearer: String?, base: String?): Auth? {
    if (!bearer.isNullOrEmpty()) return Auth(bearer, normBase(base))
    val r = refl() ?: return null
    return try {
      val a = r.resolveM?.invoke(r.authCompanion, ctx.applicationContext ?: ctx, uid) ?: return null
      val t = a.javaClass.getMethod("getBearer").invoke(a) as? String ?: return null
      val b = a.javaClass.getMethod("getBase").invoke(a) as? String
      if (t.isEmpty()) null else Auth(t, normBase(b))
    } catch (_: Throwable) { null }
  }

  /** POST email.php?action=… → (status, JSON). Sem logar corpo. */
  private fun post(auth: Auth, action: String, body: JSONObject, timeoutMs: Int): Pair<Int, JSONObject?> {
    var conn: HttpURLConnection? = null
    return try {
      conn = (URL(auth.base + "/api/email.php?action=" + action).openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"; doOutput = true
        connectTimeout = minOf(timeoutMs, 6000); readTimeout = timeoutMs
        setRequestProperty("Content-Type", "application/json")
        setRequestProperty("Accept", "application/json")
        setRequestProperty("Authorization", "Bearer " + auth.bearer)
      }
      conn.outputStream.use { it.write(body.toString().toByteArray(StandardCharsets.UTF_8)) }
      val code = conn.responseCode
      val text = try { (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: "" } catch (_: Throwable) { "" }
      code to (try { JSONObject(text) } catch (_: Throwable) { null })
    } catch (_: Throwable) {
      0 to null
    } finally { try { conn?.disconnect() } catch (_: Throwable) {} }
  }

  // ─── estado da conversa (e2ee5_conversation_state, §4.2.19) ──────────────

  private val convCache = ConcurrentHashMap<String, ConvState>()
  private fun ck(account: String, conv: String) = canonEmail(account) + "|" + conv

  /** WS `conv_e2ee` (§5.2) visto pelo transporte nativo: atualiza já (membros vêm no próximo fetch). */
  fun onConvE2ee(account: String, conv: String, mode: Int, since: Long) {
    if (conv.isEmpty()) return
    val k = ck(account, conv)
    val prev = convCache[k]
    // at=0 → membros "velhos": o próximo envio cifrado busca a lista fresca
    convCache[k] = ConvState(conv, if (mode == 1) 1 else 0, since, prev?.members ?: emptyList(), if (mode == 1) 0L else System.currentTimeMillis())
  }

  /** Recusa do servidor/hub por E2EE (`e2ee5_plaintext_refused` / `e2ee5_not_e2ee`): esquece o estado. */
  fun onRefused(account: String, conv: String, code: String) {
    convCache.remove(ck(account, conv))
    Log.i(TAG, "refused conv=$conv code=$code")
  }

  /** Último estado conhecido (sem rede). */
  fun cachedState(account: String, conv: String): ConvState? = convCache[ck(account, conv)]

  /**
   * Estado da conversa (cache ≤ TTL ou busca). null = gate desligado OU não deu para saber
   * (rede) — o chamador segue o caminho de hoje e o servidor impõe (recusa → [onRefused] + reenvio).
   */
  fun convState(ctx: Context, account: String, conv: String, bearer: String? = null, base: String? = null, fresh: Boolean = false): ConvState? {
    val uid = uidFor(ctx, account) ?: return null
    if (conv.isEmpty() || conv.toLongOrNull() == null) return null
    val k = ck(account, conv)
    val now = System.currentTimeMillis()
    val prev = convCache[k]
    if (!fresh && prev != null && prev.at > 0) {
      val ttl = if (prev.mode == 1) TTL_ON_MS else TTL_OFF_MS
      if (now - prev.at < ttl) return prev
    }
    val auth = authFor(ctx, uid, bearer, base) ?: return prev
    val (code, j) = post(auth, "e2ee5_conversation_state", JSONObject().put("conv_id", conv), 8000)
    val d = j?.optJSONObject("data")
    if (code !in 200..299 || j?.optBoolean("success", false) != true || d == null) {
      Log.i(TAG, "conv_state conv=$conv http=$code code=${d?.optString("code") ?: ""}")
      return prev?.takeIf { it.at > 0 }
    }
    val mem = ArrayList<String>()
    d.optJSONArray("members")?.let { a ->
      for (i in 0 until a.length()) {
        val u = a.optJSONObject(i)?.opt("uid")?.toString() ?: continue
        if (u.isNotEmpty() && u != "null" && u.all { it in '0'..'9' }) mem.add(u)
      }
    }
    val st = ConvState(conv, if (d.optInt("e2ee_mode", 0) == 1) 1 else 0, d.optLong("since_pts", 0L), mem, now)
    convCache[k] = st
    // saiu alguém → o núcleo rotaciona a sessão Megolm já (quem sai não lê a próxima) — §6.4
    if (st.mode == 1 && prev != null && prev.members.isNotEmpty()) {
      val removed = prev.members.filter { it !in mem }
      if (removed.isNotEmpty()) try {
        ensureOpen(ctx, uid)
        core(ctx, "onMembersChanged", JSONObject().put("convId", conv).put("memberUids", JSONArray(mem)).put("removedUids", JSONArray(removed)), 8000)
      } catch (e: E5Error) { Log.i(TAG, "members_changed conv=$conv err=${e.code}") }
    }
    return st
  }

  // ─── cifrar (envio nativo) ───────────────────────────────────────────────

  private val LINK_RE = Regex("(?i)\\b(?:https?://|www\\.)\\S+|\\b[a-z0-9][a-z0-9-]{0,62}(?:\\.[a-z0-9-]{1,63})*\\.(?:com|br|net|org|io|app|me|co|dev|ly|gl|gg|tv|info|xyz)(?:/\\S*)?\\b")

  fun hasLink(text: String): Boolean = text.isNotEmpty() && LINK_RE.containsMatchIn(text)

  /**
   * Payload v1 (§2.3/2.4) de texto. `replyMid`/`quote`: citação cifrada (o `reply_to_id` em claro
   * continua no corpo). `extra`: campos opcionais do §2.3 já no formato (effect, mentions…).
   */
  fun textPayload(conv: String, cmid: String, text: String, replyMid: Long = 0L, quote: String? = null, extra: JSONObject? = null): JSONObject {
    val p = JSONObject().put("v", 1).put("t", "text").put("conv", conv).put("cmid", cmid)
      .put("ts", System.currentTimeMillis()).put("body", text)
    if (replyMid > 0) {
      val r = JSONObject().put("mid", replyMid.toString())
      if (!quote.isNullOrEmpty()) r.put("quote", quote.take(300))
      p.put("reply", r)
    }
    extra?.let { e -> val it = e.keys(); while (it.hasNext()) { val k = it.next(); if (!p.has(k)) p.put(k, e.get(k)) } }
    return p
  }

  /**
   * Cifra `payload` para a conversa se ela é E2EE. [Seal.Plain] = conversa normal / gate desligado /
   * estado desconhecido; [Seal.Fail] = É E2EE e não deu (nunca mandar em claro).
   */
  fun seal(ctx: Context, account: String, conv: String, payload: JSONObject, bearer: String? = null, base: String? = null,
           forceFresh: Boolean = false, timeoutMs: Long = 12_000L): Seal {
    val uid = uidFor(ctx, account) ?: return Seal.Plain
    val st = convState(ctx, account, conv, bearer, base, forceFresh) ?: return Seal.Plain
    if (st.mode != 1) return Seal.Plain
    var s = st
    if (s.members.isEmpty()) s = convState(ctx, account, conv, bearer, base, true) ?: return Seal.Fail("no_members")
    if (s.mode != 1) return Seal.Plain
    if (s.members.isEmpty()) return Seal.Fail("no_members")
    return try {
      ensureOpen(ctx, uid)
      val r = core(ctx, "encrypt", JSONObject().put("convId", conv).put("memberUids", JSONArray(s.members)).put("payload", payload.toString()), timeoutMs) as? JSONObject
        ?: return Seal.Fail("internal")
      val env = r.optString("envelopeJson")
      if (!env.startsWith(ENV5_PREFIX)) return Seal.Fail("bad_envelope")
      val body = payload.optString("body").ifEmpty { payload.optString("caption") }
      Seal.Env(env, hasLink(body), r.optString("sessionId"))
    } catch (e: E5Error) {
      Log.i(TAG, "encrypt conv=$conv err=${e.code}")
      Seal.Fail(e.code)
    }
  }

  // ─── decifrar ────────────────────────────────────────────────────────────

  fun isEnvelope(s: String?): Boolean = s != null && s.startsWith(ENV_PREFIX)

  fun envelopeVersion(s: String?): Int {
    if (!isEnvelope(s)) return 0
    return try { JSONObject(s!!).optInt("e2e", -1) } catch (_: Throwable) { -1 }
  }

  private fun lang(): String = Locale.getDefault().language.lowercase()
  private fun tr(pt: String, en: String, es: String): String = when (lang()) { "pt" -> pt; "es" -> es; else -> en }

  /** "Nova mensagem" (prévia genérica até decifrar — e2ee5.push.new_message). */
  fun labelNewMessage(): String = tr("Nova mensagem", "New message", "Nuevo mensaje")
  /** e2ee5.msg.waiting */
  fun labelWaiting(): String = tr("Aguardando esta mensagem. Pode levar um tempo.", "Waiting for this message. This may take a while.", "Esperando este mensaje. Puede tardar un poco.")
  /** e2ee5.msg.cannot_decrypt */
  fun labelCannot(): String = tr("Não foi possível decifrar esta mensagem.", "This message couldn't be decrypted.", "No se pudo descifrar este mensaje.")
  /** e2ee5.msg.update_to_read */
  fun labelUpdate(): String = tr("Mensagem protegida. Atualize o Chatyy para ler.", "Protected message. Update Chatyy to read it.", "Mensaje protegido. Actualiza Chatyy para leerlo.")

  /** Texto curto p/ prévia/bolha/notificação a partir do payload v1 (sem mídia decifrada). */
  fun previewOf(payload: JSONObject): String {
    val t = payload.optString("t")
    val cap = payload.optString("caption").trim()
    fun withCap(l: String) = if (cap.isNotEmpty()) "$l · $cap" else l
    return when (t) {
      "text", "edit" -> payload.optString("body")
      "image" -> withCap(tr("Foto", "Photo", "Foto"))
      "video" -> withCap(tr("Vídeo", "Video", "Video"))
      "gif" -> "GIF"
      "sticker" -> tr("Figurinha", "Sticker", "Sticker")
      "voice" -> tr("Mensagem de voz", "Voice message", "Mensaje de voz")
      "audio" -> payload.optString("title").ifEmpty { tr("Áudio", "Audio", "Audio") }
      "file" -> payload.optJSONArray("media")?.optJSONObject(0)?.optString("name")?.takeIf { it.isNotEmpty() && it != "null" } ?: tr("Documento", "Document", "Documento")
      "location" -> tr("Localização", "Location", "Ubicación")
      "contact" -> tr("Contato", "Contact", "Contacto")
      "poll" -> payload.optString("question").ifEmpty { tr("Enquete", "Poll", "Encuesta") }
      "meetup" -> payload.optString("title").ifEmpty { tr("Encontro", "Meetup", "Encuentro") }
      "reaction" -> tr("Reagiu à sua mensagem", "Reacted to your message", "Reaccionó a tu mensaje")
      else -> labelNewMessage()
    }
  }

  private fun store(ctx: Context): ChatyyStoreDB = ChatyyStoreDB.get(ctx.applicationContext ?: ctx)

  /** uid do remetente: campo explícito, eu mesmo, cache e-mail→uid, 1:1 (o outro membro) ou sender_key dos aparelhos. */
  private fun senderUid(ctx: Context, account: String, myUid: String, conv: String, msg: JSONObject, envelope: String, bearer: String?, base: String?, net: Boolean): String? {
    for (k in arrayOf("sender_uid", "e2e_sender_uid")) {
      val v = msg.opt(k)?.toString().orEmpty()
      if (v.isNotEmpty() && v != "null" && v.all { it in '0'..'9' } && v[0] != '0') return v
    }
    val se = canonEmail(msg.optString("sender_email"))
    if (se.isNotEmpty() && se == canonEmail(account)) return myUid
    if (se.isNotEmpty()) store(ctx).e2eUidGet(account, se)?.let { return it }
    val st = if (!net) cachedState(account, conv)?.takeIf { it.members.isNotEmpty() } ?: return null
      else convState(ctx, account, conv, bearer, base, false)?.takeIf { it.members.isNotEmpty() }
        ?: convState(ctx, account, conv, bearer, base, true) ?: return null
    val others = st.members.filter { it != myUid }
    if (st.members.size == 2 && others.size == 1 && se.isNotEmpty()) return others[0]
    // grupo: o aparelho remetente é o dono da sender_key (curve25519) do envelope
    val sk = try { JSONObject(envelope).optJSONObject("c")?.optString("sender_key").orEmpty() } catch (_: Throwable) { "" }
    if (sk.isEmpty()) return null
    for (u in others.take(64)) {
      val devs = try { core(ctx, "listDevices", JSONObject().put("uid", u), 5000) as? JSONArray } catch (_: E5Error) { null } ?: continue
      for (i in 0 until devs.length()) if (devs.optJSONObject(i)?.optString("curve25519") == sk) return u
    }
    return null
  }

  @Volatile private var lastSyncAt = 0L
  private val syncLock = Any()

  /** `sync()` do núcleo (no máx. 1 a cada 3 s por processo). Guarda os `chatyy.*` p/ o JS (fila e2e_events). */
  fun syncNow(ctx: Context, account: String, why: String): Boolean {
    val uid = uidFor(ctx, account) ?: return false
    synchronized(syncLock) {
      val now = System.currentTimeMillis()
      if (now - lastSyncAt < SYNC_MIN_GAP_MS) return true
      lastSyncAt = now
      return try {
        ensureOpen(ctx, uid)
        val r = core(ctx, "sync", JSONObject(), 15_000L) as? JSONObject
        val ev = r?.optJSONArray("chatyyEvents")
        // o JS pode estar morto: os chatyy.* (chave de ligação, decrypt_report…) não podem sumir
        if (ev != null && ev.length() > 0) store(ctx).e2eEventsPut(account, ev)
        Log.i(TAG, "sync why=$why td=${r?.optLong("toDeviceProcessed") ?: 0} ev=${ev?.length() ?: 0}")
        true
      } catch (e: E5Error) { Log.i(TAG, "sync why=$why err=${e.code}"); false }
    }
  }

  /**
   * Decifra UMA mensagem (linha do servidor/hub: conversation_id?, id, client_message_id, content,
   * sender_email, created_at, sender_uid?). Cache: tabela `e2e_plain` do store da conta.
   * `allowNet`: pode buscar estado/aparelhos e fazer 1 `sync` se faltar a chave.
   */
  fun decrypt(ctx: Context, account: String, conv: String, msg: JSONObject, allowNet: Boolean = true,
              bearer: String? = null, base: String? = null, timeoutMs: Long = 10_000L): Dec {
    val content = msg.optString("content")
    if (!isEnvelope(content)) return Dec.Off
    val n = envelopeVersion(content)
    if (n != 5) return Dec.Version(n)
    val mid = StoreIngest.lng(msg.opt("id"))
    val cmid = msg.optString("client_message_id").takeIf { it != "null" }.orEmpty()
    if (mid > 0) store(ctx).e2ePlainGet(account, conv, mid)?.let { p ->
      val o = try { JSONObject(p) } catch (_: Throwable) { null }
      if (o != null) return Dec.Ok(p, previewOf(o), o.optString("t"))
    }
    val uid = uidFor(ctx, account) ?: return Dec.Off
    return try {
      ensureOpen(ctx, uid)
      val su = senderUid(ctx, account, uid, conv, msg, content, bearer, base, allowNet)
        ?: return Dec.Utd("sender_unknown", true)
      val ts = StoreIngest.ms(msg.opt("created_at")).let { if (it > 0) it else System.currentTimeMillis() }
      val args = JSONObject().put("convId", conv).put("envelopeJson", content).put("senderUid", su)
        .put("serverMid", if (mid > 0) mid.toString() else "0").put("cmid", cmid).put("tsMs", ts)
      val r = try {
        core(ctx, "decrypt", args, timeoutMs) as? JSONObject
      } catch (e: E5Error) {
        val retry = e.code == "utd" && e.details.optBoolean("retryable", false)
        if (!(retry && allowNet && syncNow(ctx, account, "utd"))) throw e
        core(ctx, "decrypt", args, timeoutMs) as? JSONObject
      } ?: return Dec.Utd("internal", true)
      val pj = r.optString("payloadJson")
      val po = try { JSONObject(pj) } catch (_: Throwable) { return Dec.Utd("bad_envelope", false) }
      if (mid > 0) store(ctx).e2ePlainPut(account, conv, mid, cmid, pj, r.optString("trust"))
      val se = canonEmail(msg.optString("sender_email"))
      if (se.isNotEmpty() && su != uid) store(ctx).e2eUidSet(account, se, su)
      Dec.Ok(pj, previewOf(po), po.optString("t"))
    } catch (e: E5Error) {
      val reason = if (e.code == "utd") e.details.optString("reason").ifEmpty { "utd" } else e.code
      val retry = if (e.code == "utd") e.details.optBoolean("retryable", false) else e.code in setOf("timeout", "transport", "lock_busy", "store", "not_open")
      Log.i(TAG, "decrypt conv=$conv mid=$mid err=$reason retry=$retry")
      if (retry && mid > 0) addPending(account, conv, msg)
      Dec.Utd(reason, retry)
    }
  }

  /** Texto para mostrar numa superfície nativa (bolha, notificação): decifrado ou rótulo honesto. */
  fun displayText(d: Dec): String? = when (d) {
    is Dec.Ok -> d.preview
    is Dec.Utd -> if (d.retryable) labelWaiting() else labelCannot()
    is Dec.Version -> labelUpdate()
    Dec.Off -> null
  }

  // ─── fila "aguardando" + onNewKeys (re-tenta quando a chave chega) ───────

  private class Pending(val account: String, val conv: String, val msg: JSONObject, val at: Long)
  private val pending = LinkedHashMap<String, Pending>()
  private val bg = Executors.newSingleThreadExecutor { r -> Thread(r, "chatyy-e2ee").apply { isDaemon = true; priority = Thread.NORM_PRIORITY - 1 } }
  @Volatile private var appCtx: Context? = null
  @Volatile private var listenerOn = false

  private fun addPending(account: String, conv: String, msg: JSONObject) {
    synchronized(pending) {
      val k = conv + "|" + StoreIngest.lng(msg.opt("id"))
      pending.remove(k)
      pending[k] = Pending(account, conv, msg, System.currentTimeMillis())
      while (pending.size > PENDING_MAX) { val it = pending.keys.iterator(); it.next(); it.remove() }
    }
  }

  private fun retryPending(convs: Set<String>?) {
    val ctx = appCtx ?: return
    val now = System.currentTimeMillis()
    val list = synchronized(pending) {
      val out = ArrayList<Pending>()
      val it = pending.entries.iterator()
      while (it.hasNext()) {
        val e = it.next().value
        if (now - e.at > PENDING_AGE_MS) { it.remove(); continue }
        if (convs == null || e.conv in convs) { out.add(e); it.remove() }
      }
      out
    }
    for (p in list) try { decrypt(ctx, p.account, p.conv, p.msg, allowNet = false) } catch (_: Throwable) {}
  }

  /** Ouve `onNewKeys` do núcleo (Proxy da fun interface ChatyyCrypto.Listener). */
  private fun registerListener() {
    if (listenerOn) return
    val r = refl() ?: return
    val lc = r.listenerCls ?: return
    val add = r.addListener ?: return
    synchronized(this) {
      if (listenerOn) return
      try {
        val h = InvocationHandler { proxy, m, args ->
          when (m.name) {
            "onEvent" -> {
              val name = args?.getOrNull(0) as? String
              if (name == "onNewKeys") {
                val ids = ((args.getOrNull(1) as? Map<*, *>)?.get("convIds") as? List<*>)?.mapNotNull { it?.toString() }?.toSet()
                try { bg.execute { retryPending(ids) } } catch (_: Throwable) {}
              }
              null
            }
            "hashCode" -> System.identityHashCode(proxy)
            "equals" -> proxy === args?.getOrNull(0)
            "toString" -> "E2eeNativeListener"
            else -> null
          }
        }
        add.invoke(r.crypto, Proxy.newProxyInstance(lc.classLoader, arrayOf(lc), h))
        listenerOn = true
      } catch (_: Throwable) {}
    }
  }

  // ─── ingestão (transporte nativo / sync em 2º plano) ─────────────────────

  /**
   * Linhas recém-gravadas no store com envelope → decifra em 2º plano para `e2e_plain` e avisa os
   * observadores (a lista nativa repinta com o texto). Gate desligado = não faz nada.
   */
  fun ingestAsync(ctx: Context, account: String, rows: List<Pair<String, JSONObject>>) {
    if (rows.isEmpty()) return
    appCtx = ctx.applicationContext ?: ctx
    if (!coreLinked()) return
    try {
      bg.execute {
        if (!gateOn(ctx, account)) return@execute
        val done = HashSet<String>()
        for ((conv, m) in rows) {
          if (decrypt(ctx, account, conv, m) is Dec.Ok) done.add(conv)
        }
        if (done.isNotEmpty()) store(ctx).e2eNotify(account, done)
      }
    } catch (_: Throwable) {}
  }

  /** Bloqueante (Worker): decifra as linhas do `chat_sync` de uma conversa. → quantas decifraram. */
  fun ingestRowsBlocking(ctx: Context, account: String, conv: String, rows: JSONArray, bearer: String?, base: String?, budgetMs: Long): Int {
    appCtx = ctx.applicationContext ?: ctx
    if (!gateOn(ctx, account)) return 0
    val deadline = System.currentTimeMillis() + budgetMs
    var n = 0
    for (i in 0 until rows.length()) {
      if (System.currentTimeMillis() > deadline) break
      val m = rows.optJSONObject(i) ?: continue
      if (!isEnvelope(m.optString("content"))) continue
      if (decrypt(ctx, account, conv, m, true, bearer, base, 8_000L) is Dec.Ok) n++
    }
    if (n > 0) store(ctx).e2eNotify(account, setOf(conv))
    return n
  }

  /** WS `e2ee5_td` com o app em 2º plano (o JS pode estar parado): sync nativo com debounce. */
  fun onToDeviceHint(ctx: Context, account: String) {
    appCtx = ctx.applicationContext ?: ctx
    if (!coreLinked()) return
    try {
      bg.execute {
        if (!gateOn(ctx, account)) return@execute
        try { Thread.sleep(300) } catch (_: Throwable) {}
        if (syncNow(ctx, account, "td_bg")) retryPending(null)
      }
    } catch (_: Throwable) {}
  }

  // ─── push (FCM: dono WP-10 — chama isto com 1 linha) ─────────────────────

  /**
   * Prévia decifrada de um push E2EE (§7: `e2e`="5", `e2e_c` | `e2e_fetch`, `e2e_conv`, `e2e_mid`,
   * `e2e_cmid`, `e2e_sender_uid`). null = não é push E2EE, gate desligado ou não decifrou → o chamador
   * mostra "Nova mensagem" ([labelNewMessage]). Bloqueia até ~timeoutMs (chamar no thread do FCM).
   * O texto decifrado também vai para `e2e_plain` (a conversa abre já decifrada).
   */
  fun pushPreview(ctx: Context, data: Map<String, String>, timeoutMs: Long = 4_000L): String? {
    if (data["e2e"] != "5") return null
    val account = (data["recipient_email"] ?: data["recipient"] ?: "").trim().lowercase()
    val conv = data["e2e_conv"] ?: data["conversation_id"] ?: return null
    val uid0 = uidFor(ctx, account) ?: return null
    // interruptor da fase do push (§9 e2ee5_push_decrypt, gravado pelo status()); ausente = desligado
    val r = refl() ?: return null
    val pd = try { r.pushDecryptM?.invoke(r.flags, ctx.applicationContext ?: ctx, uid0) as? Boolean } catch (_: Throwable) { null }
    if (pd != true) return null
    val mid = data["e2e_mid"] ?: data["message_id"] ?: ""
    var env = data["e2e_c"].orEmpty()
    var created: Any? = data["bg_ts"]
    val deadline = System.currentTimeMillis() + timeoutMs
    if (env.isEmpty() && data["e2e_fetch"] == "1") {
      val uid = uidFor(ctx, account) ?: return null
      val auth = authFor(ctx, uid, null, null) ?: return null
      val (code, j) = post(auth, "chat_load_around", JSONObject().put("conversation_id", conv.toLongOrNull() ?: return null)
        .put("message_id", mid.toLongOrNull() ?: return null).put("before", 1).put("after", 0), timeoutMs.toInt().coerceIn(1500, 6000))
      if (code !in 200..299) return null
      val arr = j?.optJSONObject("data")?.optJSONArray("messages") ?: j?.optJSONArray("data")
      for (i in 0 until (arr?.length() ?: 0)) {
        val m = arr?.optJSONObject(i) ?: continue
        if (m.opt("id")?.toString() == mid) { env = m.optString("content"); created = m.opt("created_at"); break }
      }
      if (!isEnvelope(env)) return null
    }
    if (!isEnvelope(env)) return null
    val msg = JSONObject().put("id", mid).put("content", env).put("client_message_id", data["e2e_cmid"] ?: "")
      .put("sender_email", data["sender_email"] ?: "").put("created_at", created ?: JSONObject.NULL)
    data["e2e_sender_uid"]?.let { msg.put("sender_uid", it) }
    val left = (deadline - System.currentTimeMillis()).coerceAtLeast(1500L)
    // FCM: aparelho pode estar sem a chave ainda → 1 sync curto dentro do prazo (§7 / NSE)
    val d = decrypt(ctx, account, conv, msg, allowNet = true, timeoutMs = left)
    if (d is Dec.Ok) {
      // aprende o par e-mail→uid do remetente (o push traz os dois)
      val se = canonEmail(data["sender_email"]); val su = data["e2e_sender_uid"].orEmpty()
      if (se.isNotEmpty() && su.isNotEmpty()) store(ctx).e2eUidSet(account, se, su)
      return d.preview.take(300)
    }
    return null
  }

  // ─── API em JSON (p/ chamadores por reflexão: expo-callkit/CallkitE2ee.kt) ─

  /**
   * req {account, conv, cmid, text, reply_mid?, quote?, bearer?, base?, fresh?} →
   * {"kind":"plain"} | {"kind":"env","envelope","has_link"} | {"kind":"fail","why"}
   */
  fun sealTextJson(ctx: Context, reqJson: String): String {
    val q = try { JSONObject(reqJson) } catch (_: Throwable) { return JSONObject().put("kind", "plain").toString() }
    val account = q.optString("account"); val conv = q.optString("conv"); val cmid = q.optString("cmid")
    if (!gateOn(ctx, account)) return JSONObject().put("kind", "plain").toString()
    val p = textPayload(conv, cmid, q.optString("text"), q.optLong("reply_mid", 0L), q.optString("quote").ifEmpty { null })
    return when (val s = seal(ctx, account, conv, p, q.optString("bearer").ifEmpty { null }, q.optString("base").ifEmpty { null }, q.optBoolean("fresh", false))) {
      Seal.Plain -> JSONObject().put("kind", "plain")
      is Seal.Env -> JSONObject().put("kind", "env").put("envelope", s.envelope).put("has_link", s.hasLink)
      is Seal.Fail -> JSONObject().put("kind", "fail").put("why", s.why)
    }.toString()
  }

  /** req {account, conv, msg:{…linha…}, bearer?, base?, net?} → {"kind":"off"|"ok"|"utd"|"version","text"?} */
  fun decryptJson(ctx: Context, reqJson: String): String {
    val q = try { JSONObject(reqJson) } catch (_: Throwable) { return JSONObject().put("kind", "off").toString() }
    val msg = q.optJSONObject("msg") ?: return JSONObject().put("kind", "off").toString()
    val d = decrypt(ctx, q.optString("account"), q.optString("conv"), msg, q.optBoolean("net", true),
      q.optString("bearer").ifEmpty { null }, q.optString("base").ifEmpty { null }, q.optLong("timeout_ms", 8000L))
    val o = JSONObject()
    when (d) {
      Dec.Off -> o.put("kind", "off")
      is Dec.Ok -> o.put("kind", "ok").put("text", d.preview).put("t", d.t)
      is Dec.Utd -> o.put("kind", "utd").put("reason", d.reason).put("retryable", d.retryable).put("text", displayText(d))
      is Dec.Version -> o.put("kind", "version").put("n", d.n).put("text", labelUpdate())
    }
    return o.toString()
  }

  /** req {account, conv, rows:[…], bearer?, base?, budget_ms?} → nº decifradas (Worker do chat_sync). */
  fun ingestRowsJson(ctx: Context, reqJson: String): Int {
    val q = try { JSONObject(reqJson) } catch (_: Throwable) { return 0 }
    return ingestRowsBlocking(ctx, q.optString("account"), q.optString("conv"), q.optJSONArray("rows") ?: JSONArray(),
      q.optString("bearer").ifEmpty { null }, q.optString("base").ifEmpty { null }, q.optLong("budget_ms", 20_000L))
  }

  /** req {account, conv, code} — recusa e2ee5_* vista por um chamador nativo. */
  fun refusedJson(reqJson: String) {
    val q = try { JSONObject(reqJson) } catch (_: Throwable) { return }
    onRefused(q.optString("account"), q.optString("conv"), q.optString("code"))
  }

  /** Para o JS / diagnóstico (sem segredos). */
  fun info(ctx: Context, account: String): Map<String, Any?> = mapOf(
    "coreLinked" to coreLinked(), "gate" to gateOn(ctx, account),
    "pending" to synchronized(pending) { pending.size }, "convCache" to convCache.size,
  )
}
