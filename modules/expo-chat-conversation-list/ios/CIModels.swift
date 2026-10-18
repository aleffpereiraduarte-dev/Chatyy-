import UIKit

// [2026-10-18 chat-info-native] Modelos da tela NATIVA "Dados do contato" /
// "Dados do grupo" (view ChatyyChatInfo). Mesmo contrato do Android
// (CIModels.kt). O JS (components/chat/NativeChatInfo.js) manda:
//   hero    {title, sub, tile {u, a, i, g}, badge ("camera"|""), busy,
//            actions [{key, icon, label, active}]}
//   rows    [{id, k, sid, hd, ft, title, sub, val, icon, dest, on, dis}]
//           k: "c" navega (seta) · "a" ação · "t" interruptor ·
//              "about" texto livre (recado/descrição) · "media" faixa de
//              miniaturas (prop `media`) · "members" âncora da lista de membros
//   media   [{key, u, a, video, dur}]
//   members {header, items [{id, title, sub, tile {u,a,i,g}, pill, me}],
//            total, hasMore, loading, search (placeholder; "" = sem busca),
//            empty, actions [{id, title, icon}]}
// Só desenha: toques voltam por id e o JS chama os MESMOS handlers da folha JS.

struct CIRow: Equatable {
  var id: String = ""
  var kind: String = "c"
  var sid: String = ""
  var header: String = ""
  var footer: String = ""
  var title: String = ""
  var sub: String = ""
  var value: String = ""
  var icon: String = ""
  var destructive = false
  var on = false
  var disabled = false

  init() {}

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    let k = CLVal.str(d["k"])
    kind = k.isEmpty ? "c" : k
    sid = CLVal.str(d["sid"])
    header = CLVal.str(d["hd"])
    footer = CLVal.str(d["ft"])
    title = CLVal.str(d["title"])
    sub = CLVal.str(d["sub"])
    value = CLVal.str(d["val"])
    icon = CLVal.str(d["icon"])
    destructive = CLVal.bool(d["dest"])
    on = CLVal.bool(d["on"])
    disabled = CLVal.bool(d["dis"])
  }
}

struct CIAction: Equatable {
  var key: String = ""
  var icon: String = ""
  var label: String = ""
  var active = false

  init(_ d: [String: Any]) {
    key = CLVal.str(d["key"])
    icon = CLVal.str(d["icon"])
    label = CLVal.str(d["label"])
    active = CLVal.bool(d["active"])
  }
}

/// Foto/iniciais de um avatar (mesmo formato do ladrilho da lista: u, a, i, g).
struct CIPic: Equatable {
  var url: String = ""
  var auth = false
  var initials: String = ""
  var grad: Int = 0

  init() {}

  init(_ v: Any?) {
    var d = v as? [String: Any]
    if d == nil, let arr = v as? [Any], let first = arr.first as? [String: Any] { d = first }
    guard let m = d else { return }
    url = CLVal.str(m["u"])
    auth = CLVal.bool(m["a"])
    initials = CLVal.str(m["i"])
    grad = CLVal.int(m["g"])
  }
}

struct CIHero: Equatable {
  var title: String = ""
  var sub: String = ""
  var pic = CIPic()
  var badge: String = ""
  var busy = false
  var actions: [CIAction] = []

  init() {}

  init(_ d: [String: Any]?) {
    guard let d = d else { return }
    title = CLVal.str(d["title"])
    sub = CLVal.str(d["sub"])
    pic = CIPic(d["tile"])
    badge = CLVal.str(d["badge"])
    busy = CLVal.bool(d["busy"])
    if let arr = d["actions"] as? [Any] {
      for x in arr {
        guard let m = x as? [String: Any] else { continue }
        let a = CIAction(m)
        if !a.key.isEmpty { actions.append(a) }
      }
    }
  }
}

struct CIMedia: Equatable {
  var key: String = ""
  var url: String = ""
  var auth = false
  var video = false
  var dur: String = ""

