import ExpoModulesCore
import Foundation
import Network
import ImageIO
import UIKit
#if canImport(WidgetKit)
import WidgetKit
#endif

// [2026-10-09 system-integration] OS-integration bridge (JS: services/systemIntegration.js).
//
//   setConversations(items, opts) → App Group snapshot read by:
//       • App Intents / Siri / Atalhos (ChatyyAppIntents.swift in the app target,
//         plugins/with-system-intents.js) — key chatyy.system_conversations
//       • the home-screen widget extension (plugins/with-chatyy-widgets.js)
//       • the NSE Focus-filter tag (pinned ids) — key chatyy.pinned_conversation_ids
//     then reloads widget timelines + refreshes Siri's parameterized phrases.
//   getNetworkConstraints()  → { constrained (Low Data Mode), expensive, satisfied }
//     + "onNetworkConstraints" event on change (NWPathMonitor).
//   getFocusFilter()         → last ChatyyFocusFilter values (App Group) or null.
//   clear()                  → logout wipe.
//
// Everything is best-effort and never throws into JS.

private let kAppGroup = "group.com.onemundo.mail"
private let kConvsKey = "chatyy.system_conversations"
private let kPinnedKey = "chatyy.pinned_conversation_ids"
private let kUpdatedKey = "chatyy.system_updated_at"
private let kFocusKey = "chatyy.focus_filter"
private let kLockedKey = "chatyy.widget_locked"
// [2026-10-11 badge] Shared with the NSE (plugins/notification-service/
// NotificationService.swift applyBadge): the app re-bases the counter every
// time it sets the icon badge so the NSE's "+1 per new message" fallback
// starts from the real number.
private let kBadgeCountKey = "chatyy.badge.count"
private let kBadgeAtKey = "chatyy.badge.at"
private let kBadgeLastServerKey = "chatyy.badge.last_server"

// [2026-10-16 boot-trace] Época do PROCESSO (ms desde 1970) via sysctl
// KERN_PROC_PID → kp_proc.p_starttime (timeval de parede, gravada pelo kernel no
// fork/exec). O JS (services/bootTrace.js) usa p/ medir nativo+bundle antes do T0
// do JS. 0 = indisponível (nunca lança).
func chatyyProcessStartEpochMs() -> Double {
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.stride
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
  let rc = sysctl(&mib, u_int(mib.count), &info, &size, nil, 0)
  if rc != 0 { return 0 }
  let tv = info.kp_proc.p_un.__p_starttime
  let ms = Double(tv.tv_sec) * 1000.0 + Double(tv.tv_usec) / 1000.0
  return ms > 0 ? ms : 0
}

public class ExpoChatyySystemModule: Module {
  private var monitor: NWPathMonitor?
  private let monitorQueue = DispatchQueue(label: "chatyy.system.netmonitor", qos: .utility)
  private let stateLock = NSLock()
  private var lastConstrained = false
  private var lastExpensive = false
  private var lastSatisfied = true
  private var hasPath = false

