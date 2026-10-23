import Foundation
import CallKit

/// [2026-10-09 native-transport] Entrada REGIONAL do WebSocket para os sockets
/// nativos (ChatCoreSocket, CallSignalWs, RelayWake) — mesma regra do JS
/// (services/websocket.js `_pickWsUrl`):
///   - o JS escolhe a região (services/api.js / clientLb.js) e a repassa via
///     ChatyyChatCore.setWsRegion("us"|"br"|"eu") (API 1) ou
///     ChatyyChatCore.setWsEndpoint(region, url) (API 2, qualquer região válida);
///     guardada no App Group → vale também no cold start por push (RelayWake),
///     quando o JS ainda não rodou;
///   - regional → wss://api-<id>.chatyy.com.br/ws (TLS termina no edge);
///   - fallback: socket regional que fecha sem auth_success → a próxima
///     tentativa vai pro US; se o US autenticar logo em seguida (= problema
///     era do edge) AQUELA entrada regional fica bloqueada 15 min (bloqueio
///     POR host, como o websocket.js com client-lb). Se o US também falhar
///     (= rede), volta a tentar a regional.
/// [2026-10-21 any-region] URL vinda do JS só é aceita se passar validação
/// estrita (isValidWsURL): wss, host ws.chatyy.com.br ou
/// api-<id>.chatyy.com.br (id ^[a-z][a-z0-9]{1,7}$), caminho /ws, sem
/// porta/userinfo/query/fragmento. Thread-safe.
enum ChatyyWsEndpoint {
    /// Versão da API exposta ao JS (ChatyyChatCore.wsEndpointApi()).
    /// 1 = só setWsRegion(br|eu|us); 2 = + setWsEndpoint(region, url);
    /// 3 = [2026-10-22 ws-migrate] sockets nativos trocam de região sozinhos quando o JS grava
    ///     (o JS para de reconectar o fio nativo para seguir o client-lb).
    static let apiVersion = 3

    static let usURL = URL(string: "wss://ws.chatyy.com.br/ws")!
    private static let regionalURLs: [String: URL] = [
        "br": URL(string: "wss://api-br.chatyy.com.br/ws")!,
        "eu": URL(string: "wss://api-eu.chatyy.com.br/ws")!,
    ]
    private static let appGroupId = "group.com.onemundo.mail"
    private static let regionKey = "chatyy_ws_region"
    private static let urlKey = "chatyy_ws_url" // API 2 (vazio = mapa fixo da API 1)
    private static let blockSeconds: TimeInterval = 15 * 60

    private static let lock = NSLock()
    /// host regional → bloqueado até
    private static var blockedUntil: [String: Date] = [:]
    /// host regional que falhou antes do auth (aguardando o resultado do US)
    private static var failPendingHost: String? = nil

    // MARK: - Validação

    private static let regionPattern = "\\A(us|[a-z][a-z0-9]{1,7})\\z"
    private static let urlPattern =
        "\\Awss://(ws\\.chatyy\\.com\\.br|api-[a-z][a-z0-9]{1,7}\\.chatyy\\.com\\.br)/ws\\z"

    static func isValidRegion(_ r: String) -> Bool {
        return r.count <= 8 && r.range(of: regionPattern, options: .regularExpression) != nil
    }

    /// Validação estrita da URL (string inteira + conferência pelos componentes).
    static func isValidWsURL(_ s: String) -> Bool {
        guard s.count <= 64, s.range(of: urlPattern, options: .regularExpression) != nil,
              let c = URLComponents(string: s) else { return false }
        return c.scheme == "wss" && c.port == nil && c.user == nil && c.password == nil
            && c.query == nil && c.fragment == nil && c.path == "/ws"
            && (c.host == "ws.chatyy.com.br" || (c.host?.hasPrefix("api-") == true && c.host?.hasSuffix(".chatyy.com.br") == true))
    }

    // MARK: - Escrita (JS)

    /// API 1 (compat): ChatyyChatCore.setWsRegion. Região desconhecida → "us".
    /// Limpa a URL da API 2 → comportamento idêntico ao binário antigo.
    static func setRegion(_ region: String) {
        let r = region.lowercased()
        let v = regionalURLs[r] != nil ? r : "us"
        let before = pick()
        let d = UserDefaults(suiteName: appGroupId)
        d?.set(v, forKey: regionKey)
        d?.removeObject(forKey: urlKey)
        notifyIfChanged(before)
    }

    /// API 2: ChatyyChatCore.setWsEndpoint(region, url). Inválido → false e
    /// nada muda. region "us" (ou URL do US) → volta ao US.
    @discardableResult
    static func setEndpoint(_ region: String, _ url: String) -> Bool {
        let r = region.lowercased()
        guard isValidRegion(r), isValidWsURL(url) else { return false }
        let before = pick()
        defer { notifyIfChanged(before) }
        let d = UserDefaults(suiteName: appGroupId)
        if r == "us" || url == usURL.absoluteString {
            d?.set("us", forKey: regionKey)
            d?.removeObject(forKey: urlKey)
        } else {
            d?.set(r, forKey: regionKey)
            d?.set(url, forKey: urlKey)
        }
        return true
    }

    // MARK: - [2026-10-22 ws-migrate] Aviso de troca de região

