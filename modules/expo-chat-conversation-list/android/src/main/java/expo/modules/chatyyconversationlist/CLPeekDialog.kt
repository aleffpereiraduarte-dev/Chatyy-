package expo.modules.chatyyconversationlist

// [2026-10-16 wave8-list] Prévia (peek) do toque longo no ANDROID, estilo
// Telegram: janela por cima do app (fundo escurecido + blur de janela no
// Android 12+), cartão com as últimas mensagens da conversa e a lista de ações
// logo abaixo. Toque no cartão = abre a conversa; toque fora / voltar = fecha.
// Mesmo dado do iOS (CLPeekController.swift): abre na hora com a prévia da
// linha e se completa quando o JS responde ao onPeekRequest (prop `peek`).
// Só com a prop peekMode = "peek" (o JS liga; binário/JS antigos = PopupMenu).
// [2026-10-17 peek-fit] Igual ao iOS: o MENU sempre inteiro (todas as ações,
// Bloquear/Denunciar/Apagar inclusos); a prévia tem altura máxima
// min(45% da tela, tela − barras − menu) e mostra as ÚLTIMAS mensagens
// ancoradas embaixo (fade no topo); mídia com miniatura real, hora e recibo
// ✓/✓✓/azul em todos os balões. Se nem o menu couber, ele rola.

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import android.widget.TextView
import kotlin.math.max
import kotlin.math.min

