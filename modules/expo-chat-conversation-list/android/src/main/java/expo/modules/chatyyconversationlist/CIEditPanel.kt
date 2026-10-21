package expo.modules.chatyyconversationlist

// [2026-10-18 profile-edit-native] "Editar perfil" NATIVO estilo Telegram por
// cima da MESMA view ChatyyChatInfo (apiVersion 4). Mesmo contrato do iOS
// (ios/CIEditPanel.swift): prop `edit` {on, seq, backSeq, values, pic, cover,
// busyAvatar, busyCover, saving, errors, uname, presets, groups, labels,
// limits} → eventos onEdit {type: change|done|cancel|avatar|cover|coverRemove|row}.
// [2026-10-21 foto-capa-studio] apiVersion 7: `coverHero` true = capa GRANDE no
// topo (3:1 atrás do avatar; sem capa = degradê grafite) + selo "Alterar capa";
// toque → onEdit {type:"cover"}; o cartão "Foto de capa" some.
// Os campos são do NATIVO durante a edição (o JS só manda os valores iniciais
// quando `seq` muda), então digitar não depende da ponte.

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewTreeObserver
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.bumptech.glide.Glide
import kotlin.math.max

internal data class CIEditRow(
  val id: String = "",
  val title: String = "",
  val value: String = "",
  val chevron: Boolean = true,
  val destructive: Boolean = false
) {
  companion object {
    fun from(m: Map<String, Any?>): CIEditRow = CIEditRow(
      id = CLVal.str(m["id"]),
      title = CLVal.str(m["title"]),
      value = CLVal.str(m["val"]),
      chevron = if (m["nav"] == null) true else CLVal.bool(m["nav"]),
      destructive = CLVal.bool(m["dest"])
    )
  }
}

internal data class CIEditGroup(
  val header: String = "",
  val footer: String = "",
  val rows: List<CIEditRow> = emptyList()
) {
  companion object {
    fun from(m: Map<String, Any?>): CIEditGroup {
      val rows = ArrayList<CIEditRow>()
      CLVal.list(m["rows"])?.forEach { x ->
        val r = CLVal.map(x) ?: return@forEach
        val row = CIEditRow.from(r)
        if (row.id.isNotEmpty()) rows.add(row)
      }
      return CIEditGroup(header = CLVal.str(m["header"]), footer = CLVal.str(m["footer"]), rows = rows)
    }
  }
}

internal data class CIEditState(
  val on: Boolean = false,
  val seq: Int = 0,
  val backSeq: Int = 0,
  val values: Map<String, String> = emptyMap(),
  val pic: CIPic = CIPic(),
  val coverUrl: String = "",
  val coverAuth: Boolean = false,
  val busyAvatar: Boolean = false,
  val busyCover: Boolean = false,
  val saving: Boolean = false,
  val errors: Map<String, String> = emptyMap(),
  val unameQ: String = "",
  val unameState: String = "",
  val unameText: String = "",
  val presets: List<String> = emptyList(),
  val groups: List<CIEditGroup> = emptyList(),
  val labels: Map<String, String> = emptyMap(),
  val limits: Map<String, Int> = emptyMap(),
  val coverHero: Boolean = false
) {
  fun label(k: String, fb: String): String = labels[k] ?: fb
  fun limit(k: String, fb: Int): Int = limits[k] ?: fb

  companion object {
    fun from(m: Map<String, Any?>?): CIEditState {
      if (m == null) return CIEditState()
      val values = HashMap<String, String>()
      CLVal.map(m["values"])?.forEach { (k, v) -> values[k] = CLVal.str(v) }
      val cover = CLVal.map(m["cover"])
      val errors = HashMap<String, String>()
      CLVal.map(m["errors"])?.forEach { (k, v) ->
        val s = CLVal.str(v)
        if (s.isNotEmpty()) errors[k] = s
      }
      val uname = CLVal.map(m["uname"])
      val presets = ArrayList<String>()
      CLVal.list(m["presets"])?.forEach { x ->
        val s = CLVal.str(x)
        if (s.isNotEmpty() && !presets.contains(s)) presets.add(s)
      }
      val groups = ArrayList<CIEditGroup>()
      CLVal.list(m["groups"])?.forEach { x ->
        val g = CLVal.map(x) ?: return@forEach
        val gg = CIEditGroup.from(g)
        if (gg.rows.isNotEmpty()) groups.add(gg)
      }
      val labels = HashMap<String, String>()
      CLVal.map(m["labels"])?.forEach { (k, v) ->
        val s = CLVal.str(v)
        if (s.isNotEmpty()) labels[k] = s
      }
      val limits = HashMap<String, Int>()
      CLVal.map(m["limits"])?.forEach { (k, v) ->
        val n = CLVal.int(v)
        if (n > 0) limits[k] = n
      }
      return CIEditState(
        on = CLVal.bool(m["on"]),
        seq = CLVal.int(m["seq"]),
        backSeq = CLVal.int(m["backSeq"]),
        values = values,
        pic = CIPic.from(m["pic"]),
        coverUrl = if (cover != null) CLVal.str(cover["u"]) else "",
        coverAuth = if (cover != null) CLVal.bool(cover["a"]) else false,
        busyAvatar = CLVal.bool(m["busyAvatar"]),
        busyCover = CLVal.bool(m["busyCover"]),
        saving = CLVal.bool(m["saving"]),
        errors = errors,
        unameQ = if (uname != null) CLVal.str(uname["q"]) else "",
        unameState = if (uname != null) CLVal.str(uname["state"]) else "",
        unameText = if (uname != null) CLVal.str(uname["text"]) else "",
        presets = presets,
        groups = groups,
        labels = labels,
        limits = limits,
        coverHero = CLVal.bool(m["coverHero"])
      )
    }
  }
}

private fun Context.cePx(v: Float): Int = (v * resources.displayMetrics.density + 0.5f).toInt()

private fun ceText(ctx: Context, sizeSp: Float, weight: Int): TextView {
  val tv = TextView(ctx)
  tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
  tv.typeface = CLType.weight(weight)
  tv.includeFontPadding = false
  return tv
}

