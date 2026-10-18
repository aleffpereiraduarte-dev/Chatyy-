package expo.modules.nativetoolkit

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import com.whatsapp.otp.android.sdk.WhatsAppOtpHandler
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import java.util.UUID

/**
 * [2026-10-18 wa-onetap] WhatsApp one-tap / zero-tap OTP autofill (Android only).
 *
 * Meta's authentication templates with an `otp_type: one_tap` (or `zero_tap`)
 * button deliver the code straight to the app instead of the "Copy code"
 * button, IF:
 *   1. the template lists `supported_apps` = { package_name: com.onemundo.mail,
 *      signature_hash: <11-char hash of the Play App Signing cert> };
 *   2. the app did a handshake < 10 min before the message arrived: an
 *      explicit `com.whatsapp.otp.OTP_REQUESTED` broadcast to com.whatsapp and
 *      com.whatsapp.w4b carrying a PendingIntent (`_ci_`, WhatsApp reads the
 *      creator package from it) + a `request_id` UUID. We use Meta's OTP Android
 *      SDK (com.whatsapp.otp:whatsapp-otp-android-sdk) for this, the raw
 *      PendingIntent handshake without the SDK is deprecated since 2026-10-15;
 *   3. the app declares an exported activity (one-tap) / receiver (zero-tap)
 *      for `com.whatsapp.otp.OTP_RETRIEVED` → [WaOtpCodeActivity] /
 *      [WaOtpCodeReceiver], which hand the intent to [handleIncoming].
 * If any check fails WhatsApp just shows the "Copy code" button (JS falls back
 * to the clipboard path in services/otpAutofill.js).
 *
 * Security: the code intent is accepted only when its `request_id` is one of
 * the UUIDs WE issued in the last 10 minutes (random, only ever sent to the
 * WhatsApp packages), and the code must look like an OTP (4-10 alphanumerics).
 * Only the code reaches JS, through the "onWaOtp" event or consumePending()
 * (cold start: the activity may run before JS has subscribed).
 *
 * Also: getClipboardTextSince(ms) — the clipboard text only if it was copied
 * after `ms` (ClipDescription.getTimestamp, API 26+), so the clipboard path
 * never submits a stale number copied before the code was requested.
 */
class ExpoWaOtpModule : Module() {

