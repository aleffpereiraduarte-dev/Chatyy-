package expo.modules.nativetoolkit

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper

/**
 * [2026-10-19 perf-android] Resposta a onTrimMemory (JS: services/memoryPressure.js).
 *
 * Pico Android p50 ~470 MB RSS (PSS ~260), trim 40 frequente e o único crash
 * nativo veio junto de aviso de memória. O Glide (expo-image + listas nativas,
 * singleton) só se limpa sozinho em UI_HIDDEN+/RUNNING_CRITICAL; em
 * RUNNING_LOW (1º plano, sistema apertado) não fazia nada. Aqui:
 *   • RUNNING_LOW / RUNNING_CRITICAL / COMPLETE / onLowMemory → Glide.clearMemory() (main);
 *   • aparelho "low RAM" ou memoryClass ≤ 256 MB → Glide MemoryCategory.LOW (½ cache);
 *   • repassa o nível ao JS (evento onMemoryTrim do ChatyyPerf) → limpa cache
 *     de imagem em memória do expo-image + caches JS (conversas parseadas).
 * Glide por reflexão (o toolkit não depende do Glide; sem ele = no-op). Nunca lança.
 */
object ChatyyMemTrim {
  @Volatile private var installed = false
  private val main = Handler(Looper.getMainLooper())
  var emit: ((Int) -> Unit)? = null
  @Volatile var lastLevel = 0
  @Volatile var count = 0

  fun install(ctx: Context) {
    if (installed) return
    installed = true
    val app = ctx.applicationContext
    try { app.registerComponentCallbacks(cb) } catch (_: Throwable) { installed = false; return }
    try {
      val am = app.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
      if (am != null && (am.isLowRamDevice || am.memoryClass <= 256)) {
        main.post { glideLowCategory(app) }
      }
    } catch (_: Throwable) {}
  }

  private fun glide(app: Context): Any? = try {
    val k = Class.forName("com.bumptech.glide.Glide")
    k.getMethod("get", Context::class.java).invoke(null, app)
  } catch (_: Throwable) { null }

  private fun glideClear(app: Context) {
    try { glide(app)?.let { g -> g.javaClass.getMethod("clearMemory").invoke(g) } } catch (_: Throwable) {}
  }

  private fun glideLowCategory(app: Context) {
    try {
      val g = glide(app) ?: return
      val cat = Class.forName("com.bumptech.glide.MemoryCategory")
      val low = cat.getField("LOW").get(null)
      g.javaClass.getMethod("setMemoryCategory", cat).invoke(g, low)
    } catch (_: Throwable) {}
  }

  private var appRef: Context? = null

  private val cb = object : ComponentCallbacks2 {
    override fun onTrimMemory(level: Int) { handle(level) }
    override fun onConfigurationChanged(newConfig: Configuration) {}
    @Deprecated("Deprecated in Java")
    override fun onLowMemory() { handle(ComponentCallbacks2.TRIM_MEMORY_COMPLETE) }
  }

  private fun handle(level: Int) {
    lastLevel = level
    count++
    main.post {
      val app = appRef
      if (app != null && (level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW
          || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL
          || level >= ComponentCallbacks2.TRIM_MEMORY_COMPLETE)) {
        glideClear(app)
      }
      // UI_HIDDEN (20) = toda ida p/ 2º plano; não é pressão → não acorda o JS.
      if (level != ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN && level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
        try { emit?.invoke(level) } catch (_: Throwable) {}
      }
    }
  }

  fun bind(ctx: Context) {
    appRef = ctx.applicationContext
    install(ctx)
  }
}
