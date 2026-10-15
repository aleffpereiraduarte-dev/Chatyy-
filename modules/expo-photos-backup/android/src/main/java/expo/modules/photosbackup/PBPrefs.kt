package expo.modules.photosbackup

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject
import java.security.MessageDigest

// [2026-10-15 photos-native] Configuração persistida do backup nativo.
// Fica em SharedPreferences privadas (o Worker roda sem o JS vivo e precisa
// do token). Uma conta "ativa" por vez; o banco de estado é por conta
// (PBStore, pb_<acct>.sqlite) — trocar de conta nunca mistura filas.
internal class PBPrefs(context: Context) {
  private val sp: SharedPreferences =
    context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

  companion object {
    const val NAME = "chatyy_photos_backup"

    fun acctHash(email: String): String {
      val d = MessageDigest.getInstance("SHA-256").digest(email.trim().lowercase().toByteArray())
      return d.joinToString("") { "%02x".format(it) }.substring(0, 16)
    }
  }

  var account: String
    get() = sp.getString("account", "") ?: ""
    set(v) { sp.edit().putString("account", v).apply() }
  var acct: String
    get() = sp.getString("acct", "") ?: ""
    set(v) { sp.edit().putString("acct", v).apply() }
  var token: String
    get() = sp.getString("token", "") ?: ""
    set(v) { sp.edit().putString("token", v).apply() }
  var apiBase: String
    get() = sp.getString("apiBase", "") ?: ""
    set(v) { sp.edit().putString("apiBase", v).apply() }
  var fallbackBase: String
    get() = sp.getString("fallbackBase", "https://chatyy.com.br") ?: "https://chatyy.com.br"
    set(v) { sp.edit().putString("fallbackBase", v).apply() }
  var enabled: Boolean
    get() = sp.getBoolean("enabled", false)
    set(v) { sp.edit().putBoolean("enabled", v).apply() }
  var paused: Boolean
    get() = sp.getBoolean("paused", false)
    set(v) { sp.edit().putBoolean("paused", v).apply() }
  var wifiOnly: Boolean
    get() = sp.getBoolean("wifiOnly", true)
    set(v) { sp.edit().putBoolean("wifiOnly", v).apply() }
  var chargingOnly: Boolean
    get() = sp.getBoolean("chargingOnly", false)
    set(v) { sp.edit().putBoolean("chargingOnly", v).apply() }
  var quality: String
    get() = sp.getString("quality", "original") ?: "original"
    set(v) { sp.edit().putString("quality", v).apply() }
  var includeVideos: Boolean
    get() = sp.getBoolean("includeVideos", true)
    set(v) { sp.edit().putBoolean("includeVideos", v).apply() }
  var notify: Boolean
    get() = sp.getBoolean("notify", true)
    set(v) { sp.edit().putBoolean("notify", v).apply() }
  var labelsJson: String
    get() = sp.getString("labels", "{}") ?: "{}"
    set(v) { sp.edit().putString("labels", v).apply() }
  var lastRunAt: Long
    get() = sp.getLong("lastRunAt", 0L)
    set(v) { sp.edit().putLong("lastRunAt", v).apply() }
  var lastError: String
    get() = sp.getString("lastError", "") ?: ""
    set(v) { sp.edit().putString("lastError", v).apply() }
  var blockedBy: String
    get() = sp.getString("blockedBy", "") ?: ""
    set(v) { sp.edit().putString("blockedBy", v).apply() }

  fun label(key: String, fallback: String): String {
    return try {
      val o = JSONObject(labelsJson)
      val s = o.optString(key, "")
      if (s.isNullOrEmpty()) fallback else s
    } catch (_: Exception) { fallback }
  }

  /** true quando há conta + token para trabalhar. */
  fun hasCreds(): Boolean = acct.isNotEmpty() && token.isNotEmpty() && apiBase.isNotEmpty()
}

/**
 * Ponte de eventos Worker → módulo JS (mesmo processo: WorkManager roda o
 * Worker no processo do app). Sem JS vivo, `listener` é null e nada acontece.
 */
internal object PBEvents {
  @Volatile var listener: ((String, Map<String, Any?>) -> Unit)? = null

  fun emit(name: String, body: Map<String, Any?>) {
    try { listener?.invoke(name, body) } catch (_: Throwable) {}
  }
}
