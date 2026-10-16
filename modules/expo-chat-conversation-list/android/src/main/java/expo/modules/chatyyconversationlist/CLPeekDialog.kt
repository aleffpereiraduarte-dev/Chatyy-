package expo.modules.chatyyconversationlist

// [2026-10-16 wave8-list] Prévia (peek) do toque longo no ANDROID, estilo
// Telegram: janela por cima do app (fundo escurecido + blur de janela no
// Android 12+), cartão com as últimas mensagens da conversa e a lista de ações
// logo abaixo. Toque no cartão = abre a conversa; toque fora / voltar = fecha.
// Mesmo dado do iOS (CLPeekController.swift): abre na hora com a prévia da
// linha e se completa quando o JS responde ao onPeekRequest (prop `peek`).
// Só com a prop peekMode = "peek" (o JS liga; binário/JS antigos = PopupMenu).

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
import android.widget.LinearLayout
import android.widget.TextView
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

  private class Msg(val mine: Boolean, val text: String, val time: String, val sender: String)

  private val density = activity.resources.displayMetrics.density
  private fun px(v: Float): Int = (v * density + 0.5f).toInt()
  private val dialog = Dialog(activity, android.R.style.Theme_Translucent_NoTitleBar)
  private val column = LinearLayout(activity)
  private val msgBox = LinearLayout(activity)
  private var messages: List<Msg> = emptyList()
  private var cardW = 0
  private var closed = false

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
    messages = items.takeLast(8).map {
      Msg(CLVal.bool(it["m"]), CLVal.str(it["t"]), CLVal.str(it["h"]), CLVal.str(it["s"]))
    }
    rebuildMessages()
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
    card.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(56f)))

    msgBox.orientation = LinearLayout.VERTICAL
    msgBox.setPadding(px(10f), px(10f), px(10f), px(12f))
    card.addView(msgBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    if (messages.isEmpty()) seedFromRow()
    rebuildMessages()
    column.addView(card, LinearLayout.LayoutParams(cardW, ViewGroup.LayoutParams.WRAP_CONTENT))

    // Ações (mesmas do swipe/menu; "Mais" abre o menu completo do JS).
    val menu = LinearLayout(activity)
    menu.orientation = LinearLayout.VERTICAL
    menu.background = rounded(menuBg, 14f)
    menu.clipToOutline = true
    val unread = row.unread > 0
    val items = ArrayList<Triple<String, String, Boolean>>()
    items.add(Triple("toggleRead", if (unread) labels.get("markRead", "Marcar como lida") else labels.get("markUnread", "Marcar como não lida"), false))
    items.add(Triple("pin", if (row.pinned) labels.get("unpin", "Desafixar") else labels.get("pin", "Fixar"), false))
    items.add(Triple("mute", if (row.muted) labels.get("unmute", "Reativar som") else labels.get("mute", "Silenciar"), false))
    items.add(Triple("archive", if (row.archived) labels.get("unarchive", "Desarquivar") else labels.get("archive", "Arquivar"), false))
    items.add(Triple("more", labels.get("more", "Mais opções"), false))
    items.add(Triple("delete", labels.get("delete", "Apagar"), true))
    val hair = if (theme.dark) Color.argb(30, 255, 255, 255) else Color.argb(26, 0, 0, 0)
    items.forEachIndexed { i, (action, label, destructive) ->
      if (i > 0) {
        val sep = View(activity)
        sep.setBackgroundColor(hair)
        menu.addView(sep, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, maxOf(1, px(0.5f))))
      }
      val tv = TextView(activity)
      tv.text = label
      tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
      tv.setTextColor(if (destructive) CLTheme.SWIPE_DELETE else theme.text)
      tv.gravity = Gravity.CENTER_VERTICAL
      tv.setPadding(px(16f), 0, px(16f), 0)
      tv.maxLines = 1
      tv.ellipsize = TextUtils.TruncateAt.END
      tv.background = RippleDrawable(ColorStateList.valueOf(theme.press), null, ColorDrawable(Color.WHITE))
      tv.setOnClickListener {
        onAction(action)
        dismiss()
      }
      menu.addView(tv, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(48f)))
    }
    val mlp = LinearLayout.LayoutParams(min(px(250f), cardW), ViewGroup.LayoutParams.WRAP_CONTENT)
    mlp.topMargin = px(8f)
    column.addView(menu, mlp)

    val clp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER)
    root.addView(column, clp)
    dialog.setContentView(root)
    dialog.setCanceledOnTouchOutside(true)
  }

  private fun seedFromRow() {
    val txt = if (row.locked) row.text else (if (row.text.isEmpty()) row.empty else row.text)
    if (txt.isEmpty()) return
    val mine = row.receipt > 0
    messages = listOf(Msg(mine, txt, row.time, if (!mine && row.isGroupish) row.sender else ""))
  }

  private fun rebuildMessages() {
    msgBox.removeAllViews()
    val maxBubble = (cardW * 0.8f).toInt()
    for ((i, m) in messages.withIndex()) {
      val tv = TextView(activity)
      val sb = android.text.SpannableStringBuilder()
      if (m.sender.isNotEmpty()) {
        val st = sb.length
        sb.append(m.sender).append("\n")
        sb.setSpan(android.text.style.ForegroundColorSpan(theme.sub), st, sb.length, 0)
        sb.setSpan(android.text.style.RelativeSizeSpan(0.8f), st, sb.length, 0)
      }
      sb.append(m.text)
      if (m.time.isNotEmpty()) {
        val st = sb.length
        sb.append("  ").append(m.time)
        val meta = if (m.mine && !theme.dark) Color.argb(153, 255, 255, 255) else theme.sub
        sb.setSpan(android.text.style.ForegroundColorSpan(meta), st, sb.length, 0)
        sb.setSpan(android.text.style.RelativeSizeSpan(0.73f), st, sb.length, 0)
      }
      tv.text = sb
      tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
      tv.maxLines = 4
      tv.ellipsize = TextUtils.TruncateAt.END
      tv.maxWidth = maxBubble
      val bubbleBg = if (m.mine) (if (theme.dark) Color.parseColor("#2C2C2E") else Color.parseColor("#0B0B0B"))
        else (if (theme.dark) Color.parseColor("#1C1C1E") else Color.WHITE)
      tv.setTextColor(if (m.mine && !theme.dark) Color.WHITE else theme.text)
      tv.background = rounded(bubbleBg, 14f)
      tv.setPadding(px(12f), px(7f), px(12f), px(7f))
      val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      lp.gravity = if (m.mine) Gravity.END else Gravity.START
      if (i > 0) lp.topMargin = px(6f)
      msgBox.addView(tv, lp)
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
