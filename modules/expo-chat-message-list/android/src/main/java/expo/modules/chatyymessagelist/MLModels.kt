package expo.modules.chatyymessagelist

import android.graphics.Color

// [2026-10-14 native-list] Modelo de linha vindo do JS
// (components/chat/nativeThreadList.js → buildRow). Parse tolerante: campo
// ausente/estranho vira default, nunca exceção.

enum class MLKind { MSG, DATE, UNREAD, SYSTEM }

data class MLSpan(val start: Int, val end: Int, val flags: Int, val url: String?, val color: Int? = null) {
  companion object {
    const val BOLD = 1
    const val ITALIC = 2
    const val STRIKE = 4
    const val MONO = 8
    const val LINK = 16
    const val MENTION = 32
    const val HASHTAG = 64
    // [fase 2]
    const val EMOJI = 128
    const val SPOILER = 256
    const val CODE = 512
  }
}

data class MLMedia(
  val kind: String,
  val uri: String,
  val thumb: String,
  val w: Float,
  val h: Float,
  val dur: String,
  val up: Int?,
  val id: String,
  /** [native-media-dl] baixar nativo (null = já local / JS cuida) */
  val dl: MLMediaDL? = null,
  /** [2026-10-18 vthumb, api 9] vídeo sem pôster: URL (http/file) p/ extrair o 1º frame */
  val vf: String = "",
)

data class MLReply(val id: String, val name: String, val text: String, val color: Int, val thumb: String, val italic: Boolean)
data class MLReact(val emoji: String, val count: Int, val mine: Boolean)
data class MLAudio(val duration: Int, val voice: Boolean, val wave: FloatArray, val played: Boolean, val dl: MLMediaDL? = null)
data class MLFile(val name: String, val size: String, val ext: String, val dl: MLMediaDL? = null)

class MLRow(d: Map<String, Any?>) {
  val key: String = str(d["k"])
  val kind: MLKind = when (str(d["kind"])) {
    "date" -> MLKind.DATE
    "unread" -> MLKind.UNREAD
    "system" -> MLKind.SYSTEM
    else -> MLKind.MSG
  }
  val id: String = str(d["id"])
  val own: Boolean = bool(d["own"])
  val first: Boolean = if (d["first"] == null) true else bool(d["first"])
  val last: Boolean = if (d["last"] == null) true else bool(d["last"])
  val time: String = str(d["time"])
  val status: Double? = num(d["st"])
  val star: Boolean = bool(d["star"])
  val sel: Int = (num(d["sel"]) ?: 0.0).toInt()
  val name: String = str(d["name"])
  val nameColor: Int = color(d["nc"]) ?: 0xFF888888.toInt()
  val text: String = str(d["text"])
  val spans: List<MLSpan> = parseSpans(d["sp"])
  val deleted: Boolean = bool(d["del"])
  val forwarded: String = str(d["fwd"])
  val forwardedMany: Boolean = bool(d["fwdm"]) // [2026-10-17 fwd-label] forward_count >= 5 → seta dupla
  val reply: MLReply? = (d["rp"] as? Map<*, *>)?.let {
    MLReply(str(it["id"]), str(it["name"]), str(it["text"]), color(it["c"]) ?: 0xFF888888.toInt(), str(it["th"]), bool(it["it"]))
  }
  val edited: String = str(d["ed"])
  val reacts: List<MLReact> = ((d["rx"] as? List<*>) ?: emptyList<Any>()).mapNotNull { r ->
    val m = r as? Map<*, *> ?: return@mapNotNull null
    val e = str(m["e"])
    if (e.isEmpty()) null else MLReact(e, maxOf(1, (num(m["n"]) ?: 1.0).toInt()), bool(m["me"]))
  }
  val jumbo: Float = (num(d["jumbo"]) ?: 0.0).toFloat()
  val media: MLMedia? = (d["media"] as? Map<*, *>)?.let { parseMedia(it) }
  val album: List<MLMedia> = ((d["album"] as? List<*>) ?: emptyList<Any>()).mapNotNull { (it as? Map<*, *>)?.let { m -> parseMedia(m) } }
  val more: Int = (num(d["more"]) ?: 0.0).toInt()
  /** [hero] ids de TODO o álbum (só quando > 4: índice ≥ 4 volta ao último tile). */
  val albumIds: List<String> = ((d["aids"] as? List<*>) ?: emptyList<Any>()).map { str(it) }
  val audio: MLAudio? = (d["au"] as? Map<*, *>)?.let { a ->
    val w = ((a["w"] as? List<*>) ?: emptyList<Any>()).mapNotNull { num(it) }.map { (it.coerceIn(8.0, 100.0) / 100.0).toFloat() }
    MLAudio((num(a["d"]) ?: 0.0).toInt(), if (a["v"] == null) true else bool(a["v"]), w.toFloatArray(), bool(a["p"]), MLMediaDL.parse(a["dl"]))
  }
  val file: MLFile? = (d["file"] as? Map<*, *>)?.let { MLFile(str(it["n"]), str(it["s"]), str(it["x"]), MLMediaDL.parse(it["dl"])) }

