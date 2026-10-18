package expo.modules.chatyyconversationlist

// [2026-10-18 native-apps-grid] Peças do painel "Apps" NATIVO (Android).
// Mesmo desenho do components/apps/AppsSheet.js e do iOS (ios/APCells.swift):
// ladrilho 60 dp arredondado com gradiente monocromático + brilho no topo,
// glifo vetorial de traço (res/drawable/ap_ic_*), badge "99+" em pílula,
// marcador +/− e tremor no modo editar, rótulo 12 sp; cartão da Bia (orb
// radial que "respira" + atalho de voz); cabeçalho de seção; "sem resultados".
// Regra do projeto: try só em forma de statement (nunca try-expressão).

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.animation.LinearInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import java.text.Normalizer

internal data class APItem(val id: String, val title: String, val norm: String, val featured: Boolean)

internal data class APSection(val key: String, val title: String, val norm: String, val items: List<APItem>)

internal object APText {
  private val marks = Regex("\\p{Mn}+")

  /** Sem acento/caixa ("Vídeo" ≈ "video") — igual ao _norm do JS. */
  fun norm(s: String): String {
    var out = s.lowercase()
    try {
      out = marks.replace(Normalizer.normalize(out, Normalizer.Form.NFD), "")
    } catch (_: Throwable) {
    }
    return out
  }

  fun badge(n: Int): String = if (n > 99) "99+" else n.toString()

  fun icon(id: String): Int = when (id) {
    "email" -> R.drawable.ap_ic_email
    "meet" -> R.drawable.ap_ic_meet
    "channels" -> R.drawable.ap_ic_channels
    "communities" -> R.drawable.ap_ic_communities
    "reels" -> R.drawable.ap_ic_reels
    "feed" -> R.drawable.ap_ic_feed
    "live" -> R.drawable.ap_ic_live
    "snapmap" -> R.drawable.ap_ic_snapmap
    "one" -> R.drawable.ap_ic_one
    "calendar" -> R.drawable.ap_ic_calendar
    "contacts" -> R.drawable.ap_ic_contacts
    "files" -> R.drawable.ap_ic_files
    "docs" -> R.drawable.ap_ic_docs
    "notes" -> R.drawable.ap_ic_notes
    "tasks" -> R.drawable.ap_ic_tasks
    "photos" -> R.drawable.ap_ic_photos
    "profile" -> R.drawable.ap_ic_profile
    "wallet" -> R.drawable.ap_ic_wallet
    "notifications" -> R.drawable.ap_ic_notifications
    "backup" -> R.drawable.ap_ic_backup
    "settings" -> R.drawable.ap_ic_settings
    else -> R.drawable.ap_ic_grid
  }

  fun parseSections(list: List<Any?>?): List<APSection> {
    val out = ArrayList<APSection>()
    val seenSec = HashSet<String>()
    list?.forEach { raw ->
      val m = CLVal.map(raw) ?: return@forEach
      val key = CLVal.str(m["key"])
      if (key.isEmpty() || !seenSec.add(key)) return@forEach
      val title = CLVal.str(m["title"])
      val items = ArrayList<APItem>()
      val seen = HashSet<String>()
      CLVal.list(m["items"])?.forEach { r ->
        val d = CLVal.map(r) ?: return@forEach
        val id = CLVal.str(d["id"])
        if (id.isEmpty() || !seen.add(id)) return@forEach
        val t = CLVal.str(d["t"])
        val n = CLVal.str(d["n"])
        items.add(APItem(id, t, norm(if (n.isEmpty()) t else n), CLVal.bool(d["feat"])))
      }
      out.add(APSection(key, title, norm(title), items))
    }
    return out
  }
}

