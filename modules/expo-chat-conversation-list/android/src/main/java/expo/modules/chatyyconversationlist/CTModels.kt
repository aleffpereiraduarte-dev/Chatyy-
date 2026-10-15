package expo.modules.chatyyconversationlist

// [2026-10-15 native-contacts] Modelos da lista de CONTATOS nativa (contatos e
// nova conversa). Mesmo contrato do iOS (ios/CTModels.swift). As linhas vêm
// PLANAS do JS (components/contacts/contactListAdapter.js): cabeçalhos de seção
// (k = "s") e contatos (k = "r") numa sequência só; o índice A–Z sai das seções
// com `ix`.

import android.graphics.Color

internal object CTColor {
  /** processColor() do RN → Int ARGB; null quando ausente. */
  fun of(v: Any?): Int? {
    if (v == null) return null
    return when (v) {
      is Number -> v.toLong().toInt()
      is String -> try { Color.parseColor(v) } catch (_: Throwable) { null }
      else -> null
    }
  }
}

internal data class CTRow(
  val id: String = "",
  val kind: String = "r",
  // Seção
  val title: String = "",
  val sBg: Int? = null,
  val sFg: Int? = null,
  val sBar: Boolean = false,
  val sUpper: Boolean = false,
  val sSize: Float = 13f,
  val sWeight: Int = 600,
  val sPadTop: Float = 8f,
  val sPadBottom: Float = 8f,
  val sPadH: Float = 16f,
  val sHair: Boolean = false,
  val sSpacing: Float = 0f,
  val ix: String = "",
  // Contato
  val titleWeight: Int = 600,
  val suffix: String = "",
  val verified: Boolean = false,
  val newBadge: String = "",
  val sub: String = "",
  val subTone: Int = 0,
  val username: String = "",
  val sub2: String = "",
  val sub2Tone: Int = 0,
  val sub2Italic: Boolean = false,
  val chip: String = "",
  val meta: String = "",
  val tiles: List<CLTile> = emptyList(),
  val online: Boolean = false,
  val avatar: Float = 40f,
  val avatarRing: Boolean = false,
  val glyph: String = "",
  val glyphBg: Int? = null,
  val pill: String = "",
  val pillFilled: Boolean = false,
  val pillIcon: Boolean = false,
  val pillBusy: Boolean = false,
  val star: Int = 0,
  val trash: Boolean = false,
  val check: Int = 0,
  val swipe: String = "",
  val tap: Boolean = true,
  val longPress: Boolean = false,
  val a11y: String = ""
) {
  val isSection: Boolean get() = kind == "s"

  /** CLRow só com o que o CLAvatarView desenha (foto/iniciais + online). */
  fun avatarRow(): CLRow = CLRow(id = id, kind = "direct", title = title, tiles = tiles, online = online)

  companion object {
    fun from(m: Map<String, Any?>): CTRow {
      val tiles = ArrayList<CLTile>()
      CLVal.list(m["tiles"])?.forEach { t -> CLVal.map(t)?.let { tiles.add(CLTile.from(it)) } }
      fun f(key: String, def: Float): Float = if (m[key] == null) def else CLVal.double(m[key]).toFloat()
      fun i(key: String, def: Int): Int = if (m[key] == null) def else CLVal.int(m[key])
      return CTRow(
        id = CLVal.str(m["id"]),
        kind = CLVal.str(m["k"]).ifEmpty { "r" },
        title = CLVal.str(m["t"]),
        sBg = CTColor.of(m["sbg"]),
        sFg = CTColor.of(m["sfg"]),
        sBar = CLVal.bool(m["bar"]),
        sUpper = CLVal.bool(m["up"]),
        sSize = f("fs", 13f),
        sWeight = i("fw", 600),
        sPadTop = f("pt", 8f),
        sPadBottom = f("pb", 8f),
        sPadH = f("ph", 16f),
        sHair = CLVal.bool(m["hl"]),
        sSpacing = f("ls", 0f),
        ix = CLVal.str(m["ix"]),
        titleWeight = i("tw", 600),
        suffix = CLVal.str(m["sx"]),
        verified = CLVal.bool(m["vb"]),
        newBadge = CLVal.str(m["nb"]),
        sub = CLVal.str(m["sb"]),
        subTone = i("sbt", 0),
        username = CLVal.str(m["un"]),
        sub2 = CLVal.str(m["s2"]),
        sub2Tone = i("s2t", 0),
        sub2Italic = CLVal.bool(m["s2i"]),
        chip = CLVal.str(m["ch"]),
        meta = CLVal.str(m["me"]),
        tiles = tiles,
        online = CLVal.bool(m["on"]),
        avatar = f("av", 40f),
        avatarRing = CLVal.bool(m["ar"]),
        glyph = CLVal.str(m["gl"]),
        glyphBg = CTColor.of(m["gbg"]),
        pill = CLVal.str(m["pl"]),
        pillFilled = CLVal.bool(m["pf"]),
        pillIcon = CLVal.bool(m["pi"]),
        pillBusy = CLVal.bool(m["pb"]),
        star = i("st", 0),
        trash = CLVal.bool(m["tr"]),
        check = i("ck", 0),
        swipe = CLVal.str(m["sw"]),
        tap = if (m["tap"] == null) true else CLVal.bool(m["tap"]),
        longPress = CLVal.bool(m["lp"]),
        a11y = CLVal.str(m["a11y"])
      )
    }
  }
}