/** Linha de toque (título · valor · miniatura · indicador · seta), 50 dp. */
@SuppressLint("ViewConstructor")
internal class CIEditNavRow(ctx: Context) : LinearLayout(ctx) {
  val titleTv = ceText(ctx, 17f, 400)
  val valueTv = ceText(ctx, 17f, 400)
  val thumb = ImageView(ctx)
  val spin = ProgressBar(ctx)
  val chevron = ImageView(ctx)
  var rowId = ""
  private var thumbUrl = ""

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = ctx.cePx(50f)
    setPadding(ctx.cePx(16f), 0, ctx.cePx(16f), 0)
    titleTv.maxLines = 1
    titleTv.ellipsize = TextUtils.TruncateAt.END
    addView(titleTv, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    valueTv.maxLines = 1
    valueTv.ellipsize = TextUtils.TruncateAt.END
    valueTv.gravity = Gravity.END
    addView(valueTv, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = ctx.cePx(12f) })
    thumb.scaleType = ImageView.ScaleType.CENTER_CROP
    thumb.clipToOutline = true
    val tb = GradientDrawable()
    tb.cornerRadius = 4f * resources.displayMetrics.density
    tb.setColor(Color.TRANSPARENT)
    thumb.background = tb
    thumb.visibility = GONE
    addView(thumb, LayoutParams(ctx.cePx(66f), ctx.cePx(22f)).apply { marginStart = ctx.cePx(8f) })
    spin.isIndeterminate = true
    spin.visibility = GONE
    addView(spin, LayoutParams(ctx.cePx(18f), ctx.cePx(18f)).apply { marginStart = ctx.cePx(8f) })
    chevron.scaleType = ImageView.ScaleType.FIT_CENTER
    addView(chevron, LayoutParams(ctx.cePx(17f), ctx.cePx(17f)).apply { marginStart = ctx.cePx(6f) })
    isClickable = true
    isFocusable = true
  }

  fun bind(title: String, value: String, chevronOn: Boolean, destructive: Boolean, p: STPalette) {
    titleTv.text = title
    titleTv.setTextColor(if (destructive) p.destructive else p.text)
    valueTv.text = value
    valueTv.setTextColor(p.secondary)
    valueTv.visibility = if (value.isEmpty()) INVISIBLE else VISIBLE
    chevron.visibility = if (chevronOn) VISIBLE else GONE
    chevron.setImageDrawable(tintedIcon(context, R.drawable.cst_ic_chevron, p.tertiary))
    spin.indeterminateTintList = ColorStateList.valueOf(p.secondary)
    val mask = GradientDrawable()
    mask.setColor(Color.WHITE)
    background = RippleDrawable(ColorStateList.valueOf(p.ripple), null, mask)
    contentDescription = if (value.isEmpty()) title else "$title, $value"
  }

  fun setBusy(on: Boolean) {
    spin.visibility = if (on) VISIBLE else GONE
  }

  fun setThumb(url: String, auth: Boolean) {
    if (url.isEmpty()) {
      thumbUrl = ""
      thumb.visibility = GONE
      try { Glide.with(context.applicationContext).clear(thumb) } catch (_: Throwable) {}
      thumb.setImageDrawable(null)
      return
    }
    thumb.visibility = VISIBLE
    if (url == thumbUrl) return
    thumbUrl = url
    val model = CICard.glideModel(url, auth) ?: return
    try {
      Glide.with(context.applicationContext).load(model).centerCrop().into(thumb)
    } catch (_: Throwable) {}
  }
}

/** [2026-10-21 foto-capa-studio] Capa grande do topo do editor (apiVersion 7):
 * 3:1, cantos de 16 dp, degradê grafite sem capa, véu embaixo e selo "Alterar capa". */
@SuppressLint("ViewConstructor")
internal class CIEditCoverView(ctx: Context) : FrameLayout(ctx) {
  private val dens = ctx.resources.displayMetrics.density
  private fun dpx(v: Float): Int = (v * dens + 0.5f).toInt()
  private val fallback = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(0xFFDCDCD6.toInt(), 0xFFB9B9B3.toInt()))
  private val image = ImageView(ctx)
  private val shade = View(ctx)
  private val chip = LinearLayout(ctx)
  private val chipIcon = ImageView(ctx)
  private val chipLabel = ceText(ctx, 13f, 600)
  private val spin = ProgressBar(ctx)
  private var url = ""

  init {
    fallback.cornerRadius = 16f * dens
    background = fallback
    clipToOutline = true
    image.scaleType = ImageView.ScaleType.CENTER_CROP
    image.visibility = GONE
    image.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(image, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    shade.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0x00000000, 0x00000000, 0x4D000000))
    shade.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(shade, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    chip.orientation = LinearLayout.HORIZONTAL
    chip.gravity = Gravity.CENTER_VERTICAL
    chip.setPadding(dpx(10f), 0, dpx(12f), 0)
    val cb = GradientDrawable()
    cb.cornerRadius = 14f * dens
    cb.setColor(0x6B000000)
    chip.background = cb
    chipIcon.setImageDrawable(tintedIcon(ctx, R.drawable.crl_ic_image, Color.WHITE))
    chip.addView(chipIcon, LinearLayout.LayoutParams(dpx(14f), dpx(14f)))
    chipLabel.setTextColor(Color.WHITE)
    chip.addView(chipLabel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dpx(6f) })
    addView(chip, LayoutParams(LayoutParams.WRAP_CONTENT, dpx(28f), Gravity.END or Gravity.BOTTOM).apply { marginEnd = dpx(10f); bottomMargin = dpx(10f) })
    spin.isIndeterminate = true
    spin.indeterminateTintList = ColorStateList.valueOf(Color.WHITE)
    spin.visibility = GONE
    addView(spin, LayoutParams(dpx(28f), dpx(28f), Gravity.CENTER))
    isClickable = true
    isFocusable = true
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    super.onMeasure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(max(1, w / 3), MeasureSpec.EXACTLY))
  }

  fun bind(u: String, auth: Boolean, dark: Boolean, label: String, busy: Boolean) {
    fallback.colors = if (dark) intArrayOf(0xFF34343B.toInt(), 0xFF1B1B1F.toInt()) else intArrayOf(0xFFDCDCD6.toInt(), 0xFFB9B9B3.toInt())
    chipLabel.text = label
    contentDescription = label
    spin.visibility = if (busy) VISIBLE else GONE
    if (u.isEmpty()) {
      url = ""
      try { Glide.with(context.applicationContext).clear(image) } catch (_: Throwable) {}
      image.setImageDrawable(null)
      image.visibility = GONE
      return
    }
    image.visibility = VISIBLE
    if (u == url) return
    url = u
    val model = CICard.glideModel(u, auth) ?: return
    try {
      Glide.with(context.applicationContext).load(model).centerCrop().into(image)
    } catch (_: Throwable) {}
  }

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    alpha = if (pressed) 0.82f else 1f
  }
}

@SuppressLint("ViewConstructor")
internal class CIEditPanel(ctx: Context) : FrameLayout(ctx) {
  var onEvent: ((Map<String, Any>) -> Unit)? = null

