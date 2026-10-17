package expo.modules.chatyyconversationlist

// [2026-10-15 native-lists] Aba STATUS em nativo (Android) — modelos.
// Mesmo contrato do iOS (ios/SLModels.swift). JS: components/status/NativeStatusList.js

import android.graphics.Color

internal data class SLRow(
  val id: String = "",
  val kind: String = "row",          // row | section
  val section: String = "",
  val email: String = "",
  val title: String = "",
  val time: String = "",
  val count: Int = 0,
  val ring: String = "",             // "1" visto, "0" novo (um por item)
  val muted: Boolean = false,
  val mine: Boolean = false,
  val notify: Boolean = false,
  val closeFriends: Boolean = false,
  val a11y: String = "",
  val tileUrl: String = "",
  val tileAuth: Boolean = false,
  val tileInitials: String = "",
  val tileGrad: Int = 0,
  val thumbText: String = "",
  val thumbBg: String = "",
  val thumbFont: String = "",
  val collapsible: Boolean = false,
  val expanded: Boolean = false
) {
  val isSection: Boolean get() = kind == "section"

  companion object {
    fun from(m: Map<String, Any?>): SLRow = SLRow(
      id = CLVal.str(m["id"]),
      kind = CLVal.str(m["kind"]).ifEmpty { "row" },
      section = CLVal.str(m["section"]),
      email = CLVal.str(m["email"]),
      title = CLVal.str(m["title"]),
      time = CLVal.str(m["time"]),
      count = CLVal.int(m["count"]),
      ring = CLVal.str(m["ring"]),
      muted = CLVal.bool(m["muted"]),
      mine = CLVal.bool(m["mine"]),
      notify = CLVal.bool(m["notify"]),
      closeFriends = CLVal.bool(m["cf"]),
      a11y = CLVal.str(m["a11y"]),
      tileUrl = CLVal.str(m["tu"]),
      tileAuth = CLVal.bool(m["ta"]),
      tileInitials = CLVal.str(m["ti"]),
      tileGrad = CLVal.int(m["tg"]),
      thumbText = CLVal.str(m["tt"]),
      thumbBg = CLVal.str(m["tbg"]),
      thumbFont = CLVal.str(m["tf"]),
      collapsible = CLVal.bool(m["collapsible"]),
      expanded = CLVal.bool(m["expanded"])
    )
  }
}

/** Cores da aba (fallback; o JS manda `palette` com as do tema). */
internal class SLPalette(val dark: Boolean, m: Map<String, Any?>? = null) {
  var bg: Int
  var card: Int
  var text: Int
  var sub: Int
  var pillBg: Int
  val press: Int
  val ink: Int
  val ringViewed: Int = Color.argb(89, 150, 150, 150)
  // [2026-10-16 P&B] não é mais usado no anel (era verde); mantido p/ compat.
  val closeFriends: Int = Color.parseColor("#10B981")

  init {
    if (dark) {
      bg = Color.BLACK
      card = Color.parseColor("#1C1C1E")
      text = Color.parseColor("#F5F5F7")
      sub = Color.parseColor("#8E8E93")
      pillBg = Color.parseColor("#2C2C2E")
      press = Color.argb(20, 255, 255, 255)
      ink = Color.parseColor("#F5F5F7")
    } else {
      bg = Color.parseColor("#F2F2F7")
      card = Color.WHITE
      text = Color.parseColor("#111111")
      sub = Color.parseColor("#737373")
      pillBg = Color.parseColor("#F0F0F0")
      press = Color.argb(13, 0, 0, 0)
      ink = Color.parseColor("#111111")
    }
    if (m != null) {
      SLColor.parse(CLVal.str(m["bg"]))?.let { bg = it }
      SLColor.parse(CLVal.str(m["card"]))?.let { card = it }
      SLColor.parse(CLVal.str(m["text"]))?.let { text = it }
      SLColor.parse(CLVal.str(m["sub"]))?.let { sub = it }
      SLColor.parse(CLVal.str(m["pill"]))?.let { pillBg = it }
    }
  }
}

internal object SLColor {
  /** "#RGB" / "#RRGGBB" / "#RRGGBBAA" → ARGB (null se não for hex). */
  fun parse(s: String): Int? {
    var h = s.trim()
    if (!h.startsWith("#")) return null
    h = h.substring(1)
    if (h.length == 3) h = h.map { "$it$it" }.joinToString("")
    if (h.length != 6 && h.length != 8) return null
    val v = h.toLongOrNull(16) ?: return null
    return if (h.length == 6) {
      (0xFF000000L or v).toInt()
    } else {
      val rgb = (v shr 8) and 0xFFFFFFL
      val a = v and 0xFFL
      ((a shl 24) or rgb).toInt()
    }
  }
}
