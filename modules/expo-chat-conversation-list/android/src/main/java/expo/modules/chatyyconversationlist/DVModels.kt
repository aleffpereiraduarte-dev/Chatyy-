package expo.modules.chatyyconversationlist

// [2026-10-15 native-drive] Modelos da lista de ARQUIVOS nativa
// (ChatyyDriveList): app/drive.js e app/files.js. Mesmo contrato do iOS
// (ios/DVModels.swift). Linhas PLANAS vindas de components/native/driveListAdapter.js:
//   seção → { id, k: 's', t }
//   item  → { id, k: 'r', t, sb, gl, bd, th, vd, st, sh, wn, wu, cv, sw, sl, mn, sel, a11y }
// Ações (sw/sl/mn = "a,b,c"): open | download | share | rename | move | star |
// delete | restore | purge | more. Títulos vêm da prop `labels`.

import android.graphics.Color
import android.widget.ImageView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.load.model.GlideUrl
import java.io.File

internal class DVRow(
  val id: String,
  val kind: String,
  val title: String,
  val sub: String,
  val glyph: String,
  val badge: String,
  val thumb: String,
  val video: Boolean,
  val starred: Boolean,
  val shared: Boolean,
  val warn: String,
  val warnUrgent: Boolean,
  val chevron: Boolean,
  val swipe: List<String>,
  val swipeLeft: List<String>,
  val menu: List<String>,
  val selectable: Boolean,
  val a11y: String
) {
  val isFolder: Boolean get() = glyph == "folder"

  companion object {
    val EMPTY = DVRow("", "r", "", "", "file", "", "", false, false, false, "", false, false, emptyList(), emptyList(), emptyList(), true, "")

    private fun csv(v: Any?): List<String> {
      val s = CLVal.str(v)
      if (s.isEmpty()) return emptyList()
      return s.split(',').map { it.trim() }.filter { it.isNotEmpty() }
    }

    fun from(m: Map<String, Any?>): DVRow {
      val k = CLVal.str(m["k"]).ifEmpty { "r" }
      return DVRow(
        id = CLVal.str(m["id"]),
        kind = k,
        title = CLVal.str(m["t"]),
        sub = CLVal.str(m["sb"]),
        glyph = CLVal.str(m["gl"]).ifEmpty { "file" },
        badge = CLVal.str(m["bd"]),
        thumb = CLVal.str(m["th"]),
        video = CLVal.bool(m["vd"]),
        starred = CLVal.bool(m["st"]),
        shared = CLVal.bool(m["sh"]),
        warn = CLVal.str(m["wn"]),
        warnUrgent = CLVal.bool(m["wu"]),
        chevron = CLVal.bool(m["cv"]),
        swipe = csv(m["sw"]),
        swipeLeft = csv(m["sl"]),
        menu = csv(m["mn"]),
        selectable = if (m.containsKey("sel")) CLVal.bool(m["sel"]) else true,
        a11y = CLVal.str(m["a11y"])
      )
    }
  }
}

internal class DVStyle(
  val colors: CTColors = CTColors(),
  val card: Int = Color.WHITE,
  val selBg: Int = Color.argb(15, 0, 0, 0),
  val tokens: List<String> = emptyList(),
  val selectionMode: Boolean = false,
  val selected: Set<String> = emptySet()
)

/** Títulos das ações (i18n da tela) com padrão pt-BR. */
internal class DVLabels(m: Map<String, Any?>? = null) {
  private val map = HashMap<String, String>()

  init {
    m?.forEach { (k, v) -> val s = CLVal.str(v); if (s.isNotEmpty()) map[k] = s }
  }

  fun get(k: String, def: String): String = map[k] ?: def

  fun action(a: String, starred: Boolean): String = when (a) {
    "open" -> get("open", "Abrir")
    "download" -> get("download", "Baixar")
    "share" -> get("share", "Compartilhar")
    "rename" -> get("rename", "Renomear")
    "move" -> get("move", "Mover para...")
    "star" -> if (starred) get("unstar", "Desfavoritar") else get("star", "Favoritar")
    "delete" -> get("delete", "Excluir")
    "restore" -> get("restore", "Restaurar")
    "purge" -> get("purge", "Excluir permanentemente")
    "more" -> get("more", "Mais")
    "sendcopy" -> get("sendcopy", "Enviar cópia") // [2026-10-16 drive-native]
    "savefiles" -> get("savefiles", "Salvar em Downloads")
    else -> get(a, a)
  }
}

