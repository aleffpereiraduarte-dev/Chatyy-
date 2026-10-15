package expo.modules.chatyyconversationlist

// [2026-10-15 native-wallet] Modelos da CARTEIRA nativa (Android). Mesmo
// contrato do iOS (ios/WLModels.swift) — linhas planas do JS
// (components/native/NativeWalletList.js):
//   dia        → { id, k: 'd', t }
//   transação  → { id, k: 'x', sid, gl, t, sb, am, cr, dm, a2, ag, tiles?, a11y, tap? }
//   vazio      → { id, k: 'e', gl, t, sb, b?, ba? }
//   carregando → { id, k: 'l' }
//   nota       → { id, k: 'n', t, cr? }

import android.graphics.Color
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

internal data class WLRow(
  val id: String = "",
  val kind: String = "x",
  val sid: String = "",
  val glyph: String = "",
  val title: String = "",
  val sub: String = "",
  val amount: String = "",
  val credit: Boolean = false,
  val diamond: Boolean = false,
  val amount2: String = "",
  val amountGlyph: String = "",
  val tiles: List<CLTile> = emptyList(),
  val button: String = "",
  val buttonAction: String = "",
  val a11y: String = "",
  val tap: Boolean = true
) {
  val hasTiles: Boolean get() = tiles.isNotEmpty()

  fun avatarRow(): CLRow = CLRow(id = id, kind = "direct", title = title, tiles = tiles)

  companion object {
    fun from(m: Map<String, Any?>): WLRow {
      val tiles = ArrayList<CLTile>()
      CLVal.list(m["tiles"])?.forEach { t -> CLVal.map(t)?.let { tiles.add(CLTile.from(it)) } }
      val k = CLVal.str(m["k"])
      return WLRow(
        id = CLVal.str(m["id"]),
        kind = if (k.isEmpty()) "x" else k,
        sid = CLVal.str(m["sid"]),
        glyph = CLVal.str(m["gl"]),
        title = CLVal.str(m["t"]),
        sub = CLVal.str(m["sb"]),
        amount = CLVal.str(m["am"]),
        credit = CLVal.bool(m["cr"]),
        diamond = CLVal.bool(m["dm"]),
        amount2 = CLVal.str(m["a2"]),
        amountGlyph = CLVal.str(m["ag"]),
        tiles = tiles,
        button = CLVal.str(m["b"]),
        buttonAction = CLVal.str(m["ba"]),
        a11y = CLVal.str(m["a11y"]),
        tap = if (m["tap"] == null) true else CLVal.bool(m["tap"])
      )
    }
  }
}

internal data class WLHeroStat(val label: String, val value: String, val sub: String)

internal data class WLHeroButton(val id: String, val label: String, val primary: Boolean, val disabled: Boolean, val a11y: String)

internal data class WLHero(
  val caps: String = "",
  val brand: String = "",
  val value: Double? = null,
  val format: String = "int",
  val text: String = "",
  val locale: String = "",
  val diamond: Boolean = false,
  val danger: Boolean = false,
  val numSize: Float = 46f,
  val sub: String = "",
  val note: String = "",
  val stats: List<WLHeroStat> = emptyList(),
  val progress: Double = -1.0,
  val progressText: String = "",
  val notice: String = "",
  val buttons: List<WLHeroButton> = emptyList(),
  val foot: String = "",
  val glow: Boolean = true,
  val a11y: String = ""
) {
  companion object {
    fun from(m: Map<String, Any?>): WLHero {
      val v = m["value"]
      val value = if (v is Number && !v.toDouble().isNaN() && !v.toDouble().isInfinite()) v.toDouble() else null
      val stats = ArrayList<WLHeroStat>()
      CLVal.list(m["stats"])?.forEach { s ->
        val sm = CLVal.map(s) ?: return@forEach
        stats.add(WLHeroStat(CLVal.str(sm["l"]), CLVal.str(sm["v"]), CLVal.str(sm["s"])))
      }
      val buttons = ArrayList<WLHeroButton>()
      CLVal.list(m["buttons"])?.forEach { b ->
        val bm = CLVal.map(b) ?: return@forEach
        val id = CLVal.str(bm["id"])
        if (id.isEmpty()) return@forEach
        buttons.add(WLHeroButton(id, CLVal.str(bm["label"]), CLVal.bool(bm["primary"]), CLVal.bool(bm["disabled"]), CLVal.str(bm["a11y"])))
      }
      val f = CLVal.str(m["fmt"])
      return WLHero(
        caps = CLVal.str(m["caps"]),
        brand = CLVal.str(m["brand"]),
        value = value,
        format = if (f.isEmpty()) "int" else f,
        text = CLVal.str(m["text"]),
        locale = CLVal.str(m["loc"]),
        diamond = CLVal.bool(m["dia"]),
        danger = CLVal.bool(m["danger"]),
        numSize = if (m["numSize"] == null) 46f else CLVal.double(m["numSize"]).toFloat().coerceIn(20f, 64f),
        sub = CLVal.str(m["sub"]),
        note = CLVal.str(m["note"]),
        stats = stats,
        progress = if (m["prog"] == null) -1.0 else CLVal.double(m["prog"]),
        progressText = CLVal.str(m["progText"]),
        notice = CLVal.str(m["notice"]),
        buttons = buttons,
        foot = CLVal.str(m["foot"]),
        glow = if (m["glow"] == null) true else CLVal.bool(m["glow"]),
        a11y = CLVal.str(m["a11y"])
      )
    }
  }
}

