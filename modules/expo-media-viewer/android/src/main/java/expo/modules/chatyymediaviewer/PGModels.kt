package expo.modules.chatyymediaviewer

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.provider.MediaStore
import android.text.format.DateFormat
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// [2026-10-15 native-photos] Modelo da grade de Fotos nativa (ChatyyPhotosGrid).
// Contrato: scratchpad photos/SPEC.md (parte A).

/** Um item da grade (local do aparelho ou só-nuvem). Imutável. */
class PGItem(
  @JvmField val key: String,
  @JvmField val local: Boolean,
  @JvmField val localId: String,
  @JvmField val cloudId: String,
  @JvmField val time: Long,
  @JvmField val width: Int,
  @JvmField val height: Int,
  @JvmField val video: Boolean,
  @JvmField val durationSec: Double,
  @JvmField val uri: String,
  @JvmField val thumb: String,
  @JvmField val name: String,
  @JvmField val tag: String,
  @JvmField val unavailable: Boolean,
) {
  /** Local cuja tag casou com um item da nuvem (preenchido no merge). */
  @JvmField var cloudMatched: Boolean = false
  /** Duração formatada (cache — evita alocar no bind). */
  @JvmField var durationLabel: String? = null
}

object PGStatus {
  const val NONE = 0
  const val CLOUD = 1
  const val UPLOADING = 2
  const val FAILED = 3
  const val PENDING = 4
  const val LOCAL = 5
  const val CLOUD_ONLY = 6

  /** Prioridade (maior vence) p/ quando um id aparece em mais de uma lista. */
  fun rank(s: Int): Int = when (s) {
    CLOUD -> 5; UPLOADING -> 4; FAILED -> 3; PENDING -> 2; LOCAL -> 1; else -> 0
  }

  fun name(s: Int): String = when (s) {
    CLOUD -> "cloud"; UPLOADING -> "uploading"; FAILED -> "failed"; PENDING -> "pending"
    LOCAL -> "local"; CLOUD_ONLY -> "cloudOnly"; else -> "none"
  }
}

class PGZoomLevel(@JvmField val cols: Int, @JvmField val group: Int) {
  companion object {
    const val G_DAY = 0
    const val G_MONTH = 1
    const val G_YEAR = 2
    val DEFAULTS = listOf(
      PGZoomLevel(12, G_YEAR), PGZoomLevel(7, G_MONTH), PGZoomLevel(5, G_DAY), PGZoomLevel(3, G_DAY)
    )

    fun parse(raw: List<*>?): List<PGZoomLevel> {
      if (raw.isNullOrEmpty()) return DEFAULTS
      val out = ArrayList<PGZoomLevel>()
      for (r in raw) {
        val m = r as? Map<*, *> ?: continue
        val c = (m["c"] as? Number)?.toInt() ?: (m["cols"] as? Number)?.toInt() ?: continue
        val g = when ((m["g"] ?: m["group"]) as? String) {
          "year" -> G_YEAR; "month" -> G_MONTH; else -> G_DAY
        }
        out.add(PGZoomLevel(c.coerceIn(1, 20), g))
      }
      return if (out.isEmpty()) DEFAULTS else out
    }
  }
}

class PGTheme {
  var background = Color.WHITE
  var text = Color.BLACK
  var textSecondary = Color.GRAY
  var accent = Color.parseColor("#2F80ED")
  var header = Color.argb(235, 255, 255, 255)
  var check = Color.WHITE
  var dark = false

  fun apply(m: Map<String, Any?>?, darkHint: Boolean?) {
    if (darkHint != null) dark = darkHint
    if (dark) {
      background = Color.BLACK; text = Color.WHITE; textSecondary = Color.LTGRAY
      header = Color.argb(235, 0, 0, 0)
    }
    if (m == null) return
    fun c(k: String): Int? = (m[k] as? String)?.let { s ->
      try { Color.parseColor(s.trim()) } catch (_: Throwable) { null }
    }
    c("background")?.let { background = it }
    c("text")?.let { text = it }
    c("textSecondary")?.let { textSecondary = it }
    c("accent")?.let { accent = it }
    c("header")?.let { header = it } ?: run {
      header = Color.argb(235, Color.red(background), Color.green(background), Color.blue(background))
    }
    c("check")?.let { check = it }
  }
}

object PGUtil {
  private val TAG_RE = Regex("_([a-f0-9]{10})\\.[^.]+$")

  fun md5Tag(s: String, md: MessageDigest): String {
    md.reset()
    val d = md.digest(s.toByteArray(Charsets.UTF_8))
    val hex = "0123456789abcdef"
    val sb = StringBuilder(10)
    for (i in 0 until 5) {
      val b = d[i].toInt() and 0xff
      sb.append(hex[b ushr 4]); sb.append(hex[b and 0xf])
    }
    return sb.toString()
  }

  fun tagFromName(name: String): String = TAG_RE.find(name)?.groupValues?.get(1) ?: ""

  fun stripQuery(url: String): String {
    val q = url.indexOf('?')
    return if (q >= 0) url.substring(0, q) else url
  }

