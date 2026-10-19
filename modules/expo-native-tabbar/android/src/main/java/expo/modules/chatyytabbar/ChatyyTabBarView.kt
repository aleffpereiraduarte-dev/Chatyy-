package expo.modules.chatyytabbar

import android.animation.ValueAnimator
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.graphics.drawable.RippleDrawable
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.model.GlideUrl
import com.bumptech.glide.load.model.LazyHeaders
import com.bumptech.glide.request.target.CustomTarget
import com.bumptech.glide.request.transition.Transition
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * [2026-10-18 you-tab-avatar] Foto redonda da aba "Você" (api 3). A foto já vem
 * recortada em círculo pela Glide (circleCrop); aqui só posiciona e desenha o
 * anel de 1,5 dp na cor ativa quando a aba está selecionada (+ contorno 0,5 dp
 * quase invisível p/ foto clara em fundo claro não "sumir"). Sem tint.
 */
internal class NTBAvatarDrawable(
  private val photo: Bitmap,
  private val ring: Int?,
  private val edge: Int,
  private val density: Float,
) : Drawable() {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val dst = RectF()

  override fun draw(canvas: Canvas) {
    val b = bounds
    val side = min(b.width(), b.height()).toFloat()
    if (side <= 0f || photo.isRecycled) return
    val cx = b.exactCenterX()
    val cy = b.exactCenterY()
    val r = side / 2f
    var pr = r - 1f * density
    if (ring != null) {
      val lw = 1.5f * density
      stroke.strokeWidth = lw
      stroke.color = ring
      canvas.drawCircle(cx, cy, r - lw / 2f, stroke)
      pr = r - lw - 1.5f * density
    }
    dst.set(cx - pr, cy - pr, cx + pr, cy + pr)
    canvas.drawBitmap(photo, null, dst, paint)
    stroke.strokeWidth = 0.5f * density
    stroke.color = edge
    canvas.drawCircle(cx, cy, pr - 0.25f * density, stroke)
  }

  override fun setAlpha(alpha: Int) {
    paint.alpha = alpha
    stroke.alpha = alpha
    invalidateSelf()
  }

  override fun setColorFilter(colorFilter: ColorFilter?) {
    paint.colorFilter = colorFilter
    invalidateSelf()
  }

  @Deprecated("Deprecated in Java")
  override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}

/** Modelo Glide: http(s) (com cabeçalhos opcionais), file://, content:// ou caminho. */
internal fun ntbAvatarModel(u: String, headers: Map<String, String>?): Any? {
  if (u.startsWith("http://") || u.startsWith("https://")) {
    if (!headers.isNullOrEmpty()) {
      val b = LazyHeaders.Builder()
      for ((k, v) in headers) if (k.isNotBlank()) b.addHeader(k, v)
      return GlideUrl(u, b.build())
    }
    return u
  }
  if (u.startsWith("file://") || u.startsWith("content://")) return Uri.parse(u)
  if (u.startsWith("/")) return File(u)
  return null
}

/**
 * [2026-10-15 native-tabs] Barra inferior estilo Material 3 NavigationBar,
 * desenhada com Views do framework (sem Material Components → sem exigir
 * Theme.MaterialComponents; o app usa Theme.AppCompat).
 *
 * - Pílula atrás do ícone ativo (fade + expansão horizontal com overshoot).
 * - Ícone troca para a versão preenchida e dá um "bounce" (overshoot).
 * - Ripple sem borda, haptic CLOCK_TICK ao trocar, LONG_PRESS no long-press.
 * - Seleção controlada pelo JS (`selectedKey`) com pintura otimista no toque
 *   e ressincronização em 700 ms (igual ao iOS).
 */
class ChatyyTabBarView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {

  internal val onTabPress by EventDispatcher()
  internal val onTabLongPress by EventDispatcher()
  @Suppress("unused") internal val onPreferredHeight by EventDispatcher()

  override val shouldUseAndroidLayout: Boolean = true

  var bounceEnabled = true

  private val density = resources.displayMetrics.density
  private fun dp(v: Float): Int = (v * density).roundToInt()

