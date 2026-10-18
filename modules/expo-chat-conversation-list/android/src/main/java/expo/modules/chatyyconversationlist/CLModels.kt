package expo.modules.chatyyconversationlist

// [2026-10-14 native-home] Modelos da lista de conversas nativa (Android).
// Espelha ios/CLModels.swift: o JS (components/chatlist/nativeAdapter.js)
// manda as linhas já normalizadas; aqui só lemos o Map da ponte.
// Regra do projeto: try só em forma de statement (nunca try-expressão).

import android.graphics.Color

internal object CLVal {
  fun str(v: Any?): String {
    if (v is String) return v
    if (v is Double) {
      if (v == Math.floor(v) && Math.abs(v) < 9.2e18) return v.toLong().toString() // ids Snowflake até 2^53-1 (era < 1e15 → "9.0E15")
      return v.toString()
    }
    if (v is Number) return v.toString()
    return ""
  }

  fun bool(v: Any?): Boolean {
    if (v is Boolean) return v
    if (v is Number) return v.toDouble() != 0.0
    if (v is String) return v == "1" || v == "true"
    return false
  }

  fun int(v: Any?): Int {
    if (v is Number) {
      val d = v.toDouble()
      if (d.isNaN() || d.isInfinite()) return 0
      return d.coerceIn(-1e9, 1e9).toInt()
    }
    if (v is String) return v.toIntOrNull() ?: 0
    return 0
  }

  fun double(v: Any?): Double {
    if (v is Number) return v.toDouble()
    if (v is String) return v.toDoubleOrNull() ?: 0.0
    return 0.0
  }

  @Suppress("UNCHECKED_CAST")
  fun map(v: Any?): Map<String, Any?>? = v as? Map<String, Any?>

  fun list(v: Any?): List<Any?>? = v as? List<Any?>
}

internal data class CLTile(
  val url: String,
  val auth: Boolean,
  val initials: String,
  val grad: Int
) {
  companion object {
    fun from(m: Map<String, Any?>): CLTile = CLTile(
      url = CLVal.str(m["u"]),
      auth = CLVal.bool(m["a"]),
      initials = CLVal.str(m["i"]),
      grad = CLVal.int(m["g"])
    )
  }
}

internal data class CLRow(
  val id: String = "",
  val kind: String = "direct",
  val title: String = "",
  val unread: Int = 0,
  val mention: Boolean = false,
  val pinned: Boolean = false,
  val muted: Boolean = false,
  val archived: Boolean = false,
  val locked: Boolean = false,
  val online: Boolean = false,
  val activity: String = "",
  val time: String = "",
  val timeBold: Boolean = false,
  val sender: String = "",
  val text: String = "",
  val icon: String = "",
  val receipt: Int = 0,
  val scheduled: Boolean = false,
  val pending: Boolean = false, // [2026-10-17] na fila sem rede → relógio (receipt 0)
  val failed: Boolean = false, // [2026-10-18] última enviada falhou → "!" vermelho (receipt 0)
  val typing: String = "",
  val draft: String = "",
  val draftLabel: String = "",
  val draftFresh: Boolean = false,
  val draftAge: String = "",
  val note: String = "",
  val ring: String = "",
  val tiles: List<CLTile> = emptyList(),
  val selected: Boolean = false,
  val a11y: String = "",
  val empty: String = "",
  val lockOn: Boolean = false,
  val blockLabel: String = "",
  val smart: Boolean = false
) {
  val isGroupish: Boolean get() = kind == "group" || kind == "channel"
  val tilesKey: String get() = kind + "|" + tiles.joinToString("|") { "${it.url}#${it.initials}#${it.grad}" }

  companion object {
    fun from(m: Map<String, Any?>): CLRow {
      val tiles = ArrayList<CLTile>()
      CLVal.list(m["tiles"])?.forEach { t -> CLVal.map(t)?.let { tiles.add(CLTile.from(it)) } }
      val kind = CLVal.str(m["kind"]).ifEmpty { "direct" }
      return CLRow(
        id = CLVal.str(m["id"]),
        kind = kind,
        title = CLVal.str(m["title"]),
        unread = CLVal.int(m["unread"]),
        mention = CLVal.bool(m["mention"]),
        pinned = CLVal.bool(m["pinned"]),
        muted = CLVal.bool(m["muted"]),
        archived = CLVal.bool(m["archived"]),
        locked = CLVal.bool(m["locked"]),
        online = CLVal.bool(m["online"]),
        activity = CLVal.str(m["activity"]),
        time = CLVal.str(m["time"]),
        timeBold = CLVal.bool(m["timeBold"]),
        sender = CLVal.str(m["sender"]),
        text = CLVal.str(m["text"]),
        icon = CLVal.str(m["icon"]),
        receipt = CLVal.int(m["receipt"]),
        scheduled = CLVal.bool(m["scheduled"]),
        pending = CLVal.bool(m["pending"]),
        failed = CLVal.bool(m["failed"]),
        typing = CLVal.str(m["typing"]),
        draft = CLVal.str(m["draft"]),
        draftLabel = CLVal.str(m["draftLabel"]),
        draftFresh = CLVal.bool(m["draftFresh"]),
        draftAge = CLVal.str(m["draftAge"]),
        note = CLVal.str(m["note"]),
        ring = CLVal.str(m["ring"]),
        tiles = tiles,
        selected = CLVal.bool(m["selected"]),
        a11y = CLVal.str(m["a11y"]),
        empty = CLVal.str(m["empty"]),
        lockOn = CLVal.bool(m["lockOn"]),
        blockLabel = CLVal.str(m["blockLabel"]),
        smart = CLVal.bool(m["smart"])
      )
    }
  }
}

