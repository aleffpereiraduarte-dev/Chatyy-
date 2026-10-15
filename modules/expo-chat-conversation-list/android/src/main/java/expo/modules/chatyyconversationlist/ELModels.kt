package expo.modules.chatyyconversationlist

// [2026-10-15 native-inbox] Modelos da caixa de entrada NATIVA do e-mail
// (Android). Mesmo contrato do iOS (ios/ELModels.swift). O JS
// (components/email/emailNativeAdapter.js) manda tudo pronto: hora, prévia
// limpa, rótulos com cor resolvida, textos traduzidos e cores ARGB.

import android.graphics.Color

internal object ELColor {
  /** Número 0xAARRGGBB vindo do JS → Int de cor; null se ausente/ inválido. */
  fun parse(v: Any?): Int? {
    val d = (v as? Number)?.toDouble() ?: return null
    if (d.isNaN() || d < 0 || d > 4294967295.0) return null
    return d.toLong().toInt()
  }
}

internal data class ELChip(val name: String, val bg: Int, val fg: Int, val bd: Int) {
  companion object {
    fun from(m: Map<String, Any?>): ELChip = ELChip(
      name = CLVal.str(m["n"]),
      bg = ELColor.parse(m["bg"]) ?: Color.argb(30, 128, 128, 128),
      fg = ELColor.parse(m["fg"]) ?: Color.GRAY,
      bd = ELColor.parse(m["bd"]) ?: Color.TRANSPARENT
    )
  }
}

internal data class ELRow(
  val id: String = "",
  val kind: String = "email",
  val title: String = "",
  val from: String = "",
  val fromEmail: String = "",
  val subject: String = "",
  val preview: String = "",
  val time: String = "",
  val dateFull: String = "",
  val unread: Boolean = false,
  val starred: Boolean = false,
  val attach: Boolean = false,
  val muted: Boolean = false,
  val thread: Int = 0,
  val chips: List<ELChip> = emptyList(),
  val checked: Boolean = false,
  val active: Boolean = false,
  val snoozed: String = "",
  val nudge: String = "",
  val a11y: String = "",
  val avatar: CLRow = CLRow()
) {
  val isSection: Boolean get() = kind == "section"

  companion object {
    fun from(m: Map<String, Any?>): ELRow {
      val chips = ArrayList<ELChip>()
      CLVal.list(m["chips"])?.forEach { c -> CLVal.map(c)?.let { val ch = ELChip.from(it); if (ch.name.isNotEmpty()) chips.add(ch) } }
      val id = CLVal.str(m["id"])
      val from = CLVal.str(m["from"])
      val av = HashMap<String, Any?>()
      av["id"] = id
      av["kind"] = "direct"
      av["title"] = from
      m["tiles"]?.let { av["tiles"] = it }
      return ELRow(
        id = id,
        kind = CLVal.str(m["kind"]).ifEmpty { "email" },
        title = CLVal.str(m["title"]),
        from = from,
        fromEmail = CLVal.str(m["fromEmail"]),
        subject = CLVal.str(m["subject"]),
        preview = CLVal.str(m["preview"]),
        time = CLVal.str(m["time"]),
        dateFull = CLVal.str(m["dateFull"]),
        unread = CLVal.bool(m["unread"]),
        starred = CLVal.bool(m["starred"]),
        attach = CLVal.bool(m["attach"]),
        muted = CLVal.bool(m["muted"]),
        thread = CLVal.int(m["thread"]),
        chips = chips,
        checked = CLVal.bool(m["checked"]),
        active = CLVal.bool(m["active"]),
        snoozed = CLVal.str(m["snoozed"]),
        nudge = CLVal.str(m["nudge"]),
        a11y = CLVal.str(m["a11y"]),
        avatar = CLRow.from(av)
      )
    }
  }
}

/** Paleta vinda do ThemeContext (mesmas cores do EmailRow JS). */
internal class ELPalette(val dark: Boolean, private val p: Map<String, Any?>? = null) {
  private fun c(k: String, light: String, darkHex: String): Int =
    ELColor.parse(p?.get(k)) ?: Color.parseColor(if (dark) darkHex else light)

  val bg = c("bg", "#FFFFFF", "#0B0B0B")
  val sectionBg = c("sectionBg", "#FFFFFF", "#000000")
  val text = c("text", "#0B0B0B", "#F5F5F7")
  val sub = c("sub", "#5F6368", "#A1A1A6")
  val faint = c("faint", "#8696A0", "#6C6C70")
  val hair = ELColor.parse(p?.get("hair")) ?: if (dark) Color.argb(15, 255, 255, 255) else Color.parseColor("#F4F5F6")
  val selectedBg = c("selectedBg", "#F2F3F5", "#1C1C1E")
  val pressBg = if (dark) Color.parseColor("#1A1A1A") else Color.parseColor("#F0F0F0")
  val primary = c("primary", "#111111", "#F5F5F7")
  val star = c("star", "#111111", "#F5F5F7")
  val starEmpty = c("starEmpty", "#CBD0D6", "#4A4D52")
  val variant = c("variant", "#F1F3F4", "#1C1C1E")
  val checkOn = c("checkOn", "#111111", "#F5F5F7")
  val checkOff = c("checkOff", "#5F6368", "#A1A1A6")
}

/** Densidade (DENSITY_CONFIG + espaçamentos do EmailRow), em dp. */
internal class ELDensity(m: Map<String, Any?>? = null) {
  val padV: Float = m?.get("padV")?.let { CLVal.double(it).toFloat() } ?: 10f
  val padH: Float = m?.get("padH")?.let { CLVal.double(it).toFloat() } ?: 13f
  val minH: Float = m?.get("minH")?.let { CLVal.double(it).toFloat() } ?: 54f
  val avatar: Float = m?.get("avatar")?.let { kotlin.math.max(20f, CLVal.double(it).toFloat()) } ?: 38f
  val gap: Float = m?.get("gap")?.let { CLVal.double(it).toFloat() } ?: 10f
  val preview: Boolean = m?.get("preview")?.let { CLVal.bool(it) } ?: true
}
