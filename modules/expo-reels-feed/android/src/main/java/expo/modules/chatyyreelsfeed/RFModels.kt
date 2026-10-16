package expo.modules.chatyyreelsfeed

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import androidx.core.graphics.PathParser

// [2026-10-15 native-reels] Modelo de um reel vindo do JS (applyItems).
// `apply` só toca nas chaves presentes → `op: "update"` pode mandar só
// {id, likes, liked}.

class RFSubtitle(val start: Double, val end: Double, val text: String)

class RFItem(val id: String) {
  var videoUrl = ""
  var hlsUrl = ""
  var thumb = ""
  var avatar = ""
  var author = ""
  var caption = ""
  var music = ""
  var credit = ""
  var likes = 0
  var comments = 0
  var liked = false
  var saved = false
  var durationMs = 0.0
  var canGift = false
  var canFollow = false
  var commentsDisabled = false
  /** [2026-10-15 reels-gaps] autor transmitindo agora → anel "ao vivo" no avatar. */
  var live = false
  /** [2026-10-16 reels-rail-v2] contadores extras + selo + capa do áudio (JS api ≥ 2). */
  var shares = 0
  var saves = 0
  var verified = false
  var musicCover = ""
  var width = 0.0
  var height = 0.0
  var subtitles: List<RFSubtitle> = emptyList()

  val mediaKey: String get() = "$hlsUrl|$videoUrl"

  fun apply(m: Map<*, *>) {
    if (m.containsKey("videoUrl")) videoUrl = str(m["videoUrl"])
    if (m.containsKey("hlsUrl")) hlsUrl = str(m["hlsUrl"])
    if (m.containsKey("thumb")) thumb = str(m["thumb"])
    if (m.containsKey("avatar")) avatar = str(m["avatar"])
    if (m.containsKey("author")) author = str(m["author"])
    if (m.containsKey("caption")) caption = str(m["caption"])
    if (m.containsKey("music")) music = str(m["music"])
    if (m.containsKey("credit")) credit = str(m["credit"])
    if (m.containsKey("likes")) likes = num(m["likes"]).toInt().coerceAtLeast(0)
    if (m.containsKey("comments")) comments = num(m["comments"]).toInt().coerceAtLeast(0)
    if (m.containsKey("liked")) liked = bool(m["liked"])
    if (m.containsKey("saved")) saved = bool(m["saved"])
    if (m.containsKey("durationMs")) durationMs = num(m["durationMs"]).coerceAtLeast(0.0)
    if (m.containsKey("canGift")) canGift = bool(m["canGift"])
    if (m.containsKey("canFollow")) canFollow = bool(m["canFollow"])
    if (m.containsKey("commentsDisabled")) commentsDisabled = bool(m["commentsDisabled"])
    if (m.containsKey("live")) live = bool(m["live"])
    if (m.containsKey("shares")) shares = num(m["shares"]).toInt().coerceAtLeast(0)
    if (m.containsKey("saves")) saves = num(m["saves"]).toInt().coerceAtLeast(0)
    if (m.containsKey("verified")) verified = bool(m["verified"])
    if (m.containsKey("musicCover")) musicCover = str(m["musicCover"])
    if (m.containsKey("width")) width = num(m["width"])
    if (m.containsKey("height")) height = num(m["height"])
    if (m.containsKey("subtitles")) {
      val out = ArrayList<RFSubtitle>()
      (m["subtitles"] as? List<*>)?.let { list ->
        for (raw in list.take(600)) {
          val s = raw as? Map<*, *> ?: continue
          val text = str(s["text"])
          if (text.isEmpty()) continue
          out.add(RFSubtitle(num(s["start"]), num(s["end"]), text))
        }
      }
      subtitles = out
    }
  }

  fun subtitleAt(seconds: Double): String {
    if (subtitles.isEmpty()) return ""
    for (s in subtitles) if (seconds >= s.start && seconds <= s.end) return s.text
    return ""
  }

