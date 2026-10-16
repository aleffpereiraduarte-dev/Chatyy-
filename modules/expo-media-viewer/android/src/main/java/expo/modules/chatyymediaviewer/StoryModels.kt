package expo.modules.chatyymediaviewer

import android.graphics.Color
import kotlin.math.abs

// [2026-10-15 native-story] Modelos do visualizador de status nativo (vêm do
// JS já normalizados por components/status/nativeStories.js).

enum class SVType { IMAGE, VIDEO, TEXT, VOICE }

/** [v2] Bloco sobre a mídia (figurinha/texto/GIF/enquete…). x/y em dp; < 0 = centralizado. */
class SVOverlay(
  val kind: String,
  val id: String,
  val x: Float,
  val y: Float,
  val text: String,
  val color: Int,
  val url: String,
  val w: Float,
  val h: Float,
  val email: String,
  val question: String,
  val options: List<String>,
  var counts: MutableList<Int>,
  /** -1 = não votou; -2 = dono (só resultados). */
  var myVote: Int,
  val correct: Int,
  val votable: Boolean,
  val hint: String,
  val targetMs: Double,
  val ended: String,
  val emoji: String,
  var value: Double,
  var avg: Double,
) {
  companion object {
    fun from(m: Map<*, *>): SVOverlay = SVOverlay(
      kind = SVItem.str(m, "kind"),
      id = SVItem.idOf(m["id"]),
      x = (SVItem.num(m["x"]) ?: 0.0).toFloat(),
      y = (SVItem.num(m["y"]) ?: 0.0).toFloat(),
      text = SVItem.str(m, "text"),
      color = SVItem.color(m["color"] as? String) ?: Color.WHITE,
      url = SVItem.str(m, "url"),
      w = (SVItem.num(m["w"]) ?: 0.0).toFloat(),
      h = (SVItem.num(m["h"]) ?: 0.0).toFloat(),
      email = SVItem.str(m, "email"),
      question = SVItem.str(m, "question"),
      options = (m["options"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList(),
      counts = ((m["counts"] as? List<*>)?.map { SVItem.num(it)?.toInt() ?: 0 } ?: emptyList()).toMutableList(),
      myVote = SVItem.num(m["myVote"])?.toInt() ?: -1,
      correct = SVItem.num(m["correct"])?.toInt() ?: -1,
      votable = (m["votable"] as? Boolean) ?: false,
      hint = SVItem.str(m, "hint"),
      targetMs = SVItem.num(m["targetMs"]) ?: 0.0,
      ended = SVItem.str(m, "ended"),
      emoji = SVItem.str(m, "emoji"),
      value = SVItem.num(m["value"]) ?: -1.0,
      avg = SVItem.num(m["avg"]) ?: -1.0,
    )
  }
}

/** points em dp: [x0,y0,x1,y1…]. */
class SVPath(val color: Int, val width: Float, val points: FloatArray)

class SVItem(
  val id: String,
  val type: SVType,
  val uri: String,
  val localUri: String,
  val thumb: String,
  val text: String,
  var caption: String,
  val bg: Int,
  val bgColors: IntArray,
  val font: String,
  val durationMs: Long,
  val timeLabel: String,
  var viewed: Boolean,
  var viewsCount: Int,
  var myReaction: String,
  val musicTitle: String,
  val musicArtist: String,
  val musicUrl: String,
  val musicStartMs: Long,
  val linkUrl: String,
  val linkLabel: String,
  val textAnim: String = "",
  val loop: Boolean = false,
  val translatable: Boolean = false,
  var translated: Boolean = false,
  val overlays: List<SVOverlay> = emptyList(),
  val paths: List<SVPath> = emptyList(),
) {
  fun hasFlag(f: String): Boolean = when (f) {
    "translatable" -> translatable
    else -> false
  }

  companion object {
    fun str(m: Map<*, *>, k: String): String = (m[k] as? String) ?: ""

    fun num(v: Any?): Double? = when (v) {
      is Number -> v.toDouble()
      is String -> v.toDoubleOrNull()
      else -> null
    }

    fun idOf(v: Any?): String = when (v) {
      is String -> v
      is Number -> {
        val d = v.toDouble()
        if (d == Math.floor(d) && abs(d) < 9.2E18) d.toLong().toString() else d.toString()
      }
      else -> ""
    }

    fun color(raw: String?): Int? {
      if (raw.isNullOrBlank()) return null
      var s = raw.trim()
      if (!s.startsWith("#")) return null
      s = s.substring(1)
      if (s.length == 3) s = s.map { "$it$it" }.joinToString("")
      return try {
        when (s.length) {
          6 -> Color.parseColor("#$s")
          8 -> {
            // CSS #RRGGBBAA → Android #AARRGGBB
            Color.parseColor("#" + s.substring(6, 8) + s.substring(0, 6))
          }
          else -> null
        }
      } catch (_: Throwable) {
        null
      }
    }

    fun from(m: Map<*, *>): SVItem {
      val type = when (str(m, "type")) {
        "video" -> SVType.VIDEO
        "text" -> SVType.TEXT
        "voice" -> SVType.VOICE
        else -> SVType.IMAGE
      }
      val d = num(m["duration"]) ?: 0.0
      val music = m["music"] as? Map<*, *> ?: emptyMap<Any, Any>()
      val link = m["link"] as? Map<*, *> ?: emptyMap<Any, Any>()
      val cols = (m["bgColors"] as? List<*>)?.mapNotNull { color(it as? String) } ?: emptyList()
      return SVItem(
        id = idOf(m["id"]),
        type = type,
        uri = str(m, "uri"),
        localUri = str(m, "localUri"),
        thumb = str(m, "thumb"),
        text = str(m, "text"),
        caption = str(m, "caption"),
        bg = color(m["bg"] as? String) ?: Color.rgb(17, 17, 17),
        bgColors = cols.toIntArray(),
        font = str(m, "font").ifEmpty { "sans" },
        durationMs = if (d > 0) d.coerceIn(1500.0, 60000.0).toLong() else 5000L,
        timeLabel = str(m, "timeLabel"),
        viewed = (m["viewed"] as? Boolean) ?: false,
        viewsCount = num(m["viewsCount"])?.toInt() ?: 0,
        myReaction = str(m, "myReaction"),
        musicTitle = str(music, "title"),
        musicArtist = str(music, "artist"),
        musicUrl = str(music, "url"),
        musicStartMs = num(music["startMs"])?.toLong() ?: 0L,
        linkUrl = str(link, "url"),
        linkLabel = str(link, "label"),
        textAnim = str(m, "textAnim"),
        loop = (m["loop"] as? Boolean) ?: false,
        translatable = (m["translatable"] as? Boolean) ?: false,
        translated = (m["translated"] as? Boolean) ?: false,
        overlays = (m["overlays"] as? List<*>)?.mapNotNull { r -> (r as? Map<*, *>)?.let { SVOverlay.from(it) } }?.filter { it.kind.isNotEmpty() } ?: emptyList(),
        paths = (m["paths"] as? List<*>)?.mapNotNull { r ->
          val pm = r as? Map<*, *> ?: return@mapNotNull null
          val nums = (pm["points"] as? List<*>)?.mapNotNull { num(it)?.toFloat() } ?: emptyList()
          if (nums.size < 4) return@mapNotNull null
          val n = nums.size - (nums.size % 2)
          SVPath(color(pm["color"] as? String) ?: Color.WHITE, (num(pm["width"]) ?: 3.0).toFloat().let { if (it > 0f) it else 3f }, nums.subList(0, n).toFloatArray())
        } ?: emptyList(),
      )
    }
  }
}

class SVMenuEntry(
  val id: String,
  val label: String,
  val destructive: Boolean,
  val confirm: String,
  val labelAlt: String = "",
  val itemFlag: String = "",
) {
  fun visible(item: SVItem): Boolean = itemFlag.isEmpty() || item.hasFlag(itemFlag)
  fun title(item: SVItem): String = if (item.translated && labelAlt.isNotEmpty()) labelAlt else label
}

class SVGroup(
  val key: String,
  val ownerEmail: String,
  val ownerName: String,
  val avatar: String,
  val isSelf: Boolean,
  var items: MutableList<SVItem>,
  val menu: List<SVMenuEntry>,
  var index: Int,
) {
  companion object {
    fun from(m: Map<*, *>): SVGroup {
      val owner = m["owner"] as? Map<*, *> ?: emptyMap<Any, Any>()
      val email = SVItem.str(owner, "email")
      val items = ArrayList<SVItem>()
      (m["items"] as? List<*>)?.forEach { r ->
        val im = r as? Map<*, *> ?: return@forEach
        val it = SVItem.from(im)
        if (it.id.isNotEmpty()) items.add(it)
      }
      val menu = ArrayList<SVMenuEntry>()
      (m["menu"] as? List<*>)?.forEach { r ->
        val em = r as? Map<*, *> ?: return@forEach
        val id = em["id"] as? String ?: return@forEach
        val label = em["label"] as? String ?: return@forEach
        menu.add(SVMenuEntry(id, label, (em["destructive"] as? Boolean) ?: false, (em["confirm"] as? String) ?: "", (em["labelAlt"] as? String) ?: "", (em["itemFlag"] as? String) ?: ""))
      }
      val explicit = SVItem.num(m["startItem"])?.toInt()
      var start = if (explicit != null && explicit >= 0) explicit else items.indexOfFirst { !it.viewed }.let { if (it < 0) 0 else it }
      start = start.coerceIn(0, maxOf(0, items.size - 1))
      return SVGroup(
        key = (m["key"] as? String)?.ifEmpty { null } ?: email,
        ownerEmail = email,
        ownerName = SVItem.str(owner, "name"),
        avatar = SVItem.str(owner, "avatar"),
        isSelf = (m["isSelf"] as? Boolean) ?: false,
        items = items,
        menu = menu,
        index = start,
      )
    }
  }
}

class SVReaction(val emoji: String, val kind: String) {
  fun drawable(): Int = when (kind) {
    "heart" -> R.drawable.sv_rx_heart
    "flame" -> R.drawable.sv_rx_flame
    "laugh" -> R.drawable.sv_rx_laugh
    "wow" -> R.drawable.sv_rx_wow
    "sad" -> R.drawable.sv_rx_sad
    "clap" -> R.drawable.sv_rx_clap
    else -> R.drawable.sv_rx_thumbs
  }

  companion object {
    fun drawableFor(kind: String): Int = SVReaction("", kind).drawable()
  }
}

class SVLabels(private val map: Map<String, String>) {
  fun get(key: String, fallback: String): String {
    val s = map[key]
    return if (s.isNullOrEmpty()) fallback else s
  }

  fun views(n: Int): String {
    val tpl = if (n == 1) get("viewsOne", "{count} visualização") else get("viewsOther", "{count} visualizações")
    return tpl.replace("{count}", n.toString())
  }
}