    /// Postada (fila qualquer) sempre que o JS grava a região
    /// (setRegion/setEndpoint), e quando a última ligação
    /// do aparelho termina (sockets que adiaram a troca reavaliam).
    /// ChatCoreSocket / CallSignalWs observam e fazem a troca suave (abre o
    /// novo, autentica, resume, fecha o velho) se ociosos e fora de ligação.
    /// RelayWake não observa: sessão efêmera (janela de segundos) que já usa
    /// pick() a cada despertar.
    static let changedNotification = Notification.Name("ChatyyWsEndpointChanged")

    private static func notifyIfChanged(_ before: URL) {
        let after = pick()
        if after.absoluteString != before.absoluteString {
            NSLog("[ChatyyWsEndpoint] endpoint %@ → %@ — avisando sockets nativos", before.host ?? "?", after.host ?? "?")
        }
        // Sempre avisa: cada socket compara o host em que ESTÁ com pick()
        // (pode ter ficado numa região antiga mesmo sem a escolha mudar agora).
        NotificationCenter.default.post(name: changedNotification, object: nil)
    }

    /// true = há ligação (CallKit) ativa, saindo ou tocando neste aparelho →
    /// sockets NÃO trocam de região agora (adiam até acabar).
    static func callBusy() -> Bool {
        return ChatyyCallBusyObserver.shared.busy()
    }

    /// Mesmo host? (troca só quando o host muda de verdade)
    static func sameHost(_ a: URL?, _ b: URL?) -> Bool {
        guard let ha = a?.host, let hb = b?.host else { return false }
        return ha == hb
    }

    // MARK: - Leitura

    static func region() -> String {
        return UserDefaults(suiteName: appGroupId)?.string(forKey: regionKey) ?? "us"
    }

    /// URL regional configurada (sem fallback/bloqueio). nil = US.
    private static func configuredURL() -> URL? {
        let d = UserDefaults(suiteName: appGroupId)
        if let s = d?.string(forKey: urlKey), !s.isEmpty {
            // revalida o que veio do disco
            guard isValidWsURL(s), let u = URL(string: s), u.host != usURL.host else { return nil }
            return u
        }
        return regionalURLs[region()]
    }

    /// URL para a PRÓXIMA conexão. Chamar com lock.
    private static func pickLocked() -> URL {
        guard let u = configuredURL(), let h = u.host else { return usURL }
        if failPendingHost == h { return usURL }
        if let until = blockedUntil[h], Date() < until { return usURL }
        return u
    }

    static func pick() -> URL {
        lock.lock(); defer { lock.unlock() }
        return pickLocked()
    }

    static func isRegional(_ url: URL?) -> Bool {
        guard let u = url else { return false }
        return u.host != usURL.host
    }

    /// Socket em `url` fechou/falhou ANTES do auth_success.
    static func noteFailedBeforeAuth(_ url: URL?) {
        lock.lock(); defer { lock.unlock() }
        if isRegional(url) {
            failPendingHost = url?.host ?? failPendingHost
        } else if failPendingHost != nil {
            failPendingHost = nil // US também falhou → rede, não o edge
        }
    }

    /// Socket em `url` recebeu auth_success.
    static func noteAuthed(_ url: URL?) {
        lock.lock(); defer { lock.unlock() }
        if !isRegional(url), let h = failPendingHost {
            blockedUntil[h] = Date().addingTimeInterval(blockSeconds)
            NSLog("[ChatyyWsEndpoint] regional %@ falhou e US autenticou → bloqueada 15 min", h)
        }
        failPendingHost = nil
    }

    static func snapshot() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let now = Date()
        let cur = configuredURL()
        var maxBlock: TimeInterval = 0
        var blocked: [String: Double] = [:]
        for (h, until) in blockedUntil where until > now {
            blocked[h] = until.timeIntervalSince1970 * 1000
            if let ch = cur?.host, ch == h { maxBlock = until.timeIntervalSince1970 * 1000 }
        }
        return [
            "api": apiVersion,
            "region": region(),
            "configuredUrl": (cur ?? usURL).absoluteString,
            "failPending": failPendingHost != nil,
            "blockedUntilMs": maxBlock,
            "blocked": blocked,
            "url": pickLocked().absoluteString,
        ]
    }
}

/// [2026-10-22 ws-migrate] Observa o CallKit: quantas ligações não terminadas
/// existem (tocando, saindo, em curso — de qualquer app). Quando a última
/// termina, posta ChatyyWsEndpoint.changedNotification → sockets que adiaram a
/// troca de região reavaliam.
final class ChatyyCallBusyObserver: NSObject, CXCallObserverDelegate {
    static let shared = ChatyyCallBusyObserver()
    private let observer = CXCallObserver()
    private let lock = NSLock()
    private var wasBusy = false

    private override init() {
        super.init()
        observer.setDelegate(self, queue: nil)
    }

    func busy() -> Bool {
        let b = observer.calls.contains(where: { !$0.hasEnded })
        lock.lock(); wasBusy = wasBusy || b; lock.unlock()
        return b
    }

    func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
        let b = callObserver.calls.contains(where: { !$0.hasEnded })
        lock.lock()
        let fire = wasBusy && !b
        wasBusy = b
        lock.unlock()
        if fire {
            // pequena folga: CallSignalWs ainda pode estar mandando call_end
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                NotificationCenter.default.post(name: ChatyyWsEndpoint.changedNotification, object: nil)
            }
        }
    }
}