  private val hairline = View(context)
  private val row = LinearLayout(context)
  private val cells = ArrayList<Cell>()
  private val main = Handler(Looper.getMainLooper())

  private var records: List<NTBItemRecord> = emptyList()
  private var structureSignature = ""
  private var itemsDirty = false

  private var selectedKey: String? = null
  private var selectedDirty = false
  private var displayedKey: String? = null

  private var theme = NTBThemeRecord()
  private var themeDirty = true

  private var cActive = Color.BLACK
  private var cInactive = Color.GRAY
  private var cBackground = Color.WHITE
  private var cPill = 0x12000000
  private var cBadgeBg = Color.BLACK
  private var cBadgeFg = Color.WHITE
  private var cRipple = 0x14000000
  private var isDarkTheme = false

  private val resync = Runnable {
    if (displayedKey != selectedKey) setDisplayed(selectedKey, animate = true, bounce = false)
  }

  init {
    orientation = VERTICAL
    clipChildren = false
    clipToPadding = false
    row.orientation = LinearLayout.HORIZONTAL
    row.clipChildren = false
    row.clipToPadding = false
    addView(hairline, LayoutParams(LayoutParams.MATCH_PARENT, max(1, (density * 0.5f).roundToInt())))
    addView(row, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
    applyTheme()
  }

  // ── Props ────────────────────────────────────────────────────────────────

  fun setItems(list: List<NTBItemRecord>) {
    records = list
    itemsDirty = true
  }

  fun setSelectedKeyProp(key: String?) {
    selectedKey = if (key.isNullOrEmpty()) null else key
    selectedDirty = true
  }

  fun setThemeProp(t: NTBThemeRecord) {
    theme = t
    themeDirty = true
  }

  fun setBottomInsetDp(v: Double) {
    val px = (v * density).roundToInt()
    if (row.paddingBottom != px) row.setPadding(0, 0, 0, px)
  }

  fun didUpdateProps() {
    if (themeDirty) {
      themeDirty = false
      applyTheme()
    }
    if (itemsDirty) {
      itemsDirty = false
      applyItems()
    }
    if (selectedDirty) {
      selectedDirty = false
      main.removeCallbacks(resync)
      val bounce = displayedKey != null && displayedKey != selectedKey
      setDisplayed(selectedKey, animate = true, bounce = bounce)
    }
  }

  // ── Cells ────────────────────────────────────────────────────────────────

  private inner class Cell(var record: NTBItemRecord) {
    val root = LinearLayout(context)
    val iconWrap = FrameLayout(context)
    val pill = View(context)
    val icon = ImageView(context)
    val badge = TextView(context)
    val dot = View(context)
    val label = TextView(context)
    var active = false
    var shownBadge = -1
    var colorAnim: ValueAnimator? = null
    // [2026-10-18 you-tab-avatar] foto (cópia própria — o bitmap da Glide pode
    // ser reciclado quando o target é limpo) e o pedido em andamento.
    var avatarBmp: Bitmap? = null
    var avatarReqUrl = ""
    var avatarTarget: CustomTarget<Bitmap>? = null
    var avatarShown = false

    init {
      root.orientation = LinearLayout.VERTICAL
      root.gravity = Gravity.CENTER
      root.clipChildren = false
      root.clipToPadding = false
      root.isClickable = true
      root.isFocusable = true

      iconWrap.clipChildren = false
      iconWrap.clipToPadding = false
      pill.alpha = 0f
      pill.scaleX = 0.6f
      iconWrap.addView(pill, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      icon.scaleType = ImageView.ScaleType.FIT_CENTER
      iconWrap.addView(icon, FrameLayout.LayoutParams(dp(24f), dp(24f), Gravity.CENTER))

      badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
      badge.typeface = Typeface.DEFAULT_BOLD
      badge.gravity = Gravity.CENTER
      badge.includeFontPadding = false
      badge.minWidth = dp(18f)
      badge.setPadding(dp(5f), 0, dp(5f), 0)
      badge.visibility = View.GONE
      iconWrap.addView(badge, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(18f), Gravity.TOP or Gravity.END).apply {
        topMargin = -dp(4f)
        rightMargin = dp(5f)
      })
      dot.visibility = View.GONE
      iconWrap.addView(dot, FrameLayout.LayoutParams(dp(9f), dp(9f), Gravity.TOP or Gravity.END).apply {
        topMargin = dp(2f)
        rightMargin = dp(12f)
      })
      root.addView(iconWrap, LinearLayout.LayoutParams(dp(56f), dp(32f)))

      label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      label.maxLines = 1
      label.isSingleLine = true
      label.gravity = Gravity.CENTER
      label.includeFontPadding = false
      root.addView(label, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
        topMargin = dp(4f)
      })

      root.accessibilityDelegate = object : View.AccessibilityDelegate() {
        override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
          super.onInitializeAccessibilityNodeInfo(host, info)
          info.className = "android.widget.Button"
          info.isSelected = active
        }
      }
      root.setOnClickListener { onCellClick(this) }
    }

