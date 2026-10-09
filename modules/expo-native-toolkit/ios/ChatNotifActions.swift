import ExpoModulesCore
import ExpoNotifications
import Foundation
import Security
import UIKit
import UserNotifications

// MARK: ─── [2026-10-09 notif-native] Chat notification actions, app KILLED ──
//
// "Responder" (UNTextInputNotificationAction) and "Marcar como lida" on a chat
// banner used to be handled ONLY in JS (services/pushNotifications.js). With
// the app killed iOS launches the process in the background, expo-notifications
// calls completionHandler() right away and the JS listener is usually not up
// yet → the reply was lost or sent minutes later. WhatsApp sends it natively.
//
// Here:
//   • ChatNotifActionsAppDelegateSubscriber registers ChatNotifActionHandler
//     as an expo-notifications NotificationDelegate at didFinishLaunching
//     (before iOS delivers the response).
//   • The handler POSTs email.php?action=chat_send / chat_mark_read with the
//     bearer of the account the push was addressed to (data.recipient_email),
//     inside a UIApplication background task, then removes the conversation's
//     delivered banners (thread chat_<cid>).
//   • Bearers live in the KEYCHAIN (AfterFirstUnlockThisDeviceOnly, never in
//     backups / other devices), written by JS via ChatyyNotifActions.setAuth.
//     Fallback = the App Group "auth_token" (persistAuthForNativeCall) only
//     when the push is for the active account or names no account.
//   • JS asks wasHandledNatively(requestIdentifier) and skips its own send →
//     never a double reply. No bearer / empty text → not handled here → the
//     JS path runs exactly as before.
//
// Endpoint MUST be email.php?action=… (chat.php direct = 200 with empty body).

enum ChatNotifAuthStore {
  private static let service = "com.onemundo.mail.chatnotif"
  private static let account = "auth_v1"
  private static let appGroup = "group.com.onemundo.mail"

  static func normEmail(_ e: String?) -> String {
    return (e ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      .replacingOccurrences(of: "@onemundo.com.br", with: "@chatyy.com.br")
  }

  static func save(active: String, tokens: [String: String]) {
    var clean: [String: String] = [:]
    for (k, v) in tokens {
      let e = normEmail(k)
      if !e.isEmpty && !v.isEmpty { clean[e] = v }
    }
    let blob: [String: Any] = ["active": normEmail(active), "tokens": clean]
    guard let data = try? JSONSerialization.data(withJSONObject: blob) else { return }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let update: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let st = SecItemUpdate(query as CFDictionary, update as CFDictionary)
    if st == errSecItemNotFound {
      var add = query
      for (k, v) in update { add[k] = v }
      SecItemAdd(add as CFDictionary, nil)
    }
  }

  static func clear() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(query as CFDictionary)
  }

  private static func load() -> (active: String, tokens: [String: String]) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
          let data = out as? Data,
          let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return ("", [:]) }
    return ((j["active"] as? String) ?? "", (j["tokens"] as? [String: String]) ?? [:])
  }

  /// Bearer of the account the push belongs to. nil when we KNOW it belongs
  /// to an account we have no token for (never reply as the wrong person).
  static func bearer(for recipient: String?) -> String? {
    let rcpt = normEmail(recipient)
    let st = load()
    if !rcpt.isEmpty, let t = st.tokens[rcpt], !t.isEmpty { return t }
    let active = normEmail(st.active)
    if rcpt.isEmpty || active.isEmpty || rcpt == active {
      if !active.isEmpty, let t = st.tokens[active], !t.isEmpty { return t }
      if let ud = UserDefaults(suiteName: appGroup),
         let t = ud.string(forKey: "auth_token"), !t.isEmpty { return t }
    }
    return nil
  }

  static func apiBase() -> String {
    if let ud = UserDefaults(suiteName: appGroup),
       let b = ud.string(forKey: "api_base"), b.hasPrefix("https://") {
      return b.hasSuffix("/") ? String(b.dropLast()) : b
    }
    return "https://chatyy.com.br"
  }
}

final class ChatNotifActionHandler: NotificationDelegate {
  static let shared = ChatNotifActionHandler()

  private static let replyIds: Set<String> = ["reply", "REPLY", "reply_chat"]
  private static let readIds: Set<String> = ["mark_read", "MARK_READ", "mark_read_chat"]

  private let lock = NSLock()
  private var handled: [String: Date] = [:]

  func wasHandled(_ requestId: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return handled[requestId] != nil
  }

  private func markHandled(_ requestId: String) {
    lock.lock(); defer { lock.unlock() }
    let now = Date()
    handled = handled.filter { now.timeIntervalSince($0.value) < 600 }
    handled[requestId] = now
  }

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    let action = response.actionIdentifier
    let isReply = Self.replyIds.contains(action) || action.hasPrefix("smart_reply_")
    let isRead = Self.readIds.contains(action)
    guard isReply || isRead else { return false }

    let p = Self.payload(response.notification.request.content.userInfo)
    // E-mail pushes share "mark_read"/"REPLY" ids — they carry `uid`.
    if Self.str(p, "uid") != nil { return false }
    guard let conv = Self.str(p, "conversation_id") else { return false }
    guard let bearer = ChatNotifAuthStore.bearer(for: Self.str(p, "recipient_email")) else { return false }

