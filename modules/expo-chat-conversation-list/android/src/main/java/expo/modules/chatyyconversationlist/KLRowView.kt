package expo.modules.chatyyconversationlist

// [2026-10-15 native-calls] Linha do histórico de ligações (Android). Visual =
// CallHistoryRow do components/ChatCallsTab.js: avatar 44 num aro de 51
// (vermelho se perdida), nome 16/600 (vermelho se perdida), linha 2 com seta
// entrada/saída + origem + câmera + duração + microfone, hora 12 tabular,
// botão redondo de ligar (40) e "i". Cartão arredondado por seção (o
// arredondamento depende de ser 1ª/última da seção). Layout manual.

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import kotlin.math.max
import kotlin.math.min

internal class KLTheme(val dark: Boolean) {
  val bg: Int = if (dark) Color.BLACK else Color.parseColor("#F2F2F7")
  val card: Int = if (dark) Color.parseColor("#1C1C1E") else Color.WHITE
  val text: Int = if (dark) Color.WHITE else Color.BLACK
  val sub: Int = if (dark) Color.parseColor("#8E8E93") else Color.parseColor("#6C6C70")
  val hair: Int = if (dark) Color.argb(20, 255, 255, 255) else Color.argb(20, 0, 0, 0)
  val ink: Int = if (dark) Color.parseColor("#F5F5F7") else Color.parseColor("#111111")
  val btnBg: Int = if (dark) Color.parseColor("#2C2C2E") else Color.parseColor("#F2F2F7")
  val press: Int = if (dark) Color.argb(26, 255, 255, 255) else Color.argb(18, 0, 0, 0)
  val red: Int = Color.parseColor("#E53935")
  val green: Int = Color.parseColor("#16A34A")
}

internal data class KLRow(
  val id: String = "",
  val title: String = "",
  val dir: String = "in",
  val video: Boolean = false,
  val sub: String = "",
  val dur: String = "",
  val vm: Boolean = false,
  val time: String = "",
  val flag: String = "",
  val phone: Boolean = false,
  val count: Int = 0,
  val sec: String = "",
  val a11y: String = "",
  val avatar: CLRow = CLRow()
) {
  val missed: Boolean get() = dir == "missed"

  companion object {
    fun from(m: Map<String, Any?>): KLRow {
      val tiles = ArrayList<CLTile>()
      CLVal.list(m["tiles"])?.forEach { t -> CLVal.map(t)?.let { tiles.add(CLTile.from(it)) } }
      val id = CLVal.str(m["id"])
      return KLRow(
        id = id,
        title = CLVal.str(m["title"]),
        dir = CLVal.str(m["dir"]).ifEmpty { "in" },
        video = CLVal.bool(m["video"]),
        sub = CLVal.str(m["sub"]),
        dur = CLVal.str(m["dur"]),
        vm = CLVal.bool(m["vm"]),
        time = CLVal.str(m["time"]),
        flag = CLVal.str(m["flag"]),
        phone = CLVal.bool(m["phone"]),
        count = CLVal.int(m["count"]),
        sec = CLVal.str(m["sec"]),
        a11y = CLVal.str(m["a11y"]),
        avatar = CLRow(id = id, kind = CLVal.str(m["kind"]).ifEmpty { "direct" }, tiles = tiles)
      )
    }
  }
}

@SuppressLint("ViewConstructor")
internal class KLRowView(ctx: Context) : ViewGroup(ctx) {
  interface Listener {
    fun onPress(id: String)
    fun onAction(id: String, action: String)
    fun onLongPress(id: String, anchor: View)
  }

  var listener: Listener? = null

  private val d = ctx.resources.displayMetrics.density
  private val fontScale = ctx.resources.configuration.fontScale
  private fun px(v: Float): Int = (v * d + 0.5f).toInt()
  private fun sp(size: Float, cap: Float): Float = size * d * min(max(fontScale, 0.85f), cap)

  private val avatar = CLAvatarView(ctx)
  private val phoneTv = TextView(ctx)
  private val phoneIv = ImageView(ctx)
  private val phoneBg = GradientDrawable()
  private val nameTv = label(16f, 1.35f, 600)
  private val subTv = label(13f, 1.3f, 400)
  private val timeTv = label(12f, 1.3f, 500)
  private val callBtn = ImageView(ctx)
  private val callBg = GradientDrawable()
  private val infoBtn = ImageView(ctx)
  private val cardBg = GradientDrawable()
  private val maskBg = GradientDrawable()
  private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val hairPaint = Paint()

  var row = KLRow()
    private set
  private var theme = KLTheme(false)
  private var labels = CLLabels()
  var first = true
    private set
  var last = true
    private set
  private val rowHeight: Int

