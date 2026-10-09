import ExpoModulesCore
import Intents
import UIKit

// [2026-10-08 android-otp-shortcuts] Home-screen quick actions (long-press icon).
//
// Static items (Nova conversa / Câmera / Escrever e-mail) are written into
// Info.plist → UIApplicationShortcutItems by plugins/with-app-shortcuts.js,
// each with UserInfo.url = onemundomail://… . Dynamic items (top recent
// conversations) are set here via UIApplication.shared.shortcutItems.
//
// Launch handling: the app has no SceneDelegate, so iOS calls the
// AppDelegate. ExpoAppDelegate forwards performActionFor to subscribers →
// AppShortcutsAppDelegateSubscriber stores the URL in ChatyyShortcutCenter
// (pending) and, when the module is alive, emits "onShortcut". JS consumes
// it with getPendingShortcut() (cold start: on mount; warm: on the event)
// and routes through expo-router. Consuming clears it → no double navigation.

final class ChatyyShortcutCenter {
  private static let lock = NSLock()
  private static var pendingURL: String?
  private static var listener: ((String) -> Void)?

  static func setListener(_ l: ((String) -> Void)?) {
    lock.lock(); listener = l; lock.unlock()
  }

  static func deliver(_ url: String) {
    lock.lock()
    pendingURL = url
    let l = listener
    lock.unlock()
    l?(url)
  }

  static func consume() -> String? {
    lock.lock()
    var u = pendingURL
    pendingURL = nil
    lock.unlock()
    // [2026-10-09 system-integration] App Intents (Siri/Atalhos, compiled in
    // the app target by plugins/with-system-intents.js) park their URL in
    // UserDefaults — survives the cold-start race before this pod's observer
    // existed. Fresh (< 10 min) only; always cleared once read.
    let ud = UserDefaults.standard
    if let parked = ud.string(forKey: intentURLKey), !parked.isEmpty {
      let at = ud.double(forKey: intentAtKey)
      if u == nil && Date().timeIntervalSince1970 - at < 600 { u = parked }
      ud.removeObject(forKey: intentURLKey)
      ud.removeObject(forKey: intentAtKey)
    }
    return u
  }

  static let intentURLKey = "chatyy.intent.pendingURL"
  static let intentAtKey = "chatyy.intent.pendingAt"
  private static var intentObserver: NSObjectProtocol?

  /// Warm path for App Intents: the intent posts "ChatyyIntentOpenURL" (main
  /// thread, in-process). Registered once from didFinishLaunching.
  static func observeIntents() {
    lock.lock()
    let already = intentObserver != nil
    lock.unlock()
    if already { return }
    let obs = NotificationCenter.default.addObserver(
      forName: Notification.Name("ChatyyIntentOpenURL"), object: nil, queue: .main
    ) { note in
      guard let url = note.userInfo?["url"] as? String, !url.isEmpty else { return }
      UserDefaults.standard.removeObject(forKey: ChatyyShortcutCenter.intentURLKey)
      UserDefaults.standard.removeObject(forKey: ChatyyShortcutCenter.intentAtKey)
      ChatyyShortcutCenter.deliver(url)
    }
    lock.lock(); intentObserver = obs; lock.unlock()
  }

  /// Phone app Recents / Siri suggestions hand us INStartCallIntent /
  /// INSendMessageIntent user activities (donated by expo-callkit and
  /// ExpoChatyyIntents). Map them to the same deep links the app routes.
  static func url(for activity: NSUserActivity) -> String? {
    guard let interaction = activity.interaction else { return nil }
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    func enc(_ s: String) -> String { return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s }
    if let call = interaction.intent as? INStartCallIntent,
       let person = call.contacts?.first,
       let handle = person.personHandle?.value, handle.contains("@") {
      let video = call.callCapability == .videoCall
      let name = person.displayName
      // Resolved to the conversation by app/assistant-action/[kind].js, which
      // opens it with ?autocall= → same call pipeline as the in-chat button.
      return "onemundomail://assistant-action/\(video ? "video" : "call")?email=\(enc(handle))&name=\(enc(name))"
    }
    if let msg = interaction.intent as? INSendMessageIntent,
       let conv = msg.conversationIdentifier, !conv.isEmpty {
      return "onemundomail://chat-conversation?id=\(enc(conv))&src=intent"
    }
    return nil
  }

