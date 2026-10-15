package expo.modules.chatyymessagelist

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.os.Build
import android.text.Layout
import android.text.TextPaint
import android.text.style.CharacterStyle
import android.text.style.ReplacementSpan
import android.view.View
import androidx.core.graphics.PathParser
import com.bumptech.glide.Glide
import com.bumptech.glide.request.target.CustomTarget
import com.bumptech.glide.request.transition.Transition
import java.util.WeakHashMap
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

// [2026-10-15 native-list fase 2] Blocos (row.bl / pre / post) — árvore de nós
// montada no JS (components/chat/nativeNodes.js) com os MESMOS valores de
// estilo do render JS. Aqui: parse tolerante, medida (executor de fundo,
// StaticLayout), posicionamento e uma lista PLANA de ops que o MLCellView só
// desenha. Contrato: scratchpad nl2/SPEC.md / cabeçalho do nativeThreadList.js.

class MLIconPath(val path: Path, val fill: Int, val stroke: Int, val width: Float, val opacity: Float)

class MLNode(d: Map<*, *>) {
  val t: String = MLRow.str(d["t"])
  val m: FloatArray = edges(d["m"]) ?: ZERO
  val p: FloatArray = edges(d["p"]) ?: ZERO
  val w: Float = (MLRow.num(d["w"]) ?: 0.0).toFloat()
  val h: Float = (MLRow.num(d["h"]) ?: 0.0).toFloat()
  val bg: Int? = MLRow.color(d["bg"])
  val r: Float = (MLRow.num(d["r"]) ?: 0.0).toFloat()
  val bc: Int? = MLRow.color(d["bc"])
  val bg2: Int? = MLRow.color(d["bg2"])
  val bw: Float = (MLRow.num(d["bw"]) ?: 0.0).toFloat()
  val a: String = MLRow.str(d["a"])
  val op: Float = (MLRow.num(d["op"]) ?: 1.0).toFloat().coerceIn(0f, 1f)
  val fl: Float = (MLRow.num(d["fl"]) ?: 0.0).toFloat()
  val al: String = MLRow.str(d["al"])
  val jc: String = MLRow.str(d["jc"])
  val pos: String = MLRow.str(d["pos"])
  val id: String = MLRow.str(d["id"])
  val gap: Float = (MLRow.num(d["g"]) ?: 0.0).toFloat()
  val children: List<MLNode> = list(d["c"])
  // texto
  val text: String = if (t == "tx") MLRow.str(d["s"]) else ""
  val spans: List<MLSpan> = MLRow.parseSpans(d["sp"])
  val fs: Float = (MLRow.num(d["fs"]) ?: 14.0).toFloat()
  val fw: Int = (MLRow.num(d["fw"]) ?: 400.0).toInt()
  val italic: Boolean = MLRow.bool(d["it"])
  val color: Int? = if (d["c"] is List<*>) null else MLRow.color(d["c"])
  val lh: Float = (MLRow.num(d["lh"]) ?: 0.0).toFloat()
  val ml: Int = (MLRow.num(d["ml"]) ?: 0.0).toInt()
  val ta: String = MLRow.str(d["ta"])
  val mono: Boolean = MLRow.str(d["ff"]) == "mono"
  val body: Boolean = MLRow.bool(d["body"])
  val mi: Boolean = MLRow.bool(d["mi"])
  val underline: Boolean = d["u"] !is String && MLRow.bool(d["u"])
  val ls: Float = (MLRow.num(d["ls"]) ?: 0.0).toFloat()
  // imagem / avatar / vídeo
  val uri: String = if (d["u"] is String) d["u"] as String else ""
  val thumb: String = MLRow.str(d["th"])
  val ar: Float = (MLRow.num(d["ar"]) ?: 0.0).toFloat()
  val fit: Boolean = MLRow.str(d["fit"]) == "contain"
  val size: Float = if (t == "tx") 0f else (MLRow.num(d["s"]) ?: 0.0).toFloat()
  val initials: String = MLRow.str(d["tx"])
  val poster: String = MLRow.str(d["po"])
  val dur: Float = (MLRow.num(d["d"]) ?: 0.0).toFloat()
  val ring: Int? = MLRow.color(d["ring"])
  // barra
  val value: Float = (MLRow.num(d["v"]) ?: 0.0).toFloat().coerceIn(0f, 1f)
  // ícone
  val vb: Float = (MLRow.num(d["vb"]) ?: 24.0).toFloat().let { if (it > 0f) it else 24f }
  val paths: List<MLIconPath> = if (t == "ic") parsePaths(d["ps"]) else emptyList()