  fun formatDuration(sec: Double): String {
    val t = if (sec.isNaN() || sec < 0) 0 else Math.round(sec).toInt()
    val h = t / 3600; val m = (t % 3600) / 60; val s = t % 60
    return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s)
    else String.format(Locale.US, "%d:%02d", m, s)
  }

  // Data civil a partir do dia epoch (Howard Hinnant) — sem Calendar no laço.
  fun civil(epochDay: Long): IntArray {
    val z = epochDay + 719468
    val era = (if (z >= 0) z else z - 146096) / 146097
    val doe = z - era * 146097
    val yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
    val y = yoe + era * 400
    val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    val mp = (5 * doy + 2) / 153
    val d = doy - (153 * mp + 2) / 5 + 1
    val m = if (mp < 10) mp + 3 else mp - 9
    return intArrayOf((if (m <= 2) y + 1 else y).toInt(), m.toInt(), d.toInt())
  }

  fun localEpochDay(timeMs: Long, tz: TimeZone): Long {
    val t = timeMs + tz.getOffset(timeMs)
    return Math.floorDiv(t, 86_400_000L)
  }

  fun permission(ctx: Context): String {
    fun g(p: String) = ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
    return if (Build.VERSION.SDK_INT >= 33) {
      when {
        g(Manifest.permission.READ_MEDIA_IMAGES) || g(Manifest.permission.READ_MEDIA_VIDEO) -> "authorized"
        Build.VERSION.SDK_INT >= 34 && g("android.permission.READ_MEDIA_VISUAL_USER_SELECTED") -> "limited"
        else -> "denied"
      }
    } else {
      if (g(Manifest.permission.READ_EXTERNAL_STORAGE)) "authorized" else "denied"
    }
  }
}

/** Formata títulos de seção no locale pedido (cache por chave de seção). */
class PGDateFmt(localeTag: String?, private val today: String, private val yesterday: String) {
  private val locale: Locale = if (localeTag.isNullOrBlank()) Locale.getDefault() else Locale.forLanguageTag(localeTag)
  private val tz = TimeZone.getDefault()
  private val dayFmt = SimpleDateFormat(DateFormat.getBestDateTimePattern(locale, "EEEdMMM"), locale)
  private val dayYearFmt = SimpleDateFormat(DateFormat.getBestDateTimePattern(locale, "EEEdMMMyyyy"), locale)
  private val monthFmt = SimpleDateFormat(DateFormat.getBestDateTimePattern(locale, "MMMMyyyy"), locale)
  private val shortMonthFmt = SimpleDateFormat(DateFormat.getBestDateTimePattern(locale, "MMMyyyy"), locale)
  private val yearFmt = SimpleDateFormat("yyyy", locale)
  private val cache = HashMap<Long, String>()
  private val bubbleCache = HashMap<Long, String>()
  private val todayDay: Long
  private val thisYear: Int

  init {
    val now = System.currentTimeMillis()
    todayDay = PGUtil.localEpochDay(now, tz)
    thisYear = Calendar.getInstance(tz, locale).get(Calendar.YEAR)
  }

  fun timeZone(): TimeZone = tz

  private fun cap(s: String): String =
    if (s.isEmpty()) s else s.substring(0, 1).uppercase(locale) + s.substring(1)

  /** key: dia epoch (day), yyyy*100+mm (month) ou yyyy (year), com o grupo nos bits altos. */
  fun title(group: Int, sectionKey: Long, sampleTime: Long): String {
    val ck = (group.toLong() shl 40) or (sectionKey and 0xFFFFFFFFFFL)
    cache[ck]?.let { return it }
    val d = Date(sampleTime)
    val s = when (group) {
      PGZoomLevel.G_YEAR -> yearFmt.format(d)
      PGZoomLevel.G_MONTH -> cap(monthFmt.format(d))
      else -> {
        when (sectionKey) {
          todayDay -> today
          todayDay - 1 -> yesterday
          else -> {
            val y = PGUtil.civil(sectionKey)[0]
            cap(if (y == thisYear) dayFmt.format(d) else dayYearFmt.format(d))
          }
        }
      }
    }
    cache[ck] = s
    return s
  }

  fun bubble(time: Long, group: Int): String {
    val day = PGUtil.localEpochDay(time, tz)
    val c = PGUtil.civil(day)
    if (group == PGZoomLevel.G_YEAR) return c[0].toString()
    val k = c[0] * 100L + c[1]
    bubbleCache[k]?.let { return it }
    val s = cap(shortMonthFmt.format(Date(time)))
    bubbleCache[k] = s
    return s
  }
}

/** Enumeração MediaStore (thread de fundo). */
object PGLocalSource {
  fun load(ctx: Context): ArrayList<PGItem> {
    val out = ArrayList<PGItem>(4096)
    val md = MessageDigest.getInstance("MD5")
    query(ctx, false, out, md)
    query(ctx, true, out, md)
    out.sortWith { a, b -> b.time.compareTo(a.time) }
    return out
  }

