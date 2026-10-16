package expo.modules.callkit.video

// [2026-10-16 wave13-B] Folha nativa "Efeitos" (View, sem Compose) — usada pela
// CallActivity (Compose por baixo) e pela GroupCallActivity (Views). Faixa de
// fundos (Nenhum · Desfoque leve/forte · 8 fundos · Galeria) + faixa de luz
// (Nenhum · Retoque · Pouca luz). Escolha aplica na hora; o PiP local fica
// visível acima = pré-visualização ao vivo. Toque fora fecha.

import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

object CallFxSheet {
  private const val TAG = "CallFxSheet"
  private const val VIEW_TAG = "chatyy_callfx_sheet"
  private var pickSeq = 0

  fun isShowing(activity: ComponentActivity): Boolean {
    val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return false
    return content.findViewWithTag<View>(VIEW_TAG) != null
  }

  /**
   * @param cameraOn   local camera publishing (hint shown when false)
   * @param beforePick called right before the system photo picker opens
   *                   (activities suppress their auto-PiP there)
   * @param afterPick  called when the picker returns (any result)
   */
  fun show(
    activity: ComponentActivity,
    cameraOn: () -> Boolean,
    beforePick: () -> Unit = {},
    afterPick: () -> Unit = {},
  ) {
    val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return
    if (content.findViewWithTag<View>(VIEW_TAG) != null) return
    CallFx.load(activity)
    val ctx = activity
    fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt()

    val root = FrameLayout(ctx).apply {
      tag = VIEW_TAG
      setBackgroundColor(Color.argb(1, 0, 0, 0)) // catches taps, keeps the PiP visible
      isClickable = true
      layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    }
    val navBottom = try {
      ViewCompat.getRootWindowInsets(content)?.getInsets(WindowInsetsCompat.Type.navigationBars())?.bottom ?: 0
    } catch (_: Throwable) { 0 }

    val card = LinearLayout(ctx).apply {
      orientation = LinearLayout.VERTICAL
      isClickable = true // swallow taps on the card
      background = GradientDrawable().apply {
        cornerRadius = dp(24f).toFloat()
        setColor(Color.parseColor("#F5121212"))
        setStroke(1, Color.argb(20, 255, 255, 255))
      }
      setPadding(0, dp(10f), 0, dp(14f))
      layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        gravity = Gravity.BOTTOM
        leftMargin = dp(8f); rightMargin = dp(8f); bottomMargin = dp(8f) + navBottom
      }
    }
    root.addView(card)

    card.addView(View(ctx).apply {
      background = GradientDrawable().apply { cornerRadius = dp(3f).toFloat(); setColor(Color.argb(64, 255, 255, 255)) }
    }, LinearLayout.LayoutParams(dp(40f), dp(5f)).apply { gravity = Gravity.CENTER_HORIZONTAL })