  val isFill: Boolean get() = w < 0f

  companion object {
    val ZERO = FloatArray(4)

    fun list(v: Any?): List<MLNode> {
      val arr = v as? List<*> ?: return emptyList()
      val out = ArrayList<MLNode>(arr.size)
      for (x in arr) {
        val m = x as? Map<*, *> ?: continue
        try { out.add(MLNode(m)) } catch (_: Throwable) {}
      }
      return out
    }

    /** número ou [t,r,b,l] → FloatArray(t,r,b,l) em dp. */
    fun edges(v: Any?): FloatArray? {
      if (v == null) return null
      val n = MLRow.num(v)
      if (n != null && v !is List<*>) { val f = n.toFloat(); return floatArrayOf(f, f, f, f) }
      val l = v as? List<*> ?: return null
      val a = l.map { (MLRow.num(it) ?: 0.0).toFloat() }
      return when (a.size) {
        0 -> null
        1 -> floatArrayOf(a[0], a[0], a[0], a[0])
        2 -> floatArrayOf(a[0], a[1], a[0], a[1])
        3 -> floatArrayOf(a[0], a[1], a[2], a[1])
        else -> floatArrayOf(a[0], a[1], a[2], a[3])
      }
    }

    private val pathCache = object : LinkedHashMap<String, Path>(64, 0.75f, true) {
      override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Path>?): Boolean = size > 400
    }

    fun parsePath(d: String): Path? {
      if (d.isEmpty()) return null
      synchronized(pathCache) { pathCache[d]?.let { return it } }
      val p = try { PathParser.createPathFromPathData(d) } catch (_: Throwable) { null } ?: return null
      synchronized(pathCache) { pathCache[d] = p }
      return p
    }

    private fun parsePaths(v: Any?): List<MLIconPath> {
      val arr = v as? List<*> ?: return emptyList()
      val out = ArrayList<MLIconPath>(arr.size)
      for (x in arr) {
        val m = x as? Map<*, *> ?: continue
        val path = parsePath(MLRow.str(m["d"])) ?: continue
        val f = MLRow.color(m["f"]) ?: 0
        val k = MLRow.color(m["k"]) ?: 0
        if (f == 0 && k == 0) continue
        out.add(MLIconPath(path, f, k, (MLRow.num(m["w"]) ?: 1.9).toFloat(), (MLRow.num(m["o"]) ?: 1.0).toFloat().coerceIn(0f, 1f)))
      }
      return out
    }
  }
}

/** Op plana já posicionada (coordenadas do balão). */
class MLOp(val kind: Int, val rect: RectF) {
  var color = 0
  var color2 = 0
  var radius = 0f
  var strokeW = 0f
  var alpha = 1f
  var text: MLText? = null
  var icon: MLNode? = null
  var value = 0f
  var id = ""
  var uri = ""
  var thumb = ""
  var fit = false
  var slot = -1
  var dur = 0f

  companion object {
    const val RECT = 0
    const val TEXT = 1
    const val ICON = 2
    const val BAR = 3
    const val IMAGE = 4
    const val AVATAR = 5
    const val LOADER = 6
    const val VNOTE = 7
    const val CLIP_PUSH = 8
    const val CLIP_POP = 9
  }
}

class MLAction(val rect: RectF, val action: String, val radius: Float)

/** Resultado do layout de um grupo de blocos. */
class MLBlocks {
  val ops = ArrayList<MLOp>()
  val actions = ArrayList<MLAction>()
  var lastText: MLOp? = null
  var lastRect: RectF? = null
  var width = 0f
  var height = 0f
}