internal object DVGlyphs {
  fun res(g: String): Int = when (g) {
    "folder" -> R.drawable.dv_ic_folder
    "image" -> R.drawable.crl_ic_image
    "video" -> R.drawable.ccl_ic_film
    "audio" -> R.drawable.ccl_ic_music
    "sheet" -> R.drawable.dv_ic_sheet
    "slides" -> R.drawable.dv_ic_slides
    "zip" -> R.drawable.ccl_ic_archive
    "code" -> R.drawable.dv_ic_code
    else -> R.drawable.ccl_ic_file
  }

  fun actionRes(a: String, starred: Boolean): Int = when (a) {
    "open" -> R.drawable.dv_ic_eye
    "download" -> R.drawable.dv_ic_download
    "share" -> R.drawable.cct_ic_user_plus
    "rename" -> R.drawable.dv_ic_edit
    "move" -> R.drawable.dv_ic_folder
    "star" -> if (starred) R.drawable.cct_ic_star else R.drawable.cct_ic_star_fill
    "delete", "purge" -> R.drawable.ccl_ic_trash
    "restore" -> R.drawable.dv_ic_restore
    "more" -> R.drawable.dv_ic_more
    "sendcopy" -> R.drawable.dv_ic_send_copy // [2026-10-16 drive-native]
    "savefiles" -> R.drawable.dv_ic_download
    else -> R.drawable.dv_ic_more
  }

  fun isDestructive(a: String): Boolean = a == "delete" || a == "purge"
}

/**
 * Miniaturas via Glide (já no binário) com cache em disco do próprio Glide
 * (DiskCacheStrategy.ALL guarda o original E a miniatura reduzida). A chave
 * ignora `token`/`dl` da URL: o mesmo arquivo não baixa de novo quando o
 * bearer gira.
 */
internal class DVGlideUrl(url: String, private val key: String) : GlideUrl(url) {
  override fun getCacheKey(): String = key
}

internal object DVThumbs {
  const val PX = 360

  fun cacheKey(u: String): String {
    val q = u.indexOf('?')
    if (q < 0) return u
    val base = u.substring(0, q)
    val kept = u.substring(q + 1).split('&').filter {
      !it.startsWith("token=") && !it.startsWith("dl=")
    }
    return if (kept.isEmpty()) base else base + "?" + kept.joinToString("&")
  }

  fun model(u: String): Any? {
    if (u.startsWith("http://") || u.startsWith("https://")) return DVGlideUrl(u, cacheKey(u))
    if (u.startsWith("file://") || u.startsWith("content://")) return android.net.Uri.parse(u)
    if (u.startsWith("/")) return File(u)
    if (u.startsWith("data:")) return u
    return null
  }

  fun load(iv: ImageView, url: String, onReady: (Boolean) -> Unit) {
    val app = iv.context.applicationContext
    val m = model(url)
    if (m == null) { onReady(false); return }
    try {
      Glide.with(app)
        .load(m)
        .override(PX, PX)
        .centerCrop()
        .diskCacheStrategy(DiskCacheStrategy.ALL)
        .listener(object : com.bumptech.glide.request.RequestListener<android.graphics.drawable.Drawable> {
          override fun onLoadFailed(
            e: com.bumptech.glide.load.engine.GlideException?,
            model: Any?,
            target: com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable>,
            isFirstResource: Boolean
          ): Boolean { onReady(false); return false }

          override fun onResourceReady(
            resource: android.graphics.drawable.Drawable,
            model: Any,
            target: com.bumptech.glide.request.target.Target<android.graphics.drawable.Drawable>?,
            dataSource: com.bumptech.glide.load.DataSource,
            isFirstResource: Boolean
          ): Boolean { onReady(true); return false }
        })
        .into(iv)
    } catch (_: Throwable) { onReady(false) }
  }

  fun clear(iv: ImageView) {
    try { Glide.with(iv.context.applicationContext).clear(iv) } catch (_: Throwable) {}
    iv.setImageDrawable(null)
  }
}
