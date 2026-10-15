package expo.modules.chatyyprivacy

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Window
import android.view.WindowManager
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
 */
object ScreenProtectHub {
  private const val TAG = "ChatyyScreenProtect"
  private const val PREFS = "chatyy_screen_protect_v1"
  private const val K_ENABLED = "enabled"

  private val main = Handler(Looper.getMainLooper())
  @Volatile private var installed = false
  @Volatile private var global = true
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
      global = prefs?.getBoolean(K_ENABLED, true) ?: true
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
        }
        override fun onActivityPaused(activity: Activity) {}
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
    } catch (t: Throwable) {
      Log.w(TAG, "applyWindow: ${t.message}")
    }
  }

  private inline fun onMain(crossinline block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post { block() }
  }
}