class MLBox(val node: MLNode) {
  var w = 0f
  var h = 0f
  var x = 0f   // posição (inclui margem) relativa ao box pai
  var y = 0f
  val kids = ArrayList<MLBox>()
  var text: MLText? = null
  val outerW: Float get() = w + mx
  val outerH: Float get() = h + my
  var mx = 0f
  var my = 0f
}

/** Medida + posicionamento de nós. Uma instância por linha (fundo). */
class MLNodeEngine(private val s: MLStyle, private val row: MLRow, private val textColor: Int, private val linkColor: Int) {
  private fun dp(v: Float) = s.dp(v)
  private val ownOrOtherBubble = if (row.own) s.theme.ownBubble else (row.bubbleBg ?: s.theme.otherBubble)

  /** Mede um grupo (pilha vertical virtual). exactW > 0 força a largura. */
  fun layout(nodes: List<MLNode>, maxW: Float, exactW: Float, ox: Float, oy: Float, out: MLBlocks) {
    val root = MLNode(mapOf("t" to "v", "w" to (if (exactW > 0f) -1.0 else 0.0)))
    val avail = if (exactW > 0f) exactW else maxW
    val box = MLBox(root)
    measureStack(box, nodes, avail, exactW > 0f, vertical = true)
    out.width = box.w
    out.height = box.h
    emit(box, ox, oy, 1f, out, topLevel = true)
  }

  /** Remede com largura exata (bubble ficou mais largo que o conteúdo). */
  fun layoutExact(nodes: List<MLNode>, w: Float, ox: Float, oy: Float): MLBlocks {
    val b = MLBlocks()
    layout(nodes, w, w, ox, oy, b)
    return b
  }

  private fun measure(n: MLNode, availOuter: Float, forceExact: Boolean, intrinsic: Boolean = false): MLBox {
    val b = MLBox(n)
    b.mx = dp(n.m[1] + n.m[3])
    b.my = dp(n.m[0] + n.m[2])
    val avail = max(0f, availOuter - b.mx)
    val fillMe = n.isFill && !intrinsic
    val exact = forceExact || fillMe
    val fixedW: Float? = when {
      n.w > 0f -> min(dp(n.w), max(avail, 1f))
      exact -> avail
      else -> null
    }
    val pl = dp(n.p[3]); val pr = dp(n.p[1]); val pt = dp(n.p[0]); val pb = dp(n.p[2])
    val cAvail = max(0f, (fixedW ?: avail) - pl - pr)
    var cw = 0f
    var ch = 0f
    when (n.t) {
      "v" -> { measureStack(b, n.children, fixedW ?: avail, fixedW != null, true); return finish(b, n, fixedW) }
      "h" -> { measureStack(b, n.children, fixedW ?: avail, fixedW != null, false); return finish(b, n, fixedW) }
      "z" -> {
        if (n.children.isNotEmpty()) {
          val first = measure(n.children[0], cAvail, fixedW != null)
          first.x = pl + dp(n.children[0].m[3]); first.y = pt + dp(n.children[0].m[0])
          b.kids.add(first)
          cw = first.outerW; ch = first.outerH
          for (i in 1 until n.children.size) {
            val cn = n.children[i]
            val k = measure(cn, cw, false)
            val ml = dp(cn.m[3]); val mr = dp(cn.m[1]); val mt = dp(cn.m[0]); val mb = dp(cn.m[2])
            val ps = cn.pos.ifEmpty { "tl" }
            k.x = pl + when {
              ps.endsWith("l") || ps == "l" -> ml
              ps.endsWith("r") || ps == "r" -> cw - k.w - mr
              else -> (cw - k.w) / 2 + ml - mr
            }
            k.y = pt + when {
              ps.startsWith("t") -> mt
              ps.startsWith("b") -> ch - k.h - mb
              else -> (ch - k.h) / 2 + mt - mb
            }
            b.kids.add(k)
          }
        }
      }
      "tx" -> {
        val t = makeText(n, cAvail, if (fixedW != null) cAvail else 0f)
        b.text = t
        cw = if (fixedW != null) cAvail else t.width
        ch = t.height
      }
      "im" -> {
        val iw = fixedW ?: dp(if (n.h > 0f && n.ar > 0f) n.h * n.ar else 120f).coerceAtMost(avail)
        b.w = iw
        b.h = when {
          n.h > 0f && fixedW != null && n.ar <= 0f -> dp(n.h)
          n.ar > 0f -> iw / n.ar
          n.h > 0f -> dp(n.h)
          else -> iw
        }
        return b
      }
      "ic", "av", "ld" -> {
        val sz = dp(if (n.size > 0f) n.size else if (n.t == "ld") 20f else if (n.t == "av") 40f else 18f)
        b.w = fixedW ?: (sz + pl + pr)
        b.h = if (n.h > 0f) dp(n.h) else sz + pt + pb
        return b
      }
      "vn" -> {
        val sz = min(dp(if (n.size > 0f) n.size else 200f), avail.coerceAtLeast(dp(40f)))
        b.w = sz; b.h = sz
        return b
      }
      "pb" -> {
        b.w = fixedW ?: if (n.w == 0f && !intrinsic) avail else 0f
        b.h = dp(if (n.h > 0f) n.h else 6f)
        return b
      }
      "dv" -> {
        b.w = fixedW ?: if (intrinsic) 0f else avail
        b.h = max(1f, dp(if (n.h > 0f) n.h else 0.5f))
        return b
      }
      "sp" -> {
        b.w = fixedW ?: dp(max(0f, n.w))
        b.h = dp(max(0f, n.h))
        return b
      }
      else -> { b.w = 0f; b.h = 0f; return b }
    }
    b.w = fixedW ?: (cw + pl + pr)
    b.h = if (n.h > 0f) dp(n.h) else ch + pt + pb
    return b
  }