  public func definition() -> ModuleDefinition {
    Name("ExpoChatyySystem")
    Events("onNetworkConstraints")

    OnCreate {
      self.startMonitor()
    }

    OnDestroy {
      self.monitor?.cancel()
      self.monitor = nil
    }

    // items: [{ id, name, email, type: 'direct'|'group', pinned, unread, muted,
    //           lastMessageAt, avatarUrl }]  (JS already drops locked/hidden/archived)
    // opts: { locked: Bool } — app lock (Face ID) on → widget shows only "Chatyy bloqueado".
    AsyncFunction("setConversations") { (items: [[String: Any]], opts: [String: Any]) -> Int in
      guard let ud = UserDefaults(suiteName: kAppGroup) else { return 0 }
      var clean: [[String: Any]] = []
      var pinned: [String] = []
      for item in items.prefix(50) {
        let id = ExpoChatyySystemModule.str(item["id"])
        if id.isEmpty { continue }
        let name = ExpoChatyySystemModule.str(item["name"])
        let email = ExpoChatyySystemModule.str(item["email"])
        let isPinned = ExpoChatyySystemModule.bool(item["pinned"])
        if isPinned { pinned.append(id) }
        clean.append([
          "id": id,
          "name": String(name.prefix(80)),
          "email": email,
          "type": ExpoChatyySystemModule.str(item["type"]) == "group" ? "group" : "direct",
          "pinned": isPinned,
          "unread": ExpoChatyySystemModule.int(item["unread"]),
          "muted": ExpoChatyySystemModule.bool(item["muted"]),
          "lastMessageAt": ExpoChatyySystemModule.str(item["lastMessageAt"]),
          "avatarUrl": ExpoChatyySystemModule.str(item["avatarUrl"]),
        ])
      }
      guard let data = try? JSONSerialization.data(withJSONObject: clean, options: []) else { return 0 }
      ud.set(data, forKey: kConvsKey)
      ud.set(pinned, forKey: kPinnedKey)
      ud.set(ExpoChatyySystemModule.bool(opts["locked"]), forKey: kLockedKey)
      ud.set(Date().timeIntervalSince1970, forKey: kUpdatedKey)
      ExpoChatyySystemModule.reloadWidgets()
      ExpoChatyySystemModule.refreshSiriPhrases()
      return clean.count
    }

    // [2026-10-18 native-share] Snapshot p/ a ShareExtension NATIVA (lista de
    // conversas sem abrir o app) + kill switch. JS: services/nativeShareSnapshot.js.
    // items: [{ id, title, is_group, email, avatar_url }] — o JS já tirou E2EE,
    // bloqueadas, trancadas, arquivadas e canais.
    // opts: { enabled, account, base, locked }. enabled=false → apaga o snapshot
    // e a extensão volta a abrir o app (/share-receive).
    AsyncFunction("setShareSnapshot") { (items: [[String: Any]], opts: [String: Any]) -> Int in
      return ChatyyShareSnapshotWriter.write(items: items, opts: opts)
    }

    Function("clearShareSnapshot") { () -> Bool in
      ChatyyShareSnapshotWriter.clear()
      return true
    }

    // [2026-10-16 boot-trace] época do processo (ms) — ver chatyyProcessStartEpochMs.
    Function("processStartTime") { () -> Double in
      return chatyyProcessStartEpochMs()
    }

    // [2026-10-11 badge] Mirror of the icon badge for the NSE (app killed).
    Function("setBadgeMirror") { (count: Int) -> Bool in
      guard let ud = UserDefaults(suiteName: kAppGroup) else { return false }
      ud.set(max(0, count), forKey: kBadgeCountKey)
      ud.set(Date().timeIntervalSince1970, forKey: kBadgeAtKey)
      ud.removeObject(forKey: kBadgeLastServerKey)
      return true
    }

    AsyncFunction("clear") { () -> Bool in
      if let ud = UserDefaults(suiteName: kAppGroup) {
        for k in [kConvsKey, kPinnedKey, kUpdatedKey, kFocusKey, kLockedKey,
                  kBadgeCountKey, kBadgeAtKey, kBadgeLastServerKey] { ud.removeObject(forKey: k) }
      }
      ChatyyShareSnapshotWriter.clear()
      ExpoChatyySystemModule.reloadWidgets()
      ExpoChatyySystemModule.refreshSiriPhrases()
      return true
    }

    Function("getNetworkConstraints") { () -> [String: Any] in
      self.stateLock.lock()
      defer { self.stateLock.unlock() }
      return [
        "supported": true,
        "known": self.hasPath,
        "constrained": self.lastConstrained,
        "expensive": self.lastExpensive,
        "satisfied": self.lastSatisfied,
        "dataSaver": self.lastConstrained,
      ]
    }

    // [2026-10-15 app-links] Abre o link SÓ se um app instalado reivindica o
    // universal link (YouTube/Spotify/Apple Music…). false → JS cai no
    // navegador interno. Nunca abre o Safari.
    AsyncFunction("openUniversalLink") { (urlString: String, promise: Promise) in
      guard let url = URL(string: urlString), let scheme = url.scheme?.lowercased(),
            scheme == "https" || scheme == "http" else {
        promise.resolve(false)
        return
      }
      DispatchQueue.main.async {
        UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { ok in
          promise.resolve(ok)
        }
      }
    }

    Function("getFocusFilter") { () -> [String: Any]? in
      guard let ud = UserDefaults(suiteName: kAppGroup) else { return nil }
      return ud.dictionary(forKey: kFocusKey)
    }
  }

