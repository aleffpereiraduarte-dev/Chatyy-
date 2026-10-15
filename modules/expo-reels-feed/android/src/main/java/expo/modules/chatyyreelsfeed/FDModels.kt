package expo.modules.chatyyreelsfeed

// [2026-10-15 native-feed] Modelo de um post da aba FEED (linha plana do JS,
// components/feed/NativePostFeed.js). Mesmo contrato do iOS (ios/FDModels.swift):
//   m  = mídia: linhas "v\t<url>\t<pôster>" (vídeo) / "i\t<url>" (foto)
//   tg = marcados: e-mails separados por "\n"

class FDMedia(val video: Boolean, val url: String, val poster: String)

class FDRow(val id: String) {
  var authorName = ""
  var authorEmail = ""
  var avatar = ""
  var initials = ""
  var own = false
  var sponsored = false
  var location = ""
  var time = ""
  var media: List<FDMedia> = emptyList()
  var caption = ""
  var translation = ""
  var translateState = 0
  var liked = false
  var likes = 0
  var saved = false
  var comments = 0
  var date = ""
  var hasRepost = false
  var repostAuthor = ""
  var repostCaption = ""
  var repostThumb = ""
  var derivative = ""
  var sound = ""
  var tags: List<String> = emptyList()
  var gift = false
  var pinned = false
  var promote = false

  fun videoKey(page: Int) = "$id#$page"

  val displayName: String
    get() = if (authorName.isNotEmpty()) authorName else authorEmail.substringBefore('@').ifEmpty { "?" }

  companion object {
    fun from(m: Map<*, *>): FDRow? {
      val id = FDVal.str(m["id"])
      if (id.isEmpty()) return null
      val r = FDRow(id)
      r.authorName = FDVal.str(m["an"])
      r.authorEmail = FDVal.str(m["ae"])
      r.avatar = FDVal.str(m["au"])
      r.initials = FDVal.str(m["ai"])
      r.own = FDVal.bool(m["own"])
      r.sponsored = FDVal.bool(m["sp"])
      r.location = FDVal.str(m["loc"])
      r.time = FDVal.str(m["tm"])
      r.media = parseMedia(FDVal.str(m["m"]))
      r.caption = FDVal.str(m["cap"])
      r.translation = FDVal.str(m["tr"])
      r.translateState = FDVal.num(m["trs"]).toInt()
      r.liked = FDVal.bool(m["liked"])
      r.likes = FDVal.num(m["lk"]).toInt().coerceAtLeast(0)
      r.saved = FDVal.bool(m["sv"])
      r.comments = FDVal.num(m["cc"]).toInt().coerceAtLeast(0)
      r.date = FDVal.str(m["dt"])
      r.hasRepost = FDVal.bool(m["rp"])
      r.repostAuthor = FDVal.str(m["rpa"])
      r.repostCaption = FDVal.str(m["rpc"])
      r.repostThumb = FDVal.str(m["rpt"])
      r.derivative = FDVal.str(m["dl"])
      r.sound = FDVal.str(m["snd"])
      val tg = FDVal.str(m["tg"])
      r.tags = if (tg.isEmpty()) emptyList() else tg.split('\n').filter { it.isNotEmpty() }
      r.gift = FDVal.bool(m["gift"])
      r.pinned = FDVal.bool(m["pin"])
      r.promote = FDVal.bool(m["prm"])
      return r
    }

    fun parseMedia(s: String): List<FDMedia> {
      if (s.isEmpty()) return emptyList()
      val out = ArrayList<FDMedia>()
      for (line in s.split('\n')) {
        val p = line.split('\t')
        if (p.size < 2 || p[1].isEmpty()) continue
        out.add(FDMedia(p[0] == "v", p[1], if (p.size > 2) p[2] else ""))
      }
      return out
    }
  }
}

object FDVal {
  fun str(v: Any?): String = when (v) {
    null -> ""
    is String -> v
    is Double -> if (v % 1.0 == 0.0) v.toLong().toString() else v.toString()
    is Number -> v.toString()
    else -> ""
  }

  fun num(v: Any?): Double = when (v) {
    is Number -> v.toDouble()
    is String -> v.toDoubleOrNull() ?: 0.0
    else -> 0.0
  }

  fun bool(v: Any?): Boolean = when (v) {
    is Boolean -> v
    is Number -> v.toDouble() != 0.0
    is String -> v == "1" || v == "true"
    else -> false
  }

  fun list(v: Any?): List<*>? = v as? List<*>