  private fun finish(b: MLBox, n: MLNode, fixedW: Float?): MLBox {
    if (fixedW != null) b.w = fixedW
    if (n.h > 0f) b.h = dp(n.h)
    return b
  }

  /** Mede filhos de v/h (b.w/b.h preenchidos com padding). */
  private fun measureStack(b: MLBox, children: List<MLNode>, availW: Float, exact: Boolean, vertical: Boolean) {
    val n = b.node
    val pl = dp(n.p[3]); val pr = dp(n.p[1]); val pt = dp(n.p[0]); val pb = dp(n.p[2])
    val g = dp(n.gap)
    val inner = max(0f, availW - pl - pr)
    b.kids.clear()
    if (vertical) {
      val boxes = ArrayList<MLBox>(children.size)
      var cw = 0f
      for (c in children) {
        val k = if (c.isFill && !exact) measure(c, inner, false, intrinsic = true) else measure(c, inner, false)
        boxes.add(k)
        if (!(c.isFill && (c.t == "pb" || c.t == "dv"))) cw = max(cw, k.outerW)
      }
      val finalInner = if (exact) inner else min(inner, cw)
      // filhos "preencher" com a largura final
      for (i in children.indices) {
        val c = children[i]
        if (c.isFill) boxes[i] = measure(c, finalInner, true)
      }
      var y = pt
      for ((i, k) in boxes.withIndex()) {
        val c = children[i]
        if (i > 0) y += g
        val al = n.al.ifEmpty { "s" }
        val freeX = finalInner - k.outerW
        k.x = pl + dp(c.m[3]) + when (al) { "c" -> freeX / 2; "e" -> freeX; else -> 0f }
        k.y = y + dp(c.m[0])
        y += k.outerH
        b.kids.add(k)
      }
      b.w = finalInner + pl + pr
      b.h = y + pb
      // jc em v só faz sentido com altura fixa
      if (n.h > 0f && n.jc.isNotEmpty()) {
        val free = dp(n.h) - b.h
        if (free > 0f) {
          val dy = when (n.jc) { "c" -> free / 2; "e" -> free; else -> 0f }
          for (k in b.kids) k.y += dy
        }
      }
    } else {
      val boxes = arrayOfNulls<MLBox>(children.size)
      var used = 0f
      var totalFl = 0f
      for ((i, c) in children.withIndex()) {
        val fl = if (c.fl > 0f) c.fl else if (c.isFill) 1f else 0f
        if (fl > 0f) { totalFl += fl; continue }
        val rem = max(0f, inner - used - g * i)
        val k = measure(c, rem, false)
        boxes[i] = k
        used += k.outerW
      }
      val gaps = g * max(0, children.size - 1)
      if (totalFl > 0f) {
        if (exact) {
          val rem = max(0f, inner - used - gaps)
          for ((i, c) in children.withIndex()) {
            val fl = if (c.fl > 0f) c.fl else if (c.isFill) 1f else 0f
            if (fl <= 0f) continue
            val share = rem * fl / totalFl
            val k = measure(c, share, true)
            boxes[i] = k
          }
          used = inner - gaps
        } else {
          var rem = max(0f, inner - used - gaps)
          for ((i, c) in children.withIndex()) {
            val fl = if (c.fl > 0f) c.fl else if (c.isFill) 1f else 0f
            if (fl <= 0f) continue
            val k = measure(c, rem, false, intrinsic = true)
            boxes[i] = k
            rem = max(0f, rem - k.outerW)
            used += k.outerW
          }
        }
      }
      val contentW = if (exact) inner else min(inner, used + gaps)
      var hh = 0f
      for (k in boxes) if (k != null) hh = max(hh, k.outerH)
      val fixedH = if (n.h > 0f) dp(n.h) - pt - pb else hh
      val free = max(0f, contentW - used - gaps)
      var x = pl
      var extraGap = 0f
      when (n.jc) {
        "c" -> x += free / 2
        "e" -> x += free
        "sb" -> if (children.size > 1) extraGap = free / (children.size - 1)
      }
      for ((i, k) in boxes.withIndex()) {
        k ?: continue
        val c = children[i]
        if (i > 0) x += g + extraGap
        val al = n.al.ifEmpty { "c" }
        val freeY = fixedH - k.outerH
        k.x = x + dp(c.m[3])
        if (c.t == "sp" && c.h <= 0f) {
          // divisor vertical: estica à altura da linha (alignSelf stretch)
          k.h = max(0f, fixedH - dp(c.m[0] + c.m[2]))
          k.y = pt + dp(c.m[0])
        } else {
          k.y = pt + dp(c.m[0]) + when (al) { "s" -> 0f; "e" -> freeY; else -> freeY / 2 }
        }
        x += k.outerW
        b.kids.add(k)
      }
      b.w = contentW + pl + pr
      b.h = fixedH + pt + pb
    }
  }