/** Paleta P&B — espelha o AppsSheet.js (preto verdadeiro no escuro). */
internal class APTheme(val dark: Boolean) {
  val bg: Int = if (dark) Color.BLACK else Color.WHITE
  val text: Int = if (dark) Color.parseColor("#F5F5F7") else Color.parseColor("#111111")
  val muted: Int = if (dark) Color.parseColor("#8E8E93") else Color.parseColor("#86868B")
  val fieldBg: Int = if (dark) Color.parseColor("#1C1C1E") else Color.parseColor("#F0F0F2")
  val tileTop: Int = if (dark) Color.parseColor("#2E2E32") else Color.WHITE
  val tileMid: Int = if (dark) Color.parseColor("#1E1E21") else Color.parseColor("#F7F7F9")
  val tileBot: Int = if (dark) Color.parseColor("#141416") else Color.parseColor("#ECEDF0")
  val tileBorder: Int = if (dark) Color.argb(23, 255, 255, 255) else Color.argb(15, 0, 0, 0)
  val gloss: Int = if (dark) Color.argb(18, 255, 255, 255) else Color.argb(178, 255, 255, 255)
  val glyph: Int = if (dark) Color.parseColor("#F5F5F7") else Color.parseColor("#111111")
  val badgeBg: Int = if (dark) Color.WHITE else Color.parseColor("#0B0B0C")
  val badgeFg: Int = if (dark) Color.BLACK else Color.WHITE
  val ring: Int = if (dark) Color.BLACK else Color.WHITE
  val markOff: Int = if (dark) Color.parseColor("#3A3A3E") else Color.parseColor("#D9DADF")
  val markOffFg: Int = if (dark) Color.WHITE else Color.parseColor("#111111")
  val cardBg: Int = if (dark) Color.parseColor("#141416") else Color.parseColor("#0E0E10")
}

internal fun apDp(v: View, dp: Float): Int = Math.round(dp * v.resources.displayMetrics.density)

/** Ladrilho de um app (grade, fixados ou faixa Recentes). */
@SuppressLint("ViewConstructor")
internal class APTileView(ctx: Context) : FrameLayout(ctx) {
  val inner = FrameLayout(ctx)
  private val iconWrap = FrameLayout(ctx)
  private val iconBox = FrameLayout(ctx)
  private val gloss = View(ctx)
  private val glyph = ImageView(ctx)
  private val badge = TextView(ctx)
  private val mark = FrameLayout(ctx)
  private val markGlyph = ImageView(ctx)
  private val label = TextView(ctx)
  private var jiggle: ObjectAnimator? = null
  var appId = ""
    private set

  init {
    clipChildren = false
    clipToPadding = false
    inner.clipChildren = false
    inner.clipToPadding = false
    iconWrap.clipChildren = false
    iconWrap.clipToPadding = false
    addView(inner, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

    iconBox.addView(gloss, LayoutParams(LayoutParams.MATCH_PARENT, apDp(this, 33f), Gravity.TOP).apply {
      leftMargin = 1; rightMargin = 1; topMargin = 1
    })
    glyph.scaleType = ImageView.ScaleType.FIT_CENTER
    iconBox.addView(glyph, LayoutParams(apDp(this, 26f), apDp(this, 26f), Gravity.CENTER))
    iconWrap.addView(iconBox, LayoutParams(apDp(this, 60f), apDp(this, 60f)))

    badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    badge.typeface = Typeface.create("sans-serif", Typeface.BOLD)
    badge.gravity = Gravity.CENTER
    badge.includeFontPadding = false
    badge.maxLines = 1
    badge.minWidth = apDp(this, 22f)
    badge.setPadding(apDp(this, 6f), 0, apDp(this, 6f), 0)
    iconWrap.addView(badge, LayoutParams(LayoutParams.WRAP_CONTENT, apDp(this, 22f), Gravity.TOP or Gravity.END).apply {
      topMargin = -apDp(this@APTileView, 6f)
      rightMargin = -apDp(this@APTileView, 9f)
    })

    markGlyph.scaleType = ImageView.ScaleType.FIT_CENTER
    mark.addView(markGlyph, LayoutParams(apDp(this, 12f), apDp(this, 12f), Gravity.CENTER))
    iconWrap.addView(mark, LayoutParams(apDp(this, 24f), apDp(this, 24f), Gravity.TOP or Gravity.START).apply {
      topMargin = -apDp(this@APTileView, 7f)
      leftMargin = -apDp(this@APTileView, 7f)
    })
    inner.addView(iconWrap, LayoutParams(apDp(this, 60f), apDp(this, 60f), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply {
      topMargin = apDp(this@APTileView, 8f)
    })

    label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    label.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    label.gravity = Gravity.CENTER_HORIZONTAL
    label.ellipsize = TextUtils.TruncateAt.END
    label.includeFontPadding = false
    label.setLineSpacing(apDp(this, 2f).toFloat(), 1f)
    inner.addView(label, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.TOP).apply {
      topMargin = apDp(this@APTileView, 8f + 60f + 7f)
      leftMargin = apDp(this@APTileView, 2f)
      rightMargin = apDp(this@APTileView, 2f)
    })
    isClickable = true
    isFocusable = true
    isHapticFeedbackEnabled = true
  }

  fun bind(item: APItem, theme: APTheme, badgeCount: Int, editing: Boolean, pinned: Boolean,
           singleLine: Boolean, seed: Int, labels: Map<String, String>, reduceMotion: Boolean) {
    appId = item.id
    val r = apDp(this, 18f).toFloat()
    val fill = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(theme.tileTop, theme.tileMid, theme.tileBot))
    fill.cornerRadius = r
    fill.setStroke(1, theme.tileBorder)
    iconBox.background = fill
    iconBox.elevation = if (theme.dark) 0f else apDp(this, 2f).toFloat()
    val gl = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(theme.gloss, Color.TRANSPARENT))
    gl.cornerRadii = floatArrayOf(r - 1f, r - 1f, r - 1f, r - 1f, 0f, 0f, 0f, 0f)
    gloss.background = gl
    glyph.setImageResource(APText.icon(item.id))
    glyph.setColorFilter(theme.glyph, PorterDuff.Mode.SRC_IN)

