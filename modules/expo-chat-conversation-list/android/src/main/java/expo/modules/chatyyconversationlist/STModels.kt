package expo.modules.chatyyconversationlist

// [2026-10-15 settings-native] Modelos da lista NATIVA da raiz das
// Configurações. Mesmo contrato do iOS (ios/STModels.swift):
//   id, k ("c" categoria · "q" resultado de busca · "a" ação · "t" toggle),
//   sid (seção), hd (cabeçalho), title, sub, icon, kw, dest, center, on.
// [2026-10-18 settings-sub-native] apiVersion 2 (sub-páginas): k "i" (só
//   informação), val, acc ("" · "c" · "n" · "k" · "u" · "s"), dis, tl, sl, ft.
// [2026-10-18 settings-sub-native-2] apiVersion 4: vd (valor na cor destrutiva).

import android.graphics.Color
import java.text.Normalizer
import java.util.Locale
import kotlin.math.max

internal data class STRow(
  val id: String = "",
  val kind: String = "c",
  val sid: String = "",
  val header: String = "",
  val title: String = "",
  val sub: String = "",
  val icon: String = "",
  val keywords: String = "",
  val destructive: Boolean = false,
  val center: Boolean = false,
  val on: Boolean = false,
  val value: String = "",
  val acc: String = "",
  val disabled: Boolean = false,
  val titleLines: Int = 1,
  val subLines: Int = 1,
  val footer: String = "",
  val valueDestructive: Boolean = false,
  val hay: String = ""
) {
  /** Acessório efetivo: "t" interruptor · "c" seta · "n" nada · "k" check · "u" vazio · "s" spinner. */
  val accessory: String
    get() = when {
      kind == "t" -> "t"
      acc.isNotEmpty() -> acc
      center || destructive -> "n"
      else -> "c"
    }

  /** Toque abre/aciona (o toggle alterna pelo próprio interruptor). */
  val pressable: Boolean
    get() = kind != "t" && kind != "i" && !disabled

  companion object {
    fun from(m: Map<String, Any?>): STRow {
      val title = CLVal.str(m["title"])
      val sub = CLVal.str(m["sub"])
      val kw = CLVal.str(m["kw"])
      val k = CLVal.str(m["k"])
      return STRow(
        id = CLVal.str(m["id"]),
        kind = if (k.isEmpty()) "c" else k,
        sid = CLVal.str(m["sid"]),
        header = CLVal.str(m["hd"]),
        title = title,
        sub = sub,
        icon = CLVal.str(m["icon"]),
        keywords = kw,
        destructive = CLVal.bool(m["dest"]),
        center = CLVal.bool(m["center"]),
        on = CLVal.bool(m["on"]),
        value = CLVal.str(m["val"]),
        acc = CLVal.str(m["acc"]),
        disabled = CLVal.bool(m["dis"]),
        titleLines = if (m.containsKey("tl")) max(0, CLVal.int(m["tl"])) else 1,
        subLines = if (m.containsKey("sl")) max(0, CLVal.int(m["sl"])) else 1,
        footer = CLVal.str(m["ft"]),
        valueDestructive = CLVal.bool(m["vd"]),
        hay = STText.normalize("$title $sub $kw")
      )
    }
  }
}

internal object STText {
  private val marks = Regex("\\p{Mn}+")

  fun normalize(s: String): String {
    val d = Normalizer.normalize(s, Normalizer.Form.NFD)
    return marks.replace(d, "").lowercase(Locale.ROOT).trim()
  }