  companion object {
    private const val TAG = "ExpoWaOtp"
    private const val EVENT = "onWaOtp"
    private const val API_VERSION = 1
    private const val TTL_MS = 10L * 60L * 1000L
    private const val MAX_HANDSHAKES = 8
    private val CODE_RE = Regex("^[A-Za-z0-9]{4,10}$")

    private val handshakes = LinkedHashMap<String, Long>()
    private var pendingCode: String? = null
    private var pendingAt: Long = 0L
    private var pendingSource: String = ""
    @Volatile private var live: WeakReference<ExpoWaOtpModule>? = null

    @Synchronized
    private fun prune(now: Long) {
      val it = handshakes.entries.iterator()
      while (it.hasNext()) {
        if (now - it.next().value > TTL_MS) it.remove()
      }
      while (handshakes.size > MAX_HANDSHAKES) {
        val first = handshakes.keys.firstOrNull() ?: break
        handshakes.remove(first)
      }
    }

    @Synchronized
    private fun remember(id: String) {
      val now = System.currentTimeMillis()
      handshakes[id] = now
      prune(now)
    }

    @Synchronized
    private fun isKnown(id: String?): Boolean {
      if (id.isNullOrBlank()) return false
      prune(System.currentTimeMillis())
      return handshakes.containsKey(id.trim())
    }

    @Synchronized
    private fun stash(code: String, source: String) {
      pendingCode = code
      pendingAt = System.currentTimeMillis()
      pendingSource = source
    }

    @Synchronized
    private fun takePending(): Map<String, Any>? {
      val c = pendingCode ?: return null
      val age = System.currentTimeMillis() - pendingAt
      pendingCode = null
      if (age > TTL_MS) return null
      return mapOf("code" to c, "source" to pendingSource, "ageMs" to age)
    }

    /**
     * Called by [WaOtpCodeActivity] (one-tap) and [WaOtpCodeReceiver]
     * (zero-tap). Returns true when the intent carried a valid code.
     */
    fun handleIncoming(intent: Intent?, source: String): Boolean {
      if (intent == null) return false
      var requestId: String? = null
      var code: String? = null
      try {
        requestId = intent.getStringExtra("request_id")
        code = intent.getStringExtra("code")
      } catch (t: Throwable) {
        Log.w(TAG, "bad intent extras: ${t.message}")
        return false
      }
      if (!isKnown(requestId)) {
        // Debug signal from WhatsApp (template/hash mismatch etc.) — log only.
        var err: String? = null
        try { err = intent.getStringExtra("error") } catch (_: Throwable) {}
        Log.w(TAG, "otp intent ignored (unknown handshake) src=$source err=${err ?: "-"}")
        return false
      }
      val clean = code?.trim()?.replace(" ", "")?.replace("-", "")
      if (clean == null || !CODE_RE.matches(clean)) {
        Log.w(TAG, "otp intent without a usable code src=$source")
        return false
      }
      stash(clean, source)
      val mod = live?.get()
      if (mod != null) {
        try {
          mod.sendEvent(EVENT, mapOf("status" to "code", "code" to clean, "source" to source))
        } catch (t: Throwable) {
          Log.w(TAG, "emit failed: ${t.message}")
        }
      }
      return true
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoWaOtp")
    Events(EVENT)

    OnCreate {
      live = WeakReference(this@ExpoWaOtpModule)
    }

    OnDestroy {
      val cur = live?.get()
      if (cur === this@ExpoWaOtpModule) live = null
    }

    Function("apiVersion") { API_VERSION }

    Function("isWhatsAppInstalled") {
      val ctx = appContext.reactContext?.applicationContext
      var ok = false
      if (ctx != null) {
        try {
          ok = WhatsAppOtpHandler().isWhatsAppInstalled(ctx)
        } catch (t: Throwable) {
          Log.w(TAG, "isWhatsAppInstalled failed: ${t.message}")
        }
      }
      ok
    }

    // Handshake: call right BEFORE asking the server to send the code (and
    // again when the code screen shows — every issued id stays valid 10 min).
    // Returns false when WhatsApp is not installed / the broadcast failed.
    Function("startHandshake") {
      val ctx = appContext.reactContext?.applicationContext
      var ok = false
      if (ctx != null) {
        try {
          val handler = WhatsAppOtpHandler()
          if (handler.isWhatsAppInstalled(ctx)) {
            val id = UUID.randomUUID()
            remember(id.toString())
            handler.sendOtpIntentToWhatsApp(id, ctx)
            ok = true
          }
        } catch (t: Throwable) {
          Log.w(TAG, "handshake failed: ${t.message}")
        }
      }
      ok
    }

    // Code delivered while JS was not listening (cold start / screen remount).
    Function("consumePending") {
      takePending()
    }

    // Clipboard text only if copied at/after `sinceMs` (epoch ms). null when
    // older, empty, unknown age (API < 26) or unreadable (no focus).
    Function("getClipboardTextSince") { sinceMs: Double ->
      readClipboardSince(sinceMs.toLong())
    }
  }

  private fun readClipboardSince(sinceMs: Long): String? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
    val ctx: Context = appContext.reactContext?.applicationContext ?: return null
    var out: String? = null
    try {
      val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
      val clip = cm?.primaryClip
      val desc = clip?.description
      if (clip != null && desc != null && clip.itemCount > 0) {
        val ts = desc.timestamp
        if (ts >= sinceMs) {
          val txt = clip.getItemAt(0)?.coerceToText(ctx)?.toString()
          if (!txt.isNullOrBlank() && txt.length <= 200) out = txt
        }
      }
    } catch (t: Throwable) {
      Log.w(TAG, "clipboard read failed: ${t.message}")
    }
    return out
  }
}

/**
 * One-tap: WhatsApp starts this activity with the code when the user taps
 * "Autofill" in the chat. Invisible trampoline: hands the code to the module,
 * brings the existing Chatyy task to the front and finishes.
 * Manifest: exported, launchMode standard (Meta requirement), own empty
 * taskAffinity + excludeFromRecents so it never lands in WhatsApp's task.
 */
class WaOtpCodeActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    try {
      ExpoWaOtpModule.handleIncoming(intent, "one_tap")
    } catch (t: Throwable) {
      Log.w("ExpoWaOtp", "one-tap handle failed: ${t.message}")
    }
    try {
      val launch = packageManager.getLaunchIntentForPackage(packageName)
      if (launch != null) {
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        startActivity(launch)
      }
    } catch (t: Throwable) {
      Log.w("ExpoWaOtp", "bring to front failed: ${t.message}")
    }
    finish()
  }
}

/** Zero-tap: WhatsApp broadcasts the code without user interaction. */
class WaOtpCodeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    if (intent?.action != "com.whatsapp.otp.OTP_RETRIEVED") return
    try {
      ExpoWaOtpModule.handleIncoming(intent, "zero_tap")
    } catch (t: Throwable) {
      Log.w("ExpoWaOtp", "zero-tap handle failed: ${t.message}")
    }
  }
}
