package expo.modules.chatyyconversationlist

// [2026-10-18 chat-info-native] Modelos da tela NATIVA "Dados do contato" /
// "Dados do grupo" (view ChatyyChatInfo). Mesmo contrato do iOS
// (ios/CIModels.swift):
//   hero    {title, sub, tile {u, a, i, g}, badge, busy, actions [{key, icon, label, active}]}
//   rows    [{id, k, sid, hd, ft, title, sub, val, icon, dest, on, dis}]
//           k: "c" navega · "a" ação · "t" interruptor · "about" · "media" · "members"
//   media   [{key, u, a, video, dur}]
//   members {header, items [{id, title, sub, tile, pill, me}], total, hasMore,
//            loading, search, empty, actions [{id, title, icon}]}
// Regra do projeto: try só em forma de statement (nunca try-expressão).

internal data class CIRow(
  val id: String = "",
  val kind: String = "c",
  val sid: String = "",
  val header: String = "",
  val footer: String = "",
  val title: String = "",
  val sub: String = "",
  val value: String = "",
  val icon: String = "",
  val destructive: Boolean = false,
  val on: Boolean = false,
  val disabled: Boolean = false
) {
  companion object {
    fun from(m: Map<String, Any?>): CIRow {
      val k = CLVal.str(m["k"])
      return CIRow(
        id = CLVal.str(m["id"]),
        kind = if (k.isEmpty()) "c" else k,
        sid = CLVal.str(m["sid"]),
        header = CLVal.str(m["hd"]),
        footer = CLVal.str(m["ft"]),
        title = CLVal.str(m["title"]),
        sub = CLVal.str(m["sub"]),
        value = CLVal.str(m["val"]),
        icon = CLVal.str(m["icon"]),
        destructive = CLVal.bool(m["dest"]),
        on = CLVal.bool(m["on"]),
        disabled = CLVal.bool(m["dis"])
      )
    }
  }
}

internal data class CIAction(
  val key: String = "",
  val icon: String = "",
  val label: String = "",
  val active: Boolean = false
) {
  companion object {
    fun from(m: Map<String, Any?>): CIAction = CIAction(
      key = CLVal.str(m["key"]),
      icon = CLVal.str(m["icon"]),
      label = CLVal.str(m["label"]),
      active = CLVal.bool(m["active"])
    )
  }
}

/** Foto/iniciais de um avatar (ladrilho u, a, i, g). */
internal data class CIPic(
  val url: String = "",
  val auth: Boolean = false,
  val initials: String = "",
  val grad: Int = 0
) {
  fun tile(): CLTile = CLTile(url, auth, initials, grad)

  companion object {
    fun from(v: Any?): CIPic {
      var m = CLVal.map(v)
      if (m == null) {
        val first = CLVal.list(v)?.firstOrNull()
        m = CLVal.map(first)
      }
      if (m == null) return CIPic()
      return CIPic(
        url = CLVal.str(m["u"]),
        auth = CLVal.bool(m["a"]),
        initials = CLVal.str(m["i"]),
        grad = CLVal.int(m["g"])
      )
    }
  }
}

internal data class CIHero(
  val title: String = "",
  val sub: String = "",
  val pic: CIPic = CIPic(),
  val badge: String = "",
  val busy: Boolean = false,
  val actions: List<CIAction> = emptyList()
) {
  companion object {
    fun from(m: Map<String, Any?>?): CIHero {
      if (m == null) return CIHero()
      val acts = ArrayList<CIAction>()
      CLVal.list(m["actions"])?.forEach { x ->
        val am = CLVal.map(x) ?: return@forEach
        val a = CIAction.from(am)
        if (a.key.isNotEmpty()) acts.add(a)
      }
      return CIHero(
        title = CLVal.str(m["title"]),
        sub = CLVal.str(m["sub"]),
        pic = CIPic.from(m["tile"]),
        badge = CLVal.str(m["badge"]),
        busy = CLVal.bool(m["busy"]),
        actions = acts
      )
    }
  }
}

internal data class CIMedia(
  val key: String = "",
  val url: String = "",
  val auth: Boolean = false,
  val video: Boolean = false,
  val dur: String = ""
) {
  companion object {
    fun from(m: Map<String, Any?>): CIMedia = CIMedia(
      key = CLVal.str(m["key"]),
      url = CLVal.str(m["u"]),
      auth = CLVal.bool(m["a"]),
      video = CLVal.bool(m["video"]),
      dur = CLVal.str(m["dur"])
    )
  }
}