  private val density = ctx.resources.displayMetrics.density
  private fun px(v: Float): Int = (v * density + 0.5f).toInt()

  private var state = CIEditState()
  private var palette = STPalette.defaults(false)
  private var appliedSeq = Int.MIN_VALUE
  private var appliedBack = Int.MIN_VALUE
  private var shown = false
  private var initial: Map<String, String> = emptyMap()
  private val localErrors = HashMap<String, String>()
  private var bottomInsetPx = 0
  private var imePx = 0
  private var subOpen = false
  private var hydrating = false
  private var groupsApplied: List<CIEditGroup>? = null
  private var pillsApplied: List<String>? = null

  private val mainView = LinearLayout(ctx)
  private val navBar = FrameLayout(ctx)
  private val navLine = View(ctx)
  private val cancelBtn = ceText(ctx, 17f, 400)
  private val doneBtn = ceText(ctx, 17f, 600)
  private val navTitle = ceText(ctx, 17f, 600)
  private val doneSpin = ProgressBar(ctx)
  private val scroll = ScrollView(ctx)
  private val content = LinearLayout(ctx)

  private val avatarFrame = FrameLayout(ctx)
  private val avatar = CLAvatarView(ctx)
  private val avatarDim = View(ctx)
  private val avatarSpin = ProgressBar(ctx)
  private val setPhotoBtn = ceText(ctx, 17f, 400)
  private val generalError = ceText(ctx, 13f, 400)
  // [2026-10-21 foto-capa-studio] capa grande no topo (apiVersion 7, edit.coverHero).
  private val coverHero = CIEditCoverView(ctx)
  private var coverCardGroup: View? = null

  private val firstField = EditText(ctx)
  private val lastField = EditText(ctx)
  private val nameError = ceText(ctx, 13f, 400)
  private val nameFooter = ceText(ctx, 13f, 400)

  private val bioField = EditText(ctx)
  private val bioCounter = ceText(ctx, 15f, 400)
  private val bioError = ceText(ctx, 13f, 400)
  private val bioFooter = ceText(ctx, 13f, 400)

  private val usernameRow = CIEditNavRow(ctx)
  private val pronounsTitle = ceText(ctx, 17f, 400)
  private val pronounsField = EditText(ctx)
  private val linkTitle = ceText(ctx, 17f, 400)
  private val linkField = EditText(ctx)
  private val detailsError = ceText(ctx, 13f, 400)

  private val aboutTitle = ceText(ctx, 17f, 400)
  private val aboutField = EditText(ctx)
  private val pillsRow = HorizontalScrollView(ctx)
  private val pillsBox = LinearLayout(ctx)
  private val pills = ArrayList<TextView>()
  private val aboutError = ceText(ctx, 13f, 400)
  private val aboutFooter = ceText(ctx, 13f, 400)

  private val coverRow = CIEditNavRow(ctx)
  private val coverRemoveRow = CIEditNavRow(ctx)
  private var coverRemoveSep: View? = null

  private val groupsBox = LinearLayout(ctx)

  // Subtela do @usuário
  private val subView = LinearLayout(ctx)
  private val subNav = FrameLayout(ctx)
  private val subLine = View(ctx)
  private val subBack = ceText(ctx, 17f, 400)
  private val subDone = ceText(ctx, 17f, 600)
  private val subTitle = ceText(ctx, 17f, 600)
  private val subScroll = ScrollView(ctx)
  private val subContent = LinearLayout(ctx)
  private val atLabel = ceText(ctx, 17f, 400)
  private val unameField = EditText(ctx)
  private val unameStatusRow = LinearLayout(ctx)
  private val unameSpin = ProgressBar(ctx)
  private val unameStatus = ceText(ctx, 13f, 400)
  private val unameFooter = ceText(ctx, 13f, 400)

  private val cards = ArrayList<View>()
  private val seps = ArrayList<View>()
  private val footers = ArrayList<TextView>()
  private val errorLabels = ArrayList<TextView>()
  private val fieldTitles = ArrayList<TextView>()
  private val fields = ArrayList<EditText>()
  private val fieldKeys = HashMap<EditText, String>()

  private val layoutListener = ViewTreeObserver.OnGlobalLayoutListener { measureIme() }

  init {
    visibility = GONE
    alpha = 0f
    isClickable = true
    isFocusable = true
    build()
  }

  // ─── Construção ─────────────────────────────────────────────────────────

  private fun mlp(w: Int, h: Int): LinearLayout.LayoutParams = LinearLayout.LayoutParams(w, h)

