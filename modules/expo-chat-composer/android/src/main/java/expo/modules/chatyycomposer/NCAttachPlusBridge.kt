package expo.modules.chatyycomposer

import android.view.View

/**
 * [2026-10-21 attach-android-armed] Ponte para modules/expo-chat-attach
 * (AttachPlusHub) por REFLEXÃO — sem dependência gradle entre módulos (keep em
 * modules/expo-chat-attach/android/consumer-rules.pro). Sem o hub no binário
 * ou sem folha armada: false → caminho de sempre (onAttach → JS → openSheet).
 */
internal object NCAttachPlusBridge {
  @Volatile private var resolved = false
  @Volatile private var method: java.lang.reflect.Method? = null

  private fun hub(): java.lang.reflect.Method? {
    if (resolved) return method
    method = try {
      Class.forName("expo.modules.chatyyattach.AttachPlusHub")
        .getMethod("bridge", String::class.java, Any::class.java)
    } catch (_: Throwable) { null }
    resolved = true
    return method
  }

  /** Toque no "+" (main thread). true = a folha armada foi apresentada. */
  fun plus(plus: View, hadKeyboard: Boolean, tapAt: Long): Boolean {
    val m = hub() ?: return false
    val info = HashMap<String, Any?>()
    info["hadKeyboard"] = hadKeyboard
    info["tapAt"] = tapAt
    try {
      val loc = IntArray(2)
      plus.getLocationOnScreen(loc)
      info["plusX"] = loc[0]
      info["plusY"] = loc[1]
      info["plusW"] = plus.width
      info["plusH"] = plus.height
    } catch (_: Throwable) {}
    return try { m.invoke(null, "plus", info) == true } catch (_: Throwable) { false }
  }
}
