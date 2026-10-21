// [e2ee5 WP-03] Host nativo Android do núcleo chatyy-crypto (modo NÚCLEO).
//
// `ChatyyCrypto` é a API Kotlin PÚBLICA para os pacotes nativos (08b fila/ingestão, 10 FCM,
// 11 mídia, 13 ligações) chamarem SEM JS; o módulo Expo só usa `ChatyyCryptoImpl.invoke`.
// Transporte do §6.2: POST {base}/api/email.php?action=e2ee5_<action> (OkHttp), Bearer do app,
// X-E2EE-Device, corpo JSON; devolve status/corpo crus (o núcleo interpreta {success,data}).
// Só compila com as bindings UniFFI (com.chatyy.crypto.core) — ver android/build.gradle.
package expo.modules.chatyycrypto

import android.content.Context
import com.chatyy.crypto.core.CoreException
import com.chatyy.crypto.core.CryptoCore
import com.chatyy.crypto.core.DecryptInput
import com.chatyy.crypto.core.DeviceSummary
import com.chatyy.crypto.core.DeviceTarget
import com.chatyy.crypto.core.ExportFilter
import com.chatyy.crypto.core.HttpResponse
import com.chatyy.crypto.core.HttpTransport
import com.chatyy.crypto.core.IdentityStatus
import com.chatyy.crypto.core.ImportResult
import com.chatyy.crypto.core.LinkPhone
import com.chatyy.crypto.core.LinkPhoneState
import com.chatyy.crypto.core.OpenOptions
import com.chatyy.crypto.core.ProcessRole
import com.chatyy.crypto.core.SyncResult
import com.chatyy.crypto.core.TransportException
import com.chatyy.crypto.core.Trust
import com.chatyy.crypto.core.UtdReason
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

internal object ChatyyE2EEHttp {
  private val JSON_MT = "application/json; charset=utf-8".toMediaType()
  private val ACTION_RE = Regex("^[a-z0-9_]{1,48}$")

  private val base: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).writeTimeout(15, TimeUnit.SECONDS)
      .callTimeout(15, TimeUnit.SECONDS).retryOnConnectionFailure(true).followRedirects(false).build()
  }
  private val short: OkHttpClient by lazy { base.newBuilder().callTimeout(5, TimeUnit.SECONDS).build() }

  /** → (status, corpo). Lança [TransportException.Network] sem conteúdo na mensagem. */
  suspend fun post(action: String, body: String, auth: ChatyyCryptoAuth?, deviceId: String, fast: Boolean): Pair<Int, String> {
    if (!ACTION_RE.matches(action)) throw TransportException.Network("bad_action")
    val b = auth?.base ?: ChatyyCryptoConst.DEFAULT_BASE
    val rb = Request.Builder().url("$b/api/email.php?action=e2ee5_$action")
      .post(body.toRequestBody(JSON_MT))
      .header("Accept", "application/json")
    auth?.bearer?.takeIf { it.isNotEmpty() }?.let { rb.header("Authorization", "Bearer $it") }
    if (deviceId.isNotEmpty()) rb.header("X-E2EE-Device", deviceId)
    return withContext(Dispatchers.IO) {
      try {
        (if (fast) short else base).newCall(rb.build()).execute().use { r -> r.code to (r.body?.string() ?: "") }
      } catch (t: Throwable) {
        throw TransportException.Network(t.javaClass.simpleName)
      }
    }
  }
}

internal class ChatyyE2EETransport(
  private val ctx: Context,
  private val uid: String,
  private val deviceId: String,
  private val fast: Boolean,
) : HttpTransport {
  override suspend fun `call`(`action`: String, `bodyJson`: String): HttpResponse {
    val (code, body) = ChatyyE2EEHttp.post(action, bodyJson, ChatyyCryptoAuth.resolve(ctx, uid), deviceId, fast)
    return HttpResponse(code.coerceIn(0, 65535).toUShort(), body)
  }
}

/** Uma instância por processo e por conta (CONTRATO §6.1). */
object ChatyyCrypto {
  const val API_VERSION = ChatyyCryptoConst.API_VERSION
  const val CORE_LINKED = true

  /** (evento, corpo) — o módulo Expo repassa ao JS. Corpo sem segredos. */
  fun interface Listener { fun onEvent(name: String, body: Map<String, Any?>) }

  private val listeners = CopyOnWriteArrayList<Listener>()
  private val cores = ConcurrentHashMap<String, CryptoCore>()
  private val openLock = Mutex()
  @Volatile private var currentUid: String? = null
  @Volatile private var linkPhone: LinkPhone? = null