  private func startMonitor() {
    if monitor != nil { return }
    let m = NWPathMonitor()
    m.pathUpdateHandler = { [weak self] path in
      guard let self = self else { return }
      let constrained = path.isConstrained
      let expensive = path.isExpensive
      let satisfied = path.status == .satisfied
      self.stateLock.lock()
      let changed = !self.hasPath || constrained != self.lastConstrained
        || expensive != self.lastExpensive || satisfied != self.lastSatisfied
      self.hasPath = true
      self.lastConstrained = constrained
      self.lastExpensive = expensive
      self.lastSatisfied = satisfied
      self.stateLock.unlock()
      if changed {
        self.sendEvent("onNetworkConstraints", [
          "supported": true,
          "known": true,
          "constrained": constrained,
          "expensive": expensive,
          "satisfied": satisfied,
          "dataSaver": constrained,
        ])
      }
    }
    m.start(queue: monitorQueue)
    monitor = m
  }

  static func reloadWidgets() {
    #if canImport(WidgetKit)
    if #available(iOS 14.0, *) {
      WidgetCenter.shared.reloadAllTimelines()
    }
    #endif
  }

  /// ChatyyIntentsBootstrap lives in the APP target (no compile-time link).
  static func refreshSiriPhrases() {
    guard let cls = NSClassFromString("ChatyyIntentsBootstrap") else { return }
    let sel = NSSelectorFromString("refreshShortcutParameters")
    let obj: AnyObject = cls as AnyObject
    if obj.responds(to: sel) {
      _ = obj.perform(sel)
    }
  }

  static func str(_ v: Any?) -> String {
    if let s = v as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
  }

  static func bool(_ v: Any?) -> Bool {
    if let b = v as? Bool { return b }
    if let n = v as? NSNumber { return n.boolValue }
    if let s = v as? String { return s == "1" || s.lowercased() == "true" }
    return false
  }

  static func int(_ v: Any?) -> Int {
    if let n = v as? NSNumber { return n.intValue }
    if let s = v as? String, let i = Int(s) { return i }
    return 0
  }
}

// MARK: - [2026-10-18 native-share] snapshot da ShareExtension nativa

/// Grava no App Group o que a extensão precisa p/ mostrar a lista SEM rede:
///   chatyy.share.snapshot.v1  = {"v":1,"acct","at","locked","items":[{id,title,is_group,email,avatar}]}
///   chatyy.share.native_enabled = Bool (kill switch do JS)
///   ChatyyShare/avatars/<hash>.jpg = miniatura 132 px de cada avatar (baixada aqui,
///   em 2º plano; a extensão só lê do disco).
/// Token/base já estão no App Group (ExpoChatyyIntents.setShareExtensionAuth).
enum ChatyyShareSnapshotWriter {
  static let snapshotKey = "chatyy.share.snapshot.v1"
  static let enabledKey = "chatyy.share.native_enabled"
  private static let q = DispatchQueue(label: "chatyy.share.snapshot", qos: .utility)
  private static let maxItems = 60
  private static let avatarMaxAge: TimeInterval = 3 * 24 * 3600

  static func avatarsDir() -> URL? {
    guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: kAppGroup) else { return nil }
    let d = root.appendingPathComponent("ChatyyShare", isDirectory: true).appendingPathComponent("avatars", isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
  }

  /// FNV-1a 64 → nome de arquivo estável por URL.
  static func hashName(_ s: String) -> String {
    var h: UInt64 = 0xcbf29ce484222325
    for b in s.utf8 { h ^= UInt64(b); h = h &* 0x100000001b3 }
    return String(h, radix: 16) + ".jpg"
  }