  companion object {
    fun from(m: Map<*, *>): RFItem? {
      val id = str(m["id"])
      if (id.isEmpty()) return null
      return RFItem(id).also { it.apply(m) }
    }

    fun str(v: Any?): String = when (v) {
      null -> ""
      is String -> v
      is Number -> {
        val d = v.toDouble()
        if (d == Math.floor(d) && !d.isInfinite()) d.toLong().toString() else d.toString()
      }
      is Boolean -> v.toString()
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
  }
}

/** Bearer p/ get_avatar do nosso host (foto restrita "meus contatos"). Só main thread escreve. */
object RFImageAuth {
  @Volatile var headers: Map<String, String> = emptyMap()

  fun needsAuth(url: String): Boolean {
    if (!url.startsWith("https://") || !url.contains("get_avatar")) return false
    val host = try { android.net.Uri.parse(url).host?.lowercase() ?: "" } catch (_: Throwable) { "" }
    return host == "chatyy.com.br" || host.endsWith(".chatyy.com.br")
  }

  /** Modelo Glide: GlideUrl com cabeçalho quando precisa, senão a própria URL. */
  fun model(url: String): Any {
    val h = headers
    if (h.isEmpty() || !needsAuth(url)) return url
    val b = com.bumptech.glide.load.model.LazyHeaders.Builder()
    for ((k, v) in h) b.addHeader(k, v)
    return com.bumptech.glide.load.model.GlideUrl(url, b.build())
  }
}

class RFLabels(m: Map<*, *>? = null) {
  val like: String = pick(m, "like", "Curtir")
  val comment: String = pick(m, "comment", "Comentar")
  val gift: String = pick(m, "gift", "Enviar presente")
  val share: String = pick(m, "share", "Compartilhar")
  val save: String = pick(m, "save", "Salvar")
  val saved: String = pick(m, "saved", "Salvo")
  val more: String = pick(m, "more", "Mais")
  val mute: String = pick(m, "mute", "Silenciar")
  val unmute: String = pick(m, "unmute", "Ativar som")
  val follow: String = pick(m, "follow", "Seguir")
  val seeMore: String = pick(m, "seeMore", "mais")
  val error: String = pick(m, "error", "Não foi possível reproduzir este vídeo")
  val retry: String = pick(m, "retry", "Tentar de novo")
  val likers: String = pick(m, "likers", "Ver curtidas")
  val sound: String = pick(m, "sound", "Usar este som")
  val live: String = pick(m, "live", "AO VIVO")
  /** [2026-10-16 reels-rail-v2] 1 = trilho original; 2 = trilho novo (JS manda com api ≥ 2). */
  val railStyle: Int = (m?.get("railStyle") as? Number)?.toInt() ?: 1
  val countK: String = pick(m, "countK", "{n} mil")
  val countM: String = pick(m, "countM", "{n} mi")
  val decimalSep: String = pick(m, "decimalSep", ",")
  val v2: Boolean get() = railStyle >= 2

  private fun pick(m: Map<*, *>?, k: String, def: String): String {
    val v = m?.get(k) as? String
    return if (v.isNullOrEmpty()) def else v
  }
}

object RFFormat {
  /** Igual ao formatCount do JS (1.2K / 3.4M); 0 → "" (o trilho esconde o número). */
  fun compact(n: Int): String {
    if (n <= 0) return ""
    if (n >= 1_000_000) return trim(n / 1_000_000.0) + "M"
    if (n >= 1000) return trim(n / 1000.0) + "K"
    return n.toString()
  }

  /** Trilho v2: sempre mostra o número (0 inclusive), "1,2 mil" / "3,4 mi" no idioma. */
  fun count(n: Int, l: RFLabels): String {
    val v = n.coerceAtLeast(0)
    if (v < 1000) return v.toString()
    if (v >= 1_000_000) return l.countM.replace("{n}", trim(v / 1_000_000.0).replace(".", l.decimalSep))
    val k = v / 1000.0
    val s = if (k >= 100) k.toInt().toString() else trim(k).replace(".", l.decimalSep)
    return l.countK.replace("{n}", s)
  }