/** Paleta da tela (useSurface → processColor ARGB). */
internal class WLPalette(val dark: Boolean, m: Map<String, Any?>? = null) {
  val pageBg: Int = CTColor.of(m?.get("pageBg")) ?: if (dark) Color.BLACK else Color.parseColor("#F2F2F7")
  val cardBg: Int = CTColor.of(m?.get("cardBg")) ?: if (dark) Color.parseColor("#1C1C1E") else Color.WHITE
  val separator: Int = CTColor.of(m?.get("separator")) ?: if (dark) 0x1AFFFFFF else 0x14000000
  val text: Int = CTColor.of(m?.get("text")) ?: if (dark) Color.parseColor("#F5F5F7") else Color.parseColor("#111111")
  val secondary: Int = CTColor.of(m?.get("secondary")) ?: Color.parseColor("#8E8E93")
  val tertiary: Int = CTColor.of(m?.get("tertiary")) ?: if (dark) Color.parseColor("#636366") else Color.parseColor("#C4C4C7")
  val fill: Int = CTColor.of(m?.get("fill")) ?: if (dark) 0x14FFFFFF else 0x0D000000
  val success: Int = CTColor.of(m?.get("success")) ?: Color.parseColor("#16A34A")
  val danger: Int = CTColor.of(m?.get("danger")) ?: Color.parseColor("#DC2626")
  val ink: Int = CTColor.of(m?.get("ink")) ?: if (dark) Color.WHITE else Color.parseColor("#111111")
  val onInk: Int = CTColor.of(m?.get("onInk")) ?: if (dark) Color.BLACK else Color.WHITE
  val press: Int = CTColor.of(m?.get("press")) ?: if (dark) 0x14FFFFFF else 0x0D000000
}

internal object WLGlyphs {
  fun res(name: String): Int = when (name) {
    "purchase" -> R.drawable.wl_ic_purchase
    "gift" -> R.drawable.wl_ic_gift
    "cashout" -> R.drawable.wl_ic_cashout
    "convert" -> R.drawable.wl_ic_convert
    "refund" -> R.drawable.wl_ic_refund
    "promo" -> R.drawable.wl_ic_promo
    "receipt" -> R.drawable.wl_ic_receipt
    else -> R.drawable.wl_ic_transfer
  }
}

/** Formatação durante a contagem (o texto final vem pronto do JS). */
internal object WLNumber {
  private val cache = HashMap<String, NumberFormat>()

  private fun formatter(format: String, locale: String): NumberFormat {
    val key = "$format|$locale"
    cache[key]?.let { return it }
    val f: NumberFormat
    if (format == "brl") {
      f = NumberFormat.getCurrencyInstance(Locale("pt", "BR"))
      f.currency = Currency.getInstance("BRL")
      f.minimumFractionDigits = 2
      f.maximumFractionDigits = 2
    } else {
      val loc = if (locale.isEmpty()) Locale.getDefault() else Locale.forLanguageTag(locale)
      f = NumberFormat.getIntegerInstance(loc)
      f.maximumFractionDigits = 0
    }
    cache[key] = f
    return f
  }

  fun format(v: Double, format: String, locale: String): String {
    val n = if (format == "brl") v / 100.0 else Math.round(v).toDouble()
    return formatter(format, locale).format(n)
  }
}

internal object WLHeroColors {
  const val text = 0xFFFFFFFF.toInt()
  const val sub = 0x9EFFFFFF.toInt()
  const val faint = 0x61FFFFFF
  const val line = 0x1FFFFFFF
  const val outline = 0x4DFFFFFF
  const val fill = 0x1AFFFFFF
  const val danger = 0xFFFF6B63.toInt()
}
