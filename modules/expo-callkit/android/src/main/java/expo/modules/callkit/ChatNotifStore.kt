package expo.modules.callkit

// [2026-10-07 recv-native] ChatNotifStore — the small native-readable state
// the chat notification path needs while JS is dead (app killed / background):
//
//   • per-account bearer tokens  → ChatActionReceiver signs inline Reply /
//     Mark-as-read POSTs with the RIGHT account (push tokens are shared by all
//     accounts signed in on the device; data["recipient_email"] says which
//     account a push belongs to).
//   • active conversation id     → ChatMessagingStyleHandler drops the banner
//     for the chat that is open on screen (WhatsApp: no notification for the
//     chat you are looking at).
//
// Lives in the SAME SharedPreferences file the JS already writes through
// persistAuthForNativeCall ("expo_callkit_prefs", key auth_token) so a build
// that never received the new JS call still has the active-account bearer.
// AsyncStorage is SQLite (RKStorage), NOT SharedPreferences — reading
// "RCTAsyncLocalStorage" prefs (the pre-2026-10-07 receiver) always returned "".

import android.app.ActivityManager
import android.app.KeyguardManager
import android.content.Context
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject

object ChatNotifStore {
    private const val TAG = "ChatNotifStore"
    private const val PREFS = "expo_callkit_prefs"
    private const val KEY_ACTIVE_EMAIL = "chat_auth_active_email"
    private const val KEY_TOKENS = "chat_auth_tokens"          // JSON {email: bearer}
    private const val KEY_ACTIVE_CONV = "chat_active_conversation"
    private const val KEY_ACTIVE_CONV_AT = "chat_active_conversation_at"

    fun normEmail(e: String?): String =
        (e ?: "").trim().lowercase().replace("@onemundo.com.br", "@chatyy.com.br")

    /** JS → native: active account + bearer, plus every signed-in account's bearer. */
    fun setAuth(ctx: Context, activeEmail: String?, activeToken: String?, tokens: Map<String, String>?) {
        try {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val merged = JSONObject()
            tokens?.forEach { (email, tok) ->
                val k = normEmail(email)
                if (k.isNotEmpty() && tok.isNotBlank()) merged.put(k, tok)
            }
            val act = normEmail(activeEmail)
            if (act.isNotEmpty() && !activeToken.isNullOrBlank()) merged.put(act, activeToken)
            val ed = sp.edit()
                .putString(KEY_ACTIVE_EMAIL, act)
                .putString(KEY_TOKENS, merged.toString())
            // Keep the legacy single-bearer key fresh too (LkTokenFetcher,
            // CallSignalWs and IncomingCallActivity read it).
            if (!activeToken.isNullOrBlank()) ed.putString("auth_token", activeToken)
            ed.apply()
        } catch (t: Throwable) {
            Log.w(TAG, "setAuth failed: ${t.message}")
        }
    }

    fun clearAuth(ctx: Context) {
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(KEY_ACTIVE_EMAIL).remove(KEY_TOKENS).apply()
        } catch (_: Throwable) {}
    }

    /**
     * Bearer for the account a push was addressed to. Returns null when we
     * KNOW the push belongs to an account we have no token for — the caller
     * must then NOT send (a reply signed with another account's bearer would
     * be posted as the wrong person).
     */
    fun bearerFor(ctx: Context, recipientEmail: String?): String? {
        return try {
            val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val rcpt = normEmail(recipientEmail)
            val tokens = try { JSONObject(sp.getString(KEY_TOKENS, "{}") ?: "{}") } catch (_: Throwable) { JSONObject() }
            if (rcpt.isNotEmpty()) {
                val t = tokens.optString(rcpt, "")
                if (t.isNotEmpty()) return t
            }
            val active = normEmail(sp.getString(KEY_ACTIVE_EMAIL, "") ?: "")
            val legacy = sp.getString("auth_token", "") ?: ""
            when {
                // Unknown recipient (old backend) or it IS the active account → active bearer.
                rcpt.isEmpty() || active.isEmpty() || rcpt == active -> legacy.ifEmpty { null }
                else -> null
            }
        } catch (t: Throwable) {
            Log.w(TAG, "bearerFor failed: ${t.message}")
            null
        }
    }

    fun apiBase(ctx: Context): String {
        return try {
            val b = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("api_base", "") ?: ""
            if (b.startsWith("https://")) b.trimEnd('/') else "https://chatyy.com.br"
        } catch (_: Throwable) { "https://chatyy.com.br" }
    }

    fun setActiveConversation(ctx: Context, convId: String?) {
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_ACTIVE_CONV, convId ?: "")
                .putLong(KEY_ACTIVE_CONV_AT, System.currentTimeMillis())
                .apply()
        } catch (_: Throwable) {}
    }

    fun activeConversation(ctx: Context): String {
        return try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ACTIVE_CONV, "") ?: ""
        } catch (_: Throwable) { "" }
    }

    /**
     * True only when an Activity of this process is visible AND the device is
     * interactive + unlocked — i.e. the user is actually looking at the app.
     * (A foreground SERVICE, e.g. an ongoing call, is IMPORTANCE_FOREGROUND_SERVICE,
     * not FOREGROUND, so it does not count.)
     */
    fun isAppVisibleToUser(ctx: Context): Boolean {
        return try {
            val info = ActivityManager.RunningAppProcessInfo()
            ActivityManager.getMyMemoryState(info)
            if (info.importance != ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) return false
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
            if (pm != null && !pm.isInteractive) return false
            val km = ctx.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            !(km?.isKeyguardLocked ?: false)
        } catch (_: Throwable) {
            false
        }
    }
}