    val showBadge = badgeCount > 0 && !editing
    badge.visibility = if (showBadge) View.VISIBLE else View.GONE
    if (showBadge) {
      val bg = GradientDrawable()
      bg.cornerRadius = apDp(this, 11f).toFloat()
      bg.setColor(theme.badgeBg)
      bg.setStroke(apDp(this, 2f), theme.ring)
      badge.background = bg
      badge.setTextColor(theme.badgeFg)
      badge.text = APText.badge(badgeCount)
    }

    mark.visibility = if (editing) View.VISIBLE else View.GONE
    if (editing) {
      val mb = GradientDrawable()
      mb.shape = GradientDrawable.OVAL
      mb.setColor(if (pinned) theme.badgeBg else theme.markOff)
      mb.setStroke(apDp(this, 2f), theme.ring)
      mark.background = mb
      markGlyph.setImageResource(if (pinned) R.drawable.ap_ic_minus else R.drawable.ap_ic_plus)
      markGlyph.setColorFilter(if (pinned) theme.badgeFg else theme.markOffFg, PorterDuff.Mode.SRC_IN)
    }

    label.setTextColor(theme.text)
    label.maxLines = if (singleLine) 1 else 2
    label.text = item.title

    var a11y = item.title
    if (showBadge) {
      val tpl = labels["badgeNew"] ?: ""
      a11y += ", " + (if (tpl.isEmpty()) APText.badge(badgeCount) else tpl.replace("{count}", APText.badge(badgeCount)))
    }
    if (editing) {
      val l = if (pinned) (labels["unpin"] ?: "") else (labels["pin"] ?: "")
      if (l.isNotEmpty()) a11y += ", $l"
    }
    contentDescription = a11y
    setJiggle(editing && !reduceMotion, seed)
  }

  private fun setJiggle(on: Boolean, seed: Int) {
    if (on) {
      if (jiggle != null) return
      val a = ObjectAnimator.ofFloat(iconWrap, "rotation", -1.6f, 1.6f)
      a.duration = 130L + (seed % 3) * 10L
      a.repeatCount = ValueAnimator.INFINITE
      a.repeatMode = ValueAnimator.REVERSE
      a.interpolator = LinearInterpolator()
      a.startDelay = (seed % 5) * 25L
      jiggle = a
      a.start()
    } else {
      stopJiggle()
    }
  }

  fun stopJiggle() {
    val a = jiggle ?: return
    jiggle = null
    a.cancel()
    iconWrap.rotation = 0f
  }

  fun setLifted(on: Boolean) {
    inner.animate().cancel()
    inner.animate().scaleX(if (on) 1.12f else 1f).scaleY(if (on) 1.12f else 1f).alpha(if (on) 0.92f else 1f)
      .setDuration(180).start()
  }

  fun resetAnim() {
    inner.animate().cancel()
    inner.scaleX = 1f
    inner.scaleY = 1f
    inner.alpha = 1f
    inner.translationY = 0f
    stopJiggle()
  }

  override fun setPressed(pressed: Boolean) {
    val was = isPressed
    super.setPressed(pressed)
    if (was == pressed) return
    if (pressed) {
      inner.animate().scaleX(0.88f).scaleY(0.88f).setDuration(110).setInterpolator(android.view.animation.DecelerateInterpolator()).start()
    } else {
      inner.animate().scaleX(1f).scaleY(1f).setDuration(320)
        .setInterpolator(android.view.animation.OvershootInterpolator(2.2f)).start()
    }
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    stopJiggle()
  }
}