    card.addView(TextView(ctx).apply {
      text = CallFxStrings.s("title")
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
      typeface = android.graphics.Typeface.DEFAULT_BOLD
      gravity = Gravity.CENTER
    }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10f) })

    val info = TextView(ctx).apply {
      setTextColor(Color.argb(180, 255, 255, 255))
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      gravity = Gravity.CENTER
      maxLines = 2
      setPadding(dp(16f), dp(2f), dp(16f), 0)
    }
    card.addView(info, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

    class Item(val key: String, val tile: FrameLayout, val image: ImageView)
    val bgItems = ArrayList<Item>()
    val lightItems = ArrayList<Item>()

    fun section(title: String): LinearLayout {
      card.addView(TextView(ctx).apply {
        text = title
        setTextColor(Color.argb(153, 255, 255, 255))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        typeface = android.graphics.Typeface.DEFAULT_BOLD
        setPadding(dp(16f), dp(12f), dp(16f), dp(6f))
      })
      val hs = HorizontalScrollView(ctx).apply {
        isHorizontalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
      }
      val row = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        setPadding(dp(12f), 0, dp(12f), 0)
      }
      hs.addView(row)
      card.addView(hs, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      return row
    }

    fun makeItem(row: LinearLayout, key: String, caption: String, a11y: String, icon: Drawable?, thumb: Bitmap?, onTap: () -> Unit): Item {
      val col = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
      }
      val tile = FrameLayout(ctx).apply {
        background = GradientDrawable().apply { cornerRadius = dp(16f).toFloat(); setColor(Color.argb(26, 255, 255, 255)) }
        outlineProvider = object : ViewOutlineProvider() {
          override fun getOutline(view: View, outline: Outline) {
            outline.setRoundRect(0, 0, view.width, view.height, dp(16f).toFloat())
          }
        }
        clipToOutline = true
        contentDescription = a11y
        isClickable = true
        setOnClickListener { onTap() }
      }
      val iv = ImageView(ctx).apply {
        if (thumb != null) {
          setImageBitmap(thumb)
          scaleType = ImageView.ScaleType.CENTER_CROP
        } else {
          setImageDrawable(icon)
          scaleType = ImageView.ScaleType.CENTER
          imageTintList = ColorStateList.valueOf(Color.WHITE)
        }
      }
      tile.addView(iv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      col.addView(tile, LinearLayout.LayoutParams(dp(60f), dp(60f)))
      if (caption.isNotEmpty()) {
        col.addView(TextView(ctx).apply {
          text = caption
          setTextColor(Color.argb(217, 255, 255, 255))
          setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
          gravity = Gravity.CENTER
          maxLines = 2
        }, LinearLayout.LayoutParams(dp(68f), ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4f) })
      }
      row.addView(col, LinearLayout.LayoutParams(dp(68f), ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        leftMargin = dp(4f); rightMargin = dp(4f)
      })
      return Item(key, tile, iv)
    }

    val ring = { on: Boolean ->
      if (on) GradientDrawable().apply {
        cornerRadius = dp(16f).toFloat()
        setColor(Color.TRANSPARENT)
        setStroke(dp(2.5f), Color.WHITE)
      } else null
    }

    fun refresh() {
      val bg = CallFx.background
      for (it in bgItems) { it.tile.foreground = ring(it.key == bg); it.tile.isSelected = it.key == bg }
      val l = CallFx.light
      for (it in lightItems) { it.tile.foreground = ring(it.key == l); it.tile.isSelected = it.key == l }
      val pause = CallFx.pauseText(CallFx.pauseReason)
      info.text = pause ?: if (!cameraOn()) CallFxStrings.s("camOff") else ""
      info.visibility = if (info.text.isNullOrEmpty()) View.GONE else View.VISIBLE
    }

    // Background row
    val bgRow = section(CallFxStrings.s("background"))
    bgItems += makeItem(bgRow, CallFx.BG_NONE, CallFxStrings.s("none"), CallFxStrings.s("none"), FxIcon(FxIcon.NONE, dp(24f)), null) {
      CallFx.setBackground(ctx, CallFx.BG_NONE); refresh()
    }
    bgItems += makeItem(bgRow, CallFx.BG_BLUR_LIGHT, CallFxStrings.s("blurLight"), CallFxStrings.s("blurLight"), FxIcon(FxIcon.BLUR_LIGHT, dp(24f)), null) {
      CallFx.setBackground(ctx, CallFx.BG_BLUR_LIGHT); refresh()
    }
    bgItems += makeItem(bgRow, CallFx.BG_BLUR_STRONG, CallFxStrings.s("blurStrong"), CallFxStrings.s("blurStrong"), FxIcon(FxIcon.BLUR_STRONG, dp(24f)), null) {
      CallFx.setBackground(ctx, CallFx.BG_BLUR_STRONG); refresh()
    }
    val thumbPx = dp(60f)
    for (i in 0 until CallFx.WALLPAPER_COUNT) {
      val key = CallFx.wallpaperKey(i)
      val label = CallFxStrings.s("bgN", "n" to (i + 1).toString())
      val thumb = try { CallFxWallpapers.render(i, thumbPx, thumbPx) } catch (_: Throwable) { null }
      bgItems += makeItem(bgRow, key, "", label, null, thumb) { CallFx.setBackground(ctx, key); refresh() }
    }
    val customThumb = try {
      if (CallFx.hasCustom(ctx)) BitmapFactory.decodeFile(CallFx.customFile(ctx).absolutePath, BitmapFactory.Options().apply { inSampleSize = 8 }) else null
    } catch (_: Throwable) { null }
    lateinit var galleryItem: Item
    galleryItem = makeItem(bgRow, CallFx.BG_CUSTOM, CallFxStrings.s("gallery"), CallFxStrings.s("gallery"),
      FxIcon(FxIcon.GALLERY, dp(24f)), customThumb) {
      openPicker(activity, beforePick, afterPick) { ok ->
        if (!ok) return@openPicker
        try {
          val bmp = BitmapFactory.decodeFile(CallFx.customFile(ctx).absolutePath, BitmapFactory.Options().apply { inSampleSize = 8 })
          if (bmp != null) {
            galleryItem.image.imageTintList = null
            galleryItem.image.setImageBitmap(bmp)
            galleryItem.image.scaleType = ImageView.ScaleType.CENTER_CROP
          }
        } catch (_: Throwable) {}
        refresh()
      }
    }
    bgItems += galleryItem

    // Light row
    val lightRow = section(CallFxStrings.s("light"))
    lightItems += makeItem(lightRow, CallFx.LIGHT_NONE, CallFxStrings.s("none"), CallFxStrings.s("none"), FxIcon(FxIcon.NONE, dp(24f)), null) {
      CallFx.setLight(ctx, CallFx.LIGHT_NONE); refresh()
    }
    lightItems += makeItem(lightRow, CallFx.LIGHT_RETOUCH, CallFxStrings.s("retouch"), CallFxStrings.s("retouch"), FxIcon(FxIcon.RETOUCH, dp(24f)), null) {
      CallFx.setLight(ctx, CallFx.LIGHT_RETOUCH); refresh()
    }
    lightItems += makeItem(lightRow, CallFx.LIGHT_LOW, CallFxStrings.s("lowLight"), CallFxStrings.s("lowLight"), FxIcon(FxIcon.LOW_LIGHT, dp(24f)), null) {
      CallFx.setLight(ctx, CallFx.LIGHT_LOW); refresh()
    }

    val listener: () -> Unit = { refresh() }
    CallFx.listeners.add(listener)
    var closing = false
    fun dismiss() {
      if (closing) return
      closing = true
      CallFx.listeners.remove(listener)
      card.animate().translationY(dp(40f).toFloat()).alpha(0f).setDuration(160).withEndAction {
        try { content.removeView(root) } catch (_: Throwable) {}
      }.start()
    }
    root.setOnClickListener { dismiss() }
    root.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(v: View) {}
      override fun onViewDetachedFromWindow(v: View) { CallFx.listeners.remove(listener) }
    })

    refresh()
    content.addView(root)
    card.alpha = 0f
    card.translationY = dp(40f).toFloat()
    card.animate().translationY(0f).alpha(1f).setDuration(220).start()
  }

  private fun openPicker(activity: ComponentActivity, beforePick: () -> Unit, afterPick: () -> Unit, done: (Boolean) -> Unit) {
    val key = "chatyy_callfx_pick_${++pickSeq}"
    var launcher: androidx.activity.result.ActivityResultLauncher<PickVisualMediaRequest>? = null
    try {
      launcher = activity.activityResultRegistry.register(key, ActivityResultContracts.PickVisualMedia()) { uri ->
        try { launcher?.unregister() } catch (_: Throwable) {}
        try { afterPick() } catch (_: Throwable) {}
        if (uri == null) { done(false); return@register }
        val app = activity.applicationContext
        Thread {
          val ok = CallFx.saveCustomImage(app, uri)
          Handler(Looper.getMainLooper()).post { done(ok) }
        }.start()
      }
      beforePick()
      launcher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    } catch (t: Throwable) {
      Log.w(TAG, "photo picker failed: ${t.message}")
      try { launcher?.unregister() } catch (_: Throwable) {}
      try { afterPick() } catch (_: Throwable) {}
      done(false)
    }
  }
}

