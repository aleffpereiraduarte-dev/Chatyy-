// [e2ee5 WP-03] Suporte do host nativo Android do núcleo chatyy-crypto (CONTRATO §1.3, §4.1, §6.10).
//
// Não depende do núcleo (compila também no modo stub). Guarda, em noBackupFilesDir/e2ee5/
// (fora do Auto Backup e da transferência D2D):
//   meta/<uid>.json  → device_id + senha do store (32 B aleatórios) CIFRADA com chave AES-GCM
//                      não-exportável do Android Keystore ("chatyy_e2ee5_wrap_v1");
//   meta/auth.bin    → bearer + base (atual e por uid), cifrado com a mesma chave;
//   meta/flags.json  → último `e2ee5_native` por uid/conta (não é segredo);
//   <uid>/           → store SQLite cifrado do núcleo.
// Plano B do bearer: o arquivo do ChatOutbox (noBackupFilesDir/chatyy-outbox/creds.json).
// NUNCA loga bearer, senha, conteúdo ou corpo de resposta.
package expo.modules.chatyycrypto

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object ChatyyCryptoConst {
  /** Versão da API do módulo (JS confere `info().apiVersion >= REQUIRED_API`). */
  const val API_VERSION = 1
  const val DEFAULT_BASE = "https://chatyy.com.br"
  const val KEY_ALIAS = "chatyy_e2ee5_wrap_v1"
}

/** Erro do host com `.code` do §6.11 (`disabled`, `not_open`, `store`…) e detalhes sem conteúdo. */
class ChatyyCryptoHostException(val code: String, val details: JSONObject = JSONObject()) : Exception("e2ee5:$code") {
  companion object {
    fun of(code: String, vararg kv: Pair<String, Any?>): ChatyyCryptoHostException {
      val d = JSONObject()
      for ((k, v) in kv) d.put(k, v ?: JSONObject.NULL)
      return ChatyyCryptoHostException(code, d)
    }
  }
}

/** Chave AES-GCM do Keystore que embrulha os segredos do host (a senha nunca vai clara ao disco). */
internal object ChatyyKeystore {
  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getEntry(ChatyyCryptoConst.KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    g.init(
      KeyGenParameterSpec.Builder(ChatyyCryptoConst.KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .build()
    )
    return g.generateKey()
  }

  /** → "iv_b64:ct_b64" */
  @Synchronized fun seal(plain: ByteArray): String {
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.ENCRYPT_MODE, key())
    val ct = c.doFinal(plain)
    return Base64.encodeToString(c.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
  }

  /** null = chave perdida/dado adulterado (o chamador trata como "aparelho novo"). */
  @Synchronized fun open(sealed: String): ByteArray? = try {
    val i = sealed.indexOf(':')
    if (i <= 0) null else {
      val iv = Base64.decode(sealed.substring(0, i), Base64.NO_WRAP)
      val ct = Base64.decode(sealed.substring(i + 1), Base64.NO_WRAP)
      val c = Cipher.getInstance("AES/GCM/NoPadding")
      c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
      c.doFinal(ct)
    }
  } catch (_: Throwable) { null }
}

internal object ChatyyCryptoFiles {
  fun root(ctx: Context): File = File(ctx.noBackupFilesDir, "e2ee5")
  fun meta(ctx: Context): File = File(root(ctx), "meta").apply { mkdirs() }
  fun storeDir(ctx: Context, uid: String): File = File(root(ctx), uid)

  fun isValidUid(uid: String): Boolean = uid.length in 1..18 && uid[0] != '0' && uid.all { it in '0'..'9' }

  fun readText(f: File): String? = try { if (f.isFile) f.readText() else null } catch (_: Throwable) { null }

  /** Escrita atômica (tmp + rename). */
  fun writeText(f: File, s: String): Boolean = try {
    f.parentFile?.mkdirs()
    val tmp = File(f.path + ".tmp")
    tmp.writeText(s)
    tmp.renameTo(f) || run { f.writeText(s); tmp.delete(); true }
  } catch (_: Throwable) { false }

