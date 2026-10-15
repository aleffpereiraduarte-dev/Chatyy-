import Foundation

/// [2026-10-15 native-store fase 2b] Frames do hub → lote do store, SEM JS.
/// Espelho de StoreIngest.kt (lá roda na JVM contra frames reais do hub — mesma
/// lógica aqui). Puro (Foundation): nenhuma chamada de SQLite.
///
/// Frames: chat_message / chat_summary / edit / delete / reaction {type, data:<linha>}
///         chat_read {data:{conversation_id, email, last_read_id}}
///         chat_delivered {data:{conversation_id, email, delivered_at, message_ids[]}}
public enum ChatyyStoreIngest {
  private static let needles = [
    "\"type\":\"chat_message\"", "\"type\":\"chat_summary\"", "\"type\":\"edit\"", "\"type\":\"delete\"",
    "\"type\":\"reaction\"", "\"type\":\"chat_read\"", "\"type\":\"chat_delivered\"",
  ]
  private static let msgTypes: Set<String> = ["chat_message", "chat_summary", "edit", "delete", "reaction"]

  /// Pré-filtro barato no texto cru (sem parse).
  public static func wants(_ text: String) -> Bool {
    if text.utf8.count < 24 { return false }
    for n in needles where text.contains(n) { return true }
    return false
  }

  static func isBool(_ v: Any?) -> Bool {
    guard let n = v as? NSNumber else { return false }
    return CFGetTypeID(n) == CFBooleanGetTypeID()
  }

  static func str(_ v: Any?) -> String {
    if v == nil || v is NSNull { return "" }
    if let s = v as? String { return s }
    if let n = v as? NSNumber {
      if isBool(n) { return n.boolValue ? "true" : "false" }
      if CFNumberIsFloatType(n) {
        let d = n.doubleValue
        if d == d.rounded() && abs(d) < 9e15 { return String(Int64(d)) }
        return String(d)
      }
      return n.stringValue
    }
    return "\(v!)"
  }

  static func lng(_ v: Any?) -> Int64 {
    if let n = v as? NSNumber { return n.int64Value }
    if let s = v as? String { return Int64(s) ?? Int64(Double(s) ?? 0) }
    return 0
  }

  static func truthy(_ v: Any?) -> Bool {
    if v == nil || v is NSNull { return false }
    if let n = v as? NSNumber { return n.doubleValue != 0 }
    if let s = v as? String { return !(s.isEmpty || s == "0" || s == "false" || s == "[]" || s == "null") }
    if let a = v as? [Any] { return !a.isEmpty }
    if let d = v as? [String: Any] { return !d.isEmpty }
    return true
  }

  private static let isoRe = try! NSRegularExpression(pattern: "^(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?\\s*(Z|[+-]\\d{2}(?::?\\d{2})?)?$")

