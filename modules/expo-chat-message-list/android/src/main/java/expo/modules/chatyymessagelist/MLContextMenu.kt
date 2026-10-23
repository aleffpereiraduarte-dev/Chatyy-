package expo.modules.chatyymessagelist

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.RenderEffect
import android.graphics.Shader
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.provider.Settings
import android.text.Editable
import android.text.TextUtils
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.animation.PathInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.FloatValueHolder
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import java.text.Normalizer
import kotlin.math.max
import kotlin.math.min

// [2026-10-15 native-ctxmenu] Menu de contexto da MENSAGEM 100% nativo (Android).
// Equivalente ao CMLContextMenu.swift: overlay no DecorView, conteúdo da
// Activity borrado com RenderEffect (12+; antes disso só escurece), balão
// (snapshot real) com SpringAnimation, barra de reações escalonada + "+"
// (grade de emojis com busca/recentes), menu de ações com a lista do JS,
// reação voando até a bolha. Dono: MLListView (prop ctxMenu, apiVersion 3).

class MLCtxAction(
  val id: String, val title: String, val sub: String,
  val paths: List<MLIconPath>, val vb: Float,
  val destructive: Boolean, val disabled: Boolean,
)

class MLCtxTheme(private val m: Map<*, *>?, val dark: Boolean) {
  private fun c(k: String, d: Int): Int = (m?.get(k)?.let { MLRow.color(it) }) ?: d
  val accent = c("accent", 0xFF0A84FF.toInt())
  val text = c("text", if (dark) Color.WHITE else Color.BLACK)
  val sub = c("sub", if (dark) 0x99EBEBF5.toInt() else 0x993C3C43.toInt())
  val destructive = c("destructive", 0xFFFF3B30.toInt())
  val menuSolid = c("menuSolid", if (dark) 0xFF252527.toInt() else Color.WHITE)
  val sep = c("sep", if (dark) 0x8C545458.toInt() else 0x2E3C3C43)
  val press = c("press", if (dark) 0x1AFFFFFF else 0x12000000)
  val reactBg = c("reactBg", if (dark) 0xFF252527.toInt() else Color.WHITE)
  val mineBg = c("mineBg", if (dark) 0x29FFFFFF else 0x14000000)
  val dim = c("dim", if (dark) 0x73000000 else 0x38000000)
  val field = c("field", if (dark) 0x3D767680 else 0x1F767680)
}

class MLCtxMenuData(d: Map<String, Any?>) {
  val key: String = MLRow.str(d["key"])
  val messageId: String = MLRow.str(d["messageId"])
  val own: Boolean = MLRow.bool(d["own"])
  val showReactions: Boolean = if (d["showReactions"] == null) true else MLRow.bool(d["showReactions"])
  val reactions: List<String> = ((d["reactions"] as? List<*>) ?: emptyList<Any>()).map { MLRow.str(it) }.filter { it.isNotEmpty() }
  val mine: String = MLRow.str(d["mine"])
  val dark: Boolean = MLRow.bool(d["dark"])
  val theme = MLCtxTheme(d["theme"] as? Map<*, *>, dark)
  val labels: Map<String, String> = ((d["labels"] as? Map<*, *>) ?: emptyMap<Any, Any>()).entries.associate { MLRow.str(it.key) to MLRow.str(it.value) }
  val recents: List<String> = ((d["recents"] as? List<*>) ?: emptyList<Any>()).map { MLRow.str(it) }.filter { it.isNotEmpty() }
  val actions: List<MLCtxAction>

  init {
    val out = ArrayList<MLCtxAction>()
    for (a in (d["actions"] as? List<*>) ?: emptyList<Any>()) {
      val m = a as? Map<*, *> ?: continue
      val id = MLRow.str(m["id"])
      if (id.isEmpty()) continue
      var paths: List<MLIconPath> = emptyList()
      var vb = 24f
      (m["ic"] as? Map<*, *>)?.let { ic ->
        try {
          val n = MLNode(mapOf("t" to "ic", "s" to 22.0, "vb" to (ic["vb"] ?: 24.0), "ps" to (ic["ps"] ?: emptyList<Any>())))
          paths = n.paths; vb = n.vb
        } catch (_: Throwable) {}
      }
      out.add(MLCtxAction(id, MLRow.str(m["title"]), MLRow.str(m["sub"]), paths, vb, MLRow.bool(m["destructive"]), MLRow.bool(m["disabled"])))
    }
    actions = out
    d["emoji"]?.let { MLEmojiStore.update(it) }
  }
}

/** Catálogo de emojis (mandado pelo JS uma vez por sessão). */
object MLEmojiStore {
  class Cat(val title: String, val emojis: List<String>, val keys: List<String>)
  @Volatile var cats: List<Cat> = emptyList()

  fun update(v: Any?) {
    val d = v as? Map<*, *> ?: return
    val arr = d["cats"] as? List<*> ?: return
    val out = ArrayList<Cat>()
    for (x in arr) {
      val m = x as? Map<*, *> ?: continue
      val e = ((m["e"] as? List<*>) ?: emptyList<Any>()).map { MLRow.str(it) }
      val k = ((m["k"] as? List<*>) ?: emptyList<Any>()).map { fold(MLRow.str(it)) }.toMutableList()
      while (k.size < e.size) k.add("")
      if (e.isEmpty()) continue
      out.add(Cat(MLRow.str(m["t"]), e, k))
    }
    if (out.isNotEmpty()) cats = out
  }

