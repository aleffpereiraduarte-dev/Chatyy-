package expo.modules.callkit

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import io.livekit.android.e2ee.BaseKeyProvider
import io.livekit.android.e2ee.E2EEOptions
import io.livekit.android.room.Room
import livekit.LivekitModels
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * [e2ee5 WP-13 2026-10-21] Ligações E2EE v5 no Android (livekit-android 2.24.1, frame encryption).
 *
 * O JS (services/callE2ee.js) gera/recebe a chave por to-device Olm (`chatyy.call_key`) e entrega
 * por `setCallE2EEKey`; marca a ligação como EXIGIDA (`setCallE2EERequired`) e grava a dica por
 * conversa (`setCallE2EEConvHint`) para o toque com o app morto.
 *
 * Ligação exigida ⇒ o Room nasce com [E2EEOptions] mesmo SEM chave (BaseKeyProvider vazio): o
 * cifrador descarta os quadros até a chave chegar — nunca sai mídia em claro. A chave nova (1ª ou
 * rotação) vai para o MESMO provider, slot 0. Nada exigido e sem chave (= hoje, flag desligada) ⇒
 * [optionsFor] devolve null e o Room é criado exatamente como antes.
 *
 * Chave = TEXTO base64 de 32 B (44 chars), igual iOS/web. Nunca logar a chave.
 */
internal object CallE2EE {
  private const val TAG = "CallE2EE"
  const val API_VERSION = 1
  private const val PREFS = "chatyy_e2ee5_call"
  private const val HINTS = "hints_v1"

  private class Entry {
    @Volatile var required = false
    @Volatile var key: String? = null
    @Volatile var provider: BaseKeyProvider? = null
    val createdAt = System.currentTimeMillis()
  }

  private val calls = ConcurrentHashMap<String, Entry>()

  fun validKey(k: String?): Boolean {
    if (k == null || k.length != 44 || !k.endsWith("=")) return false
    return try { Base64.decode(k, Base64.NO_WRAP).size == 32 } catch (_: Throwable) { false }
  }

  private fun entry(callId: String): Entry = calls.getOrPut(callId) { Entry() }

  fun setRequired(callId: String, on: Boolean) {
    if (callId.isEmpty()) return
    entry(callId).required = on
    Log.i(TAG, "required=${if (on) 1 else 0} call=$callId")
  }

  /** Chave nova (1ª ou rotação): também no provider do Room vivo. */
  fun setKey(callId: String, keyB64: String): Boolean {
    if (callId.isEmpty() || !validKey(keyB64)) return false
    val e = entry(callId)
    e.key = keyB64
    val live = e.provider
    try { live?.setSharedKey(keyB64, 0) } catch (t: Throwable) { Log.w(TAG, "setSharedKey falhou: ${t.javaClass.simpleName}") }
    Log.i(TAG, "key set call=$callId live=${if (live != null) 1 else 0}")
    return true
  }

  fun clear(callId: String) { calls.remove(callId) }

  fun isRequired(callId: String?): Boolean {
    if (callId.isNullOrEmpty()) return false
    val e = calls[callId] ?: return false
    return e.required || e.key != null
  }

  fun hasKey(callId: String?): Boolean = !callId.isNullOrEmpty() && calls[callId]?.key != null

  /** Opções E2EE do Room desta ligação; null = ligação de hoje. Lança se exigida e o SDK falhar. */
  fun optionsFor(callId: String?): E2EEOptions? {
    if (!isRequired(callId)) return null
    val e = entry(callId!!)
    val p = BaseKeyProvider()
    e.key?.let { p.setSharedKey(it, 0) }
    e.provider = p
    Log.i(TAG, "room e2ee call=$callId key=${if (e.key != null) 1 else 0}")
    return E2EEOptions(p, LivekitModels.Encryption.Type.GCM)
  }

  /** Room quente (toque) criado SEM E2EE numa ligação que agora é exigida → não adotar. */
  fun roomViolatesPolicy(callId: String?, room: Room?): Boolean =
    room != null && isRequired(callId) && room.e2eeManager == null

  /** P2P nativo (SDP pelo hub sem autenticação) fica de fora das ligações cifradas. */
  fun blocksNativeP2P(callId: String?): Boolean = isRequired(callId)

  /** Participante remoto publicando SEM cifra (app antigo)? */
  fun hasUnencryptedRemote(room: Room?): Boolean {
    val r = room ?: return false
    return try {
      r.remoteParticipants.values.any { p ->
        p.trackPublications.values.any { it.encryptionType == LivekitModels.Encryption.Type.NONE }
      }
    } catch (_: Throwable) { false }
  }

  fun status(callId: String): Map<String, Any> {
    val e = calls[callId]
    return mapOf(
      "required" to (e?.required ?: false),
      "hasKey" to (e?.key != null),
      "live" to (e?.provider != null),
      "ageMs" to (if (e != null) System.currentTimeMillis() - e.createdAt else 0L),
    )
  }

  // ───── dica por conversa (toque com o app morto) ─────

  private fun canon(e: String): String {
    val s = e.trim().lowercase(Locale.ROOT)
    return if (s.endsWith("@onemundo.com.br")) s.dropLast(16) + "@chatyy.com.br" else s
  }

  fun setConvHint(ctx: Context, convId: String, peerEmail: String, on: Boolean) {
    if (convId.isEmpty()) return
    try {
      val sp = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val o = try { JSONObject(sp.getString(HINTS, "{}") ?: "{}") } catch (_: Throwable) { JSONObject() }
      if (on) o.put(convId, JSONObject().put("p", canon(peerEmail)).put("t", System.currentTimeMillis())) else o.remove(convId)
      if (o.length() > 500) {
        val keys = o.keys().asSequence().toList().sortedBy { o.optJSONObject(it)?.optLong("t") ?: 0L }
        keys.take(o.length() - 400).forEach { o.remove(it) }
      }
      sp.edit().putString(HINTS, o.toString()).apply()
    } catch (t: Throwable) { Log.w(TAG, "hint falhou: ${t.javaClass.simpleName}") }
  }