    fun bind(r: NTBItemRecord) {
      record = r
      label.text = r.label
      // [2026-10-18 you-tab-nolabel] api 4: sem rótulo → só o ícone/foto, centralizado
      // na célula (root gravity CENTER) e com caixa maior p/ caber a foto de 30 dp.
      label.visibility = if (r.hideLabel) View.GONE else View.VISIBLE
      (iconWrap.layoutParams as? LinearLayout.LayoutParams)?.let { lp ->
        val h = dp(if (r.hideLabel) 40f else 32f)
        if (lp.height != h) {
          lp.height = h
          iconWrap.layoutParams = lp
        }
      }
      if (r.longPress) {
        root.setOnLongClickListener {
          root.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
          bounce()
          onTabLongPress(mapOf("key" to record.key))
          true
        }
      } else {
        root.setOnLongClickListener(null)
        root.isLongClickable = false
      }
      updateIcon()
      updateBadge(animate = false)
      updateAvatar()
    }

    private fun setIconSizeDp(v: Float) {
      val lp = icon.layoutParams as? FrameLayout.LayoutParams ?: return
      val px = dp(v)
      if (lp.width != px || lp.height != px) {
        lp.width = px
        lp.height = px
        icon.layoutParams = lp
      }
    }

    fun updateIcon() {
      val bmp = avatarBmp
      if (bmp != null) {
        setIconSizeDp(if (record.hideLabel) 30f else 28f)
        icon.imageTintList = null
        val edge = if (isDarkTheme) 0x24FFFFFF else 0x1A000000
        icon.setImageDrawable(NTBAvatarDrawable(bmp, if (active) cActive else null, edge, density))
        avatarShown = true
        return
      }
      setIconSizeDp(if (record.hideLabel) 28f else 24f)
      val res = iconRes(record.androidIcon ?: record.key, active)
      if (res != 0) icon.setImageResource(res) else icon.setImageDrawable(null)
      if (avatarShown) {
        avatarShown = false
        icon.imageTintList = ColorStateList.valueOf(if (active) cActive else cInactive)
      }
    }