/** Orb da Bia: gradiente radial P&B que "respira". */
internal class APOrbView(ctx: Context) : View(ctx) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val halo = Paint(Paint.ANTI_ALIAS_FLAG)
  private var anim: ValueAnimator? = null
  private var phase = 0f
  var reduceMotion = false

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    val cx = w / 2f
    val cy = h / 2f
    val base = Math.min(w, h) / 2f
    val s = 0.94f + 0.10f * phase
    halo.shader = RadialGradient(cx, cy, base, intArrayOf(Color.argb((40 + 50 * phase).toInt(), 255, 255, 255), Color.TRANSPARENT),
      null, Shader.TileMode.CLAMP)
    canvas.drawCircle(cx, cy, base, halo)
    val r = (base - 3f * resources.displayMetrics.density) * s
    paint.shader = RadialGradient(cx - r * 0.3f, cy - r * 0.38f, r * 1.7f,
      intArrayOf(Color.WHITE, Color.parseColor("#B8B8BE"), Color.parseColor("#4A4A50"), Color.parseColor("#1C1C1F")),
      floatArrayOf(0f, 0.3f, 0.7f, 1f), Shader.TileMode.CLAMP)
    canvas.drawCircle(cx, cy, r, paint)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (reduceMotion || anim != null) return
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 2200
    a.repeatCount = ValueAnimator.INFINITE
    a.repeatMode = ValueAnimator.REVERSE
    a.addUpdateListener { v ->
      phase = v.animatedValue as Float
      invalidate()
    }
    anim = a
    a.start()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    anim?.cancel()
    anim = null
  }
}

/** Cartão da Bia (escuro nos 2 temas) + atalho de voz. */
@SuppressLint("ViewConstructor")
internal class APBiaView(ctx: Context) : FrameLayout(ctx) {
  private val card = FrameLayout(ctx)
  val orb = APOrbView(ctx)
  private val title = TextView(ctx)
  private val aiPill = TextView(ctx)
  private val sub = TextView(ctx)
  val voice = FrameLayout(ctx)
  private val voiceGlyph = ImageView(ctx)

