package expo.modules.chatyyconversationlist

// [2026-10-18 chat-info-native] Peças da tela "Dados do contato/grupo"
// (Android). Mesmo visual do iOS (ios/CICells.swift): hero (foto 112 dp,
// nome 22 semibold, subtítulo, ações em ladrilhos), linhas de cartão com
// ladrilho de ícone 30 dp, faixa horizontal de miniaturas, membros com
// pílula "Admin", busca de membros. Cartão = fundo arredondado 14 dp nos
// cantos da 1ª/última linha (RippleDrawable).

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Build
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Switch
import android.widget.TextView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.model.GlideUrl
import com.bumptech.glide.load.model.LazyHeaders
import java.io.File
import kotlin.math.max

internal object CICard {
  /** Fundo de cartão por posição (cantos 14 dp só na 1ª/última linha) + ripple. */
  fun apply(v: View, p: STPalette, first: Boolean, last: Boolean, pressable: Boolean) {
    val d = v.resources.displayMetrics.density
    val rad = 14f * d
    val tl = if (first) rad else 0f
    val bl = if (last) rad else 0f
    val radii = floatArrayOf(tl, tl, tl, tl, bl, bl, bl, bl)
    val content = GradientDrawable()
    content.cornerRadii = radii
    content.setColor(p.cardBg)
    val mask = GradientDrawable()
    mask.cornerRadii = radii
    mask.setColor(Color.WHITE)
    val ripple = ColorStateList.valueOf(if (pressable) p.ripple else Color.TRANSPARENT)
    v.background = RippleDrawable(ripple, content, mask)
  }

  /** Modelo do Glide p/ uma URL (mesmas regras do CLAvatarView). */
  fun glideModel(url: String, auth: Boolean): Any? {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      val tok = CLAuth.token
      if (auth && tok.isNotEmpty()) {
        return GlideUrl(url, LazyHeaders.Builder().addHeader("Authorization", "Bearer $tok").build())
      }
      return url
    }
    if (url.startsWith("file://") || url.startsWith("content://")) return Uri.parse(url)
    if (url.startsWith("/")) return File(url)
    if (url.startsWith("data:")) return url
    return null
  }
}

private fun Context.ciPx(v: Float): Int = (v * resources.displayMetrics.density + 0.5f).toInt()

private fun ciText(ctx: Context, sizeSp: Float, weight: Int): TextView {
  val tv = TextView(ctx)
  tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
  tv.typeface = CLType.weight(weight)
  tv.includeFontPadding = false
  return tv
}

// ─── Linha ─────────────────────────────────────────────────────────────────

@SuppressLint("ViewConstructor", "UseSwitchCompatOrMaterialCode")
internal class CIRowView(ctx: Context) : LinearLayout(ctx) {
  interface Listener {
    fun onPress(id: String)
    fun onToggle(id: String, value: Boolean)
  }

  var listener: Listener? = null

  private val chip = FrameLayout(ctx)
  private val chipBg = GradientDrawable()
  private val glyph = ImageView(ctx)
  private val textCol = LinearLayout(ctx)
  private val titleTv = ciText(ctx, 16f, 400)
  private val subTv = ciText(ctx, 13f, 400)
  private val valueTv = ciText(ctx, 15f, 400)
  private val chevron = ImageView(ctx)
  private val toggle = Switch(ctx)
  private val hairPaint = Paint()

  private var row = CIRow()
  private var palette = STPalette.defaults(false)
  private var hasIcon = false
  private var showSeparator = false
  private var isToggle = false
  private var binding = false

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = ctx.ciPx(52f)
    setPadding(ctx.ciPx(16f), ctx.ciPx(10f), ctx.ciPx(16f), ctx.ciPx(10f))
    setWillNotDraw(false)
    isFocusable = true

    chipBg.cornerRadius = 7f * resources.displayMetrics.density
    chip.background = chipBg
    glyph.scaleType = ImageView.ScaleType.FIT_CENTER
    chip.addView(glyph, FrameLayout.LayoutParams(ctx.ciPx(17f), ctx.ciPx(17f), Gravity.CENTER))
    addView(chip, LayoutParams(ctx.ciPx(30f), ctx.ciPx(30f)).apply { marginEnd = ctx.ciPx(14f) })