/** Lista do usuário (submenu "Adicionar à lista"). */
internal data class CLFolder(val id: String, val name: String, val ids: Set<String>) {
  companion object {
    fun from(m: Map<String, Any?>): CLFolder = CLFolder(
      id = CLVal.str(m["id"]),
      name = CLVal.str(m["name"]),
      ids = (CLVal.list(m["ids"]) ?: emptyList()).map { CLVal.str(it) }.toSet()
    )
  }
}

internal class CLLabels(src: Map<String, Any?>? = null) {
  private val dict = HashMap<String, String>()

  init {
    src?.forEach { (k, v) -> if (v is String && v.isNotEmpty()) dict[k] = v }
  }

  fun get(key: String, fallback: String): String = dict[key] ?: fallback
  fun has(key: String): Boolean = dict.containsKey(key)
}

/** Paleta P&B — espelha LP_LIGHT / LP_DARK do ChatListTab.js. */
internal class CLTheme(val dark: Boolean) {
  val bg: Int
  val text: Int
  val sub: Int
  val subStrong: Int
  val faint: Int
  val icon: Int
  val press: Int
  val pinnedBg: Int
  val pillBg: Int
  val pillTxt: Int
  val mutedPillBg: Int
  val mutedPillTxt: Int
  val card: Int
  val selectedBg: Int
  val checkBorder: Int
  val receiptSent: Int
  val receiptGray: Int
  val receiptRead: Int = Color.parseColor("#53BDEB")
  val danger: Int = if (dark) Color.parseColor("#FF453A") else Color.parseColor("#FF3B30")
  val ringHot: Int
  val ringCold: Int
  val online: Int = Color.parseColor("#22C55E")