  /** "m:ss" para o rótulo do arrastar. */
  fun clock(seconds: Double): String {
    val t = if (seconds.isFinite()) seconds.toInt().coerceAtLeast(0) else 0
    return String.format(java.util.Locale.US, "%d:%02d", t / 60, t % 60)
  }

  private fun trim(v: Double): String {
    val s = String.format(java.util.Locale.US, "%.1f", v)
    return if (s.endsWith(".0")) s.dropLast(2) else s
  }
}

/**
 * Ícones do trilho: path SVG (viewport 24×24, Material Icons) desenhado num
 * Drawable — sem recursos XML (path inválido → ícone vazio, nunca crash).
 */
object RFIconPaths {
  const val HEART = "M12,21.35l-1.45,-1.32C5.4,15.36 2,12.28 2,8.5 2,5.42 4.42,3 7.5,3c1.74,0 3.41,0.81 4.5,2.09C13.09,3.81 14.76,3 16.5,3 19.58,3 22,5.42 22,8.5c0,3.78 -3.4,6.86 -8.55,11.54L12,21.35z"
  const val COMMENT = "M20,2H4c-1.1,0 -2,0.9 -2,2v18l4,-4h14c1.1,0 2,-0.9 2,-2V4c0,-1.1 -0.9,-2 -2,-2z"
  const val GIFT = "M20,6h-2.18c0.11,-0.31 0.18,-0.65 0.18,-1 0,-1.66 -1.34,-3 -3,-3 -1.05,0 -1.96,0.54 -2.5,1.35l-0.5,0.67 -0.5,-0.68C10.96,2.54 10.05,2 9,2 7.34,2 6,3.34 6,5c0,0.35 0.07,0.69 0.18,1H4c-1.11,0 -1.99,0.89 -1.99,2L2,19c0,1.11 0.89,2 2,2h16c1.11,0 2,-0.89 2,-2V8c0,-1.11 -0.89,-2 -2,-2zM15,4c0.55,0 1,0.45 1,1s-0.45,1 -1,1 -1,-0.45 -1,-1 0.45,-1 1,-1zM9,4c0.55,0 1,0.45 1,1s-0.45,1 -1,1 -1,-0.45 -1,-1 0.45,-1 1,-1zM20,19H4v-2h16v2zM20,14H4V8h5.08L7,10.83 8.62,12 11,8.76l1,-1.36 1,1.36L15.38,12 17,10.83 14.92,8H20v6z"
  const val SHARE = "M14,9V5l7,7 -7,7v-4.1c-5,0 -8.5,1.6 -11,5.1 1,-5 4,-10 11,-11z"
  const val BOOKMARK = "M17,3H7c-1.1,0 -1.99,0.9 -1.99,2L5,21l7,-3 7,3V5c0,-1.1 -0.9,-2 -2,-2z"
  /** Material bookmark_border (salvar ainda não marcado — igual ao IconBookmark do JS). */
  const val BOOKMARK_OUTLINE = "M17,3H7c-1.1,0 -1.99,0.9 -1.99,2L5,21l7,-3 7,3V5c0,-1.1 -0.9,-2 -2,-2zM17,18l-5,-2.18L7,18V5h10v13z"
  const val MORE = "M6,10c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2zM18,10c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2zM12,10c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2z"
  const val MUSIC = "M12,3v10.55c-0.59,-0.34 -1.27,-0.55 -2,-0.55 -2.21,0 -4,1.79 -4,4s1.79,4 4,4 4,-1.79 4,-4V7h4V3h-6z"
  const val VOLUME_OFF = "M16.5,12c0,-1.77 -1.02,-3.29 -2.5,-4.03v2.21l2.45,2.45c0.03,-0.2 0.05,-0.41 0.05,-0.63zM19,12c0,0.94 -0.2,1.82 -0.54,2.64l1.51,1.51C20.63,14.91 21,13.5 21,12c0,-4.28 -2.99,-7.86 -7,-8.77v2.06c2.89,0.86 5,3.54 5,6.71zM4.27,3L3,4.27 7.73,9H3v6h4l5,5v-6.73l4.25,4.25c-0.67,0.52 -1.42,0.93 -2.25,1.18v2.06c1.38,-0.31 2.63,-0.95 3.69,-1.81L19.73,21 21,19.73l-9,-9L4.27,3zM12,4L9.91,6.09 12,8.18V4z"
  const val VOLUME_ON = "M3,9v6h4l5,5V4L7,9H3zM16.5,12c0,-1.77 -1.02,-3.29 -2.5,-4.03v8.05c1.48,-0.73 2.5,-2.25 2.5,-4.02zM14,3.23v2.06c2.89,0.86 5,3.54 5,6.71s-2.11,5.85 -5,6.71v2.06c4.01,-0.91 7,-4.49 7,-8.77s-2.99,-7.86 -7,-8.77z"
  const val PLUS = "M19,13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"

