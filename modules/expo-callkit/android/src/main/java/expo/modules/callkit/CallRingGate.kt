package expo.modules.callkit

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.util.Collections

/**
 * [2026-10-15 dnd] Callee-side "the ring will not reach the user" gate —
 * Android twin of the iOS rule "reportNewIncomingCall failed (Focus) → no
 * preconnect + call_status dnd".
 *
 * On Android Telecom/ConnectionService failure is NOT a rejection: the
 * CallRingingService FGS + notification ring on their own. What really
 * silences a call is zen mode (Do Not Disturb): the call notification is
 * intercepted (no heads-up / full-screen) and AudioService mutes
 * USAGE_NOTIFICATION_RINGTONE (our MediaPlayer ringer). We only report when
 * that is CERTAIN:
 *   - filter NONE (total silence)                         → silenced;
 *   - filter ALARMS and our channel cannot bypass DND     → silenced;
 *   - filter PRIORITY, channel cannot bypass DND, and the policy allows
 *     neither calls nor repeat callers                    → silenced.
 * "Calls from contacts/starred only" depends on person matching → NOT
 * reported (it may ring). App in foreground → IncomingCallActivity is
 * launched directly (visible) → never reported.
 *
 * When silenced: skip the ring-window LiveKit preconnect (its LK join is what
 * paints "Tocando…" on the caller) and POST call_status{status:"dnd"} once per
 * call_id; chat.php relays call_peer_status{dnd} to the caller. A 400 from a
 * server without the patch is ignored. The ring notification itself is still
 * posted (it lands silently in the shade; answering from it joins cold).
 * Kill switch: prefs bool "chatyy_dnd_gate_off" (expo_callkit_prefs).
 */
object CallRingGate {
  private const val TAG = "CallRingGate"
  private const val PREFS = "expo_callkit_prefs"

  /** call_ids already judged silenced (no preconnect for them). Bounded. */
  private val silenced: MutableSet<String> = Collections.synchronizedSet(LinkedHashSet())

  fun isSilenced(callId: String): Boolean = callId.isNotEmpty() && silenced.contains(callId)

  /** Non-null reason ("focus") when zen mode certainly silences our ring. */
  fun ringSilencedReason(ctx: Context): String? {
    try {
      val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      if (sp.getBoolean("chatyy_dnd_gate_off", false)) return null
      if (IncomingCallRegistry.isAppForeground(ctx)) return null
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return null
      val filter = nm.currentInterruptionFilter
      if (filter == NotificationManager.INTERRUPTION_FILTER_ALL ||
          filter == NotificationManager.INTERRUPTION_FILTER_UNKNOWN) return null
      val bypass = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        try { nm.getNotificationChannel(CallNotificationService.CHANNEL_ID)?.canBypassDnd() == true } catch (_: Throwable) { false }
      } else false
      return when (filter) {
        NotificationManager.INTERRUPTION_FILTER_NONE -> "focus"
        NotificationManager.INTERRUPTION_FILTER_ALARMS -> if (bypass) null else "focus"
        NotificationManager.INTERRUPTION_FILTER_PRIORITY -> {
          if (bypass) return null
          val p = try { nm.notificationPolicy } catch (_: Throwable) { null } ?: return null
          val cats = p.priorityCategories
          val calls = (cats and NotificationManager.Policy.PRIORITY_CATEGORY_CALLS) != 0
          val repeat = (cats and NotificationManager.Policy.PRIORITY_CATEGORY_REPEAT_CALLERS) != 0
          if (!calls && !repeat) "focus" else null
        }
        else -> null
      }
    } catch (t: Throwable) {
      Log.w(TAG, "ringSilencedReason failed: ${t.message}")
      return null
    }
  }

  /**
   * Evaluates the gate for an incoming ring. Returns true when the ring is
   * silenced (caller must then SKIP the preconnect); reports dnd once.
   */
  fun checkAndReport(ctx: Context, callId: String, src: String): Boolean {
    if (callId.isEmpty()) return false
    if (isSilenced(callId)) return true
    val reason = ringSilencedReason(ctx) ?: return false
    synchronized(silenced) {
      if (!silenced.add(callId)) return true
      while (silenced.size > 32) {
        val it = silenced.iterator(); it.next(); it.remove()
      }
    }
    CallDiag.log("ring_silenced_dnd", callId, "src=$src reason=$reason", ctx)
    postDnd(ctx.applicationContext, callId, reason)
    return true
  }

  private fun postDnd(app: Context, callId: String, reason: String) {
    Thread {
      try {
        val sp = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val token = sp.getString("auth_token", "") ?: ""
        val apiBase = sp.getString("api_base", "") ?: ""
        if (token.isEmpty() || apiBase.isEmpty()) return@Thread
        val base = if (apiBase.endsWith("/")) apiBase.dropLast(1) else apiBase
        val conn = (java.net.URL("$base/api/email.php?action=call_status").openConnection() as java.net.HttpURLConnection).apply {
          requestMethod = "POST"
          setRequestProperty("Authorization", "Bearer $token")
          setRequestProperty("Content-Type", "application/json")
          setRequestProperty("Accept", "application/json")
          doOutput = true
          connectTimeout = 5000
          readTimeout = 6000
        }
        val body = JSONObject().apply {
          put("action", "call_status"); put("call_id", callId); put("status", "dnd")
          put("reason", reason); put("duration", 0)
        }.toString()
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        val code = conn.responseCode
        try { (if (code < 400) conn.inputStream else conn.errorStream)?.close() } catch (_: Throwable) {}
        CallDiag.log("dnd_http", callId, "code=$code", app)
      } catch (t: Throwable) {
        Log.w(TAG, "dnd HTTP failed: ${t.message}")
      }
    }.apply { isDaemon = true }.start()
  }
}