  /// Static items carry UserInfo.url; fall back to a type → URL map so an
  /// item from an older Info.plist (no UserInfo) still routes.
  static func url(for item: UIApplicationShortcutItem) -> String? {
    if let u = item.userInfo?["url"] as? String, !u.isEmpty { return u }
    let t = item.type
    if t.hasSuffix(".newchat") { return "onemundomail://chat-new" }
    if t.hasSuffix(".camera") { return "onemundomail://photos?camera=1" }
    if t.hasSuffix(".compose") { return "onemundomail://compose" }
    return nil
  }
}

public class AppShortcutsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Cold launch from a quick action. iOS ALSO calls performActionFor
    // afterwards (didFinishLaunching returns true) — deliver() is idempotent
    // (it just overwrites the same pending URL).
    if let item = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem,
       let url = ChatyyShortcutCenter.url(for: item) {
      ChatyyShortcutCenter.deliver(url)
    }
    ChatyyShortcutCenter.observeIntents()
    return true
  }

  // [2026-10-09 system-integration] Recents "call back" / intent activities.
  // ExpoAppDelegateSubscriberManager waits for EVERY subscriber to call the
  // restoration handler → always call it, handled or not.
  public func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    guard let url = ChatyyShortcutCenter.url(for: userActivity) else {
      restorationHandler(nil)
      return false
    }
    ChatyyShortcutCenter.deliver(url)
    restorationHandler(nil)
    return true
  }

  public func application(
    _ application: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    guard let url = ChatyyShortcutCenter.url(for: shortcutItem) else {
      completionHandler(false)
      return
    }
    ChatyyShortcutCenter.deliver(url)
    completionHandler(true)
  }
}

public class ExpoAppShortcutsModule: Module {
  private static let maxRecents = 4
  private static let unreserved: CharacterSet = {
    // ASCII-only (CharacterSet.alphanumerics would leave "é" etc. raw).
    return CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
  }()

  public func definition() -> ModuleDefinition {
    Name("ExpoAppShortcuts")
    Events("onShortcut")

    OnCreate {
      ChatyyShortcutCenter.setListener { [weak self] url in
        self?.sendEvent("onShortcut", ["url": url])
      }
    }

    OnDestroy {
      ChatyyShortcutCenter.setListener(nil)
    }

    // items: [{ id, name, type: 'direct'|'group', email?, acct? }]
    AsyncFunction("setRecentConversations") { (items: [[String: Any]]) -> Int in
      var out: [UIApplicationShortcutItem] = []
      let bundleId = Bundle.main.bundleIdentifier ?? "com.onemundo.mail"
      for item in items {
        if out.count >= ExpoAppShortcutsModule.maxRecents { break }
        let convId = ExpoAppShortcutsModule.str(item["id"])
        if convId.isEmpty { continue }
        var name = ExpoAppShortcutsModule.str(item["name"])
        if name.isEmpty { name = "Chatyy" }
        let isGroup = ExpoAppShortcutsModule.str(item["type"]) == "group"
        let email = ExpoAppShortcutsModule.str(item["email"])
        let acct = ExpoAppShortcutsModule.str(item["acct"])

        var q = "id=\(ExpoAppShortcutsModule.enc(convId))&type=\(isGroup ? "group" : "direct")"
        q += "&name=\(ExpoAppShortcutsModule.enc(name))"
        if !email.isEmpty { q += "&email=\(ExpoAppShortcutsModule.enc(email))" }
        if !acct.isEmpty { q += "&acct=\(ExpoAppShortcutsModule.enc(acct))" }
        q += "&src=shortcut"
        let url = "onemundomail://chat-conversation?\(q)"

        let icon = UIApplicationShortcutIcon(systemImageName: isGroup ? "person.2.fill" : "person.crop.circle.fill")
        let si = UIApplicationShortcutItem(
          type: "\(bundleId).recent",
          localizedTitle: String(name.prefix(60)),
          localizedSubtitle: nil,
          icon: icon,
          userInfo: ["url": url as NSString, "conversationId": convId as NSString]
        )
        out.append(si)
      }
      UIApplication.shared.shortcutItems = out
      return out.count
    }.runOnQueue(.main)

    AsyncFunction("clear") {
      UIApplication.shared.shortcutItems = []
    }.runOnQueue(.main)

    Function("getPendingShortcut") { () -> String? in
      return ChatyyShortcutCenter.consume()
    }
  }

  private static func str(_ v: Any?) -> String {
    if let s = v as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
  }

  private static func enc(_ s: String) -> String {
    return s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? s
  }
}