  fun addListener(l: Listener) { listeners.add(l) }
  fun removeListener(l: Listener) { listeners.remove(l) }

  private fun emit(name: String, body: JSONObject) {
    val m = ChatyyJson.toNative(body) as? Map<*, *> ?: return
    @Suppress("UNCHECKED_CAST") val mm = m as Map<String, Any?>
    for (l in listeners) try { l.onEvent(name, mm) } catch (_: Throwable) {}
  }

  // ─── credenciais / status / flags ─────────────────────────────────────────

  fun setAuth(ctx: Context, bearer: String, base: String, account: String) =
    ChatyyCryptoAuth.saveCurrent(ctx.applicationContext, bearer, base, account)

  /** `e2ee5_status` (§4.2.1). Grava `flags.e2ee5_native` (o núcleo só abre com true). */
  suspend fun status(ctx: Context): JSONObject {
    val app = ctx.applicationContext
    val auth = ChatyyCryptoAuth.current(app)
    val dev = currentUid?.let { cores[it]?.deviceId() }.orEmpty()
    val (code, body) = try {
      ChatyyE2EEHttp.post("status", "{}", auth, dev, false)
    } catch (e: TransportException.Network) {
      throw ChatyyCryptoHostException.of("transport", "msg" to e.msg)
    }
    val j = try { JSONObject(body) } catch (_: Throwable) {
      throw ChatyyCryptoHostException.of("server", "status" to code, "server_code" to "bad_response")
    }
    val d = j.optJSONObject("data")
    if (!j.optBoolean("success", false) || code !in 200..299 || d == null) {
      val sc = d?.optString("code")?.takeIf { it.isNotEmpty() } ?: if (code == 401) "unauthorized" else "error"
      throw ChatyyCryptoHostException.of("server", "status" to code, "server_code" to sc)
    }
    val uid = d.opt("uid")?.toString().orEmpty()
    if (ChatyyCryptoFiles.isValidUid(uid)) {
      val flags = d.optJSONObject("flags")
      val on = flags?.optBoolean("e2ee5_native", false) == true && d.optBoolean("enabled", false) && !d.optBoolean("kill", false)
      ChatyyCryptoFlags.setNative(app, uid, auth?.account.orEmpty(), on)
      // [WP-10] o serviço FCM só decifra com e2ee5_push_decrypt = true (lido sem rede).
      ChatyyCryptoFlags.setPushDecrypt(app, uid, on && flags?.optBoolean("e2ee5_push_decrypt", false) == true)
      ChatyyCryptoAuth.bind(app, uid)
      emit("onNativeFlag", JSONObject().put("uid", uid).put("enabled", on))
    }
    return d
  }

  fun nativeEnabled(ctx: Context, uid: String): Boolean = ChatyyCryptoFlags.native(ctx.applicationContext, uid)

  // ─── ciclo de vida ────────────────────────────────────────────────────────

  class Opened(val deviceId: String, val created: Boolean)

  /** Abre (ou cria) o store do uid. Sem rede. Exige `e2ee5_native` = true gravado pelo `status()`. */
  /** `makeCurrent` = vira a conta "atual" das chamadas do JS (só o `open` do JS usa true). */
  suspend fun open(ctx: Context, uid: String, prefix: String = "P", role: ProcessRole = ProcessRole.APP, makeCurrent: Boolean = true): Opened {
    val app = ctx.applicationContext
    if (!ChatyyCryptoFiles.isValidUid(uid)) throw ChatyyCryptoHostException.of("invalid_input", "field" to "uid")
    if (!ChatyyCryptoFlags.native(app, uid)) throw ChatyyCryptoHostException.of("disabled", "why" to "e2ee5_native")
    return openLock.withLock {
      cores[uid]?.let { if (makeCurrent) currentUid = uid; return@withLock Opened(it.deviceId(), false) }
      val pfx = when (prefix) { "X" -> "X"; "T" -> "T"; else -> "P" }
      val sec = withContext(Dispatchers.IO) {
        ChatyyCryptoSecrets.get(app, uid) { com.chatyy.crypto.core.newDeviceId(pfx) }
      }
      val dir = ChatyyCryptoFiles.storeDir(app, uid)
      val opts = OpenOptions(
        storeDir = dir.absolutePath, storePassphrase = sec.passphrase, uid = uid, deviceId = sec.deviceId,
        role = role, holderSuffix = android.os.Process.myPid().toString(),
      )
      val core = CryptoCore.open(opts, ChatyyE2EETransport(app, uid, sec.deviceId, role == ProcessRole.PUSH))
      cores[uid] = core
      if (makeCurrent) currentUid = uid
      Opened(core.deviceId(), sec.created)
    }
  }