    textCol.orientation = VERTICAL
    titleTv.maxLines = 1
    titleTv.ellipsize = TextUtils.TruncateAt.END
    titleTv.letterSpacing = -0.25f / 16f
    subTv.maxLines = 2
    subTv.ellipsize = TextUtils.TruncateAt.END
    textCol.addView(titleTv, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    textCol.addView(subTv, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = ctx.ciPx(2f) })
    addView(textCol, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))

    valueTv.maxLines = 1
    valueTv.ellipsize = TextUtils.TruncateAt.END
    valueTv.maxWidth = ctx.ciPx(150f)
    addView(valueTv, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginStart = ctx.ciPx(8f) })

    chevron.scaleType = ImageView.ScaleType.FIT_CENTER
    chevron.setImageResource(R.drawable.cst_ic_chevron)
    addView(chevron, LayoutParams(ctx.ciPx(17f), ctx.ciPx(17f)).apply { marginStart = ctx.ciPx(6f) })

    toggle.showText = false
    toggle.setOnCheckedChangeListener { v, checked ->
      if (binding) return@setOnCheckedChangeListener
      val c = if (Build.VERSION.SDK_INT >= 34) {
        if (checked) HapticFeedbackConstants.TOGGLE_ON else HapticFeedbackConstants.TOGGLE_OFF
      } else HapticFeedbackConstants.VIRTUAL_KEY
      v.performHapticFeedback(c)
      tintSwitch()
      listener?.onToggle(row.id, checked)
    }
    addView(toggle, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginStart = ctx.ciPx(10f) })

    hairPaint.strokeWidth = max(1f, resources.displayMetrics.density * 0.5f)
    setOnClickListener {
      if (row.disabled) return@setOnClickListener
      if (isToggle) toggle.toggle() else listener?.onPress(row.id)
    }
  }

  private fun tintSwitch() {
    val p = palette
    val states = arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf())
    toggle.trackTintList = ColorStateList(states, intArrayOf(p.switchOnTrack, p.switchOffTrack))
    toggle.thumbTintList = ColorStateList(states, intArrayOf(p.switchOnThumb, p.switchOffThumb))
    if (Build.VERSION.SDK_INT >= 29) toggle.trackTintMode = android.graphics.PorterDuff.Mode.SRC_IN
    toggle.refreshDrawableState()
  }

  fun bind(r: CIRow, p: STPalette, first: Boolean, last: Boolean) {
    binding = true
    row = r
    palette = p
    isToggle = r.kind == "t"
    showSeparator = !last
    CICard.apply(this, p, first, last, !isToggle && !r.disabled)

    val res = CIText.drawable(r.icon)
    hasIcon = res != 0
    chip.visibility = if (hasIcon) VISIBLE else GONE
    if (hasIcon) {
      chipBg.setColor(if (r.destructive) Color.TRANSPARENT else p.chipBg)
      glyph.setImageDrawable(tintedIcon(context, res, if (r.destructive) p.destructive else p.chipFg))
    }
    titleTv.text = r.title
    titleTv.setTextColor(if (r.destructive) p.destructive else p.text)
    subTv.text = r.sub
    subTv.setTextColor(p.secondary)
    subTv.visibility = if (r.sub.isEmpty()) GONE else VISIBLE
    valueTv.text = r.value
    valueTv.setTextColor(p.secondary)
    valueTv.visibility = if (r.value.isEmpty() || isToggle) GONE else VISIBLE
    val showChevron = r.kind == "c" && !r.destructive
    chevron.visibility = if (showChevron) VISIBLE else GONE
    if (showChevron) chevron.setColorFilter(p.tertiary)
    toggle.visibility = if (isToggle) VISIBLE else GONE
    if (isToggle) {
      tintSwitch()
      toggle.isEnabled = !r.disabled
      if (toggle.isChecked != r.on) toggle.isChecked = r.on
    }
    textCol.alpha = if (r.disabled) 0.45f else 1f
    hairPaint.color = p.separator
    val parts = ArrayList<String>()
    parts.add(r.title)
    if (r.value.isNotEmpty()) parts.add(r.value)
    if (r.sub.isNotEmpty()) parts.add(r.sub)
    contentDescription = parts.joinToString(", ")
    binding = false
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (showSeparator) {
      val inset = if (hasIcon) context.ciPx(60f) else context.ciPx(16f)
      val y = height - hairPaint.strokeWidth / 2f
      canvas.drawLine(inset.toFloat(), y, width.toFloat(), y, hairPaint)
    }
  }
}

