package expo.modules.chatyymediaviewer

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.animation.AccelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import java.text.Normalizer
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

// [2026-10-17 status-reacoes] Reações de status estilo Instagram/WhatsApp
// (apiVersion 4), espelho do iOS StoryReactions.swift:
//   • SVReactBubble — segurar o coração abre a fileira numa bolha; o dedo
//     desliza (haptic por item) e solta p/ escolher.
//   • SVEmojiSheet — "+" abre a grade completa de emojis do app (catálogo do
//     JS: components/chat/nativeEmojiData.js) com busca.
//   • SVReactionBurst — o emoji sobe grande e estoura (Reduzir Movimento = fade).
// Emojis = CONTEÚDO (a reação). Ícones de UI seguem vetoriais (sv_ic_plus).
// Curvas espelham constants/motion.js: bouncy (Overshoot) e snappy (Decelerate).

/** Emoji desenhado num bitmap (fonte de emoji do sistema). */
fun svEmojiBitmap(glyph: String, px: Int): Bitmap {
  val sz = max(1, px)
  val bmp = Bitmap.createBitmap(sz, sz, Bitmap.Config.ARGB_8888)
  val c = Canvas(bmp)
  val p = Paint(Paint.ANTI_ALIAS_FLAG)
  p.textSize = sz * 0.82f
  p.textAlign = Paint.Align.CENTER
  val fm = p.fontMetrics
  c.drawText(glyph, sz / 2f, sz / 2f - (fm.ascent + fm.descent) / 2f, p)
  return bmp
}

/** Catálogo do "+" (mandado pelo JS no open; guardado por processo). */
object SVEmojiStore {
  class Cat(val title: String, val emojis: List<String>, val keys: List<String>)

  @Volatile var cats: List<Cat> = emptyList()

  fun update(v: Any?) {
    val d = v as? Map<*, *> ?: return
    val arr = d["cats"] as? List<*> ?: return
    val out = ArrayList<Cat>()
    for (x in arr) {
      val m = x as? Map<*, *> ?: continue
      val e = (m["e"] as? List<*>)?.mapNotNull { (it as? String)?.takeIf { s -> s.isNotEmpty() } } ?: emptyList()
      if (e.isEmpty()) continue
      val k = ArrayList((m["k"] as? List<*>)?.map { fold((it as? String) ?: "") } ?: emptyList())
      while (k.size < e.size) k.add("")
      out.add(Cat((m["t"] as? String) ?: "", e, k))
    }
    if (out.isNotEmpty()) cats = out
  }

  fun fold(s: String): String =
    Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "").lowercase()

  fun search(q: String): List<String> {
    val f = fold(q.trim())
    if (f.isEmpty()) return emptyList()
    val out = ArrayList<String>()
    val seen = HashSet<String>()
    for (c in cats) {
      c.emojis.forEachIndexed { i, e ->
        if (seen.contains(e)) return@forEachIndexed
        val k = c.keys.getOrNull(i) ?: ""
        if (e == q.trim() || k.contains(f)) { out.add(e); seen.add(e) }
      }
    }
    return out
  }
}

