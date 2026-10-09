package expo.modules.nativetoolkit.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.Typeface
import android.net.Uri
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import expo.modules.nativetoolkit.ExpoChatyySystemModule
import expo.modules.nativetoolkit.R
import org.json.JSONArray
import java.io.File
import java.security.MessageDigest

/**
 * [2026-10-09 system-integration] Home-screen widget "Conversas do Chatyy":
 * up to 4 recent conversations (pinned first) with avatar + unread count.
 * Privacy: never shows message content; locked/hidden/archived chats are never
 * in the snapshot; when the app lock is on only "Chatyy bloqueado" is shown.
 *
 * Data: SharedPreferences written by ExpoChatyySystemModule.setConversations.
 * Taps: plain ACTION_VIEW deep links (same shape as the launcher shortcuts),
 * handled by expo-router — no extra activity.
 */
class ChatyyConversationsWidget : AppWidgetProvider() {

  companion object {
    private const val TAG = "ChatyyWidget"
    private const val SCHEME = "onemundomail"
    private const val AVATAR_HOST = "https://chatyy.com.br"
    private const val AVATAR_PX = 96
    private const val MAX_ROWS = 4

    private val ROW_IDS = intArrayOf(R.id.chatyy_w_row1, R.id.chatyy_w_row2, R.id.chatyy_w_row3, R.id.chatyy_w_row4)
    private val AVATAR_IDS = intArrayOf(R.id.chatyy_w_avatar1, R.id.chatyy_w_avatar2, R.id.chatyy_w_avatar3, R.id.chatyy_w_avatar4)
    private val NAME_IDS = intArrayOf(R.id.chatyy_w_name1, R.id.chatyy_w_name2, R.id.chatyy_w_name3, R.id.chatyy_w_name4)
    private val BADGE_IDS = intArrayOf(R.id.chatyy_w_badge1, R.id.chatyy_w_badge2, R.id.chatyy_w_badge3, R.id.chatyy_w_badge4)

    /** Re-renders every placed instance (no-op when none is placed). */
    fun refreshAll(context: Context) {
      try {
        val mgr = AppWidgetManager.getInstance(context) ?: return
        val ids = mgr.getAppWidgetIds(ComponentName(context, ChatyyConversationsWidget::class.java))
        if (ids == null || ids.isEmpty()) return
        for (id in ids) render(context, mgr, id)
      } catch (t: Throwable) {
        Log.w(TAG, "refreshAll failed: ${t.message}")
      }
    }

    private fun render(context: Context, mgr: AppWidgetManager, widgetId: Int) {
      val views = RemoteViews(context.packageName, R.layout.chatyy_widget_conversations)
      val prefs = context.getSharedPreferences(ExpoChatyySystemModule.PREFS, Context.MODE_PRIVATE)
      val locked = prefs.getBoolean(ExpoChatyySystemModule.KEY_LOCKED, false)
      val raw = prefs.getString(ExpoChatyySystemModule.KEY_CONVS, null)

      views.setOnClickPendingIntent(R.id.chatyy_w_header, viewIntent(context, "$SCHEME://chat", 9000 + widgetId))
      views.setOnClickPendingIntent(R.id.chatyy_w_new, viewIntent(context, "$SCHEME://chat-new", 9100 + widgetId))

      var rows = 0
      if (!locked && !raw.isNullOrEmpty()) {
        try {
          val arr = JSONArray(raw)
          // Pinned first, keep the JS order (most recent first) otherwise.
          val ordered = ArrayList<org.json.JSONObject>()
          for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (o.optBoolean("pinned")) ordered.add(o)
          }
          for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (!o.optBoolean("pinned")) ordered.add(o)
          }
          for (o in ordered) {
            if (rows >= MAX_ROWS) break
            val id = o.optString("id")
            if (id.isEmpty()) continue
            val name = o.optString("name").ifEmpty { o.optString("email") }.ifEmpty { "Chatyy" }
            val isGroup = o.optString("type") == "group"
            val unread = o.optInt("unread", 0)
            views.setViewVisibility(ROW_IDS[rows], View.VISIBLE)
            views.setTextViewText(NAME_IDS[rows], name)
            if (unread > 0) {
              views.setViewVisibility(BADGE_IDS[rows], View.VISIBLE)
              views.setTextViewText(BADGE_IDS[rows], if (unread > 99) "99+" else unread.toString())
            } else {
              views.setViewVisibility(BADGE_IDS[rows], View.GONE)
            }
            val email = o.optString("email")
            val avatarUrl = o.optString("avatarUrl")
            val canonical = if (!isGroup && email.contains('@'))
              "$AVATAR_HOST/api/email.php?action=get_avatar&email=" + Uri.encode(email) else ""
            val bmp = cachedAvatar(context, avatarUrl) ?: cachedAvatar(context, canonical) ?: letterAvatar(name)
            views.setImageViewBitmap(AVATAR_IDS[rows], bmp)
            val uri = Uri.Builder().scheme(SCHEME).authority("chat-conversation")
              .appendQueryParameter("id", id)
              .appendQueryParameter("type", if (isGroup) "group" else "direct")
              .appendQueryParameter("name", name)
              .apply { if (email.isNotEmpty()) appendQueryParameter("email", email) }
              .apply { val a = o.optString("acct"); if (a.isNotEmpty()) appendQueryParameter("acct", a) }
              .appendQueryParameter("src", "widget")
              .build()
            views.setOnClickPendingIntent(ROW_IDS[rows], viewIntent(context, uri.toString(), widgetId * 10 + rows))
            rows++
          }
        } catch (t: Throwable) {
          Log.w(TAG, "render parse failed: ${t.message}")
        }
      }
      for (i in rows until MAX_ROWS) views.setViewVisibility(ROW_IDS[i], View.GONE)
      if (rows == 0) {
        views.setViewVisibility(R.id.chatyy_w_empty, View.VISIBLE)
        views.setTextViewText(
          R.id.chatyy_w_empty,
          context.getString(if (locked) R.string.chatyy_widget_locked else R.string.chatyy_widget_empty),
        )
        views.setOnClickPendingIntent(R.id.chatyy_w_empty, viewIntent(context, "$SCHEME://chat", 9200 + widgetId))
      } else {
        views.setViewVisibility(R.id.chatyy_w_empty, View.GONE)
      }
      mgr.updateAppWidget(widgetId, views)
    }

    private fun viewIntent(context: Context, url: String, requestCode: Int): PendingIntent {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        .setPackage(context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      return PendingIntent.getActivity(
        context, requestCode, intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    /** Read-only lookup in the expo-callkit avatar cache (cacheDir/chat_avatars/md5(absUrl).png). */
    private fun cachedAvatar(c: Context, url: String): Bitmap? {
      if (url.isEmpty()) return null
      val abs = when {
        url.startsWith("https://") -> url
        url.startsWith("/") -> AVATAR_HOST + url
        else -> return null
      }
      return try {
        val f = File(File(c.cacheDir, "chat_avatars"), md5(abs) + ".png")
        if (!f.exists()) return null
        val opts = BitmapFactory.Options().apply { inSampleSize = 2 }
        val src = BitmapFactory.decodeFile(f.absolutePath, opts) ?: return null
        circle(Bitmap.createScaledBitmap(src, AVATAR_PX, AVATAR_PX, true))
      } catch (_: Throwable) {
        null
      }
    }

    private fun circle(src: Bitmap): Bitmap {
      val out = Bitmap.createBitmap(AVATAR_PX, AVATAR_PX, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(out)
      val p = Paint(Paint.ANTI_ALIAS_FLAG)
      p.shader = BitmapShader(src, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
      canvas.drawCircle(AVATAR_PX / 2f, AVATAR_PX / 2f, AVATAR_PX / 2f, p)
      return out
    }

    // Black & white letter avatar (app visual language: P&B).
    private fun letterAvatar(name: String): Bitmap {
      val out = Bitmap.createBitmap(AVATAR_PX, AVATAR_PX, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(out)
      val bg = Paint(Paint.ANTI_ALIAS_FLAG)
      bg.color = Color.rgb(0x1F, 0x1F, 0x1F)
      canvas.drawCircle(AVATAR_PX / 2f, AVATAR_PX / 2f, AVATAR_PX / 2f, bg)
      val letter = name.trim().firstOrNull { it.isLetterOrDigit() }?.uppercaseChar()?.toString() ?: "C"
      val tp = Paint(Paint.ANTI_ALIAS_FLAG)
      tp.color = Color.WHITE
      tp.textSize = AVATAR_PX * 0.44f
      tp.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      tp.textAlign = Paint.Align.CENTER
      val y = AVATAR_PX / 2f - (tp.descent() + tp.ascent()) / 2f
      canvas.drawText(letter, AVATAR_PX / 2f, y, tp)
      return out
    }

    private fun md5(s: String): String {
      val d = MessageDigest.getInstance("MD5").digest(s.toByteArray(Charsets.UTF_8))
      val sb = StringBuilder(d.size * 2)
      for (b in d) sb.append(String.format("%02x", b))
      return sb.toString()
    }
  }

  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    for (id in appWidgetIds) {
      try {
        render(context, appWidgetManager, id)
      } catch (t: Throwable) {
        Log.w(TAG, "onUpdate failed: ${t.message}")
      }
    }
  }
}