  init {
    clipChildren = false
    isClickable = true
    isLongClickable = true
    isFocusable = true
    setWillNotDraw(false)
    avatar.setBoxDp(44f)
    avatar.isClickable = false
    addView(avatar)
    phoneBg.shape = GradientDrawable.OVAL
    phoneTv.background = phoneBg
    phoneTv.gravity = Gravity.CENTER
    phoneTv.setTextSize(TypedValue.COMPLEX_UNIT_PX, 20f * d)
    phoneTv.includeFontPadding = false
    addView(phoneTv)
    phoneIv.scaleType = ImageView.ScaleType.CENTER_INSIDE
    phoneIv.setPadding(px(12f), px(12f), px(12f), px(12f))
    addView(phoneIv)
    addView(nameTv)
    addView(subTv)
    addView(timeTv)
    timeTv.fontFeatureSettings = "tnum"
    timeTv.gravity = Gravity.END
    timeTv.letterSpacing = 0.2f / 12f
    callBg.shape = GradientDrawable.OVAL
    callBtn.background = callBg
    callBtn.scaleType = ImageView.ScaleType.CENTER_INSIDE
    callBtn.setPadding(px(11f), px(11f), px(11f), px(11f))
    callBtn.isClickable = true
    callBtn.setOnClickListener {
      it.performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY)
      listener?.onAction(row.id, "callBack")
    }
    addView(callBtn)
    infoBtn.scaleType = ImageView.ScaleType.CENTER_INSIDE
    infoBtn.setPadding(px(4f), px(4f), px(4f), px(4f))
    infoBtn.isClickable = true
    infoBtn.setOnClickListener { listener?.onAction(row.id, "info") }
    addView(infoBtn)
    ringPaint.strokeWidth = 2f * d
    hairPaint.strokeWidth = max(1f, d * 0.5f)
    val nameLine = nameTv.lineHeight
    val subLine = subTv.lineHeight
    rowHeight = max(px(66f), px(22f) + nameLine + px(2f) + subLine)

