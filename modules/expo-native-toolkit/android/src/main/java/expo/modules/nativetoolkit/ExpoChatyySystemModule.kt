package expo.modules.nativetoolkit

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.nativetoolkit.widget.ChatyyConversationsWidget
import org.json.JSONArray
import org.json.JSONObject

/**
 * [2026-10-09 system-integration] OS-integration bridge (JS: services/systemIntegration.js).
 *
 *   setConversations(items, opts) → SharedPreferences snapshot for the home-screen
 *       widget (widget/ChatyyConversationsWidget) + immediate widget refresh.
 *       JS already drops locked/hidden/archived chats; opts.locked=true (app
 *       lock on) makes the widget show only "Chatyy bloqueado".
 *   getNetworkConstraints() → { dataSaver (Android Data Saver ON for this app),
 *       expensive (metered), constrained } + "onNetworkConstraints" on change.
 *   getFocusFilter() → null (iOS only).
 *   clear() → logout wipe.
 */
class ExpoChatyySystemModule : Module() {

  companion object {
    private const val TAG = "ExpoChatyySystem"
    const val PREFS = "chatyy_system"
    const val KEY_CONVS = "conversations"
    const val KEY_LOCKED = "locked"
    const val KEY_UPDATED = "updated_at"
  }

  private val ctx: Context? get() = appContext.reactContext?.applicationContext
  private var receiver: BroadcastReceiver? = null

  override fun definition() = ModuleDefinition {
    Name("ExpoChatyySystem")
    Events("onNetworkConstraints")

    OnCreate {
      registerDataSaverReceiver()
    }

    OnDestroy {
      val c = ctx
      val r = receiver
      receiver = null
      if (c != null && r != null) {
        try {
          c.unregisterReceiver(r)
        } catch (_: Throwable) {
        }
      }
    }

    AsyncFunction("setConversations") { items: List<Map<String, Any?>>, opts: Map<String, Any?> ->
      val c = ctx ?: return@AsyncFunction 0
      var count = 0
      try {
        val arr = JSONArray()
        for (item in items.take(50)) {
          val id = (item["id"] ?: "").toString().trim()
          if (id.isEmpty()) continue
          val o = JSONObject()
          o.put("id", id)
          o.put("name", (item["name"] ?: "").toString().trim().take(80))
          o.put("email", (item["email"] ?: "").toString().trim())
          o.put("type", if ((item["type"] ?: "").toString() == "group") "group" else "direct")
          o.put("pinned", truthy(item["pinned"]))
          o.put("unread", intOf(item["unread"]))
          o.put("muted", truthy(item["muted"]))
          o.put("avatarUrl", (item["avatarUrl"] ?: "").toString().trim())
          o.put("acct", (item["acct"] ?: "").toString().trim())
          arr.put(o)
          count++
        }
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
          .putString(KEY_CONVS, arr.toString())
          .putBoolean(KEY_LOCKED, truthy(opts["locked"]))
          .putLong(KEY_UPDATED, System.currentTimeMillis())
          .apply()
        ChatyyConversationsWidget.refreshAll(c)
      } catch (t: Throwable) {
        Log.w(TAG, "setConversations failed: ${t.message}")
      }
      count
    }

    AsyncFunction("clear") {
      val c = ctx
      if (c != null) {
        try {
          c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
          ChatyyConversationsWidget.refreshAll(c)
        } catch (t: Throwable) {
          Log.w(TAG, "clear failed: ${t.message}")
        }
      }
      true
    }

    Function("getNetworkConstraints") {
      constraints()
    }

    Function("getFocusFilter") {
      null as Map<String, Any?>?
    }
  }

  private fun constraints(): Map<String, Any?> {
    val c = ctx ?: return mapOf("supported" to false, "known" to false)
    return try {
      val cm = c.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        ?: return mapOf("supported" to false, "known" to false)
      val metered = cm.isActiveNetworkMetered
      // RESTRICT_BACKGROUND_STATUS_ENABLED = Data Saver ON and this app is not
      // whitelisted. Only bites on metered networks (Wi-Fi is never restricted).
      val restricted = cm.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED
      mapOf(
        "supported" to true,
        "known" to true,
        "dataSaver" to (restricted && metered),
        "dataSaverSetting" to restricted,
        "constrained" to (restricted && metered),
        "expensive" to metered,
      )
    } catch (t: Throwable) {
      mapOf("supported" to false, "known" to false)
    }
  }

  private fun registerDataSaverReceiver() {
    val c = ctx ?: return
    if (receiver != null) return
    val r = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        try {
          sendEvent("onNetworkConstraints", constraints())
        } catch (_: Throwable) {
        }
      }
    }
    try {
      // System broadcast; only delivered to context-registered receivers.
      ContextCompat.registerReceiver(
        c, r, IntentFilter(ConnectivityManager.ACTION_RESTRICT_BACKGROUND_CHANGED),
        ContextCompat.RECEIVER_NOT_EXPORTED,
      )
      receiver = r
    } catch (t: Throwable) {
      Log.w(TAG, "registerReceiver failed: ${t.message}")
    }
  }

  private fun truthy(v: Any?): Boolean = when (v) {
    is Boolean -> v
    is Number -> v.toInt() != 0
    is String -> v == "1" || v.equals("true", ignoreCase = true)
    else -> false
  }

  private fun intOf(v: Any?): Int = when (v) {
    is Number -> v.toInt()
    is String -> v.toIntOrNull() ?: 0
    else -> 0
  }
}
