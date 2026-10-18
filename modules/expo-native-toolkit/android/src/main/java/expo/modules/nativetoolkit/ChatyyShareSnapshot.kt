package expo.modules.nativetoolkit

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * [2026-10-18 native-share] Snapshot do compartilhar NATIVO do Android
 * (modules/expo-chat-transport … ChatyyShareActivity lê; JS:
 * services/nativeShareSnapshot.js grava via ExpoChatyySystem.setShareSnapshot).
 *
 * SharedPreferences "chatyy_native_share":
 *   enabled  = Boolean (kill switch do JS; ausente/false → Activity encaminha p/ o app)
 *   snapshot = {"v":1,"acct","at","locked","items":[{id,title,is_group,email,avatar}]}
 *              avatar = caminho ABSOLUTO de uma miniatura (filesDir/chatyy_share_avatars)
 * O JS já tirou E2EE, bloqueadas, trancadas, arquivadas e canais.
 */
object ChatyyShareSnapshot {
  private const val TAG = "ChatyyShareSnapshot"
  const val PREFS = "chatyy_native_share"
  const val KEY_ENABLED = "enabled"
  const val KEY_SNAPSHOT = "snapshot"
  private const val MAX_ITEMS = 60
  private const val AVATAR_PX = 160
  private const val AVATAR_MAX_AGE_MS = 3L * 24 * 3600 * 1000
  private const val DEFAULT_BASE = "https://chatyy.com.br"
  private val io = Executors.newSingleThreadExecutor()

  private fun avatarsDir(c: Context): File = File(c.filesDir, "chatyy_share_avatars").apply { mkdirs() }

  private fun md5(s: String): String {
    val d = MessageDigest.getInstance("MD5").digest(s.toByteArray(Charsets.UTF_8))
    val sb = StringBuilder()
    for (b in d) sb.append(String.format("%02x", b))
    return sb.toString()
  }

  private fun absUrl(raw: String, base: String): String {
    val s = raw.trim()
    if (s.startsWith("https://")) return s
    if (s.startsWith("/")) return (if (base.startsWith("https://")) base.trimEnd('/') else DEFAULT_BASE) + s
    return ""
  }

  private fun truthy(v: Any?): Boolean = when (v) {
    is Boolean -> v
    is Number -> v.toInt() != 0
    is String -> v == "1" || v.equals("true", ignoreCase = true)
    else -> false
  }

  fun write(c: Context, items: List<Map<String, Any?>>, opts: Map<String, Any?>): Int {
    val prefs = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val enabled = truthy(opts["enabled"])
    val acct = (opts["account"] ?: "").toString().trim().lowercase()
    if (!enabled || acct.isEmpty()) {
      prefs.edit().putBoolean(KEY_ENABLED, enabled).remove(KEY_SNAPSHOT).apply()
      return 0
    }
    val base = (opts["base"] ?: "").toString()
    val rows = JSONArray()
    val downloads = ArrayList<Pair<String, File>>()
    val seen = HashSet<String>()
    val dir = avatarsDir(c)
    val callkitDir = File(c.cacheDir, "chat_avatars")
    for (item in items) {
      if (rows.length() >= MAX_ITEMS) break
      val id = (item["id"] ?: "").toString().trim()
      val title = (item["title"] ?: "").toString().trim()
      if (id.isEmpty() || title.isEmpty() || !seen.add(id)) continue
      var avatar = ""
      val url = absUrl((item["avatar_url"] ?: "").toString(), base)
      if (url.isNotEmpty()) {
        val h = md5(url)
        val mine = File(dir, "$h.png")
        val callkit = File(callkitDir, "$h.png")
        avatar = if (!mine.exists() && callkit.exists()) callkit.absolutePath else mine.absolutePath
        downloads.add(url to mine)
      }
      rows.put(JSONObject()
        .put("id", id)
        .put("title", title.take(80))
        .put("is_group", truthy(item["is_group"]))
        .put("email", (item["email"] ?: "").toString().trim().lowercase())
        .put("avatar", avatar))
    }
    val snap = JSONObject()
      .put("v", 1).put("acct", acct).put("at", System.currentTimeMillis())
      .put("locked", truthy(opts["locked"])).put("items", rows)
    prefs.edit().putBoolean(KEY_ENABLED, true).putString(KEY_SNAPSHOT, snap.toString()).apply()
    val app = c.applicationContext ?: c
    try { io.execute { fetchAvatars(app, downloads) } } catch (_: Throwable) {}
    return rows.length()
  }

  fun clear(c: Context) {
    try { c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply() } catch (_: Throwable) {}
    val app = c.applicationContext ?: c
    try { io.execute { try { avatarsDir(app).deleteRecursively() } catch (_: Throwable) {} } } catch (_: Throwable) {}
  }

  private fun fetchAvatars(c: Context, list: List<Pair<String, File>>) {
    val now = System.currentTimeMillis()
    val keep = list.map { it.second.name }.toHashSet()
    try {
      avatarsDir(c).listFiles()?.forEach { f ->
        if (f.name !in keep && now - f.lastModified() > 7L * 24 * 3600 * 1000) f.delete()
      }
    } catch (_: Throwable) {}
    for ((url, dst) in list) {
      if (dst.exists() && now - dst.lastModified() < AVATAR_MAX_AGE_MS) continue
      var conn: HttpURLConnection? = null
      try {
        conn = (URL(url).openConnection() as HttpURLConnection).apply {
          connectTimeout = 10_000
          readTimeout = 15_000
          instanceFollowRedirects = true
        }
        if (conn.responseCode != 200) continue
        val bytes = conn.inputStream.use { it.readBytes() }
        if (bytes.isEmpty() || bytes.size > 4 * 1024 * 1024) continue
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= AVATAR_PX && bounds.outHeight / (sample * 2) >= AVATAR_PX) sample *= 2
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: continue
        val side = minOf(bmp.width, bmp.height)
        val sq = Bitmap.createBitmap(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side)
        val out = Bitmap.createScaledBitmap(sq, AVATAR_PX, AVATAR_PX, true)
        val tmp = File(dst.path + ".tmp")
        FileOutputStream(tmp).use { out.compress(Bitmap.CompressFormat.PNG, 100, it) }
        tmp.renameTo(dst)
      } catch (t: Throwable) {
        Log.w(TAG, "avatar fetch failed: ${t.message}")
      } finally {
        try { conn?.disconnect() } catch (_: Throwable) {}
      }
    }
  }
}
