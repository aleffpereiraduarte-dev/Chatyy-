package expo.modules.chatyymediaeditor

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import kotlin.math.max
import kotlin.math.min

/**
 * [2026-10-15 native-editor] Modelo do editor. Tudo em coordenadas
 * NORMALIZADAS da imagem inteira já girada (u,v em 0..1) e tamanhos relativos
 * ao LADO MENOR dessa imagem (invariante a giros de 90°) — assim prévia (tela)
 * e exportação (resolução cheia) usam exatamente a mesma conta.
 */

class MEStroke(val color: Int, val widthRel: Float) {
  val pts = ArrayList<Float>() // u0,v0,u1,v1...
  fun copy(): MEStroke {
    val s = MEStroke(color, widthRel)
    s.pts.addAll(pts)
    return s
  }
}

class MEObj(
  var kind: String,     // "text" | "sticker"
  var text: String,
  var color: Int,
  var font: Int,
  var bg: Int,          // 0 sem fundo · 1 fundo sólido · 2 suave
  var u: Float,
  var v: Float,
  var scale: Float,     // tamanho da fonte = scale × lado menor
  var rot: Float,       // radianos
) {
  fun copy() = MEObj(kind, text, color, font, bg, u, v, scale, rot)
}

class MEState {
  var rotQ = 0                              // quartos de volta (horário)
  var crop = RectF(0f, 0f, 1f, 1f)          // normalizado na imagem girada
  var filterIdx = 0
  val strokes = ArrayList<MEStroke>()
  val objs = ArrayList<MEObj>()

  fun copy(): MEState {
    val s = MEState()
    s.rotQ = rotQ
    s.crop = RectF(crop)
    s.filterIdx = filterIdx
    for (k in strokes) s.strokes.add(k.copy())
    for (o in objs) s.objs.add(o.copy())
    return s
  }

  fun isPristine(): Boolean =
    rotQ % 4 == 0 && filterIdx == 0 && strokes.isEmpty() && objs.isEmpty() &&
      crop.left <= 0.0005f && crop.top <= 0.0005f && crop.right >= 0.9995f && crop.bottom >= 0.9995f

  /** Gira 90° no sentido horário: (u,v) → (1−v, u). */
  fun rotateCW() {
    rotQ = (rotQ + 1) % 4
    crop = RectF(1f - crop.bottom, crop.left, 1f - crop.top, crop.right)
    for (s in strokes) {
      var i = 0
      while (i + 1 < s.pts.size) {
        val u = s.pts[i]
        val v = s.pts[i + 1]
        s.pts[i] = 1f - v
        s.pts[i + 1] = u
        i += 2
      }
    }
    for (o in objs) {
      val u = o.u
      o.u = 1f - o.v
      o.v = u
      o.rot += (Math.PI / 2).toFloat()
    }
  }
}

class MEFilter(val id: String, val label: String, val m: FloatArray?) {
  /** android.graphics.ColorMatrix usa translação em 0..255 (o JS manda 0..1). */
  fun androidMatrix(): FloatArray? {
    val src = m ?: return null
    if (src.size != 20) return null
    val out = src.copyOf()
    out[4] *= 255f; out[9] *= 255f; out[14] *= 255f; out[19] *= 255f
    return out
  }
}

/** Desenho de texto/figurinha — MESMA função na prévia e na exportação. */
object MEDraw {
  const val WRAP_EM = 11f
  const val PAD_EM = 0.32f

  fun typeface(font: Int): Typeface = when (font) {
    1 -> Typeface.create("sans-serif-light", Typeface.NORMAL)
    2 -> Typeface.create(Typeface.SERIF, Typeface.BOLD)
    3 -> Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
    4 -> Typeface.create("sans-serif-black", Typeface.NORMAL)
    else -> Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
  }

  fun contrastOn(c: Int): Int {
    val l = 0.2126 * Color.red(c) + 0.7152 * Color.green(c) + 0.0722 * Color.blue(c)
    return if (l > 150) Color.BLACK else Color.WHITE
  }

  class Laid(val layout: StaticLayout, val w: Float, val h: Float, val fontPx: Float)