  /// Data do servidor → epoch ms (mesma regra do _ms do JS: sem fuso = UTC). 0 = inválida.
  public static func ms(_ v: Any?) -> Int64 {
    if v == nil || v is NSNull { return 0 }
    if let n = v as? NSNumber, !isBool(n) { let d = n.doubleValue; return d > 1e12 ? Int64(d) : Int64(d * 1000) }
    let s = str(v).trimmingCharacters(in: .whitespaces)
    if s.isEmpty { return 0 }
    let ns = s as NSString
    guard let m = isoRe.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return 0 }
    func g(_ i: Int) -> String { let r = m.range(at: i); return r.location == NSNotFound ? "" : ns.substring(with: r) }
    let y = Int64(g(1)) ?? 0, mo = Int64(g(2)) ?? 0, d = Int64(g(3)) ?? 0
    let hh = Int64(g(4)) ?? 0, mi = Int64(g(5)) ?? 0, ss = Int64(g(6)) ?? 0
    let fr = g(7)
    let frac: Int64 = fr.isEmpty ? 0 : (Int64(String((fr + "00").prefix(3))) ?? 0)
    var offMin: Int64 = 0
    let tz = g(8)
    if !tz.isEmpty && tz != "Z" {
      let sign: Int64 = tz.hasPrefix("-") ? -1 : 1
      let digits = String(tz.dropFirst()).replacingOccurrences(of: ":", with: "")
      let oh = Int64(String(digits.prefix(2))) ?? 0
      let om: Int64 = digits.count >= 4 ? (Int64(String(digits.dropFirst(2).prefix(2))) ?? 0) : 0
      offMin = sign * (oh * 60 + om)
    }
    // dias desde 1970-01-01 (algoritmo civil de H. Hinnant)
    let yy = mo <= 2 ? y - 1 : y
    let era = (yy >= 0 ? yy : yy - 399) / 400
    let yoe = yy - era * 400
    let mp = (mo + 9) % 12
    let doy = (153 * mp + 2) / 5 + d - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    let days = era * 146097 + doe - 719468
    return ((days * 86400 + hh * 3600 + mi * 60 + ss) - offMin * 60) * 1000 + frac
  }

  /// Mesma chave do msgKeyExtractor/defaultKeyOf do JS.
  public static func keyOf(_ m: [String: Any]) -> String {
    var cl = str(m["client_message_id"]); if cl.isEmpty { cl = str(m["_client_id"]) }
    let del = truthy(m["deleted_at"])
    if !cl.isEmpty { return del ? "c:\(cl)_d" : "c:\(cl)" }
    let id = str(m["id"])
    return del ? "\(id)_d" : id
  }

  private static func msgOf(_ o: [String: Any]) -> [String: Any]? {
    guard let d = o["data"] as? [String: Any] else { return nil }
    return (d["message"] as? [String: Any]) ?? d
  }

  static func jsonString(_ o: Any) -> String? {
    guard JSONSerialization.isValidJSONObject(o), let d = try? JSONSerialization.data(withJSONObject: o) else { return nil }
    return String(data: d, encoding: .utf8)
  }

  /// frames → lote (formato do applyBatch + chaves internas do 2b). nil = nada.
  public static func translate(me: String, frames: [String]) -> [String: Any]? {
    var order: [String] = []
    var msgs: [String: [String: Any]] = [:]
    var kinds: [String: String] = [:]
    var peerReads: [String: [String: Any]] = [:]
    var selfReads: [String: Int64] = [:]
    var delivs: [[String: Any]] = []
    var convTypes: [String: String] = [:]
    for f in frames {
      guard let data = f.data(using: .utf8),
            let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
      let type = str(o["type"])
      if msgTypes.contains(type) {
        guard let m = msgOf(o) else { continue }
        var conv = str(m["conversation_id"])
        if conv.isEmpty { conv = str((o["data"] as? [String: Any])?["conversation_id"]) }
        let id = lng(m["id"])
        if conv.isEmpty || id <= 0 { continue }
        let k = "\(conv)|\(id)"
        if let i = order.firstIndex(of: k) { order.remove(at: i) }
        order.append(k); msgs[k] = m
        // "new" (chegou nesta leva) vence "upd"
        kinds[k] = (type == "chat_message" || type == "chat_summary") ? "new" : (kinds[k] ?? "upd")
        let ct = str(m["conversation_type"])
        if !ct.isEmpty { convTypes[conv] = ct }
      } else if type == "chat_read" {
        guard let d = o["data"] as? [String: Any] else { continue }
        let conv = str(d["conversation_id"]); let upTo = lng(d["last_read_id"])
        let email = str(d["email"]).trimmingCharacters(in: .whitespaces).lowercased()
        if conv.isEmpty || upTo <= 0 || email.isEmpty { continue }
        if email == me { selfReads[conv] = max(selfReads[conv] ?? 0, upTo) }
        else {
          let k = "\(conv)|\(email)"
          if lng(peerReads[k]?["upTo"]) < upTo { peerReads[k] = ["conv": conv, "email": email, "upTo": NSNumber(value: upTo)] }
        }
      } else if type == "chat_delivered" {
        guard let d = o["data"] as? [String: Any] else { continue }
        let conv = str(d["conversation_id"])
        let email = str(d["email"]).trimmingCharacters(in: .whitespaces).lowercased()
        if conv.isEmpty || email.isEmpty || email == me { continue }
        var ids: [NSNumber] = []
        for x in (d["message_ids"] as? [Any]) ?? [] { let v = lng(x); if v > 0 { ids.append(NSNumber(value: v)) } }
        if ids.isEmpty { let v = lng(d["message_id"]); if v > 0 { ids.append(NSNumber(value: v)) } }
        if ids.isEmpty { continue }
        var at = ms(d["delivered_at"]); if at <= 0 { at = Int64(Date().timeIntervalSince1970 * 1000) }
        delivs.append(["conv": conv, "ids": ids, "at": NSNumber(value: at)])
      }
    }
    if msgs.isEmpty && peerReads.isEmpty && selfReads.isEmpty && delivs.isEmpty { return nil }
    var out: [String: Any] = ["v": 1, "src": "native"]
    var messages: [[String: Any]] = [], receipts: [[String: Any]] = [], reactions: [[String: Any]] = [], touch: [[String: Any]] = []
    for k in order {
      guard let m = msgs[k] else { continue }
      let conv = String(k.split(separator: "|", maxSplits: 1).first ?? "")
      let id = lng(m["id"])
      var cl = str(m["client_message_id"]); if cl.isEmpty { cl = str(m["_client_id"]) }
      var type = str(m["type"]); if type.isEmpty { type = "text" }
      messages.append([
        "conv": conv, "id": NSNumber(value: id), "ckey": cl.isEmpty ? String(id) : "c:\(cl)", "client_id": cl,
        "sender": str(m["sender_email"]).lowercased(), "type": type,
        "created_at": NSNumber(value: ms(m["created_at"])), "edited_at": NSNumber(value: ms(m["edited_at"])),
        "deleted": NSNumber(value: truthy(m["deleted_at"]) ? 1 : 0), "reply_to": NSNumber(value: lng(m["reply_to_id"])),
        "raw": jsonString(m) ?? "{}",
      ])
      let dl = ms(m["delivered_at"]), rd = ms(m["read_at"])
      if dl > 0 || rd > 0 { receipts.append(["conv": conv, "msg_id": NSNumber(value: id), "delivered_at": NSNumber(value: dl), "read_at": NSNumber(value: rd)]) }
      if let rx = m["reactions"] as? [Any] {
        var set: [[String: Any]] = []
        for x in rx {
          guard let r = x as? [String: Any] else { continue }
          var emoji = str(r["emoji"]); if emoji.isEmpty { emoji = str(r["reaction"]) }
          if emoji.isEmpty { continue }
          var users: [String] = []
          if let u = r["users"] as? [Any] { for e in u { let s = str(e).lowercased(); if !s.isEmpty { users.append(s) } } }
          else if let u = r["users"] as? String { for e in u.split(separator: ",") { let s = e.trimmingCharacters(in: .whitespaces).lowercased(); if !s.isEmpty { users.append(s) } } }
          set.append(["emoji": emoji, "users": users])
        }
        reactions.append(["conv": conv, "msg_id": NSNumber(value: id), "set": set])
      }
      touch.append(["conv": conv, "id": NSNumber(value: id), "kind": kinds[k] ?? "upd", "msg": m])
    }
    if !messages.isEmpty { out["messages"] = messages }
    if !receipts.isEmpty { out["receipts"] = receipts }
    if !reactions.isEmpty { out["reactions"] = reactions }
    if !touch.isEmpty { out["touch"] = touch }
    if !peerReads.isEmpty { out["peer_reads"] = Array(peerReads.values) }
    if !selfReads.isEmpty { out["self_reads"] = selfReads.map { ["conv": $0.key, "upTo": NSNumber(value: $0.value)] as [String: Any] } }
    if !delivs.isEmpty { out["delivs"] = delivs }
    if !convTypes.isEmpty { out["conv_types"] = convTypes }
    return out
  }

  // ─── RowBuilder nativo SÓ p/ texto simples (flag do JS; padrão desligado) ──

  public struct TextProfile {
    let rev: String, me: String, group: Bool, h24: Bool, am: String, pm: String, join: String
    let today: String, todayLabel: String, gapMs: Int64
    let allow: NSRegularExpression?, deny: NSRegularExpression?
    let ok: Bool

    init(_ o: [String: Any]) {
      rev = ChatyyStoreIngest.str(o["rev"]); me = ChatyyStoreIngest.str(o["me"]).lowercased(); group = ChatyyStoreIngest.lng(o["group"]) != 0; h24 = ChatyyStoreIngest.lng(o["h24"]) != 0
      am = ChatyyStoreIngest.str(o["am"]); pm = ChatyyStoreIngest.str(o["pm"]); join = ChatyyStoreIngest.str(o["join"])
      today = ChatyyStoreIngest.str(o["today"]); todayLabel = ChatyyStoreIngest.str(o["todayLabel"])
      let g = ChatyyStoreIngest.lng(o["gapMs"]); gapMs = g > 0 ? g : 60000
      let a = ChatyyStoreIngest.str(o["allow"]); let d = ChatyyStoreIngest.str(o["deny"])
      allow = a.isEmpty ? nil : (try? NSRegularExpression(pattern: a))
      deny = d.isEmpty ? nil : (try? NSRegularExpression(pattern: d, options: [.caseInsensitive]))
      ok = !rev.isEmpty && !me.isEmpty && !today.isEmpty && allow != nil && (h24 || (!am.isEmpty && !pm.isEmpty))
    }
  }

  public struct Tail { let k: String; let id: Int64; let sender: String; let ts: Int64; let type: String; let day: String }

  /// "AAAA-M0-D" local (mesmo formato do _dayKey do JS: mês 0-based, sem zero à esquerda).
  public static func dayKey(_ ts: Int64) -> String {
    let c = Calendar.current.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: Double(ts) / 1000))
    return "\(c.year ?? 0)-\((c.month ?? 1) - 1)-\(c.day ?? 0)"
  }

  static func timeLabel(_ p: TextProfile, _ ts: Int64) -> String {
    let c = Calendar.current.dateComponents([.hour, .minute], from: Date(timeIntervalSince1970: Double(ts) / 1000))
    let h = c.hour ?? 0, m = c.minute ?? 0
    let mm = m < 10 ? "0\(m)" : "\(m)"
    if p.h24 { return (h < 10 ? "0\(h)" : "\(h)") + ":" + mm }
    let h12 = h % 12 == 0 ? 12 : h % 12
    return (h12 < 10 ? "0\(h12)" : "\(h12)") + ":" + mm + p.join + (h < 12 ? p.am : p.pm)
  }

  private static func fullMatch(_ re: NSRegularExpression, _ s: String) -> Bool {
    let n = (s as NSString).length
    guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: n)) else { return false }
    return m.range.location == 0 && m.range.length == n
  }

  /// Por que NÃO montar no nativo ("" = pode). Conservador.
  static func textReason(_ p: TextProfile, _ m: [String: Any]) -> String {
    if !p.ok { return "profile" }
    if p.group { return "group" }
    var type = str(m["type"]); if type.isEmpty { type = "text" }
    if type != "text" { return "type" }
    let ct = str(m["conversation_type"])
    if !ct.isEmpty && ct != "direct" { return "convtype" }
    for f in ["deleted_at", "edited_at", "reply_to_id", "reply_to", "forwarded_from", "mentions", "link_preview",
              "expires_at", "effect", "topic_id", "starred", "sealed", "is_view_once", "is_poll", "file_url", "pinned", "_failed", "translation"] {
      if truthy(m[f]) { return "field:\(f)" }
    }
    if truthy(m["edited"]) { return "edited" }
    if let rx = m["reactions"] as? [Any], !rx.isEmpty { return "reactions" }
    let c = trimEnd(str(m["content"]))
    if c.isEmpty || (c as NSString).length > 500 { return "len" }
    guard let allow = p.allow, fullMatch(allow, c) else { return "allow" }
    if let deny = p.deny, deny.firstMatch(in: c, range: NSRange(location: 0, length: (c as NSString).length)) != nil { return "deny" }
    return ""
  }

  static func trimEnd(_ s: String) -> String {
    var t = s
    while let l = t.last, l.isWhitespace { t.removeLast() }
    return t
  }

  /// Operações na foto p/ UMA mensagem nova de texto simples (nil = não monta).
  static func textOps(_ p: TextProfile, _ m: [String: Any], _ tail: Tail, _ nowDay: String) -> [[String: Any]]? {
    if textReason(p, m) != "" { return nil }
    if p.today != nowDay { return nil }
    let id = lng(m["id"]); if id <= tail.id { return nil }
    let ts = ms(m["created_at"]); if ts <= 0 { return nil }
    let day = dayKey(ts)
    let sender = str(m["sender_email"]).lowercased()
    let own = sender == p.me
    var rows: [[String: Any]] = []
    var ops: [[String: Any]] = []
    if day != tail.day {
      if day != nowDay || p.todayLabel.isEmpty { return nil }
      rows.append(["k": "sep-\(day)", "kind": "date", "text": p.todayLabel])
    }
    let gap = ts - tail.ts
    let grouped = day == tail.day && !tail.sender.isEmpty && tail.sender == sender && tail.type != "system" && tail.ts > 0 && gap >= 0 && gap <= p.gapMs
    if grouped { ops.append(["op": "set", "k": tail.k, "set": ["last": 0]]) }
    var row: [String: Any] = [
      "k": keyOf(m), "kind": "msg", "id": String(id), "own": own ? 1 : 0, "first": grouped ? 0 : 1, "last": 1,
      "time": timeLabel(p, ts), "text": trimEnd(str(m["content"])),
    ]
    if own { row["st"] = 1 }
    rows.append(row)
    ops.append(["op": "append", "after": tail.k, "rows": rows])
    return ops
  }
}
