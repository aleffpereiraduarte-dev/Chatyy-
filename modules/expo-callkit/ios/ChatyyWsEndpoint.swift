import Foundation

/// [2026-10-09 native-transport] Entrada REGIONAL do WebSocket para os sockets
/// nativos (ChatCoreSocket, CallSignalWs, RelayWake) — mesma regra do JS
/// (services/websocket.js `_pickWsUrl`):
///   - o JS escolhe a região (services/api.js: region_hint + probe com
///     histerese) e a repassa via ChatyyChatCore.setWsRegion("us"|"br"|"eu");
///     guardada no App Group → vale também no cold start por push (RelayWake),
///     quando o JS ainda não rodou;
///   - br/eu → wss://api-<região>.chatyy.com.br/ws (TLS termina no edge, que
///     leva o upgrade pelo túnel WireGuard até o MESMO hub Go do US);
///   - fallback: socket regional que fecha sem auth_success → a próxima
///     tentativa vai pro US; se o US autenticar logo em seguida (= problema
///     era do edge) a regional fica bloqueada 15 min. Se o US também falhar
///     (= rede), volta a tentar a regional.
/// Só hosts fixos (sem URL arbitrária vinda do JS). Thread-safe.
enum ChatyyWsEndpoint {
    static let usURL = URL(string: "wss://ws.chatyy.com.br/ws")!
    private static let regionalURLs: [String: URL] = [
        "br": URL(string: "wss://api-br.chatyy.com.br/ws")!,
        "eu": URL(string: "wss://api-eu.chatyy.com.br/ws")!,
    ]
    private static let appGroupId = "group.com.onemundo.mail"
    private static let regionKey = "chatyy_ws_region"
    private static let blockSeconds: TimeInterval = 15 * 60

    private static let lock = NSLock()
    private static var blockedUntil = Date.distantPast
    private static var failPending = false

    /// Chamado pelo JS (ChatyyChatCore.setWsRegion). Região desconhecida → "us".
    static func setRegion(_ region: String) {
        let r = region.lowercased()
        let v = regionalURLs[r] != nil ? r : "us"
        UserDefaults(suiteName: appGroupId)?.set(v, forKey: regionKey)
    }

    static func region() -> String {
        return UserDefaults(suiteName: appGroupId)?.string(forKey: regionKey) ?? "us"
    }

    /// URL para a PRÓXIMA conexão.
    static func pick() -> URL {
        lock.lock(); defer { lock.unlock() }
        if failPending || Date() < blockedUntil { return usURL }
        return regionalURLs[region()] ?? usURL
    }

    static func isRegional(_ url: URL?) -> Bool {
        guard let u = url else { return false }
        return u.host != usURL.host
    }

    /// Socket em `url` fechou/falhou ANTES do auth_success.
    static func noteFailedBeforeAuth(_ url: URL?) {
        lock.lock(); defer { lock.unlock() }
        if isRegional(url) {
            failPending = true
        } else if failPending {
            failPending = false // US também falhou → rede, não o edge
        }
    }

    /// Socket em `url` recebeu auth_success.
    static func noteAuthed(_ url: URL?) {
        lock.lock(); defer { lock.unlock() }
        if !isRegional(url) && failPending {
            blockedUntil = Date().addingTimeInterval(blockSeconds)
            NSLog("[ChatyyWsEndpoint] regional falhou e US autenticou → regional bloqueada 15 min")
        }
        failPending = false
    }

    static func snapshot() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return [
            "region": region(),
            "failPending": failPending,
            "blockedUntilMs": blockedUntil == Date.distantPast ? 0 : blockedUntil.timeIntervalSince1970 * 1000,
        ]
    }
}