  fun layout(o: MEObj, short: Float): Laid {
    val fontPx = max(4f, o.scale * short)
    val tp = TextPaint(Paint.ANTI_ALIAS_FLAG)
    tp.textSize = fontPx
    if (o.kind == "text") {
      tp.typeface = typeface(o.font)
      tp.color = if (o.bg == 1) contrastOn(o.color) else o.color
      if (o.bg == 0) tp.setShadowLayer(fontPx * 0.08f, 0f, fontPx * 0.03f, Color.argb(110, 0, 0, 0))
    } else {
      tp.color = Color.WHITE
    }
    val text = if (o.text.isEmpty()) " " else o.text
    var maxLine = 0f
    for (line in text.split('\n')) maxLine = max(maxLine, tp.measureText(line))
    val wrap = max(1, min(maxLine, fontPx * WRAP_EM).toInt() + 2)
    val sl = if (Build.VERSION.SDK_INT >= 23) {
      StaticLayout.Builder.obtain(text, 0, text.length, tp, wrap)
        .setAlignment(Layout.Alignment.ALIGN_CENTER)
        .setIncludePad(false)
        .build()
    } else {
      @Suppress("DEPRECATION")
      StaticLayout(text, tp, wrap, Layout.Alignment.ALIGN_CENTER, 1f, 0f, false)
    }
    var w = 0f
    for (i in 0 until sl.lineCount) w = max(w, sl.getLineWidth(i))
    return Laid(sl, w, sl.height.toFloat(), fontPx)
  }

  /** Meia-largura/altura (px) da caixa de toque/fundo, sem rotação. */
  fun halfBox(l: Laid): Pair<Float, Float> {
    val pad = l.fontPx * PAD_EM
    return Pair(l.w / 2f + pad, l.h / 2f + pad * 0.7f)
  }

  /**
   * Desenha o objeto com centro em (cx,cy) px. `short` = lado menor da imagem
   * inteira no espaço de destino (tela ou arquivo).
   */
  fun drawObj(c: Canvas, o: MEObj, cx: Float, cy: Float, short: Float, highlight: Boolean = false) {
    val l = layout(o, short)
    c.save()
    c.translate(cx, cy)
    c.rotate(Math.toDegrees(o.rot.toDouble()).toFloat())
    val (hw, hh) = halfBox(l)
    if (o.kind == "text" && o.bg != 0) {
      val p = Paint(Paint.ANTI_ALIAS_FLAG)
      p.color = if (o.bg == 1) o.color else Color.argb(140, 0, 0, 0)
      val r = l.fontPx * 0.36f
      c.drawRoundRect(RectF(-hw, -hh, hw, hh), r, r, p)
    }
    if (highlight) {
      val p = Paint(Paint.ANTI_ALIAS_FLAG)
      p.style = Paint.Style.STROKE
      p.strokeWidth = max(1.5f, short * 0.003f)
      p.color = Color.argb(200, 255, 255, 255)
      c.drawRoundRect(RectF(-hw - 4, -hh - 4, hw + 4, hh + 4), 8f, 8f, p)
    }
    c.translate(-l.layout.width / 2f, -l.h / 2f)
    l.layout.draw(c)
    c.restore()
  }

  /** Traços: pontos normalizados → retângulo da imagem inteira (fx,fy,fw,fh). */
  fun drawStroke(c: Canvas, s: MEStroke, fx: Float, fy: Float, fw: Float, fh: Float, short: Float, paint: Paint) {
    if (s.pts.size < 2) return
    paint.color = s.color
    paint.strokeWidth = max(1f, s.widthRel * short)
    if (s.pts.size == 2) {
      paint.style = Paint.Style.FILL
      c.drawCircle(fx + s.pts[0] * fw, fy + s.pts[1] * fh, paint.strokeWidth / 2f, paint)
      paint.style = Paint.Style.STROKE
      return
    }
    val path = Path()
    path.moveTo(fx + s.pts[0] * fw, fy + s.pts[1] * fh)
    var i = 2
    var px = s.pts[0]
    var py = s.pts[1]
    while (i + 1 < s.pts.size) {
      val x = s.pts[i]
      val y = s.pts[i + 1]
      // curva quadrática pelo ponto médio → traço liso
      val mx = (px + x) / 2f
      val my = (py + y) / 2f
      path.quadTo(fx + px * fw, fy + py * fh, fx + mx * fw, fy + my * fh)
      px = x; py = y
      i += 2
    }
    path.lineTo(fx + px * fw, fy + py * fh)
    c.drawPath(path, paint)
  }

  fun strokePaint(): Paint {
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    p.style = Paint.Style.STROKE
    p.strokeCap = Paint.Cap.ROUND
    p.strokeJoin = Paint.Join.ROUND
    return p
  }
}
