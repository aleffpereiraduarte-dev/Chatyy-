import ExpoModulesCore
import UIKit
import UserNotifications

// [2026-10-15 notif-read-sync] Push silencioso `chat_notif_clear` (servidor:
// firebase_push.php chatPushNotifClear, disparado no chat_mark_read / apagar p/
// todos) → tira da central, NATIVAMENTE, os banners daquela conversa quando ela
// foi lida em OUTRO aparelho / na web (WhatsApp multi-device).
//
// Antes só o JS (services/pushDeliveryTask → applyNotifClear) fazia isso: com o
// app suspenso o iOS acorda o processo, mas o bundle RN pode nem subir dentro da
// janela de ~30 s. Aqui roda direto no didReceiveRemoteNotification, sem JS.
// O JS continua fazendo o mesmo (idempotente: remover id já removido = no-op).
//
// Formatos aceitos: Expo / APNs direto → dados em userInfo["body"] (dict ou JSON
// string); FCM → dados no topo. kind=read: remove msgs com id <= up_to (todas sem
// up_to); kind=deleted: remove a do message_id (não mexe em reação).
// Badge: o servidor manda aps.badge no kind=read (o iOS aplica sozinho); aqui só
// espelhamos no App Group p/ a NSE contar certo com o app morto.
//
// Kill switch: App Group / standard UserDefaults bool "chatyy.notif_clear_native_off".
// Limite conhecido (Apple): app FORÇADO a fechar (swipe up) não recebe push
// silencioso → banners ficam até o app abrir (aí o JS reconcilia).

private let kNcAppGroup = "group.com.onemundo.mail"
private let kNcKillKey = "chatyy.notif_clear_native_off"
private let kNcBadgeCountKey = "chatyy.badge.count"
private let kNcBadgeAtKey = "chatyy.badge.at"
private let kNcBadgeLastServerKey = "chatyy.badge.last_server"

public class ChatNotifClearAppDelegateSubscriber: ExpoAppDelegateSubscriber {

    public func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard let p = Self.clearPayload(userInfo) else { completionHandler(.noData); return }
        let ag = UserDefaults(suiteName: kNcAppGroup)
        if UserDefaults.standard.bool(forKey: kNcKillKey) || (ag?.bool(forKey: kNcKillKey) ?? false) {
            completionHandler(.noData); return
        }
        let cid = Self.str(p, "conversation_id") ?? ""
        let kind = Self.str(p, "kind") ?? "read"
        guard !cid.isEmpty, kind == "read" || kind == "deleted" else { completionHandler(.noData); return }
        let upTo = Int64(Self.str(p, "up_to") ?? "") ?? 0
        let mid = Self.str(p, "message_id") ?? ""
        let thread = "chat_" + cid

        // Badge vindo do servidor (kind=read) → espelho p/ a NSE.
        if kind == "read", let b = Int(Self.str(p, "badge") ?? ""), b >= 0, let ud = ag {
            ud.set(b, forKey: kNcBadgeCountKey)
            ud.set(Date().timeIntervalSince1970, forKey: kNcBadgeAtKey)
            ud.removeObject(forKey: kNcBadgeLastServerKey)
        }

        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            var ids: [String] = []
            for n in delivered {
                let c = n.request.content
                let d = Self.dataOf(c.userInfo)
                if Self.str(d, "type") == "chat_notif_clear" { continue }
                let nCid = Self.str(d, "conversation_id") ?? ""
                guard nCid == cid || (nCid.isEmpty && c.threadIdentifier == thread) else { continue }
                let nType = Self.str(d, "type") ?? ""
                let nMidStr = Self.str(d, "message_id") ?? ""
                let nMid = Int64(nMidStr) ?? 0
                let hit: Bool
                if kind == "read" {
                    hit = upTo <= 0 || nMid <= 0 || nMid <= upTo || nType == "chat_reaction"
                } else {
                    hit = !mid.isEmpty && nMidStr == mid && nType != "chat_reaction"
                }
                if hit { ids.append(n.request.identifier) }
            }
            if !ids.isEmpty {
                center.removeDeliveredNotifications(withIdentifiers: ids)
                NSLog("%@", "[NotifClear] conv=\(cid) kind=\(kind) removed=\(ids.count)")
            }
            completionHandler(ids.isEmpty ? .noData : .newData)
        }
    }

    // MARK: - payload helpers

    /// Dados do push: userInfo["body"] (dict ou JSON) ou o próprio topo.
    static func dataOf(_ userInfo: [AnyHashable: Any]) -> [String: Any] {
        if let b = userInfo["body"] as? [String: Any] { return b }
        if let s = userInfo["body"] as? String, s.hasPrefix("{"),
           let data = s.data(using: .utf8),
           let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { return obj }
        var out: [String: Any] = [:]
        for (k, v) in userInfo { if let ks = k as? String { out[ks] = v } }
        return out
    }

    static func clearPayload(_ userInfo: [AnyHashable: Any]) -> [String: Any]? {
        let d = dataOf(userInfo)
        if str(d, "type") == "chat_notif_clear" { return d }
        if let t = userInfo["type"] as? String, t == "chat_notif_clear" {
            var out: [String: Any] = [:]
            for (k, v) in userInfo { if let ks = k as? String { out[ks] = v } }
            return out
        }
        return nil
    }

    static func str(_ d: [String: Any], _ k: String) -> String? {
        guard let v = d[k] else { return nil }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }
}
