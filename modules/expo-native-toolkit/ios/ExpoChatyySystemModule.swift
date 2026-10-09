import ExpoModulesCore
import Foundation
import Network
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

    AsyncFunction("clear") { () -> Bool in
      if let ud = UserDefaults(suiteName: kAppGroup) {
        for k in [kConvsKey, kPinnedKey, kUpdatedKey, kFocusKey, kLockedKey] { ud.removeObject(forKey: k) }
      }
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