  private fun makeText(n: MLNode, maxW: Float, exactW: Float): MLText {
    val paint: TextPaint
    val lhPx: Float
    val color = n.color ?: textColor
    if (n.body) {
      paint = s.body
      lhPx = if (n.lh > 0f) s.sp(n.lh) else s.lineHeightPx
    } else {
      paint = s.nodePaint(n.fs, n.fw, n.italic, n.mono, n.ls)
      lhPx = if (n.lh > 0f) s.sp(n.lh) else ceil(s.sp(n.fs) * 1.3f)
    }
    val cs = MLLayoutBuilder.styled(n.text, n.spans, color, if (n.body) linkColor else (n.color ?: linkColor), paint.textSize * 1.2f, ownOrOtherBubble, n.underline, s.density)
    val align = when (n.ta) { "c" -> Layout.Alignment.ALIGN_CENTER; "r" -> Layout.Alignment.ALIGN_OPPOSITE; else -> Layout.Alignment.ALIGN_NORMAL }
    var t = MLText.make(cs, paint, if (exactW > 0f) exactW else maxW, lhPx, n.ml, align, color)
    if (exactW <= 0f && align != Layout.Alignment.ALIGN_NORMAL && t.width < maxW) {
      t = MLText.make(cs, paint, max(1f, t.width), lhPx, n.ml, align, color)
    }
    return t
  }

