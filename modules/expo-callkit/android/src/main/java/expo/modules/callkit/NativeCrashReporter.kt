package expo.modules.callkit

import android.content.Context
import android.os.Build
import android.util.Log
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * [native-crash-visibility 2026-05-26] Global uncaught-exception reporter.
 *
 * WHY THIS EXISTS
 * ---------------
 * The JS-side crashReporter (services/crashReporter.js) installs
 * ErrorUtils.setGlobalHandler, but that ONLY catches JS/Hermes exceptions.
 * Crashes that originate in native Kotlin (a FGS start throwing on a thread
 * the JS handler never sees, a BroadcastReceiver onReceive throwing, a media
 * op on a background thread, a Compose layout exception, etc.) tear the
 * process down WITHOUT ever reaching the JS handler — so "crasha às vezes"
 * was invisible: nothing in push_diag.log, nothing the JS reporter saw.
 *
 * This installs a process-wide Thread.setDefaultUncaughtExceptionHandler that:
 *   1. Captures a compact crash summary (class + message + top frames) +
 *      device fingerprint (Build.MODEL / SDK_INT / app versionCode) + the
 *      crashing thread name.
 *   2. Fires a best-effort POST to the SAME backend channel the JS reporter
 *      uses — email.php?action=push_diag — with `platform=android`,
 *      `step=native_crash`, `info=<summary>`. Entries land in the same
 *      push_diag.log so we can finally see native crashes alongside JS ones.
 *   3. CHAINS to the previously-installed default handler so the OS still
 *      shows the crash dialog and the process still dies normally. We do NOT
 *      swallow the crash — we only record it then delegate.
 *
 * Everything is wrapped so the handler itself can never crash boot or turn a
 * recoverable situation into a worse one. The network POST runs on a throwaway
 * thread with short timeouts and is joined briefly so it has a chance to flush
 * before the process is reaped — but a join timeout never blocks the OS handler.
 */
object NativeCrashReporter {

  private const val TAG = "NativeCrashReporter"
  private const val ENDPOINT = "https://chatyy.com.br/api/email.php?action=push_diag"

  @Volatile
  private var installed = false

  /**
   * Install the global handler. Idempotent. Never throws. Safe to call from
   * any module's OnCreate — guaranteed to load early in the process.
   */
  fun install(context: Context) {
    if (installed) return
    try {
      val appContext = context.applicationContext
      val versionCode = readVersionCode(appContext)
      val previous = Thread.getDefaultUncaughtExceptionHandler()
      Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
        // Record first (best-effort), then ALWAYS delegate to the previous
        // handler so the process dies exactly as it would have otherwise.
        try {
          report(thread, throwable, versionCode)
        } catch (_: Throwable) {
          // The reporter must never make a crash worse.
        }
        try {
          previous?.uncaughtException(thread, throwable)
        } catch (_: Throwable) {
          // If the previous handler itself throws, fall through — the
          // runtime will still terminate the process.
        }
      }
      installed = true
      Log.d(TAG, "Native uncaught-exception handler installed (vc=$versionCode)")
    } catch (t: Throwable) {
      // Installation must never crash boot.
      Log.w(TAG, "install failed: ${t.message}")
    }
  }

  private fun report(thread: Thread, throwable: Throwable, versionCode: String) {
    val stack = try {
      throwable.stackTraceToString()
    } catch (_: Throwable) {
      throwable.javaClass.name
    }
    // Truncate to ~3KB so the POST stays small and the backend log line is sane.
    val truncatedStack = if (stack.length > 3000) stack.substring(0, 3000) else stack

    val cls = throwable.javaClass.name
    val msg = (throwable.message ?: "").take(200)
    // Top 3 frames give the actual crash site without the full chain.
    val topFrames = try {
      throwable.stackTrace.take(3).joinToString(" <- ") { "${it.className}.${it.methodName}:${it.lineNumber}" }
    } catch (_: Throwable) {
      ""
    }

    // `info` mirrors the field crashReporter.js posts: a compact human string.
    // Format: <class>: <message> | thread=<name> dev=<model>/<sdk> vc=<code> | <topFrames> | <stack...>
    val info = buildString {
      append(cls)
      if (msg.isNotEmpty()) { append(": "); append(msg) }
      append(" | thread="); append(thread.name)
      append(" dev="); append(Build.MODEL); append("/"); append(Build.VERSION.SDK_INT)
      append(" vc="); append(versionCode)
      if (topFrames.isNotEmpty()) { append(" | "); append(topFrames) }
      append(" | "); append(truncatedStack)
    }

    Log.e(TAG, "NATIVE CRASH on thread=${thread.name}: $cls: $msg")

    // Best-effort POST on a throwaway thread with short timeouts. Join briefly
    // so it can flush before the process is reaped, but never block the OS
    // handler beyond the join timeout.
    val poster = Thread {
      try {
        val body = JSONObject().apply {
          put("platform", "android")
          put("step", "native_crash")
          put("info", info)
        }.toString()
        val conn = (URL(ENDPOINT).openConnection() as HttpURLConnection).apply {
          requestMethod = "POST"
          doOutput = true
          connectTimeout = 2500
          readTimeout = 2500
          setRequestProperty("Content-Type", "application/json")
          setRequestProperty("Accept", "application/json")
        }
        try {
          OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
          // Touching responseCode forces the request to actually be sent.
          val code = conn.responseCode
          Log.d(TAG, "native_crash POST → HTTP $code")
          try { conn.inputStream.close() } catch (_: Throwable) {}
        } finally {
          try { conn.disconnect() } catch (_: Throwable) {}
        }
      } catch (_: Throwable) {
        // Swallow ALL errors — a failed crash report must never mask the crash.
      }
    }
    try {
      poster.isDaemon = true
      poster.start()
      // Give the flush a short window; the OS handler will run right after.
      poster.join(2500)
    } catch (_: Throwable) {
      // join interruption / thread start failure — ignore.
    }
  }

  private fun readVersionCode(context: Context): String {
    return try {
      val pm = context.packageManager
      val pi = pm.getPackageInfo(context.packageName, 0)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        pi.longVersionCode.toString()
      } else {
        @Suppress("DEPRECATION")
        pi.versionCode.toString()
      }
    } catch (_: Throwable) {
      "?"
    }
  }
}