  /** Toque/atendimento: conversa (ou par do 1:1) marcada como cifrada ⇒ exigida. */
  fun noteIncoming(ctx: Context, callId: String, convId: String, peerEmail: String) {
    if (callId.isEmpty()) return
    try {
      val raw = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(HINTS, null) ?: return
      val o = JSONObject(raw)
      if (o.length() == 0) return
      var hit = convId.isNotEmpty() && o.has(convId)
      if (!hit && peerEmail.isNotEmpty()) {
        val pe = canon(peerEmail)
        val it = o.keys()
        while (it.hasNext() && !hit) { if (o.optJSONObject(it.next())?.optString("p") == pe) hit = true }
      }
      if (hit) setRequired(callId, true)
    } catch (_: Throwable) {}
  }

  fun text(ctx: Context?, key: String): String {
    val lang = try { (ctx?.resources?.configuration?.locales?.get(0) ?: Locale.getDefault()).language } catch (_: Throwable) { "pt" }
    val pt = lang == "pt"; val es = lang == "es"
    return when (key) {
      "on" -> if (pt) "Criptografada de ponta a ponta" else if (es) "Cifrada de extremo a extremo" else "End-to-end encrypted"
      "wait" -> if (pt) "Protegendo a ligação…" else if (es) "Protegiendo la llamada…" else "Securing the call…"
      "nokey" -> if (pt) "Não foi possível proteger esta ligação." else if (es) "No fue posible proteger esta llamada." else "Couldn't secure this call."
      "plain" -> if (pt) "Esta ligação não está protegida. Desligue e ligue de novo." else if (es) "Esta llamada no está protegida. Cuelga y vuelve a llamar." else "This call isn't secured. Hang up and call again."
      else -> if (pt) "A outra pessoa precisa atualizar o Chatyy para esta ligação ser protegida." else if (es) "La otra persona necesita actualizar Chatyy para proteger esta llamada." else "The other person needs to update Chatyy to secure this call."
    }
  }
}

/**
 * Cadeado / aviso por cima da tela de chamada (View simples via addContentView — não mexe no
 * Compose). Escondido quando a ligação não é cifrada; poll leve de 2 s enquanto anexado.
 */
internal object CallE2EEBadge {
  private const val TAG_KEY = "chatyy_e2ee5_badge"

  fun attach(activity: Activity, callId: () -> String, room: () -> Room?) {
    try {
      val root = activity.findViewById<FrameLayout>(android.R.id.content) ?: return
      if (root.findViewWithTag<View>(TAG_KEY) != null) return
      val dp = { v: Float -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, activity.resources.displayMetrics).toInt() }
      val tv = TextView(activity).apply {
        tag = TAG_KEY
        visibility = View.GONE
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
        setTextColor(Color.argb(217, 255, 255, 255))
        gravity = Gravity.CENTER
        maxLines = 2
        setPadding(dp(10f), dp(3f), dp(10f), dp(3f))
        background = GradientDrawable().apply { cornerRadius = dp(10f).toFloat(); setColor(Color.argb(90, 0, 0, 0)) }
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
      }
      val lp = FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL)
      lp.topMargin = dp(36f)
      activity.addContentView(tv, lp)
      val h = Handler(Looper.getMainLooper())
      val started = System.currentTimeMillis()
      val tick = object : Runnable {
        override fun run() {
          if (!tv.isAttachedToWindow && tv.parent == null) return
          try { refresh(activity, tv, callId(), room(), started) } catch (_: Throwable) {}
          h.postDelayed(this, 2000)
        }
      }
      tv.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(v: View) {}
        override fun onViewDetachedFromWindow(v: View) { h.removeCallbacks(tick) }
      })
      h.post(tick)
    } catch (t: Throwable) {
      android.util.Log.w("CallE2EE", "badge falhou: ${t.javaClass.simpleName}")
    }
  }

  private fun refresh(ctx: Context, tv: TextView, callId: String, room: Room?, started: Long) {
    if (!CallE2EE.isRequired(callId)) { tv.visibility = View.GONE; return }
    tv.visibility = View.VISIBLE
    tv.bringToFront()
    val warn = Color.rgb(255, 210, 122)
    val normal = Color.argb(217, 255, 255, 255)
    val (key, color) = when {
      room != null && room.e2eeManager == null -> "plain" to warn
      CallE2EE.hasUnencryptedRemote(room) -> "peer" to warn
      CallE2EE.hasKey(callId) -> "on" to normal
      System.currentTimeMillis() - started > 30_000 -> "nokey" to warn
      else -> "wait" to normal
    }
    // Ícone = drawable do sistema (cadeado / alerta), nunca emoji.
    try {
      val res = if (key == "on" || key == "wait") android.R.drawable.ic_lock_lock else android.R.drawable.ic_dialog_alert
      val d = androidx.core.content.ContextCompat.getDrawable(ctx, res)?.mutate()
      if (d != null) {
        val px = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 12f, ctx.resources.displayMetrics).toInt()
        d.setBounds(0, 0, px, px)
        d.setTint(color)
        tv.setCompoundDrawables(d, null, null, null)
        tv.compoundDrawablePadding = px / 2
      }
    } catch (_: Throwable) {}
    tv.text = CallE2EE.text(ctx, key)
    tv.setTextColor(color)
    tv.contentDescription = CallE2EE.text(ctx, key)
  }
}