private fun Context.dpi(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

// ─── Bolha (segurar o coração) ───────────────────────────────────────────────

@SuppressLint("ViewConstructor")
class SVReactBubble(context: Context, val items: List<String>, mine: String) : FrameLayout(context) {
  companion object { const val MORE = "__more__" }

  private val itemSize = context.dpi(44f)
  private val pad = context.dpi(8f)
  private val cells = ArrayList<View>()
  var highlighted: Int? = null
    private set

  init {
    background = GradientDrawable().apply {
      cornerRadius = (itemSize + pad * 2) / 2f
      setColor(Color.argb(232, 28, 28, 30))
      setStroke(context.dpi(1f), Color.argb(36, 255, 255, 255))
    }
    elevation = context.dpi(10f).toFloat()
    clipChildren = false
    clipToPadding = false
    items.forEachIndexed { i, e ->
      val iv = ImageView(context)
      iv.scaleType = ImageView.ScaleType.CENTER_INSIDE
      if (e == MORE) {
        iv.setImageResource(R.drawable.sv_ic_plus)
        iv.setColorFilter(Color.WHITE)
        iv.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.argb(42, 255, 255, 255)) }
        val ip = context.dpi(9f)
        iv.setPadding(ip, ip, ip, ip)
      } else {
        iv.setImageBitmap(svEmojiBitmap(e, context.dpi(38f)))
        if (e == mine) iv.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.argb(46, 255, 255, 255)) }
      }
      iv.contentDescription = e
      addView(iv, LayoutParams(itemSize, itemSize, Gravity.TOP or Gravity.START).apply { leftMargin = pad + i * itemSize; topMargin = pad })
      cells.add(iv)
    }
  }

  val preferredW: Int get() = items.size * itemSize + pad * 2
  val preferredH: Int get() = itemSize + pad * 2

  /** x/y na bolha. Tolerância vertical generosa (o dedo fica abaixo). */
  fun indexAt(x: Float, y: Float): Int? {
    if (y < -context.dpi(70f) || y > height + context.dpi(80f) || x < 0 || x > width) return null
    val i = ((x - pad) / itemSize).toInt()
    return i.coerceIn(0, items.size - 1)
  }

  fun setHighlighted(i: Int?, reduce: Boolean) {
    if (i == highlighted) return
    highlighted = i
    if (i != null) performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    cells.forEachIndexed { k, c ->
      val sel = i != null && k == i
      val sc = if (i == null) 1f else if (sel) 1.45f else 0.9f
      val ty = if (sel) -context.dpi(14f).toFloat() else 0f
      c.pivotX = itemSize / 2f
      c.pivotY = itemSize.toFloat()
      if (reduce) {
        c.scaleX = sc; c.scaleY = sc; c.translationY = ty
      } else {
        c.animate().scaleX(sc).scaleY(sc).translationY(ty).setDuration(220).setInterpolator(DecelerateInterpolator(1.6f)).start()
      }
    }
  }

  /** Centro do item em coordenadas do pai da bolha. */
  fun centerOf(i: Int): Pair<Float, Float> {
    val c = cells.getOrNull(i) ?: return Pair(left + width / 2f, top + height / 2f)
    return Pair(left + c.left + c.width / 2f, top + c.top + c.height / 2f)
  }

  fun present(reduce: Boolean) {
    alpha = 0f
    if (reduce) { animate().alpha(1f).setDuration(150).start(); return }
    pivotX = width.toFloat().takeIf { it > 0 } ?: preferredW.toFloat()
    pivotY = preferredH.toFloat()
    scaleX = 0.6f; scaleY = 0.6f; translationY = context.dpi(16f).toFloat()
    animate().alpha(1f).scaleX(1f).scaleY(1f).translationY(0f).setDuration(320).setInterpolator(OvershootInterpolator(1.1f)).start()
    cells.forEachIndexed { k, c ->
      c.alpha = 0f; c.scaleX = 0.4f; c.scaleY = 0.4f; c.translationY = context.dpi(12f).toFloat()
      c.animate().alpha(1f).scaleX(1f).scaleY(1f).translationY(0f).setStartDelay(20L * k).setDuration(340).setInterpolator(OvershootInterpolator(1.6f)).start()
    }
  }

  fun dismiss(reduce: Boolean, end: () -> Unit) {
    animate().cancel()
    animate().alpha(0f).apply {
      if (!reduce) scaleX(0.85f).scaleY(0.85f).translationY(context.dpi(10f).toFloat())
    }.setDuration(if (reduce) 120 else 180).setInterpolator(AccelerateInterpolator()).withEndAction {
      (parent as? ViewGroup)?.removeView(this)
      end()
    }.start()
  }
}

// ─── Grade completa ("+") ────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
class SVEmojiSheet(context: Context, quick: List<String>, private val mine: String, labels: SVLabels) : FrameLayout(context) {
  var onPick: ((String, Float, Float) -> Unit)? = null
  var onClose: (() -> Unit)? = null