  private fun emit(b: MLBox, ox: Float, oy: Float, alphaIn: Float, out: MLBlocks, topLevel: Boolean) {
    val n = b.node
    val x = ox + b.x
    val y = oy + b.y
    val a = alphaIn * n.op
    val rect = RectF(x, y, x + b.w, y + b.h)
    val rad = if (n.r < 0f) min(b.w, b.h) / 2 else dp(n.r)
    if (n.bg != null || (n.bc != null && n.bw > 0f)) {
      if (n.t != "pb" && n.t != "av" && n.t != "dv") {
        val o = MLOp(MLOp.RECT, rect)
        o.color = n.bg ?: 0
        o.radius = rad
        o.alpha = a
        if (o.color != 0) out.ops.add(o)
      }
    }
    var borderOp: MLOp? = null
    if (n.bc != null && n.bw > 0f && n.t != "pb" && n.t != "dv") {
      run {
        val o = MLOp(MLOp.RECT, RectF(rect))
        o.color2 = n.bc
        o.strokeW = dp(n.bw)
        o.radius = rad
        o.alpha = a
        borderOp = o
      }
    }
    if (n.a.isNotEmpty()) out.actions.add(MLAction(RectF(rect), n.a, rad))
    val pl = dp(n.p[3]); val pt = dp(n.p[0])
    when (n.t) {
      "tx" -> b.text?.let { t ->
        val o = MLOp(MLOp.TEXT, RectF(x + pl, y + pt, x + pl + t.width + 1, y + pt + t.height))
        // alinhamento c/r dentro de uma largura fixa: o StaticLayout já alinha
        o.text = t
        o.alpha = a
        out.ops.add(o)
        if (n.mi) out.lastText = o
      }
      "ic" -> {
        val sz = dp(if (n.size > 0f) n.size else 18f)
        val ix = x + pl + (b.w - pl - dp(n.p[1]) - sz) / 2
        val iy = y + pt + (b.h - pt - dp(n.p[2]) - sz) / 2
        val o = MLOp(MLOp.ICON, RectF(ix, iy, ix + sz, iy + sz))
        o.icon = n
        o.alpha = a
        out.ops.add(o)
      }
      "pb" -> {
        val o = MLOp(MLOp.BAR, rect)
        o.value = n.value
        o.color = n.color ?: textColor
        o.color2 = n.bg ?: ((textColor and 0x00FFFFFF) or (0x2E shl 24))
        o.radius = if (n.r > 0f) dp(n.r) else b.h / 2
        o.id = n.id
        o.alpha = a
        out.ops.add(o)
      }
      "dv" -> {
        val o = MLOp(MLOp.RECT, rect)
        o.color = n.color ?: n.bg ?: ((textColor and 0x00FFFFFF) or (0x26 shl 24))
        o.alpha = a
        out.ops.add(o)
      }
      "im" -> {
        val o = MLOp(MLOp.IMAGE, rect)
        o.uri = n.uri; o.thumb = n.thumb; o.fit = n.fit; o.radius = rad
        o.color = n.bg ?: 0
        o.alpha = a
        out.ops.add(o)
      }
      "av" -> {
        val sz = dp(if (n.size > 0f) n.size else 40f)
        val ax = x + pl; val ay = y + pt
        val o = MLOp(MLOp.AVATAR, RectF(ax, ay, ax + sz, ay + sz))
        o.uri = n.uri
        o.color = n.bg ?: 0xFF8E8E93.toInt()
        o.color2 = n.bg2 ?: 0
        o.radius = sz / 2
        o.alpha = a
        if (n.initials.isNotEmpty()) {
          val p = s.nodePaint(if (n.fs != 14f) n.fs else max(10f, (if (n.size > 0f) n.size else 40f) * 0.4f), 600, false, false, 0f)
          o.text = MLText.make(MLLayoutBuilder.colored(n.initials, n.color ?: 0xFFFFFFFF.toInt()), p, sz, 0f, 1)
        }
        out.ops.add(o)
      }
      "ld" -> {
        val sz = dp(if (n.size > 0f) n.size else 20f)
        val lx = x + (b.w - sz) / 2; val ly = y + (b.h - sz) / 2
        val o = MLOp(MLOp.LOADER, RectF(lx, ly, lx + sz, ly + sz))
        o.color = n.color ?: textColor
        o.alpha = a
        out.ops.add(o)
      }
      "vn" -> {
        val o = MLOp(MLOp.VNOTE, rect)
        o.uri = n.uri; o.thumb = n.poster; o.dur = n.dur
        o.color = n.ring ?: 0xFFFFFFFF.toInt()
        o.color2 = n.bg ?: 0xFF000000.toInt()
        o.radius = min(b.w, b.h) / 2
        o.alpha = a
        out.ops.add(o)
      }
    }
    val clip = (n.t == "v" || n.t == "h" || n.t == "z") && n.r != 0f && b.kids.isNotEmpty()
    if (clip) { val o = MLOp(MLOp.CLIP_PUSH, RectF(rect)); o.radius = rad; out.ops.add(o) }
    for (k in b.kids) emit(k, x, y, a, out, false)
    if (clip) out.ops.add(MLOp(MLOp.CLIP_POP, RectF(rect)))
    borderOp?.let { out.ops.add(it) }
    if (topLevel) {
      // grupo raiz: o "último nó" p/ meta over/inline = último filho direto
      val last = b.kids.lastOrNull()
      if (last != null) {
        out.lastRect = RectF(x + last.x, y + last.y, x + last.x + last.w, y + last.y + last.h)
        if (!(last.node.t == "tx" && last.node.mi)) out.lastText = null
      }
    }
  }
}