  static func absoluteURL(_ raw: String, base: String) -> URL? {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { return nil }
    if s.hasPrefix("https://") { return URL(string: s) }
    if s.hasPrefix("/") {
      let b = base.hasPrefix("https://") ? base : "https://chatyy.com.br"
      return URL(string: b.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + s)
    }
    return nil
  }

  static func write(items: [[String: Any]], opts: [String: Any]) -> Int {
    guard let ud = UserDefaults(suiteName: kAppGroup) else { return 0 }
    let enabled = ExpoChatyySystemModule.bool(opts["enabled"])
    let acct = ExpoChatyySystemModule.str(opts["account"]).lowercased()
    ud.set(enabled, forKey: enabledKey)
    if !enabled || acct.isEmpty {
      ud.removeObject(forKey: snapshotKey)
      return 0
    }
    let base = ExpoChatyySystemModule.str(opts["base"])
    var rows: [[String: Any]] = []
    var downloads: [(String, URL)] = []
    var seen = Set<String>()
    for item in items {
      if rows.count >= maxItems { break }
      let id = ExpoChatyySystemModule.str(item["id"])
      let title = ExpoChatyySystemModule.str(item["title"])
      if id.isEmpty || title.isEmpty || seen.contains(id) { continue }
      seen.insert(id)
      var avatar = ""
      if let u = absoluteURL(ExpoChatyySystemModule.str(item["avatar_url"]), base: base) {
        avatar = hashName(u.absoluteString)
        downloads.append((avatar, u))
      }
      rows.append([
        "id": id,
        "title": String(title.prefix(80)),
        "is_group": ExpoChatyySystemModule.bool(item["is_group"]),
        "email": ExpoChatyySystemModule.str(item["email"]).lowercased(),
        "avatar": avatar,
      ])
    }
    let obj: [String: Any] = [
      "v": 1, "acct": acct, "at": Date().timeIntervalSince1970 * 1000,
      "locked": ExpoChatyySystemModule.bool(opts["locked"]), "items": rows,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return 0 }
    ud.set(data, forKey: snapshotKey)
    q.async { fetchAvatars(downloads) }
    return rows.count
  }

  static func clear() {
    if let ud = UserDefaults(suiteName: kAppGroup) {
      ud.removeObject(forKey: snapshotKey)
      ud.removeObject(forKey: enabledKey)
    }
    q.async {
      if let d = avatarsDir() { try? FileManager.default.removeItem(at: d) }
    }
  }

  private static func fetchAvatars(_ list: [(String, URL)]) {
    guard let dir = avatarsDir() else { return }
    let fm = FileManager.default
    let keep = Set(list.map { $0.0 })
    let now = Date()
    // poda: o que saiu da lista e tem mais de 7 dias
    if let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) {
      for f in files where !keep.contains(f.lastPathComponent) {
        let m = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? now
        if now.timeIntervalSince(m) > 7 * 24 * 3600 { try? fm.removeItem(at: f) }
      }
    }
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 15
    let session = URLSession(configuration: cfg)
    for (name, url) in list {
      let dst = dir.appendingPathComponent(name)
      if let m = (try? dst.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate,
         now.timeIntervalSince(m) < avatarMaxAge { continue }
      let sem = DispatchSemaphore(value: 0)
      session.dataTask(with: url) { data, resp, _ in
        defer { sem.signal() }
        guard let d = data, d.count > 0, d.count < 4 * 1024 * 1024,
              ((resp as? HTTPURLResponse)?.statusCode ?? 0) == 200,
              let src = CGImageSourceCreateWithData(d as CFData, nil) else { return }
        let o: [CFString: Any] = [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: 132,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, o as CFDictionary) else { return }
        guard let jpg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.8) else { return }
        try? jpg.write(to: dst, options: .atomic)
      }.resume()
      _ = sem.wait(timeout: .now() + 20)
    }
    session.finishTasksAndInvalidate()
  }
}