  init {
    clipChildren = false
    addView(card, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    card.addView(orb, LayoutParams(apDp(this, 50f), apDp(this, 50f), Gravity.CENTER_VERTICAL or Gravity.START).apply {
      leftMargin = apDp(this@APBiaView, 14f)
    })
    val col = LinearLayout(ctx)
    col.orientation = LinearLayout.VERTICAL
    val row = LinearLayout(ctx)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    title.text = "Bia"
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
    title.typeface = Typeface.create("sans-serif", Typeface.BOLD)
    title.setTextColor(Color.WHITE)
    title.includeFontPadding = false
    row.addView(title, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    aiPill.setTextSize(TypedValue.COMPLEX_UNIT_SP, 9.5f)
    aiPill.typeface = Typeface.create("sans-serif", Typeface.BOLD)
    aiPill.setTextColor(Color.argb(217, 255, 255, 255))
    aiPill.letterSpacing = 0.06f
    aiPill.includeFontPadding = false
    aiPill.setPadding(apDp(this, 6f), apDp(this, 2f), apDp(this, 6f), apDp(this, 2f))
    val pillBg = GradientDrawable()
    pillBg.cornerRadius = apDp(this, 6f).toFloat()
    pillBg.setColor(Color.argb(36, 255, 255, 255))
    aiPill.background = pillBg
    row.addView(aiPill, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
      leftMargin = apDp(this@APBiaView, 7f)
    })
    col.addView(row)
    sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
    sub.maxLines = 1
    sub.ellipsize = TextUtils.TruncateAt.END
    sub.includeFontPadding = false
    col.addView(sub, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
      topMargin = apDp(this@APBiaView, 4f)
    })
    card.addView(col, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER_VERTICAL).apply {
      leftMargin = apDp(this@APBiaView, 14f + 50f + 14f)
      rightMargin = apDp(this@APBiaView, 14f + 38f + 14f)
    })
    val vb = GradientDrawable()
    vb.shape = GradientDrawable.OVAL
    vb.setColor(Color.WHITE)
    voice.background = vb
    voiceGlyph.setImageResource(R.drawable.ap_ic_wave)
    voiceGlyph.setColorFilter(Color.BLACK, PorterDuff.Mode.SRC_IN)
    voice.addView(voiceGlyph, LayoutParams(apDp(this, 18f), apDp(this, 18f), Gravity.CENTER))
    voice.isClickable = true
    voice.isFocusable = true
    card.addView(voice, LayoutParams(apDp(this, 38f), apDp(this, 38f), Gravity.CENTER_VERTICAL or Gravity.END).apply {
      rightMargin = apDp(this@APBiaView, 14f)
    })
    isClickable = true
    isFocusable = true
  }

  fun bind(theme: APTheme, labels: Map<String, String>, reduceMotion: Boolean) {
    val bg = GradientDrawable()
    bg.cornerRadius = apDp(this, 24f).toFloat()
    bg.setColor(theme.cardBg)
    if (theme.dark) bg.setStroke(1, Color.argb(26, 255, 255, 255))
    card.background = bg
    card.elevation = if (theme.dark) 0f else apDp(this, 4f).toFloat()
    orb.reduceMotion = reduceMotion
    aiPill.text = labels["aiBadge"] ?: "IA"
    val hello = labels["biaHello"] ?: ""
    val tip = labels["biaTip"] ?: ""
    val sb = SpannableStringBuilder()
    if (hello.isNotEmpty()) {
      sb.append(hello)
      sb.setSpan(ForegroundColorSpan(Color.argb(235, 255, 255, 255)), 0, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      sb.setSpan(StyleSpan(Typeface.BOLD), 0, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    if (tip.isNotEmpty()) {
      val start = sb.length
      sb.append(if (hello.isEmpty()) tip else " · $tip")
      sb.setSpan(ForegroundColorSpan(Color.argb(158, 255, 255, 255)), start, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    sub.text = sb
    contentDescription = "Bia, $hello, $tip"
    voice.contentDescription = labels["voice"] ?: ""
  }

  override fun setPressed(pressed: Boolean) {
    val was = isPressed
    super.setPressed(pressed)
    if (was == pressed) return
    animate().scaleX(if (pressed) 0.975f else 1f).scaleY(if (pressed) 0.975f else 1f)
      .setDuration(if (pressed) 110L else 260L).start()
  }
}

/** Cabeçalho de seção (CAIXA ALTA, cinza). */
internal class APHeaderView(ctx: Context) : TextView(ctx) {
  init {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    letterSpacing = 0.075f
    includeFontPadding = false
    gravity = Gravity.TOP or Gravity.START
    setPadding(apDp(this, 6f), apDp(this, 2f), apDp(this, 6f), 0)
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
    isFocusable = false
  }

  fun bind(title: String, theme: APTheme) {
    setTextColor(theme.muted)
    text = title.uppercase()
    contentDescription = title
  }
}

/** "Nenhum app encontrado". */
internal class APEmptyView(ctx: Context) : LinearLayout(ctx) {
  private val circle = FrameLayout(ctx)
  private val icon = ImageView(ctx)
  private val label = TextView(ctx)

  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    setPadding(apDp(this, 16f), apDp(this, 36f), apDp(this, 16f), 0)
    icon.setImageResource(R.drawable.ap_ic_search)
    circle.addView(icon, FrameLayout.LayoutParams(apDp(this, 26f), apDp(this, 26f), Gravity.CENTER))
    addView(circle, LayoutParams(apDp(this, 60f), apDp(this, 60f)))
    label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    label.gravity = Gravity.CENTER_HORIZONTAL
    label.maxLines = 2
    addView(label, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
      topMargin = apDp(this@APEmptyView, 12f)
    })
  }

  fun bind(theme: APTheme, text: String) {
    val bg = GradientDrawable()
    bg.shape = GradientDrawable.OVAL
    bg.setColor(theme.fieldBg)
    circle.background = bg
    icon.setColorFilter(theme.muted, PorterDuff.Mode.SRC_IN)
    label.setTextColor(theme.muted)
    label.text = text
  }
}

/** RecyclerView que avisa "puxou p/ baixo no topo e soltou" (fechar a folha). */
internal class APRecycler(ctx: Context) : RecyclerView(ctx) {
  var onPullDismiss: (() -> Unit)? = null
  /** true enquanto um fixado é arrastado (não fechar a folha). */
  var blocked = false
  private var downY = 0f
  private var atTopOnDown = false
  private var maxPull = 0f

  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downY = ev.rawY
        atTopOnDown = !canScrollVertically(-1)
        maxPull = 0f
      }
      MotionEvent.ACTION_MOVE -> {
        if (atTopOnDown) {
          if (canScrollVertically(-1)) atTopOnDown = false
          else maxPull = Math.max(maxPull, ev.rawY - downY)
        }
      }
      MotionEvent.ACTION_UP -> {
        val d = resources.displayMetrics.density
        if (atTopOnDown && !blocked && !canScrollVertically(-1) && maxPull > 96f * d && ev.rawY - downY > 72f * d) {
          atTopOnDown = false
          val cb = onPullDismiss
          if (cb != null) post { cb() }
        }
      }
      MotionEvent.ACTION_CANCEL -> atTopOnDown = false
    }
    return super.dispatchTouchEvent(ev)
  }
}
