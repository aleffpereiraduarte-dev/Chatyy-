package expo.modules.chatyymessagelist

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.text.Selection
import android.text.Spannable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * [reply-v2 2026-10-15] "Citar trecho" (Telegram): escolhe PARTE do texto e
 * responde citando só aquele trecho. JS chama ref.showQuotePicker depois que o
 * menu de contexto fecha; devolve o trecho ("" = cancelou). P&B, sem emoji.
 * payload: { text, title, hint, confirm, cancel, dark: 0|1, max: 240 }
 */
internal object MLQuotePicker {
  private var current: Dialog? = null

  fun present(activity: Activity?, payload: Map<String, Any?>, done: (String) -> Unit) {
    val src = (payload["text"] as? String) ?: ""
    if (activity == null || activity.isFinishing || src.isBlank()) { done(""); return }
    try { current?.dismiss() } catch (_: Throwable) {}
    val dark = when (val d = payload["dark"]) { is Boolean -> d; is Number -> d.toInt() != 0; else -> false }
    val maxLen = ((payload["max"] as? Number)?.toInt() ?: 240).coerceAtLeast(20)
    val ctx = activity
    val dp = { v: Float -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt() }
    val ink = if (dark) Color.WHITE else Color.BLACK
    val sub = if (dark) 0x99FFFFFF.toInt() else 0x8C000000.toInt()
    val cardBg = if (dark) 0xFF1F1F1F.toInt() else Color.WHITE

    var finished = false
    val dialog = Dialog(ctx)
    dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)

    val card = LinearLayout(ctx).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(16f), dp(18f), dp(16f), dp(16f))
      background = GradientDrawable().apply { cornerRadius = dp(22f).toFloat(); setColor(cardBg) }
      elevation = dp(8f).toFloat()
    }
    val title = TextView(ctx).apply {
      text = (payload["title"] as? String) ?: "Citar trecho"
      setTextColor(ink); setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f); typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.CENTER
    }
    card.addView(title)
    val hintS = (payload["hint"] as? String) ?: ""
    if (hintS.isNotEmpty()) {
      card.addView(TextView(ctx).apply {
        text = hintS; setTextColor(sub); setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f); gravity = Gravity.CENTER
        setPadding(0, dp(4f), 0, 0)
      })
    }
    val body = TextView(ctx).apply {
      setText(src, TextView.BufferType.SPANNABLE)
      setTextColor(ink); setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
      setTextIsSelectable(true)
      highlightColor = if (dark) 0x55FFFFFF else 0x33000000
      setPadding(dp(12f), dp(12f), dp(12f), dp(12f))
    }
    val scroll = ScrollView(ctx).apply {
      background = GradientDrawable().apply { cornerRadius = dp(14f).toFloat(); setColor(if (dark) 0x0FFFFFFF else 0x0A000000) }
      addView(body)
    }
    val maxH = (ctx.resources.displayMetrics.heightPixels * 0.42f).toInt()
    card.addView(FrameLayout(ctx).apply {
      addView(scroll)
      setPadding(0, dp(12f), 0, 0)
    }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    val preview = TextView(ctx).apply {
      setTextColor(sub); setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f); maxLines = 1
      ellipsize = TextUtils.TruncateAt.MIDDLE
      setPadding(0, dp(10f), 0, dp(14f))
    }
    card.addView(preview)
    val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
    fun btn(label: String, primary: Boolean) = TextView(ctx).apply {
      this.text = label
      gravity = Gravity.CENTER
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
      typeface = if (primary) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
      setTextColor(if (primary) (if (dark) Color.BLACK else Color.WHITE) else ink)
      background = GradientDrawable().apply {
        cornerRadius = dp(14f).toFloat()
        setColor(if (primary) ink else (if (dark) 0x1AFFFFFF else 0x0F000000))
      }
      isClickable = true; isFocusable = true
    }
    val cancel = btn((payload["cancel"] as? String) ?: "Cancelar", false)
    val confirm = btn((payload["confirm"] as? String) ?: "Citar", true)
    row.addView(cancel, LinearLayout.LayoutParams(0, dp(48f), 1f).apply { marginEnd = dp(5f) })
    row.addView(confirm, LinearLayout.LayoutParams(0, dp(48f), 1f).apply { marginStart = dp(5f) })
    card.addView(row)

    fun selected(): String {
      val s = body.selectionStart; val e = body.selectionEnd
      var out = if (s >= 0 && e > s && e <= src.length) src.substring(s, e) else src
      out = out.trim()
      if (out.length > maxLen) out = out.substring(0, maxLen)
      return out
    }
    fun refresh() {
      val s = selected().replace('\n', ' ')
      preview.text = if (s.isEmpty()) "" else "“$s”"
      confirm.alpha = if (s.isEmpty()) 0.4f else 1f
      confirm.isEnabled = s.isNotEmpty()
    }
    fun finish(result: String) {
      if (finished) return
      finished = true
      done(result)
      try { dialog.dismiss() } catch (_: Throwable) {}
    }
    // seleção muda (alças) → atualiza a prévia; polling leve enquanto aberto
    val tick = object : Runnable {
      var last = -2L
      override fun run() {
        if (finished) return
        val sig = body.selectionStart.toLong() * 100000L + body.selectionEnd
        if (sig != last) { last = sig; refresh() }
        body.postDelayed(this, 120)
      }
    }
    cancel.setOnClickListener { finish("") }
    confirm.setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
      finish(selected())
    }
    dialog.setOnDismissListener { if (!finished) { finished = true; done("") }; if (current === dialog) current = null }

    val root = FrameLayout(ctx)
    val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM)
    lp.setMargins(dp(12f), 0, dp(12f), dp(12f))
    root.addView(card, lp)
    root.setOnClickListener { finish("") }
    card.setOnClickListener { /* engole o toque */ }
    dialog.setContentView(root)
    dialog.window?.let { w ->
      w.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      w.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      w.setGravity(Gravity.BOTTOM)
      w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
      w.setDimAmount(if (dark) 0.55f else 0.35f)
      w.setWindowAnimations(android.R.style.Animation_InputMethod)
    }
    // limita a altura do texto (rolável)
    scroll.post {
      if (scroll.height > maxH) { scroll.layoutParams = scroll.layoutParams.apply { height = maxH } }
    }
    current = dialog
    dialog.show()
    body.post {
      body.requestFocus()
      // começa com TUDO selecionado: o usuário arrasta as alças até o trecho
      try { Selection.setSelection(body.text as Spannable, 0, src.length) } catch (_: Throwable) {}
      refresh()
      body.post(tick)
    }
    root.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
  }
}