/** Cores da tela (colors do ThemeContext, já em ARGB via processColor). */
internal class CTColors(m: Map<String, Any?>? = null) {
  val dark: Boolean = CLVal.bool(m?.get("dark"))
  val bg: Int = CTColor.of(m?.get("bg")) ?: if (dark) Color.BLACK else Color.WHITE
  val text: Int = CTColor.of(m?.get("text")) ?: if (dark) Color.WHITE else Color.parseColor("#111111")
  val sub: Int = CTColor.of(m?.get("sub")) ?: Color.parseColor("#737373")
  val faint: Int = CTColor.of(m?.get("faint")) ?: Color.parseColor("#A3A3A3")
  val hair: Int = CTColor.of(m?.get("hair")) ?: if (dark) Color.argb(23, 255, 255, 255) else Color.argb(20, 0, 0, 0)
  val primary: Int = CTColor.of(m?.get("primary")) ?: if (dark) Color.WHITE else Color.parseColor("#111111")
  val onPrimary: Int = CTColor.of(m?.get("onPrimary")) ?: if (dark) Color.BLACK else Color.WHITE
  val warning: Int = CTColor.of(m?.get("warning")) ?: Color.parseColor("#F59E0B")
  val error: Int = CTColor.of(m?.get("error")) ?: Color.parseColor("#FF3B30")
  val press: Int = CTColor.of(m?.get("press")) ?: if (dark) Color.argb(20, 255, 255, 255) else Color.argb(15, 0, 0, 0)
  val chipBg: Int = CTColor.of(m?.get("chipBg")) ?: if (dark) Color.parseColor("#2C2C2E") else Color.parseColor("#F2F2F7")
  val chipText: Int = CTColor.of(m?.get("chipText")) ?: text
  val indexText: Int = CTColor.of(m?.get("indexText")) ?: primary
  val border: Int = CTColor.of(m?.get("border")) ?: if (dark) Color.argb(77, 255, 255, 255) else Color.argb(64, 0, 0, 0)
  val theme = CLTheme(dark)
}

/** Medidas da linha (dp / sp) — espelham os StyleSheets de cada tela. */
internal class CTMetrics(private val m: Map<String, Any?>? = null) {
  private fun f(key: String, def: Float): Float {
    val v = m?.get(key) ?: return def
    return CLVal.double(v).toFloat()
  }
  val padH = f("padH", 16f)
  val padV = f("padV", 14f)
  val gap = f("gap", 14f)
  val minH = f("minH", 0f)
  val nameSize = f("nameSize", 16f)
  val subSize = f("subSize", 13f)
  val sub2Size = f("sub2Size", 12f)
  val metaSize = f("metaSize", 10f)
}
