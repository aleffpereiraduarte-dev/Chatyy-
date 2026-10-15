package expo.modules.chatyyattach

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.google.common.util.concurrent.ListenableFuture

/** [2026-10-15 native-attach] Ação da barra (mesmas chaves do buildAttachItems do JS). */
data class CAAction(val key: String, val label: String)

/** Opções vindas do JS (labels já traduzidos, cores do tema, limites). */
class CAConfig(o: Map<String, Any?>) {
  val labels: Map<String, String>
  val actions: List<CAAction>
  val dark: Boolean
  val bg: Int
  val surface: Int
  val text: Int
  val textSecondary: Int
  val border: Int
  val chip: Int
  val maxSelect: Int
  val hdDefault: Boolean
  val allowCamera: Boolean
  val maxVideoSec: Double
  val withAudio: Boolean
  // [2026-10-15 native-status-studio] câmera do status: seletor Texto · Normal · Boomerang.
  val statusModes: Boolean
  val boomerangSec: Double

  init {
    val l = HashMap<String, String>()
    (o["labels"] as? Map<*, *>)?.forEach { (k, v) -> if (k is String && v is String) l[k] = v }
    labels = l
    val acts = ArrayList<CAAction>()
    (o["actions"] as? List<*>)?.forEach { a ->
      val m = a as? Map<*, *> ?: return@forEach
      val k = m["key"] as? String ?: return@forEach
      if (k.isEmpty()) return@forEach
      acts.add(CAAction(k, (m["label"] as? String) ?: k))
    }
    actions = acts
    val d = (o["dark"] as? Boolean) ?: false
    dark = d
    val c = o["colors"] as? Map<*, *> ?: emptyMap<Any, Any>()
    bg = color(c["bg"], if (d) 0xFF121212.toInt() else Color.WHITE)
    surface = color(c["surface"], if (d) 0xFF1C1C1E.toInt() else 0xFFF4F4F5.toInt())
    text = color(c["text"], if (d) Color.WHITE else 0xFF111111.toInt())
    textSecondary = color(c["textSecondary"], if (d) 0xFF9E9E9E.toInt() else 0xFF6B6B6B.toInt())
    border = color(c["border"], if (d) 0x1AFFFFFF else 0x14000000)
    chip = color(c["chip"], if (d) 0xFF2C2C2E.toInt() else 0xFFF2F2F4.toInt())
    maxSelect = ((o["maxSelect"] as? Number)?.toInt() ?: 30).coerceAtLeast(1)
    hdDefault = (o["hdDefault"] as? Boolean) ?: false
    allowCamera = (o["allowCamera"] as? Boolean) ?: true
    maxVideoSec = ((o["maxVideoSec"] as? Number)?.toDouble() ?: 60.0).coerceAtLeast(3.0)
    withAudio = (o["withAudio"] as? Boolean) ?: true
    statusModes = (o["statusModes"] as? Boolean) ?: false
    boomerangSec = ((o["boomerangSec"] as? Number)?.toDouble() ?: 1.5).coerceIn(0.8, 4.0)
  }

  fun t(key: String, fallback: String): String {
    val v = labels[key]
    return if (v.isNullOrEmpty()) fallback else v
  }

  companion object {
    fun color(v: Any?, fallback: Int): Int {
      val s = (v as? String)?.trim() ?: return fallback
      if (s.isEmpty()) return fallback
      return try {
        var h = s.removePrefix("#")
        // CSS #RRGGBBAA → Android #AARRGGBB
        if (h.length == 8) h = h.substring(6, 8) + h.substring(0, 6)
        if (h.length != 6 && h.length != 8) return fallback
        Color.parseColor("#$h")
      } catch (_: Throwable) {
        fallback
      }
    }

    fun iconFor(key: String): Int = when (key) {
      "camera" -> R.drawable.ca_ic_camera
      "gallery" -> R.drawable.ca_ic_gallery
      "file" -> R.drawable.ca_ic_file
      "scan_document" -> R.drawable.ca_ic_scan
      "location", "liveLocation" -> R.drawable.ca_ic_location
      "contact" -> R.drawable.ca_ic_contact
      "poll" -> R.drawable.ca_ic_poll
      "meetup" -> R.drawable.ca_ic_calendar
      "playlist", "audio", "music" -> R.drawable.ca_ic_music
      "gift" -> R.drawable.ca_ic_gift
      "gif" -> R.drawable.ca_ic_gif
      "short_video" -> R.drawable.ca_ic_film
      else -> R.drawable.ca_ic_grid
    }
  }
}

