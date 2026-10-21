package expo.modules.chatyytransport

import android.content.Context
import android.util.Log
import expo.modules.chatyychatstore.E2eeNative
import org.json.JSONArray
import org.json.JSONObject

/**
 * [e2ee5 WP-08b] Fila nativa (OutboxCore) × E2EE v5: cifra o item ANTES de gravar no SQLite.
 *
 * Conversa `e2ee_mode=1` (estado pelo `e2ee5_conversation_state`, cache curto em [E2eeNative]):
 *   • texto → payload v1 `t:"text"` (citação, efeito e `reply_quote_text` vão DENTRO do envelope);
 *     `body.content` e `frame.content` = `{"e2e":5,…}`; em claro só o §2.5 (type, cmid,
 *     reply_to_id, mentions, has_link, silent);
 *   • mídia → F3 (WP-11, `encryptFileForUpload`) ainda não existe → NÃO grava (null): o JS assume
 *     ou o compartilhar abre o app. Nunca sobe arquivo/legenda em claro numa conversa E2EE.
 * Conteúdo que já chega como envelope (o JS cifrou — WP-08c) passa intacto.
 * Gate desligado / conversa normal / estado desconhecido = item intacto (o servidor impõe: a
 * recusa `e2ee5_plaintext_refused` volta em [reseal], que recifra 1×).
 */
internal class E2eeOutboxSealer(
  private val ctx: Context,
  private val credsOf: (String) -> OutboxCore.Creds?,
) : OutboxCore.Sealer {
  companion object {
    private const val TAG = "ChatyyOutboxE2ee"
    /** Campos do corpo/frame que carregam conteúdo e NUNCA vão em claro numa conversa E2EE. */
    private val CLEAR_DROP = arrayOf("reply_quote_text", "effect", "link_preview", "file_name", "thumb_b64", "translation", "caption")
  }

  private fun obj(v: Any?): JSONObject? = when (v) {
    is JSONObject -> v
    is String -> if (v.isEmpty() || v == "null") null else try { JSONObject(v) } catch (_: Throwable) { null }
    else -> null
  }

  override fun seal(account: String, item: JSONObject): JSONObject? = sealInner(account, item, fresh = false)

  override fun reseal(account: String, item: JSONObject, code: String): JSONObject? {
    val conv = item.optString("conv")
    E2eeNative.onRefused(account, conv, code)
    if (item.optBoolean("probe", false)) return null
    if (code != "e2ee5_plaintext_refused") return null
    val body = obj(item.opt("body")) ?: return null
    if (E2eeNative.isEnvelope(body.optString("content"))) return null // já cifrado e recusado → definitivo
    val out = sealInner(account, item, fresh = true) ?: return null
    // recusou por texto puro e mesmo com o estado fresco não ficou cifrado → não reenvia em claro
    return if (E2eeNative.isEnvelope(obj(out.opt("body"))?.optString("content"))) out else null
  }

  private fun sealInner(account: String, item: JSONObject, fresh: Boolean): JSONObject? {
    val body = obj(item.opt("body")) ?: return item
    val content = body.optString("content")
    if (E2eeNative.isEnvelope(content)) return item // o JS já cifrou
    if (!E2eeNative.gateOn(ctx, account)) return item
    val conv = item.optString("conv").ifEmpty { body.opt("conversation_id")?.toString().orEmpty() }
    val c = credsOf(account)
    val st = E2eeNative.convState(ctx, account, conv, c?.token, c?.base, fresh) ?: return item
    if (st.mode != 1) return item
    val cmi = item.optString("cmi").ifEmpty { body.optString("client_message_id") }
    if (item.optString("kind") == "media" || body.optString("file_url").let { it.isNotEmpty() && it != "null" }) {
      Log.i(TAG, "media in e2ee conv=$conv → not queued (F3)")
      return null
    }
    val type = body.optString("type").ifEmpty { "text" }
    if (type != "text") { Log.i(TAG, "type=$type in e2ee conv=$conv → not queued"); return null }
    val extra = JSONObject()
    body.optString("effect").takeIf { it.isNotEmpty() && it != "null" }?.let { extra.put("effect", it) }
    val replyMid = body.optLong("reply_to_id", 0L)
    val quote = body.optString("reply_quote_text").takeIf { it.isNotEmpty() && it != "null" && !E2eeNative.isEnvelope(it) }
    val payload = E2eeNative.textPayload(conv, cmi, content, replyMid, quote, extra)
    return when (val s = E2eeNative.seal(ctx, account, conv, payload, c?.token, c?.base, fresh)) {
      E2eeNative.Seal.Plain -> item
      is E2eeNative.Seal.Fail -> { Log.i(TAG, "seal failed conv=$conv why=${s.why}"); null }
      is E2eeNative.Seal.Env -> {
        val nb = JSONObject(body.toString())
        for (k in CLEAR_DROP) nb.remove(k)
        nb.put("content", s.envelope).put("type", "text").put("has_link", s.hasLink)
        val out = JSONObject(item.toString()).put("body", nb)
        val f = obj(item.opt("frame"))
        if (f != null) {
          for (k in CLEAR_DROP) f.remove(k)
          f.put("content", s.envelope).put("has_link", s.hasLink)
          out.put("frame", f.toString())
        } else out.remove("frame")
        out
      }
    }
  }
}

/** Dica de mudança de estado vinda do WS nativo (`conv_e2ee`, `e2ee5_td`) — sem conteúdo. */
internal object E2eeWsHints {
  fun onFrame(ctx: Context, account: String, text: String, foreground: Boolean) {
    if (text.length > 4096) return
    val o = try { JSONObject(text) } catch (_: Throwable) { return }
    val d = o.optJSONObject("data") ?: JSONObject()
    when (o.optString("type")) {
      "conv_e2ee" -> E2eeNative.onConvE2ee(account, d.opt("conv_id")?.toString().orEmpty(), d.optInt("e2ee_mode", 0), d.optLong("since_pts", 0L))
      // 1º plano: o JS sincroniza (WP-08c); 2º plano: o JS pode estar parado → núcleo nativo
      "e2ee5_td" -> if (!foreground) E2eeNative.onToDeviceHint(ctx, account)
      "e2ee5_devices" -> {
        val uids = d.optJSONArray("uids") ?: JSONArray()
        if (!foreground && uids.length() > 0) E2eeNative.onToDeviceHint(ctx, account)
      }
    }
  }
}