// ─── Hero ──────────────────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class CIHeroView(ctx: Context) : LinearLayout(ctx) {
  var onAvatar: (() -> Unit)? = null
  var onAction: ((String) -> Unit)? = null

  private val avatarFrame = FrameLayout(ctx)
  private val avatar = CLAvatarView(ctx)
  private val badge = FrameLayout(ctx)
  private val badgeBg = GradientDrawable()
  private val badgeIcon = ImageView(ctx)
  private val badgeSpin = ProgressBar(ctx)
  private val titleTv = ciText(ctx, 22f, 600)
  private val subTv = ciText(ctx, 15f, 400)
  private val actionsRow = LinearLayout(ctx)
  private val tiles = ArrayList<LinearLayout>()
  private var keys: List<String> = emptyList()

  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    val box = ctx.ciPx(112f)
    avatar.setBoxDp(112f)
    avatarFrame.addView(avatar, FrameLayout.LayoutParams(box, box))
    badgeBg.shape = GradientDrawable.OVAL
    badge.background = badgeBg
    badge.addView(badgeIcon, FrameLayout.LayoutParams(ctx.ciPx(16f), ctx.ciPx(16f), Gravity.CENTER))
    badge.addView(badgeSpin, FrameLayout.LayoutParams(ctx.ciPx(16f), ctx.ciPx(16f), Gravity.CENTER))
    badgeSpin.isIndeterminate = true
    avatarFrame.addView(badge, FrameLayout.LayoutParams(ctx.ciPx(34f), ctx.ciPx(34f), Gravity.END or Gravity.BOTTOM))
    avatarFrame.setOnClickListener { onAvatar?.invoke() }
    avatarFrame.isClickable = true
    avatarFrame.isFocusable = true
    addView(avatarFrame, LayoutParams(box, box).apply { topMargin = ctx.ciPx(4f) })

    titleTv.gravity = Gravity.CENTER_HORIZONTAL
    titleTv.maxLines = 2
    titleTv.ellipsize = TextUtils.TruncateAt.END
    addView(titleTv, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
      topMargin = ctx.ciPx(14f)
      leftMargin = ctx.ciPx(8f)
      rightMargin = ctx.ciPx(8f)
    })
    subTv.gravity = Gravity.CENTER_HORIZONTAL
    subTv.maxLines = 2
    subTv.ellipsize = TextUtils.TruncateAt.END
    addView(subTv, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
      topMargin = ctx.ciPx(4f)
      leftMargin = ctx.ciPx(8f)
      rightMargin = ctx.ciPx(8f)
    })
    actionsRow.orientation = HORIZONTAL
    addView(actionsRow, LayoutParams(LayoutParams.MATCH_PARENT, ctx.ciPx(64f)).apply {
      topMargin = ctx.ciPx(20f)
      bottomMargin = ctx.ciPx(4f)
    })
  }

  private fun makeTile(): LinearLayout {
    val ctx = context
    val t = LinearLayout(ctx)
    t.orientation = VERTICAL
    t.gravity = Gravity.CENTER
    val icon = ImageView(ctx)
    icon.scaleType = ImageView.ScaleType.FIT_CENTER
    t.addView(icon, LayoutParams(ctx.ciPx(22f), ctx.ciPx(22f)))
    val label = ciText(ctx, 12f, 500)
    label.maxLines = 1
    label.ellipsize = TextUtils.TruncateAt.END
    label.gravity = Gravity.CENTER_HORIZONTAL
    t.addView(label, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
      topMargin = ctx.ciPx(5f)
      leftMargin = ctx.ciPx(4f)
      rightMargin = ctx.ciPx(4f)
    })
    t.isClickable = true
    t.isFocusable = true
    return t
  }

  fun bind(h: CIHero, p: STPalette, avatarLabel: String) {
    avatar.bind(CLRow(id = "hero", kind = "direct", title = h.title, tiles = listOf(h.pic.tile())), CLTheme(p.dark), p.pageBg)
    avatarFrame.contentDescription = avatarLabel
    titleTv.text = h.title
    titleTv.setTextColor(p.text)
    subTv.text = h.sub
    subTv.setTextColor(p.secondary)
    subTv.visibility = if (h.sub.isEmpty()) GONE else VISIBLE

    val showBadge = h.badge == "camera" || h.busy
    badge.visibility = if (showBadge) VISIBLE else GONE
    badgeBg.setColor(p.text)
    badgeBg.setStroke(context.ciPx(3f), p.pageBg)
    badgeIcon.visibility = if (h.busy) GONE else VISIBLE
    badgeSpin.visibility = if (h.busy) VISIBLE else GONE
    badgeIcon.setImageDrawable(tintedIcon(context, R.drawable.ccl_ic_camera, p.pageBg))
    badgeSpin.indeterminateTintList = ColorStateList.valueOf(p.pageBg)

    while (tiles.size < h.actions.size) {
      val t = makeTile()
      tiles.add(t)
      actionsRow.addView(t, LayoutParams(0, LayoutParams.MATCH_PARENT, 1f).apply {
        leftMargin = context.ciPx(4f)
        rightMargin = context.ciPx(4f)
      })
    }
    while (tiles.size > h.actions.size) {
      val t = tiles.removeAt(tiles.size - 1)
      actionsRow.removeView(t)
    }
    keys = h.actions.map { it.key }
    h.actions.forEachIndexed { i, a ->
      val t = tiles[i]
      val content = GradientDrawable()
      content.cornerRadius = 12f * resources.displayMetrics.density
      content.setColor(p.cardBg)
      val mask = GradientDrawable()
      mask.cornerRadius = 12f * resources.displayMetrics.density
      mask.setColor(Color.WHITE)
      t.background = RippleDrawable(ColorStateList.valueOf(p.ripple), content, mask)
      val icon = t.getChildAt(0) as? ImageView
      val label = t.getChildAt(1) as? TextView
      icon?.setImageDrawable(tintedIcon(context, CIText.drawable(a.icon), p.text))
      label?.text = a.label
      label?.setTextColor(p.text)
      label?.typeface = CLType.weight(if (a.active) 600 else 500)
      t.contentDescription = a.label
      val key = a.key
      t.setOnClickListener { v ->
        v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        onAction?.invoke(key)
      }
    }
    actionsRow.visibility = if (h.actions.isEmpty()) GONE else VISIBLE
  }
}

