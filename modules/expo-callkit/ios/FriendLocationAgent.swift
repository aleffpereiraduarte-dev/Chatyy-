import Foundation
import CoreLocation
import UIKit

/// [2026-10-12 find-my] Mapa de amigos com o app FECHADO (iOS), estilo Find My.
///
/// Dono 100% nativo do envio em 2º plano para quem tem ≥1 compartilhamento
/// ativo no Mapa de amigos (ou localização ao vivo da conversa):
///
///   • startMonitoringSignificantLocationChanges — ~500 m / poucos minutos,
///     usa só torre/Wi-Fi (bateria quase zero). O iOS RELANÇA o app em 2º plano
///     (launchOptions[.location]) mesmo depois de ele ter sido encerrado pelo
///     sistema. Exceção da Apple: se o usuário encerrar o app à força no
///     seletor de apps, o iOS não relança até o app ser aberto de novo.
///   • startMonitoringVisits — chegada/saída de lugares (casa, trabalho).
///   • ping silencioso ("Pedir atualização" de um amigo) → requestLocation()
///     uma vez (FriendLocationAppDelegateSubscriber).
///
/// Cada posição vira POST direto em Swift para
/// email.php?action=chat_friend_location_share_update com o bearer do App
/// Group (o mesmo que ChatBgJournal / RelayWake usam — gravado pelo JS em
/// persistAuthForNativeCall). Não depende do JS acordar.
///
/// Liga/desliga: o JS (services/nativeFriendLocation.js) chama start/stop
/// quando as razões mudam (friend_map_share_active / live_location_active /
/// modo fantasma). O estado fica no App Group (fl_enabled) para sobreviver ao
/// relançamento. Modo fantasma = o JS chama stop → nenhum envio nativo.
final class FriendLocationAgent: NSObject, CLLocationManagerDelegate {
    static let shared = FriendLocationAgent()
    static let appGroupId = "group.com.onemundo.mail"

    private enum K {
        static let enabled = "fl_enabled"
        static let armed = "fl_armed"           // monitoramento foi ligado alguma vez → desligar no próximo launch se fl_enabled=false
        static let acct = "fl_acct"
        static let lastPostAt = "fl_last_post_at"
        static let lastResult = "fl_last_result"
        static let lastEventAt = "fl_last_event_at"
    }

    /// Intervalo mínimo entre envios automáticos (mudança significativa/visita).
    private let minGapSeconds: TimeInterval = 60
    /// Posição cacheada aceitável quando o requestLocation do ping falha.
    private let pingCacheMaxAge: TimeInterval = 180
    private let pingTimeoutSeconds: TimeInterval = 20

    private var manager: CLLocationManager?
    private var monitoring = false
    private var pingWaiters: [(Bool) -> Void] = []
    private var pingTimeout: DispatchWorkItem?
    private var pingBgTask: UIBackgroundTaskIdentifier = .invalid

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 15
        c.timeoutIntervalForResource = 20
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    private var ud: UserDefaults? { UserDefaults(suiteName: Self.appGroupId) }
    var isEnabled: Bool { ud?.bool(forKey: K.enabled) ?? false }

