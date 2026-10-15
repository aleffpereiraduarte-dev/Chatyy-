package expo.modules.chatyyconversationlist

// [2026-10-15 native-search-notifs] Modelos da lista de RESULTADOS nativa
// (ChatyyResultList): busca global e central de notificações. Mesmo contrato
// do iOS (ios/RLModels.swift). Linhas PLANAS vindas de
// components/native/resultListAdapter.js:
//   seção      → { id, k: 's', t, ac? }
//   linha      → { id, k: 'r', t, tl, sb, sl, tm, tiles | th(+ta) | gl(+gs),
//                  bd, pv, rt, un, b1, b1f, b1b, b2, sw, cv, hl, tap, a11y }
//   carregando → { id, k: 'l', t? }
//   aviso      → { id, k: 'n', t, gl? }
// O termo buscado vem na prop `highlight` e é destacado AQUI.

import android.graphics.Color
import java.text.Normalizer

internal data class RLRow(
  val id: String = "",
  val kind: String = "r",
  val title: String = "",
  val titleLines: Int = 1,
  val sub: String = "",
  val subLines: Int = 1,
  val time: String = "",
  val tiles: List<CLTile> = emptyList(),
  val thumb: String = "",
  val thumbAuth: Boolean = false,
  val glyph: String = "",
  val glyphRound: Boolean = false,
  val badge: String = "",
  val play: Boolean = false,
  val rightThumb: String = "",
  val unread: Boolean = false,
  val b1: String = "",
  val b1Filled: Boolean = true,
  val b1Busy: Boolean = false,
  val b2: String = "",
  val swipe: String = "",
  val chevron: Boolean = false,
  val highlight: Boolean = false,
  val tap: Boolean = true,
  val a11y: String = "",
  val action: String = ""
) {
  val isSection: Boolean get() = kind == "s"
  val hasTiles: Boolean get() = tiles.isNotEmpty()
  val hasButtons: Boolean get() = b1.isNotEmpty() || b2.isNotEmpty()

  fun avatarRow(): CLRow = CLRow(id = id, kind = "direct", title = title, tiles = tiles)

  companion object {
    fun from(m: Map<String, Any?>): RLRow {
      val tiles = ArrayList<CLTile>()
      CLVal.list(m["tiles"])?.forEach { t -> CLVal.map(t)?.let { tiles.add(CLTile.from(it)) } }
      fun lines(key: String): Int = if (m[key] == null) 1 else CLVal.int(m[key]).coerceIn(1, 3)
      return RLRow(
        id = CLVal.str(m["id"]),
        kind = CLVal.str(m["k"]).ifEmpty { "r" },
        title = CLVal.str(m["t"]),
        titleLines = lines("tl"),
        sub = CLVal.str(m["sb"]),
        subLines = lines("sl"),
        time = CLVal.str(m["tm"]),
        tiles = tiles,
        thumb = CLVal.str(m["th"]),
        thumbAuth = CLVal.bool(m["ta"]),
        glyph = CLVal.str(m["gl"]),
        glyphRound = CLVal.str(m["gs"]) == "r",
        badge = CLVal.str(m["bd"]),
        play = CLVal.bool(m["pv"]),
        rightThumb = CLVal.str(m["rt"]),
        unread = CLVal.bool(m["un"]),
        b1 = CLVal.str(m["b1"]),
        b1Filled = if (m["b1f"] == null) true else CLVal.bool(m["b1f"]),
        b1Busy = CLVal.bool(m["b1b"]),
        b2 = CLVal.str(m["b2"]),
        swipe = CLVal.str(m["sw"]),
        chevron = CLVal.bool(m["cv"]),
        highlight = CLVal.bool(m["hl"]),
        tap = if (m["tap"] == null) true else CLVal.bool(m["tap"]),
        a11y = CLVal.str(m["a11y"]),
        action = CLVal.str(m["ac"])
      )
    }
  }
}

/** Glifos semânticos → drawables do pacote (traço do components/Icons.js). */
internal object RLGlyphs {
  fun res(name: String): Int = when (name) {
    "message" -> R.drawable.ccl_ic_message
    "mail" -> R.drawable.ccl_ic_mail
    "user" -> R.drawable.ccl_ic_user
    "userPlus" -> R.drawable.cct_ic_user_plus
    "image" -> R.drawable.crl_ic_image
    "film" -> R.drawable.ccl_ic_film
    "video" -> R.drawable.ccl_ic_video
    "file" -> R.drawable.ccl_ic_file
    "clock" -> R.drawable.ccl_ic_clock
    "search" -> R.drawable.cst_ic_search
    "heart" -> R.drawable.crl_ic_heart
    "at" -> R.drawable.crl_ic_at
    "bell" -> R.drawable.ccl_ic_bell
    "hash" -> R.drawable.crl_ic_hash
    "music" -> R.drawable.ccl_ic_music
    "mic" -> R.drawable.ccl_ic_mic
    "link" -> R.drawable.crl_ic_link
    "chart" -> R.drawable.ccl_ic_chart
    "calendar" -> R.drawable.ccl_ic_calendar
    "play" -> R.drawable.crl_ic_play
    "live" -> R.drawable.ccl_ic_video
    else -> R.drawable.cst_ic_search
  }
}

/** Destaque do termo sem caixa/acento: intervalos [início, fim) no texto original. */
internal object RLHighlight {
  fun tokens(q: String): List<String> {
    val out = ArrayList<String>()
    for (p in q.split(' ', '\n', '\t')) {
      val t = p.trim('#', '@', '"', '\'')
      if (t.isNotEmpty() && !out.contains(t)) out.add(t)
    }
    val full = q.trim()
    if (out.size > 1 && full.isNotEmpty()) out.add(0, full)
    return out.take(6).map { fold(it) }.filter { it.isNotEmpty() }
  }

  /** Dobra 1 char → 1 char (mantém os índices do texto original). */
  fun fold(s: String): String {
    val sb = StringBuilder(s.length)
    for (ch in s) {
      val n = try {
        Normalizer.normalize(ch.toString(), Normalizer.Form.NFD)
      } catch (_: Throwable) { ch.toString() }
      var base = ch
      for (c in n) {
        if (Character.getType(c) != Character.NON_SPACING_MARK.toInt()) { base = c; break }
      }
      sb.append(base.lowercaseChar())
    }
    return sb.toString()
  }

  fun ranges(text: String, folded: List<String>): List<IntArray> {
    if (text.isEmpty() || folded.isEmpty()) return emptyList()
    val hay = fold(text)
    val out = ArrayList<IntArray>()
    for (t in folded) {
      var start = 0
      var guard = 0
      while (start < hay.length && guard < 20) {
        guard++
        val i = hay.indexOf(t, start)
        if (i < 0) break
        val e = i + t.length
        if (out.none { i < it[1] && e > it[0] }) out.add(intArrayOf(i, e))
        start = e
      }
    }
    return out
  }
}

/** Cor de não lida (padrão por tema) — prop colors.unreadBg sobrescreve. */
internal fun rlUnreadBg(m: Map<String, Any?>?, dark: Boolean): Int =
  CTColor.of(m?.get("unreadBg")) ?: if (dark) Color.argb(15, 255, 255, 255) else Color.argb(10, 0, 0, 0)