  // [2026-10-16 reels-rail-v2] Ícones de LINHA do app (components/Icons.js = Feather),
  // convertidos p/ M/L/C/Z absolutos — mesmos textos do iOS (RFIcons.swift).
  const val L_HEART = "M20.84 4.61C19.81 3.58 18.41 3 16.95 3C15.49 3 14.09 3.58 13.06 4.61L12 5.67L10.94 4.61C8.79 2.46 5.31 2.46 3.16 4.61C1.01 6.76 1.01 10.24 3.16 12.39L4.22 13.45L12 21.23L19.78 13.45L20.84 12.39C21.87 11.36 22.45 9.96 22.45 8.5C22.45 7.04 21.87 5.64 20.84 4.61Z"
  const val L_COMMENT = "M21 11.5C21 12.82 20.7 14.12 20.1 15.3C18.66 18.18 15.72 20 12.5 20C11.18 20 9.88 19.7 8.7 19.1L3 21L4.9 15.3C4.3 14.12 4 12.82 4 11.5C4 8.28 5.82 5.34 8.7 3.9C9.88 3.3 11.18 3 12.5 3L13 3C17.32 3.24 20.76 6.68 21 11L21 11.5Z"
  const val L_SEND = "M22 2L11 13M22 2L15 22L11 13L2 9L22 2Z"
  const val L_BOOKMARK = "M19 21L12 16L5 21L5 5C5 3.9 5.9 3 7 3L17 3C18.1 3 19 3.9 19 5Z"
  const val L_GIFT = "M5 8L19 8C20.1 8 21 8.9 21 10L21 19C21 20.1 20.1 21 19 21L5 21C3.9 21 3 20.1 3 19L3 10C3 8.9 3.9 8 5 8ZM3 12L21 12M12 8L12 21M8 8C6.5 8 5 7 5 5.5C5 4 6.5 3 8 3C9.5 3 12 5 12 8M16 8C17.5 8 19 7 19 5.5C19 4 17.5 3 16 3C14.5 3 12 5 12 8"
  const val L_MORE = "M13.6 12C13.6 12.57 13.3 13.1 12.8 13.39C12.3 13.67 11.7 13.67 11.2 13.39C10.7 13.1 10.4 12.57 10.4 12C10.4 11.43 10.7 10.9 11.2 10.61C11.7 10.33 12.3 10.33 12.8 10.61C13.3 10.9 13.6 11.43 13.6 12ZM20.6 12C20.6 12.88 19.88 13.6 19 13.6C18.12 13.6 17.4 12.88 17.4 12C17.4 11.12 18.12 10.4 19 10.4C19.88 10.4 20.6 11.12 20.6 12ZM6.6 12C6.6 12.57 6.3 13.1 5.8 13.39C5.3 13.67 4.7 13.67 4.2 13.39C3.7 13.1 3.4 12.57 3.4 12C3.4 11.43 3.7 10.9 4.2 10.61C4.7 10.33 5.3 10.33 5.8 10.61C6.3 10.9 6.6 11.43 6.6 12Z"
  const val L_MUSIC = "M9 18L9 5L21 3L21 16M9 18C9 19.66 7.66 21 6 21C4.34 21 3 19.66 3 18C3 16.34 4.34 15 6 15C7.66 15 9 16.34 9 18ZM21 16C21 17.66 19.66 19 18 19C16.34 19 15 17.66 15 16C15 14.34 16.34 13 18 13C19.66 13 21 14.34 21 16Z"
  const val L_PLUS = "M12 6L12 18M6 12L18 12"
  const val L_CHECK = "M20 6L9 17L4 12"
}

class RFIconDrawable(pathData: String, color: Int, shadow: Boolean = true) : Drawable() {
  private var source: Path? = parse(pathData)
  private var sourceData = pathData