object CAUtil {
  val main = Handler(Looper.getMainLooper())

  fun dp(ctx: Context, v: Float): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt()

  fun fmtDur(sec: Double): String {
    val s = Math.max(0, Math.round(sec).toInt())
    return String.format("%d:%02d", s / 60, s % 60)
  }

  fun granted(ctx: Context, p: String): Boolean =
    ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

  fun hasCamera(ctx: Context) = granted(ctx, Manifest.permission.CAMERA)

  fun hasMic(ctx: Context) = granted(ctx, Manifest.permission.RECORD_AUDIO)

  /** Permissões de mídia a pedir (por versão do Android). */
  fun mediaPermissions(): Array<String> = when {
    Build.VERSION.SDK_INT >= 34 -> arrayOf(
      Manifest.permission.READ_MEDIA_IMAGES,
      Manifest.permission.READ_MEDIA_VIDEO,
      Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
    )
    Build.VERSION.SDK_INT >= 33 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
    else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
  }

  /** "full" | "partial" (Android 14 seleção do usuário) | "none". */
  fun mediaAccess(ctx: Context): String {
    if (Build.VERSION.SDK_INT >= 33) {
      val img = granted(ctx, Manifest.permission.READ_MEDIA_IMAGES)
      val vid = granted(ctx, Manifest.permission.READ_MEDIA_VIDEO)
      if (img || vid) return "full"
      if (Build.VERSION.SDK_INT >= 34 && granted(ctx, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)) return "partial"
      return "none"
    }
    return if (granted(ctx, Manifest.permission.READ_EXTERNAL_STORAGE)) "full" else "none"
  }

  fun haptic(v: View?, kind: String = "light") {
    try {
      val c = when (kind) {
        "select" -> if (Build.VERSION.SDK_INT >= 23) HapticFeedbackConstants.CLOCK_TICK else HapticFeedbackConstants.VIRTUAL_KEY
        "heavy" -> HapticFeedbackConstants.LONG_PRESS
        "warn" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
        else -> HapticFeedbackConstants.VIRTUAL_KEY
      }
      v?.performHapticFeedback(c)
    } catch (_: Throwable) {}
  }
}

/** LifecycleOwner próprio por tela: destruir = CameraX solta SÓ os nossos use cases. */
class CALifecycle : LifecycleOwner {
  private val reg = LifecycleRegistry(this)
  private var started = false
  override val lifecycle: Lifecycle get() = reg

  fun start() {
    if (started) return
    started = true
    reg.currentState = Lifecycle.State.CREATED
    reg.currentState = Lifecycle.State.RESUMED
  }

  fun pause() {
    if (started) try { reg.currentState = Lifecycle.State.CREATED } catch (_: Throwable) {}
  }

  fun resume() {
    if (started) try { reg.currentState = Lifecycle.State.RESUMED } catch (_: Throwable) {}
  }

  fun destroy() {
    if (!started) return
    started = false
    try { reg.currentState = Lifecycle.State.DESTROYED } catch (_: Throwable) {}
  }
}

/**
 * Pré-aquecimento: o custo frio do CameraX é o ProcessCameraProvider (carrega
 * o Camera2 e enumera câmeras). prewarm() dispara isso cedo; abrir a câmera
 * depois só faz o bind (~100–250 ms).
 */
object CameraHub {
  @Volatile private var future: ListenableFuture<ProcessCameraProvider>? = null

  fun prewarm(ctx: Context) {
    if (!CAUtil.hasCamera(ctx)) return
    if (future == null) {
      try { future = ProcessCameraProvider.getInstance(ctx.applicationContext) } catch (_: Throwable) {}
    }
  }

  fun withProvider(ctx: Context, cb: (ProcessCameraProvider?) -> Unit) {
    val f = future ?: try {
      ProcessCameraProvider.getInstance(ctx.applicationContext).also { future = it }
    } catch (_: Throwable) {
      null
    }
    if (f == null) { cb(null); return }
    f.addListener({
      val p = try { f.get() } catch (_: Throwable) { null }
      if (p == null) future = null
      cb(p)
    }, ContextCompat.getMainExecutor(ctx))
  }
}