// ─── spans especiais ───────────────────────────────────────────────────────

/** Spoiler: glyphs invisíveis até revelar (alpha animado pelo MLCellView). */
class MLSpoilerSpan : CharacterStyle() {
  @Volatile var reveal: Float = 0f
  override fun updateDrawState(tp: TextPaint) {
    if (reveal < 1f) tp.alpha = (tp.alpha * reveal).toInt().coerceIn(0, 255)
  }
}

/** Emoji customizado inline (imagem quadrada carregada async). */
class MLEmojiSpan(val url: String, private val sizePx: Float) : ReplacementSpan() {
  override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
    if (fm != null) {
      val pm = paint.fontMetricsInt
      fm.ascent = pm.ascent; fm.descent = pm.descent; fm.top = pm.top; fm.bottom = pm.bottom
    }
    return ceil(sizePx).toInt()
  }

  override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
    val cy = (top + bottom) / 2f
    val r = RectF(x, cy - sizePx / 2, x + sizePx, cy + sizePx / 2)
    val d = MLEmojiCache.get(url)
    if (d != null) {
      d.setBounds(r.left.toInt(), r.top.toInt(), r.right.toInt(), r.bottom.toInt())
      d.draw(canvas)
    } else {
      val old = paint.color
      paint.color = (old and 0x00FFFFFF) or (0x1F shl 24)
      canvas.drawRoundRect(r, sizePx * 0.2f, sizePx * 0.2f, paint)
      paint.color = old
    }
  }
}

/** Código inline curto: fundo arredondado + mono. */
class MLCodeSpan(private val bg: Int, private val radius: Float) : ReplacementSpan() {
  private fun mono(paint: Paint): Paint {
    val p = TextPaint(paint)
    p.typeface = Typeface.MONOSPACE
    p.textSize = paint.textSize * 0.88f
    return p
  }

  override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
    if (fm != null) {
      val pm = paint.fontMetricsInt
      fm.ascent = pm.ascent; fm.descent = pm.descent; fm.top = pm.top; fm.bottom = pm.bottom
    }
    val t = text ?: return 0
    return ceil(mono(paint).measureText(t, start, end) + radius * 2).toInt()
  }

  override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
    val t = text ?: return
    val mp = mono(paint)
    val w = mp.measureText(t, start, end)
    val fm = paint.fontMetrics
    val r = RectF(x, y + fm.ascent - 1f, x + w + radius * 2, y + fm.descent + 1f)
    val old = paint.color
    val oldStyle = paint.style
    paint.color = bg
    paint.style = Paint.Style.FILL
    canvas.drawRoundRect(r, radius, radius, paint)
    paint.color = old
    paint.style = oldStyle
    mp.color = old
    canvas.drawText(t, start, end, x + radius, y.toFloat(), mp)
  }
}

/** Cache global dos emojis customizados (Glide) + invalidação das views que pediram. */
object MLEmojiCache {
  @Volatile var appContext: Context? = null
  private val map = HashMap<String, Drawable>()
  private val loading = HashSet<String>()
  private val waiting = WeakHashMap<View, Boolean>()
  /** View sendo desenhada agora (main thread) — registrada ao pedir um emoji ainda não carregado. */
  var drawingView: View? = null