// ─── Recado / descrição ────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class CIAboutView(ctx: Context) : LinearLayout(ctx) {
  private val textTv = ciText(ctx, 16f, 400)
  private val subTv = ciText(ctx, 13f, 400)
  var onPress: (() -> Unit)? = null
  private var disabled = false

  init {
    orientation = VERTICAL
    setPadding(ctx.ciPx(16f), ctx.ciPx(12f), ctx.ciPx(16f), ctx.ciPx(12f))
    textTv.setLineSpacing(0f, 1.15f)
    subTv.maxLines = 2
    subTv.ellipsize = TextUtils.TruncateAt.END
    addView(textTv, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(subTv, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = ctx.ciPx(4f) })
    setOnClickListener { if (!disabled) onPress?.invoke() }
  }

  fun bind(r: CIRow, p: STPalette, first: Boolean, last: Boolean) {
    disabled = r.disabled
    CICard.apply(this, p, first, last, !r.disabled)
    val placeholder = r.title.isEmpty()
    textTv.text = if (placeholder) r.value else r.title
    textTv.setTextColor(if (placeholder) p.secondary else p.text)
    subTv.text = r.sub
    subTv.setTextColor(p.secondary)
    subTv.visibility = if (r.sub.isEmpty()) GONE else VISIBLE
    contentDescription = listOf(textTv.text.toString(), r.sub).filter { it.isNotEmpty() }.joinToString(", ")
  }
}

