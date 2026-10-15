package expo.modules.chatyyattach

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.camera.view.PreviewView

/** [2026-10-15 native-attach] Círculo de seleção numerado (anel → cheio + número). */
class CABadgeView(ctx: Context) : View(ctx) {
  var fill: Int = Color.WHITE
  var ink: Int = Color.BLACK
  var number: Int? = null
    set(v) { field = v; invalidate() }
  private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Color.WHITE }
  private val shade = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = 0x2E000000 }
  private val solid = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val txt = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    textAlign = Paint.Align.CENTER
    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
  }

  override fun onDraw(c: Canvas) {
    super.onDraw(c)
    val d = resources.displayMetrics.density
    val r = Math.min(width, height) / 2f - d
    val cx = width / 2f
    val cy = height / 2f
    val n = number
    if (n == null) {
      c.drawCircle(cx, cy, r, shade)
      ring.strokeWidth = 1.6f * d
      c.drawCircle(cx, cy, r - 0.8f * d, ring)
    } else {
      solid.color = fill
      c.drawCircle(cx, cy, r, solid)
      txt.color = ink
      txt.textSize = 12.5f * d
      val y = cy - (txt.descent() + txt.ascent()) / 2f
      c.drawText(n.toString(), cx, y, txt)
    }
  }
}

/** Célula da grade (foto/vídeo). */
class CAMediaCell(ctx: Context) : FrameLayout(ctx) {
  val image = ImageView(ctx)
  val dur = TextView(ctx)
  val badge = CABadgeView(ctx)
  var key: String = ""

  init {
    setBackgroundColor(0x1F808080)
    image.scaleType = ImageView.ScaleType.CENTER_CROP
    addView(image, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    dur.setTextColor(Color.WHITE)
    dur.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    dur.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    dur.setShadowLayer(3f, 0f, 0f, 0x99000000.toInt())
    dur.visibility = GONE
    val dlp = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END)
    dlp.setMargins(0, 0, CAUtil.dp(ctx, 6f), CAUtil.dp(ctx, 4f))
    addView(dur, dlp)
    val b = CAUtil.dp(ctx, 26f)
    val blp = LayoutParams(b, b, Gravity.TOP or Gravity.END)
    blp.setMargins(0, CAUtil.dp(ctx, 4f), CAUtil.dp(ctx, 4f), 0)
    addView(badge, blp)
  }

  fun setSelectedNumber(n: Int?, animate: Boolean) {
    badge.number = n
    val s = if (n != null) 0.9f else 1f
    if (animate) {
      image.animate().scaleX(s).scaleY(s).setDuration(180).start()
      if (n != null) {
        badge.scaleX = 0.6f; badge.scaleY = 0.6f
        badge.animate().scaleX(1f).scaleY(1f).setDuration(260)
          .setInterpolator(android.view.animation.OvershootInterpolator(2.2f)).start()
      }
    } else {
      image.animate().cancel()
      image.scaleX = s; image.scaleY = s
    }
  }
}

/** 1º quadrado: preview ao vivo (CameraX) ou ícone quando sem permissão. */
class CACameraCell(ctx: Context) : FrameLayout(ctx) {
  val preview = PreviewView(ctx)
  val icon = ImageView(ctx)

  init {
    setBackgroundColor(0xFF141414.toInt())
    preview.implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    preview.scaleType = PreviewView.ScaleType.FILL_CENTER
    preview.alpha = 0f
    addView(preview, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    icon.setImageResource(R.drawable.ca_ic_camera)
    icon.setColorFilter(Color.WHITE)
    val s = CAUtil.dp(ctx, 30f)
    addView(icon, LayoutParams(s, s, Gravity.CENTER))
  }
}

/** Botão redondo de ação (ícone + rótulo), P&B. */
class CAActionButton(ctx: Context, val key: String, title: String, cfg: CAConfig) : LinearLayout(ctx) {
  private val circle = FrameLayout(ctx)

  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    val d = CAUtil.dp(ctx, 52f)
    circle.background = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(cfg.chip)
      setStroke(Math.max(1, CAUtil.dp(ctx, 0.5f)), cfg.border)
    }
    val icon = ImageView(ctx)
    icon.setImageResource(CAConfig.iconFor(key))
    icon.setColorFilter(cfg.text)
    val i = CAUtil.dp(ctx, 24f)
    circle.addView(icon, FrameLayout.LayoutParams(i, i, Gravity.CENTER))
    val clp = LayoutParams(d, d)
    clp.topMargin = CAUtil.dp(ctx, 4f)
    addView(circle, clp)
    val label = TextView(ctx)
    label.text = title
    label.setTextColor(cfg.textSecondary)
    label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    label.gravity = Gravity.CENTER
    label.maxLines = 1
    label.ellipsize = TextUtils.TruncateAt.END
    val llp = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    llp.topMargin = CAUtil.dp(ctx, 6f)
    addView(label, llp)
    contentDescription = title
    isClickable = true
    isFocusable = true
  }

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    val s = if (pressed) 0.9f else 1f
    circle.animate().scaleX(s).scaleY(s).setDuration(120).start()
  }
}

/** Chip alternável (HD / Enviar como arquivo). */
class CAChip(ctx: Context, title: String, private val cfg: CAConfig) : TextView(ctx) {
  var on: Boolean = false
    set(v) { field = v; refresh() }

  init {
    text = title
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    gravity = Gravity.CENTER
    val h = CAUtil.dp(ctx, 13f)
    setPadding(h, 0, h, 0)
    minHeight = CAUtil.dp(ctx, 30f)
    isClickable = true
    isFocusable = true
    contentDescription = title
    refresh()
  }

  private fun refresh() {
    background = GradientDrawable().apply {
      cornerRadius = CAUtil.dp(context, 15f).toFloat()
      setColor(if (on) cfg.text else Color.TRANSPARENT)
      setStroke(CAUtil.dp(context, 1f), if (on) cfg.text else (cfg.textSecondary and 0x00FFFFFF) or 0x73000000)
    }
    setTextColor(if (on) cfg.bg else cfg.text)
    isSelected = on
  }
}

fun caCircleBg(color: Int, stroke: Int? = null, strokeW: Int = 0): GradientDrawable =
  GradientDrawable().apply {
    shape = GradientDrawable.OVAL
    setColor(color)
    if (stroke != null) setStroke(strokeW, stroke)
  }

fun caTint(v: ImageView, color: Int) {
  v.imageTintList = ColorStateList.valueOf(color)
}
