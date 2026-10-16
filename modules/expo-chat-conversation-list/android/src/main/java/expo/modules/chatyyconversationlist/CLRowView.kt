package expo.modules.chatyyconversationlist

// [2026-10-14 native-home] Linha da conversa (Android). ViewGroup com layout
// manual (sem ConstraintLayout/medições aninhadas): altura fixa por escala de
// fonte, então o RecyclerView não remede nada no scroll. Visual = ConversationRow
// do ChatListTab.js (avatar 54, gutter 16, gap 14, nome 16, prévia 14, hora 12
// tabular, pílula 22, ícones 15; linha inset entre linhas desenhada pela lista — wave13).

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.core.view.ViewCompat
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

@SuppressLint("ViewConstructor")
internal class CLRowView(ctx: Context) : ViewGroup(ctx) {
  interface Listener {
    fun onPress(id: String)
    fun onPressIn(id: String)
    fun onAvatar(id: String)
    fun onLongPress(id: String, anchor: View)
    fun onA11yAction(id: String, action: String)
  }

  var listener: Listener? = null

  private val d = ctx.resources.displayMetrics.density
  private val fontScale = ctx.resources.configuration.fontScale
  private fun px(v: Float): Int = (v * d + 0.5f).toInt()
  private fun sp(size: Float, cap: Float): Float = size * d * min(max(fontScale, 0.85f), cap)

  val avatar = CLAvatarView(ctx)
  private val check = CLCheckView(ctx)
  private val nameTv = label(16f, 1.35f, 600)
  private val activityTv = label(12f, 1.3f, 500)
  private val timeTv = label(12f, 1.3f, 400)
  private val previewTv = label(14f, 1.3f, 400)
  private val lockIv = ImageView(ctx)
  private val clockIv = ImageView(ctx)
  private val muteIv = ImageView(ctx)
  private val pinIv = ImageView(ctx)
  private val receipt = CLReceiptView(ctx)
  private val typing = CLTypingDots(ctx)
  private val mentionTv = label(13f, 1.15f, 800)
  // [2026-10-16 wave8-list] contador desenhado (dígitos rolando)
  private val unreadTv = CLCounterView(ctx)
  private val mentionBg = GradientDrawable()
  private val rowBgDrawable = ColorDrawable(0xFFFFFFFF.toInt())
  // [2026-10-16 wave13 swipe-ios] linha arrastada = cinza + cantos arredondados
  // (UICellConfigurationState.isSwiped do iOS: #F0F0F0 / #1A1A1A).
  private var swiped = false
  private var baseBg = 0xFFFFFFFF.toInt()
  private val swipeOutline = object : android.view.ViewOutlineProvider() {
    override fun getOutline(view: View, outline: android.graphics.Outline) {
      outline.setRoundRect(0, 0, view.width, view.height, px(22f).toFloat())
    }
  }

  private val tfName = CLType.weight(600)
  private val tfNameBold = CLType.weight(700)
  private val tfTime = CLType.weight(400)
  private val tfTimeBold = CLType.weight(700)
  private val tfMedium = CLType.weight(500)
  private val tfSemibold = CLType.weight(600)

  var row = CLRow()
    private set
  private var theme = CLTheme(false)
  private var labels = CLLabels()
  private var selectionMode = false
  private val a11yIds = ArrayList<Int>()

  private val rowHeight: Int