/** Tiny vector-free glyphs (white) for the effect tiles / the group button. */
class FxIcon(private val kind: Int, private val sizePx: Int) : Drawable() {
  companion object {
    const val NONE = 0
    const val BLUR_LIGHT = 1
    const val BLUR_STRONG = 2
    const val GALLERY = 3
    const val RETOUCH = 4
    const val LOW_LIGHT = 5
    const val EFFECTS = 6
  }

  private val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }

  override fun getIntrinsicWidth() = sizePx
  override fun getIntrinsicHeight() = sizePx

  override fun draw(canvas: Canvas) {
    val b = bounds
    val s = min(b.width(), b.height()).toFloat()
    val cx = b.exactCenterX(); val cy = b.exactCenterY()
    val sw = s * 0.09f
    p.strokeWidth = sw
    p.strokeCap = Paint.Cap.ROUND
    when (kind) {
      NONE -> {
        p.style = Paint.Style.STROKE
        canvas.drawCircle(cx, cy, s * 0.36f, p)
        val d = s * 0.36f * 0.7071f
        canvas.drawLine(cx - d, cy + d, cx + d, cy - d, p)
      }
      BLUR_LIGHT, BLUR_STRONG -> {
        p.style = Paint.Style.FILL
        val step = s * 0.24f
        for (yy in -1..1) for (xx in -1..1) {
          val edge = xx != 0 || yy != 0
          val r = if (kind == BLUR_STRONG) (if (edge) s * 0.075f else s * 0.10f) else (if (edge) s * 0.04f else s * 0.075f)
          p.alpha = if (edge) 150 else 255
          canvas.drawCircle(cx + xx * step, cy + yy * step, r, p)
        }
        p.alpha = 255
      }
      GALLERY -> {
        p.style = Paint.Style.STROKE
        val r = RectF(cx - s * 0.38f, cy - s * 0.30f, cx + s * 0.38f, cy + s * 0.30f)
        canvas.drawRoundRect(r, s * 0.08f, s * 0.08f, p)
        p.style = Paint.Style.FILL
        val path = Path().apply {
          moveTo(r.left + sw, r.bottom - sw)
          lineTo(cx - s * 0.10f, cy - s * 0.02f)
          lineTo(cx + s * 0.04f, cy + s * 0.12f)
          lineTo(cx + s * 0.16f, cy + s * 0.02f)
          lineTo(r.right - sw, r.bottom - sw)
          close()
        }
        canvas.drawPath(path, p)
        canvas.drawCircle(cx + s * 0.18f, cy - s * 0.14f, s * 0.06f, p)
      }
      RETOUCH, EFFECTS -> {
        p.style = Paint.Style.FILL
        star(canvas, cx - s * 0.06f, cy + s * 0.04f, s * 0.30f)
        star(canvas, cx + s * 0.26f, cy - s * 0.26f, s * 0.14f)
        if (kind == EFFECTS) star(canvas, cx + s * 0.24f, cy + s * 0.28f, s * 0.10f)
      }
      LOW_LIGHT -> {
        p.style = Paint.Style.STROKE
        canvas.drawCircle(cx, cy, s * 0.16f, p)
        for (i in 0 until 8) {
          val a = Math.PI * i / 4
          val r0 = s * 0.28f; val r1 = s * 0.40f
          canvas.drawLine(cx + (cos(a) * r0).toFloat(), cy + (sin(a) * r0).toFloat(),
            cx + (cos(a) * r1).toFloat(), cy + (sin(a) * r1).toFloat(), p)
        }
      }
    }
  }

  /** 4-point sparkle. */
  private fun star(c: Canvas, x: Float, y: Float, r: Float) {
    val k = r * 0.28f
    val path = Path().apply {
      moveTo(x, y - r)
      quadTo(x + k * 0.2f, y - k * 0.2f, x + r, y)
      quadTo(x + k * 0.2f, y + k * 0.2f, x, y + r)
      quadTo(x - k * 0.2f, y + k * 0.2f, x - r, y)
      quadTo(x - k * 0.2f, y - k * 0.2f, x, y - r)
      close()
    }
    c.drawPath(path, p)
  }

  override fun setAlpha(alpha: Int) { p.alpha = alpha; invalidateSelf() }
  override fun setColorFilter(colorFilter: ColorFilter?) { p.colorFilter = colorFilter; invalidateSelf() }
  @Deprecated("Deprecated in Java")
  override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