  fun fold(s: String): String {
    val n = Normalizer.normalize(s, Normalizer.Form.NFD)
    return n.replace(Regex("\\p{M}+"), "").lowercase()
  }

  fun search(q: String): List<String> {
    val f = fold(q.trim())
    if (f.isEmpty()) return emptyList()
    val out = ArrayList<String>()
    val seen = HashSet<String>()
    for (c in cats) {
      for ((i, e) in c.emojis.withIndex()) {
        if (e in seen) continue
        val k = if (i < c.keys.size) c.keys[i] else ""
        if (e == q || k.contains(f)) { out.add(e); seen.add(e) }
      }
    }
    return out
  }
}

/** Ícone (paths do Icons.js) pintado com a cor da linha. */
class MLCtxIconView(ctx: Context) : View(ctx) {
  var paths: List<MLIconPath> = emptyList()
    set(v) { field = v; invalidate() }
  var vb = 24f
  var tint = Color.BLACK
    set(v) { field = v; invalidate() }
  private val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (paths.isEmpty() || vb <= 0f) return
    val s = min(width, height) / vb
    canvas.save()
    canvas.translate((width - vb * s) / 2f, (height - vb * s) / 2f)
    canvas.scale(s, s)
    for (ip in paths) {
      val a = (ip.opacity * 255).toInt().coerceIn(0, 255)
      if (ip.fill != 0) {
        p.style = Paint.Style.FILL; p.color = tint; p.alpha = (Color.alpha(tint) * a / 255)
        canvas.drawPath(ip.path, p)
      }
      if (ip.stroke != 0) {
        p.style = Paint.Style.STROKE; p.strokeWidth = ip.width; p.color = tint; p.alpha = (Color.alpha(tint) * a / 255)
        canvas.drawPath(ip.path, p)
      }
    }
    canvas.restore()
  }
}