  init {
    if (dark) {
      bg = Color.parseColor("#0B0B0B")
      text = Color.parseColor("#F5F5F5")
      sub = Color.parseColor("#8E8E93")
      subStrong = Color.parseColor("#E5E5EA")
      faint = Color.parseColor("#636366")
      icon = Color.argb(107, 255, 255, 255)
      press = Color.argb(20, 255, 255, 255)
      pinnedBg = Color.parseColor("#111111")
      pillBg = Color.parseColor("#F5F5F5")
      pillTxt = Color.parseColor("#0B0B0B")
      mutedPillBg = Color.parseColor("#3A3A3C")
      mutedPillTxt = Color.parseColor("#D1D1D6")
      card = Color.parseColor("#1C1C1E")
      selectedBg = Color.parseColor("#232323")
      checkBorder = Color.argb(77, 255, 255, 255)
      receiptSent = Color.argb(89, 255, 255, 255)
      receiptGray = Color.argb(140, 255, 255, 255)
      ringHot = Color.WHITE
      ringCold = Color.argb(82, 255, 255, 255)
    } else {
      bg = Color.WHITE
      text = Color.parseColor("#0B0B0B")
      sub = Color.parseColor("#737373")
      subStrong = Color.parseColor("#262626")
      faint = Color.parseColor("#A3A3A3")
      icon = Color.argb(97, 0, 0, 0)
      press = Color.argb(18, 0, 0, 0)
      pinnedBg = Color.parseColor("#FAFAFA")
      pillBg = Color.parseColor("#0B0B0B")
      pillTxt = Color.WHITE
      mutedPillBg = Color.parseColor("#E5E5EA")
      mutedPillTxt = Color.parseColor("#48484A")
      card = Color.parseColor("#F5F5F5")
      selectedBg = Color.parseColor("#F0F0F0")
      checkBorder = Color.argb(64, 0, 0, 0)
      receiptSent = Color.argb(77, 0, 0, 0)
      receiptGray = Color.argb(115, 0, 0, 0)
      ringHot = Color.parseColor("#111111")
      ringCold = Color.argb(64, 0, 0, 0)
    }
  }

  companion object {
    /** Mesmos 8 pares cinza do AvatarCircle.js. */
    private val GRADIENTS = arrayOf(
      intArrayOf(0x5C5C5C, 0x333333),
      intArrayOf(0x636363, 0x3A3A3A),
      intArrayOf(0x545454, 0x2C2C2C),
      intArrayOf(0x6A6A6A, 0x404040),
      intArrayOf(0x4D4D4D, 0x262626),
      intArrayOf(0x5F5F5F, 0x363636),
      intArrayOf(0x575757, 0x303030),
      intArrayOf(0x666666, 0x3D3D3D)
    )

    fun gradient(i: Int): IntArray {
      val n = GRADIENTS.size
      val g = GRADIENTS[((i % n) + n) % n]
      return intArrayOf(0xFF000000.toInt() or g[0], 0xFF000000.toInt() or g[1])
    }

    // Botões de swipe (SWIPE_C do JS): cinzas + vermelho só no destrutivo.
    val SWIPE_READ = Color.parseColor("#1C1C1E")
    val SWIPE_ARCHIVE = Color.parseColor("#3A3A3C")
    val SWIPE_DELETE = Color.parseColor("#FF3B30")
  }
}

/** Glifo da prévia → vetor (mesmos traços dos SVG do app). */
internal object CLIcons {
  fun preview(icon: String): Int = when (icon) {
    "camera" -> R.drawable.ccl_ic_camera
    "video", "videoMissed" -> R.drawable.ccl_ic_video
    "phone", "phoneMissed" -> R.drawable.ccl_ic_phone
    "mic" -> R.drawable.ccl_ic_mic
    "paperclip" -> R.drawable.ccl_ic_paperclip
    "film" -> R.drawable.ccl_ic_film
    "music" -> R.drawable.ccl_ic_music
    "pin" -> R.drawable.ccl_ic_map_pin
    "user" -> R.drawable.ccl_ic_user
    "chart" -> R.drawable.ccl_ic_chart
    "calendar" -> R.drawable.ccl_ic_calendar
    "sticker" -> R.drawable.ccl_ic_sticker
    "file" -> R.drawable.ccl_ic_file
    "lock" -> R.drawable.ccl_ic_lock
    "gift" -> R.drawable.ccl_ic_gift
    "ban" -> R.drawable.ccl_ic_ban // [wave13-C] mensagem apagada (⊘)
    else -> 0
  }
}
