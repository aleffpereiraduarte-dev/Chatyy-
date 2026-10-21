package expo.modules.chatyytransport

import android.app.Activity
import android.content.ClipData
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.inputmethod.EditorInfo
import android.webkit.MimeTypeMap
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.text.Normalizer
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors

/**
 * [2026-10-18 native-share] Compartilhar 100% NATIVO no Android (estilo WhatsApp):
 * escolher conversas (busca, recentes, multi-seleção, Direct Share pré-seleciona
 * pelo EXTRA_SHORTCUT_ID "chat_<id>") → prévia + legenda → enviar. O envio vai
 * para a FILA NATIVA (OutboxCore: /api/rust/upload + chat_send, WorkManager com
 * o app fechado) — o RN nem sobe.
 *
 * Fallback (encaminha o MESMO intent para a MainActivity → /share-receive, como
 * antes): kill switch do JS (prefs chatyy_native_share.enabled), bloqueio do app,
 * sem snapshot/credencial da conta, conteúdo não suportado (vCard, export do
 * WhatsApp, .wastickers, > 10 itens), ou "Mais opções no Chatyy".
 *
 * Declarada no AndroidManifest do APP por plugins/with-android-share-intents.js
 * (com os filtros SEND que antes ficavam na MainActivity); CHATYY_NATIVE_SHARE=0
 * no prebuild → nem é declarada.
 */
class ChatyyShareActivity : Activity() {

  companion object {
    private const val TAG = "ChatyyShare"
    const val PREFS = "chatyy_native_share"
    private const val EXTRA_SHORTCUT_ID = "android.intent.extra.shortcut.ID"
    private const val MAX_RECIPIENTS = 5
    private const val MAX_ITEMS = 10
    private const val MAX_SENDS = 30
    private const val MAX_BYTES = 200L * 1024 * 1024
    private const val IMAGE_MAX_PX = 2560
    private const val ORIGIN = "https://chatyy.com.br"
  }

  private class Conv(val id: String, val title: String, val isGroup: Boolean, val email: String, val avatar: String, val key: String)

  private class Item(val kind: String) {
    var file: File? = null
    var mime: String = "application/octet-stream"
    var name: String = "file"
    var size: Long = 0
    var text: String = ""
    var thumb: Bitmap? = null
    var durationMs: Long = 0
    val isMedia: Boolean get() = kind == "image" || kind == "video" || kind == "file"
  }

  private val main = Handler(Looper.getMainLooper())
  private val exec = Executors.newSingleThreadExecutor()
  /** Avatares não esperam atrás da cópia/conversão de vídeos e fotos. */
  private val avatarExec = Executors.newSingleThreadExecutor()
  private var account = ""
  private var creds: OutboxCore.Creds? = null
  private var convs: List<Conv> = emptyList()
  private val selected = ArrayList<String>()
  private var items: List<Item> = emptyList()
  private var loadError: String? = null
  private var loaded = false
  private var pendingCompose = false
  private var preselected = false
  private var finishedFlow = false
  private var batchDir: File? = null
  private var screen = "picker"

  private var dark = false
  private var cBg = Color.WHITE
  private var cInk = Color.BLACK
  private var cSecondary = Color.GRAY
  private var cFill = Color.LTGRAY
  private var cHairline = Color.LTGRAY

  private lateinit var root: FrameLayout
  private var adapter: ConvAdapter? = null
  private var footerBar: View? = null
  private var footerNames: TextView? = null
  private var overlay: View? = null

  // ─── textos ─────────────────────────────────────────────────────────────
  private val lang: String = Locale.getDefault().language.lowercase()
  private fun t(pt: String, en: String, es: String): String = when (lang) { "pt" -> pt; "es" -> es; else -> en }

  private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()
  private fun dp(v: Int): Int = dp(v.toFloat())

  // ─── ciclo de vida ───────────────────────────────────────────────────────

  override fun onCreate(savedInstanceState: Bundle?) {
    dark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    setTheme(if (dark) android.R.style.Theme_Material_NoActionBar else android.R.style.Theme_Material_Light_NoActionBar)
    super.onCreate(savedInstanceState)
    if (!evaluateGate()) { forwardToApp("gate"); return }
    cBg = if (dark) Color.BLACK else Color.WHITE
    cInk = if (dark) Color.WHITE else Color.BLACK
    cSecondary = if (dark) Color.rgb(158, 158, 158) else Color.rgb(102, 102, 102)
    cFill = if (dark) Color.rgb(31, 31, 31) else Color.rgb(242, 242, 242)
    cHairline = if (dark) Color.argb(36, 255, 255, 255) else Color.argb(26, 0, 0, 0)
    setupWindow()
    root = FrameLayout(this)
    root.setBackgroundColor(cBg)
    setContentView(root)
    if (Build.VERSION.SDK_INT >= 33) {
      try {
        onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { handleBack() }
      } catch (_: Throwable) {}
    }
    sweepOld()
    startLoading()
    val sid = try { intent.getStringExtra(EXTRA_SHORTCUT_ID) } catch (_: Throwable) { null }
    val pre = sid?.removePrefix("chat_")?.takeIf { id -> convs.any { it.id == id } }
    if (pre != null) {
      preselected = true
      selected.add(pre)
      showCompose()
    } else {
      showPicker()
    }
  }