    /** Pede a foto quando `avatarUrl` muda. Até chegar fica o que já está (vetor
     *  ou a foto anterior, se só mudou o `v=`); erro → volta ao vetor (ntb_you). */
    fun updateAvatar() {
      val url = record.avatarUrl?.trim().orEmpty()
      if (url == avatarReqUrl) return
      avatarReqUrl = url
      val app = context.applicationContext
      avatarTarget?.let { old -> try { Glide.with(app).clear(old) } catch (_: Throwable) {} }
      avatarTarget = null
      val model = if (url.isEmpty()) null else ntbAvatarModel(url, record.avatarHeaders)
      if (model == null) {
        if (avatarBmp != null) {
          avatarBmp = null
          updateIcon()
        }
        return
      }
      val px = dp(if (record.hideLabel) 30f else 28f)
      val target = object : CustomTarget<Bitmap>(px, px) {
        override fun onResourceReady(resource: Bitmap, transition: Transition<in Bitmap>?) {
          if (avatarTarget !== this) return
          val own = try {
            resource.copy(Bitmap.Config.ARGB_8888, false)
          } catch (_: Throwable) {
            null
          } ?: return
          avatarBmp = own
          updateIcon()
        }

        override fun onLoadFailed(errorDrawable: Drawable?) {
          if (avatarTarget !== this) return
          if (avatarBmp != null) {
            avatarBmp = null
            updateIcon()
          }
        }

        override fun onLoadCleared(placeholder: Drawable?) {}
      }
      avatarTarget = target
      try {
        Glide.with(app).asBitmap().load(model).circleCrop()
          .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC).into(target)
      } catch (_: Throwable) {
        avatarTarget = null
      }
    }

    fun updateBadge(animate: Boolean) {
      val n = record.badge
      if (n > 0) {
        badge.text = if (n > 99) "99+" else n.toString()
        val wasHidden = badge.visibility != View.VISIBLE
        badge.visibility = View.VISIBLE
        dot.visibility = View.GONE
        if (animate && (wasHidden || n != shownBadge)) {
          badge.scaleX = 0.85f
          badge.scaleY = 0.85f
          badge.animate().scaleX(1f).scaleY(1f).setDuration(260).setInterpolator(OvershootInterpolator(2.5f)).start()
        }
      } else {
        badge.visibility = View.GONE
        dot.visibility = if (record.dot) View.VISIBLE else View.GONE
      }
      shownBadge = n
      root.contentDescription = if (n > 0) "${record.label}, $n" else record.label
    }

    fun applyColors() {
      (badge.background as? GradientDrawable)?.let {
        it.setColor(cBadgeBg)
        it.setStroke(dp(2f), cBackground)
      } ?: run {
        badge.background = GradientDrawable().apply {
          shape = GradientDrawable.RECTANGLE
          cornerRadius = dp(9f).toFloat()
          setColor(cBadgeBg)
          setStroke(dp(2f), cBackground)
        }
      }
      badge.setTextColor(cBadgeFg)
      dot.background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(cBadgeBg)
        setStroke(max(1, dp(1.5f)), cBackground)
      }
      pill.background = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = dp(16f).toFloat()
        setColor(cPill)
      }
      root.background = RippleDrawable(ColorStateList.valueOf(cRipple), null, null).apply {
        radius = dp(34f)
      }
      colorAnim?.cancel()
      tint(if (active) cActive else cInactive)
      if (avatarBmp != null) updateIcon() // anel/contorno seguem cor ativa e modo escuro
    }

    fun tint(c: Int) {
      if (avatarBmp == null) icon.imageTintList = ColorStateList.valueOf(c)
      label.setTextColor(c)
    }

    fun setActive(on: Boolean, animate: Boolean) {
      val changed = on != active
      active = on
      root.isSelected = on
      updateIcon()
      label.typeface = if (on) Typeface.DEFAULT_BOLD else Typeface.create("sans-serif-medium", Typeface.NORMAL)
      if (!changed) {
        tint(if (on) cActive else cInactive)
        pill.alpha = if (on) 1f else 0f
        pill.scaleX = if (on) 1f else 0.6f
        return
      }
      colorAnim?.cancel()
      pill.animate().cancel()
      if (animate) {
        val from = if (on) cInactive else cActive
        val to = if (on) cActive else cInactive
        colorAnim = ValueAnimator.ofArgb(from, to).apply {
          duration = 180
          addUpdateListener { a -> tint(a.animatedValue as Int) }
          start()
        }
        if (on) {
          pill.animate().alpha(1f).scaleX(1f).setDuration(320).setInterpolator(OvershootInterpolator(1.4f)).start()
        } else {
          pill.animate().alpha(0f).scaleX(0.6f).setDuration(160).setInterpolator(DecelerateInterpolator()).start()
        }
      } else {
        tint(if (on) cActive else cInactive)
        pill.alpha = if (on) 1f else 0f
        pill.scaleX = if (on) 1f else 0.6f
      }
    }

    fun bounce() {
      if (!bounceEnabled) return
      if (android.os.Build.VERSION.SDK_INT >= 26 && !ValueAnimator.areAnimatorsEnabled()) return
      icon.animate().cancel()
      icon.scaleX = 0.72f
      icon.scaleY = 0.72f
      icon.animate().scaleX(1f).scaleY(1f).setDuration(420).setInterpolator(OvershootInterpolator(3.2f)).start()
    }
  }

  private fun iconRes(name: String?, on: Boolean): Int = when (name) {
    "chats" -> if (on) R.drawable.ntb_chats_on else R.drawable.ntb_chats
    "email" -> if (on) R.drawable.ntb_email_on else R.drawable.ntb_email
    "reels" -> if (on) R.drawable.ntb_reels_on else R.drawable.ntb_reels
    "calls" -> if (on) R.drawable.ntb_calls_on else R.drawable.ntb_calls
    "apps" -> if (on) R.drawable.ntb_apps_on else R.drawable.ntb_apps
    "you" -> if (on) R.drawable.ntb_you_on else R.drawable.ntb_you // [2026-10-18 you-tab] api 2
    else -> 0
  }

  private fun applyItems() {
    val sig = records.joinToString("\n") { "${it.key}|${it.label}|${it.androidIcon ?: ""}|${it.longPress}|${it.hideLabel}" }
    if (sig != structureSignature || cells.size != records.size) {
      structureSignature = sig
      row.removeAllViews()
      cells.clear()
      for (r in records) {
        val c = Cell(r)
        c.applyColors()
        c.bind(r)
        cells.add(c)
        row.addView(c.root, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
      }
      val keep = displayedKey ?: selectedKey
      displayedKey = null
      setDisplayed(keep, animate = false, bounce = false)
      requestLayout()
    } else {
      for ((i, r) in records.withIndex()) {
        val c = cells[i]
        c.record = r
        c.updateBadge(animate = true)
        c.updateAvatar()
      }
    }
  }

  private fun applyTheme() {
    val t = theme
    val dark = t.dark
    isDarkTheme = dark
    cActive = ntbColor(t.active, if (dark) 0xFFF5F5F5.toInt() else 0xFF0B0B0B.toInt())
    cInactive = ntbColor(t.inactive, if (dark) 0xFF8E8E93.toInt() else 0xFF6E6E73.toInt())
    cBackground = ntbColor(t.background, if (dark) 0xFF0B0B0B.toInt() else Color.WHITE)
    cPill = ntbColor(t.pill, if (dark) 0x24FFFFFF else 0x12000000)
    cBadgeBg = ntbColor(t.badgeBackground, cActive)
    cBadgeFg = ntbColor(t.badgeText, if (dark) 0xFF0B0B0B.toInt() else Color.WHITE)
    cRipple = ntbColor(t.ripple, if (dark) 0x1FFFFFFF else 0x14000000)
    setBackgroundColor(cBackground)
    hairline.setBackgroundColor(ntbColor(t.hairline, if (dark) 0x1AFFFFFF else 0x1F000000))
    for (c in cells) c.applyColors()
  }

  // ── Selection ────────────────────────────────────────────────────────────

  private fun setDisplayed(key: String?, animate: Boolean, bounce: Boolean) {
    val changed = key != displayedKey
    displayedKey = if (key != null && cells.any { it.record.key == key }) key else null
    for (c in cells) {
      val on = c.record.key == displayedKey
      c.setActive(on, animate)
      if (on && bounce && changed) c.bounce()
    }
  }

  private fun onCellClick(c: Cell) {
    val key = c.record.key
    if (key != displayedKey) {
      c.root.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    }
    if (c.record.selectable) {
      if (key != displayedKey) setDisplayed(key, animate = true, bounce = true)
    } else {
      c.bounce()
    }
    main.removeCallbacks(resync)
    main.postDelayed(resync, 700)
    onTabPress(mapOf("key" to key))
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    main.removeCallbacks(resync)
  }
}