  private val dim = View(context)
  private val panel = LinearLayout(context)
  private val search = EditText(context)
  private val grid = RecyclerView(context)
  private val empty = TextView(context)
  private val base = ArrayList<Pair<String, List<String>>>()
  private var rows: List<Row> = emptyList()
  private var closing = false
  private var cols = 7

  private class Row(val header: String?, val emoji: String?)

  init {
    isClickable = true
    dim.setBackgroundColor(Color.argb(115, 0, 0, 0))
    dim.alpha = 0f
    dim.setOnClickListener {
      if (search.hasFocus()) hideIme() else onClose?.invoke()
    }
    addView(dim, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

    panel.orientation = LinearLayout.VERTICAL
    panel.isClickable = true
    panel.background = GradientDrawable().apply {
      val r = context.dpi(20f).toFloat()
      cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
      setColor(Color.rgb(28, 28, 30))
    }
    val handleBox = FrameLayout(context)
    val handle = View(context)
    handle.background = GradientDrawable().apply { cornerRadius = context.dpi(3f).toFloat(); setColor(Color.argb(64, 255, 255, 255)) }
    handleBox.addView(handle, LayoutParams(context.dpi(40f), context.dpi(5f), Gravity.CENTER))
    panel.addView(handleBox, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, context.dpi(20f)))
    val title = TextView(context)
    title.text = labels.get("moreReactions", "Mais reações")
    title.setTextColor(Color.WHITE)
    title.textSize = 17f
    title.setTypeface(title.typeface, Typeface.BOLD)
    panel.addView(title, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
      leftMargin = context.dpi(18f); rightMargin = context.dpi(18f); bottomMargin = context.dpi(10f)
    })
    search.hint = labels.get("emojiSearch", "Buscar emoji")
    search.setTextColor(Color.WHITE)
    search.setHintTextColor(Color.argb(140, 255, 255, 255))
    search.textSize = 16f
    search.isSingleLine = true
    search.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    search.imeOptions = EditorInfo.IME_ACTION_SEARCH
    search.setPadding(context.dpi(14f), context.dpi(8f), context.dpi(14f), context.dpi(8f))
    search.background = GradientDrawable().apply { cornerRadius = context.dpi(10f).toFloat(); setColor(Color.argb(26, 255, 255, 255)) }
    search.setOnEditorActionListener { _, _, _ -> hideIme(); true }
    search.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) { filter(s?.toString() ?: "") }
    })
    panel.addView(search, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, context.dpi(40f)).apply {
      leftMargin = context.dpi(12f); rightMargin = context.dpi(12f); bottomMargin = context.dpi(6f)
    })
    val body = FrameLayout(context)
    empty.text = labels.get("emojiNoResults", "Nenhum emoji encontrado")
    empty.setTextColor(Color.argb(140, 255, 255, 255))
    empty.textSize = 15f
    empty.gravity = Gravity.CENTER_HORIZONTAL
    empty.visibility = View.GONE
    body.addView(empty, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.TOP).apply { topMargin = context.dpi(24f) })
    val glm = GridLayoutManager(context, cols)
    glm.spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
      override fun getSpanSize(position: Int): Int = if (rows.getOrNull(position)?.header != null) glm.spanCount else 1
    }
    grid.layoutManager = glm
    grid.overScrollMode = View.OVER_SCROLL_NEVER
    grid.setPadding(context.dpi(8f), 0, context.dpi(8f), context.dpi(8f))
    grid.clipToPadding = false
    grid.adapter = Adapter()
    grid.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_DRAGGING && search.hasFocus()) hideIme()
      }
    })
    body.addView(grid, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    panel.addView(body, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
    addView(panel, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))

    val q = quick.filter { it.isNotEmpty() && it != SVReactBubble.MORE }
    if (q.isNotEmpty()) base.add(Pair("", q))
    for (c in SVEmojiStore.cats) base.add(Pair(c.title, c.emojis))
    setSections(base)
  }

  /** Altura do painel (60% da tela; com teclado aberto sobe até 86%). */
  fun applyLayout(screenH: Int, imeBottom: Int, navBottom: Int) {
    val h = if (imeBottom > 0) min((screenH * 0.86f).toInt(), screenH - context.dpi(60f)) else min((screenH * 0.62f).toInt(), context.dpi(520f) + navBottom)
    val lp = panel.layoutParams as LayoutParams
    lp.height = h
    panel.layoutParams = lp
    panel.setPadding(0, 0, 0, if (imeBottom > 0) imeBottom else navBottom)
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    val n = max(5, (w - context.dpi(16f)) / context.dpi(46f))
    if (n != cols) {
      cols = n
      (grid.layoutManager as? GridLayoutManager)?.spanCount = n
    }
  }

  private fun setSections(list: List<Pair<String, List<String>>>) {
    val out = ArrayList<Row>()
    for ((t, es) in list) {
      if (t.isNotEmpty()) out.add(Row(t.uppercase(), null))
      for (e in es) out.add(Row(null, e))
    }
    rows = out
    grid.adapter?.notifyDataSetChanged()
    empty.visibility = if (out.isEmpty()) View.VISIBLE else View.GONE
  }

  private fun filter(q: String) {
    if (q.isBlank()) setSections(base)
    else {
      val r = SVEmojiStore.search(q)
      setSections(if (r.isEmpty()) emptyList() else listOf(Pair("", r)))
    }
    grid.scrollToPosition(0)
  }

  private fun hideIme() {
    try {
      val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
      imm.hideSoftInputFromWindow(search.windowToken, 0)
    } catch (_: Throwable) {}
    search.clearFocus()
  }

  fun present(reduce: Boolean) {
    if (reduce) {
      panel.alpha = 0f
      dim.animate().alpha(1f).setDuration(180).start()
      panel.animate().alpha(1f).setDuration(180).start()
      return
    }
    panel.post {
      panel.translationY = panel.height.toFloat().takeIf { it > 0 } ?: context.dpi(500f).toFloat()
      dim.animate().alpha(1f).setDuration(200).start()
      panel.animate().translationY(0f).setDuration(380).setInterpolator(DecelerateInterpolator(2.2f)).start()
    }
  }

  fun dismiss(reduce: Boolean) {
    if (closing) return
    closing = true
    hideIme()
    dim.animate().alpha(0f).setDuration(if (reduce) 140 else 220).start()
    val a = panel.animate().setDuration(if (reduce) 140 else 220).setInterpolator(AccelerateInterpolator())
    if (reduce) a.alpha(0f) else a.translationY(panel.height.toFloat() + context.dpi(20f))
    a.withEndAction { (parent as? ViewGroup)?.removeView(this) }.start()
  }

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    override fun getItemCount(): Int = rows.size
    override fun getItemViewType(position: Int): Int = if (rows[position].header != null) 1 else 0
    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      return if (viewType == 1) {
        val tv = TextView(parent.context)
        tv.setTextColor(Color.argb(140, 255, 255, 255))
        tv.textSize = 13f
        tv.setTypeface(tv.typeface, Typeface.BOLD)
        tv.setPadding(context.dpi(6f), context.dpi(10f), context.dpi(6f), context.dpi(6f))
        tv.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
        object : RecyclerView.ViewHolder(tv) {}
      } else {
        val tv = TextView(parent.context)
        tv.textSize = 28f
        tv.gravity = Gravity.CENTER
        tv.includeFontPadding = false
        tv.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, context.dpi(46f))
        tv.isClickable = true
        tv.isFocusable = true
        object : RecyclerView.ViewHolder(tv) {}
      }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      val r = rows[position]
      val tv = holder.itemView as TextView
      if (r.header != null) { tv.text = r.header; return }
      val e = r.emoji ?: ""
      tv.text = e
      tv.contentDescription = e
      tv.background = if (e == mine) GradientDrawable().apply { cornerRadius = context.dpi(10f).toFloat(); setColor(Color.argb(42, 255, 255, 255)) } else null
      tv.setOnClickListener { v ->
        v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        val loc = IntArray(2)
        v.getLocationOnScreen(loc)
        onPick?.invoke(e, loc[0] + v.width / 2f, loc[1] + v.height / 2f)
      }
    }
  }
}