  init {
    clipChildren = false
    clipToPadding = false
    isClickable = true
    isLongClickable = true
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    addView(check)
    addView(avatar)
    for (v in listOf(nameTv, activityTv, timeTv, previewTv, mentionTv)) addView(v)
    addView(unreadTv)
    for (iv in listOf(lockIv, clockIv, muteIv, pinIv)) {
      iv.scaleType = ImageView.ScaleType.FIT_CENTER
      addView(iv)
    }
    addView(receipt)
    addView(typing)
    timeTv.fontFeatureSettings = "tnum"
    unreadTv.setTextSizePx(sp(12f, 1.15f))
    unreadTv.setTypeface(CLType.weight(700))
    timeTv.gravity = Gravity.END
    mentionTv.gravity = Gravity.CENTER
    mentionTv.text = "@"
    mentionBg.cornerRadius = px(11f).toFloat()
    mentionTv.background = mentionBg
    for (i in 0 until childCount) {
      getChildAt(i).importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }
    val nameLine = nameTv.lineHeight
    val prevLine = previewTv.lineHeight
    rowHeight = max(px(74f), px(20f) + nameLine + px(4f) + prevLine + px(2f))

    setOnClickListener { listener?.onPress(row.id) }
    setOnLongClickListener {
      performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
      listener?.onLongPress(row.id, this)
      true
    }
    avatar.setOnClickListener {
      if (selectionMode || row.isGroupish) performClick() else listener?.onAvatar(row.id)
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
    tv.letterSpacing = if (size >= 16f) -0.3f / size else 0f
    return tv
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
    if (ev.actionMasked == MotionEvent.ACTION_DOWN && !selectionMode) {
      // Pré-carrega a conversa no toque (o JS usa onPressIn para isso).
      listener?.onPressIn(row.id)
    }
    return false
  }

  fun bind(r: CLRow, t: CLTheme, l: CLLabels, selection: Boolean, animate: Boolean) {
    val prev: CLRow? = if (animate && r.id == row.id && row.id.isNotEmpty()) row else null
    row = r
    theme = t
    labels = l
    selectionMode = selection
    val unread = r.unread > 0

    // Fundo + ripple (cinza discreto)
    val base = when {
      selection && r.selected -> t.selectedBg
      r.pinned -> t.pinnedBg
      else -> t.bg
    }
    baseBg = base
    rowBgDrawable.color = if (swiped) swipeBg() else base
    if (background !is RippleDrawable) {
      background = RippleDrawable(ColorStateList.valueOf(t.press), rowBgDrawable, null)
    } else {
      (background as RippleDrawable).setColor(ColorStateList.valueOf(t.press))
    }

    avatar.bind(r, t, base)
    avatar.isClickable = !selection && !r.isGroupish
    check.visibility = if (selection) VISIBLE else GONE
    check.checked = r.selected
    check.onColor = t.pillBg
    check.tickColor = t.pillTxt
    check.borderTint = t.checkBorder

    nameTv.text = r.title
    nameTv.typeface = if (unread) tfNameBold else tfName
    nameTv.setTextColor(t.text)
    activityTv.visibility = if (r.activity.isNotEmpty() && !r.isGroupish) VISIBLE else GONE
    activityTv.text = r.activity
    activityTv.setTextColor(t.sub)

    timeTv.text = r.time
    timeTv.typeface = if (r.timeBold) tfTimeBold else tfTime
    timeTv.setTextColor(if (r.timeBold) t.text else t.sub)

    lockIv.visibility = if (r.locked) VISIBLE else GONE
    if (r.locked) lockIv.setImageDrawable(tintedIcon(context, R.drawable.ccl_ic_lock, t.icon))

    val isTyping = r.typing.isNotEmpty() && !r.locked
    val drafting = !isTyping && r.draft.isNotEmpty() && !r.locked
    typing.color = t.text
    typing.setActive(isTyping)

    val showReceipt = !isTyping && !drafting && !r.locked && r.receipt > 0
    receipt.sentColor = t.receiptSent
    receipt.grayColor = t.receiptGray
    receipt.readColor = t.receiptRead
    receipt.update(if (showReceipt) r.receipt else 0, prev != null && prev.receipt != r.receipt)

    val sched = r.scheduled && !isTyping && !drafting && !r.locked
    clockIv.visibility = if (sched) VISIBLE else GONE
    if (sched) clockIv.setImageDrawable(tintedIcon(context, R.drawable.ccl_ic_clock, t.sub))

    previewTv.text = buildPreview(isTyping, drafting, unread)
    // [2026-10-16 wave8-list] "digitando…" entra/sai num fade curto.
    if (prev != null && prev.typing.isEmpty() != r.typing.isEmpty() && !CLMotion.reduced(context)) {
      previewTv.alpha = 0.35f
      previewTv.animate().alpha(1f).setDuration(180).start()
    } else if (prev == null) {
      previewTv.animate().cancel()
      previewTv.alpha = 1f
    }

    muteIv.visibility = if (r.muted) VISIBLE else GONE
    if (r.muted) muteIv.setImageDrawable(tintedIcon(context, R.drawable.ccl_ic_bell_off, t.icon))
    if (prev != null && prev.muted != r.muted && r.muted) {
      muteIv.alpha = 0f
      muteIv.animate().alpha(1f).setDuration(200).start()
    } else {
      muteIv.alpha = 1f
    }
    pinIv.visibility = if (r.pinned) VISIBLE else GONE
    if (r.pinned) pinIv.setImageDrawable(tintedIcon(context, R.drawable.ccl_ic_pin, t.icon))

    mentionTv.visibility = if (r.mention) VISIBLE else GONE
    mentionBg.setColor(t.pillBg)
    mentionTv.setTextColor(t.pillTxt)

    unreadTv.visibility = if (unread) VISIBLE else GONE
    val mutedPill = r.muted && !r.mention
    unreadTv.bgColor = if (mutedPill) t.mutedPillBg else t.pillBg
    unreadTv.textColor = if (mutedPill) t.mutedPillTxt else t.pillTxt
    // Rola só com a pílula já na tela (2→3 sobe, 3→2 desce); nova = só "pula".
    if (prev == null) unreadTv.cancelRoll()
    val rollPill = prev != null && prev.unread > 0 && unread && prev.unread != r.unread
    unreadTv.setCount(if (r.unread > 99) "99+" else r.unread.toString(), rollPill)

    if (prev != null) {
      if (r.unread > prev.unread && unread) pop(unreadTv)
      if (r.mention && !prev.mention) pop(mentionTv)
    }

    // Acessibilidade: a linha é UM elemento + ações nomeadas (TalkBack).
    contentDescription = if (r.a11y.isNotEmpty()) r.a11y else r.title
    isSelected = selection && r.selected
    for (id in a11yIds) ViewCompat.removeAccessibilityAction(this, id)
    a11yIds.clear()
    if (!selection) {
      val acts = ArrayList<Pair<String, String>>()
      acts.add("toggleRead" to (if (unread) l.get("markRead", "Marcar como lida") else l.get("markUnread", "Marcar como não lida")))
      acts.add("pin" to (if (r.pinned) l.get("unpin", "Desafixar") else l.get("pin", "Fixar")))
      acts.add("mute" to (if (r.muted) l.get("unmute", "Reativar som") else l.get("mute", "Silenciar")))
      acts.add("archive" to (if (r.archived) l.get("unarchive", "Desarquivar") else l.get("archive", "Arquivar")))
      acts.add("delete" to l.get("delete", "Apagar"))
      if (!r.isGroupish && r.kind != "saved") {
        acts.add("photo" to (if (r.ring.isEmpty()) l.get("viewPhoto", "Ver foto do perfil") else l.get("viewStatus", "Ver status")))
      }
      acts.add("more" to l.get("more", "Mais opções"))
      for ((action, title) in acts) {
        val rid = r.id
        val id = ViewCompat.addAccessibilityAction(this, title) { _, _ ->
          listener?.onA11yAction(rid, action)
          true
        }
        if (id != View.NO_ID) a11yIds.add(id)
      }
    }
    requestLayout()
    invalidate()
  }

  private fun swipeBg(): Int = if (theme.dark) 0xFF1A1A1A.toInt() else 0xFFF0F0F0.toInt()

  /** [wave13 swipe-ios] Visual da linha enquanto arrastada/aberta. */
  fun setSwiped(on: Boolean) {
    if (swiped == on) return
    swiped = on
    rowBgDrawable.color = if (on) swipeBg() else baseBg
    if (on) {
      outlineProvider = swipeOutline
      clipToOutline = true
    } else {
      clipToOutline = false
      outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
    }
    invalidateOutline()
    invalidate()
  }

  private fun pop(v: View) {
    v.scaleX = 0.8f
    v.scaleY = 0.8f
    val sx = ObjectAnimator.ofFloat(v, View.SCALE_X, 0.8f, 1.2f, 1f)
    val sy = ObjectAnimator.ofFloat(v, View.SCALE_Y, 0.8f, 1.2f, 1f)
    val set = AnimatorSet()
    set.playTogether(sx, sy)
    set.duration = 320
    set.start()
  }

  private fun appendIcon(sb: SpannableStringBuilder, res: Int, color: Int) {
    val dr = tintedIcon(context, res, color) ?: return
    val size = (previewTv.textSize * 0.95f).toInt()
    val start = sb.length
    sb.append("⁠")
    sb.setSpan(CLIconSpan(dr, size, px(4f)), start, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  }

  private fun styled(sb: SpannableStringBuilder, text: String, color: Int, tf: android.graphics.Typeface?) {
    if (text.isEmpty()) return
    val start = sb.length
    sb.append(text)
    sb.setSpan(ForegroundColorSpan(color), start, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    if (tf != null) sb.setSpan(CLTypefaceSpan(tf), start, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  }

  private fun buildPreview(isTyping: Boolean, drafting: Boolean, unread: Boolean): CharSequence {
    val r = row
    val t = theme
    val sb = SpannableStringBuilder()
    if (r.locked) {
      appendIcon(sb, R.drawable.ccl_ic_lock, t.sub)
      styled(sb, r.text, t.sub, null)
      return sb
    }
    if (isTyping) {
      styled(sb, r.typing, t.text, tfMedium)
      return sb
    }
    if (drafting) {
      var head = if (r.draftLabel.isNotEmpty()) r.draftLabel else labels.get("draft", "Rascunho")
      if (r.draftAge.isNotEmpty()) head += " · " + r.draftAge
      styled(sb, "$head: ", if (r.draftFresh) t.text else t.sub, tfSemibold)
      styled(sb, r.draft, t.sub, null)
      return sb
    }
    val body = if (unread) t.subStrong else t.sub
    if (r.sender.isNotEmpty()) styled(sb, r.sender + ": ", if (unread) t.text else t.sub, tfMedium)
    val icon = CLIcons.preview(r.icon)
    if (icon != 0) appendIcon(sb, icon, body)
    val txt = if (r.text.isEmpty() && r.sender.isEmpty() && r.icon.isEmpty()) r.empty else r.text
    if (r.icon == "ban") {
      // [wave13-C] mensagem apagada: ⊘ + itálico (como o WhatsApp)
      val st = sb.length
      styled(sb, txt, body, null)
      if (sb.length > st) sb.setSpan(android.text.style.StyleSpan(android.graphics.Typeface.ITALIC), st, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    } else styled(sb, txt, body, null)
    return sb
  }

  // ─── Medida / layout ─────────────────────────────────────────────────────

  private val unspec = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
  private fun exactly(v: Int) = MeasureSpec.makeMeasureSpec(max(0, v), MeasureSpec.EXACTLY)
  private fun atMost(v: Int) = MeasureSpec.makeMeasureSpec(max(0, v), MeasureSpec.AT_MOST)

  private var cTextX = 0
  private var cNameW = 0
  private var cActW = 0
  private var cPrevX = 0
  private var cPrevW = 0

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = rowHeight
    var x = px(16f)
    if (selectionMode) {
      check.measure(exactly(px(26f)), exactly(px(26f)))
      x += px(36f)
    } else {
      check.measure(exactly(0), exactly(0))
    }
    val box = px(54f)
    avatar.measure(exactly(box), exactly(box))
    val textX = x + box + px(14f)
    val right = w - px(16f)

    timeTv.measure(unspec, unspec)
    var rx = right - timeTv.measuredWidth
    val icon = px(15f)
    if (lockIv.visibility == VISIBLE) {
      lockIv.measure(exactly(px(13f)), exactly(px(13f)))
      rx -= px(5f) + px(13f)
    }
    val nameMax = max(0, rx - px(10f) - textX)
    var aw = 0
    if (activityTv.visibility == VISIBLE) {
      activityTv.measure(unspec, unspec)
      aw = min(activityTv.measuredWidth, px(90f))
      activityTv.measure(exactly(aw), unspec)
    }
    nameTv.measure(atMost(max(0, nameMax - (if (aw > 0) aw + px(6f) else 0))), unspec)
    cNameW = nameTv.measuredWidth
    cActW = aw

    var bx = right
    val pillH = px(22f)
    if (unreadTv.visibility == VISIBLE) {
      unreadTv.measure(unspec, exactly(pillH))
      val pw = max(pillH, unreadTv.measuredWidth)
      unreadTv.measure(exactly(pw), exactly(pillH))
      bx -= pw + px(6f)
    }
    if (mentionTv.visibility == VISIBLE) {
      mentionTv.measure(exactly(pillH), exactly(pillH))
      bx -= pillH + px(6f)
    }
    if (pinIv.visibility == VISIBLE) {
      pinIv.measure(exactly(icon), exactly(icon))
      bx -= icon + px(6f)
    }
    if (muteIv.visibility == VISIBLE) {
      muteIv.measure(exactly(icon), exactly(icon))
      bx -= icon + px(6f)
    }
    val previewRight = if (bx < right) bx + px(6f) - px(10f) else right
    var pxX = textX
    if (typing.visibility == VISIBLE) {
      typing.measure(exactly(px(18f)), exactly(px(8f)))
      pxX += px(18f) + px(6f)
    }
    if (clockIv.visibility == VISIBLE) {
      clockIv.measure(exactly(px(14f)), exactly(px(14f)))
      pxX += px(14f) + px(4f)
    }
    if (receipt.visibility == VISIBLE) {
      receipt.measure(exactly(px(22f)), exactly(px(15f)))
      pxX += receipt.contentWidth + px(3f)
    }
    cPrevX = pxX
    cPrevW = max(0, previewRight - pxX)
    previewTv.measure(exactly(cPrevW), unspec)
    cTextX = textX
    setMeasuredDimension(w, h)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val h = b - t
    var x = px(16f)
    if (selectionMode) {
      val s = px(26f)
      check.layout(x, (h - s) / 2, x + s, (h - s) / 2 + s)
      x += px(36f)
    } else {
      check.layout(0, 0, 0, 0)
    }
    val box = px(54f)
    val ay = (h - box) / 2
    avatar.layout(x, ay, x + box, ay + box)
    val textX = cTextX
    val right = w - px(16f)

    val nameH = nameTv.measuredHeight
    val prevH = previewTv.measuredHeight + px(2f)
    val total = nameH + px(4f) + prevH
    val top = (h - total) / 2

    // Linha de cima (alinhamento por baseline com o nome)
    val nameBase = top + nameTv.baseline
    val tw = timeTv.measuredWidth
    val timeTop = nameBase - timeTv.baseline
    timeTv.layout(right - tw, timeTop, right, timeTop + timeTv.measuredHeight)
    var rx = right - tw
    if (lockIv.visibility == VISIBLE) {
      val s = px(13f)
      val ly = top + (nameH - s) / 2
      lockIv.layout(rx - px(5f) - s, ly, rx - px(5f), ly + s)
      rx -= px(5f) + s
    }
    nameTv.layout(textX, top, textX + cNameW, top + nameH)
    if (activityTv.visibility == VISIBLE) {
      val ax = textX + cNameW + px(6f)
      val at = nameBase - activityTv.baseline
      activityTv.layout(ax, at, ax + cActW, at + activityTv.measuredHeight)
    }

    // Linha de baixo
    val by = top + nameH + px(4f)
    val cy = by + prevH / 2
    var bx = right
    val pillH = px(22f)
    if (unreadTv.visibility == VISIBLE) {
      val pw = unreadTv.measuredWidth
      unreadTv.layout(bx - pw, cy - pillH / 2, bx, cy - pillH / 2 + pillH)
      bx -= pw + px(6f)
    }
    if (mentionTv.visibility == VISIBLE) {
      mentionTv.layout(bx - pillH, cy - pillH / 2, bx, cy - pillH / 2 + pillH)
      bx -= pillH + px(6f)
    }
    val icon = px(15f)
    if (pinIv.visibility == VISIBLE) {
      pinIv.layout(bx - icon, cy - icon / 2, bx, cy - icon / 2 + icon)
      bx -= icon + px(6f)
    }
    if (muteIv.visibility == VISIBLE) {
      muteIv.layout(bx - icon, cy - icon / 2, bx, cy - icon / 2 + icon)
      bx -= icon + px(6f)
    }
    var px0 = textX
    if (typing.visibility == VISIBLE) {
      typing.layout(px0, cy - px(4f), px0 + px(18f), cy + px(4f))
      px0 += px(18f) + px(6f)
    }
    if (clockIv.visibility == VISIBLE) {
      val s = px(14f)
      clockIv.layout(px0, cy - s / 2, px0 + s, cy - s / 2 + s)
      px0 += s + px(4f)
    }
    if (receipt.visibility == VISIBLE) {
      val rh = px(15f)
      receipt.layout(px0, cy - rh / 2, px0 + px(22f), cy - rh / 2 + rh)
      px0 += receipt.contentWidth + px(3f)
    }
    val ph = previewTv.measuredHeight
    previewTv.layout(cPrevX, cy - ph / 2, cPrevX + cPrevW, cy - ph / 2 + ph)
  }

  override fun hasOverlappingRendering(): Boolean = false

  companion object {
    @Suppress("unused")
    private fun ceilInt(v: Float): Int = ceil(v).toInt()
  }
}
