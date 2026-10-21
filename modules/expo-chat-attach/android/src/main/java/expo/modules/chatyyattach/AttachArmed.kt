package expo.modules.chatyyattach

import android.app.Activity
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewGroup
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import java.lang.ref.WeakReference

/**
 * [2026-10-21 attach-android-armed] "+" do composer nativo → folha NO MESMO
 * TOQUE (= iOS api 12), sem ida ao JS.
 *
 * O composer (modules/expo-chat-composer, api 8) chama por REFLEXÃO (sem
 * dependência gradle entre módulos; keep em consumer-rules.pro):
 *   AttachPlusHub.bridge("plus", {hadKeyboard, tapAt, plusX, plusY, plusW, plusH}) → Boolean
 * true = a folha armada pelo JS (armSheet) foi apresentada; o composer manda
 * onAttach{nativeOpened:true} e o resultado chega pelo evento onArmedResult.
 */
object AttachPlusHub {
  @Volatile internal var owner: WeakReference<ChatyyAttachModule>? = null

  @JvmStatic
  fun bridge(cmd: String, arg: Any?): Any? {
    try {
      when (cmd) {
        "plus" -> {
          if (Looper.myLooper() != Looper.getMainLooper()) return false
          val m = owner?.get() ?: return false
          val info = HashMap<String, Any?>()
          (arg as? Map<*, *>)?.forEach { (k, v) -> if (k is String) info[k] = v }
          return m.onComposerPlus(info)
        }
        "api" -> return 1
      }
    } catch (t: Throwable) {
      Log.w("ChatyyAttach", "plus hub $cmd: ${t.message}")
    }
    return null
  }
}

/**
 * Sonda de IME na Activity: uma View 0×0 em android.R.id.content com callback
 * próprio de WindowInsetsAnimation (não substitui o do composer / do
 * keyboard-controller — o deles despacha CONTINUE_ON_SUBTREE e a sonda é irmã).
 * Diz quando a descida do teclado do composer TERMINOU (onArmedShown espera
 * isso para o chat passar a ignorar o teclado sem pulo do lift).
 * Instalada fora do toque (pré-montagem), para não mexer na hierarquia no quadro do "+".
 */
internal class CAImeProbe private constructor(activity: Activity) {
  companion object {
    // fraca: quem segura a sonda é a própria hierarquia (content → view → callback)
    private var current: WeakReference<CAImeProbe>? = null

    fun install(activity: Activity): CAImeProbe? {
      current?.get()?.let { if (it.act.get() === activity && it.attached()) return it }
      return try {
        val p = CAImeProbe(activity)
        if (!p.attached()) null else { current = WeakReference(p); p }
      } catch (t: Throwable) { Log.w("ChatyyAttach", "ime probe: ${t.message}"); null }
    }

    /**
     * cb(waitMs) quando o IME da Activity acabou de descer: fim da animação,
     * ou ~150 ms sem animação começar e IME já fora, ou teto maxMs.
     */
    fun afterImeHidden(activity: Activity, maxMs: Long, cb: (Int) -> Unit) {
      val t0 = SystemClock.uptimeMillis()
      var done = false
      val fire = {
        if (!done) {
          done = true
          try { cb((SystemClock.uptimeMillis() - t0).toInt()) } catch (_: Throwable) {}
        }
      }
      val p = install(activity)
      if (p == null) { CAUtil.main.postDelayed({ fire() }, 300L); return }
      p.waiters.add(fire)
      CAUtil.main.postDelayed({
        if (!done && !p.running && !p.imeVisible()) { p.waiters.remove(fire); fire() }
      }, 150L)
      CAUtil.main.postDelayed({ if (!done) { p.waiters.remove(fire); fire() } }, maxMs)
    }
  }

  internal val act = WeakReference(activity)
  private val view = View(activity)
  var running = false
    private set
  val waiters = ArrayList<() -> Unit>()

  init {
    view.isClickable = false
    view.isFocusable = false
    view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    ViewCompat.setWindowInsetsAnimationCallback(view, object : WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_STOP) {
      override fun onPrepare(animation: WindowInsetsAnimationCompat) {
        if ((animation.typeMask and WindowInsetsCompat.Type.ime()) != 0) running = true
      }

      override fun onProgress(insets: WindowInsetsCompat, runningAnimations: MutableList<WindowInsetsAnimationCompat>): WindowInsetsCompat = insets

      override fun onEnd(animation: WindowInsetsAnimationCompat) {
        if ((animation.typeMask and WindowInsetsCompat.Type.ime()) == 0) return
        running = false
        if (imeVisible()) return // subiu (outro foco) — espera a próxima descida ou o teto
        val list = ArrayList(waiters)
        waiters.clear()
        for (w in list) CAUtil.main.post { w() }
      }
    })
    val content = activity.findViewById<ViewGroup>(android.R.id.content)
    content?.addView(view, 0, ViewGroup.LayoutParams(0, 0))
  }

  fun attached(): Boolean = view.parent != null && act.get()?.isDestroyed == false

  fun imeVisible(): Boolean = try {
    val a = act.get()
    val ins = a?.window?.decorView?.let { ViewCompat.getRootWindowInsets(it) }
    ins != null && ins.isVisible(WindowInsetsCompat.Type.ime()) && ins.getInsets(WindowInsetsCompat.Type.ime()).bottom > 0
  } catch (_: Throwable) { false }
}
