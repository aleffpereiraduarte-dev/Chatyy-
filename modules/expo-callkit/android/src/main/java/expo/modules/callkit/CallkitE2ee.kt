package expo.modules.callkit

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.lang.reflect.Method

/**
 * [e2ee5 WP-08b] Ponte do expo-callkit (resposta pela notificação, bolha, sync em 2º plano) para a
 * cripto nativa do Chatyy — `expo.modules.chatyychatstore.E2eeNative` (expo-chat-store), POR
 * REFLEXÃO: o expo-callkit não depende do expo-chat-store no Gradle (e o build.gradle dele não é
 * deste pacote). Classe ausente / gate desligado (sem núcleo no binário ou sem `e2ee5_native`) =
 * [Seal.Plain]/null = comportamento de hoje.
 *
 * Bloqueia (rede + núcleo): chamar fora da main thread. Nunca loga conteúdo.
 */
internal object CallkitE2ee {
  private const val TAG = "CallkitE2ee"
  private const val CLS = "expo.modules.chatyychatstore.E2eeNative"

  sealed class Seal {
    object Plain : Seal()
    class Env(val envelope: String, val hasLink: Boolean) : Seal()
    class Fail(val why: String) : Seal()
  }

  private class R(val inst: Any, val seal: Method, val decrypt: Method, val ingest: Method, val refused: Method, val gate: Method)

  @Volatile private var tried = false
  @Volatile private var r: R? = null

  private fun r(): R? {
    if (tried) return r
    synchronized(this) {
      if (tried) return r
      r = try {
        val c = Class.forName(CLS)
        val inst = c.getField("INSTANCE").get(null)
        R(
          inst,
          c.getMethod("sealTextJson", Context::class.java, String::class.java),
          c.getMethod("decryptJson", Context::class.java, String::class.java),
          c.getMethod("ingestRowsJson", Context::class.java, String::class.java),
          c.getMethod("refusedJson", String::class.java),
          c.getMethod("gateOn", Context::class.java, String::class.java),
        )
      } catch (_: Throwable) { null }
      tried = true
      return r
    }
  }

  fun isEnvelope(s: String?): Boolean = s != null && s.startsWith("{\"e2e\":")

  /** E2EE nativo ligado para a conta (núcleo + flag)? Barato (cache de 5 s do lado do store). */
  fun gateOn(ctx: Context, account: String): Boolean = try {
    r()?.let { it.gate.invoke(it.inst, ctx.applicationContext ?: ctx, account) as? Boolean } == true
  } catch (_: Throwable) { false }

  /**
   * Texto da resposta → envelope se a conversa é E2EE. `fresh` = ignora o cache do estado (depois de
   * uma recusa e2ee5_plaintext_refused).
   */
  fun sealText(ctx: Context, account: String, bearer: String, base: String, conv: String, cmid: String, text: String,
               replyMid: Long = 0L, quote: String? = null, fresh: Boolean = false): Seal {
    val x = r() ?: return Seal.Plain
    return try {
      val q = JSONObject().put("account", account).put("conv", conv).put("cmid", cmid).put("text", text)
        .put("bearer", bearer).put("base", base).put("fresh", fresh)
      if (replyMid > 0) q.put("reply_mid", replyMid)
      if (!quote.isNullOrEmpty()) q.put("quote", quote)
      val o = JSONObject(x.seal.invoke(x.inst, ctx.applicationContext ?: ctx, q.toString()) as String)
      when (o.optString("kind")) {
        "env" -> Seal.Env(o.optString("envelope"), o.optBoolean("has_link", false))
        "fail" -> Seal.Fail(o.optString("why"))
        else -> Seal.Plain
      }
    } catch (t: Throwable) {
      Log.w(TAG, "seal failed: ${t.javaClass.simpleName}")
      // gate ligado e algo quebrou: na dúvida NÃO manda texto puro
      if (gateOn(ctx, account)) Seal.Fail("bridge") else Seal.Plain
    }
  }

  /**
   * Linha de mensagem com envelope → texto para a superfície nativa (decifrado, "Aguardando…",
   * "Atualize…"). null = não é envelope (use o content como hoje).
   */
  fun displayText(ctx: Context, account: String, conv: String, msg: JSONObject, bearer: String?, base: String?, net: Boolean = true): String? {
    if (!isEnvelope(msg.optString("content"))) return null
    val x = r() ?: return null
    return try {
      val q = JSONObject().put("account", account).put("conv", conv).put("msg", msg).put("net", net).put("timeout_ms", 6000)
      if (!bearer.isNullOrEmpty()) q.put("bearer", bearer)
      if (!base.isNullOrEmpty()) q.put("base", base)
      val o = JSONObject(x.decrypt.invoke(x.inst, ctx.applicationContext ?: ctx, q.toString()) as String)
      o.optString("text").takeIf { it.isNotEmpty() && o.optString("kind") != "off" }
    } catch (_: Throwable) { null }
  }

  /** Worker do chat_sync: decifra as linhas com envelope para o store protegido. */
  fun ingestRows(ctx: Context, account: String, conv: String, rows: JSONArray, bearer: String, base: String, budgetMs: Long): Int {
    val x = r() ?: return 0
    return try {
      val q = JSONObject().put("account", account).put("conv", conv).put("rows", rows).put("bearer", bearer).put("base", base).put("budget_ms", budgetMs)
      (x.ingest.invoke(x.inst, ctx.applicationContext ?: ctx, q.toString()) as? Int) ?: 0
    } catch (_: Throwable) { 0 }
  }

  fun refused(account: String, conv: String, code: String) {
    val x = r() ?: return
    try { x.refused.invoke(x.inst, JSONObject().put("account", account).put("conv", conv).put("code", code).toString()) } catch (_: Throwable) {}
  }

  /** `data.code` de uma resposta de erro do email.php (ex.: e2ee5_plaintext_refused). */
  fun errorCode(body: String?): String = try { JSONObject(body ?: "").optJSONObject("data")?.optString("code").orEmpty() } catch (_: Throwable) { "" }
}