@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
class MLCtxOverlay(
  private val activity: Activity,
  val key: String,
  bmp: Bitmap,
  private val src: RectF,          // coordenadas do DecorView (= janela)
  private var own: Boolean,
  private val dark: Boolean,
) : FrameLayout(activity) {
  var onAction: ((MLCtxMenuData, String) -> Unit)? = null
  var onReact: ((MLCtxMenuData, String) -> Unit)? = null
  var onDismissed: ((String) -> Unit)? = null
  var sourceRectProvider: (() -> RectF?)? = null

  var data: MLCtxMenuData? = null
    private set
  var dismissing = false
    private set
  private var finished = false
  private val decor: ViewGroup? = activity.window?.decorView as? ViewGroup
  private val content: View? = decor?.findViewById(android.R.id.content)
  private val dimView = View(activity)
  private val bubble = ImageView(activity)
  private var bar: LinearLayout? = null
  private val barItems = ArrayList<View>()
  private var menu: FrameLayout? = null
  private val menuRows = ArrayList<View>()
  private var panel: FrameLayout? = null
  private var panelContent: LinearLayout? = null
  private var search: EditText? = null
  private var blurAnim: ValueAnimator? = null
  private var blurR = 0f
  private var bubbleScale = 1f
  private var target = RectF()
  private var pending = 0
  private var lastReason = "outside"
  private var imeBottom = 0
  private var panelBase: RectF? = null
  private val reduce: Boolean = try {
    Settings.Global.getFloat(activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
  } catch (_: Throwable) { false }
  private val timeout = Runnable { if (data == null) dismiss("timeout") }

  private fun dp(v: Float): Float = v * resources.displayMetrics.density
  private fun dpi(v: Float): Int = (dp(v) + 0.5f).toInt()

  init {
    isClickable = true
    isFocusable = true
    isFocusableInTouchMode = true
    clipChildren = false
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    dimView.setBackgroundColor(if (dark) 0x73000000 else 0x38000000)
    dimView.alpha = 0f
    addView(dimView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    bubble.setImageBitmap(bmp)
    bubble.scaleType = ImageView.ScaleType.FIT_XY
    addView(bubble, LayoutParams(src.width().toInt().coerceAtLeast(1), src.height().toInt().coerceAtLeast(1)))
    bubble.x = src.left
    bubble.y = src.top
    bubble.setOnClickListener { dismiss("outside") }
    setOnClickListener {
      val s = search
      if (s != null && s.hasFocus()) { hideIme(s); s.clearFocus() } else dismiss("outside")
    }
    ViewCompat.setOnApplyWindowInsetsListener(this) { _, ins ->
      val b = ins.getInsets(WindowInsetsCompat.Type.ime()).bottom
      if (b != imeBottom) { imeBottom = b; post { placePanelForIme() } }
      ins
    }
  }

  // ─── apresentar (no long-press, antes do JS responder) ──────────────────
  fun present(): Boolean {
    val d = decor ?: return false
    d.addView(this, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    requestFocus()
    dimView.animate().alpha(1f).setDuration(if (reduce) 120 else 260).setInterpolator(DecelerateInterpolator()).start()
    animateBlur(dp(22f), if (reduce) 120 else 280)
    if (!reduce) {
      bubble.pivotX = src.width() / 2f
      bubble.pivotY = src.height() / 2f
      val sx = SpringAnimation(bubble, DynamicAnimation.SCALE_X, 1.04f)
      val sy = SpringAnimation(bubble, DynamicAnimation.SCALE_Y, 1.04f)
      for (s in listOf(sx, sy)) {
        s.spring.setStiffness(1500f).setDampingRatio(SpringForce.DAMPING_RATIO_NO_BOUNCY)
      }
      sx.addEndListener { _, canceled, _, _ ->
        if (!canceled && !dismissing) {
          springTo(bubble, DynamicAnimation.SCALE_X, bubbleScale, 500f, 0.55f)
          springTo(bubble, DynamicAnimation.SCALE_Y, bubbleScale, 500f, 0.55f)
        }
      }
      sx.start(); sy.start()
    }
    postDelayed(timeout, 2500)
    return true
  }

  private fun springTo(v: View, p: DynamicAnimation.ViewProperty, value: Float, stiffness: Float, damping: Float, end: (() -> Unit)? = null): SpringAnimation {
    val s = SpringAnimation(v, p, value)
    s.spring.setStiffness(stiffness).setDampingRatio(damping)
    if (end != null) s.addEndListener { _, _, _, _ -> end() }
    s.start()
    return s
  }

  private fun animateBlur(to: Float, dur: Long, end: (() -> Unit)? = null) {
    blurAnim?.cancel()
    if (Build.VERSION.SDK_INT < 31 || content == null) { end?.invoke(); return }
    val a = ValueAnimator.ofFloat(blurR, to)
    a.duration = dur
    a.addUpdateListener { setBlur(it.animatedValue as Float) }
    a.addListener(object : AnimatorListenerAdapter() {
      override fun onAnimationEnd(animation: Animator) { end?.invoke() }
    })
    blurAnim = a
    a.start()
  }

  private fun setBlur(r: Float) {
    blurR = r
    if (Build.VERSION.SDK_INT < 31) return
    try {
      val c = content ?: return
      if (r < 0.5f) c.setRenderEffect(null)
      else c.setRenderEffect(RenderEffect.createBlurEffect(r, r, Shader.TileMode.CLAMP))
    } catch (_: Throwable) {}
  }

  // ─── conteúdo (lista do JS) ─────────────────────────────────────────────
  fun setMenu(d: MLCtxMenuData) {
    if (dismissing || data != null) return
    data = d
    removeCallbacks(timeout)
    own = d.own
    val th = d.theme
    dimView.setBackgroundColor(th.dim)
    if (d.showReactions && d.reactions.isNotEmpty()) buildBar(d)
    if (d.actions.isNotEmpty()) buildMenu(d)
    // [2026-10-22 ctx-blink] balão ACIMA do menu (paridade iOS d1c3ad21): o menu
    // entra/sai escalando (0,5→1) e passava POR CIMA da foto/álbum ("retângulo
    // cinza" no 1º quadro e na volta). No Android a ordem real é o Z (elevation
    // vence bringToFront): menu 12−6=6 < balão 7 < reações 8 < painel 12 < voo 16.
    menu?.let { it.bringToFront(); it.translationZ = -dp(6f) }
    bubble.outlineProvider = null // Z só p/ ordem, sem sombra no snapshot
    bubble.elevation = dp(7f)
    bubble.bringToFront()
    bar?.bringToFront()
    layoutMenu()
    animateIn()
  }

  private fun buildBar(d: MLCtxMenuData) {
    val th = d.theme
    val b = LinearLayout(context)
    b.orientation = LinearLayout.HORIZONTAL
    b.gravity = Gravity.CENTER_VERTICAL
    b.setPadding(dpi(6f), 0, dpi(6f), 0)
    b.background = GradientDrawable().apply { setColor(th.reactBg); cornerRadius = dp(26f) }
    b.elevation = dp(8f)
    b.clipChildren = false
    b.clipToPadding = false
    b.isClickable = true
    for (e in d.reactions) {
      val tv = TextView(context)
      tv.text = e
      tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
      tv.gravity = Gravity.CENTER
      tv.includeFontPadding = false
      tv.contentDescription = e
      if (e == d.mine) tv.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(th.mineBg) }
      b.addView(tv, LinearLayout.LayoutParams(dpi(42f), dpi(42f)).apply { marginStart = dpi(1f); marginEnd = dpi(1f) })
      pressScale(tv, -dp(3f)) { pickReaction(e, tv) }
      barItems.add(tv)
    }
    val more = MLCtxIconView(context)
    more.paths = listOfNotNull(MLNode.parsePath("M12 6v12M6 12h12")?.let { MLIconPath(it, 0, Color.BLACK, 2.2f, 1f) })
    more.vb = 24f
    more.tint = th.sub
    more.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(th.field) }
    more.setPadding(dpi(6f), dpi(6f), dpi(6f), dpi(6f))
    more.contentDescription = d.labels["more"] ?: "+"
    b.addView(more, LinearLayout.LayoutParams(dpi(32f), dpi(32f)).apply { marginStart = dpi(5f); marginEnd = dpi(3f) })
    pressScale(more, 0f) { expandEmoji() }
    barItems.add(more)
    addView(b, LayoutParams(LayoutParams.WRAP_CONTENT, dpi(52f)))
    bar = b
  }

  private fun pressScale(v: View, lift: Float, click: () -> Unit) {
    v.isClickable = true
    v.setOnTouchListener { view, ev ->
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          view.animate().scaleX(1.28f).scaleY(1.28f).translationY(lift).setDuration(140).start()
        }
        MotionEvent.ACTION_UP -> {
          springTo(view, DynamicAnimation.SCALE_X, 1f, 600f, 0.6f)
          springTo(view, DynamicAnimation.SCALE_Y, 1f, 600f, 0.6f)
          springTo(view, DynamicAnimation.TRANSLATION_Y, 0f, 600f, 0.6f)
          val inside = ev.x >= 0 && ev.y >= 0 && ev.x <= view.width && ev.y <= view.height
          if (inside) click()
        }
        MotionEvent.ACTION_CANCEL -> {
          springTo(view, DynamicAnimation.SCALE_X, 1f, 600f, 0.6f)
          springTo(view, DynamicAnimation.SCALE_Y, 1f, 600f, 0.6f)
          springTo(view, DynamicAnimation.TRANSLATION_Y, 0f, 600f, 0.6f)
        }
      }
      true
    }
  }

  private fun buildMenu(d: MLCtxMenuData) {
    val th = d.theme
    val box = FrameLayout(context)
    box.background = GradientDrawable().apply { setColor(th.menuSolid); cornerRadius = dp(14f) }
    box.elevation = dp(12f)
    box.clipToOutline = true
    box.isClickable = true
    val sv = ScrollView(context)
    sv.isVerticalScrollBarEnabled = false
    sv.overScrollMode = View.OVER_SCROLL_NEVER
    val col = LinearLayout(context)
    col.orientation = LinearLayout.VERTICAL
    for ((i, a) in d.actions.withIndex()) {
      if (i > 0) {
        val prev = d.actions[i - 1]
        val group = (a.destructive || a.disabled) && !(prev.destructive || prev.disabled)
        val sep = View(context)
        sep.setBackgroundColor(if (group) (th.sep and 0x00FFFFFF) or (((Color.alpha(th.sep) * 0.6f).toInt()) shl 24) else th.sep)
        col.addView(sep, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, if (group) dpi(8f) else max(1, dpi(0.5f))))
      }
      val row = buildRow(a, th)
      // [2026-10-17 ctx-fit] altura mínima fixa; título longo quebra em 2 linhas (sem "…").
      row.minimumHeight = dpi(if (a.sub.isEmpty()) 48f else 58f)
      col.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
      menuRows.add(row)
    }
    sv.addView(col, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    box.addView(sv, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(box, LayoutParams(dpi(250f), LayoutParams.WRAP_CONTENT))
    menu = box
  }

  private fun buildRow(a: MLCtxAction, th: MLCtxTheme): View {
    val color = if (a.disabled) th.sub else if (a.destructive) th.destructive else th.text
    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    row.setPadding(dpi(16f), dpi(6f), dpi(14f), dpi(6f))
    val texts = LinearLayout(context)
    texts.orientation = LinearLayout.VERTICAL
    val title = TextView(context)
    title.text = a.title
    title.setTextColor(color)
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    title.maxLines = 2
    title.ellipsize = TextUtils.TruncateAt.END
    texts.addView(title)
    if (a.sub.isNotEmpty()) {
      val s = TextView(context)
      s.text = a.sub
      s.setTextColor(th.sub)
      s.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      s.maxLines = 1
      texts.addView(s)
    }
    row.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    if (a.paths.isNotEmpty()) {
      val ic = MLCtxIconView(context)
      ic.paths = a.paths
      ic.vb = a.vb
      ic.tint = color
      row.addView(ic, LinearLayout.LayoutParams(dpi(22f), dpi(22f)).apply { marginStart = dpi(10f) })
    }
    row.contentDescription = if (a.sub.isEmpty()) a.title else "${a.title}, ${a.sub}"
    if (!a.disabled) {
      row.background = RippleDrawable(ColorStateList.valueOf(th.press), null, ColorDrawable(Color.WHITE))
      row.setOnClickListener { tapAction(a) }
    } else {
      row.alpha = 0.55f
      row.isEnabled = false
    }
    return row
  }

  private fun insetsTop(): Float {
    val ins = ViewCompat.getRootWindowInsets(this)?.getInsets(WindowInsetsCompat.Type.systemBars())
    return max(ins?.top?.toFloat() ?: 0f, dp(24f)) + dp(8f)
  }

  private fun insetsBottom(): Float {
    val ins = ViewCompat.getRootWindowInsets(this)?.getInsets(WindowInsetsCompat.Type.systemBars())
    val h = if (height > 0) height.toFloat() else (decor?.height ?: 0).toFloat()
    return h - max(ins?.bottom?.toFloat() ?: 0f, dp(12f)) - dp(8f)
  }

  private fun overlayW(): Float = if (width > 0) width.toFloat() else (decor?.width ?: 0).toFloat()

  private fun layoutMenu() {
    val margin = dp(8f)
    val top = insetsTop()
    val bottom = insetsBottom()
    val w = overlayW()
    val reactH = if (bar == null) 0f else dp(52f)
    val gapR = if (bar == null) 0f else dp(10f)
    val gapM = if (menu == null) 0f else dp(10f)
    val menuW = min(dp(250f), w - margin * 2)
    var menuH = 0f
    menu?.let { m ->
      m.measure(View.MeasureSpec.makeMeasureSpec(menuW.toInt(), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
      // [2026-10-17 ctx-fit] menu inteiro primeiro (só um mínimo p/ o balão);
      // o balão encolhe no que sobrar; só rola se nem assim couber.
      val minBubble = min(max(src.height(), 1f), dp(64f))
      val menuRoom = (bottom - top) - reactH - gapR - gapM - minBubble
      menuH = min(m.measuredHeight.toFloat(), max(dp(96f), menuRoom))
      m.layoutParams = (m.layoutParams as LayoutParams).apply { width = menuW.toInt(); height = menuH.toInt() }
    }
    val availB = max(min(max(src.height(), 1f), dp(64f)), (bottom - top) - reactH - gapR - menuH - gapM)
    var scale = 1f
    if (src.height() > availB && src.height() > 0f) scale = max(0.12f, availB / src.height())
    val bw = src.width() * scale
    val bh = src.height() * scale
    var by = src.top
    if (by - gapR - reactH < top) by = top + reactH + gapR
    if (by + bh + gapM + menuH > bottom) by = bottom - menuH - gapM - bh
    if (by - gapR - reactH < top) by = top + reactH + gapR
    val bx = if (own) src.right - bw else src.left
    target = RectF(bx, by, bx + bw, by + bh)
    bubbleScale = scale
    bar?.let { b ->
      b.measure(View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED), View.MeasureSpec.makeMeasureSpec(dpi(52f), View.MeasureSpec.EXACTLY))
      val bwid = min(b.measuredWidth.toFloat(), w - margin * 2)
      b.layoutParams = (b.layoutParams as LayoutParams).apply { width = bwid.toInt() }
      var x = if (own) target.right - bwid else target.left
      x = max(margin, min(w - margin - bwid, x))
      b.x = x
      b.y = by - gapR - reactH
      b.pivotX = if (own) bwid else 0f
      b.pivotY = reactH
    }
    menu?.let { m ->
      var x = if (own) target.right - menuW else target.left
      x = max(margin, min(w - margin - menuW, x))
      m.x = x
      m.y = target.bottom + gapM
      m.pivotX = if (own) menuW else 0f
      m.pivotY = 0f
    }
  }

  private fun animateIn() {
    // balão: centro escalado no lugar-alvo (pivot = centro do snapshot)
    val tx = target.centerX() - src.width() / 2f
    val ty = target.centerY() - src.height() / 2f
    if (reduce) {
      bubble.x = tx; bubble.y = ty; bubble.scaleX = bubbleScale; bubble.scaleY = bubbleScale
      bar?.alpha = 0f; menu?.alpha = 0f
      bar?.animate()?.alpha(1f)?.setDuration(150)?.start()
      menu?.animate()?.alpha(1f)?.setDuration(150)?.start()
      return
    }
    springTo(bubble, DynamicAnimation.X, tx, 380f, 0.8f)
    springTo(bubble, DynamicAnimation.Y, ty, 380f, 0.8f)
    springTo(bubble, DynamicAnimation.SCALE_X, bubbleScale, 500f, 0.7f)
    springTo(bubble, DynamicAnimation.SCALE_Y, bubbleScale, 500f, 0.7f)
    bar?.let { b ->
      b.alpha = 0f; b.scaleX = 0.45f; b.scaleY = 0.45f
      b.animate().alpha(1f).setDuration(160).start()
      springTo(b, DynamicAnimation.SCALE_X, 1f, 420f, 0.68f)
      springTo(b, DynamicAnimation.SCALE_Y, 1f, 420f, 0.68f)
      for ((i, v) in barItems.withIndex()) {
        v.alpha = 0f; v.scaleX = 0.25f; v.scaleY = 0.25f
        postDelayed({
          if (dismissing) return@postDelayed
          v.animate().alpha(1f).setDuration(120).start()
          springTo(v, DynamicAnimation.SCALE_X, 1f, 520f, 0.5f)
          springTo(v, DynamicAnimation.SCALE_Y, 1f, 520f, 0.5f)
        }, 40L + i * 25L)
      }
    }
    menu?.let { m ->
      m.alpha = 0f; m.scaleX = 0.5f; m.scaleY = 0.5f
      m.animate().alpha(1f).setDuration(170).start()
      springTo(m, DynamicAnimation.SCALE_X, 1f, 420f, 0.78f)
      springTo(m, DynamicAnimation.SCALE_Y, 1f, 420f, 0.78f)
      for ((i, r) in menuRows.withIndex()) {
        r.alpha = 0f; r.translationY = -dp(8f)
        r.animate().alpha(1f).translationY(0f).setStartDelay(30L + i * 18L).setDuration(280).setInterpolator(DecelerateInterpolator()).start()
      }
    }
  }

  // ─── ações ──────────────────────────────────────────────────────────────
  private fun tapAction(a: MLCtxAction) {
    val d = data ?: return
    if (dismissing) return
    try { performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP) } catch (_: Throwable) {}
    onAction?.invoke(d, a.id)
    dismiss("action")
  }

  private fun pickReaction(e: String, from: View) {
    val d = data ?: return
    if (dismissing) return
    try { performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK) } catch (_: Throwable) {}
    val removing = e == d.mine
    onReact?.invoke(d, e)
    if (!removing && !reduce) {
      val loc = IntArray(2); from.getLocationInWindow(loc)
      val me = IntArray(2); getLocationInWindow(me)
      fly(e, loc[0] - me[0] + from.width / 2f, loc[1] - me[1] + from.height / 2f)
    }
    dismiss("react")
  }

  // ─── "+" → grade de emojis ──────────────────────────────────────────────
  private fun expandEmoji() {
    val d = data ?: return
    val b = bar ?: return
    if (dismissing || panel != null) return
    try { performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP) } catch (_: Throwable) {}
    val th = d.theme
    val p = FrameLayout(context)
    p.background = GradientDrawable().apply { setColor(th.reactBg); cornerRadius = dp(26f) }
    p.elevation = dp(12f)
    p.clipToOutline = true
    p.isClickable = true
    val col = LinearLayout(context)
    col.orientation = LinearLayout.VERTICAL
    col.alpha = 0f
    val et = EditText(context)
    et.hint = d.labels["search"] ?: "Buscar emoji"
    et.setHintTextColor(th.sub)
    et.setTextColor(th.text)
    et.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    et.setSingleLine(true)
    et.imeOptions = EditorInfo.IME_ACTION_SEARCH
    et.background = GradientDrawable().apply { setColor(th.field); cornerRadius = dp(10f) }
    et.setPadding(dpi(12f), 0, dpi(12f), 0)
    col.addView(et, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dpi(38f)).apply { setMargins(dpi(10f), dpi(10f), dpi(10f), dpi(4f)) })
    val empty = TextView(context)
    empty.text = d.labels["noResults"] ?: "Nenhum emoji encontrado"
    empty.setTextColor(th.sub)
    empty.gravity = Gravity.CENTER
    empty.visibility = View.GONE
    col.addView(empty, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dpi(56f)))
    val rv = RecyclerView(context)
    rv.overScrollMode = View.OVER_SCROLL_NEVER
    rv.clipToPadding = false
    rv.setPadding(dpi(6f), 0, dpi(6f), dpi(8f))
    col.addView(rv, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
    p.addView(col, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

    // dados: recentes (+ rápidas) e categorias
    val base = ArrayList<Pair<String, List<String>>>()
    val rec = LinkedHashSet<String>()
    for (e in d.recents + d.reactions) if (e.isNotEmpty() && !e.startsWith("sticker:")) rec.add(e)
    if (rec.isNotEmpty()) base.add(Pair(d.labels["recents"] ?: "Recentes", rec.take(24)))
    for (c in MLEmojiStore.cats) base.add(Pair(c.title, c.emojis))
    val adapter = EmojiAdapter(th, d.mine) { e, v -> pickReaction(e, v) }
    adapter.setSections(base)
    val w = min(overlayW() - dp(16f), dp(380f))
    val span = max(1, ((w - dp(12f)) / dp(44f)).toInt())
    val glm = GridLayoutManager(context, span)
    glm.spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
      override fun getSpanSize(position: Int): Int = if (adapter.isHeader(position)) span else 1
    }
    rv.layoutManager = glm
    rv.adapter = adapter
    rv.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_DRAGGING && et.hasFocus()) { hideIme(et); et.clearFocus() }
      }
    })
    et.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        val q = s?.toString() ?: ""
        if (q.isBlank()) adapter.setSections(base)
        else {
          val r = MLEmojiStore.search(q)
          adapter.setSections(if (r.isEmpty()) emptyList() else listOf(Pair("", r)))
          empty.visibility = if (r.isEmpty()) View.VISIBLE else View.GONE
        }
        if (q.isBlank()) empty.visibility = View.GONE
        rv.scrollToPosition(0)
      }
    })
    et.setOnEditorActionListener { v, _, _ -> hideIme(v); true }
    search = et
    panelContent = col

    val start = RectF(b.x, b.y, b.x + b.width, b.y + b.height)
    val margin = dp(8f)
    val top = insetsTop()
    val bottom = insetsBottom()
    val h = min(dp(340f), (bottom - top) * 0.62f)
    var x = if (own) start.right - w else start.left
    x = max(margin, min(overlayW() - margin - w, x))
    var y = start.top
    if (y + h > bottom) y = bottom - h
    if (y < top) y = top
    val end = RectF(x, y, x + w, y + h)
    panelBase = end
    addView(p, LayoutParams(start.width().toInt(), start.height().toInt()))
    p.x = start.left; p.y = start.top
    panel = p
    b.isEnabled = false
    for (v in barItems) v.isClickable = false
    menu?.let { m -> m.animate().alpha(0f).scaleX(0.85f).scaleY(0.85f).setDuration(160).start(); setEnabledDeep(m, false) }
    b.animate().alpha(0f).setDuration(140).start()
    val bg = p.background as? GradientDrawable
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = if (reduce) 120 else 360
    a.interpolator = PathInterpolator(0.2f, 0.9f, 0.25f, 1.05f)
    a.addUpdateListener {
      val f = it.animatedValue as Float
      val l = start.left + (end.left - start.left) * f
      val t = start.top + (end.top - start.top) * f
      val ww = start.width() + (end.width() - start.width()) * f
      val hh = start.height() + (end.height() - start.height()) * f
      p.x = l; p.y = t
      val lp = p.layoutParams
      lp.width = max(1f, ww).toInt(); lp.height = max(1f, hh).toInt()
      p.layoutParams = lp
      bg?.cornerRadius = dp(26f) + (dp(20f) - dp(26f)) * f.coerceIn(0f, 1f)
    }
    a.addListener(object : AnimatorListenerAdapter() {
      override fun onAnimationEnd(animation: Animator) {
        if (!dismissing) col.animate().alpha(1f).setDuration(180).start()
        placePanelForIme()
      }
    })
    a.start()
  }

  private fun setEnabledDeep(v: View, on: Boolean) {
    v.isEnabled = on
    if (v is ViewGroup) for (i in 0 until v.childCount) setEnabledDeep(v.getChildAt(i), on)
  }

  private fun placePanelForIme() {
    val p = panel ?: return
    val base = panelBase ?: return
    if (dismissing) return
    var f = RectF(base)
    if (imeBottom > 0) {
      val limit = (if (height > 0) height else (decor?.height ?: 0)) - imeBottom - dp(8f)
      if (f.bottom > limit) {
        val top = insetsTop()
        val nt = max(top, limit - f.height())
        f = RectF(f.left, nt, f.right, min(limit, nt + f.height()))
      }
    }
    p.animate().x(f.left).y(f.top).setDuration(200).start()
    val lp = p.layoutParams
    if (lp.height != f.height().toInt()) { lp.height = f.height().toInt(); p.layoutParams = lp }
  }

  private fun hideIme(v: View) {
    try { (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(v.windowToken, 0) } catch (_: Throwable) {}
  }

  private inner class EmojiAdapter(val th: MLCtxTheme, val mine: String, val pick: (String, View) -> Unit) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    // itens planos: String começando com \u0000 = cabeçalho
    private val items = ArrayList<String>()
    @SuppressLint("NotifyDataSetChanged")
    fun setSections(s: List<Pair<String, List<String>>>) {
      items.clear()
      for ((t, l) in s) {
        if (t.isNotEmpty()) items.add("\u0000" + t)
        items.addAll(l)
      }
      notifyDataSetChanged()
    }
    fun isHeader(pos: Int): Boolean = pos in items.indices && items[pos].startsWith("\u0000")
    override fun getItemCount(): Int = items.size
    override fun getItemViewType(position: Int): Int = if (isHeader(position)) 1 else 0
    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      val tv = TextView(parent.context)
      if (viewType == 1) {
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        tv.setTextColor(th.sub)
        tv.typeface = android.graphics.Typeface.DEFAULT_BOLD
        tv.setPadding(dpi(6f), dpi(10f), dpi(6f), dpi(4f))
        tv.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.WRAP_CONTENT)
      } else {
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 27f)
        tv.gravity = Gravity.CENTER
        tv.includeFontPadding = false
        tv.layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, dpi(44f))
        tv.background = RippleDrawable(ColorStateList.valueOf(th.press), null, GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(10f) })
      }
      return object : RecyclerView.ViewHolder(tv) {}
    }
    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      val tv = holder.itemView as TextView
      val s = items[position]
      if (s.startsWith("\u0000")) { tv.text = s.substring(1).uppercase(); return }
      tv.text = s
      tv.contentDescription = s
      if (s == mine) {
        tv.foreground = GradientDrawable().apply { setColor(th.mineBg); cornerRadius = dp(10f) }
      } else tv.foreground = null
      tv.setOnClickListener { v -> pick(s, v) }
    }
  }

  // ─── reação voando até a bolha ──────────────────────────────────────────
  private fun fly(e: String, sx: Float, sy: Float) {
    val dest = sourceRectProvider?.invoke() ?: src
    val tv = TextView(context)
    tv.text = e
    tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
    tv.includeFontPadding = false
    tv.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
    val w = tv.measuredWidth.toFloat()
    val h = tv.measuredHeight.toFloat()
    addView(tv, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    tv.elevation = dp(16f)
    val ex = if (own) dest.right - dp(20f) else dest.left + dp(20f)
    val ey = dest.bottom + dp(7f)
    val cx = (sx + ex) / 2f + (if (own) -dp(50f) else dp(50f))
    val cy = min(sy, ey) - dp(70f)
    pending++
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 520
    a.interpolator = PathInterpolator(0.32f, 0f, 0.18f, 1f)
    a.addUpdateListener {
      val t = it.animatedValue as Float
      val u = 1f - t
      val x = u * u * sx + 2f * u * t * cx + t * t * ex
      val y = u * u * sy + 2f * u * t * cy + t * t * ey
      tv.x = x - w / 2f
      tv.y = y - h / 2f
      val s = if (t < 0.38f) 1f + 0.55f * (t / 0.38f) else 1.55f - 1.05f * ((t - 0.38f) / 0.62f)
      tv.scaleX = s; tv.scaleY = s
    }
    a.addListener(object : AnimatorListenerAdapter() {
      override fun onAnimationEnd(animation: Animator) {
        tv.animate().alpha(0f).setDuration(110).withEndAction {
          removeView(tv)
          oneDone(null)
        }.start()
      }
    })
    a.start()
  }

  // ─── fechar (animação reversa) ──────────────────────────────────────────
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.keyCode == KeyEvent.KEYCODE_BACK) {
      if (event.action == KeyEvent.ACTION_UP) {
        val s = search
        if (s != null && s.hasFocus() && imeBottom > 0) { hideIme(s); s.clearFocus() } else dismiss("back")
      }
      return true
    }
    return super.dispatchKeyEvent(event)
  }

  fun dismiss(reason: String, animated: Boolean = true) {
    if (dismissing) { if (!animated) finish(reason); return }
    dismissing = true
    removeCallbacks(timeout)
    search?.let { hideIme(it) }
    isClickable = false
    if (!animated || !isAttachedToWindow) { finish(reason, fade = false); return }
    lastReason = reason
    val dest = sourceRectProvider?.invoke() ?: src
    bar?.animate()?.alpha(0f)?.scaleX(0.8f)?.scaleY(0.8f)?.setDuration(170)?.start()
    menu?.animate()?.alpha(0f)?.scaleX(0.85f)?.scaleY(0.85f)?.setDuration(170)?.start()
    panel?.animate()?.alpha(0f)?.scaleX(0.92f)?.scaleY(0.92f)?.setDuration(170)?.start()
    dimView.animate().alpha(0f).setDuration(260).start()
    pending++
    animateBlur(0f, 260)
    val tx = dest.centerX() - src.width() / 2f
    val ty = dest.centerY() - src.height() / 2f
    if (reduce) {
      bubble.animate().x(tx).y(ty).scaleX(1f).scaleY(1f).setDuration(180).withEndAction { oneDone(reason) }.start()
      return
    }
    var left = 4
    val done = { left--; if (left == 0) oneDone(reason) }
    springTo(bubble, DynamicAnimation.X, tx, 420f, 0.86f) { done() }
    springTo(bubble, DynamicAnimation.Y, ty, 420f, 0.86f) { done() }
    springTo(bubble, DynamicAnimation.SCALE_X, 1f, 500f, 0.86f) { done() }
    springTo(bubble, DynamicAnimation.SCALE_Y, 1f, 500f, 0.86f) { done() }
    // trava: spring que não termina (view desanexada) não prende o overlay
    postDelayed({ if (!finished) finish(lastReason) }, 1500)
  }

  private fun oneDone(reason: String?) {
    if (reason != null) lastReason = reason
    pending--
    if (pending <= 0 && dismissing) finish(lastReason)
  }

  private fun finish(reason: String, fade: Boolean = true) {
    if (finished) return
    finished = true
    removeCallbacks(timeout)
    blurAnim?.cancel()
    setBlur(0f)
    try { onDismissed?.invoke(reason) } catch (_: Throwable) {}
    // [2026-10-22 ctx-blink] paridade iOS 03d8b9bf: a célula já voltou a 100%
    // embaixo (onDismissed) → o balão pousado sai com fade curto por cima em vez
    // de sumir seco (GIF: quadro do snapshot ≠ quadro ao vivo). Sem toques.
    if (fade && !reduce && isAttachedToWindow && reason != "off" && reason != "replaced") {
      passThrough = true
      animate().alpha(0f).setDuration(120).setInterpolator(DecelerateInterpolator())
        .withEndAction { try { (parent as? ViewGroup)?.removeView(this) } catch (_: Throwable) {} }
        .start()
    } else {
      try { (parent as? ViewGroup)?.removeView(this) } catch (_: Throwable) {}
    }
  }

  private var passThrough = false
  override fun dispatchTouchEvent(ev: MotionEvent): Boolean = if (passThrough) false else super.dispatchTouchEvent(ev)

  companion object {
    fun activityOf(ctx: Context?): Activity? {
      var c = ctx
      var n = 0
      while (c != null && n < 12) {
        if (c is Activity) return c
        c = (c as? ContextWrapper)?.baseContext
        n++
      }
      return null
    }
  }
}

/** Pop do chip de reação (MLCellView desenha as reações com esta escala). */
class MLReactPop(private val onValue: (Float) -> Unit) {
  private var anim: SpringAnimation? = null
  fun start() {
    anim?.cancel()
    val h = FloatValueHolder(0.3f)
    val s = SpringAnimation(h)
    s.setSpring(SpringForce(1f).setStiffness(420f).setDampingRatio(0.45f))
    s.setStartVelocity(6f)
    s.setMinimumVisibleChange(DynamicAnimation.MIN_VISIBLE_CHANGE_SCALE)
    s.addUpdateListener { _, v, _ -> onValue(v) }
    s.addEndListener { _, _, _, _ -> onValue(1f) }
    anim = s
    onValue(0.3f)
    s.start()
  }
  fun cancel() { anim?.cancel(); anim = null }
}