// ─── Mídia ─────────────────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class CIMediaView(ctx: Context) : LinearLayout(ctx) {
  var onSeeAll: (() -> Unit)? = null
  var onItem: ((String) -> Unit)? = null

  private val header = LinearLayout(ctx)
  private val titleTv = ciText(ctx, 16f, 400)
  private val countTv = ciText(ctx, 15f, 400)
  private val chevron = ImageView(ctx)
  private val scroller = HorizontalScrollView(ctx)
  private val strip = LinearLayout(ctx)
  private val thumbs = ArrayList<FrameLayout>()
  private val thumbKeys = ArrayList<String>()
  private val thumbUrls = ArrayList<String>()

  init {
    orientation = VERTICAL
    header.orientation = HORIZONTAL
    header.gravity = Gravity.CENTER_VERTICAL
    header.setPadding(ctx.ciPx(16f), 0, ctx.ciPx(16f), 0)
    titleTv.maxLines = 1
    titleTv.ellipsize = TextUtils.TruncateAt.END
    header.addView(titleTv, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    countTv.maxLines = 1
    header.addView(countTv, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginStart = ctx.ciPx(8f) })
    chevron.scaleType = ImageView.ScaleType.FIT_CENTER
    chevron.setImageResource(R.drawable.cst_ic_chevron)
    header.addView(chevron, LayoutParams(ctx.ciPx(17f), ctx.ciPx(17f)).apply { marginStart = ctx.ciPx(6f) })
    header.isClickable = true
    header.isFocusable = true
    header.setOnClickListener { onSeeAll?.invoke() }
    addView(header, LayoutParams(LayoutParams.MATCH_PARENT, ctx.ciPx(50f)))

    scroller.isHorizontalScrollBarEnabled = false
    scroller.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    strip.orientation = HORIZONTAL
    strip.setPadding(ctx.ciPx(16f), 0, ctx.ciPx(10f), 0)
    scroller.addView(strip, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT))
    addView(scroller, LayoutParams(LayoutParams.MATCH_PARENT, ctx.ciPx(80f)).apply { bottomMargin = ctx.ciPx(12f) })
  }

  private fun makeThumb(): FrameLayout {
    val ctx = context
    val f = FrameLayout(ctx)
    val img = ImageView(ctx)
    img.scaleType = ImageView.ScaleType.CENTER_CROP
    f.addView(img, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    val play = ImageView(ctx)
    play.setImageDrawable(tintedIcon(ctx, R.drawable.crl_ic_play, Color.WHITE))
    f.addView(play, FrameLayout.LayoutParams(ctx.ciPx(14f), ctx.ciPx(14f), Gravity.START or Gravity.BOTTOM).apply {
      leftMargin = ctx.ciPx(6f)
      bottomMargin = ctx.ciPx(5f)
    })
    val dur = ciText(ctx, 11f, 600)
    dur.setTextColor(Color.WHITE)
    dur.setShadowLayer(3f, 0f, 0f, 0x80000000.toInt())
    f.addView(dur, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.END or Gravity.BOTTOM).apply {
      rightMargin = ctx.ciPx(6f)
      bottomMargin = ctx.ciPx(4f)
    })
    val r = 8f * resources.displayMetrics.density
    f.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) {
        outline.setRoundRect(0, 0, view.width, view.height, r)
      }
    }
    f.clipToOutline = true
    f.isClickable = true
    f.isFocusable = true
    return f
  }

  fun bind(r: CIRow, items: List<CIMedia>, p: STPalette, first: Boolean, last: Boolean) {
    CICard.apply(this, p, first, last, false)
    val content = GradientDrawable()
    content.setColor(Color.TRANSPARENT)
    val mask = GradientDrawable()
    mask.setColor(Color.WHITE)
    header.background = RippleDrawable(ColorStateList.valueOf(p.ripple), content, mask)
    titleTv.text = r.title
    titleTv.setTextColor(p.text)
    countTv.text = r.value
    countTv.setTextColor(p.secondary)
    countTv.visibility = if (r.value.isEmpty()) GONE else VISIBLE
    chevron.setColorFilter(p.tertiary)
    header.contentDescription = if (r.value.isEmpty()) r.title else "${r.title}, ${r.value}"

    val side = context.ciPx(80f)
    while (thumbs.size < items.size) {
      val t = makeThumb()
      thumbs.add(t)
      thumbKeys.add("")
      thumbUrls.add("")
      strip.addView(t, LayoutParams(side, side).apply { rightMargin = context.ciPx(6f) })
    }
    while (thumbs.size > items.size) {
      val t = thumbs.removeAt(thumbs.size - 1)
      thumbKeys.removeAt(thumbKeys.size - 1)
      thumbUrls.removeAt(thumbUrls.size - 1)
      val img = t.getChildAt(0) as? ImageView
      if (img != null) {
        try { Glide.with(context.applicationContext).clear(img) } catch (_: Throwable) {}
      }
      strip.removeView(t)
    }
    items.forEachIndexed { i, m ->
      val t = thumbs[i]
      thumbKeys[i] = m.key
      t.setBackgroundColor(p.chipBg)
      t.contentDescription = r.title
      val img = t.getChildAt(0) as? ImageView
      val play = t.getChildAt(1)
      val dur = t.getChildAt(2) as? TextView
      play.visibility = if (m.video) VISIBLE else GONE
      dur?.text = m.dur
      dur?.visibility = if (m.video && m.dur.isNotEmpty()) VISIBLE else GONE
      if (img != null && thumbUrls[i] != m.url) {
        thumbUrls[i] = m.url
        val model = CICard.glideModel(m.url, m.auth)
        if (model == null) {
          img.setImageDrawable(null)
        } else {
          try {
            Glide.with(context.applicationContext)
              .load(model)
              .override(side, side)
              .centerCrop()
              .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC)
              .into(img)
          } catch (_: Throwable) {
            img.setImageDrawable(null)
          }
        }
      }
      val key = m.key
      t.setOnClickListener { onItem?.invoke(key) }
    }
    scroller.visibility = if (items.isEmpty()) GONE else VISIBLE
  }
}