  fun readJson(f: File): JSONObject = try { JSONObject(readText(f) ?: "{}") } catch (_: Throwable) { JSONObject() }
}

/** Credenciais do transporte (o mesmo bearer/base do ChatTransport; o JS chama setAuth). */
data class ChatyyCryptoAuth(val bearer: String, val base: String, val account: String) {
  companion object {
    fun isUsableBase(b: String): Boolean =
      b.startsWith("https://") && b.removePrefix("https://").substringBefore('/').substringBefore(':').lowercase().let { h ->
        h == "chatyy.com.br" || h.endsWith(".chatyy.com.br")
      }

    fun normBase(b: String): String = b.trim().trimEnd('/').let { if (isUsableBase(it)) it else ChatyyCryptoConst.DEFAULT_BASE }
    fun normAccount(a: String): String = a.trim().lowercase()

    private fun authFile(ctx: Context) = File(ChatyyCryptoFiles.meta(ctx), "auth.bin")

    @Synchronized private fun load(ctx: Context): JSONObject {
      val s = ChatyyCryptoFiles.readText(authFile(ctx)) ?: return JSONObject()
      val b = ChatyyKeystore.open(s.trim()) ?: return JSONObject()
      return try { JSONObject(String(b, Charsets.UTF_8)) } catch (_: Throwable) { JSONObject() }
    }

    @Synchronized private fun save(ctx: Context, o: JSONObject) {
      try { ChatyyCryptoFiles.writeText(authFile(ctx), ChatyyKeystore.seal(o.toString().toByteArray(Charsets.UTF_8))) } catch (_: Throwable) {}
    }

    private fun from(o: JSONObject?): ChatyyCryptoAuth? {
      val t = o?.optString("t").orEmpty()
      if (t.isEmpty()) return null
      return ChatyyCryptoAuth(t, normBase(o?.optString("b").orEmpty()), o?.optString("a").orEmpty())
    }

    @Synchronized fun saveCurrent(ctx: Context, bearer: String, base: String, account: String) {
      val a = normAccount(account)
      val o = load(ctx)
      val cur = JSONObject().put("t", bearer).put("b", normBase(base)).put("a", a)
      o.put("cur", cur)
      if (a.isNotEmpty()) ChatyyCryptoFlags.uidForAccount(ctx, a)?.let { uid ->
        val u = o.optJSONObject("u") ?: JSONObject()
        u.put(uid, cur)
        o.put("u", u)
      }
      save(ctx, o)
    }

    /** Depois do `e2ee5_status`: amarra uid ↔ credencial atual. */
    @Synchronized fun bind(ctx: Context, uid: String) {
      val o = load(ctx)
      val cur = o.optJSONObject("cur") ?: return
      val u = o.optJSONObject("u") ?: JSONObject()
      u.put(uid, cur)
      o.put("u", u)
      save(ctx, o)
    }

    @Synchronized fun current(ctx: Context): ChatyyCryptoAuth? = from(load(ctx).optJSONObject("cur"))

    /** Atual (mesma conta), a gravada para o uid, ou a do ChatOutbox — nessa ordem. */
    @Synchronized fun resolve(ctx: Context, uid: String): ChatyyCryptoAuth? {
      val o = load(ctx)
      val mapped = from(o.optJSONObject("u")?.optJSONObject(uid))
      from(o.optJSONObject("cur"))?.let { c ->
        val cuid = ChatyyCryptoFlags.uidForAccount(ctx, c.account)
        val same = mapped == null || mapped.account == c.account
        if (same && (cuid == null || cuid == uid)) return c
      }
      val m = mapped ?: return null
      if (m.account.isNotEmpty()) outbox(ctx, m.account)?.let { return it }
      return m
    }

    /** ChatOutbox (noBackupFilesDir/chatyy-outbox/creds.json, {conta: {"t","b"}}). */
    fun outbox(ctx: Context, account: String): ChatyyCryptoAuth? {
      val a = normAccount(account)
      if (a.isEmpty()) return null
      val f = File(File(ctx.noBackupFilesDir, "chatyy-outbox"), "creds.json")
      val o = ChatyyCryptoFiles.readJson(f).optJSONObject(a) ?: return null
      val t = o.optString("t")
      if (t.isEmpty()) return null
      return ChatyyCryptoAuth(t, normBase(o.optString("b")), a)
    }

    @Synchronized fun forget(ctx: Context, uid: String) {
      val o = load(ctx)
      o.optJSONObject("u")?.remove(uid)
      save(ctx, o)
    }
  }
}

/** `e2ee5_status.flags.e2ee5_native` gravado (ausente = false: nunca liga sozinho — CONTRATO §9). */
object ChatyyCryptoFlags {
  private fun file(ctx: Context) = File(ChatyyCryptoFiles.meta(ctx), "flags.json")