  fun map(v: Any?): Map<*, *>? = v as? Map<*, *>
}

class FDPalette(dark: Boolean, m: Map<String, Any?>? = null) {
  var bg: Int = if (dark) 0xFF000000.toInt() else 0xFFFFFFFF.toInt()
  var card: Int = if (dark) 0xFF121212.toInt() else 0xFFFFFFFF.toInt()
  var text: Int = if (dark) 0xFFF5F5F5.toInt() else 0xFF111111.toInt()
  var text2: Int = if (dark) 0xFF9E9E9E.toInt() else 0xFF666666.toInt()
  var text3: Int = if (dark) 0xFF737373.toInt() else 0xFF8C8C8C.toInt()
  val sep: Int = if (dark) 0x0FFFFFFF else 0x0F000000
  val chip: Int = if (dark) 0x1FFFFFFF else 0x14111111
  val placeholder: Int = if (dark) 0xFF1F1F1F.toInt() else 0xFFEDEDED.toInt()
  val likeRed: Int = 0xFFEF4444.toInt()

  init {
    parse(m?.get("bg"))?.let { bg = it }
    parse(m?.get("card"))?.let { card = it }
    parse(m?.get("text"))?.let { text = it }
    parse(m?.get("text2"))?.let { text2 = it }
    parse(m?.get("text3"))?.let { text3 = it }
  }

  companion object {
    fun parse(v: Any?): Int? {
      var s = (v as? String)?.trim() ?: return null
      if (!s.startsWith("#")) return null
      s = s.substring(1)
      if (s.length == 3) s = s.map { "$it$it" }.joinToString("")
      return try {
        when (s.length) {
          6 -> (0xFF000000 or s.toLong(16)).toInt()
          8 -> {
            val n = s.toLong(16)
            (((n and 0xFF) shl 24) or (n ushr 8)).toInt()
          }
          else -> null
        }
      } catch (_: Throwable) { null }
    }
  }
}

class FDLabels(m: Map<*, *>? = null) {
  private val d = HashMap<String, String>()

  init {
    m?.forEach { (k, v) -> if (k is String && v is String && v.isNotEmpty()) d[k] = v }
  }

  fun get(k: String, def: String): String = d[k] ?: def

  fun likes(n: Int): String {
    if (n <= 0) return ""
    if (n == 1) return get("oneLike", "1 curtida")
    val word = get("likes", "curtidas")
    if (n >= 1_000_000) return trim(n / 1_000_000.0) + "M " + word
    if (n >= 1000) return trim(n / 1000.0) + "K " + word
    return "$n $word"
  }

  fun comments(n: Int): String {
    if (n <= 0) return ""
    if (n == 1) return get("viewOneComment", "Ver 1 comentário")
    return get("viewAllComments", "Ver todos os {count} comentários").replace("{count}", n.toString())
  }

  private fun trim(v: Double): String {
    val s = String.format(java.util.Locale.US, "%.1f", v)
    return if (s.endsWith(".0")) s.dropLast(2) else s
  }
}

/** Ícones de contorno (Material, viewport 24) da barra de ações do post. */
object FDIconPaths {
  const val HEART_OUTLINE = "M16.5,3c-1.74,0 -3.41,0.81 -4.5,2.09C10.91,3.81 9.24,3 7.5,3 4.42,3 2,5.42 2,8.5c0,3.78 3.4,6.86 8.55,11.54L12,21.35l1.45,-1.32C18.6,15.36 22,12.28 22,8.5 22,5.42 19.58,3 16.5,3zM12.1,18.55l-0.1,0.1 -0.1,-0.1C7.14,14.24 4,11.39 4,8.5 4,6.5 5.5,5 7.5,5c1.54,0 3.04,0.99 3.57,2.36h1.87C13.46,5.99 14.96,5 16.5,5c2,0 3.5,1.5 3.5,3.5 0,2.89 -3.14,5.74 -7.9,10.05z"
  const val COMMENT_OUTLINE = "M20,2H4c-1.1,0 -2,0.9 -2,2v18l4,-4h14c1.1,0 2,-0.9 2,-2V4c0,-1.1 -0.9,-2 -2,-2zM20,16H6l-2,2V4h16v12z"
  const val SEND_OUTLINE = "M4.01,6.03l7.51,3.22 -7.52,-1 0.01,-2.22m7.5,8.72L4,17.97v-2.22l7.51,-1M2.01,3L2,10l15,2 -15,2 0.01,7L23,12 2.01,3z"
  const val PLAY = "M8,5v14l11,-7z"
}