    var text = ""
    if isReply {
      text = ((response as? UNTextInputNotificationResponse)?.userText ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty { return false }
    }
    let requestId = response.notification.request.identifier
    markHandled(requestId)

    let lang = (Self.str(p, "lang") ?? "pt").lowercased()
    let lastMid = Int64(Self.str(p, "message_id") ?? "") ?? 0
    let base = ChatNotifAuthStore.apiBase()

    let app = UIApplication.shared
    var bgId: UIBackgroundTaskIdentifier = .invalid
    bgId = app.beginBackgroundTask(withName: "chatyy-notif-action") {
      if bgId != .invalid { app.endBackgroundTask(bgId); bgId = .invalid }
    }
    let finish = {
      DispatchQueue.main.async {
        if bgId != .invalid { app.endBackgroundTask(bgId); bgId = .invalid }
      }
    }

    DispatchQueue.global(qos: .userInitiated).async {
      if isReply {
        let cmid = "notif-" + UUID().uuidString.lowercased()
        var ok = false
        for _ in 0..<2 {
          let r = Self.post(base: base, bearer: bearer, action: "chat_send", body: [
            "conversation_id": conv, "type": "text", "content": text, "client_message_id": cmid,
          ])
          if r.ok { ok = true; break }
          if (400..<500).contains(r.code) { break }
        }
        if ok {
          // Replying = you read the chat (WhatsApp).
          _ = Self.post(base: base, bearer: bearer, action: "chat_mark_read", body: [
            "conversation_id": conv, "message_id": lastMid,
          ])
          Self.removeDelivered(conv: conv, then: finish)
        } else {
          Self.postSendFailed(conv: conv, lang: lang, original: response.notification.request.content, then: finish)
        }
      } else {
        Self.removeDelivered(conv: conv, then: {})
        for _ in 0..<2 {
          let r = Self.post(base: base, bearer: bearer, action: "chat_mark_read", body: [
            "conversation_id": conv, "message_id": lastMid,
          ])
          if r.ok || (400..<500).contains(r.code) { break }
        }
        finish()
      }
    }
    return true
  }

  // MARK: - helpers

  private static func post(base: String, bearer: String, action: String, body: [String: Any]) -> (ok: Bool, code: Int) {
    guard let url = URL(string: base + "/api/email.php?action=" + action) else { return (false, -1) }
    var req = URLRequest(url: url, timeoutInterval: 12)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization")
    var b = body
    b["action"] = action
    req.httpBody = try? JSONSerialization.data(withJSONObject: b)
    let sem = DispatchSemaphore(value: 0)
    var result: (ok: Bool, code: Int) = (false, -1)
    URLSession.shared.dataTask(with: req) { data, resp, _ in
      let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
      var ok = false
      if (200..<300).contains(code), let d = data,
         let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
        // An empty 200 = action not routed → failure.
        ok = (j["success"] as? Bool) == true
      }
      result = (ok, code)
      sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 14)
    NSLog("[ChatNotifActions] POST \(action) → \(result.code) ok=\(result.ok)")
    return result
  }

  private static func removeDelivered(conv: String, then: @escaping () -> Void) {
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { list in
      let ids = list.filter { n in
        if n.request.content.threadIdentifier == "chat_" + conv { return true }
        let p = ChatNotifActionHandler.payload(n.request.content.userInfo)
        return ChatNotifActionHandler.str(p, "conversation_id") == conv
      }.map { $0.request.identifier }
      if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
      then()
    }
  }

  private static func postSendFailed(conv: String, lang: String, original: UNNotificationContent, then: @escaping () -> Void) {
    let c = UNMutableNotificationContent()
    c.title = original.title
    c.body = lang.hasPrefix("en") ? "Not sent. Tap to open"
      : (lang.hasPrefix("es") ? "No enviado. Toca para abrir" : "Não enviada. Toque para abrir")
    c.threadIdentifier = "chat_" + conv
    c.userInfo = original.userInfo
    let req = UNNotificationRequest(identifier: "chat_send_failed_" + conv, content: c, trigger: nil)
    UNUserNotificationCenter.current().add(req) { _ in then() }
  }

  /// Top-level userInfo merged with the Expo "body" (dictionary or JSON string).
  static func payload(_ userInfo: [AnyHashable: Any]) -> [String: Any] {
    var out: [String: Any] = [:]
    for (k, v) in userInfo { if let ks = k as? String { out[ks] = v } }
    var nested: [String: Any]? = userInfo["body"] as? [String: Any]
    if nested == nil, let s = userInfo["body"] as? String, s.hasPrefix("{"),
       let d = s.data(using: .utf8),
       let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
      nested = j
    }
    if let n = nested { for (k, v) in n { out[k] = v } }
    return out
  }

  static func str(_ p: [String: Any], _ k: String) -> String? {
    if let s = p[k] as? String { return s.isEmpty ? nil : s }
    if let n = p[k] as? NSNumber { return n.stringValue }
    return nil
  }
}

public class ChatNotifActionsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NotificationCenterManager.shared.addDelegate(ChatNotifActionHandler.shared)
    return true
  }
}

public class ChatyyNotifActionsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyNotifActions")

    // tokens: { email: bearer } for every signed-in account.
    Function("setAuth") { (activeEmail: String, activeToken: String, tokens: [String: Any]) in
      var map: [String: String] = [:]
      for (k, v) in tokens { if let s = v as? String, !s.isEmpty { map[k] = s } }
      if !activeEmail.isEmpty && !activeToken.isEmpty { map[activeEmail] = activeToken }
      if map.isEmpty { return }
      ChatNotifAuthStore.save(active: activeEmail, tokens: map)
    }

    Function("clearAuth") {
      ChatNotifAuthStore.clear()
    }

    // JS skips its own send when the native handler already did it.
    Function("wasHandledNatively") { (requestId: String) -> Bool in
      return ChatNotifActionHandler.shared.wasHandled(requestId)
    }
  }
}