// ─── Membro ────────────────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class CIMemberView(ctx: Context) : LinearLayout(ctx) {
  private val avatar = CLAvatarView(ctx)
  private val textCol = LinearLayout(ctx)
  private val titleRow = LinearLayout(ctx)
  private val titleTv = ciText(ctx, 16f, 400)
  private val pill = ciText(ctx, 12f, 500)
  private val pillBg = GradientDrawable()
  private val subTv = ciText(ctx, 14f, 400)
  private val hairPaint = Paint()
  private var showSeparator = false
  var onPress: (() -> Unit)? = null

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = ctx.ciPx(60f)
    setPadding(ctx.ciPx(16f), ctx.ciPx(10f), ctx.ciPx(16f), ctx.ciPx(10f))
    setWillNotDraw(false)
    avatar.setBoxDp(40f)
    addView(avatar, LayoutParams(ctx.ciPx(40f), ctx.ciPx(40f)).apply { marginEnd = ctx.ciPx(12f) })
    textCol.orientation = VERTICAL
    titleRow.orientation = HORIZONTAL
    titleRow.gravity = Gravity.CENTER_VERTICAL
    titleTv.maxLines = 1
    titleTv.ellipsize = TextUtils.TruncateAt.END
    titleRow.addView(titleTv, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    pillBg.cornerRadius = 9f * resources.displayMetrics.density
    pill.background = pillBg
    pill.setPadding(ctx.ciPx(7f), ctx.ciPx(2f), ctx.ciPx(7f), ctx.ciPx(2f))
    pill.maxLines = 1
    titleRow.addView(pill, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginStart = ctx.ciPx(8f) })
    textCol.addView(titleRow, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    subTv.maxLines = 1
    subTv.ellipsize = TextUtils.TruncateAt.END
    textCol.addView(subTv, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = ctx.ciPx(3f) })
    addView(textCol, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    hairPaint.strokeWidth = max(1f, resources.displayMetrics.density * 0.5f)
    isFocusable = true
    setOnClickListener { onPress?.invoke() }
  }

  fun bind(m: CIMember, p: STPalette, first: Boolean, last: Boolean) {
    CICard.apply(this, p, first, last, true)
    showSeparator = !last
    avatar.bind(CLRow(id = m.id, kind = "direct", title = m.title, tiles = listOf(m.pic.tile())), CLTheme(p.dark), p.cardBg)
    titleTv.text = m.title
    titleTv.setTextColor(p.text)
    titleTv.typeface = CLType.weight(if (m.me) 500 else 400)
    pill.text = m.pill
    pill.setTextColor(p.secondary)
    pillBg.setColor(p.chipBg)
    pill.visibility = if (m.pill.isEmpty()) GONE else VISIBLE
    subTv.text = m.sub
    subTv.setTextColor(p.secondary)
    subTv.visibility = if (m.sub.isEmpty()) GONE else VISIBLE
    hairPaint.color = p.separator
    contentDescription = listOf(m.title, m.pill, m.sub).filter { it.isNotEmpty() }.joinToString(", ")
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (showSeparator) {
      val inset = context.ciPx(68f)
      val y = height - hairPaint.strokeWidth / 2f
      canvas.drawLine(inset.toFloat(), y, width.toFloat(), y, hairPaint)
    }
  }
}

