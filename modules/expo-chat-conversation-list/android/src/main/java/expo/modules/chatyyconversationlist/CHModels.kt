package expo.modules.chatyyconversationlist

// [2026-10-15 native-social] Aba CANAIS em nativo (Android) — modelos.
// Mesmo contrato do iOS (ios/CHModels.swift).
// JS: components/channels/NativeChannelList.js / NativeChannelFeed.js

import android.graphics.Color

internal class CHReaction(val emoji: String, val count: Int)

internal data class CHRow(
  val id: String = "",
  val kind: String = "row",          // row | card | post
  val title: String = "",
  val sub: String = "",
  val time: String = "",
  val meta: String = "",
  val desc: String = "",
  val badge: String = "",
  val member: Boolean = false,
  val verified: Boolean = false,
  val unread: Int = 0,
  val a11y: String = "",
  val tileUrl: String = "",
  val tileAuth: Boolean = false,
  val tileInitials: String = "",
  val tileGrad: Int = 0,
  val text: String = "",
  val views: String = "",
  val mediaUrl: String = "",
  val mediaKind: String = "",
  val rx: String = "",
  val mine: String = "",
  val quick: Boolean = false
) {
  val reactions: List<CHReaction> by lazy {
    if (rx.isEmpty()) emptyList() else rx.split('\u001E').mapNotNull { rec ->
      val i = rec.indexOf('\u001F')
      if (i <= 0) return@mapNotNull null
      val e = rec.substring(0, i)
      val c = rec.substring(i + 1).toIntOrNull() ?: 0
      if (e.isEmpty() || c <= 0) null else CHReaction(e, c)
    }
  }

  val hasMedia: Boolean get() = mediaUrl.isNotEmpty() && (mediaKind == "image" || mediaKind == "video")

  companion object {
    fun from(m: Map<String, Any?>): CHRow = CHRow(
      id = CLVal.str(m["id"]),
      kind = CLVal.str(m["kind"]).ifEmpty { "row" },
      title = CLVal.str(m["title"]),
      sub = CLVal.str(m["sub"]),
      time = CLVal.str(m["time"]),
      meta = CLVal.str(m["meta"]),
      desc = CLVal.str(m["desc"]),
      badge = CLVal.str(m["badge"]),
      member = CLVal.bool(m["member"]),
      verified = CLVal.bool(m["ver"]),
      unread = CLVal.int(m["unread"]),
      a11y = CLVal.str(m["a11y"]),
      tileUrl = CLVal.str(m["tu"]),
      tileAuth = CLVal.bool(m["ta"]),
      tileInitials = CLVal.str(m["ti"]),
      tileGrad = CLVal.int(m["tg"]),
      text = CLVal.str(m["text"]),
      views = CLVal.str(m["views"]),
      mediaUrl = CLVal.str(m["mu"]),
      mediaKind = CLVal.str(m["mk"]),
      rx = CLVal.str(m["rx"]),
      mine = CLVal.str(m["mine"]),
      quick = CLVal.bool(m["q"])
    )
  }
}

/** Cores P&B (fallback; o JS manda `palette` com as do tema). */
internal class CHPalette(val dark: Boolean, m: Map<String, Any?>? = null) {
  var bg: Int
  var card: Int
  var text: Int
  var sub: Int
  var pill: Int
  var line: Int
  val ink: Int
  val inkText: Int
  val press: Int
  val mineChip: Int

  init {
    if (dark) {
      bg = Color.BLACK
      card = Color.parseColor("#1C1C1E")
      text = Color.parseColor("#F5F5F7")
      sub = Color.parseColor("#8E8E93")
      pill = Color.parseColor("#1A1A24")
      line = Color.argb(15, 255, 255, 255)
      ink = Color.parseColor("#F5F5F7")
      inkText = Color.parseColor("#111111")
      press = Color.argb(20, 255, 255, 255)
      mineChip = Color.argb(36, 255, 255, 255)
    } else {
      bg = Color.WHITE
      card = Color.WHITE
      text = Color.parseColor("#111111")
      sub = Color.parseColor("#737373")
      pill = Color.parseColor("#F0F0F5")
      line = Color.argb(15, 0, 0, 0)
      ink = Color.parseColor("#111111")
      inkText = Color.WHITE
      press = Color.argb(13, 0, 0, 0)
      mineChip = Color.argb(20, 17, 17, 17)
    }
    if (m != null) {
      SLColor.parse(CLVal.str(m["bg"]))?.let { bg = it }
      SLColor.parse(CLVal.str(m["card"]))?.let { card = it }
      SLColor.parse(CLVal.str(m["text"]))?.let { text = it }
      SLColor.parse(CLVal.str(m["sub"]))?.let { sub = it }
      SLColor.parse(CLVal.str(m["pill"]))?.let { pill = it }
      SLColor.parse(CLVal.str(m["line"]))?.let { line = it }
    }
  }
}