  // Preenchimento não-zero (padrão do VectorDrawable): os furos dos ícones
  // "vazados" do Material vêm com o sentido do traço invertido.
  private fun parse(data: String): Path? = try { PathParser.createPathFromPathData(data) } catch (_: Throwable) { null }

  /** Troca o desenho (ex.: marcador vazado ↔ cheio) sem recriar o Drawable. */
  fun setPathData(data: String) {
    if (data == sourceData) return
    sourceData = data
    source = parse(data)
    invalidateSelf()
  }
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    this.color = color
    style = Paint.Style.FILL
    strokeJoin = Paint.Join.ROUND
    strokeCap = Paint.Cap.ROUND
    if (shadow) setShadowLayer(3f, 0f, 1f, 0x66000000)
  }

  /**
   * [2026-10-16 reels-rail-v2] Traço (ícones de linha do app). `width24` = espessura
   * na grade 24 (escala com o tamanho); 0 = preenchido (padrão antigo).
   * `fillToo` = preenche E contorna (curtido/salvo com quinas arredondadas).
   */
  var strokeWidth24 = 0f
    set(v) { if (field != v) { field = v; invalidateSelf() } }
  var fillToo = false
    set(v) { if (field != v) { field = v; invalidateSelf() } }

  /** Sombra mais suave/forte p/ ícone sobre vídeo (v2). */
  fun setShadow(radius: Float, dy: Float, color: Int) {
    paint.setShadowLayer(radius, 0f, dy, color)
    invalidateSelf()
  }
  private val matrix = Matrix()
  private val drawPath = Path()

  var color: Int
    get() = paint.color
    set(v) {
      if (paint.color != v) {
        paint.color = v
        invalidateSelf()
      }
    }

  override fun draw(canvas: Canvas) {
    val p = source ?: return
    val b = bounds
    if (b.isEmpty) return
    matrix.setScale(b.width() / 24f, b.height() / 24f)
    matrix.postTranslate(b.left.toFloat(), b.top.toFloat())
    drawPath.reset()
    p.transform(matrix, drawPath)
    if (strokeWidth24 > 0f) {
      paint.strokeWidth = strokeWidth24 * b.width() / 24f
      paint.style = if (fillToo) Paint.Style.FILL_AND_STROKE else Paint.Style.STROKE
    } else {
      paint.style = Paint.Style.FILL
    }
    canvas.drawPath(drawPath, paint)
  }

  override fun setAlpha(alpha: Int) {
    paint.alpha = alpha
    invalidateSelf()
  }

  override fun setColorFilter(colorFilter: ColorFilter?) {
    paint.colorFilter = colorFilter
    invalidateSelf()
  }

  @Deprecated("Deprecated in Java")
  override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