    setOnClickListener { listener?.onPress(row.id) }
    setOnLongClickListener {
      performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
      listener?.onLongPress(row.id, this)
      true
    }
  }

  private fun label(size: Float, cap: Float, weight: Int): TextView {
    val tv = TextView(context)
    tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, sp(size, cap))
    tv.maxLines = 1
    tv.setSingleLine(true)
    tv.ellipsize = TextUtils.TruncateAt.END
    tv.includeFontPadding = false
    tv.typeface = CLType.weight(weight)
    tv.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    return tv
  }

  fun bind(r: KLRow, t: KLTheme, l: CLLabels, isFirst: Boolean, isLast: Boolean) {
    row = r
    theme = t
    labels = l
    first = isFirst
    last = isLast
    // Cartão: cantos de 14 só no topo da 1ª e no pé da última da seção.
    val rad = 14f * d
    val tl = if (isFirst) rad else 0f
    val bl = if (isLast) rad else 0f
    val radii = floatArrayOf(tl, tl, tl, tl, bl, bl, bl, bl)
    cardBg.cornerRadii = radii
    cardBg.setColor(t.card)
    maskBg.cornerRadii = radii
    maskBg.setColor(Color.WHITE)
    if (background !is RippleDrawable) {
      background = RippleDrawable(ColorStateList.valueOf(t.press), cardBg, maskBg)
    } else {
      (background as RippleDrawable).setColor(ColorStateList.valueOf(t.press))
    }
    // Avatar
    if (r.phone) {
      avatar.visibility = GONE
      phoneBg.setColor(t.btnBg)
      if (r.flag.isEmpty()) {
        phoneTv.visibility = GONE
        phoneIv.visibility = VISIBLE
        phoneIv.background = phoneBg
        phoneIv.setImageDrawable(tintedIcon(context, R.drawable.ccl_ic_phone, t.sub))
      } else {
        phoneIv.visibility = GONE
        phoneTv.visibility = VISIBLE
        phoneTv.background = phoneBg
        phoneTv.text = r.flag
      }
    } else {
      phoneTv.visibility = GONE
      phoneIv.visibility = GONE
      avatar.visibility = VISIBLE
      avatar.bind(r.avatar, CLTheme(t.dark), t.card)
    }
    // Nome
    nameTv.setTextColor(if (r.missed) t.red else t.text)
    nameTv.text = if (r.count > 1) "${r.title} (${r.count})" else r.title
    // Linha 2
    val sb = SpannableStringBuilder()
    val arrowColor = if (r.missed) t.red else t.sub // [2026-10-16 P&B] recebida = cinza como a feita (verde só no botão)
    val iconSize = px(12f)
    tintedIcon(context, if (r.dir == "out") R.drawable.ckl_ic_arrow_out else R.drawable.ckl_ic_arrow_in, arrowColor)?.let {
      sb.append("​")
      sb.setSpan(CLIconSpan(it, iconSize, px(4f)), sb.length - 1, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    val start = sb.length
    sb.append(r.sub)
    sb.setSpan(ForegroundColorSpan(t.sub), start, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    if (r.video) {
      tintedIcon(context, R.drawable.ccl_ic_video, t.sub)?.let {
        sb.append(" ​")
        sb.setSpan(CLIconSpan(it, iconSize, 0), sb.length - 1, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
    }
    if (r.dur.isNotEmpty()) {
      val s0 = sb.length
      sb.append(" ").append(r.dur)
      sb.setSpan(ForegroundColorSpan(t.sub), s0, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    if (r.vm) {
      tintedIcon(context, R.drawable.ccl_ic_mic, t.red)?.let {
        sb.append("  ​")
        sb.setSpan(CLIconSpan(it, iconSize, 0), sb.length - 1, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
    }
    subTv.text = sb
    subTv.setTextColor(t.sub)
    timeTv.setTextColor(t.sub)
    timeTv.text = r.time
    callBg.setColor(t.btnBg)
    callBtn.setImageDrawable(tintedIcon(context, if (r.video) R.drawable.ccl_ic_video else R.drawable.ccl_ic_phone, t.ink))
    callBtn.contentDescription = l.get("callBack", "Ligar de volta")
    infoBtn.setImageDrawable(tintedIcon(context, R.drawable.ckl_ic_info, t.ink))
    infoBtn.contentDescription = l.get("info", "Info")
    ringPaint.color = t.red
    hairPaint.color = t.hair
    contentDescription = r.a11y.ifEmpty { r.title }
    requestLayout()
    invalidate()
  }

  private fun exactly(v: Int) = MeasureSpec.makeMeasureSpec(max(0, v), MeasureSpec.EXACTLY)
  private fun atMost(v: Int) = MeasureSpec.makeMeasureSpec(max(0, v), MeasureSpec.AT_MOST)

  private var textX = 0
  private var textW = 0

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = rowHeight
    val ab = px(44f)
    avatar.measure(exactly(ab), exactly(ab))
    phoneTv.measure(exactly(ab), exactly(ab))
    phoneIv.measure(exactly(ab), exactly(ab))
    callBtn.measure(exactly(px(40f)), exactly(px(40f)))
    infoBtn.measure(exactly(px(28f)), exactly(px(28f)))
    timeTv.measure(atMost(px(140f)), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    textX = px(16f) + px(51f) + px(13f)
    val right = w - px(16f) - px(28f) - px(10f) - px(40f) - px(10f) - timeTv.measuredWidth - px(10f)
    textW = max(0, right - textX)
    nameTv.measure(exactly(textW), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    subTv.measure(exactly(textW), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    setMeasuredDimension(w, h)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val h = b - t
    val ab = px(44f)
    val ax = px(16f) + (px(51f) - ab) / 2
    val ay = (h - ab) / 2
    avatar.layout(ax, ay, ax + ab, ay + ab)
    phoneTv.layout(ax, ay, ax + ab, ay + ab)
    phoneIv.layout(ax, ay, ax + ab, ay + ab)
    var right = w - px(16f)
    infoBtn.layout(right - px(28f), (h - px(28f)) / 2, right, (h + px(28f)) / 2)
    right -= px(28f) + px(10f)
    callBtn.layout(right - px(40f), (h - px(40f)) / 2, right, (h + px(40f)) / 2)
    right -= px(40f) + px(10f)
    val tw = timeTv.measuredWidth
    val th = timeTv.measuredHeight
    timeTv.layout(right - tw, (h - th) / 2, right, (h - th) / 2 + th)
    val nh = nameTv.measuredHeight
    val sh = subTv.measuredHeight
    val top = (h - (nh + px(2f) + sh)) / 2
    nameTv.layout(textX, top, textX + textW, top + nh)
    subTv.layout(textX, top + nh + px(2f), textX + textW, top + nh + px(2f) + sh)
  }

  override fun dispatchDraw(canvas: Canvas) {
    super.dispatchDraw(canvas)
    if (row.missed) {
      val cx = px(16f) + px(51f) / 2f
      val cy = height / 2f
      canvas.drawCircle(cx, cy, px(51f) / 2f - ringPaint.strokeWidth / 2f, ringPaint)
    }
    if (!first) {
      // Divisória a partir do nome (16 + 51 + 13), como no JS.
      canvas.drawLine(px(80f).toFloat(), 0f, width.toFloat(), 0f, hairPaint)
    }
  }

  override fun hasOverlappingRendering(): Boolean = false
}