// ─── Estouro do emoji ───────────────────────────────────────────────────────

object SVReactionBurst {
  /** Emoji nasce em (fromX, fromY) — coordenadas de `host` —, sobe com mola
   *  até o centro-alto e estoura soltando mini cópias. reduce = só fade. */
  fun play(host: FrameLayout, glyph: String, fromX: Float?, fromY: Float?, reduce: Boolean) {
    val ctx = host.context
    val w = host.width.toFloat()
    val h = host.height.toFloat()
    if (w <= 0f || h <= 0f) return
    val side = min(ctx.dpi(180f), max(ctx.dpi(120f), (w * 0.42f).toInt()))
    val bmp = svEmojiBitmap(glyph, side)
    val iv = ImageView(ctx)
    iv.setImageBitmap(bmp)
    iv.isClickable = false
    iv.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    host.addView(iv, FrameLayout.LayoutParams(side, side, Gravity.TOP or Gravity.START))
    val tx = w / 2f
    val ty = h * 0.42f
    if (reduce) {
      iv.translationX = tx - side / 2f
      iv.translationY = ty - side / 2f
      iv.alpha = 0f
      iv.animate().alpha(1f).setDuration(180).withEndAction {
        iv.animate().alpha(0f).setStartDelay(550).setDuration(300).withEndAction { host.removeView(iv) }.start()
      }.start()
      return
    }
    val sx = fromX ?: (w / 2f)
    val sy = fromY ?: (h * 0.8f)
    iv.translationX = sx - side / 2f
    iv.translationY = sy - side / 2f
    iv.scaleX = 0.22f
    iv.scaleY = 0.22f
    // bouncy (ζ≈0.46 → Overshoot): sobe e passa um pouco do tamanho
    iv.animate().translationX(tx - side / 2f).translationY(ty - side / 2f).scaleX(1f).scaleY(1f)
      .setDuration(520).setInterpolator(OvershootInterpolator(1.8f)).withEndAction {
        host.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        sparks(host, bmp, tx, ty, side)
        iv.animate().scaleX(1.45f).scaleY(1.45f).alpha(0f).setStartDelay(300).setDuration(260)
          .setInterpolator(AccelerateInterpolator()).withEndAction { host.removeView(iv) }.start()
      }.start()
  }

