import ExpoModulesCore
import UIKit

// [rcpt-bg 2026-10-24] Recibos ✓✓ (entregue) / ✓✓ azul (lido) com o app em 2º plano / fechado, SEM JS.
//
// Dois caminhos (servidor: /var/www/mail/api/rcpt-bg.php, flag por conta):
//   1. Push silencioso `chat_rcpt` (apns-push-type background, prioridade 5): o iOS acorda o processo e chama
//      didReceiveRemoteNotification → grava direto no store nativo (foto da conversa + foto da HOME).
//   2. Carona `rcpt` dentro de um push de chat VISÍVEL: a NSE (outro processo, sem acesso ao store) guarda o
//      compacto no App Group (chatyy.rcpt.pending); aqui drenamos ao abrir / voltar ao 1º plano, ANTES do JS
//      pintar (o cold start lê a foto do store).
// Formato: {type:"chat_rcpt", v:"1", ah:<hash da conta>, r:"cid,d,r;…"} (Expo/APNs: em userInfo["body"]).
// Kill: UserDefaults (standard ou App Group) bool "chatyy.rcpt_bg_native_off".
// Limite Apple: app FORÇADO a fechar não recebe push silencioso → fica p/ o catch-up do JS ao abrir (1 ida).

private let kRbAppGroup = "group.com.onemundo.mail"
private let kRbPendingKey = "chatyy.rcpt.pending"
private let kRbKillKey = "chatyy.rcpt_bg_native_off"

public class ChatyyRcptBgAppDelegateSubscriber: ExpoAppDelegateSubscriber {

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    Self.drainPending(src: "launch")
    return true
  }

  public func applicationWillEnterForeground(_ application: UIApplication) {
    Self.drainPending(src: "fg")
  }

  public func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    if Self.killed() { completionHandler(.noData); return }
    let d = Self.dataOf(userInfo)
    let type = Self.str(d, "type") ?? ""
    var compact = "", ah = ""
    if type == "chat_rcpt" {
      compact = Self.str(d, "r") ?? ""; ah = Self.str(d, "ah") ?? ""
    } else if let r = Self.str(d, "rcpt"), !r.isEmpty {
      compact = r; ah = Self.str(d, "rcpt_ah") ?? ""
    }
    if compact.isEmpty { completionHandler(.noData); return }
    Self.drainPending(src: "push")
    let lock = NSLock()
    var called = false
    let finish: (UIBackgroundFetchResult) -> Void = { r in
      lock.lock(); if called { lock.unlock(); return }; called = true; lock.unlock()
      completionHandler(r)
    }
    // Teto bem abaixo dos ~30 s da Apple (completion atrasado = orçamento de fundo menor).
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 15) { finish(.noData) }
    ChatyyStoreDB.shared.rcptBgApply(ah: ah, compact: compact, src: type == "chat_rcpt" ? "silent" : "piggy") { n in
      NSLog("%@", "[RcptBg] \(type == "chat_rcpt" ? "silent" : "piggy") convs=\(n)")
      finish(n > 0 ? .newData : .noData)
    }
  }

  // MARK: - App Group (carona da NSE)

  static func killed() -> Bool {
    if UserDefaults.standard.bool(forKey: kRbKillKey) { return true }
    return UserDefaults(suiteName: kRbAppGroup)?.bool(forKey: kRbKillKey) ?? false
  }

  /// Aplica (e apaga) o que a NSE guardou. Ordem: a fila do store é serial → o JS que ler o store depois já vê.
  static func drainPending(src: String) {
    if killed() { return }
    guard FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: kRbAppGroup) != nil,
          let ud = UserDefaults(suiteName: kRbAppGroup),
          let arr = ud.array(forKey: kRbPendingKey) as? [[String: Any]], !arr.isEmpty else { return }
    ud.removeObject(forKey: kRbPendingKey)
    let now = Date().timeIntervalSince1970
    for it in arr.suffix(8) {
      let t = (it["t"] as? NSNumber)?.doubleValue ?? 0
      if t > 0 && now - t > 86400 { continue } // mais de 1 dia: o catch-up do JS resolve
      let r = (it["r"] as? String) ?? "", ah = (it["ah"] as? String) ?? ""
      if r.isEmpty { continue }
      ChatyyStoreDB.shared.rcptBgApply(ah: ah, compact: r, src: "nse-" + src, done: nil)
    }
  }

  // MARK: - payload

  static func dataOf(_ userInfo: [AnyHashable: Any]) -> [String: Any] {
    if let b = userInfo["body"] as? [String: Any] { return b }
    if let s = userInfo["body"] as? String, s.hasPrefix("{"), let data = s.data(using: .utf8),
       let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { return obj }
    var out: [String: Any] = [:]
    for (k, v) in userInfo { if let ks = k as? String { out[ks] = v } }
    return out
  }

  static func str(_ d: [String: Any], _ k: String) -> String? {
    guard let v = d[k] else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
  }
}