internal class CLPeekDialog(
  private val activity: Activity,
  private val row: CLRow,
  private val theme: CLTheme,
  private val labels: CLLabels,
  private val onOpen: () -> Unit,
  private val onAction: (String) -> Unit,
  private val onClosed: () -> Unit
) {
  val convId: String = row.id

  private class Msg(
    val mine: Boolean, val text: String, val time: String, val sender: String,
    val receipt: Int = 0, val kind: String = "", val uri: String = "", val caption: String = "",
    val w: Double = 0.0, val h: Double = 0.0
  ) {
    val isMedia: Boolean get() = uri.isNotEmpty() && (kind == "image" || kind == "video" || kind == "gif" || kind == "sticker")
  }

  private val density = activity.resources.displayMetrics.density
  private fun px(v: Float): Int = (v * density + 0.5f).toInt()
  private val dialog = Dialog(activity, android.R.style.Theme_Translucent_NoTitleBar)
  private val column = LinearLayout(activity)
  private val msgScroll = ScrollView(activity)
  private val msgBox = LinearLayout(activity)
  private var menuScroll: ScrollView? = null
  private var menuView: View? = null
  private var messages: List<Msg> = emptyList()
  private var cardW = 0
  private var closed = false
  private val headerH get() = px(56f)

  private val chatBg = if (theme.dark) Color.parseColor("#0B0B0B") else Color.parseColor("#EFEFEF")
  private val headerBg = if (theme.dark) Color.parseColor("#1C1C1E") else Color.parseColor("#F7F7F7")
  private val menuBg = if (theme.dark) Color.parseColor("#1C1C1E") else Color.WHITE

  fun show(): Boolean {
    return try {
      build()
      dialog.setOnDismissListener {
        if (!closed) { closed = true; onClosed() }
      }
      dialog.show()
      dialog.window?.let { w ->
        w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        w.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        if (Build.VERSION.SDK_INT >= 31) {
          // Blur do que está atrás da janela (ignorado se o aparelho desligou).
          w.addFlags(WindowManager.LayoutParams.FLAG_BLUR_BEHIND)
          val a = w.attributes
          a.blurBehindRadius = px(22f)
          w.attributes = a
        }
      }
      animateIn()
      true
    } catch (_: Throwable) {
      try { dialog.dismiss() } catch (_: Throwable) {}
      false
    }
  }

  fun dismiss() {
    try { if (dialog.isShowing) dialog.dismiss() } catch (_: Throwable) {}
  }

  fun update(m: Map<String, Any?>) {
    if (CLVal.str(m["id"]) != convId) return
    val items = CLVal.list(m["items"])?.mapNotNull { CLVal.map(it) } ?: return
    if (items.isEmpty()) return
    messages = items.takeLast(12).map {
      Msg(CLVal.bool(it["m"]), CLVal.str(it["t"]), CLVal.str(it["h"]), CLVal.str(it["s"]),
        CLVal.int(it["r"]), CLVal.str(it["k"]), CLVal.str(it["u"]), CLVal.str(it["c"]),
        CLVal.double(it["w"]), CLVal.double(it["h2"]))
    }
    rebuildMessages()
    fitHeights()
  }

  // ─── Montagem ──────────────────────────────────────────────────────────────

  private fun rounded(color: Int, radiusDp: Float): GradientDrawable =
    GradientDrawable().apply { setColor(color); cornerRadius = px(radiusDp).toFloat() }

  private fun build() {
    val dm = activity.resources.displayMetrics
    cardW = min(dm.widthPixels - px(32f), px(420f))

    val root = FrameLayout(activity)
    val blurOk = Build.VERSION.SDK_INT >= 31
    root.setBackgroundColor(if (blurOk) Color.argb(70, 0, 0, 0) else Color.argb(110, 0, 0, 0))
    root.setOnClickListener { dismiss() }

    column.orientation = LinearLayout.VERTICAL
    column.gravity = Gravity.END
    column.isClickable = true // toque no espaço entre cartão e menu não fecha

    // Cartão: cabeçalho (avatar + nome) + balões.
    val card = LinearLayout(activity)
    card.orientation = LinearLayout.VERTICAL
    card.background = rounded(chatBg, 18f)
    card.clipToOutline = true
    card.isClickable = true
    card.setOnClickListener {
      onOpen()
      dismiss()
    }
    val header = LinearLayout(activity)
    header.orientation = LinearLayout.HORIZONTAL
    header.gravity = Gravity.CENTER_VERTICAL
    header.setBackgroundColor(headerBg)
    header.setPadding(px(12f), 0, px(12f), 0)
    val av = CLAvatarView(activity)
    av.setBoxDp(36f)
    av.bind(row.copy(online = false, note = ""), theme, headerBg)
    header.addView(av, LinearLayout.LayoutParams(px(36f), px(36f)))
    val title = TextView(activity)
    title.text = row.title
    title.setTextColor(theme.text)
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    title.typeface = CLType.weight(600)
    title.maxLines = 1
    title.ellipsize = TextUtils.TruncateAt.END
    val tlp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    tlp.marginStart = px(10f)
    header.addView(title, tlp)
    card.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, headerH))

    msgBox.orientation = LinearLayout.VERTICAL
    msgBox.setPadding(px(10f), px(10f), px(10f), px(12f))
    msgScroll.isVerticalScrollBarEnabled = false
    msgScroll.overScrollMode = View.OVER_SCROLL_NEVER
    msgScroll.isVerticalFadingEdgeEnabled = true
    msgScroll.setFadingEdgeLength(px(32f))
    // Prévia não rola sozinha p/ cima (é só uma espiada); toque = abrir.
    msgScroll.setOnTouchListener { v, e ->
      if (e.action == android.view.MotionEvent.ACTION_UP) v.performClick()
      true
    }
    msgScroll.setOnClickListener { onOpen(); dismiss() }
    msgScroll.addView(msgBox, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    card.addView(msgScroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    if (messages.isEmpty()) seedFromRow()
    rebuildMessages()
    column.addView(card, LinearLayout.LayoutParams(cardW, ViewGroup.LayoutParams.WRAP_CONTENT))

    // Ações: as MESMAS do menu iOS / PopupMenu (CLMenu.kt), todas visíveis.
    // "Mais" abre o menu completo do JS (silenciar por…, listas, limpar…).
    val menu = LinearLayout(activity)
    menu.orientation = LinearLayout.VERTICAL
    val unread = row.unread > 0
    val items = ArrayList<Triple<String, String, Boolean>>()
    items.add(Triple("toggleRead", if (unread) labels.get("markRead", "Marcar como lida") else labels.get("markUnread", "Marcar como não lida"), false))
    items.add(Triple("pin", if (row.pinned) labels.get("unpin", "Desafixar") else labels.get("pin", "Fixar"), false))
    items.add(Triple("mute", if (row.muted) labels.get("unmute", "Reativar som") else labels.get("mute", "Silenciar"), false))
    items.add(Triple("archive", if (row.archived) labels.get("unarchive", "Desarquivar") else labels.get("archive", "Arquivar"), false))
    items.add(Triple("lock", if (row.lockOn) labels.get("unlockChat", "Destrancar conversa") else labels.get("lockChat", "Trancar conversa"), false))
    items.add(Triple("more", labels.get("more", "Mais opções"), false))
    if (row.blockLabel.isNotEmpty()) items.add(Triple("block", row.blockLabel, true))
    items.add(Triple("report", labels.get("report", "Denunciar"), true))
    items.add(Triple("delete", labels.get("delete", "Apagar"), true))
    val hair = if (theme.dark) Color.argb(30, 255, 255, 255) else Color.argb(26, 0, 0, 0)
    items.forEachIndexed { i, (action, label, destructive) ->
      if (i > 0) {
        val group = destructive && !items[i - 1].third
        val sep = View(activity)
        sep.setBackgroundColor(hair)
        menu.addView(sep, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, if (group) px(6f) else maxOf(1, px(0.5f))))
      }
      val tv = TextView(activity)
      tv.text = label
      tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
      tv.setTextColor(if (destructive) CLTheme.SWIPE_DELETE else theme.text)
      tv.gravity = Gravity.CENTER_VERTICAL
      tv.setPadding(px(16f), px(6f), px(16f), px(6f))
      tv.minHeight = px(46f)
      tv.maxLines = 2
      tv.ellipsize = TextUtils.TruncateAt.END
      tv.background = RippleDrawable(ColorStateList.valueOf(theme.press), null, ColorDrawable(Color.WHITE))
      tv.setOnClickListener {
        onAction(action)
        dismiss()
      }
      menu.addView(tv, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    val ms = ScrollView(activity)
    ms.isVerticalScrollBarEnabled = false
    ms.overScrollMode = View.OVER_SCROLL_NEVER
    ms.background = rounded(menuBg, 14f)
    ms.clipToOutline = true
    ms.addView(menu, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    val mlp = LinearLayout.LayoutParams(min(px(250f), cardW), ViewGroup.LayoutParams.WRAP_CONTENT)
    mlp.topMargin = px(8f)
    column.addView(ms, mlp)
    menuScroll = ms
    menuView = menu

    val clp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER)
    root.addView(column, clp)
    dialog.setContentView(root)
    dialog.setCanceledOnTouchOutside(true)
    fitHeights()
  }

  /** Altura útil da janela (sem barras de status/navegação) em px. */
  private fun usableHeight(): Int {
    val decor = activity.window?.decorView
    val h = if (decor != null && decor.height > 0) decor.height else activity.resources.displayMetrics.heightPixels
    var top = px(24f)
    var bottom = px(24f)
    try {
      val ins = decor?.let { ViewCompat.getRootWindowInsets(it) }?.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      if (ins != null) { top = max(ins.top, px(12f)); bottom = max(ins.bottom, px(12f)) }
    } catch (_: Throwable) {}
    return h - top - bottom
  }

  /** Menu inteiro primeiro; a prévia fica com o resto (máx. 45% da tela). */
  private fun fitHeights() {
    try {
      val mv = menuView ?: return
      val ms = menuScroll ?: return
      val menuW = (ms.layoutParams as? LinearLayout.LayoutParams)?.width ?: px(250f)
      mv.measure(View.MeasureSpec.makeMeasureSpec(menuW, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
      val menuH = mv.measuredHeight
      msgBox.measure(View.MeasureSpec.makeMeasureSpec(cardW, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
      val contentH = msgBox.measuredHeight
      val usable = usableHeight() - px(24f)      // respiro nas bordas
      val gap = px(8f)
      val minMsgs = min(contentH, px(72f))
      val screenH = activity.resources.displayMetrics.heightPixels
      // Menu: tudo o que precisa, deixando ao menos cabeçalho + 1 balão.
      val menuMax = max(px(46f) * 3, usable - gap - headerH - minMsgs)
      val menuFinal = min(menuH, menuMax)
      val cardMax = min((screenH * 0.45f).toInt(), usable - gap - menuFinal)
      val msgsH = max(minMsgs, min(contentH, cardMax - headerH))
      (msgScroll.layoutParams as? LinearLayout.LayoutParams)?.let { lp ->
        lp.height = if (contentH > msgsH) msgsH else ViewGroup.LayoutParams.WRAP_CONTENT
        msgScroll.layoutParams = lp
      }
      (ms.layoutParams as? LinearLayout.LayoutParams)?.let { lp ->
        lp.height = if (menuH > menuFinal) menuFinal else ViewGroup.LayoutParams.WRAP_CONTENT
        ms.layoutParams = lp
      }
      // Últimas mensagens visíveis (ancoradas embaixo).
      msgScroll.post { msgScroll.scrollTo(0, max(0, msgBox.height - msgScroll.height)) }
    } catch (_: Throwable) {}
  }

  private fun seedFromRow() {
    val txt = if (row.locked) row.text else (if (row.text.isEmpty()) row.empty else row.text)
    if (txt.isEmpty()) return
    val mine = row.receipt > 0
    messages = listOf(Msg(mine, txt, row.time, if (!mine && row.isGroupish) row.sender else "", row.receipt))
  }

  private fun bubbleColor(m: Msg): Int =
    if (m.mine) (if (theme.dark) Color.parseColor("#2C2C2E") else Color.parseColor("#0B0B0B"))
    else (if (theme.dark) Color.parseColor("#1C1C1E") else Color.WHITE)

  /** Hora + recibo (✓ / ✓✓ / azul) numa linha. */
  private fun metaRow(m: Msg, color: Int): LinearLayout {
    val meta = LinearLayout(activity)
    meta.orientation = LinearLayout.HORIZONTAL
    meta.gravity = Gravity.CENTER_VERTICAL
    if (m.time.isNotEmpty()) {
      val t = TextView(activity)
      t.text = m.time
      t.setTextColor(color)
      t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
      t.maxLines = 1
      meta.addView(t)
    }
    if (m.mine && m.receipt > 0) {
      val rv = CLReceiptView(activity)
      rv.sentColor = color
      rv.grayColor = color
      rv.readColor = theme.receiptRead
      rv.update(m.receipt, false)
      val lp = LinearLayout.LayoutParams(rv.contentWidth, px(15f))
      lp.marginStart = px(3f)
      meta.addView(rv, lp)
    }
    return meta
  }

  private fun textBubble(m: Msg): View {
    val b = LinearLayout(activity)
    b.orientation = LinearLayout.VERTICAL
    b.background = rounded(bubbleColor(m), 14f)
    b.setPadding(px(12f), px(7f), px(10f), px(6f))
    val tv = TextView(activity)
    val sb = android.text.SpannableStringBuilder()
    if (m.sender.isNotEmpty()) {
      val st = sb.length
      sb.append(m.sender).append("\n")
      sb.setSpan(android.text.style.ForegroundColorSpan(theme.sub), st, sb.length, 0)
      sb.setSpan(android.text.style.RelativeSizeSpan(0.8f), st, sb.length, 0)
    }
    sb.append(m.text)
    tv.text = sb
    tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    tv.maxLines = 4
    tv.ellipsize = TextUtils.TruncateAt.END
    tv.maxWidth = (cardW * 0.8f).toInt() - px(22f)
    tv.setTextColor(if (m.mine && !theme.dark) Color.WHITE else theme.text)
    b.addView(tv)
    val metaColor = if (m.mine && !theme.dark) Color.argb(153, 255, 255, 255) else theme.sub
    val meta = metaRow(m, metaColor)
    if (meta.childCount > 0) {
      val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      lp.gravity = Gravity.END
      b.addView(meta, lp)
    }
    return b
  }

  private fun mediaBubble(m: Msg): View {
    val sticker = m.kind == "sticker"
    val side = px(if (sticker) 96f else 176f)
    var ih = px(if (sticker) 96f else 150f)
    if (!sticker && m.w > 0 && m.h > 0) ih = min(px(220f), max(px(96f), (side * (m.h / m.w)).toInt()))
    val b = LinearLayout(activity)
    b.orientation = LinearLayout.VERTICAL
    val pad = if (sticker) 0 else px(3f)
    if (!sticker) b.background = rounded(bubbleColor(m), 14f)
    b.setPadding(pad, pad, pad, pad)
    val frame = FrameLayout(activity)
    val iv = ImageView(activity)
    iv.scaleType = if (sticker) ImageView.ScaleType.FIT_CENTER else ImageView.ScaleType.CENTER_CROP
    if (!sticker) {
      iv.background = rounded(if (theme.dark) Color.argb(20, 255, 255, 255) else Color.argb(15, 0, 0, 0), 11f)
      iv.clipToOutline = true
    }
    frame.addView(iv, FrameLayout.LayoutParams(side, ih))
    try {
      if (sticker) {
        val app = activity.applicationContext
        RLImages.model(m.uri, false)?.let { mdl -> com.bumptech.glide.Glide.with(app).load(mdl).fitCenter().into(iv) }
      } else RLImages.load(iv, m.uri, false)
    } catch (_: Throwable) {}
    if (m.kind == "video" || m.kind == "gif") {
      val badge = TextView(activity)
      badge.setTextColor(Color.WHITE)
      badge.gravity = Gravity.CENTER
      if (m.kind == "video") {
        badge.text = "▶"
        badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        badge.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.argb(115, 0, 0, 0)) }
        frame.addView(badge, FrameLayout.LayoutParams(px(40f), px(40f), Gravity.CENTER))
      } else {
        badge.text = "GIF"
        badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
        badge.typeface = CLType.weight(700)
        badge.background = rounded(Color.argb(115, 0, 0, 0), 6f)
        val lp = FrameLayout.LayoutParams(px(32f), px(18f), Gravity.TOP or Gravity.START)
        lp.leftMargin = px(6f); lp.topMargin = px(6f)
        frame.addView(badge, lp)
      }
    }
    b.addView(frame)
    if (m.caption.isNotEmpty() && !sticker) {
      val cap = TextView(activity)
      cap.text = m.caption
      cap.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
      cap.maxLines = 2
      cap.ellipsize = TextUtils.TruncateAt.END
      cap.maxWidth = side - px(12f)
      cap.setTextColor(if (m.mine && !theme.dark) Color.WHITE else theme.text)
      val clp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      clp.leftMargin = px(6f); clp.topMargin = px(4f)
      b.addView(cap, clp)
      val meta = metaRow(m, if (m.mine && !theme.dark) Color.argb(153, 255, 255, 255) else theme.sub)
      if (meta.childCount > 0) {
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.gravity = Gravity.END; lp.rightMargin = px(6f); lp.bottomMargin = px(2f)
        b.addView(meta, lp)
      }
    } else {
      // Hora (+ recibo) numa pílula escura sobre a imagem (WhatsApp).
      val meta = metaRow(m, Color.WHITE)
      if (meta.childCount > 0) {
        meta.background = rounded(Color.argb(107, 0, 0, 0), 9f)
        meta.setPadding(px(7f), px(1f), px(7f), px(1f))
        val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, px(18f), Gravity.BOTTOM or Gravity.END)
        lp.rightMargin = px(6f); lp.bottomMargin = px(6f)
        frame.addView(meta, lp)
      }
    }
    return b
  }

  private fun rebuildMessages() {
    msgBox.removeAllViews()
    for ((i, m) in messages.withIndex()) {
      val v = if (m.isMedia) mediaBubble(m) else textBubble(m)
      val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      lp.gravity = if (m.mine) Gravity.END else Gravity.START
      if (i > 0) lp.topMargin = px(6f)
      msgBox.addView(v, lp)
    }
  }

  private fun animateIn() {
    column.alpha = 0f
    if (CLMotion.reduced(activity)) {
      column.animate().alpha(1f).setDuration(120).start()
      return
    }
    column.scaleX = 0.92f
    column.scaleY = 0.92f
    column.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(220)
      .setInterpolator(DecelerateInterpolator(1.8f)).start()
  }
}