  /**
   * Núcleo do uid (null = o atual / último) para os chamadores NATIVOS: reusa ou abre e, por
   * padrão, NÃO troca a conta atual do JS (serve a qualquer conta logada). Um CryptoCore por uid
   * no processo; a trava entre processos é do próprio núcleo (CrossProcessLock no SQLite).
   */
  suspend fun core(ctx: Context, uid: String? = null, role: ProcessRole = ProcessRole.APP, makeCurrent: Boolean = false): CryptoCore {
    val u = uid ?: currentUid ?: ChatyyCryptoFlags.lastUid(ctx.applicationContext) ?: throw ChatyyCryptoHostException("not_open")
    cores[u]?.let { if (makeCurrent) currentUid = u; return it }
    open(ctx, u, "P", role, makeCurrent)
    return cores[u] ?: throw ChatyyCryptoHostException("not_open")
  }

  /** Núcleo já aberto neste processo, sem abrir nem trocar a conta atual (null = não aberto). */
  fun peekCore(uid: String): CryptoCore? = cores[uid]

  /** Já aberto, sem abrir (o JS chama `open` antes). */
  private fun opened(): CryptoCore = currentUid?.let { cores[it] } ?: throw ChatyyCryptoHostException("not_open")

  fun close() {
    currentUid?.let { cores.remove(it)?.let { c -> try { c.close() } catch (_: Throwable) {} } }
    currentUid = null
    linkPhone = null
  }

  /** Logout / desvincular: apaga store + aparelho (próximo open = aparelho novo). */
  suspend fun wipe(ctx: Context, uid: String): Int = openLock.withLock {
    val app = ctx.applicationContext
    val u = uid.ifEmpty { currentUid.orEmpty() }
    if (!ChatyyCryptoFiles.isValidUid(u)) return@withLock 0
    cores.remove(u)?.let { try { it.close() } catch (_: Throwable) {} }
    if (currentUid == u) { currentUid = null; linkPhone = null }
    ChatyyCryptoAuth.forget(app, u)
    withContext(Dispatchers.IO) { ChatyyCryptoSecrets.wipe(app, u) }
  }

  // ─── sync + eventos ───────────────────────────────────────────────────────

  /** `sync()` + eventos `onSyncResult`/`onNewKeys`/`onIdentityChanged`. source "js" = o chamador recebe os chatyy.*. */
  suspend fun sync(ctx: Context, uid: String? = null, source: String = "native"): SyncResult {
    val c = core(ctx, uid)
    val r = c.sync()
    report(c.uid(), r, source)
    return r
  }

  suspend fun syncWith(ctx: Context, json: String, uid: String? = null, source: String = "native"): SyncResult {
    val c = core(ctx, uid)
    val r = c.syncWith(json)
    report(c.uid(), r, source)
    return r
  }

  private fun report(uid: String, r: SyncResult, source: String) {
    emit("onSyncResult", syncJson(r, source != "js").put("uid", uid).put("source", source))
    if (r.convsWithNewKeys.isNotEmpty()) emit("onNewKeys", JSONObject().put("uid", uid).put("convIds", ChatyyJson.list(r.convsWithNewKeys)))
    if (r.identityChangedUids.isNotEmpty()) emit("onIdentityChanged", JSONObject().put("uid", uid).put("uids", ChatyyJson.list(r.identityChangedUids)))
  }

  // ─── conversões (§6.11, camelCase; UInt/ULong → Long) ─────────────────────

  fun syncJson(r: SyncResult, includeEvents: Boolean = true): JSONObject {
    val o = JSONObject()
      .put("toDeviceProcessed", r.toDeviceProcessed.toLong()).put("toDeviceUtd", r.toDeviceUtd.toLong())
      .put("convsWithNewKeys", ChatyyJson.list(r.convsWithNewKeys))
      .put("identityChangedUids", ChatyyJson.list(r.identityChangedUids))
      .put("more", r.more).put("chatyyEventsCount", r.chatyyEvents.size)
    if (includeEvents) {
      val a = JSONArray()
      for (e in r.chatyyEvents) a.put(
        JSONObject().put("eventType", e.eventType).put("senderUid", e.senderUid)
          .put("senderDeviceId", e.senderDeviceId).put("contentJson", e.contentJson)
      )
      o.put("chatyyEvents", a)
    }
    return o
  }