  // ─── [2026-10-15 fase 2] blocos / extras ────────────────────────────────
  val blocks: List<MLNode> = MLNode.list(d["bl"])
  val pre: List<MLNode> = MLNode.list(d["pre"])
  val post: List<MLNode> = MLNode.list(d["post"])
  val cw: Float = (num(d["cw"]) ?: 0.0).toFloat()
  val cardBare: Boolean = bool(d["bare"])
  val pad: FloatArray? = MLNode.edges(d["pad"])
  val metaPlace: String = str(d["mp"])
  val failed: Boolean = bool(d["fail"])
  val pinned: Boolean = bool(d["pin"])
  val timer: Boolean = bool(d["tmr"])
  /** bbg: fundo do balão recebido (menção a mim). */
  val bubbleBg: Int? = color(d["bbg"])
  val opacity: Float = (num(d["op"]) ?: 1.0).toFloat().coerceIn(0f, 1f)
  // [2026-10-16 wave13-C a11y, apiVersion 6] rótulo completo do leitor de tela (JS)
  // + máscara das ações do TalkBack (1 responder, 2 reagir, 4 copiar, 8 encaminhar, 16 mais).
  val a11yLabel: String = str(d["ax"])
  val a11yMask: Int = num(d["aa"])?.takeIf { it.isFinite() && it >= 0 }?.toInt() ?: (if (bool(d["del"])) 16 else (1 or 2 or 16))

  val isValid: Boolean get() = key.isNotEmpty()

  val hasBlocks: Boolean get() = blocks.isNotEmpty() && !deleted

  val bare: Boolean
    get() = kind == MLKind.MSG && !deleted && (jumbo > 0f || media?.kind == "sticker" || (cardBare && blocks.isNotEmpty()))

  companion object {
    fun str(v: Any?): String = when (v) {
      null -> ""
      is String -> v
      is Double -> if (v % 1.0 == 0.0) v.toLong().toString() else v.toString()
      is Number -> v.toString()
      else -> ""
    }

    fun num(v: Any?): Double? = when (v) {
      is Number -> v.toDouble()
      is String -> v.toDoubleOrNull()
      is Boolean -> if (v) 1.0 else 0.0
      else -> null
    }

    fun bool(v: Any?): Boolean = when (v) {
      is Boolean -> v
      else -> (num(v) ?: 0.0) != 0.0
    }

    /** ARGB 32-bit vindo do JS como número (0..0xFFFFFFFF). */
    fun color(v: Any?): Int? {
      val n = num(v) ?: return null
      if (n.isNaN() || n < 0) return null
      return n.toLong().toInt()
    }

    fun parseMedia(m: Map<*, *>): MLMedia {
      val t = str(m["t"])
      return MLMedia(
        kind = if (t.isEmpty()) "image" else t,
        uri = str(m["uri"]),
        thumb = str(m["th"]),
        w = (num(m["w"]) ?: 0.0).toFloat(),
        h = (num(m["h"]) ?: 0.0).toFloat(),
        dur = str(m["dur"]),
        up = num(m["up"])?.toInt(),
        id = str(m["id"]),
        dl = MLMediaDL.parse(m["dl"]),
        vf = str(m["vf"]),
      )
    }

    fun parseSpans(v: Any?): List<MLSpan> {
      val arr = v as? List<*> ?: return emptyList()
      val out = ArrayList<MLSpan>(arr.size)
      for (a in arr) {
        val t = a as? List<*> ?: continue
        if (t.size < 3) continue
        val s = num(t[0])?.toInt() ?: continue
        val e = num(t[1])?.toInt() ?: continue
        val f = num(t[2])?.toInt() ?: continue
        val url = if (t.size > 3) t[3] as? String else null
        val col = if (t.size > 4) color(t[4]) else null
        if (e > s) out.add(MLSpan(s, e, f, url, col))
      }
      return out
    }
  }
}

class MLTheme(private val d: Map<String, Any?> = emptyMap()) {
  private fun c(k: String, def: Int): Int = MLRow.color(d[k]) ?: def

  val ownBubble = c("ownBubble", 0xFF111111.toInt())
  val otherBubble = c("otherBubble", 0xFFEEEEF0.toInt())
  val ownText = c("ownText", Color.WHITE)
  val otherText = c("otherText", 0xFF111111.toInt())
  val ownMeta = c("ownMeta", 0x9EFFFFFF.toInt())
  val otherMeta = c("otherMeta", 0xBD3C3C43.toInt())
  val link = c("link", 0xFF3373F2.toInt())
  val read = c("read", 0xFF53BDEB.toInt())
  val wall = c("wall", Color.WHITE)
  val pillBg = c("pillBg", 0x0F000000)
  val pillText = c("pillText", 0xFF4D4D4D.toInt())
  val systemText = c("systemText", 0xFF737373.toInt())
  val accent = c("accent", 0xFF111111.toInt())
  val ownQuote = c("ownQuote", 0x1FFFFFFF)
  val otherQuote = c("otherQuote", 0x0D000000)
  val unreadBg = c("unreadBg", 0x0D000000)
  val unreadText = c("unreadText", 0xFF4D4D4D.toInt())
  val reactBg = c("reactBg", 0xFFF5F5F5.toInt())
  val reactBorder = c("reactBorder", Color.WHITE)
  val selection = c("selection", 0x2E808080)
  val highlight = c("highlight", 0x47808080)
  val failed = c("failed", 0xFFE53333.toInt())
}