  @Synchronized fun setNative(ctx: Context, uid: String, account: String, enabled: Boolean) {
    val o = ChatyyCryptoFiles.readJson(file(ctx))
    val u = o.optJSONObject("u") ?: JSONObject()
    u.put(uid, enabled)
    o.put("u", u)
    val a = ChatyyCryptoAuth.normAccount(account)
    if (a.isNotEmpty()) {
      val m = o.optJSONObject("a") ?: JSONObject()
      m.put(a, uid)
      o.put("a", m)
    }
    o.put("last", uid)
    ChatyyCryptoFiles.writeText(file(ctx), o.toString())
  }

  @Synchronized fun setPushDecrypt(ctx: Context, uid: String, enabled: Boolean) {
    val o = ChatyyCryptoFiles.readJson(file(ctx))
    val u = o.optJSONObject("pd") ?: JSONObject()
    u.put(uid, enabled)
    o.put("pd", u)
    ChatyyCryptoFiles.writeText(file(ctx), o.toString())
  }

  /** `e2ee5_status.flags.e2ee5_push_decrypt` (com e2ee5_native) gravado; ausente = false. */
  @Synchronized fun pushDecrypt(ctx: Context, uid: String): Boolean =
    ChatyyCryptoFiles.readJson(file(ctx)).optJSONObject("pd")?.optBoolean(uid, false) ?: false

  @Synchronized fun native(ctx: Context, uid: String): Boolean =
    ChatyyCryptoFiles.readJson(file(ctx)).optJSONObject("u")?.optBoolean(uid, false) ?: false

  @Synchronized fun lastUid(ctx: Context): String? =
    ChatyyCryptoFiles.readJson(file(ctx)).optString("last").takeIf { it.isNotEmpty() }

  fun nativeForLast(ctx: Context): Boolean = lastUid(ctx)?.let { native(ctx, it) } ?: false

  @Synchronized fun uidForAccount(ctx: Context, account: String): String? {
    val a = ChatyyCryptoAuth.normAccount(account)
    if (a.isEmpty()) return null
    return ChatyyCryptoFiles.readJson(file(ctx)).optJSONObject("a")?.optString(a)?.takeIf { it.isNotEmpty() }
  }
}

/** device_id + senha do store por uid (reinstalar = aparelho novo; segredo perdido = store órfão apagado). */
object ChatyyCryptoSecrets {
  class Secrets(val deviceId: String, val passphrase: String, val created: Boolean)

  private fun file(ctx: Context, uid: String) = File(ChatyyCryptoFiles.meta(ctx), "$uid.json")

  @Synchronized fun get(ctx: Context, uid: String, makeDeviceId: () -> String): Secrets {
    val dir = ChatyyCryptoFiles.storeDir(ctx, uid)
    val mf = file(ctx, uid)
    val o = ChatyyCryptoFiles.readJson(mf)
    val dev = o.optString("d")
    val sealed = o.optString("p")
    val pass = sealed.takeIf { it.isNotEmpty() }?.let { ChatyyKeystore.open(it) }?.let { String(it, Charsets.UTF_8) }.orEmpty()
    if (dir.isDirectory && dev.isNotEmpty() && pass.isNotEmpty()) return Secrets(dev, pass, false)
    // Meta presente mas ilegível (Keystore indisponível agora): erro transitório, NUNCA apaga o
    // store. Recuperação explícita = wipe(uid) (logout/desvincular).
    if (dir.isDirectory && mf.isFile && (dev.isEmpty() || sealed.isEmpty() || pass.isEmpty())) {
      throw ChatyyCryptoHostException.of("store", "msg" to "secret_unavailable")
    }
    if (dir.exists()) dir.deleteRecursively()
    val raw = ByteArray(32).also { SecureRandom().nextBytes(it) }
    val np = Base64.encodeToString(raw, Base64.NO_WRAP)
    raw.fill(0)
    val nd = makeDeviceId()
    val newSealed = try { ChatyyKeystore.seal(np.toByteArray(Charsets.UTF_8)) } catch (_: Throwable) {
      throw ChatyyCryptoHostException.of("store", "msg" to "keystore_failed")
    }
    if (!ChatyyCryptoFiles.writeText(file(ctx, uid), JSONObject().put("d", nd).put("p", newSealed).put("v", 1).toString())) {
      throw ChatyyCryptoHostException.of("store", "msg" to "meta_write_failed")
    }
    if (!dir.mkdirs() && !dir.isDirectory) throw ChatyyCryptoHostException.of("store", "msg" to "mkdir_failed")
    return Secrets(nd, np, true)
  }

