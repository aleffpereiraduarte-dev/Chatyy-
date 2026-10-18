import Foundation
import UIKit
import CallKit
import UserNotifications

/// [2026-10-15 chamadas-dnd] CallKit RECUSOU o toque de uma ligação recebida
/// (reportNewIncomingCall falhou — típico: code 3 = filteredByDoNotDisturb,
/// Foco/Não Perturbe). Forense de campo (BR → founder EUA): o push falhava com
/// `voip_report_failed code=3`, mas o app pré-conectava a sala do LiveKit
/// mesmo assim → quem ligou via "Tocando…" falso (o caller marca "Tocando"
/// quando o callee entra na sala) e o telefone nunca tocou.
///
/// Agora, numa recusa:
///   1. a callId fica marcada "filtrada" → kickRingWindowPreconnect /
///      preconnectRoom NÃO entram na sala (e uma pré-conexão já em voo cai);
///   2. call_status=dnd (HTTP) → o servidor repassa `call_peer_status
///      {status:"dnd"}` a quem liga, que mostra "Não perturbe ativo";
///   3. notificação local "Ligação de X — toque para atender" (nível .active:
///      o perfil de provisionamento NÃO tem Time Sensitive);
///   4. se o app ficar ativo (toque na notificação / usuário abre o app)
///      dentro da janela de toque, tenta reportar a ligação ao CallKit de novo
///      (mesma UUID + payload) e, se tocar, pré-conecta normalmente e manda
///      call_status=peer_ringing (caller volta a "Tocando…").
/// code 2 (UUID já existe = já está tocando) e code 4 (bloqueado na lista do
/// iOS) NÃO entram aqui.
/// Desligar sem build: App Group bool "chatyy_dnd_filter_off" = true (sem
/// notificação/status/re-toque; a pré-conexão continua só após report OK).
enum IncomingCallFilter {
    private static let appGroup = "group.com.onemundo.mail"
    private static let persistKey = "chatyy_filtered_call"
    /// Janela em que um re-toque ainda faz sentido (caller desiste aos 45 s,
    /// hub manda call_missed aos 50 s).
    private static let reRingWindow: TimeInterval = 38

    private struct Entry {
        let callId: String
        let uuid: UUID
        let callerName: String
        let callerEmail: String
        let callerPhone: String
        let conversationId: String
        let hasVideo: Bool
        let lkToken: String
        let lkUrl: String
        let at: TimeInterval
        var reRingTried: Bool
    }

    private static let lock = NSLock()
    private static var entries: [String: Entry] = [:]
    private static var activeObserver: NSObjectProtocol?

    static func isDisabled() -> Bool {
        return UserDefaults(suiteName: appGroup)?.bool(forKey: "chatyy_dnd_filter_off") ?? false
    }

    /// true enquanto a callId estiver filtrada (toque recusado e ainda não re-tocou).
    static func isFiltered(_ callId: String) -> Bool {
        guard !callId.isEmpty else { return false }
        lock.lock(); defer { lock.unlock() }
        return entries[callId] != nil
    }

    /// Chamar no completion de reportNewIncomingCall com erro. Retorna true se
    /// a recusa foi tratada como "não tocou" (sem pré-conexão a partir daqui).
    @discardableResult
    static func handleReportFailure(error: Error,
                                    callId: String,
                                    uuid: UUID,
                                    callerName: String,
                                    callerEmail: String,
                                    callerPhone: String = "",
                                    conversationId: String,
                                    hasVideo: Bool,
                                    lkToken: String = "",
                                    lkUrl: String = "",
                                    source: String) -> Bool {
        guard !callId.isEmpty else { return false }
        let ns = error as NSError
        let code = ns.code
        let incomingDomain = ns.domain.lowercased().contains("incomingcall")
        // 2 = callUUIDAlreadyExists (a ligação JÁ está tocando com essa UUID);
        // 4 = filteredByBlockList (usuário bloqueou o contato no iOS — silêncio).
        if incomingDomain && (code == 2 || code == 4) {
            nativeCallDiag("ring_filter_skip", callId, "src=\(source) code=\(code)")
            return false
        }
        if isDisabled() {
            nativeCallDiag("ring_filter_off", callId, "src=\(source) code=\(code)")
            return false
        }
        let reason = (incomingDomain && code == 3) ? "focus" : "ring_rejected"
        lock.lock()
        if entries[callId] != nil {
            lock.unlock()
            return true
        }
        let e = Entry(callId: callId, uuid: uuid, callerName: callerName, callerEmail: callerEmail,
                      callerPhone: callerPhone, conversationId: conversationId, hasVideo: hasVideo,
                      lkToken: lkToken, lkUrl: lkUrl, at: Date().timeIntervalSince1970, reRingTried: false)
        entries[callId] = e
        lock.unlock()
        persist(e)
        nativeCallDiag("ring_filtered", callId, "src=\(source) code=\(code) domain=\(ns.domain) reason=\(reason)")

        DispatchQueue.main.async {
            installActiveObserver()
            // Pré-conexão que já estava em voo (ex.: convite WS em paralelo) sai da sala.
            NativeCallRoom.shared.teardownUnansweredPreconnect(callId: callId, reason: "ring_filtered")
            postLocalNotification(e)
            // [2026-10-18 calls-data] Foco engoliu o toque → se ninguém atender,
            // fica "Chamada perdida de X" (antes clear() apagava o "toque para
            // atender" e não sobrava NADA). Agendada p/ o fim da janela de toque
            // (dispara mesmo com o app suspenso); clear() antecipa/cancela.
            if CallResilience.flags().dndMissedNotif {
                postMissedNotification(callId: e.callId, callerName: e.callerName, callerEmail: e.callerEmail,
                                       conversationId: e.conversationId, hasVideo: e.hasVideo,
                                       after: 50, source: "dnd_scheduled")
            }
        }
        postPeerStatus(callId: callId, status: "dnd", reason: reason)
        return true
    }