  fun get(url: String): Drawable? {
    map[url]?.let { return it }
    drawingView?.let { waiting[it] = true }
    request(url)
    return null
  }

  private fun request(url: String) {
    if (url.isEmpty() || url in loading) return
    val ctx = appContext ?: return
    loading.add(url)
    val t = object : CustomTarget<Drawable>(96, 96) {
      override fun onResourceReady(resource: Drawable, transition: Transition<in Drawable>?) {
        map[url] = resource
        if (map.size > 300) {
          val it = map.keys.iterator()
          var n = 0
          while (it.hasNext() && n < 100) { it.next(); it.remove(); n++ }
        }
        val vs = waiting.keys.toList()
        waiting.clear()
        for (v in vs) v.invalidate()
      }
      override fun onLoadCleared(placeholder: Drawable?) {}
      override fun onLoadFailed(errorDrawable: Drawable?) { /* mantém em loading: não repete em loop */ }
    }
    try { Glide.with(ctx).load(MLImageSlot.modelOf(url)).into(t) } catch (_: Throwable) { loading.remove(url) }
  }
}

/** Partículas do spoiler sobre os runs (pseudo-aleatório determinístico). */
object MLSpoilerDraw {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

  fun draw(c: Canvas, t: MLText, color: Int, density: Float) {
    val sp = t.spoilers
    if (sp.isEmpty()) return
    val txt = t.layout.text as? android.text.Spanned ?: return
    val lay = t.layout
    for (span in sp) {
      val alpha = 1f - span.reveal
      if (alpha <= 0.01f) continue
      val a = txt.getSpanStart(span)
      val b = txt.getSpanEnd(span)
      if (a < 0 || b <= a) continue
      val l0 = lay.getLineForOffset(a)
      val l1 = lay.getLineForOffset(b)
      for (ln in l0..l1) {
        val x0 = if (ln == l0) lay.getPrimaryHorizontal(a) else lay.getLineLeft(ln)
        val x1 = if (ln == l1) lay.getPrimaryHorizontal(b) else lay.getLineRight(ln)
        val left = min(x0, x1); val right = max(x0, x1)
        if (right - left < 1f) continue
        val top = lay.getLineTop(ln).toFloat() + density * 2f
        val bottom = lay.getLineBottom(ln).toFloat() - density * 2f
        paint.color = color
        val step = density * 2.6f
        var seed = (a * 7919 + ln * 104729).toLong()
        var yy = top
        while (yy < bottom) {
          var xx = left
          while (xx < right) {
            seed = (seed * 6364136223846793005L + 1442695040888963407L)
            val rx = ((seed ushr 33) and 0xFF) / 255f
            val ry = ((seed ushr 41) and 0xFF) / 255f
            val rr = ((seed ushr 49) and 0xFF) / 255f
            paint.alpha = ((0.35f + 0.4f * rr) * 255 * alpha * ((color ushr 24) and 0xFF) / 255f).toInt().coerceIn(0, 255)
            c.drawCircle(xx + rx * step, yy + ry * step, density * (0.55f + 0.5f * rr), paint)
            xx += step
          }
          yy += step
        }
      }
    }
  }
}

/** Typeface com peso (API 28+) ou aproximação (24..27). */
object MLFonts {
  fun of(weight: Int, italic: Boolean, mono: Boolean): Typeface {
    val base = if (mono) Typeface.MONOSPACE else Typeface.DEFAULT
    if (Build.VERSION.SDK_INT >= 28) {
      return Typeface.create(base, weight.coerceIn(100, 900), italic)
    }
    return when {
      weight >= 600 -> Typeface.create(base, if (italic) Typeface.BOLD_ITALIC else Typeface.BOLD)
      weight >= 500 && !mono -> Typeface.create("sans-serif-medium", if (italic) Typeface.ITALIC else Typeface.NORMAL)
      else -> Typeface.create(base, if (italic) Typeface.ITALIC else Typeface.NORMAL)
    }
  }
}