  override fun onDestroy() {
    super.onDestroy()
    try { exec.shutdown() } catch (_: Throwable) {}
    try { avatarExec.shutdownNow() } catch (_: Throwable) {}
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    handleBack()
  }

  private fun handleBack() {
    if (finishedFlow) return
    if (screen == "compose" && !preselected) { showPicker(); return }
    cancelFlow()
  }

  private fun setupWindow() {
    val w = window
    try {
      if (Build.VERSION.SDK_INT >= 30) {
        w.setDecorFitsSystemWindows(false)
        val light = if (dark) 0 else (WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
        w.insetsController?.setSystemBarsAppearance(light, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
      } else if (!dark) {
        @Suppress("DEPRECATION")
        w.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or (if (Build.VERSION.SDK_INT >= 26) View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR else 0)
      }
      @Suppress("DEPRECATION")
      w.statusBarColor = if (Build.VERSION.SDK_INT >= 30) Color.TRANSPARENT else (if (dark) Color.BLACK else Color.WHITE)
      @Suppress("DEPRECATION")
      w.navigationBarColor = if (Build.VERSION.SDK_INT >= 30) Color.TRANSPARENT else (if (dark) Color.BLACK else Color.WHITE)
    } catch (_: Throwable) {}
  }

  private fun applyInsets(v: View) {
    v.setOnApplyWindowInsetsListener { view, ins ->
      if (Build.VERSION.SDK_INT >= 30) {
        val i = ins.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
        view.setPadding(i.left, i.top, i.right, i.bottom)
      }
      ins
    }
    v.requestApplyInsets()
  }

  // ─── portão: nativo ou o app ─────────────────────────────────────────────

  private fun evaluateGate(): Boolean {
    try {
      val action = intent?.action ?: return false
      if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return false
      val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      if (!prefs.getBoolean("enabled", false)) return false
      val snap = JSONObject(prefs.getString("snapshot", null) ?: return false)
      if (snap.optBoolean("locked", false)) return false
      account = snap.optString("acct").trim().lowercase()
      if (account.isEmpty()) return false
      creds = NativeOutbox.Creds.load(this, account) ?: return false
      val arr = snap.optJSONArray("items") ?: return false
      val list = ArrayList<Conv>()
      for (i in 0 until arr.length()) {
        val o = arr.optJSONObject(i) ?: continue
        val id = o.optString("id"); val title = o.optString("title")
        if (id.isEmpty() || title.isEmpty()) continue
        val email = o.optString("email")
        list.add(Conv(id, title, o.optBoolean("is_group"), email, o.optString("avatar"), fold("$title $email")))
      }
      if (list.isEmpty()) return false
      convs = list
      val uris = streamUris()
      val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim().orEmpty()
      if (uris.isEmpty() && text.isEmpty()) return false
      if (uris.size > MAX_ITEMS) return false
      val type = (intent.type ?: "").lowercase()
      if (type.contains("vcard") || type.contains("x-vcard")) return false
      for (u in uris) {
        val name = displayName(u).lowercase()
        val mime = (contentResolver.getType(u) ?: "").lowercase()
        if (mime.contains("vcard") || name.endsWith(".vcf")) return false
        if (name.endsWith(".wastickers")) return false
        if ((name.endsWith(".zip") || name.endsWith(".txt")) && (name.contains("whatsapp") || name.contains("_chat"))) return false
      }
      return true
    } catch (t: Throwable) {
      Log.w(TAG, "gate failed: ${t.message}")
      return false
    }
  }

  private fun streamUris(): List<Uri> {
    val out = LinkedHashSet<Uri>()
    try {
      if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
        val l: ArrayList<Uri>? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
          else @Suppress("DEPRECATION") intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
        l?.let { out.addAll(it) }
      } else {
        val u: Uri? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
          else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
        u?.let { out.add(it) }
      }
    } catch (_: Throwable) {}
    if (out.isEmpty()) {
      val cd = intent.clipData
      if (cd != null) for (i in 0 until cd.itemCount) cd.getItemAt(i)?.uri?.let { out.add(it) }
    }
    return out.toList()
  }

  private fun displayName(u: Uri): String {
    try {
      contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) { val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME); if (i >= 0) return c.getString(i) ?: "" }
      }
    } catch (_: Throwable) {}
    return u.lastPathSegment ?: ""
  }

  private fun sizeOf(u: Uri): Long {
    try {
      contentResolver.query(u, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) { val i = c.getColumnIndex(OpenableColumns.SIZE); if (i >= 0 && !c.isNull(i)) return c.getLong(i) }
      }
    } catch (_: Throwable) {}
    return -1
  }

  /** Mesmo intent → MainActivity (expo-share-intent + /share-receive, fluxo de antes). */
  private fun forwardToApp(why: String) {
    if (finishedFlow) return
    finishedFlow = true
    Log.i(TAG, "fallback → app ($why)")
    try {
      val fwd = Intent(intent)
      val launch = packageManager.getLaunchIntentForPackage(packageName)?.component
      fwd.component = launch ?: ComponentName(packageName, "$packageName.MainActivity")
      fwd.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION
      val uris = streamUris()
      if (fwd.clipData == null && uris.isNotEmpty()) {
        val cd = ClipData.newRawUri("share", uris[0])
        for (i in 1 until uris.size) cd.addItem(ClipData.Item(uris[i]))
        fwd.clipData = cd
      }
      startActivity(fwd)
    } catch (t: Throwable) {
      Log.w(TAG, "forward failed: ${t.message}")
    }
    batchDir?.let { d -> exec.execute { try { d.deleteRecursively() } catch (_: Throwable) {} } }
    finish()
  }

  private fun cancelFlow() {
    if (finishedFlow) return
    finishedFlow = true
    batchDir?.let { d -> try { exec.execute { try { d.deleteRecursively() } catch (_: Throwable) {} } } catch (_: Throwable) {} }
    finish()
  }

  // ─── leitura do conteúdo (thread própria) ────────────────────────────────

  private fun shareRoot(): File = File(filesDir, "chatyy_share").apply { mkdirs() }

  private fun sweepOld() {
    exec.execute {
      try {
        val now = System.currentTimeMillis()
        shareRoot().listFiles()?.forEach { if (now - it.lastModified() > 7L * 24 * 3600 * 1000) it.deleteRecursively() }
      } catch (_: Throwable) {}
    }
  }

  private fun startLoading() {
    val dir = File(shareRoot(), UUID.randomUUID().toString()).apply { mkdirs() }
    batchDir = dir
    val uris = streamUris()
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim().orEmpty()
    val fallbackType = intent.type ?: ""
    exec.execute {
      val out = ArrayList<Item>()
      var err: String? = null
      for ((i, u) in uris.withIndex()) {
        try {
          val it = loadUri(u, i, dir, fallbackType)
          if (it != null) out.add(it)
        } catch (t: Throwable) {
          err = if (t.message == "too_big") "too_big" else (err ?: "read")
          Log.w(TAG, "load failed: ${t.message}")
        }
      }
      if (text.isNotEmpty()) {
        val it = Item(if (Regex("^https?://\\S+$").matches(text)) "link" else "text")
        it.text = text
        out.add(it)
      }
      main.post {
        if (isFinishing) return@post
        items = out
        loadError = if (out.isEmpty()) (err ?: "read") else null
        loaded = true
        if (out.isEmpty()) {
          hideOverlay()
          errorDialog(if (loadError == "too_big") t("Arquivo maior que 200 MB.", "File is larger than 200 MB.", "Archivo mayor de 200 MB.")
            else t("Não foi possível ler o conteúdo.", "Couldn't read the content.", "No se pudo leer el contenido."), offerApp = loadError != "too_big")
          return@post
        }
        if (pendingCompose) { pendingCompose = false; hideOverlay(); showCompose() }
      }
    }
  }

  private fun extOf(name: String, mime: String): String {
    val e = name.substringAfterLast('.', "").lowercase()
    if (e.isNotEmpty() && e.length <= 6) return e
    return MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "bin"
  }

  private fun loadUri(u: Uri, i: Int, dir: File, fallbackType: String): Item? {
    var mime = (contentResolver.getType(u) ?: "").lowercase()
    if (mime.isEmpty() || mime == "*/*") mime = fallbackType.lowercase().takeIf { !it.contains('*') } ?: ""
    var name = displayName(u)
    if (mime.isEmpty()) mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
    val size = sizeOf(u)
    if (size > MAX_BYTES) throw IllegalStateException("too_big")
    val ext = extOf(name, mime)
    if (name.isEmpty()) name = "file_$i.$ext"
    if (mime.startsWith("image/") && mime != "image/gif" && mime != "image/svg+xml") {
      val img = transcodeImage(u, File(dir, "item$i.jpg"))
      if (img != null) {
        img.name = name.substringBeforeLast('.', name) + ".jpg"
        return img
      }
    }
    val dst = File(dir, "item$i.$ext")
    var copied = 0L
    contentResolver.openInputStream(u)?.use { input ->
      FileOutputStream(dst).use { o ->
        val buf = ByteArray(1 shl 16)
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          copied += n
          if (copied > MAX_BYTES) throw IllegalStateException("too_big")
          o.write(buf, 0, n)
        }
      }
    } ?: return null
    val kind = when {
      mime.startsWith("image/") -> "image"
      mime.startsWith("video/") -> "video"
      else -> "file"
    }
    val it = Item(kind)
    it.file = dst; it.mime = mime; it.name = name; it.size = copied
    if (kind == "video") {
      try {
        val r = MediaMetadataRetriever()
        r.setDataSource(dst.path)
        it.durationMs = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0
        it.thumb = r.getFrameAtTime(100_000)?.let { b -> scaleDown(b, 1080) }
        try { r.release() } catch (_: Throwable) {}
      } catch (_: Throwable) {}
    } else if (kind == "image") {
      it.thumb = decodeSampled(dst, 1080)
    }
    return it
  }

  /** Foto → JPEG ≤ 2560 px, girada pela EXIF (o servidor recebe algo que qualquer aparelho abre). */
  private fun transcodeImage(u: Uri, dst: File): Item? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    contentResolver.openInputStream(u)?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return null
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= IMAGE_MAX_PX) sample *= 2
    val bmp = contentResolver.openInputStream(u)?.use {
      BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
    } ?: return null
    var rot = 0
    try {
      contentResolver.openInputStream(u)?.use { s ->
        rot = when (ExifInterface(s).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
          ExifInterface.ORIENTATION_ROTATE_90 -> 90
          ExifInterface.ORIENTATION_ROTATE_180 -> 180
          ExifInterface.ORIENTATION_ROTATE_270 -> 270
          else -> 0
        }
      }
    } catch (_: Throwable) {}
    val longest = maxOf(bmp.width, bmp.height)
    val scale = if (longest > IMAGE_MAX_PX) IMAGE_MAX_PX.toFloat() / longest else 1f
    val m = Matrix()
    if (scale < 1f) m.postScale(scale, scale)
    if (rot != 0) m.postRotate(rot.toFloat())
    val out = if (scale < 1f || rot != 0) Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true) else bmp
    FileOutputStream(dst).use { out.compress(Bitmap.CompressFormat.JPEG, 82, it) }
    val it = Item("image")
    it.file = dst; it.mime = "image/jpeg"; it.size = dst.length()
    it.thumb = scaleDown(out, 1080)
    if (out !== bmp) bmp.recycle()
    return it
  }

  private fun scaleDown(b: Bitmap, max: Int): Bitmap {
    val longest = maxOf(b.width, b.height)
    if (longest <= max) return b
    val s = max.toFloat() / longest
    return Bitmap.createScaledBitmap(b, (b.width * s).toInt().coerceAtLeast(1), (b.height * s).toInt().coerceAtLeast(1), true)
  }

  private fun decodeSampled(f: File, max: Int): Bitmap? {
    return try {
      val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(f.path, o)
      var s = 1
      while (maxOf(o.outWidth, o.outHeight) / (s * 2) >= max) s *= 2
      BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = s })
    } catch (_: Throwable) { null }
  }

  // ─── UI: peças ──────────────────────────────────────────────────────────

  private fun fold(s: String): String =
    Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").lowercase()

  private fun label(text: String, size: Float, bold: Boolean = false, color: Int = cInk): TextView {
    val v = TextView(this)
    v.text = text
    v.setTextColor(color)
    v.setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
    if (bold) v.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    v.maxLines = 1
    v.ellipsize = TextUtils.TruncateAt.END
    return v
  }

  private fun rounded(color: Int, radiusDp: Float): GradientDrawable {
    val g = GradientDrawable()
    g.setColor(color)
    g.cornerRadius = dp(radiusDp).toFloat()
    return g
  }

  private fun topBar(leftText: String, title: String, onLeft: () -> Unit): View {
    val bar = FrameLayout(this)
    bar.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56))
    val left = label(leftText, 16f)
    left.setPadding(dp(16), 0, dp(16), 0)
    left.gravity = Gravity.CENTER_VERTICAL
    left.setOnClickListener { onLeft() }
    bar.addView(left, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.START))
    val tv = label(title, 17f, bold = true)
    tv.gravity = Gravity.CENTER
    val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    lp.leftMargin = dp(96); lp.rightMargin = dp(96)
    bar.addView(tv, lp)
    val line = View(this); line.setBackgroundColor(cHairline)
    bar.addView(line, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1, Gravity.BOTTOM))
    return bar
  }

  /** Círculo com foto (BitmapShader) ou iniciais. */
  private inner class AvatarView(ctx: Context) : View(ctx) {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = cFill }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = cInk; textAlign = Paint.Align.CENTER; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD) }
    private val img = Paint(Paint.ANTI_ALIAS_FLAG)
    private var bmp: Bitmap? = null
    private var initials = ""
    private var path = ""
    fun bind(c: Conv) {
      val words = c.title.split(' ', '.', '_').filter { it.isNotBlank() }.take(2)
      initials = if (c.isGroup) "#" else words.joinToString("") { it.substring(0, 1).uppercase() }
      if (path != c.avatar) {
        path = c.avatar
        bmp = null
        val p = c.avatar
        if (p.isNotEmpty()) {
          try { avatarExec.execute {
            val f = File(p)
            val b = if (f.exists()) decodeSampled(f, 160) else null
            if (b != null) main.post { if (path == p) { bmp = b; invalidate() } }
          } } catch (_: Throwable) {}
        }
      }
      invalidate()
    }
    override fun onDraw(canvas: Canvas) {
      val r = minOf(width, height) / 2f
      val b = bmp
      if (b != null) {
        val sh = BitmapShader(b, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
        val m = Matrix()
        val s = (2 * r) / minOf(b.width, b.height)
        m.setScale(s, s)
        m.postTranslate((width - b.width * s) / 2f, (height - b.height * s) / 2f)
        sh.setLocalMatrix(m)
        img.shader = sh
        canvas.drawCircle(width / 2f, height / 2f, r, img)
      } else {
        canvas.drawCircle(width / 2f, height / 2f, r, fill)
        text.textSize = r * 0.8f
        canvas.drawText(initials, width / 2f, height / 2f - (text.descent() + text.ascent()) / 2f, text)
      }
    }
  }

  /** Marcador de seleção: anel vazio ou círculo cheio com check. */
  private inner class CheckView(ctx: Context) : View(ctx) {
    var on = false
      set(v) { field = v; invalidate() }
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG)
    private val mark = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    override fun onDraw(canvas: Canvas) {
      val r = minOf(width, height) / 2f - dp(1.5f)
      val cx = width / 2f; val cy = height / 2f
      if (on) {
        dot.color = cInk
        canvas.drawCircle(cx, cy, r, dot)
        mark.color = cBg
        mark.strokeWidth = dp(2.2f).toFloat()
        val p = Path()
        p.moveTo(cx - r * 0.45f, cy + r * 0.02f)
        p.lineTo(cx - r * 0.1f, cy + r * 0.36f)
        p.lineTo(cx + r * 0.48f, cy - r * 0.3f)
        canvas.drawPath(p, mark)
      } else {
        ring.color = cSecondary
        ring.strokeWidth = dp(1.5f).toFloat()
        canvas.drawCircle(cx, cy, r, ring)
      }
    }
  }

  /** Botão redondo preto/branco com seta (direita = avançar, cima = enviar). */
  private inner class ArrowButton(ctx: Context, private val up: Boolean) : View(ctx) {
    private val bg = Paint(Paint.ANTI_ALIAS_FLAG)
    private val arrow = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    override fun onDraw(canvas: Canvas) {
      val r = minOf(width, height) / 2f
      val cx = width / 2f; val cy = height / 2f
      bg.color = if (isEnabled) cInk else cSecondary
      canvas.drawCircle(cx, cy, r, bg)
      arrow.color = cBg
      arrow.strokeWidth = dp(2.4f).toFloat()
      val a = r * 0.42f
      val p = Path()
      if (up) {
        p.moveTo(cx, cy + a); p.lineTo(cx, cy - a)
        p.moveTo(cx - a * 0.75f, cy - a * 0.25f); p.lineTo(cx, cy - a); p.lineTo(cx + a * 0.75f, cy - a * 0.25f)
      } else {
        p.moveTo(cx - a, cy); p.lineTo(cx + a, cy)
        p.moveTo(cx + a * 0.25f, cy - a * 0.75f); p.lineTo(cx + a, cy); p.lineTo(cx + a * 0.25f, cy + a * 0.75f)
      }
      canvas.drawPath(p, arrow)
    }
    override fun setEnabled(enabled: Boolean) { super.setEnabled(enabled); invalidate() }
  }

  // ─── tela 1: conversas ──────────────────────────────────────────────────

  private inner class ConvAdapter : BaseAdapter() {
    var rows: List<Conv> = convs
    override fun getCount(): Int = rows.size
    override fun getItem(position: Int): Any = rows[position]
    override fun getItemId(position: Int): Long = position.toLong()
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
      val row = (convertView as? LinearLayout) ?: buildRow()
      val c = rows[position]
      val av = row.getChildAt(0) as AvatarView
      val texts = row.getChildAt(1) as LinearLayout
      val check = row.getChildAt(2) as CheckView
      av.bind(c)
      (texts.getChildAt(0) as TextView).text = c.title
      (texts.getChildAt(1) as TextView).text = if (c.isGroup) t("Grupo", "Group", "Grupo") else c.email
      check.on = selected.contains(c.id)
      row.contentDescription = c.title
      return row
    }
    private fun buildRow(): LinearLayout {
      val row = LinearLayout(this@ChatyyShareActivity)
      row.orientation = LinearLayout.HORIZONTAL
      row.gravity = Gravity.CENTER_VERTICAL
      row.setPadding(dp(16), 0, dp(18), 0)
      row.minimumHeight = dp(64)
      row.addView(AvatarView(this@ChatyyShareActivity), LinearLayout.LayoutParams(dp(44), dp(44)))
      val texts = LinearLayout(this@ChatyyShareActivity)
      texts.orientation = LinearLayout.VERTICAL
      texts.setPadding(dp(12), 0, dp(12), 0)
      texts.addView(label("", 16f, bold = true))
      texts.addView(label("", 13f, color = cSecondary))
      row.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      row.addView(CheckView(this@ChatyyShareActivity), LinearLayout.LayoutParams(dp(24), dp(24)))
      row.layoutParams = android.widget.AbsListView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(64))
      return row
    }
  }

  private fun showPicker() {
    screen = "picker"
    root.removeAllViews()
    overlay = null
    val col = LinearLayout(this)
    col.orientation = LinearLayout.VERTICAL
    col.setBackgroundColor(cBg)
    col.addView(topBar(t("Cancelar", "Cancel", "Cancelar"), t("Enviar para", "Send to", "Enviar a")) { cancelFlow() })

    val search = EditText(this)
    search.hint = t("Buscar", "Search", "Buscar")
    search.setHintTextColor(cSecondary)
    search.setTextColor(cInk)
    search.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    search.background = rounded(cFill, 12f)
    search.setPadding(dp(14), dp(10), dp(14), dp(10))
    search.isSingleLine = true
    search.imeOptions = EditorInfo.IME_ACTION_SEARCH
    search.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    val slp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    slp.setMargins(dp(16), dp(10), dp(16), dp(6))
    col.addView(search, slp)

    val header = label(t("CONVERSAS RECENTES", "RECENT CHATS", "CHATS RECIENTES"), 12f, bold = true, color = cSecondary)
    header.setPadding(dp(16), dp(10), dp(16), dp(6))
    col.addView(header)

    val list = ListView(this)
    list.divider = null
    list.setBackgroundColor(cBg)
    list.cacheColorHint = cBg
    list.selector = rounded(Color.TRANSPARENT, 0f)
    val ad = adapter ?: ConvAdapter()
    adapter = ad
    ad.rows = convs
    val more = label(t("Mais opções no Chatyy", "More options in Chatyy", "Más opciones en Chatyy"), 15f, color = cSecondary)
    more.gravity = Gravity.CENTER
    more.setPadding(0, dp(18), 0, dp(18))
    more.setOnClickListener { forwardToApp("user") }
    list.addFooterView(more, null, true)
    list.adapter = ad
    val empty = label(t("Nenhuma conversa encontrada", "No chats found", "No se encontraron chats"), 15f, color = cSecondary)
    empty.gravity = Gravity.CENTER
    empty.visibility = View.GONE
    list.setOnItemClickListener { _, _, pos, _ ->
      if (pos >= ad.rows.size) return@setOnItemClickListener
      val c = ad.rows[pos]
      if (selected.contains(c.id)) selected.remove(c.id)
      else {
        if (selected.size >= MAX_RECIPIENTS) {
          Toast.makeText(this, t("Até 5 conversas por vez", "Up to 5 chats at a time", "Hasta 5 chats a la vez"), Toast.LENGTH_SHORT).show()
          return@setOnItemClickListener
        }
        selected.add(c.id)
      }
      ad.notifyDataSetChanged()
      refreshFooter()
    }
    val listFrame = FrameLayout(this)
    listFrame.addView(list, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    listFrame.addView(empty, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(80), Gravity.TOP))
    col.addView(listFrame, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

    search.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        val q = fold(s?.toString()?.trim().orEmpty())
        ad.rows = if (q.isEmpty()) convs else convs.filter { it.key.contains(q) }
        empty.visibility = if (ad.rows.isEmpty()) View.VISIBLE else View.GONE
        ad.notifyDataSetChanged()
      }
    })

    val bar = LinearLayout(this)
    bar.orientation = LinearLayout.HORIZONTAL
    bar.gravity = Gravity.CENTER_VERTICAL
    bar.setPadding(dp(16), dp(10), dp(16), dp(10))
    bar.setBackgroundColor(cBg)
    val names = label("", 15f, bold = true)
    bar.addView(names, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    val next = ArrowButton(this, up = false)
    next.contentDescription = t("Avançar", "Next", "Siguiente")
    next.setOnClickListener { if (selected.isNotEmpty()) showCompose() }
    bar.addView(next, LinearLayout.LayoutParams(dp(48), dp(48)))
    val line = View(this); line.setBackgroundColor(cHairline)
    col.addView(line, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1))
    col.addView(bar)
    footerBar = bar
    footerNames = names
    root.addView(col, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    applyInsets(root)
    refreshFooter()
  }

  private fun refreshFooter() {
    val names = selected.mapNotNull { id -> convs.firstOrNull { it.id == id }?.title }
    footerNames?.text = names.joinToString(", ")
    footerBar?.visibility = if (selected.isEmpty()) View.GONE else View.VISIBLE
  }

  // ─── tela 2: prévia + legenda ───────────────────────────────────────────

  private fun showCompose() {
    if (!loaded) {
      pendingCompose = true
      showOverlay(t("Preparando…", "Preparing…", "Preparando…"))
      return
    }
    val recips = selected.mapNotNull { id -> convs.firstOrNull { it.id == id } }
    if (recips.isEmpty()) { showPicker(); return }
    screen = "compose"
    root.removeAllViews()
    overlay = null
    val media = items.filter { it.isMedia }
    val texts = items.filter { !it.isMedia }.map { it.text }.filter { it.isNotEmpty() }
    val col = LinearLayout(this)
    col.orientation = LinearLayout.VERTICAL
    col.setBackgroundColor(cBg)
    val leftText = if (preselected) t("Cancelar", "Cancel", "Cancelar") else t("Voltar", "Back", "Atrás")
    col.addView(topBar(leftText, t("Para", "To", "Para") + ": " + recips.joinToString(", ") { it.title }) { handleBack() })

    val caption = EditText(this)
    caption.setTextColor(cInk)
    caption.setHintTextColor(cSecondary)
    caption.setTextSize(TypedValue.COMPLEX_UNIT_SP, if (media.isEmpty()) 17f else 16f)
    caption.setText(texts.joinToString("\n"))
    caption.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    caption.background = rounded(cFill, 20f)
    caption.setPadding(dp(14), dp(10), dp(14), dp(10))

    if (media.isNotEmpty()) {
      caption.hint = t("Adicionar legenda…", "Add a caption…", "Añadir un comentario…")
      caption.maxLines = 5
      col.addView(buildStage(media), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    } else {
      caption.hint = t("Mensagem", "Message", "Mensaje")
      caption.gravity = Gravity.TOP or Gravity.START
    }
    val bottom = LinearLayout(this)
    bottom.orientation = LinearLayout.HORIZONTAL
    bottom.gravity = Gravity.BOTTOM
    bottom.setPadding(dp(12), dp(8), dp(12), dp(8))
    val clp = if (media.isEmpty()) LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)
      else LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    bottom.addView(caption, clp)
    val send = ArrowButton(this, up = true)
    send.contentDescription = t("Enviar", "Send", "Enviar")
    val sl = LinearLayout.LayoutParams(dp(44), dp(44))
    sl.leftMargin = dp(8)
    bottom.addView(send, sl)
    send.setOnClickListener {
      val text = caption.text?.toString()?.trim().orEmpty()
      if (media.isEmpty() && text.isEmpty()) return@setOnClickListener
      send.isEnabled = false
      send(text, recips, media)
    }
    col.addView(bottom, if (media.isEmpty()) LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
      else LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    root.addView(col, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    applyInsets(root)
    if (media.isEmpty()) caption.requestFocus()
  }

  private fun buildStage(media: List<Item>): View {
    val frame = FrameLayout(this)
    frame.setBackgroundColor(if (dark) Color.rgb(15, 15, 15) else Color.rgb(247, 247, 247))
    val scroller = object : HorizontalScrollView(this) {
      override fun onTouchEvent(ev: MotionEvent): Boolean {
        val r = super.onTouchEvent(ev)
        if (ev.action == MotionEvent.ACTION_UP || ev.action == MotionEvent.ACTION_CANCEL) {
          val w = width.coerceAtLeast(1)
          val page = ((scrollX + w / 2) / w).coerceIn(0, media.size - 1)
          post { smoothScrollTo(page * w, 0) }
        }
        return r
      }
    }
    scroller.isHorizontalScrollBarEnabled = false
    scroller.overScrollMode = View.OVER_SCROLL_NEVER
    val strip = LinearLayout(this)
    strip.orientation = LinearLayout.HORIZONTAL
    scroller.addView(strip, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT))
    val pages = ArrayList<View>()
    for (m in media) {
      val page = FrameLayout(this)
      val thumb = m.thumb
      if (thumb != null) {
        val iv = ImageView(this)
        iv.scaleType = ImageView.ScaleType.FIT_CENTER
        iv.setImageBitmap(thumb)
        page.addView(iv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        if (m.kind == "video") {
          val s = (m.durationMs / 1000).toInt()
          val badge = label(String.format(Locale.US, "%s  %d:%02d", t("Vídeo", "Video", "Video"), s / 60, s % 60), 13f, bold = true, color = Color.WHITE)
          badge.background = rounded(Color.argb(150, 0, 0, 0), 14f)
          badge.setPadding(dp(12), dp(6), dp(12), dp(6))
          val blp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START)
          blp.setMargins(dp(12), 0, 0, dp(16))
          page.addView(badge, blp)
        }
      } else {
        val box = LinearLayout(this)
        box.orientation = LinearLayout.VERTICAL
        box.gravity = Gravity.CENTER
        val ext = m.name.substringAfterLast('.', "").uppercase().take(5).ifEmpty { "FILE" }
        val tile = label(ext, 15f, bold = true, color = cBg)
        tile.gravity = Gravity.CENTER
        tile.background = rounded(cInk, 10f)
        box.addView(tile, LinearLayout.LayoutParams(dp(72), dp(88)))
        val name = label(m.name, 16f, bold = true)
        name.maxLines = 2
        name.gravity = Gravity.CENTER
        name.setPadding(dp(32), dp(16), dp(32), 0)
        box.addView(name)
        box.addView(label(android.text.format.Formatter.formatShortFileSize(this, m.size), 13f, color = cSecondary))
        page.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      }
      strip.addView(page, LinearLayout.LayoutParams(dp(360), ViewGroup.LayoutParams.MATCH_PARENT))
      pages.add(page)
    }
    frame.addView(scroller, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    // páginas = largura real da área (só conhecida depois do layout)
    frame.addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ ->
      val w = v.width
      if (w <= 0) return@addOnLayoutChangeListener
      for (p in pages) {
        val lp = p.layoutParams
        if (lp.width != w) { lp.width = w; p.layoutParams = lp }
      }
    }
    if (media.size > 1) {
      val hint = label(t("${media.size} itens — deslize", "${media.size} items — swipe", "${media.size} elementos — desliza"), 13f, bold = true, color = cBg)
      hint.background = rounded(cInk, 14f)
      hint.setPadding(dp(12), dp(6), dp(12), dp(6))
      val hlp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END)
      hlp.setMargins(0, dp(12), dp(12), 0)
      frame.addView(hint, hlp)
    }
    return frame
  }

  // ─── envio → fila nativa ────────────────────────────────────────────────

  private fun send(caption: String, recips: List<Conv>, media: List<Item>) {
    val c = creds ?: run { forwardToApp("no_creds"); return }
    val jobs = ArrayList<JSONObject>()
    for (conv in recips) {
      val convValue: Any = conv.id.toLongOrNull() ?: conv.id
      if (media.isEmpty()) {
        if (caption.isEmpty()) continue
        val cmi = "share-" + UUID.randomUUID().toString()
        jobs.add(JSONObject().put("cmi", cmi).put("conv", conv.id).put("kind", "text")
          .put("body", JSONObject().put("conversation_id", convValue).put("content", caption).put("type", "text").put("client_message_id", cmi)))
        continue
      }
      for ((i, m) in media.withIndex()) {
        val f = m.file ?: continue
        val cmi = "share-" + UUID.randomUUID().toString()
        jobs.add(JSONObject().put("cmi", cmi).put("conv", conv.id).put("kind", "media")
          .put("body", JSONObject().put("conversation_id", convValue).put("content", if (i == 0) caption else "")
            .put("type", m.kind).put("client_message_id", cmi).put("view_once", 0))
          .put("file", f.absolutePath)
          .put("up", JSONObject().put("filename", m.name).put("mime", m.mime).put("context", "chat").put("user_email", account)))
      }
    }
    if (jobs.isEmpty()) return
    if (jobs.size > MAX_SENDS) {
      Toast.makeText(this, t("Muitos envios de uma vez. Escolha menos conversas.", "Too many sends at once. Pick fewer chats.", "Demasiados envíos a la vez. Elige menos chats."), Toast.LENGTH_LONG).show()
      showCompose()
      return
    }
    showOverlay(t("Enviando…", "Sending…", "Enviando…"))
    val app = applicationContext
    exec.execute {
      var ok = 0
      // [e2ee5 WP-08b] conversa E2EE: mídia cifrada é F3 (WP-11) → abre o app (nunca sobe em claro);
      // texto é cifrado pela fila nativa (E2eeOutboxSealer). Gate desligado = como antes.
      if (media.isNotEmpty() && expo.modules.chatyychatstore.E2eeNative.gateOn(app, account)) {
        val e2ee = try {
          recips.any { r -> expo.modules.chatyychatstore.E2eeNative.convState(app, account, r.id, c.token, c.base)?.mode == 1 }
        } catch (_: Throwable) { false }
        if (e2ee) { main.post { forwardToApp("e2ee_media") }; return@execute }
      }
      try {
        ChatTransport.init(app)
        val core = NativeOutbox.get(app)
        core.configure(account, c.token, c.base.ifEmpty { ORIGIN })
        for (j in jobs) {
          val st = core.submit(account, j)
          if (st.isNotEmpty()) ok++
          if (st == "failed") core.retry(account, j.optString("cmi"))
        }
        NativeOutbox.scheduleWork(app)
        core.kick("share")
      } catch (t: Throwable) {
        Log.w(TAG, "submit failed: ${t.message}")
      }
      val done = ok
      main.post {
        if (done == 0) {
          hideOverlay()
          errorDialog(t("Não foi possível enviar", "Couldn't send", "No se pudo enviar"), offerApp = true)
          return@post
        }
        finishedFlow = true
        if (done < jobs.size) {
          // [e2ee5 WP-08b] alguma conversa protegida não aceitou (não deu p/ cifrar agora)
          Toast.makeText(app, t("Algumas mensagens não foram enviadas. Abra o Chatyy para tentar de novo.", "Some messages weren't sent. Open Chatyy to try again.", "Algunos mensajes no se enviaron. Abre Chatyy para intentarlo de nuevo."), Toast.LENGTH_LONG).show()
        } else {
          Toast.makeText(app, t("Enviando…", "Sending…", "Enviando…"), Toast.LENGTH_SHORT).show()
        }
        finish()
      }
    }
  }

  // ─── overlay / erro ─────────────────────────────────────────────────────

  private fun showOverlay(text: String) {
    hideOverlay()
    val o = FrameLayout(this)
    o.setBackgroundColor(Color.argb(72, 0, 0, 0))
    o.isClickable = true
    val card = LinearLayout(this)
    card.orientation = LinearLayout.VERTICAL
    card.gravity = Gravity.CENTER
    card.background = rounded(cBg, 18f)
    card.setPadding(dp(28), dp(22), dp(28), dp(22))
    val pb = ProgressBar(this)
    pb.isIndeterminate = true
    try { pb.indeterminateTintList = android.content.res.ColorStateList.valueOf(cInk) } catch (_: Throwable) {}
    card.addView(pb, LinearLayout.LayoutParams(dp(36), dp(36)))
    val l = label(text, 15f, bold = true)
    l.setPadding(0, dp(12), 0, 0)
    card.addView(l)
    o.addView(card, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
    root.addView(o, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    overlay = o
  }

  private fun hideOverlay() {
    overlay?.let { root.removeView(it) }
    overlay = null
  }

  private fun errorDialog(msg: String, offerApp: Boolean) {
    if (isFinishing) return
    val b = android.app.AlertDialog.Builder(this).setMessage(msg).setCancelable(false)
    if (offerApp) b.setPositiveButton(t("Abrir no Chatyy", "Open in Chatyy", "Abrir en Chatyy")) { _, _ -> forwardToApp("error") }
    b.setNegativeButton("OK") { _, _ -> cancelFlow() }
    try { b.show() } catch (_: Throwable) { cancelFlow() }
  }
}