  private fun makeNav(bar: FrameLayout, line: View, left: TextView, right: TextView, title: TextView, spin: ProgressBar?) {
    left.setPadding(px(16f), 0, px(16f), 0)
    left.gravity = Gravity.CENTER_VERTICAL
    left.isClickable = true
    left.isFocusable = true
    bar.addView(left, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.MATCH_PARENT, Gravity.START or Gravity.CENTER_VERTICAL))
    right.setPadding(px(16f), 0, px(16f), 0)
    right.gravity = Gravity.CENTER_VERTICAL
    right.isClickable = true
    right.isFocusable = true
    bar.addView(right, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.MATCH_PARENT, Gravity.END or Gravity.CENTER_VERTICAL))
    if (spin != null) {
      spin.isIndeterminate = true
      spin.visibility = GONE
      bar.addView(spin, LayoutParams(px(22f), px(22f), Gravity.END or Gravity.CENTER_VERTICAL).apply { marginEnd = px(28f) })
    }
    title.gravity = Gravity.CENTER
    title.maxLines = 1
    title.ellipsize = TextUtils.TruncateAt.END
    bar.addView(title, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply {
      leftMargin = px(110f)
      rightMargin = px(110f)
    })
    line.alpha = 0f
    bar.addView(line, LayoutParams(LayoutParams.MATCH_PARENT, max(1, (density * 0.5f).toInt()), Gravity.BOTTOM))
  }

  private fun makeScroll(sv: ScrollView, box: LinearLayout, line: View) {
    sv.isFillViewport = true
    sv.clipToPadding = false
    sv.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    sv.isVerticalScrollBarEnabled = true
    box.orientation = LinearLayout.VERTICAL
    box.setPadding(px(16f), px(8f), px(16f), px(8f))
    sv.addView(box, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    sv.setOnScrollChangeListener { _, _, y, _, _ -> line.alpha = if (y > px(4f)) 1f else 0f }
  }

  private fun cardOf(rows: List<View>): LinearLayout {
    val card = LinearLayout(context)
    card.orientation = LinearLayout.VERTICAL
    card.clipToOutline = true
    rows.forEachIndexed { i, r ->
      if (i > 0) card.addView(separator())
      card.addView(r, mlp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    }
    cards.add(card)
    return card
  }

  private fun separator(): View {
    val wrap = FrameLayout(context)
    val line = View(context)
    wrap.addView(line, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply { leftMargin = px(16f) })
    wrap.layoutParams = mlp(LinearLayout.LayoutParams.MATCH_PARENT, max(1, (density * 0.5f).toInt()))
    seps.add(line)
    line.setBackgroundColor(palette.separator)
    return wrap
  }

  private fun caption(tv: TextView, error: Boolean): TextView {
    tv.setPadding(px(16f), px(8f), px(16f), 0)
    tv.setLineSpacing(0f, 1.15f)
    tv.visibility = GONE
    if (error) errorLabels.add(tv) else footers.add(tv)
    return tv
  }

  private fun groupOf(views: List<View>, topGap: Boolean): LinearLayout {
    val g = LinearLayout(context)
    g.orientation = LinearLayout.VERTICAL
    for (v in views) g.addView(v, mlp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    g.layoutParams = mlp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
      topMargin = if (topGap) px(28f) else 0
    }
    return g
  }

  private fun setupField(f: EditText, key: String, singleLine: Boolean) {
    f.background = null
    f.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
    f.typeface = CLType.weight(400)
    f.includeFontPadding = false
    if (singleLine) {
      f.setSingleLine(true)
      f.maxLines = 1
      f.imeOptions = EditorInfo.IME_ACTION_DONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    } else {
      f.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
    }
    fields.add(f)
    fieldKeys[f] = key
    f.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        if (hydrating) return
        fieldChanged(key, f)
      }
    })
    f.setOnFocusChangeListener { v, has -> if (has) v.postDelayed({ ensureVisible(v) }, 250) }
  }

  private fun plainFieldRow(f: EditText): View {
    val row = FrameLayout(context)
    f.setPadding(px(16f), 0, px(16f), 0)
    f.gravity = Gravity.CENTER_VERTICAL or Gravity.START
    row.addView(f, LayoutParams(LayoutParams.MATCH_PARENT, px(50f)))
    return row
  }

  private fun titledFieldRow(title: TextView, f: EditText): View {
    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    row.setPadding(px(16f), 0, px(16f), 0)
    title.maxLines = 1
    title.minWidth = px(96f)
    fieldTitles.add(title)
    row.addView(title, mlp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    f.setPadding(px(12f), 0, 0, 0)
    f.gravity = Gravity.CENTER_VERTICAL or Gravity.END
    row.addView(f, LinearLayout.LayoutParams(0, px(50f), 1f))
    return row
  }

  private fun clickOf(v: View, fn: () -> Unit) {
    v.setOnClickListener {
      if (state.saving) return@setOnClickListener
      fn()
    }
  }

  private fun build() {
    mainView.orientation = LinearLayout.VERTICAL
    addView(mainView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    makeNav(navBar, navLine, cancelBtn, doneBtn, navTitle, doneSpin)
    mainView.addView(navBar, mlp(LinearLayout.LayoutParams.MATCH_PARENT, px(56f)))
    makeScroll(scroll, content, navLine)
    mainView.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
    cancelBtn.setOnClickListener { cancelTapped() }
    doneBtn.setOnClickListener { doneTapped() }

    // ── Foto + "Definir nova foto" ──
    val header = LinearLayout(context)
    header.orientation = LinearLayout.VERTICAL
    header.gravity = Gravity.CENTER_HORIZONTAL
    val box = px(100f)
    // [2026-10-21 foto-capa-studio] capa 3:1 atrás do avatar (GONE sem coverHero).
    coverHero.visibility = GONE
    clickOf(coverHero) { if (!state.busyCover) emit(mapOf("type" to "cover")) }
    header.addView(coverHero, mlp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = px(4f) })
    avatar.setBoxDp(100f)
    avatarFrame.addView(avatar, LayoutParams(box, box))
    val dim = GradientDrawable()
    dim.shape = GradientDrawable.OVAL
    dim.setColor(0x66000000)
    avatarDim.background = dim
    avatarDim.visibility = GONE
    avatarFrame.addView(avatarDim, LayoutParams(box, box))
    avatarSpin.isIndeterminate = true
    avatarSpin.indeterminateTintList = ColorStateList.valueOf(Color.WHITE)
    avatarSpin.visibility = GONE
    avatarFrame.addView(avatarSpin, LayoutParams(px(28f), px(28f), Gravity.CENTER))
    avatarFrame.isClickable = true
    avatarFrame.isFocusable = true
    clickOf(avatarFrame) { avatarTapped() }
    header.addView(avatarFrame, mlp(box, box).apply { topMargin = px(12f) })
    setPhotoBtn.gravity = Gravity.CENTER
    setPhotoBtn.setPadding(px(12f), 0, px(12f), 0)
    setPhotoBtn.isClickable = true
    setPhotoBtn.isFocusable = true
    clickOf(setPhotoBtn) { avatarTapped() }
    header.addView(setPhotoBtn, mlp(LinearLayout.LayoutParams.WRAP_CONTENT, px(40f)).apply { topMargin = px(6f) })
    generalError.gravity = Gravity.CENTER_HORIZONTAL
    content.addView(groupOf(listOf(header, caption(generalError, true)), false))

    // ── Nome + Sobrenome ──
    setupField(firstField, "first", true)
    setupField(lastField, "last", true)
    firstField.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PERSON_NAME or InputType.TYPE_TEXT_FLAG_CAP_WORDS
    lastField.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PERSON_NAME or InputType.TYPE_TEXT_FLAG_CAP_WORDS
    firstField.imeOptions = EditorInfo.IME_ACTION_NEXT or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    firstField.setOnEditorActionListener { _, actionId, _ ->
      if (actionId == EditorInfo.IME_ACTION_NEXT) { lastField.requestFocus(); true } else false
    }
    val nameCard = cardOf(listOf(plainFieldRow(firstField), plainFieldRow(lastField)))
    content.addView(groupOf(listOf(nameCard, caption(nameError, true), caption(nameFooter, false)), true))

    // ── Bio com contador ──
    setupField(bioField, "bio", false)
    bioField.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    bioField.isSingleLine = false
    bioField.minLines = 1
    bioField.maxLines = 12
    bioField.gravity = Gravity.TOP or Gravity.START
    bioField.setPadding(px(16f), px(15f), px(8f), px(15f))
    bioField.minHeight = px(50f)
    val bioRow = LinearLayout(context)
    bioRow.orientation = LinearLayout.HORIZONTAL
    bioRow.addView(bioField, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    bioCounter.gravity = Gravity.END
    bioRow.addView(bioCounter, mlp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
      topMargin = px(16f)
      rightMargin = px(16f)
    })
    val bioCard = cardOf(listOf(bioRow))
    content.addView(groupOf(listOf(bioCard, caption(bioError, true), caption(bioFooter, false)), true))

    // ── Usuário · Pronomes · Link ──
    clickOf(usernameRow) { openSub() }
    setupField(pronounsField, "pronouns", true)
    pronounsField.inputType = InputType.TYPE_CLASS_TEXT
    setupField(linkField, "link", true)
    linkField.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
    val detailsCard = cardOf(listOf(usernameRow, titledFieldRow(pronounsTitle, pronounsField), titledFieldRow(linkTitle, linkField)))
    content.addView(groupOf(listOf(detailsCard, caption(detailsError, true)), true))

    // ── Recado + pílulas ──
    setupField(aboutField, "about", true)
    aboutField.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    pillsRow.isHorizontalScrollBarEnabled = false
    pillsRow.overScrollMode = View.OVER_SCROLL_NEVER
    pillsBox.orientation = LinearLayout.HORIZONTAL
    pillsBox.gravity = Gravity.CENTER_VERTICAL
    pillsBox.setPadding(px(16f), 0, px(16f), 0)
    pillsRow.addView(pillsBox, LayoutParams(LayoutParams.WRAP_CONTENT, px(52f)))
    val aboutCard = cardOf(listOf(titledFieldRow(aboutTitle, aboutField), pillsRow))
    content.addView(groupOf(listOf(aboutCard, caption(aboutError, true), caption(aboutFooter, false)), true))

    // ── Foto de capa ──
    clickOf(coverRow) { if (!state.busyCover) emit(mapOf("type" to "cover")) }
    clickOf(coverRemoveRow) { if (!state.busyCover) emit(mapOf("type" to "coverRemove")) }
    val coverCard = cardOf(listOf(coverRow, coverRemoveRow))
    if (coverCard.childCount == 3) coverRemoveSep = coverCard.getChildAt(1)
    val coverGroup = groupOf(listOf(coverCard), true)
    coverCardGroup = coverGroup
    content.addView(coverGroup)

    // ── Grupos do JS ──
    groupsBox.orientation = LinearLayout.VERTICAL
    content.addView(groupsBox, mlp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

    buildSub()
  }

  private fun buildSub() {
    subView.orientation = LinearLayout.VERTICAL
    subView.visibility = GONE
    subView.isClickable = true
    addView(subView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    makeNav(subNav, subLine, subBack, subDone, subTitle, null)
    subView.addView(subNav, mlp(LinearLayout.LayoutParams.MATCH_PARENT, px(56f)))
    makeScroll(subScroll, subContent, subLine)
    subView.addView(subScroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
    subBack.compoundDrawablePadding = px(4f)
    subBack.setPadding(px(10f), 0, px(16f), 0)
    subBack.setOnClickListener { closeSub(true) }
    subDone.setOnClickListener { closeSub(true) }

    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    row.setPadding(px(16f), 0, px(16f), 0)
    atLabel.text = "@"
    row.addView(atLabel, mlp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    setupField(unameField, "username", true)
    unameField.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
    unameField.setPadding(px(2f), 0, 0, 0)
    unameField.gravity = Gravity.CENTER_VERTICAL or Gravity.START
    unameField.setOnEditorActionListener { _, actionId, _ ->
      if (actionId == EditorInfo.IME_ACTION_DONE) { closeSub(true); true } else false
    }
    row.addView(unameField, LinearLayout.LayoutParams(0, px(50f), 1f))
    val card = cardOf(listOf(row))

    unameStatusRow.orientation = LinearLayout.HORIZONTAL
    unameStatusRow.gravity = Gravity.CENTER_VERTICAL
    unameStatusRow.setPadding(px(16f), px(8f), px(16f), 0)
    unameSpin.isIndeterminate = true
    unameSpin.visibility = GONE
    unameStatusRow.addView(unameSpin, mlp(px(14f), px(14f)).apply { rightMargin = px(6f) })
    unameStatus.setLineSpacing(0f, 1.15f)
    unameStatusRow.addView(unameStatus, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    unameStatusRow.visibility = GONE
    subContent.addView(groupOf(listOf(card, unameStatusRow, caption(unameFooter, false)), false))
  }

  // ─── Props ──────────────────────────────────────────────────────────────

  fun configure(s: CIEditState, p: STPalette, bottomInset: Int) {
    state = s
    palette = p
    bottomInsetPx = bottomInset
    applyColors()
    applyLabels()
    if (s.seq != appliedSeq) {
      appliedSeq = s.seq
      hydrate()
    }
    if (appliedBack == Int.MIN_VALUE) {
      appliedBack = s.backSeq
    } else if (s.backSeq != appliedBack) {
      appliedBack = s.backSeq
      if (shown) handleBack()
    }
    rebuildPills()
    rebuildGroups()
    applyDynamic()
    setShown(s.on)
    refreshInsets()
  }

  private fun placeholderColor(): Int = if (palette.dark) 0x52FFFFFF else 0x523C3C43

  private fun applyColors() {
    val p = palette
    setBackgroundColor(p.pageBg)
    mainView.setBackgroundColor(p.pageBg)
    subView.setBackgroundColor(p.pageBg)
    navBar.setBackgroundColor(p.pageBg)
    subNav.setBackgroundColor(p.pageBg)
    navLine.setBackgroundColor(p.separator)
    subLine.setBackgroundColor(p.separator)
    for (b in listOf(cancelBtn, doneBtn, subBack, subDone, setPhotoBtn)) b.setTextColor(p.text)
    navTitle.setTextColor(p.text)
    subTitle.setTextColor(p.text)
    doneSpin.indeterminateTintList = ColorStateList.valueOf(p.secondary)
    unameSpin.indeterminateTintList = ColorStateList.valueOf(p.secondary)
    val back = tintedIcon(context, R.drawable.cci_ic_back, p.text)
    val s = px(20f)
    back?.setBounds(0, 0, s, s)
    subBack.setCompoundDrawables(back, null, null, null)
    for (c in cards) {
      val bg = GradientDrawable()
      bg.cornerRadius = 14f * density
      bg.setColor(p.cardBg)
      c.background = bg
    }
    for (l in seps) l.setBackgroundColor(p.separator)
    for (l in footers) l.setTextColor(p.secondary)
    for (l in errorLabels) l.setTextColor(p.destructive)
    for (l in fieldTitles) l.setTextColor(p.text)
    atLabel.setTextColor(p.secondary)
    for (f in fields) {
      f.setTextColor(p.text)
      f.setHintTextColor(placeholderColor())
      f.highlightColor = if (p.dark) 0x55FFFFFF else 0x33111111
    }
  }

  private fun applyLabels() {
    val s = state
    cancelBtn.text = s.label("cancel", "Cancelar")
    doneBtn.text = s.label("done", "Concluído")
    navTitle.text = s.label("title", "")
    setPhotoBtn.text = s.label("setPhoto", "Definir nova foto")
    avatarFrame.contentDescription = s.label("setPhoto", "Definir nova foto")
    firstField.hint = s.label("firstPh", "Nome (obrigatório)")
    lastField.hint = s.label("lastPh", "Sobrenome (opcional)")
    setCaption(nameFooter, s.label("nameFooter", ""))
    bioField.hint = s.label("bioPh", "Bio")
    setCaption(bioFooter, s.label("bioHint", "Você pode adicionar algumas linhas sobre você."))
    pronounsTitle.text = s.label("pronouns", "Pronomes")
    pronounsField.hint = s.label("pronounsPh", "ela/dela")
    linkTitle.text = s.label("link", "Link")
    linkField.hint = s.label("linkPh", "https://")
    aboutTitle.text = s.label("about", "Recado")
    aboutField.hint = s.label("aboutPh", "Disponível")
    setCaption(aboutFooter, s.label("aboutHint", ""))
    subTitle.text = s.label("usernameTitle", "Nome de usuário")
    subBack.text = s.label("back", "Voltar")
    subDone.text = s.label("done", "Concluído")
    unameField.hint = s.label("usernamePh", "usuario")
    setCaption(unameFooter, s.label("usernameHint", ""))
    setLimit(firstField, maxLen("first"))
    setLimit(lastField, maxLen("last"))
    setLimit(bioField, maxLen("bio"))
    setLimit(unameField, maxLen("username"))
    setLimit(pronounsField, maxLen("pronouns"))
    setLimit(linkField, maxLen("link"))
    setLimit(aboutField, maxLen("about"))
  }

  private fun setLimit(f: EditText, n: Int) {
    val cur = f.filters.firstOrNull { it is InputFilter.LengthFilter } as? InputFilter.LengthFilter
    if (cur != null && cur.max == n) return
    f.filters = arrayOf<InputFilter>(InputFilter.LengthFilter(n))
  }

  private fun setCaption(tv: TextView, text: String) {
    if (tv.text.toString() != text) tv.text = text
    val vis = if (text.isEmpty()) GONE else VISIBLE
    if (tv.visibility != vis) tv.visibility = vis
  }

  // ─── Valores ────────────────────────────────────────────────────────────

  private fun sanitizeUsername(s: String): String {
    val sb = StringBuilder()
    for (ch in s.lowercase()) {
      if ((ch in 'a'..'z') || (ch in '0'..'9') || ch == '_' || ch == '.') sb.append(ch)
    }
    return if (sb.length > 30) sb.substring(0, 30) else sb.toString()
  }

  private fun hydrate() {
    val v = state.values
    val init = HashMap<String, String>()
    for (k in listOf("first", "last", "bio", "username", "pronouns", "link", "about")) init[k] = v[k] ?: ""
    init["username"] = sanitizeUsername(init["username"] ?: "")
    initial = init
    hydrating = true
    firstField.setText(init["first"])
    lastField.setText(init["last"])
    bioField.setText(init["bio"])
    unameField.setText(init["username"])
    pronounsField.setText(init["pronouns"])
    linkField.setText(init["link"])
    aboutField.setText(init["about"])
    hydrating = false
    localErrors.clear()
    closeSub(false)
    scroll.scrollTo(0, 0)
  }

  private fun currentValues(): Map<String, String> = mapOf(
    "first" to firstField.text.toString(),
    "last" to lastField.text.toString(),
    "bio" to bioField.text.toString(),
    "username" to sanitizeUsername(unameField.text.toString()),
    "pronouns" to pronounsField.text.toString(),
    "link" to linkField.text.toString(),
    "about" to aboutField.text.toString()
  )

  private fun formDirty(): Boolean {
    for ((k, v) in currentValues()) if ((initial[k] ?: "") != v) return true
    return false
  }

  private fun maxLen(key: String): Int = when (key) {
    "first", "last" -> state.limit(key, 40)
    "bio" -> state.limit("bio", 150)
    "username" -> state.limit("username", 30)
    "pronouns" -> state.limit("pronouns", 40)
    "link" -> state.limit("link", 120)
    "about" -> state.limit("about", 139)
    else -> 500
  }

  private fun err(k: String): String {
    val l = localErrors[k]
    if (!l.isNullOrEmpty()) return l
    return state.errors[k] ?: ""
  }

  private fun emit(ev: Map<String, Any>) {
    try { onEvent?.invoke(ev) } catch (_: Throwable) {}
  }

  // ─── Estado dinâmico ────────────────────────────────────────────────────

  private fun applyDynamic() {
    val s = state
    val p = palette
    avatar.bind(CLRow(id = "edit-avatar", kind = "direct", title = s.values["first"] ?: "", tiles = listOf(s.pic.tile())), CLTheme(p.dark), p.pageBg)
    avatarDim.visibility = if (s.busyAvatar) VISIBLE else GONE
    avatarSpin.visibility = if (s.busyAvatar) VISIBLE else GONE
    val photoOn = !s.busyAvatar && !s.saving
    avatarFrame.isEnabled = photoOn
    setPhotoBtn.isEnabled = photoOn
    setPhotoBtn.alpha = if (photoOn) 1f else 0.5f

    doneBtn.visibility = if (s.saving) INVISIBLE else VISIBLE
    doneSpin.visibility = if (s.saving) VISIBLE else GONE
    cancelBtn.isEnabled = !s.saving
    cancelBtn.alpha = if (s.saving) 0.5f else 1f
    for (f in fields) f.isEnabled = !s.saving

    setCaption(generalError, err("general"))
    setCaption(nameError, err("first").ifEmpty { err("last") })
    setCaption(bioError, err("bio"))
    setCaption(detailsError, err("username").ifEmpty { err("pronouns") }.ifEmpty { err("link") })
    setCaption(aboutError, err("about"))

    refreshBio()
    bindUsernameRow()
    refreshUname()
    refreshPillSelection()

    val hasCover = s.coverUrl.isNotEmpty()
    coverRow.bind(s.label("cover", "Foto de capa"), if (hasCover) s.label("coverChange", "Alterar") else s.label("coverAdd", "Adicionar"), true, false, p)
    coverRow.setThumb(s.coverUrl, s.coverAuth)
    coverRow.setBusy(s.busyCover)
    coverRow.isEnabled = !s.busyCover && !s.saving
    coverRemoveRow.bind(s.label("coverRemove", "Remover foto de capa"), "", false, true, p)
    coverRemoveRow.visibility = if (hasCover) VISIBLE else GONE
    coverRemoveSep?.visibility = if (hasCover) VISIBLE else GONE
    coverRemoveRow.isEnabled = !s.busyCover && !s.saving

    // [2026-10-21 foto-capa-studio] capa grande no topo (apiVersion 7).
    val hero = s.coverHero
    coverHero.visibility = if (hero) VISIBLE else GONE
    (avatarFrame.layoutParams as? LinearLayout.LayoutParams)?.let { lp ->
      val tm = if (hero) -px(46f) else px(12f)
      if (lp.topMargin != tm) {
        lp.topMargin = tm
        avatarFrame.layoutParams = lp
      }
    }
    if (hero) {
      val ring = GradientDrawable()
      ring.shape = GradientDrawable.OVAL
      ring.setColor(Color.TRANSPARENT)
      ring.setStroke(px(4f), p.pageBg)
      avatarFrame.foreground = ring
    } else {
      avatarFrame.foreground = null
    }
    coverHero.bind(s.coverUrl, s.coverAuth, p.dark, if (hasCover) s.label("coverChange", "Alterar capa") else s.label("coverAdd", "Adicionar capa"), s.busyCover)
    coverHero.isEnabled = !s.busyCover && !s.saving
    coverCardGroup?.visibility = if (hero) GONE else VISIBLE
  }

  private fun bindUsernameRow() {
    val u = sanitizeUsername(unameField.text.toString())
    usernameRow.bind(state.label("username", "Usuário"), if (u.isEmpty()) state.label("usernameEmpty", "") else "@$u", true, false, palette)
  }

  private fun refreshBio() {
    val left = maxLen("bio") - bioField.text.length
    bioCounter.text = max(0, left).toString()
    bioCounter.setTextColor(if (left <= 10) palette.destructive else palette.secondary)
  }

  private fun refreshUname() {
    val s = state
    val u = sanitizeUsername(unameField.text.toString())
    var text = ""
    var color = palette.secondary
    var spin = false
    val e = err("username")
    if (e.isNotEmpty()) {
      text = e
      color = palette.destructive
    } else if (u.isEmpty() || u == (initial["username"] ?: "")) {
      text = ""
    } else if (u.length < 3) {
      text = s.label("usernameShort", "Mínimo de 3 caracteres.")
      color = palette.destructive
    } else if (s.unameQ == u) {
      text = s.unameText
      when (s.unameState) {
        "checking" -> spin = true
        "ok" -> color = palette.text
        "bad" -> color = palette.destructive
      }
    } else {
      text = s.label("usernameChecking", "Verificando…")
      spin = true
    }
    unameStatus.text = text
    unameStatus.setTextColor(color)
    unameSpin.visibility = if (spin) VISIBLE else GONE
    unameStatusRow.visibility = if (text.isEmpty()) GONE else VISIBLE
  }

  private fun pillBg(selected: Boolean): RippleDrawable {
    val p = palette
    val d = GradientDrawable()
    d.cornerRadius = 16f * density
    d.setColor(if (selected) p.text else p.chipBg)
    val mask = GradientDrawable()
    mask.cornerRadius = 16f * density
    mask.setColor(Color.WHITE)
    return RippleDrawable(ColorStateList.valueOf(p.ripple), d, mask)
  }

  private fun rebuildPills() {
    if (pillsApplied == state.presets) return
    pillsApplied = state.presets
    pillsBox.removeAllViews()
    pills.clear()
    state.presets.forEachIndexed { i, t ->
      val tv = ceText(context, 15f, 500)
      tv.text = t
      tv.gravity = Gravity.CENTER
      tv.setPadding(px(14f), 0, px(14f), 0)
      tv.isClickable = true
      tv.isFocusable = true
      tv.contentDescription = t
      tv.setOnClickListener {
        if (state.saving) return@setOnClickListener
        tv.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        aboutField.setText(t)
        aboutField.setSelection(aboutField.text.length)
      }
      pillsBox.addView(tv, mlp(LinearLayout.LayoutParams.WRAP_CONTENT, px(32f)).apply { if (i > 0) leftMargin = px(8f) })
      pills.add(tv)
    }
    pillsRow.visibility = if (pills.isEmpty()) GONE else VISIBLE
  }

  private fun refreshPillSelection() {
    val cur = aboutField.text.toString().trim()
    for (tv in pills) {
      val sel = tv.text.toString() == cur
      tv.background = pillBg(sel)
      tv.setTextColor(if (sel) palette.cardBg else palette.chipFg)
      tv.isSelected = sel
    }
  }

  private fun rebuildGroups() {
    if (groupsApplied == state.groups) return
    groupsApplied = state.groups
    for (i in 0 until groupsBox.childCount) {
      val g = groupsBox.getChildAt(i)
      // Cartões antigos saem da lista de pintura.
      if (g is LinearLayout) {
        for (j in 0 until g.childCount) cards.remove(g.getChildAt(j))
      }
    }
    groupsBox.removeAllViews()
    val p = palette
    for (g in state.groups) {
      val views = ArrayList<View>()
      if (g.header.isNotEmpty()) {
        val h = ceText(context, 13f, 400)
        h.text = g.header.uppercase()
        h.setTextColor(p.header)
        h.maxLines = 1
        h.setPadding(px(16f), 0, px(16f), px(8f))
        views.add(h)
      }
      val rows = ArrayList<View>()
      for (r in g.rows) {
        val row = CIEditNavRow(context)
        row.rowId = r.id
        row.bind(r.title, r.value, r.chevron, r.destructive, p)
        val id = r.id
        clickOf(row) { emit(mapOf("type" to "row", "id" to id)) }
        rows.add(row)
      }
      val card = cardOf(rows)
      val bg = GradientDrawable()
      bg.cornerRadius = 14f * density
      bg.setColor(p.cardBg)
      card.background = bg
      views.add(card)
      if (g.footer.isNotEmpty()) {
        val f = ceText(context, 13f, 400)
        f.setPadding(px(16f), px(8f), px(16f), 0)
        f.setLineSpacing(0f, 1.15f)
        f.text = g.footer
        f.setTextColor(p.secondary)
        views.add(f)
      }
      groupsBox.addView(groupOf(views, true))
    }
    groupsBox.visibility = if (state.groups.isEmpty()) GONE else VISIBLE
  }

  // ─── Mostrar / esconder ─────────────────────────────────────────────────

  private fun setShown(on: Boolean) {
    if (on == shown) return
    shown = on
    animate().cancel()
    if (on) {
      visibility = VISIBLE
      alpha = 0f
      mainView.translationY = 14f * density
      animate().alpha(1f).setDuration(220).start()
      mainView.animate().translationY(0f).setDuration(260).start()
      performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    } else {
      hideKeyboard()
      animate().alpha(0f).setDuration(180).withEndAction {
        if (!shown) {
          visibility = GONE
          closeSub(false)
        }
      }.start()
    }
  }

  private fun handleBack() {
    if (subOpen) closeSub(true) else cancelTapped()
  }

  private fun openSub() {
    if (subOpen || state.saving) return
    subOpen = true
    hideKeyboard()
    refreshUname()
    val w = max(1, width).toFloat()
    subView.visibility = VISIBLE
    subView.translationX = w
    subView.animate().translationX(0f).setDuration(280).withEndAction {
      if (subOpen) {
        unameField.requestFocus()
        unameField.setSelection(unameField.text.length)
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.showSoftInput(unameField, InputMethodManager.SHOW_IMPLICIT)
      }
    }.start()
    mainView.animate().translationX(-w * 0.3f).setDuration(280).start()
  }

  private fun closeSub(animated: Boolean) {
    if (!subOpen) {
      subView.visibility = GONE
      return
    }
    subOpen = false
    hideKeyboard()
    applyDynamic()
    val w = max(1, width).toFloat()
    if (!animated) {
      subView.animate().cancel()
      mainView.animate().cancel()
      subView.translationX = 0f
      subView.visibility = GONE
      mainView.translationX = 0f
      return
    }
    subView.animate().translationX(w).setDuration(260).withEndAction {
      if (!subOpen) {
        subView.visibility = GONE
        subView.translationX = 0f
      }
    }.start()
    mainView.animate().translationX(0f).setDuration(260).start()
  }

  // ─── Ações ──────────────────────────────────────────────────────────────

  private fun cancelTapped() {
    if (state.saving) return
    if (subOpen) { closeSub(true); return }
    hideKeyboard()
    emit(mapOf("type" to "cancel", "dirty" to formDirty()))
  }

  private fun doneTapped() {
    if (state.saving) return
    if (subOpen) closeSub(true)
    hideKeyboard()
    localErrors.clear()
    val v = currentValues()
    val full = ((v["first"] ?: "") + (v["last"] ?: "")).trim()
    if (full.isEmpty()) localErrors["first"] = state.label("errName", "Informe seu nome.")
    val u = v["username"] ?: ""
    if (u.isNotEmpty() && u.length < 3) localErrors["username"] = state.label("usernameShort", "Mínimo de 3 caracteres.")
    if (localErrors.isNotEmpty()) {
      performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      applyDynamic()
      val target: View = if (localErrors.containsKey("first")) firstField else usernameRow
      post { ensureVisible(target) }
      return
    }
    performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    emit(mapOf("type" to "done", "values" to v))
  }

  private fun avatarTapped() {
    if (state.busyAvatar || state.saving) return
    hideKeyboard()
    emit(mapOf("type" to "avatar"))
  }

  private fun fieldChanged(key: String, f: EditText) {
    if (key == "username") {
      val raw = f.text.toString()
      val clean = sanitizeUsername(if (raw.startsWith("@")) raw.substring(1) else raw)
      if (clean != raw) {
        hydrating = true
        f.setText(clean)
        f.setSelection(clean.length)
        hydrating = false
      }
    }
    localErrors.remove(key)
    val value = if (key == "username") sanitizeUsername(f.text.toString()) else f.text.toString()
    emit(mapOf("type" to "change", "field" to key, "value" to value))
    when (key) {
      "about" -> refreshPillSelection()
      "username" -> {
        refreshUname()
        bindUsernameRow()
      }
      "bio" -> refreshBio()
      "first", "last" -> setCaption(nameError, err("first").ifEmpty { err("last") })
    }
  }

  // ─── Teclado ────────────────────────────────────────────────────────────

  private fun hideKeyboard() {
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.hideSoftInputFromWindow(windowToken, 0)
    findFocus()?.clearFocus()
  }

  private fun ensureVisible(v: View) {
    if (!v.isAttachedToWindow) return
    val sv = if (isDescendant(v, subView)) subScroll else scroll
    val r = Rect()
    v.getDrawingRect(r)
    try {
      sv.offsetDescendantRectToMyCoords(v, r)
    } catch (_: Throwable) {
      return
    }
    val pad = px(24f)
    val visTop = sv.scrollY
    val visBottom = sv.scrollY + sv.height - sv.paddingBottom
    if (r.bottom + pad > visBottom) {
      sv.smoothScrollTo(0, r.bottom + pad - (sv.height - sv.paddingBottom))
    } else if (r.top - pad < visTop) {
      sv.smoothScrollTo(0, max(0, r.top - pad))
    }
  }

  private fun isDescendant(v: View, root: View): Boolean {
    var cur: Any? = v
    while (cur is View) {
      if (cur === root) return true
      cur = cur.parent
    }
    return false
  }

  /** Teclado por cima da view (com ou sem adjustResize / edge-to-edge). */
  private fun measureIme() {
    if (!shown) return
    val root = rootView ?: return
    val ins = ViewCompat.getRootWindowInsets(this)
    val ime = ins?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
    val loc = IntArray(2)
    getLocationInWindow(loc)
    val below = root.height - (loc[1] + height)
    val overlap = max(0, ime - max(0, below))
    if (overlap != imePx) {
      imePx = overlap
      refreshInsets()
      if (overlap > 0) findFocus()?.let { f -> post { ensureVisible(f) } }
    }
  }

  private fun refreshInsets() {
    val b = max(bottomInsetPx, imePx) + px(24f)
    if (scroll.paddingBottom != b) scroll.setPadding(0, 0, 0, b)
    if (subScroll.paddingBottom != b) subScroll.setPadding(0, 0, 0, b)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    viewTreeObserver.addOnGlobalLayoutListener(layoutListener)
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnGlobalLayoutListener(layoutListener)
    super.onDetachedFromWindow()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    // Tablet / tela larga: coluna centrada de no máximo 640 dp.
    val maxW = px(640f)
    val side = if (w > maxW + px(32f)) (w - maxW) / 2 else px(16f)
    if (content.paddingLeft != side) {
      content.setPadding(side, px(8f), side, px(8f))
      subContent.setPadding(side, px(8f), side, px(8f))
    }
  }
}