// ─── Busca de membros ──────────────────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class CISearchView(ctx: Context) : FrameLayout(ctx) {
  var onChange: ((String) -> Unit)? = null
  val field = EditText(ctx)
  private val fieldBg = GradientDrawable()
  private val hairPaint = Paint()
  private var showSeparator = false
  private var binding = false

  init {
    setPadding(ctx.ciPx(12f), ctx.ciPx(10f), ctx.ciPx(12f), ctx.ciPx(10f))
    setWillNotDraw(false)
    fieldBg.cornerRadius = 10f * resources.displayMetrics.density
    field.background = fieldBg
    field.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    field.setSingleLine(true)
    field.maxLines = 1
    field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    field.imeOptions = EditorInfo.IME_ACTION_SEARCH
    field.setPadding(ctx.ciPx(10f), 0, ctx.ciPx(10f), 0)
    field.compoundDrawablePadding = ctx.ciPx(8f)
    field.gravity = Gravity.CENTER_VERTICAL
    field.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        if (binding) return
        onChange?.invoke(s?.toString() ?: "")
      }
    })
    field.setOnEditorActionListener { v, actionId, _ ->
      if (actionId == EditorInfo.IME_ACTION_SEARCH) {
        val imm = v.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.hideSoftInputFromWindow(v.windowToken, 0)
        true
      } else false
    }
    addView(field, LayoutParams(LayoutParams.MATCH_PARENT, ctx.ciPx(38f)))
    hairPaint.strokeWidth = max(1f, resources.displayMetrics.density * 0.5f)
  }

  fun bind(placeholder: String, text: String, p: STPalette, first: Boolean, last: Boolean) {
    binding = true
    CICard.apply(this, p, first, last, false)
    showSeparator = !last
    fieldBg.setColor(p.chipBg)
    field.setTextColor(p.text)
    field.setHintTextColor(p.secondary)
    field.hint = placeholder
    val icon = tintedIcon(context, R.drawable.cst_ic_search, p.secondary)
    val s = context.ciPx(16f)
    icon?.setBounds(0, 0, s, s)
    field.setCompoundDrawables(icon, null, null, null)
    if (!field.hasFocus() && field.text.toString() != text) field.setText(text)
    hairPaint.color = p.separator
    binding = false
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (showSeparator) {
      val inset = context.ciPx(16f)
      val y = height - hairPaint.strokeWidth / 2f
      canvas.drawLine(inset.toFloat(), y, width.toFloat(), y, hairPaint)
    }
  }
}

// ─── Estado (carregando / vazio) ───────────────────────────────────────────

@SuppressLint("ViewConstructor")
internal class CIStateView(ctx: Context) : FrameLayout(ctx) {
  private val label = ciText(ctx, 15f, 400)
  private val spin = ProgressBar(ctx)

  init {
    minimumHeight = ctx.ciPx(52f)
    label.gravity = Gravity.CENTER
    label.maxLines = 2
    addView(label, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply {
      leftMargin = ctx.ciPx(16f)
      rightMargin = ctx.ciPx(16f)
      topMargin = ctx.ciPx(16f)
      bottomMargin = ctx.ciPx(16f)
    })
    spin.isIndeterminate = true
    addView(spin, LayoutParams(ctx.ciPx(22f), ctx.ciPx(22f), Gravity.CENTER))
  }

  fun bind(text: String, loading: Boolean, p: STPalette, first: Boolean, last: Boolean) {
    CICard.apply(this, p, first, last, false)
    label.text = if (loading) "" else text
    label.setTextColor(p.secondary)
    label.visibility = if (loading) INVISIBLE else VISIBLE
    spin.visibility = if (loading) VISIBLE else GONE
    spin.indeterminateTintList = ColorStateList.valueOf(p.secondary)
  }
}