  private fun query(ctx: Context, video: Boolean, out: ArrayList<PGItem>, md: MessageDigest) {
    val base = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    val proj = if (video) arrayOf(
      MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.DATE_ADDED,
      MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT, MediaStore.MediaColumns.MIME_TYPE,
      MediaStore.Video.VideoColumns.DURATION
    ) else arrayOf(
      MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.DATE_ADDED,
      MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT, MediaStore.MediaColumns.MIME_TYPE
    )
    val cursor = try {
      ctx.contentResolver.query(base, proj, null, null, null)
    } catch (_: Throwable) { null } ?: return
    cursor.use { c ->
      val iId = c.getColumnIndex(MediaStore.MediaColumns._ID)
      val iTaken = c.getColumnIndex(MediaStore.MediaColumns.DATE_TAKEN)
      val iAdded = c.getColumnIndex(MediaStore.MediaColumns.DATE_ADDED)
      val iW = c.getColumnIndex(MediaStore.MediaColumns.WIDTH)
      val iH = c.getColumnIndex(MediaStore.MediaColumns.HEIGHT)
      val iDur = if (video) c.getColumnIndex(MediaStore.Video.VideoColumns.DURATION) else -1
      while (c.moveToNext()) {
        val id = c.getLong(iId)
        var t = if (iTaken >= 0 && !c.isNull(iTaken)) c.getLong(iTaken) else 0L
        if (t <= 0 && iAdded >= 0) t = c.getLong(iAdded) * 1000L
        val sid = id.toString()
        val dur = if (iDur >= 0 && !c.isNull(iDur)) c.getLong(iDur) / 1000.0 else 0.0
        val uri = ContentUris.withAppendedId(base, id).toString()
        val item = PGItem(
          key = "l:$sid", local = true, localId = sid, cloudId = "", time = t,
          width = if (iW >= 0) c.getInt(iW) else 0, height = if (iH >= 0) c.getInt(iH) else 0,
          video = video, durationSec = dur, uri = uri, thumb = uri, name = "",
          tag = PGUtil.md5Tag(sid, md), unavailable = false
        )
        if (video) item.durationLabel = PGUtil.formatDuration(dur)
        out.add(item)
      }
    }
  }

  fun parseCloud(raw: List<*>): ArrayList<PGItem> {
    val out = ArrayList<PGItem>(raw.size)
    for (r in raw) {
      val m = r as? Map<*, *> ?: continue
      val idAny = m["id"] ?: continue
      val id = when (idAny) {
        is Number -> { val d = idAny.toDouble(); if (d == Math.floor(d)) d.toLong().toString() else d.toString() }
        else -> idAny.toString()
      }
      if (id.isEmpty()) continue
      val name = (m["n"] as? String) ?: ""
      val video = (m["v"] as? Boolean) ?: ((m["v"] as? Number)?.toInt() == 1)
      val dur = (m["d"] as? Number)?.toDouble() ?: 0.0
      val thumb = (m["u"] as? String) ?: ""
      val item = PGItem(
        key = "c:$id", local = false, localId = "", cloudId = id,
        time = (m["t"] as? Number)?.toLong() ?: 0L,
        width = (m["w"] as? Number)?.toInt() ?: 0, height = (m["h"] as? Number)?.toInt() ?: 0,
        video = video, durationSec = dur,
        uri = ((m["f"] as? String)?.takeIf { it.isNotEmpty() } ?: thumb), thumb = thumb, name = name,
        tag = PGUtil.tagFromName(name),
        unavailable = (m["x"] as? Boolean) ?: false
      )
      if (video && dur > 0) item.durationLabel = PGUtil.formatDuration(dur)
      out.add(item)
    }
    return out
  }

  /** Junta locais + nuvem (escondendo nuvem casada por tag), ordena por tempo desc. */
  fun merge(local: List<PGItem>, cloud: List<PGItem>): Array<PGItem> {
    val cloudTags = HashSet<String>(cloud.size * 2)
    for (c in cloud) if (c.tag.isNotEmpty()) cloudTags.add(c.tag)
    val localTags = HashSet<String>(local.size * 2)
    for (l in local) {
      l.cloudMatched = cloudTags.contains(l.tag)
      localTags.add(l.tag)
    }
    val visibleCloud = ArrayList<PGItem>(cloud.size)
    for (c in cloud) if (c.tag.isEmpty() || !localTags.contains(c.tag)) visibleCloud.add(c)
    visibleCloud.sortWith { a, b -> b.time.compareTo(a.time) }
    // merge de duas listas já ordenadas
    val out = arrayOfNulls<PGItem>(local.size + visibleCloud.size)
    var i = 0; var j = 0; var k = 0
    while (i < local.size && j < visibleCloud.size) {
      out[k++] = if (local[i].time >= visibleCloud[j].time) local[i++] else visibleCloud[j++]
    }
    while (i < local.size) out[k++] = local[i++]
    while (j < visibleCloud.size) out[k++] = visibleCloud[j++]
    @Suppress("UNCHECKED_CAST")
    return out as Array<PGItem>
  }
}