  /** Ícone lógico do JS → drawable (traço do components/Icons.js). */
  fun drawable(name: String): Int = when (name) {
    "user" -> R.drawable.ccl_ic_user
    "shield" -> R.drawable.cst_ic_shield
    "message" -> R.drawable.ccl_ic_message
    "bell" -> R.drawable.ccl_ic_bell
    "database" -> R.drawable.cst_ic_database
    "type" -> R.drawable.cst_ic_type
    "globe" -> R.drawable.cst_ic_globe
    "mail" -> R.drawable.ccl_ic_mail
    "sparkles" -> R.drawable.ccl_ic_sparkles
    "help" -> R.drawable.cst_ic_help
    "userPlus" -> R.drawable.cct_ic_user_plus
    "search" -> R.drawable.cst_ic_search
    // [2026-10-18 settings-sub-native] atalhos da raiz + ícones das sub-páginas.
    "wallet" -> R.drawable.ap_ic_wallet
    "plus" -> R.drawable.ap_ic_plus
    else -> CIText.drawable(name)
  }
}

/** Paleta resolvida no JS (useGroupedColors → processColor ARGB). */
internal data class STPalette(
  val dark: Boolean,
  val pageBg: Int,
  val cardBg: Int,
  val separator: Int,
  val header: Int,
  val text: Int,
  val secondary: Int,
  val tertiary: Int,
  val chipBg: Int,
  val chipFg: Int,
  val destructive: Int,
  val ripple: Int
) {
  // Interruptor igual ao NativeSwitch do JS (P&B; Android).
  val switchOnTrack: Int get() = if (dark) 0xFFF5F5F7.toInt() else 0xFF111111.toInt()
  val switchOffTrack: Int get() = if (dark) 0xFF5F6368.toInt() else 0xFFC7C9CC.toInt()
  val switchOnThumb: Int get() = if (dark) 0xFF0B0B0B.toInt() else Color.WHITE
  val switchOffThumb: Int get() = if (dark) 0xFF9AA0A6.toInt() else Color.WHITE

  companion object {
    fun defaults(dark: Boolean): STPalette = if (dark) STPalette(
      dark = true,
      pageBg = Color.BLACK,
      cardBg = 0xFF141416.toInt(),
      separator = 0x12FFFFFF,
      header = 0xFF7C7C82.toInt(),
      text = 0xFFF5F5F7.toInt(),
      secondary = 0xFF8E8E93.toInt(),
      tertiary = 0xFF636366.toInt(),
      chipBg = 0x13FFFFFF,
      chipFg = 0xFFEDEDF0.toInt(),
      destructive = 0xFFDC2626.toInt(),
      ripple = 0x1FFFFFFF
    ) else STPalette(
      dark = false,
      pageBg = 0xFFF3F3F6.toInt(),
      cardBg = Color.WHITE,
      separator = 0x1C3C3C43,
      header = 0xFF77777D.toInt(),
      text = 0xFF111111.toInt(),
      secondary = 0xFF8A8A8E.toInt(),
      tertiary = 0xFFC4C4C7.toInt(),
      chipBg = 0x0E111111,
      chipFg = 0xFF1A1A1C.toInt(),
      destructive = 0xFFDC2626.toInt(),
      ripple = 0x14000000
    )

    private fun color(v: Any?): Int? {
      if (v is Number) {
        val d = v.toDouble()
        if (d.isNaN() || d.isInfinite()) return null
        return d.toLong().toInt()
      }
      return null
    }

    fun from(dark: Boolean, m: Map<String, Any?>?): STPalette {
      val b = defaults(dark)
      if (m == null) return b
      return b.copy(
        pageBg = color(m["pageBg"]) ?: b.pageBg,
        cardBg = color(m["cardBg"]) ?: b.cardBg,
        separator = color(m["separator"]) ?: b.separator,
        header = color(m["header"]) ?: b.header,
        text = color(m["text"]) ?: b.text,
        secondary = color(m["secondary"]) ?: b.secondary,
        tertiary = color(m["tertiary"]) ?: b.tertiary,
        chipBg = color(m["chipBg"]) ?: b.chipBg,
        chipFg = color(m["chipFg"]) ?: b.chipFg,
        destructive = color(m["destructive"]) ?: b.destructive,
        ripple = color(m["ripple"]) ?: b.ripple
      )
    }
  }
}
