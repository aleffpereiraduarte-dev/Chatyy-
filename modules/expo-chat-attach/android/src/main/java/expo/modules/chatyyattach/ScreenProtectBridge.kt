package expo.modules.chatyyattach

import android.view.Window
import android.view.WindowManager

/**
 * [2026-10-15 screen-protect-all] Ponte para modules/expo-chat-privacy
 * (ScreenProtectHub) por REFLEXÃO — sem dependência gradle entre módulos.
 * Cópia idêntica em cada módulo nativo que abre janela própria (Dialog) ou
 * compartilha a tela (MediaProjection). Sem o hub no binário: só o secure local.
 */
internal object ScreenProtectBridge {
  @Volatile private var resolved = false
  @Volatile private var method: java.lang.reflect.Method? = null

  private fun hub(): java.lang.reflect.Method? {
    if (resolved) return method
    method = try {
      Class.forName("expo.modules.chatyyprivacy.ScreenProtectHub")
        .getMethod("bridge", String::class.java, Any::class.java)
    } catch (_: Throwable) { null }
    resolved = true
    return method
  }

  private fun call(cmd: String, arg: Any?): Any? = try { hub()?.invoke(null, cmd, arg) } catch (_: Throwable) { null }

  /** Janela própria (Dialog). localSecure = privacidade avançada/view-once dessa tela. */
  fun protect(window: Window?, localSecure: Boolean) {
    if (window == null) return
    if (call(if (localSecure) "window:1" else "window:0", window) == true) return
    if (localSecure) {
      try { window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) } catch (_: Throwable) {}
    }
  }

  /** Compartilhamento de tela (MediaProjection) ativo/parado — dono = nome da classe. */
  fun sharing(owner: String, active: Boolean) {
    call(if (active) "share:1" else "share:0", owner)
  }
}
