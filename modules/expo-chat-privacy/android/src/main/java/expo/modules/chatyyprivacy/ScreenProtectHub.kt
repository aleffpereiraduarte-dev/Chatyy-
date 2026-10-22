package expo.modules.chatyyprivacy

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import java.util.Collections
import java.util.WeakHashMap

/**
 * [2026-10-15 screen-protect-all] Proteção de captura no APP INTEIRO (Android).
 *
 * FLAG_SECURE = print/gravação/espelhamento saem pretos e a prévia do app em
 * "Recentes" fica preta. Cobre:
 *   • TODAS as Activities do processo (MainActivity, CallActivity,
 *     GroupCallActivity, IncomingCallActivity, ChatBubbleActivity, Live*…),
 *     via ActivityLifecycleCallbacks registrados no Application.onCreate
 *     (ExpoChatPrivacyPackage) → protegido antes do 1º frame, sem esperar o JS.
 *   • Dialogs nativos (media viewer, story, editor, attach, câmera): cada um
 *     chama ScreenProtectHub.bridge("window:0|1", window) por REFLEXÃO (sem
 *     dependência gradle entre módulos; keep em consumer-rules.pro).
 *   • PopupWindows/painéis são sub-janelas da Activity → herdam o secure.
 *   • <Modal> do RN copia o FLAG_SECURE da Activity ao criar o Dialog.
 *
 * Estado efetivo = global && ninguém compartilhando a tela.
 *   global  → decidido no JS (flag do servidor screen_protect_all, allowlist de
 *             QA, kill switch) e PERSISTIDO aqui (SharedPreferences) para o
 *             próximo cold start. Nunca decidido = LIGADO.
 *   sharing → CallActivity/GroupCallActivity/ScreenShareService avisam
 *             ("share:1|0", dono) enquanto publicam MediaProjection: o
 *             MediaProjection grava as janelas FLAG_SECURE como preto, então a
 *             proteção desliga enquanto o usuário compartilha a tela e volta ao
 *             parar (ou quando a Activity dona é destruída).
 *
 * Nunca LIMPA flag em resume/criação (só ADICIONA): o FLAG_SECURE posto pela
 * privacidade avançada por conversa / view-once (expo-screen-capture) não é
 * apagado por engano. Limpa só nas transições ligado→desligado (conta liberada,
 * compartilhamento começou), e mesmo assim respeita as tags locais do JS
 * (conversa protegida aberta) e o `secure` local de cada Dialog.
 *
 * [2026-10-22 print-local] Founder: "print sai preto no app todo". O app
 * inteiro NÃO é mais protegido por padrão: `global` nasce DESLIGADO (chave nova
 * `enabled_v2` — a antiga `enabled`=true persistida pela versão anterior é
 * ignorada) e só liga com a flag remota explícita (screen_protect_android).
 * O FLAG_SECURE fica só com as tags LOCAIS (conversa protegida em foco,
 * visualizador da foto de perfil, view-once). Tags do runtime anterior do JS
 * (reload/OTA no meio de uma conversa protegida) são zeradas no OnCreate do
 * módulo e por resetLocalTags(keep) no boot do JS.
 * Recentes: com a janela protegida, Android 13+ não tira a foto da tela
 * (setRecentsScreenshotEnabled(false) → o sistema mostra o ícone do app em vez
 * de preto) e, ao sair para o fundo, uma capa da marca ("Chatyy · Conteúdo
 * protegido") cobre o conteúdo durante a animação de Recentes.
 */
object ScreenProtectHub {
  private const val TAG = "ChatyyScreenProtect"
  private const val PREFS = "chatyy_screen_protect_v1"
  private const val K_ENABLED = "enabled_v2"
  private const val COVER_TAG = "chatyy_secure_cover"

  private val main = Handler(Looper.getMainLooper())
  @Volatile private var installed = false
  @Volatile private var global = false
  private var prefs: SharedPreferences? = null

  private val sharing = Collections.synchronizedSet(HashSet<String>())
  /** Tags do JS (conversa com privacidade avançada aberta etc.) — valem para as Activities. */
  private val localTags = Collections.synchronizedSet(HashSet<String>())

