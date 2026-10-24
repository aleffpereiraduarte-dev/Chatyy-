package expo.modules.chatyychatstore

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * [rcpt-bg 2026-10-24] Recibos ✓✓ / ✓✓ azul com o app em 2º plano / fechado, SEM subir o JS.
 *
 * Chamado pelo FirebaseMessagingService do app (expo-callkit CallFirebaseMessagingService, por reflexão —
 * os dois módulos não dependem um do outro no gradle) para TODO push:
 *   • `chat_rcpt` (FCM data, prioridade NORMAL, collapse_key "rcpt"): só recibos → grava e devolve true
 *     (o serviço não repassa ao expo-notifications: nada é desenhado).
 *   • push de chat com `rcpt` (carona): grava e devolve false (o push segue o caminho normal).
 * Formato (servidor /var/www/mail/api/rcpt-bg.php): {type:"chat_rcpt", v:"1", ah:<hash da conta>, r:"cid,d,r;…"};
 * pelo Expo chega dentro de data["body"] (JSON). Kill: SharedPreferences chatyy_rcpt_bg / bool "native_off".
 */
object RcptBg {
  private const val TAG = "ChatyyRcptBg"

  /** true = push só de recibos (consumido aqui). */
  @JvmStatic
  fun handle(ctx: Context, data: Map<String, String>): Boolean {
    return try {
      var d: Map<String, String> = data
      if ((d["type"] ?: "").isEmpty() || (d["r"] == null && d["rcpt"] == null)) {
        val raw = data["body"]
        if (raw != null && raw.length < 16384 && raw.trimStart().startsWith("{") && (raw.contains("chat_rcpt") || raw.contains("\"rcpt\""))) {
          val j = JSONObject(raw); val m = HashMap<String, String>(data)
          val it = j.keys(); while (it.hasNext()) { val k = it.next(); val v = j.opt(k); if (v != null && v != JSONObject.NULL) m[k] = v.toString() }
          d = m
        }
      }
      val type = d["type"] ?: ""
      val silent = type == "chat_rcpt"
      val compact = if (silent) d["r"] ?: "" else d["rcpt"] ?: ""
      if (compact.isEmpty()) return silent
      if (ctx.getSharedPreferences(ChatyyStoreDB.RCPT_PREFS, Context.MODE_PRIVATE).getBoolean("native_off", false)) return silent
      val ah = if (silent) d["ah"] ?: "" else d["rcpt_ah"] ?: ""
      ChatyyStoreDB.get(ctx).rcptBgApply(ah, compact, if (silent) "silent" else "piggy") { n -> Log.i(TAG, "${if (silent) "silent" else "piggy"} convs=$n") }
      silent
    } catch (t: Throwable) { Log.w(TAG, "handle: ${t.message}"); false }
  }
}
