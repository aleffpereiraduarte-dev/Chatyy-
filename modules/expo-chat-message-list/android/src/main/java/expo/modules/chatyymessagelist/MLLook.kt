package expo.modules.chatyymessagelist

// [2026-10-18 tg-look, apiVersion 10] Visual "nível Telegram" (P&B) da lista
// nativa. Prop `look` {tg} (0/1) vinda do JS (components/chat/nativeThreadList.js,
// kill switch globalThis.__chatyy_tg_look = false). Ausente/0 = visual antigo
// (rabicho WhatsApp no topo da 1ª bolha do grupo).
//   tg = 1: rabicho suave na ÚLTIMA bolha do grupo (embaixo, lado do autor),
//   cantos do autor justos dentro do grupo; foto/vídeo/álbum sem peças no topo
//   rente à bolha (sem moldura), cantos = cantos da bolha; mídia sem legenda
//   sem fundo/rabicho.
// Lido na main ao criar o MLStyle (MLStyle.tg) — o layout no executor só lê o estilo.
object MLLook {
  @Volatile var tg = false

  /** true = mudou. */
  fun apply(m: Map<String, Any?>?): Boolean {
    val v = m?.get("tg")
    val n = if (v == null) false else MLRow.bool(v)
    if (n == tg) return false
    tg = n
    return true
  }

  // [2026-10-19 tg-style, apiVersion 12] polimento "nível Telegram" — prop `tgStyle`
  // {on: 0/1} (JS: nativeThreadList.js, kill switch globalThis.__chatyy_tg_bubbles = false).
  //   on = 1: 2/8 dp dentro/entre grupos; pílulas de data/sistema/flutuante em cápsula
  //   12sp; duração do vídeo em pílula (mesma linha da hora); nota de voz com botão
  //   cheio na tinta e glifo na cor da bolha; "Encaminhada" 13sp regular; citação r 6.
  @Volatile var style = false

  /** true = mudou. */
  fun applyStyle(m: Map<String, Any?>?): Boolean {
    val v = m?.get("on")
    val n = if (v == null) false else MLRow.bool(v)
    if (n == style) return false
    style = n
    return true
  }

  /** canto do lado do autor entre bolhas do mesmo grupo (dp) */
  const val GROUP_R = 6f
  /** altura da curva do rabicho (dp) */
  const val TAIL_RISE = 13f
}

// [2026-10-19 store-rev, apiVersion 13] rótulos de dia recalculados ao pintar a foto
// do store (o rev do JS não leva mais o id do OTA nem o dia local — antes 45 % das
// aberturas jogavam a foto fora com why=rev). store.dl = {m: {"A-M-D" (mês 0-based
// = chave "sep-A-M-D"): rótulo de hoje} p/ os 7 dias relativos, loc}; linhas mais
// velhas usam `ab` (absoluto gravado pelo JS) ou formatam aqui (skeleton yMMMd).
class MLDayLabels {
  private var map: Map<String, String> = emptyMap()
  private var rel: Set<String> = emptySet()
  private var loc = ""
  private var fmt: java.text.DateFormat? = null

  fun update(v: Any?) {
    val d = v as? Map<*, *>
    val m = d?.get("m") as? Map<*, *>
    if (m == null) { map = emptyMap(); rel = emptySet(); return }
    val out = HashMap<String, String>()
    for ((k, x) in m) {
      val ks = k as? String ?: continue
      val s = x as? String ?: continue
      if (s.isNotEmpty()) out[ks] = s
    }
    map = out
    rel = out.values.toHashSet()
    val l = (d?.get("loc") as? String) ?: ""
    if (l != loc) { loc = l; fmt = null }
  }

  /** Linha de data da foto com o rótulo de HOJE (as outras voltam iguais). */
  fun relabel(d: Map<String, Any?>): Map<String, Any?> {
    if (map.isEmpty() || d["kind"] != "date") return d
    val k = d["k"] as? String ?: return d
    if (!k.startsWith("sep-")) return d
    val day = k.substring(4)
    val cur = (d["text"] as? String) ?: ""
    val ab = d["ab"] as? String
    val want: String? = map[day]
      ?: (if (!ab.isNullOrEmpty()) ab else if (cur in rel) absLabel(day) else null)
    if (want.isNullOrEmpty() || want == cur) return d
    val out = HashMap<String, Any?>(d)
    out["text"] = want
    return out
  }

  private fun absLabel(day: String): String? {
    val p = day.split("-").mapNotNull { it.toIntOrNull() }
    if (p.size != 3) return null
    return try {
      val cal = java.util.Calendar.getInstance()
      cal.clear()
      cal.set(p[0], p[1], p[2], 12, 0, 0)
      val f = fmt ?: run {
        val locale = if (loc.isNotEmpty()) java.util.Locale.forLanguageTag(loc) else java.util.Locale.getDefault()
        val pat = android.text.format.DateFormat.getBestDateTimePattern(locale, "yMMMd")
        java.text.SimpleDateFormat(pat, locale).also { fmt = it }
      }
      f.format(cal.time)
    } catch (_: Throwable) { null }
  }
}