    static func onMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
    }

    /// CLLocationManager precisa nascer numa thread com run loop (main) para o
    /// delegate receber eventos — sempre chamado dentro de onMain.
    private func mgr() -> CLLocationManager {
        if let m = manager { return m }
        let m = CLLocationManager()
        m.delegate = self
        m.desiredAccuracy = kCLLocationAccuracyHundredMeters
        m.activityType = .other
        manager = m
        return m
    }

    // MARK: - Estado (seguro fora da main — não cria CLLocationManager)

    static func authString() -> String {
        let st: CLAuthorizationStatus = CLLocationManager().authorizationStatusCompat()
        switch st {
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "whenInUse"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "undetermined"
        @unknown default: return "unknown"
        }
    }

    func status() -> [String: Any] {
        let u = ud
        return [
            "enabled": u?.bool(forKey: K.enabled) ?? false,
            "monitoring": monitoring,
            "auth": Self.authString(),
            "significantAvailable": CLLocationManager.significantLocationChangeMonitoringAvailable(),
            "lastPostAt": u?.double(forKey: K.lastPostAt) ?? 0,
            "lastEventAt": u?.double(forKey: K.lastEventAt) ?? 0,
            "lastResult": u?.string(forKey: K.lastResult) ?? "",
        ]
    }

    // MARK: - Liga / desliga

    func enable(acct: String) {
        ud?.set(true, forKey: K.enabled)
        ud?.set(true, forKey: K.armed)
        if !acct.isEmpty { ud?.set(acct.lowercased(), forKey: K.acct) }
        Self.onMain { self.resume() }
    }

    func disable() {
        ud?.set(false, forKey: K.enabled)
        Self.onMain {
            self.stopMonitoring()
            self.finishPing(false)
        }
    }

    /// AppDelegate didFinishLaunching (inclusive relançamento por evento de
    /// localização com o app morto). Precisa recriar o manager e religar o
    /// monitoramento para o iOS entregar o evento que causou o relançamento.
    func onLaunch(relaunchedForLocation: Bool) {
        let u = ud
        let enabled = u?.bool(forKey: K.enabled) ?? false
        let armed = u?.bool(forKey: K.armed) ?? false
        if !enabled && !armed && !relaunchedForLocation { return } // nunca usado: não toca no CoreLocation
        Self.onMain {
            if enabled {
                self.resume()
            } else {
                // Desligado enquanto o app estava morto (ou relançado sem
                // razão): garante que o iOS pare de nos acordar.
                self.stopMonitoring()
                u?.set(false, forKey: K.armed)
            }
        }
    }

    private func resume() {
        guard isEnabled else { return }
        guard CLLocationManager.significantLocationChangeMonitoringAvailable() else {
            ud?.set("sig_unavailable", forKey: K.lastResult)
            return
        }
        let m = mgr()
        let st = m.authorizationStatusCompat()
        // Com "Durante o uso" o iOS só entrega com o app em uso; com "Sempre"
        // entrega e relança em 2º plano. Ligamos nos dois (barato) — o JS
        // mostra o aviso de "Permitir sempre" quando não for Always.
        guard st == .authorizedAlways || st == .authorizedWhenInUse else {
            ud?.set("no_permission", forKey: K.lastResult)
            return
        }
        if monitoring { return }
        m.startMonitoringSignificantLocationChanges()
        m.startMonitoringVisits()
        monitoring = true
    }

    private func stopMonitoring() {
        let m = mgr()
        m.stopMonitoringSignificantLocationChanges()
        m.stopMonitoringVisits()
        monitoring = false
    }

    // MARK: - Ping ("Pedir atualização" → push silencioso)

    /// Pede UMA posição e publica. `completion` sempre é chamado (≤ ~20 s),
    /// na main thread.
    func handlePing(completion: @escaping (Bool) -> Void) {
        Self.onMain {
            guard self.isEnabled else { completion(false); return }
            let m = self.mgr()
            let st = m.authorizationStatusCompat()
            let active = UIApplication.shared.applicationState == .active
            guard st == .authorizedAlways || (st == .authorizedWhenInUse && active) else {
                self.ud?.set("ping_no_always", forKey: K.lastResult)
                completion(false); return
            }
            // Acabou de publicar (< 45 s) → o mapa do amigo já está fresco.
            let last = self.ud?.double(forKey: K.lastPostAt) ?? 0
            if Date().timeIntervalSince1970 - last < 45 { completion(true); return }

            self.pingWaiters.append(completion)
            if self.pingWaiters.count > 1 { return } // já há um requestLocation em voo

            self.pingBgTask = UIApplication.shared.beginBackgroundTask(withName: "FriendLocationPing") { [weak self] in
                self?.finishPing(false)
            }
            let to = DispatchWorkItem { [weak self] in
                guard let self = self, !self.pingWaiters.isEmpty else { return }
                if let l = self.manager?.location, -l.timestamp.timeIntervalSinceNow < self.pingCacheMaxAge {
                    self.publish(l, forced: true)
                } else {
                    self.ud?.set("ping_timeout", forKey: K.lastResult)
                    self.finishPing(false)
                }
            }
            self.pingTimeout = to
            DispatchQueue.main.asyncAfter(deadline: .now() + self.pingTimeoutSeconds, execute: to)
            m.desiredAccuracy = kCLLocationAccuracyHundredMeters
            m.requestLocation()
        }
    }

    private func finishPing(_ ok: Bool) {
        pingTimeout?.cancel()
        pingTimeout = nil
        let waiters = pingWaiters
        pingWaiters = []
        for w in waiters { w(ok) }
        if pingBgTask != .invalid {
            UIApplication.shared.endBackgroundTask(pingBgTask)
            pingBgTask = .invalid
        }
    }

    // MARK: - CLLocationManagerDelegate (main thread)

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        ud?.set(Date().timeIntervalSince1970, forKey: K.lastEventAt)
        publish(loc, forced: !pingWaiters.isEmpty)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard !pingWaiters.isEmpty else { return }
        if let l = manager.location, -l.timestamp.timeIntervalSinceNow < pingCacheMaxAge {
            publish(l, forced: true)
        } else {
            ud?.set("ping_fail", forKey: K.lastResult)
            finishPing(false)
        }
    }

    func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        let c = visit.coordinate
        guard CLLocationCoordinate2DIsValid(c), c.latitude != 0 || c.longitude != 0 else { return }
        ud?.set(Date().timeIntervalSince1970, forKey: K.lastEventAt)
        let loc = CLLocation(coordinate: c, altitude: 0,
                             horizontalAccuracy: max(visit.horizontalAccuracy, 0),
                             verticalAccuracy: -1, timestamp: Date())
        publish(loc, forced: false)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if isEnabled {
            monitoring = false
            resume()
        }
    }

    // MARK: - Envio

    private func publish(_ loc: CLLocation, forced: Bool) {
        guard isEnabled else { finishPing(false); return }
        guard loc.horizontalAccuracy >= 0, loc.horizontalAccuracy <= 5000 else {
            if forced { finishPing(false) }
            return
        }
        // Fix velho (> 10 min) não vira "atualizado agora" no mapa do amigo.
        if -loc.timestamp.timeIntervalSinceNow > 600 {
            if forced { finishPing(false) }
            return
        }
        let now = Date().timeIntervalSince1970
        if !forced {
            let last = ud?.double(forKey: K.lastPostAt) ?? 0
            if now - last < minGapSeconds { return }
        }
        ud?.set(now, forKey: K.lastPostAt)
        post(loc) { [weak self] ok in
            Self.onMain {
                self?.ud?.set(ok ? "ok" : "post_fail", forKey: K.lastResult)
                if forced { self?.finishPing(ok) }
            }
        }
    }

    /// [2026-10-24 mapa-v2] (nível 0-100, carregando) — nil se o iOS não informar.
    static func battery() -> (level: Int, charging: Bool)? {
        let read: () -> (level: Int, charging: Bool)? = {
            let d = UIDevice.current
            if !d.isBatteryMonitoringEnabled { d.isBatteryMonitoringEnabled = true }
            let lv = d.batteryLevel
            if lv < 0 { return nil }
            return (Int((lv * 100).rounded()), d.batteryState == .charging || d.batteryState == .full)
        }
        if Thread.isMainThread { return read() }
        // Fora da main (função síncrona do JS / URLSession): sem main.sync (risco de
        // trava); liga o monitor na main e lê o valor atual (-1 na 1ª vez → nil).
        let d = UIDevice.current
        if !d.isBatteryMonitoringEnabled { DispatchQueue.main.async { d.isBatteryMonitoringEnabled = true } }
        let lv = d.batteryLevel
        if lv < 0 { return nil }
        return (Int((lv * 100).rounded()), d.batteryState == .charging || d.batteryState == .full)
    }

    private func post(_ loc: CLLocation, done: @escaping (Bool) -> Void) {
        guard let u = ud, let bearer = u.string(forKey: "auth_token"), !bearer.isEmpty else { done(false); return }
        var base = u.string(forKey: "api_base") ?? "https://chatyy.com.br"
        if !base.hasPrefix("https://") { base = "https://chatyy.com.br" }
        while base.hasSuffix("/") { base.removeLast() }
        guard let url = URL(string: base + "/api/email.php?action=chat_friend_location_share_update") else { done(false); return }
        var body: [String: Any] = [
            "action": "chat_friend_location_share_update",
            "latitude": loc.coordinate.latitude,
            "longitude": loc.coordinate.longitude,
            "accuracy": loc.horizontalAccuracy,
            "source": "ios_native",
        ]
        if loc.course >= 0 { body["heading"] = loc.course }
        if loc.speed >= 0 { body["speed"] = loc.speed }
        // [2026-10-24 mapa-v2] bateria p/ o cartão do amigo (servidor antigo ignora)
        if let b = Self.battery() { body["battery"] = b.level; body["charging"] = b.charging ? 1 : 0 }
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { done(false); return }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization")
        req.httpBody = data

        // ~30 s de execução garantida mesmo se o iOS nos relançou em 2º plano.
        let bg = BgTaskBox()
        Self.onMain {
            bg.id = UIApplication.shared.beginBackgroundTask(withName: "FriendLocationPost") { bg.end() }
        }
        Self.session.dataTask(with: req) { respData, resp, err in
            var ok = false
            if err == nil, let code = (resp as? HTTPURLResponse)?.statusCode, (200..<300).contains(code),
               let d = respData,
               let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
                ok = (j["success"] as? Bool) == true
            }
            NSLog("[FriendLocation] post ok=%@", ok ? "1" : "0")
            done(ok)
            Self.onMain { bg.end() }
        }.resume()
    }

    /// Ping push? Aceita o formato APNs direto (type no topo), o do Expo
    /// (dados em "body" dict) e "body" como string JSON.
    static func isPingPush(_ userInfo: [AnyHashable: Any]) -> Bool {
        if (userInfo["type"] as? String) == "location_ping" { return true }
        if let b = userInfo["body"] as? [String: Any], (b["type"] as? String) == "location_ping" { return true }
        if let s = userInfo["body"] as? String, let d = s.data(using: .utf8),
           let b = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
           (b["type"] as? String) == "location_ping" { return true }
        return false
    }
}

/// Caixa para o id do beginBackgroundTask (capturado pelo expirationHandler e
/// pela conclusão da request). Só usado na main thread.
private final class BgTaskBox {
    var id: UIBackgroundTaskIdentifier = .invalid
    func end() {
        if id != .invalid {
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
    }
}

extension CLLocationManager {
    /// authorizationStatus de instância (iOS 14+) — o target do pod é 15.1.
    func authorizationStatusCompat() -> CLAuthorizationStatus {
        return self.authorizationStatus
    }
}