  private fun deviceJson(d: DeviceSummary) = JSONObject().put("uid", d.uid).put("deviceId", d.deviceId)
    .put("ed25519", d.ed25519).put("curve25519", d.curve25519).put("signedByOwner", d.signedByOwner).put("isThisDevice", d.isThisDevice)

  private fun identityJson(s: IdentityStatus) = JSONObject().put("uid", s.uid).put("hasIdentity", s.hasIdentity)
    .put("masterKey", s.masterKey).put("verified", s.verified).put("needsApproval", s.needsApproval).put("isPrimary", s.isPrimary)

  private fun importJson(r: ImportResult) = JSONObject().put("imported", r.imported.toLong()).put("total", r.total.toLong())
    .put("convs", ChatyyJson.list(r.convs))

  private fun trustStr(t: Trust) = when (t) { Trust.VERIFIED -> "verified"; Trust.TOFU -> "tofu"; Trust.CHANGED -> "changed" }

  private fun utd(r: UtdReason): Pair<String, Boolean> = when (r) {
    UtdReason.MISSING_SESSION -> "missing_session" to true
    UtdReason.UNKNOWN_INDEX -> "unknown_index" to true
    UtdReason.WITHHELD -> "withheld" to false
    UtdReason.UNTRUSTED_DEVICE -> "untrusted_device" to true
    UtdReason.SENDER_MISMATCH -> "sender_mismatch" to false
    UtdReason.CONTEXT_MISMATCH -> "context_mismatch" to false
    UtdReason.BAD_ENVELOPE -> "bad_envelope" to false
    UtdReason.CORRUPTED -> "corrupted" to false
    UtdReason.STORE -> "store" to true
  }

  private fun filter(o: JSONObject?): ExportFilter {
    val f = o ?: JSONObject()
    return ExportFilter(convIds = ChatyyJson.strs(f, "convIds"), sinceMs = ChatyyJson.u64(f, "sinceMs").toULong())
  }

  /** Erro → (`.code` do §6.11, detalhes sem conteúdo). */
  fun describe(e: Throwable): Pair<String, JSONObject> = when (e) {
    is ChatyyCryptoHostException -> e.code to e.details
    is CoreException.Utd -> utd(e.reason).let { (r, retry) ->
      "utd" to JSONObject().put("reason", r).put("retryable", retry).put("session_id", e.sessionId)
    }
    is CoreException.InvalidInput -> "invalid_input" to JSONObject().put("field", e.field).put("msg", e.msg)
    is CoreException.Transport -> "transport" to JSONObject().put("msg", e.msg)
    is CoreException.Server -> "server" to JSONObject().put("status", e.status.toInt()).put("server_code", e.code)
    is CoreException.Store -> "store" to JSONObject().put("msg", e.msg)
    is CoreException.LockBusy -> "lock_busy" to JSONObject()
    is CoreException.Identity -> "identity" to JSONObject().put("msg", e.msg)
    is CoreException.IdentityViolation -> "identity_violation" to JSONObject().put("uids", ChatyyJson.list(e.uids))
    is CoreException.Media -> "media" to JSONObject().put("msg", e.msg)
    is CoreException.Link -> "link" to JSONObject().put("msg", e.msg)
    is CoreException.Backup -> "backup" to JSONObject().put("msg", e.msg)
    is CoreException.Internal -> "internal" to JSONObject().put("msg", e.msg)
    is TransportException.Network -> "transport" to JSONObject().put("msg", e.msg)
    else -> "internal" to JSONObject().put("msg", e.javaClass.simpleName)
  }

  // ─── despacho (§6.11) para o módulo Expo: args/resultado em JSON {"v": …} ─