  private fun sparks(host: FrameLayout, bmp: Bitmap, cx: Float, cy: Float, side: Int) {
    val ctx = host.context
    val n = 7
    for (i in 0 until n) {
      val s = ctx.dpi(26f + Random.nextFloat() * 16f)
      val v = ImageView(ctx)
      v.setImageBitmap(bmp)
      v.scaleType = ImageView.ScaleType.FIT_CENTER
      v.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      host.addView(v, FrameLayout.LayoutParams(s, s, Gravity.TOP or Gravity.START))
      v.translationX = cx - s / 2f
      v.translationY = cy - s / 2f
      v.alpha = 0f
      val ang = (i.toDouble() / n) * Math.PI * 2 + (Random.nextDouble() - 0.5) * 0.6
      val dist = side * (0.75f + Random.nextFloat() * 0.35f)
      val dx = (cos(ang) * dist).toFloat()
      val dy = (sin(ang) * dist).toFloat() - ctx.dpi(30f)
      v.animate().alpha(1f).setStartDelay(300).setDuration(120).start()
      v.animate().translationX(cx - s / 2f + dx).translationY(cy - s / 2f + dy).rotation((Random.nextFloat() - 0.5f) * 70f)
        .scaleX(0.7f).scaleY(0.7f).setStartDelay(300).setDuration(700).setInterpolator(DecelerateInterpolator())
        .withEndAction {
          v.animate().alpha(0f).setStartDelay(0).setDuration(200).withEndAction { host.removeView(v) }.start()
        }.start()
    }
  }
}