internal data class CIMember(
  val id: String = "",
  val title: String = "",
  val sub: String = "",
  val pic: CIPic = CIPic(),
  val pill: String = "",
  val me: Boolean = false
) {
  companion object {
    fun from(m: Map<String, Any?>): CIMember = CIMember(
      id = CLVal.str(m["id"]),
      title = CLVal.str(m["title"]),
      sub = CLVal.str(m["sub"]),
      pic = CIPic.from(m["tile"]),
      pill = CLVal.str(m["pill"]),
      me = CLVal.bool(m["me"])
    )
  }
}

internal data class CIMemberAction(
  val id: String = "",
  val title: String = "",
  val icon: String = ""
) {
  companion object {
    fun from(m: Map<String, Any?>): CIMemberAction = CIMemberAction(
      id = CLVal.str(m["id"]),
      title = CLVal.str(m["title"]),
      icon = CLVal.str(m["icon"])
    )
  }
}

internal data class CIMembers(
  val header: String = "",
  val items: List<CIMember> = emptyList(),
  val total: Int = 0,
  val hasMore: Boolean = false,
  val loading: Boolean = false,
  val search: String = "",
  val empty: String = "",
  val actions: List<CIMemberAction> = emptyList()
) {
  companion object {
    fun from(m: Map<String, Any?>?): CIMembers {
      if (m == null) return CIMembers()
      val seen = HashSet<String>()
      val items = ArrayList<CIMember>()
      CLVal.list(m["items"])?.forEach { x ->
        val im = CLVal.map(x) ?: return@forEach
        val mem = CIMember.from(im)
        if (mem.id.isEmpty() || !seen.add(mem.id)) return@forEach
        items.add(mem)
      }
      val acts = ArrayList<CIMemberAction>()
      CLVal.list(m["actions"])?.forEach { x ->
        val am = CLVal.map(x) ?: return@forEach
        val a = CIMemberAction.from(am)
        if (a.id.isNotEmpty()) acts.add(a)
      }
      return CIMembers(
        header = CLVal.str(m["header"]),
        items = items,
        total = CLVal.int(m["total"]),
        hasMore = CLVal.bool(m["hasMore"]),
        loading = CLVal.bool(m["loading"]),
        search = CLVal.str(m["search"]),
        empty = CLVal.str(m["empty"]),
        actions = acts
      )
    }
  }
}

internal object CIText {
  /** Ícone lógico do JS → drawable de traço (0 = linha sem ícone). */
  fun drawable(name: String): Int = when (name) {
    "star" -> R.drawable.cct_ic_star
    "bell", "unmute" -> R.drawable.ccl_ic_bell
    "bellOff", "mute" -> R.drawable.ccl_ic_bell_off
    "music" -> R.drawable.ccl_ic_music
    "palette" -> R.drawable.cci_ic_palette
    "image" -> R.drawable.crl_ic_image
    "clock", "slow" -> R.drawable.ccl_ic_clock
    "lock", "secret" -> R.drawable.ccl_ic_lock
    "shield" -> R.drawable.cst_ic_shield
    "sparkles" -> R.drawable.ccl_ic_sparkles
    "chart" -> R.drawable.ccl_ic_chart
    "calendar" -> R.drawable.ccl_ic_calendar
    "globe" -> R.drawable.cst_ic_globe
    "mapPin" -> R.drawable.ccl_ic_map_pin
    "pin" -> R.drawable.ccl_ic_pin
    "share", "export", "forward" -> R.drawable.cci_ic_share
    "download" -> R.drawable.dv_ic_download
    "archive" -> R.drawable.ccl_ic_archive
    "user" -> R.drawable.ccl_ic_user
    "userPlus" -> R.drawable.cct_ic_user_plus
    "users" -> R.drawable.dv_ic_users
    "link" -> R.drawable.crl_ic_link
    "qr" -> R.drawable.cci_ic_qr
    "search" -> R.drawable.cst_ic_search
    "trash" -> R.drawable.ccl_ic_trash
    "block" -> R.drawable.ccl_ic_ban
    "flag" -> R.drawable.cci_ic_flag
    "logout" -> R.drawable.cci_ic_logout
    "edit" -> R.drawable.dv_ic_edit
    "eye" -> R.drawable.dv_ic_eye
    "hash" -> R.drawable.crl_ic_hash
    "info" -> R.drawable.ckl_ic_info
    "phone", "call" -> R.drawable.ccl_ic_phone
    "video" -> R.drawable.ccl_ic_video
    "camera" -> R.drawable.ccl_ic_camera
    "message" -> R.drawable.ccl_ic_message
    "heart" -> R.drawable.crl_ic_heart
    "check" -> R.drawable.ccl_ic_check
    else -> 0
  }
}
