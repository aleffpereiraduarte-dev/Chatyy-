package expo.modules.callkit

import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * [2026-10-11 android-diag] Native Android call diagnostics → the SAME
 * endpoint/format the iOS `nativeCallDiag()` uses (api/voip_diag.php →
 * /var/www/mail/data/voip_diag.log), with events prefixed `native_android_`
 * so one grep shows both sides of a call:
 *
 *   grep <call_id> /var/www/mail/data/voip_diag.log
 *
 * Before this the Android side of a call was invisible (incident
 * call_1791735091317_q9bvow1ci: only native_ios_* lines). Fire-and-forget on
 * a single background thread, never throws, never blocks the caller.
 *
 * Rate limits (the endpoint allows 300/min/IP; a call emits ~10-30 events):
 *   - identical (event, callId, detail) within 3 s → dropped
 *   - max 90 events per rolling minute per process → excess dropped
 */
object CallDiag {
  private const val TAG = "CallDiag"
  private const val ENDPOINT = "https://chatyy.com.br/api/voip_diag.php"
  private const val PREFS = "expo_callkit_prefs"
  private const val MAX_PER_MIN = 90
  private const val DUP_WINDOW_MS = 3_000L

  @Volatile private var appCtx: Context? = null
  private val exec = Executors.newSingleThreadExecutor { r ->
    Thread(r, "chatyy-call-diag").apply { isDaemon = true }
  }
  private val lock = Any()
  private val sentAt = ArrayDeque<Long>()
  private val lastByKey = LinkedHashMap<String, Long>()

  // [2026-10-18 calls-data] callId → "caller" | "callee" (bounded, thread-safe).
  private val roles = object : LinkedHashMap<String, String>(16, 0.75f, false) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean = size > 32
  }

  /** Remember our role in [callId] ("caller" / "callee"). First writer wins
   *  except that an explicit "caller" always overrides a heuristic. */
  fun setRole(callId: String?, role: String) {
    val cid = callId ?: return
    if (cid.isEmpty() || (role != "caller" && role != "callee")) return
    try { synchronized(lock) { if (roles[cid] == null || role == "caller") roles[cid] = role } } catch (_: Throwable) {}
  }

  private fun roleFor(callId: String, event: String): String {
    if (callId.isNotEmpty()) {
      val r = synchronized(lock) { roles[callId] }
      if (r != null) return r
    }
    val e = event.lowercase()
    return when {
      e.contains("outgoing") || e.startsWith("invite_") || e.contains("ringback") -> "caller"
      e.contains("push_received") || e.contains("incoming") || e.contains("ring") ||
        e.contains("preconnect") || e.contains("caller_cancel") || e.contains("dedupe") -> "callee"
      else -> "unknown"
    }
  }

  /** Optional: remember the app context so callers without one still get the user email. */
  fun init(ctx: Context?) {
    if (ctx != null && appCtx == null) appCtx = ctx.applicationContext
  }

  /**
   * @param event short snake_case name WITHOUT prefix (e.g. "invite_sent").
   * @param callId call id / LK room name ("" when unknown).
   * @param detail free text key=value pairs (truncated to 900 chars).
   */
  fun log(event: String, callId: String?, detail: String = "", ctx: Context? = null) {
    try {
      init(ctx)
      val now = System.currentTimeMillis()
      val cid = callId ?: ""
      val key = "$event|$cid|$detail"
      synchronized(lock) {
        val last = lastByKey[key]
        if (last != null && now - last < DUP_WINDOW_MS) return
        lastByKey[key] = now
        if (lastByKey.size > 64) {
          val it = lastByKey.entries.iterator()
          while (lastByKey.size > 48 && it.hasNext()) { it.next(); it.remove() }
        }
        while (sentAt.isNotEmpty() && now - sentAt.first() > 60_000L) sentAt.removeFirst()
        if (sentAt.size >= MAX_PER_MIN) return
        sentAt.addLast(now)
      }
      // [2026-10-18 calls-data] diag_identity (call_res_flags): plain email
      // (voip_diag.php logs `user` as-is) + role appended to detail.
      val fl = try { CallResilience.flags(appCtx) } catch (_: Throwable) { null }
      val ident = fl?.diagIdentity ?: false
      val keepAliveOn = fl?.lkFastConnect ?: false
      val sp = try { appCtx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE) } catch (_: Throwable) { null }
      val user = try {
        if (ident) {
          (sp?.getString("diag_user_email", null)?.takeIf { it.isNotBlank() }
            ?: sp?.getString("user_email", "") ?: "")
        } else {
          sp?.getString("user_email", "") ?: ""
        }
      } catch (_: Throwable) { "" }
      val fullDetail = if (ident) {
        val roleTag = " role=" + roleFor(cid, event)
        detail.take(900 - roleTag.length) + roleTag
      } else detail
      Log.i(TAG, "native_android_$event call=$cid $fullDetail")
      val body = JSONObject().apply {
        put("event", "native_android_$event".take(110))
        put("call_id", cid.take(110))
        put("user", user)
        put("detail", fullDetail.take(900))
        put("platform", "android-native")
        put("device", "${Build.MODEL}/${Build.VERSION.SDK_INT}")
        put("ts", now)
      }.toString()
      exec.execute {
        try {
          val conn = (URL(ENDPOINT).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 5000
            readTimeout = 5000
            setRequestProperty("Content-Type", "application/json")
          }
          var reuse = false
          try {
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
            val code = conn.responseCode
            try { conn.inputStream.use { s -> s.readBytes() } } catch (_: Throwable) {}
            // [2026-10-18 calls-data] lk_fast_connect: keep the warm TLS socket
            // to chatyy.com.br for the token fetch that follows push_received.
            reuse = code in 200..299 && keepAliveOn
          } finally { if (!reuse) { try { conn.disconnect() } catch (_: Throwable) {} } }
        } catch (_: Throwable) {}
      }
    } catch (_: Throwable) {}
  }
}