  /** Store + segredos já existem (o push NUNCA cria store/aparelho). Sem decifrar nada. */
  @Synchronized fun exists(ctx: Context, uid: String): Boolean {
    if (!ChatyyCryptoFiles.storeDir(ctx, uid).isDirectory) return false
    val o = ChatyyCryptoFiles.readJson(file(ctx, uid))
    return o.optString("d").isNotEmpty() && o.optString("p").isNotEmpty()
  }

  @Synchronized fun wipe(ctx: Context, uid: String): Int {
    val dir = ChatyyCryptoFiles.storeDir(ctx, uid)
    val had = dir.exists()
    if (had) dir.deleteRecursively()
    file(ctx, uid).delete()
    return if (had) 1 else 0
  }
}

/** JSON do JS: args e conversões. */
internal object ChatyyJson {
  fun parse(s: String): JSONObject = try { JSONObject(s) } catch (_: Throwable) { JSONObject() }
  fun str(o: JSONObject, k: String): String = if (o.isNull(k)) "" else o.opt(k)?.toString().orEmpty()
  fun strs(o: JSONObject, k: String): List<String> {
    val a = o.optJSONArray(k) ?: return emptyList()
    return (0 until a.length()).mapNotNull { i -> a.opt(i)?.toString()?.takeIf { it.isNotEmpty() && it != "null" } }
  }
  fun u64(o: JSONObject, k: String): Long = when (val v = o.opt(k)) {
    is Number -> if (v.toDouble() <= 0) 0L else v.toLong()
    is String -> v.toLongOrNull()?.coerceAtLeast(0L) ?: 0L
    else -> 0L
  }
  /** Payload/conteúdo: string JSON (preservada) ou objeto (serializado). */
  fun jsonArg(o: JSONObject, k: String): String = when (val v = o.opt(k)) {
    is String -> v
    is JSONObject, is JSONArray -> v.toString()
    else -> "{}"
  }
  fun b64(o: JSONObject, k: String): ByteArray = try {
    Base64.decode(o.getString(k), Base64.NO_WRAP)
  } catch (_: Throwable) { throw ChatyyCryptoHostException.of("invalid_input", "field" to k, "msg" to "base64") }
  fun b64(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)
  fun list(l: List<String>): JSONArray = JSONArray().also { a -> l.forEach { a.put(it) } }

  /** JSONObject/JSONArray → Map/List para o sendEvent do Expo. */
  fun toNative(v: Any?): Any? = when (v) {
    is JSONObject -> v.keys().asSequence().associateWith { toNative(v.opt(it)) }
    is JSONArray -> (0 until v.length()).map { toNative(v.opt(it)) }
    JSONObject.NULL -> null
    else -> v
  }
}

/**
 * Panic do núcleo (2026-10-22, crash iOS 766). O núcleo Rust (panic_report.rs) acrescenta 1 linha
 * por panic em noBackupFilesDir/e2ee5/core_panic.log. Sem conteúdo nem chave. O app lê+apaga no
 * boot seguinte e o JS manda pelo beacon (e2ee5 core_panic).
 */
internal object ChatyyCryptoPanic {
  const val FILE_NAME = "core_panic.log"

  /** Primeiras linhas (≤ 3, ≤ 400 caracteres cada) e apaga o arquivo. "" = nada a relatar. */
  fun take(ctx: Context): String = try {
    val f = File(ChatyyCryptoFiles.root(ctx), FILE_NAME)
    if (!f.isFile) "" else {
      val s = f.readText().take(16 * 1024)
      f.delete()
      val lines = s.split('\n').map { it.take(400) }.filter { it.isNotEmpty() }
      (if (lines.size > 3) "n=${lines.size} | " else "") + lines.take(3).joinToString(" | ")
    }
  } catch (_: Throwable) { "" }
}