  suspend fun invoke(ctx: Context, op: String, args: String): String {
    val app = ctx.applicationContext
    val a = ChatyyJson.parse(args)
    fun s(k: String) = ChatyyJson.str(a, k)
    val out: Any? = when (op) {
      "setAuth" -> { setAuth(app, s("bearer"), s("base"), s("account")); JSONObject() }
      "status" -> status(app)
      "nativeEnabled" -> if (s("uid").isEmpty()) ChatyyCryptoFlags.nativeForLast(app) else ChatyyCryptoFlags.native(app, s("uid"))
      "open" -> {
        val r = open(app, s("uid"), s("prefix").ifEmpty { "P" })
        JSONObject().put("uid", s("uid")).put("deviceId", r.deviceId).put("created", r.created)
      }
      "close" -> { close(); JSONObject() }
      "wipe" -> JSONObject().put("deleted", wipe(app, s("uid")))

      // funções livres (§6.3)
      "coreVersion" -> com.chatyy.crypto.core.coreVersion()
      "newDeviceId" -> com.chatyy.crypto.core.newDeviceId(s("prefix"))
      "envelopeVersion" -> com.chatyy.crypto.core.envelopeVersion(s("content"))?.toLong() ?: JSONObject.NULL
      "encryptBytes" -> {
        val r = withContext(Dispatchers.Default) { com.chatyy.crypto.core.encryptBytes(ChatyyJson.b64(a, "data")) }
        JSONObject().put("data", ChatyyJson.b64(r.data)).put("infoJson", r.infoJson)
      }
      "decryptBytes" -> ChatyyJson.b64(withContext(Dispatchers.Default) { com.chatyy.crypto.core.decryptBytes(ChatyyJson.b64(a, "data"), s("infoJson")) })
      "encryptFile" -> {
        val r = withContext(Dispatchers.IO) { com.chatyy.crypto.core.encryptFile(s("inPath"), s("outPath")) }
        JSONObject().put("infoJson", r.infoJson).put("size", r.size.toLong())
      }
      "decryptFile" -> withContext(Dispatchers.IO) { com.chatyy.crypto.core.decryptFile(s("inPath"), s("outPath"), s("infoJson")) }.toLong()

      // CryptoCore (§6.4)
      "thisDevice" -> deviceJson(opened().thisDevice())
      "sync" -> { opened(); syncJson(sync(app, currentUid, "js")) }
      "syncWith" -> { opened(); syncJson(syncWith(app, ChatyyJson.jsonArg(a, "syncData"), currentUid, "js")) }
      "trackUsers" -> { opened().trackUsers(ChatyyJson.strs(a, "uids")); JSONObject() }
      "encrypt" -> try {
        val r = opened().encrypt(s("convId"), ChatyyJson.strs(a, "memberUids"), ChatyyJson.jsonArg(a, "payload"))
        JSONObject().put("envelopeJson", r.envelopeJson).put("sessionId", r.sessionId)
          .put("keyShareRequests", r.keyShareRequests.toLong()).put("keyShareBytes", r.keyShareBytes.toLong())
      } catch (e: CoreException.IdentityViolation) {
        emit("onIdentityViolation", JSONObject().put("uid", currentUid.orEmpty()).put("uids", ChatyyJson.list(e.uids)))
        throw e
      }
      "decrypt" -> {
        val r = opened().decrypt(
          DecryptInput(
            convId = s("convId"), envelopeJson = s("envelopeJson"), senderUid = s("senderUid"),
            serverMid = s("serverMid"), cmid = s("cmid"), tsMs = ChatyyJson.u64(a, "tsMs").toULong(),
          )
        )
        JSONObject().put("payloadJson", r.payloadJson).put("senderUid", r.senderUid).put("senderDeviceId", r.senderDeviceId)
          .put("trust", trustStr(r.trust)).put("sessionId", r.sessionId)
      }
      "sendToDevice" -> {
        val ta = a.optJSONArray("targets") ?: JSONArray()
        val targets = (0 until ta.length()).mapNotNull { i ->
          ta.optJSONObject(i)?.let { DeviceTarget(uid = ChatyyJson.str(it, "uid"), deviceId = ChatyyJson.str(it, "deviceId")) }
        }
        val r = opened().sendToDevice(s("eventType"), targets, ChatyyJson.jsonArg(a, "content"))
        JSONObject().put("sentDevices", r.sentDevices.toLong()).put("withheld", ChatyyJson.list(r.withheld))
      }
      "rotateConversation" -> opened().rotateConversation(s("convId"))
      "onMembersChanged" -> {
        opened().onMembersChanged(s("convId"), ChatyyJson.strs(a, "memberUids"), ChatyyJson.strs(a, "removedUids")); JSONObject()
      }
      "forgetDevice" -> opened().forgetDevice(s("deviceId")).toLong()
      "listDevices" -> JSONArray().also { arr -> opened().listDevices(s("uid")).forEach { arr.put(deviceJson(it)) } }
      "bootstrapIdentity" -> identityJson(opened().bootstrapIdentity())
      "signDevice" -> { opened().signDevice(s("deviceId"), s("expectedEd25519")); JSONObject() }
      "identityStatus" -> identityJson(opened().identityStatus(s("uid")))
      "pinIdentity" -> { opened().pinIdentity(s("uid")); JSONObject() }
      "safetyNumber" -> opened().safetyNumber(s("uid")).let { JSONObject().put("digits", it.digits).put("qrPayload", it.qrPayload) }
      "verifySafetyQr" -> opened().verifySafetyQr(s("uid"), s("scanned"))
      "markVerified" -> { opened().markVerified(s("uid")); JSONObject() }
      "exportRoomKeys" -> ChatyyJson.b64(opened().exportRoomKeys(filter(a.optJSONObject("filter"))))
      "importRoomKeys" -> importJson(opened().importRoomKeys(ChatyyJson.b64(a, "data")))
      "exportRoomKeysWithPassphrase" -> opened().exportRoomKeysWithPassphrase(s("passphrase"))
      "importRoomKeysWithPassphrase" -> importJson(opened().importRoomKeysWithPassphrase(s("data"), s("passphrase")))
      "backupEnable" -> opened().backupEnable(s("passphrase")).let { JSONObject().put("recoveryKey", it.recoveryKey).put("version", it.version) }
      "backupStep" -> opened().backupStep(ChatyyJson.u64(a, "maxBatches").coerceAtMost(UInt.MAX_VALUE.toLong()).toUInt()).toLong()
      "backupStatus" -> opened().backupStatus().let {
        JSONObject().put("enabled", it.enabled).put("version", it.version)
          .put("totalKeys", it.totalKeys.toLong()).put("backedUpKeys", it.backedUpKeys.toLong())
      }
      "backupDisable" -> { opened().backupDisable(); JSONObject() }
      "backupRestore" -> opened().backupRestore(s("keyOrPassphrase")).let {
        JSONObject().put("imported", it.imported.toLong()).put("total", it.total.toLong())
          .put("identityRestored", it.identityRestored).put("convs", ChatyyJson.list(it.convs))
      }
      "metricsSnapshot" -> opened().metricsSnapshot().let {
        JSONObject().put("encrypt", it.encrypt.toLong()).put("decryptOk", it.decryptOk.toLong()).put("utdJson", it.utdJson)
          .put("utdTotal", it.utdTotal.toLong()).put("toDeviceIn", it.toDeviceIn.toLong()).put("toDeviceUtd", it.toDeviceUtd.toLong())
          .put("droppedUntrusted", it.droppedUntrusted.toLong()).put("storeReloads", it.storeReloads.toLong())
      }
      "flushMetrics" -> { opened().flushMetrics(); JSONObject() }

      // vínculo, lado celular (§6.7 / §6.11.5)
      "linkAccept" -> {
        val lp = LinkPhone.accept(opened(), s("qrPayload"), filter(a.optJSONObject("filter")))
        linkPhone = lp
        JSONObject().put("checkCode", lp.checkCode().toInt())
      }
      "linkPhonePoll" -> {
        val lp = linkPhone ?: throw ChatyyCryptoHostException.of("link", "msg" to "no_link")
        when (val st = lp.poll()) {
          is LinkPhoneState.WaitingDevice -> JSONObject().put("state", "waiting_device")
          is LinkPhoneState.WaitingUpload -> JSONObject().put("state", "waiting_upload").put("deviceId", st.deviceId)
          is LinkPhoneState.Sent -> JSONObject().put("state", "sent").put("deviceId", st.deviceId).put("chunks", st.chunks.toLong())
          is LinkPhoneState.Done -> { linkPhone = null; JSONObject().put("state", "done").put("deviceId", st.deviceId) }
        }
      }
      "linkCancel" -> { linkPhone = null; JSONObject() }

      else -> throw ChatyyCryptoHostException.of("unsupported", "op" to op)
    }
    return JSONObject().put("v", out ?: JSONObject.NULL).toString()
  }
}

/** Ponte usada pelo módulo Expo (mesma assinatura no stub). */
internal object ChatyyCryptoImpl {
  const val CORE_LINKED = true
  suspend fun invoke(ctx: Context, op: String, args: String): String = ChatyyCrypto.invoke(ctx, op, args)
  fun describe(e: Throwable): Pair<String, JSONObject> = ChatyyCrypto.describe(e)
  fun addListener(cb: (String, Map<String, Any?>) -> Unit): Any {
    val l = ChatyyCrypto.Listener { n, b -> cb(n, b) }
    ChatyyCrypto.addListener(l)
    return l
  }
  fun removeListener(token: Any) { (token as? ChatyyCrypto.Listener)?.let { ChatyyCrypto.removeListener(it) } }
}