  // Só na main thread.
  private val activities = WeakHashMap<Activity, Boolean>()
  private val windows = WeakHashMap<Window, Boolean>() // valor = secure local do Dialog

  /** (effective, sharing) — o módulo repassa ao JS como onProtectChange. */
  @Volatile var listener: ((Boolean, Boolean) -> Unit)? = null

  @JvmStatic
  fun install(app: Application) {
    if (installed) return
    installed = true
    try {
      prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      global = prefs?.getBoolean(K_ENABLED, false) ?: false
    } catch (_: Throwable) {}
    try {
      app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
          activities[activity] = true
          applyWindow(activity.window, activityLocal(), false)
        }
        override fun onActivityStarted(activity: Activity) {}
        override fun onActivityResumed(activity: Activity) {
          activities[activity] = true
          applyWindow(activity.window, activityLocal(), false)
          removeCover(activity)
        }
        override fun onActivityPaused(activity: Activity) {
          // [2026-10-22 print-local] capa da marca nos Recentes (só tela protegida).
          try {
            val secure = (activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE) != 0
            if (secure && !activity.isFinishing && !inPipOrMulti(activity)) addCover(activity)
          } catch (_: Throwable) {}
        }
        override fun onActivityStopped(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {
          activities.remove(activity)
          // Rede de segurança: a Activity dona do compartilhamento morreu sem
          // avisar "share:0" → religa a proteção.
          val owner = activity.javaClass.simpleName
          if (sharing.remove(owner)) onEffectiveMaybeChanged(true)
        }
      })
    } catch (t: Throwable) {
      Log.w(TAG, "registerActivityLifecycleCallbacks: ${t.message}")
    }
  }

  @JvmStatic fun isGlobal(): Boolean = global
  @JvmStatic fun isSharing(): Boolean = sharing.isNotEmpty()
  @JvmStatic fun effective(): Boolean = global && sharing.isEmpty()

  private fun activityLocal(): Boolean = localTags.isNotEmpty()

  @JvmStatic
  fun setGlobal(enabled: Boolean) {
    val before = effective()
    val changed = global != enabled
    global = enabled
    if (changed) {
      try { prefs?.edit()?.putBoolean(K_ENABLED, enabled)?.apply() } catch (_: Throwable) {}
    }
    if (before != effective()) onEffectiveMaybeChanged(false) else reapplyAll(false)
  }

  /**
   * [2026-10-22 print-local] Boot do JS: fica só com `keep` (tags que o runtime
   * novo já pediu); o resto (órfãs do runtime anterior) sai e a flag é limpa
   * se ninguém mais quiser.
   */
  @JvmStatic
  fun resetLocalTags(keep: Collection<String>) {
    var changed = false
    synchronized(localTags) {
      val it = localTags.iterator()
      while (it.hasNext()) { if (!keep.contains(it.next())) { it.remove(); changed = true } }
    }
    if (changed) Log.i(TAG, "resetLocalTags: órfãs removidas (keep=${keep.size})")
    reapplyAll(true)
  }

  @JvmStatic
  fun setLocalTag(tag: String, on: Boolean) {
    val changed = if (on) localTags.add(tag) else localTags.remove(tag)
    // Tag saiu → pode limpar (se o global também estiver desligado).
    reapplyAll(changed && !on)
  }

  /** Re-aplica sem limpar (depois de um allowScreenCaptureAsync do expo-screen-capture). */
  @JvmStatic
  fun reassert() = reapplyAll(false)

  /**
   * Ponte por reflexão para os outros módulos (sem dependência gradle):
   *   bridge("window:1"|"window:0", Window)  → registra/protege um Dialog (1 = secure local)
   *   bridge("share:1"|"share:0", "Dono")     → compartilhamento de tela ativo/parado
   *   bridge("state", null)                   → Boolean efetivo
   */
  @JvmStatic
  fun bridge(cmd: String, arg: Any?): Any? {
    try {
      when {
        cmd.startsWith("window:") -> {
          val w = arg as? Window ?: return false
          val local = cmd == "window:1"
          onMain {
            windows[w] = local
            applyWindow(w, local, false)
          }
          return true
        }
        cmd.startsWith("share:") -> {
          val owner = (arg as? String)?.takeIf { it.isNotEmpty() } ?: "share"
          val before = effective()
          if (cmd == "share:1") sharing.add(owner) else sharing.remove(owner)
          if (before != effective()) onEffectiveMaybeChanged(true)
          return true
        }
        cmd == "state" -> return effective()
      }
    } catch (t: Throwable) {
      Log.w(TAG, "bridge $cmd: ${t.message}")
    }
    return null
  }

  private fun onEffectiveMaybeChanged(fromShare: Boolean) {
    reapplyAll(true)
    val eff = effective()
    val sh = sharing.isNotEmpty()
    Log.i(TAG, "effective=$eff global=$global sharing=$sh (${if (fromShare) "share" else "global"})")
    try { listener?.invoke(eff, sh) } catch (_: Throwable) {}
  }

  private fun reapplyAll(allowClear: Boolean) {
    onMain {
      val loc = activityLocal()
      for (a in activities.keys.toList()) {
        try { if (!a.isDestroyed) applyWindow(a.window, loc, allowClear) } catch (_: Throwable) {}
      }
      for ((w, l) in windows.entries.toList()) {
        applyWindow(w, l, allowClear)
      }
    }
  }

  private fun applyWindow(w: Window?, local: Boolean, allowClear: Boolean) {
    if (w == null) return
    try {
      val want = local || effective()
      val has = (w.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE) != 0
      if (want && !has) {
        w.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      } else if (!want && has && allowClear) {
        w.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      syncRecents(w)
    } catch (t: Throwable) {
      Log.w(TAG, "applyWindow: ${t.message}")
    }
  }

  // ─── [2026-10-22 print-local] Recentes: ícone do app / capa em vez de preto ──
  private fun activityOf(w: Window): Activity? {
    for (a in activities.keys) { try { if (a.window === w) return a } catch (_: Throwable) {} }
    return null
  }

  private fun syncRecents(w: Window) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val a = activityOf(w) ?: return
    try {
      val secure = (w.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE) != 0
      a.setRecentsScreenshotEnabled(!secure)
    } catch (_: Throwable) {}
  }

  private fun inPipOrMulti(a: Activity): Boolean {
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) a.isInPictureInPictureMode || a.isInMultiWindowMode else false
    } catch (_: Throwable) { false }
  }

  private fun coverLabel(): String {
    val lang = try { java.util.Locale.getDefault().language } catch (_: Throwable) { "pt" }
    return when (lang) {
      "pt" -> "Conteúdo protegido"
      "es" -> "Contenido protegido"
      else -> "Protected content"
    }
  }

  private fun addCover(a: Activity) {
    val decor = a.window?.decorView as? ViewGroup ?: return
    if (decor.findViewWithTag<View>(COVER_TAG) != null) return
    val ctx = a
    val dp = { v: Float -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt() }
    val root = FrameLayout(ctx).apply {
      tag = COVER_TAG
      setBackgroundColor(Color.parseColor("#0E0F14"))
      isClickable = true
      layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    }
    val col = LinearLayout(ctx).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
    }
    try {
      val icon = ctx.packageManager.getApplicationIcon(ctx.applicationInfo)
      col.addView(ImageView(ctx).apply { setImageDrawable(icon) }, LinearLayout.LayoutParams(dp(72f), dp(72f)))
    } catch (_: Throwable) {}
    col.addView(TextView(ctx).apply {
      text = "Chatyy"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.CENTER
    }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16f) })
    col.addView(TextView(ctx).apply {
      text = coverLabel()
      setTextColor(Color.parseColor("#A3A7B3"))
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
      gravity = Gravity.CENTER
    }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6f) })
    root.addView(col, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
    try { decor.addView(root) } catch (_: Throwable) {}
  }

  private fun removeCover(a: Activity) {
    try {
      val decor = a.window?.decorView as? ViewGroup ?: return
      val v = decor.findViewWithTag<View>(COVER_TAG) ?: return
      decor.removeView(v)
    } catch (_: Throwable) {}
  }

  private inline fun onMain(crossinline block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post { block() }
  }
}