  init(_ d: [String: Any]) {
    key = CLVal.str(d["key"])
    url = CLVal.str(d["u"])
    auth = CLVal.bool(d["a"])
    video = CLVal.bool(d["video"])
    dur = CLVal.str(d["dur"])
  }
}

struct CIMember: Equatable {
  var id: String = ""
  var title: String = ""
  var sub: String = ""
  var pic = CIPic()
  var pill: String = ""
  var me = false

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    title = CLVal.str(d["title"])
    sub = CLVal.str(d["sub"])
    pic = CIPic(d["tile"])
    pill = CLVal.str(d["pill"])
    me = CLVal.bool(d["me"])
  }
}

struct CIMemberAction: Equatable {
  var id: String = ""
  var title: String = ""
  var icon: String = ""

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    title = CLVal.str(d["title"])
    icon = CLVal.str(d["icon"])
  }
}

struct CIMembers: Equatable {
  var header: String = ""
  var items: [CIMember] = []
  var total: Int = 0
  var hasMore = false
  var loading = false
  var search: String = ""
  var empty: String = ""
  var actions: [CIMemberAction] = []

  init() {}

  init(_ d: [String: Any]?) {
    guard let d = d else { return }
    header = CLVal.str(d["header"])
    total = CLVal.int(d["total"])
    hasMore = CLVal.bool(d["hasMore"])
    loading = CLVal.bool(d["loading"])
    search = CLVal.str(d["search"])
    empty = CLVal.str(d["empty"])
    var seen = Set<String>()
    if let arr = d["items"] as? [Any] {
      for x in arr {
        guard let m = x as? [String: Any] else { continue }
        let it = CIMember(m)
        if it.id.isEmpty || seen.contains(it.id) { continue }
        seen.insert(it.id)
        items.append(it)
      }
    }
    if let arr = d["actions"] as? [Any] {
      for x in arr {
        guard let m = x as? [String: Any] else { continue }
        let a = CIMemberAction(m)
        if !a.id.isEmpty { actions.append(a) }
      }
    }
  }
}

enum CIText {
  /// Ícone lógico do JS → SF Symbol (nil = linha sem ícone).
  static func symbol(_ name: String) -> String? {
    switch name {
    case "star": return "star"
    case "bell", "unmute": return "bell"
    case "bellOff", "mute": return "bell.slash"
    case "music": return "music.note"
    case "palette": return "paintpalette"
    case "image": return "photo"
    case "clock": return "timer"
    case "slow": return "tortoise"
    case "lock": return "lock"
    case "secret": return "lock.circle"
    case "shield": return "lock.shield"
    case "sparkles": return "sparkles"
    case "chart": return "chart.bar"
    case "calendar": return "calendar"
    case "globe": return "globe"
    case "mapPin": return "mappin.and.ellipse"
    case "pin": return "pin"
    case "share", "export": return "square.and.arrow.up"
    case "download": return "square.and.arrow.down"
    case "archive": return "archivebox"
    case "user": return "person.crop.circle"
    case "userPlus": return "person.badge.plus"
    case "users": return "person.2"
    case "link": return "link"
    case "qr": return "qrcode"
    case "search": return "magnifyingglass"
    case "trash": return "trash"
    case "block": return "hand.raised"
    case "flag": return "hand.thumbsdown"
    case "logout": return "rectangle.portrait.and.arrow.right"
    case "edit": return "pencil"
    case "eye": return "eye.slash"
    case "forward": return "arrowshape.turn.up.right"
    case "hash": return "number"
    case "info": return "info.circle"
    case "phone", "call": return "phone"
    case "video": return "video"
    case "camera": return "camera.fill"
    case "message": return "message"
    case "heart": return "heart"
    case "check": return "checkmark.seal"
    default: return nil
    }
  }

  static func image(_ name: String, size: CGFloat, weight: UIImage.SymbolWeight, color: UIColor) -> UIImage? {
    guard let sym = symbol(name) else { return nil }
    let cfg = UIImage.SymbolConfiguration(pointSize: size, weight: weight)
    return UIImage(systemName: sym, withConfiguration: cfg)?.withTintColor(color, renderingMode: .alwaysOriginal)
  }
}