    /// Ligação acabou (call_end / call_missed / cancel push / atendida): limpa
    /// o estado e a notificação "toque para atender".
    static func clear(callId: String, reason: String) {
        guard !callId.isEmpty else { return }
        lock.lock()
        let removed = entries.removeValue(forKey: callId)
        lock.unlock()
        let had = removed != nil
        let ud = UserDefaults(suiteName: appGroup)
        if let d = ud?.dictionary(forKey: persistKey), (d["callId"] as? String) == callId {
            ud?.removeObject(forKey: persistKey)
        }
        let nid = notificationId(callId)
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [nid])
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [nid])
        if had { nativeCallDiag("ring_filter_clear", callId, "reason=\(reason)") }
        // [2026-10-18 calls-data] Desfecho do toque filtrado: atendida/recusada
        // (aqui ou em outro aparelho) ou re-tocou → cancela a "perdida"
        // agendada; caller desistiu / perdida → posta já.
        let r = reason.lowercased()
        let notMissed = r.contains("answered") || r.contains("declined") || r.contains("rering_ok") || r.contains("accepted")
        if notMissed {
            let mid = missedNotificationId(callId)
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [mid])
        } else if let e = removed, CallResilience.flags().dndMissedNotif {
            postMissedNotification(callId: e.callId, callerName: e.callerName, callerEmail: e.callerEmail,
                                   conversationId: e.conversationId, hasVideo: e.hasVideo,
                                   after: 0, source: "dnd_" + reason)
        }
    }

    // MARK: - [2026-10-18 calls-data] "Chamada perdida de X" (local)

    private static func missedNotificationId(_ callId: String) -> String {
        return "chatyy_call_missed_\(callId)"
    }

    /// Local missed-call notification (same id per call → re-post replaces,
    /// never duplicates). `after` > 0 = scheduled (fires even if the app is
    /// suspended); 0 = now. Tap → conversation (pushNotifications.js
    /// `missed_call`). Used for Focus-filtered rings and stale VoIP pushes.
    static func postMissedNotification(callId: String, callerName: String, callerEmail: String,
                                       conversationId: String, hasVideo: Bool,
                                       after: TimeInterval, source: String) {
        guard !callId.isEmpty else { return }
        let name = callerName.isEmpty ? (callerEmail.isEmpty ? "Chatyy" : callerEmail) : callerName
        let c = UNMutableNotificationContent()
        c.title = name
        c.body = CallStrings.s(hasVideo ? "missedVideoCallFrom" : "missedCallFrom", ["name": name])
        c.sound = .default
        c.threadIdentifier = "chatyy_calls"
        c.interruptionLevel = .active
        c.userInfo = [
            "type": "missed_call",
            "call_id": callId,
            "caller_email": callerEmail,
            "caller_name": callerName,
            "conversation_id": conversationId,
            "video": hasVideo ? "1" : "0",
            "local": "1",
        ]
        let trigger: UNNotificationTrigger? = after > 0
            ? UNTimeIntervalNotificationTrigger(timeInterval: after, repeats: false)
            : nil
        let mid = missedNotificationId(callId)
        if after <= 0 {
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [mid])
        }
        let req = UNNotificationRequest(identifier: mid, content: c, trigger: trigger)
        UNUserNotificationCenter.current().add(req) { err in
            nativeCallDiag("missed_notif", callId,
                           "src=\(source) after=\(Int(after)) " + (err == nil ? "ok" : "err=\(err!.localizedDescription)"))
        }
    }

    /// Instalado no boot (VoipPushAppDelegateSubscriber.installOnce) e na 1ª
    /// recusa. Idempotente. MAIN THREAD.
    static func installActiveObserver() {
        if !Thread.isMainThread {
            DispatchQueue.main.async { installActiveObserver() }
            return
        }
        guard activeObserver == nil else { return }
        activeObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { _ in
            IncomingCallFilter.tryReRing(trigger: "became_active")
        }
    }

    // MARK: - Re-toque ao abrir o app

    private static func tryReRing(trigger: String) {
        if isDisabled() { return }
        let now = Date().timeIntervalSince1970
        var candidate: Entry?
        lock.lock()
        // Processo novo (app tinha morrido): recupera a última do App Group.
        if entries.isEmpty, let restored = restorePersisted() {
            entries[restored.callId] = restored
        }
        for (k, e) in entries {
            if now - e.at > reRingWindow {
                entries.removeValue(forKey: k)
                continue
            }
            if !e.reRingTried && (candidate == nil || e.at > candidate!.at) { candidate = e }
        }
        if var c = candidate {
            c.reRingTried = true
            entries[c.callId] = c
        }
        lock.unlock()
        guard let e = candidate else { return }
        UserDefaults(suiteName: appGroup)?.removeObject(forKey: persistKey)

        guard let provider = VoipPushAppDelegateSubscriber.earlyProvider else {
            nativeCallDiag("ring_rering_no_provider", e.callId, "trigger=\(trigger)")
            return
        }
        // Outro caminho (push/WS) já registrou OUTRA UUID p/ esta ligação → não duplica.
        let owner = ExpoCallKitModule.registerIncomingCallKitUUIDIfAbsent(e.uuid, forCallId: e.callId)
        if owner != e.uuid {
            nativeCallDiag("ring_rering_owned_elsewhere", e.callId, "uuid=\(owner.uuidString)")
            return
        }
        let name = e.callerName.isEmpty ? "Chatyy" : e.callerName
        var stub: [String: Any] = [
            "callId": e.callId,
            "call_id": e.callId,
            "callerName": name,
            "caller_name": e.callerName,
            "caller_email": e.callerEmail,
            "conversation_id": e.conversationId,
            "hasVideo": e.hasVideo,
            "video": e.hasVideo ? "1" : "0",
            "source": "rering",
        ]
        if !e.lkToken.isEmpty && !e.lkUrl.isEmpty {
            stub["lk_token"] = e.lkToken
            stub["lk_url"] = e.lkUrl
        }
        VoipPushAppDelegateSubscriber.stashAnswerPayload(uuid: e.uuid, callId: e.callId, payload: stub)

        let update = CXCallUpdate()
        if !e.callerPhone.isEmpty {
            update.remoteHandle = CXHandle(type: .phoneNumber, value: e.callerPhone)
        } else {
            update.remoteHandle = CXHandle(type: .generic, value: name)
        }
        update.localizedCallerName = name
        update.hasVideo = e.hasVideo
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsHolding = true
        update.supportsDTMF = false
        nativeCallDiag("ring_rering_try", e.callId, "trigger=\(trigger) ageMs=\(Int((now - e.at) * 1000))")
        provider.reportNewIncomingCall(with: e.uuid, update: update) { error in
            if let error = error {
                nativeCallDiag("ring_rering_failed", e.callId, "code=\((error as NSError).code)")
                return
            }
            nativeCallDiag("ring_rering_ok", e.callId)
            // Deixa de ser "filtrada" ANTES da pré-conexão (o guard dela consulta isto).
            clear(callId: e.callId, reason: "rering_ok")
            VoipPushAppDelegateSubscriber.armRingTimeout(uuid: e.uuid, callId: e.callId, provider: provider)
            let dict: [AnyHashable: Any] = [
                "call_id": e.callId,
                "lk_token": e.lkToken,
                "lk_url": e.lkUrl,
            ]
            VoipPushAppDelegateSubscriber.kickRingWindowPreconnect(callId: e.callId, dict: dict)
            postPeerStatus(callId: e.callId, status: "peer_ringing", reason: "rering")
            NotificationCenter.default.post(
                name: Notification.Name("ExpoCallKitPendingVoipCall"),
                object: nil,
                userInfo: [
                    "callId": e.callId,
                    "uuid": e.uuid.uuidString,
                    "callerName": name,
                    "hasVideo": e.hasVideo,
                    "payload": stub,
                ]
            )
        }
    }

    // MARK: - Servidor / notificação

    /// call_status dnd | peer_ringing → servidor repassa `call_peer_status` ao
    /// caller (patch /root/chamadas-dnd-servidor.sh). Servidor antigo responde
    /// 400 — inofensivo. Roda dentro de background task (pode ser no push).
    static func postPeerStatus(callId: String, status: String, reason: String) {
        guard !callId.isEmpty,
              let ud = UserDefaults(suiteName: appGroup),
              let token = ud.string(forKey: "auth_token"), !token.isEmpty,
              let base0 = ud.string(forKey: "api_base"), !base0.isEmpty else {
            nativeCallDiag("peer_status_skip_noauth", callId, "status=\(status)")
            return
        }
        let base = base0.hasSuffix("/") ? String(base0.dropLast()) : base0
        guard let url = URL(string: "\(base)/api/email.php?action=call_status") else { return }
        var req = URLRequest(url: url, timeoutInterval: 8.0)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "action": "call_status", "call_id": callId, "status": status, "reason": reason, "duration": 0,
        ])
        DispatchQueue.main.async {
            var bg: UIBackgroundTaskIdentifier = .invalid
            bg = UIApplication.shared.beginBackgroundTask(withName: "chatyy_peer_status") {
                if bg != .invalid { UIApplication.shared.endBackgroundTask(bg); bg = .invalid }
            }
            URLSession.shared.dataTask(with: req) { _, resp, _ in
                let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
                nativeCallDiag("peer_status_http", callId, "status=\(status) code=\(code)")
                DispatchQueue.main.async {
                    if bg != .invalid { UIApplication.shared.endBackgroundTask(bg); bg = .invalid }
                }
            }.resume()
        }
    }

    private static func notificationId(_ callId: String) -> String {
        return "chatyy_call_filtered_\(callId)"
    }

    private static func postLocalNotification(_ e: Entry) {
        let name = e.callerName.isEmpty ? (e.callerEmail.isEmpty ? "Chatyy" : e.callerEmail) : e.callerName
        let c = UNMutableNotificationContent()
        c.title = name
        c.body = CallStrings.s("dndIncomingBody", ["name": name])
        c.sound = .default
        c.threadIdentifier = "chatyy_calls"
        // Time Sensitive exige a capability no App ID + perfil novo (o
        // credentials/chatyy-main.mobileprovision atual NÃO tem) → nível ativo.
        c.interruptionLevel = .active
        c.userInfo = [
            "type": "call_filtered",
            "call_id": e.callId,
            "caller_email": e.callerEmail,
            "caller_name": e.callerName,
            "conversation_id": e.conversationId,
            "video": e.hasVideo ? "1" : "0",
        ]
        let req = UNNotificationRequest(identifier: notificationId(e.callId), content: c, trigger: nil)
        UNUserNotificationCenter.current().add(req) { err in
            nativeCallDiag("ring_filter_notif", e.callId, err == nil ? "ok" : "err=\(err!.localizedDescription)")
        }
    }

    // MARK: - Persistência (re-toque após o processo morrer)

    private static func persist(_ e: Entry) {
        let d: [String: Any] = [
            "callId": e.callId, "uuid": e.uuid.uuidString, "callerName": e.callerName,
            "callerEmail": e.callerEmail, "callerPhone": e.callerPhone,
            "conversationId": e.conversationId, "hasVideo": e.hasVideo,
            "lkToken": e.lkToken, "lkUrl": e.lkUrl, "at": e.at,
        ]
        UserDefaults(suiteName: appGroup)?.set(d, forKey: persistKey)
    }

    /// Chamar com `lock` adquirido.
    private static func restorePersisted() -> Entry? {
        guard let d = UserDefaults(suiteName: appGroup)?.dictionary(forKey: persistKey),
              let callId = d["callId"] as? String, !callId.isEmpty,
              let us = d["uuid"] as? String, let uuid = UUID(uuidString: us),
              let at = d["at"] as? Double else { return nil }
        return Entry(callId: callId, uuid: uuid,
                     callerName: (d["callerName"] as? String) ?? "",
                     callerEmail: (d["callerEmail"] as? String) ?? "",
                     callerPhone: (d["callerPhone"] as? String) ?? "",
                     conversationId: (d["conversationId"] as? String) ?? "",
                     hasVideo: (d["hasVideo"] as? Bool) ?? false,
                     lkToken: (d["lkToken"] as? String) ?? "",
                     lkUrl: (d["lkUrl"] as? String) ?? "",
                     at: at, reRingTried: false)
    }
}
