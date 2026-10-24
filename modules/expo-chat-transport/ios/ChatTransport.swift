import Foundation
import Network
import UIKit
import CryptoKit
import ExpoChatStore

/// [2026-10-15 native-transport] Transporte realtime NATIVO do Chatyy (gêmeo de
/// ChatTransport.kt — ver o comentário de lá para o desenho completo).
///
/// O JS (services/websocket.js) enxerga isto como um WebSocket "lógico" que não
/// cai quando o fio físico cai: aqui moram conexão + auth automático em toda
/// reconexão, ping de app + detecção de zumbi, reconexão com backoff+jitter
/// imediata na troca de rede (NWPathMonitor) e na volta ao primeiro plano,
/// entrada regional com queda para a US, fila de saída enquanto caído e entrega
/// dos frames recebidos em LOTE ao JS. Fechamentos 4000-4999 do hub são decisão
/// de negócio → close do socket lógico (o JS decide).
///
/// Todo estado vive na fila serial `q` (inclusive os delegates do URLSession,
/// cuja delegateQueue roda em cima de `q`) → sem locks.
final class ChatTransport {
  static let shared = ChatTransport()
  // 2 = [2026-10-15 fase 2b/4] grava frames no store nativo (storeIngest) +
  //     fila de envio nativa (outbox*) + conta da sessão.
  // 3 = [2026-10-18 outbox-progress] onOutboxState "progress" (bytes reais do
  //     upload) + fallback do upload regional → origem US após 2 falhas.
  // v4 (2026-10-18): HTTP 400/401/403 no upgrade é terminal na 1ª recusa
  // (evento handshake_rejected + close 4400/4401). JS lê via version().
  // v5 (2026-10-19 resume-reuse/adaptive): volta do 2º plano < bgStaleMs (JS manda
  // 75 s) SONDA o socket em vez de derrubar; prazos de handshake/auth adaptativos
  // (RTT, duração do último handshake, timeouts seguidos); 'authed' traz
  // hsMs/connectMs/authMs. Kill switch: cfg adaptiveTimeouts=false / bgStaleMs=20000.
  // v6 (2026-10-19 bg-grace/resume): (a) graça de 2º plano — beginBackgroundTask
  //     segura o processo ~28 s com o socket autenticado (troca rápida de app não
  //     mata o fio; o iOS só "defuncta" o socket quando SUSPENDE o app → era o
  //     'Software caused connection abort' da telemetria); (b) volta: dentro da graça
  //     / < bgStaleMs / frame recebido há < 30 s → 1 ping e reusa; stale só se a
  //     sonda falhar ou > bgStaleMs; evento 'resume' {kept, probeMs, reason, bgMs,
  //     grace}; (c) DNS pré-resolvido no willEnterForeground / troca de rede;
  //     (d) URLSession compartilhada (retomada de sessão TLS) — renovada na troca de
  //     rede / falha antes do open / idade; (e) 1ª tentativa com prazo curto (≥ 4 s)
  //     quando o último handshake na MESMA rede foi rápido.
  //     Tudo atrás de chaves do cfg que o JS manda (binário v6 + JS antigo = v5):
  //     bgGrace (kill switch JS __chatyy_ws_bg_grace=false), dnsPrewarm,
  //     reuseSession, fastFirst.
  static let version = 6
  /// [ka-adapt 2026-10-24] teto do intervalo de ping de app (JS: kaCaps().maxMs; binário antigo = 120 s).
  static let kaMaxMs: Double = 300000

  let q = DispatchQueue(label: "chatyy.transport", qos: .userInitiated)
  private lazy var opQueue: OperationQueue = {
    let o = OperationQueue()
    o.maxConcurrentOperationCount = 1
    o.underlyingQueue = q
    o.name = "chatyy.transport.delegate"
    return o
  }()

  /// (eventName, body) → Module.sendEvent. Setado no OnCreate.
  var emitter: ((String, [String: Any?]) -> Void)?

  private var inited = false
  private var session: TransportSession?

  fileprivate(set) var foreground = true
  fileprivate(set) var netUp = true
  private var monitor: NWPathMonitor?
  private var pathInited = false
  private var primaryIface: String?
  private var pendingPath: NWPath?
  private var pathWork: DispatchWorkItem?

  // Fallback regional→US (por processo, como no JS).
  var regionalFailPending = false
  var regionalBlockedUntil: Double = 0

  private(set) var stats: [String: Int64] = [:]

  private var bgTask: UIBackgroundTaskIdentifier = .invalid
  /// [v6] ciclo de 2º plano (só main thread): timer/expiração de um ciclo velho
  /// nunca encerra a task de um ciclo novo.
  private var mainBgCycle: Int = 0

  // [v6] knobs de processo (do cfg da sessão mais recente; só na fila q).
  private var bgGraceOn = false
  private var bgGraceMs: Double = 28000
  private var dnsPrewarmOn = false
  private var reuseSessionOn = false
  /// [v6] graça de 2º plano em curso (processo ainda rodando) — fila q.
  private var graceActive = false
  private var graceCycle: Int = -1
  private var lastDnsAt: Double = 0
  // [v6] último handshake bom do PROCESSO (prazo curto da 1ª tentativa).
  var lastGoodConnectMs: Double = -1
  var lastGoodRttMs: Double = -1
  var netEpoch: Int = 0
  var lastGoodNetEpoch: Int = -1
  // [v6] URLSession compartilhada (retomada TLS) + roteador de delegates.
  private var sharedSession: URLSession?
  private var sharedSessionUses: Int = 0
  private var sharedSessionBornAt: Double = 0
  private lazy var router: TransportWSRouter = TransportWSRouter()

  // [2026-10-23 quic-proto] bloqueios do fio QUIC por região (só na fila q).
  // epoch >= 0 = vale só enquanto a rede (netEpoch) for a mesma ("UDP bloqueado
  // nesta rede"); -1 = vale em qualquer rede (go_ws, noise_fail…).
  struct QuicBlock {
    let until: Double
    let epoch: Int
    let why: String
  }
  private var quicBlocks: [String: QuicBlock] = [:]
  private var quicAuthedDrops: [Double] = []
  /// [chatyy/2] hosts com conexão chatyy/2 autenticada neste processo (ticket TLS p/ retomada 'E').
  var quicV2OkHosts: Set<String> = []
  /// [§9] regiões com `nc` válido neste processo (não voltam para a chave de TESTE) e as que já
  /// emitiram o evento cert_bad (1 evento por região; o contador quicCertBad conta todas).
  var quicProdRegions: Set<String> = []
  var quicCertBadSeen: Set<String> = []
  /// Versão do protótipo QUIC (JS: quicVersion()).
  static let quicVersion = 1

  static func now() -> Double {
    return Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000.0
  }

  func bump(_ k: String, _ n: Int64 = 1) {
    stats[k] = (stats[k] ?? 0) + n
  }

  func emit(_ name: String, _ body: [String: Any?]) {
    emitter?(name, body)
  }

  // MARK: [quic-proto] bloqueios por região

  func quicBlocked(_ region: String) -> QuicBlock? {
    guard let b = quicBlocks[region] else { return nil }
    if ChatTransport.now() >= b.until || (b.epoch >= 0 && b.epoch != netEpoch) {
      quicBlocks.removeValue(forKey: region)
      return nil
    }
    return b
  }

  func quicBlock(_ region: String, ms: Double, networkScoped: Bool, why: String) {
    quicBlocks[region] = QuicBlock(until: ChatTransport.now() + ms, epoch: networkScoped ? netEpoch : -1, why: why)
  }

  /// Queda do QUIC JÁ autenticado: 3 em 10 min → QUIC fora 30 min nessa região.
  func quicNoteAuthedDrop(_ region: String) {
    let t = ChatTransport.now()
    quicAuthedDrops = quicAuthedDrops.filter { t - $0 < 600_000 }
    quicAuthedDrops.append(t)
    if quicAuthedDrops.count >= 3 {
      quicAuthedDrops.removeAll()
      quicBlock(region, ms: 1_800_000, networkScoped: false, why: "flaky")
      bump("quicBlockFlaky")
    }
  }

  /// Estado p/ tela de diagnóstico / QA (sem segredo: só a chave PÚBLICA do aparelho).
  func quicStatus() -> [String: Any] {
    var out: [String: Any] = [
      "v": ChatTransport.quicVersion,
      "local": ChatyyQuicGate.localOn(),
      "kill": ChatyyQuicGate.killOn(),
      "handover": ChatyyQuicGate.handoverOn(),
      "v2Off": ChatyyQuicGate.v2Off(),
      "zeroRtt": ChatyyQuicGate.zeroRttOn(),
      "pins": ChatyyQuicProto.testPins,
    ]
    let sem = DispatchSemaphore(value: 0)
    q.async {
      var bl: [String: Any] = [:]
      let t = ChatTransport.now()
      for (r, b) in self.quicBlocks where t < b.until && (b.epoch < 0 || b.epoch == self.netEpoch) {
        bl[r] = ["why": b.why, "ms": b.until - t, "net": b.epoch >= 0]
      }
      out["blocked"] = bl
      // [§9] sem segredo: auto do cfg, quantos `nc` falharam, ids das raízes do binário, regiões em produção.
      out["auto"] = self.session?.quicAutoOn ?? false
      out["certBad"] = Double(self.stats["quicCertBad"] ?? 0)
      out["roots"] = Array(ChatyyQuicProto.productionRoots.keys).sorted()
      out["prodRegions"] = Array(self.quicProdRegions).sorted()
      out["devicePub"] = ChatyyNoiseDeviceKey.publicB64() ?? ""
      var st: [String: Any] = [:]
      for (k, v) in self.stats where k.hasPrefix("quic") { st[k] = Double(v) }
      out["stats"] = st
      if let s = self.session { out["wire"] = s.wireName() }
      sem.signal()
    }
    if sem.wait(timeout: .now() + 0.5) == .timedOut { out["busy"] = true }
    return out
  }

  /// Limpa bloqueios (QA: depois de mexer em flag do servidor).
  func quicClearBlocks() {
    q.async { self.quicBlocks.removeAll(); self.quicAuthedDrops.removeAll() }
  }

  // MARK: - ciclo de vida / rede

  func initialize() {
    q.async {
      if self.inited { return }
      self.inited = true
      let m = NWPathMonitor()
      m.pathUpdateHandler = { [weak self] path in
        // já na fila q (start(queue: q))
        self?.onPath(path)
      }
      m.start(queue: self.q)
      self.monitor = m
    }
    DispatchQueue.main.async {
      let fg = UIApplication.shared.applicationState != .background
      self.q.async { self.foreground = fg }
      let nc = NotificationCenter.default
      _ = nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
        self?.appDidEnterBackground()
      }
      _ = nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
        self?.appWillEnterForeground()
      }
    }
  }

  private func appDidEnterBackground() {
    // Main thread. Segura alguns segundos de execução para o que o JS mandar
    // ao ir pro fundo (presence offline, stopped_typing, fila pendente) sair.
    // [v6] Com a graça ligada e o socket autenticado, segura ~28 s: o iOS só
    // derruba (defuncta) o socket quando SUSPENDE o processo — troca rápida de
    // app (responder notificação, copiar código, câmera) volta com o fio vivo.
    mainBgCycle += 1
    let cyc: Int = mainBgCycle
    if bgTask == .invalid {
      bgTask = UIApplication.shared.beginBackgroundTask(withName: "chatyy.transport.flush") { [weak self] in
        // Tempo de 2º plano acabou: encerra JÁ (task não encerrada = app morto).
        guard let self = self else { return }
        self.endBackgroundTask()
        self.q.async { self.graceEnded(cyc, expired: true) }
      }
    }
    q.async {
      self.setForeground(false)
      let pending = self.session?.hasPendingOutbound() ?? false
      let grace: Bool = self.bgGraceOn && self.bgGraceMs > 0 && (self.session?.isAuthed() ?? false)
      self.graceCycle = cyc
      self.graceActive = grace
      if grace { self.bump("bgGraces") }
      // [fase 4] fila nativa com pendência: segura até ~25 s drenando e agenda o
      // BGAppRefreshTask p/ o que sobrar (texto); mídia segue na sessão de 2º plano.
      let outboxPending = ChatOutbox.shared.pendingCountLocked() > 0
      if outboxPending {
        ChatOutboxBackground.schedule()
        ChatOutbox.shared.drain(maxMs: 25000) { _ in
          self.q.async {
            // [v6] com a graça ativa quem encerra é o prazo dela (ou a expiração).
            if self.graceActive && self.graceCycle == cyc { return }
            DispatchQueue.main.async { self.endBackgroundTask(ifCycle: cyc) }
          }
        }
        if !grace { return }
      }
      var holdMs: Double = pending ? 8000.0 : 2000.0
      if grace { holdMs = min(29000.0, outboxPending ? max(self.bgGraceMs, 26000.0) : self.bgGraceMs) }
      self.q.asyncAfter(deadline: .now() + holdMs / 1000.0) {
        self.graceEnded(cyc, expired: false)
        DispatchQueue.main.async { self.endBackgroundTask(ifCycle: cyc) }
      }
    }
  }

  private func appWillEnterForeground() {
    // Dispara ANTES do AppState 'active' do JS: a sonda/reconexão começa já.
    mainBgCycle += 1
    endBackgroundTask()
    q.async {
      // [v6] graça ainda ativa = o processo nunca foi suspenso → socket vivo.
      let inGrace: Bool = self.graceActive
      self.graceActive = false
      self.graceCycle = -1
      self.prewarmDns("foreground")
      self.setForeground(true, inGrace: inGrace)
    }
  }

  private func endBackgroundTask() {
    if bgTask != .invalid {
      UIApplication.shared.endBackgroundTask(bgTask)
      bgTask = .invalid
    }
  }

  /// Main thread: encerra só se ainda for o mesmo ciclo de 2º plano.
  private func endBackgroundTask(ifCycle cyc: Int) {
    if mainBgCycle == cyc { endBackgroundTask() }
  }

  /// [v6] fila q: fim da graça (prazo ou expiração do iOS) — o processo vai ser
  /// suspenso; o socket provavelmente morre (defunct) e a volta reconecta.
  private func graceEnded(_ cyc: Int, expired: Bool) {
    guard graceCycle == cyc, graceActive else { return }
    graceActive = false
    if !foreground { bump(expired ? "bgGraceExpired" : "bgGraceEnded") }
  }

  private var bgAt: Double = 0

  private func setForeground(_ fg: Bool, inGrace: Bool = false) {
    if foreground == fg { return }
    foreground = fg
    // Relógio de parede: o uptime (mach) não anda com o aparelho dormindo.
    let wall = Date().timeIntervalSince1970 * 1000
    let bgMs = (fg && bgAt > 0) ? max(0, wall - bgAt) : 0
    if !fg { bgAt = wall }
    session?.onForeground(fg, bgMs: bgMs, inGrace: inGrace)
    if fg { ChatOutbox.shared.kick("foreground") }
  }

  // MARK: [v6] DNS pré-resolvido

  /// getaddrinfo numa fila de fundo esquenta o cache do mDNSResponder (o mesmo
  /// que o URLSession consulta) antes de precisarmos reconectar. Fila q.
  func prewarmDns(_ why: String) {
    guard dnsPrewarmOn, let s = session else { return }
    let t: Double = ChatTransport.now()
    if t - lastDnsAt < 1500 { return }
    lastDnsAt = t
    let hosts: [String] = s.dnsHosts()
    if hosts.isEmpty { return }
    bump("dnsPrewarms")
    DispatchQueue.global(qos: .userInitiated).async {
      for h in hosts { ChatTransport.resolveHost(h) }
    }
  }

  static func resolveHost(_ host: String) {
    var hints = addrinfo()
    hints.ai_family = AF_UNSPEC
    var res: UnsafeMutablePointer<addrinfo>? = nil
    let rc: Int32 = getaddrinfo(host, "443", &hints, &res)
    if rc == 0, let r = res { freeaddrinfo(r) }
  }

  // MARK: [fase 4] porta WS da fila nativa (chamado na fila q)
  func nativeSendReady(account: String) -> Bool { return session?.nativeSendReady(account) ?? false }
  func nativeSendRaw(account: String, text: String) -> Bool { return session?.sendNativeFrame(account, text) ?? false }
  /// [e2ee5 WP-08a] hub aceita envelope no native_send (cap `e2ee5_ns`, CONTRATO §5.3).
  func e2eeNsReady(account: String) -> Bool { return session?.e2eeNsReady(account) ?? false }

  private func onPath(_ path: NWPath) {
    if !pathInited {
      pathInited = true
      netUp = path.status == .satisfied
      primaryIface = path.availableInterfaces.first?.name
      return
    }
    // Debounce: na troca Wi-Fi↔celular o monitor entrega várias atualizações seguidas.
    pendingPath = path
    pathWork?.cancel()
    let w = DispatchWorkItem { [weak self] in self?.evalPath() }
    pathWork = w
    q.asyncAfter(deadline: .now() + 0.3, execute: w)
  }

  private func evalPath() {
    guard let path = pendingPath else { return }
    pendingPath = nil
    let up = path.status == .satisfied
    let iface = path.availableInterfaces.first?.name
    if !up {
      if netUp {
        netUp = false
        bump("netLost")
        session?.onNetDown()
      }
      return
    }
    if !netUp {
      netUp = true
      primaryIface = iface
      bump("netChanges")
      netEpoch += 1
      retireSharedSession("net_up")
      prewarmDns("net_up")
      session?.onNetwork("net_up")
      ChatOutbox.shared.onNetworkUp()
      return
    }
    if iface != primaryIface {
      primaryIface = iface
      bump("netChanges")
      // [v6] rede nova: sessão TLS/conexões da interface velha não servem.
      netEpoch += 1
      retireSharedSession("net_change")
      prewarmDns("net_change")
      session?.onNetwork("net_change")
      // [2026-10-18 net-change] request do outbox em voo na interface velha →
      // cancela e reenfileira sem contar tentativa (+ kick).
      ChatOutbox.shared.onNetChange("net_change")
    }
  }

  // MARK: - API (thread JS → fila q)

  /// Valida já (lança → JS cai para o WebSocket JS) e abre a sessão.
  func open(sid: String, config: [String: Any]) throws {
    let urlStrings = (config["urls"] as? [Any])?.compactMap { $0 as? String }.filter { !$0.isEmpty } ?? []
    guard !urlStrings.isEmpty else { throw TransportError.invalidConfig("no urls") }
    var urls: [URL] = []
    for s in urlStrings.prefix(2) {
      guard let u = URL(string: s), ChatTransport.isAllowed(u) else {
        throw TransportError.invalidConfig("url not allowed")
      }
      urls.append(u)
    }
    let cfg = TransportConfig(
      urls: urls,
      authFrame: config["authFrame"] as? String,
      // [ka-adapt 2026-10-24] teto 120 s → 300 s (keepalive adaptivo por rede; o JS só passa de 25 s
      // com ka_ack do servidor — services/keepaliveAdaptive.js). JS sabe o teto via kaCaps().
      pingIntervalMs: ChatTransport.num(config["pingIntervalMs"], 20000, 2000, ChatTransport.kaMaxMs),
      pongDeadlineMs: ChatTransport.num(config["pongDeadlineMs"], 10000, 1500, 60000),
      authWatchdogMs: ChatTransport.num(config["authWatchdogMs"], 6000, 2000, 30000),
      connectTimeoutMs: ChatTransport.num(config["connectTimeoutMs"], 10000, 3000, 30000),
      fgProbeMs: ChatTransport.num(config["fgProbeMs"], 2500, 1000, 10000),
      bgStaleMs: ChatTransport.num(config["bgStaleMs"], 20000, 5000, 600000),
      adaptiveTimeouts: (config["adaptiveTimeouts"] as? Bool) ?? true,
      bgGrace: (config["bgGrace"] as? Bool) == true,
      bgGraceMs: ChatTransport.num(config["bgGraceMs"], 28000, 0, 29000),
      dnsPrewarm: (config["dnsPrewarm"] as? Bool) == true,
      reuseSession: (config["reuseSession"] as? Bool) == true,
      fastFirst: (config["fastFirst"] as? Bool) == true,
      batchMs: ChatTransport.num(config["batchMs"], 16, 0, 250),
      outboxMax: Int(ChatTransport.num(config["outboxMax"], 500, 10, 2000)),
      account: ((config["account"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
      storeIngest: (config["storeIngest"] as? Bool) == true,
      quic: TransportQuicConfig.parse(config["quic"]),
      // [cbin 2026-10-24] fio binário compacto (ChatyyCbin): só com a flag do JS (__chatyy_cbin) e só no WSS
      cbin: (config["cbin"] as? Bool) == true
    )
    q.async {
      self.bgGraceOn = cfg.bgGrace
      self.bgGraceMs = cfg.bgGraceMs
      self.dnsPrewarmOn = cfg.dnsPrewarm
      if !cfg.reuseSession { self.retireSharedSession("off") }
      self.reuseSessionOn = cfg.reuseSession
      self.session?.close(code: 1000, reason: "replaced", emitClosed: false)
      let s = TransportSession(sid: sid, cfg: cfg, owner: self)
      self.session = s
      self.bump("sessions")
      s.connect(reason: "open")
    }
  }

  func send(sid: String, text: String) {
    q.async { if let s = self.session, s.sid == sid { s.sendFromJs(text) } }
  }

  func close(sid: String, code: Int, reason: String) {
    q.async {
      guard let s = self.session, s.sid == sid else { return }
      s.close(code: code, reason: reason, emitClosed: false)
      self.session = nil
    }
  }

  func setHeartbeat(sid: String, intervalMs: Double, deadlineMs: Double) {
    q.async { if let s = self.session, s.sid == sid { s.setHeartbeat(intervalMs, deadlineMs) } }
  }

  func probe(sid: String, ms: Double) {
    q.async { if let s = self.session, s.sid == sid { s.probe(ms, reason: "js_probe") } }
  }

  func kick(sid: String, reason: String, force: Bool) {
    q.async { if let s = self.session, s.sid == sid { s.kick(reason: reason, force: force) } }
  }

  func setAuthToken(sid: String, token: String) {
    q.async { if let s = self.session, s.sid == sid { s.setAuthToken(token) } }
  }

  func closeAll(reason: String) {
    q.async {
      self.session?.close(code: 1001, reason: reason, emitClosed: false)
      self.session = nil
    }
  }

  func sessionEnded(_ s: TransportSession) {
    if session === s { session = nil }
  }

  func snapshot() -> [String: Any] {
    var out: [String: Any] = ["version": ChatTransport.version]
    let sem = DispatchSemaphore(value: 0)
    q.async {
      for (k, v) in self.stats { out[k] = Double(v) }
      out["foreground"] = self.foreground
      out["netUp"] = self.netUp
      out["regionalBlockedMs"] = max(0, self.regionalBlockedUntil - ChatTransport.now())
      out["bgGraceActive"] = self.graceActive
      out["sharedSession"] = self.sharedSession != nil
      if let s = self.session { for (k, v) in s.snapshot() { out[k] = v } }
      sem.signal()
    }
    if sem.wait(timeout: .now() + 0.3) == .timedOut { return ["version": ChatTransport.version, "busy": true] }
    return out
  }

  // MARK: - URLSession plumbing

  func makeURLSession(delegate: URLSessionDelegate) -> URLSession {
    let c = URLSessionConfiguration.default
    // Prazo de handshake é nosso (connectTimeoutMs); o do request não pode
    // derrubar um socket ocioso saudável.
    c.timeoutIntervalForRequest = 24 * 3600
    c.timeoutIntervalForResource = 7 * 24 * 3600
    c.waitsForConnectivity = false
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    c.urlCache = nil
    return URLSession(configuration: c, delegate: delegate, delegateQueue: opQueue)
  }

  /// [v6] Task de WebSocket nova. Com reuseSession, todas saem da MESMA URLSession
  /// (cache de sessão TLS → handshake de retomada, 1 RTT a menos) e os callbacks
  /// são roteados por task até o delegate da geração. Sem reuse: 1 URLSession por
  /// socket (v5). Devolve a sessão DEDICADA (a invalidar no teardown) ou nil.
  func makeSocketTask(url: URL, delegate d: TransportWSDelegate) -> (URLSessionWebSocketTask, URLSession?) {
    if reuseSessionOn {
      let t0: Double = ChatTransport.now()
      if sharedSession != nil && (sharedSessionUses >= 200 || t0 - sharedSessionBornAt > 6.0 * 3600.0 * 1000.0) {
        retireSharedSession("age")
      }
      let s: URLSession
      if let cur = sharedSession {
        s = cur
      } else {
        s = makeURLSession(delegate: router)
        sharedSession = s
        sharedSessionUses = 0
        sharedSessionBornAt = t0
        bump("urlSessions")
      }
      sharedSessionUses += 1
      let t = s.webSocketTask(with: url)
      router.add(t, d)
      return (t, nil)
    }
    let s = makeURLSession(delegate: d)
    return (s.webSocketTask(with: url), s)
  }

  /// [v6] Socket descartado: solta a rota (callbacks atrasados viram no-op).
  func releaseSocketTask(_ t: URLSessionTask) {
    router.remove(t)
  }

  /// [v6] Aposenta a URLSession compartilhada (troca de rede, falha antes do
  /// open, idade). Tasks em curso terminam; a próxima conexão cria outra.
  func retireSharedSession(_ why: String) {
    guard let s = sharedSession else { return }
    sharedSession = nil
    sharedSessionUses = 0
    bump("urlSessionRetired")
    s.finishTasksAndInvalidate()
  }

  // MARK: - helpers

  static func isAllowed(_ u: URL) -> Bool {
    guard u.scheme == "wss", let host = u.host?.lowercased() else { return false }
    return host == "chatyy.com.br" || host.hasSuffix(".chatyy.com.br")
  }

  static func num(_ v: Any?, _ def: Double, _ lo: Double, _ hi: Double) -> Double {
    guard let n = v as? NSNumber else { return def }
    let d = n.doubleValue
    if d.isNaN || d.isInfinite { return def }
    return min(hi, max(lo, d))
  }

  /// [v6] classe curta do motivo de queda (telemetria 'resume').
  static func dropClass(_ reason: String) -> String {
    let r = reason.lowercased()
    if r.contains("abort") { return "abort" }
    if r.contains("connection was lost") { return "lost" }
    if r.contains("timed out") || r.contains("timeout") { return "timeout" }
    if r.contains("not connected") || r.contains("offline") { return "offline" }
    if r.contains("reset") { return "reset" }
    if r.contains("pong") { return "pong" }
    if r.contains("probe") { return "probe" }
    var out = ""
    for ch in r.unicodeScalars {
      if out.count >= 16 { break }
      if CharacterSet.alphanumerics.contains(ch) || ch == "_" { out.unicodeScalars.append(ch) }
    }
    return out.isEmpty ? "other" : out
  }

  static func topType(_ text: String) -> String? {
    guard let data = text.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else { return nil }
    return obj["type"] as? String ?? ""
  }
}

enum TransportError: Error {
  case invalidConfig(String)
}

struct TransportConfig {
  let urls: [URL]
  let authFrame: String?
  let pingIntervalMs: Double
  let pongDeadlineMs: Double
  let authWatchdogMs: Double
  let connectTimeoutMs: Double
  let fgProbeMs: Double
  /// [v5] 2º plano por menos que isto → sonda (1 ping) em vez de reconectar.
  let bgStaleMs: Double
  /// [v5] prazos de handshake/auth crescem com RTT / timeouts seguidos.
  let adaptiveTimeouts: Bool
  /// [v6] graça de 2º plano + regra de volta nova + evento 'resume'.
  let bgGrace: Bool
  let bgGraceMs: Double
  /// [v6] pré-resolver DNS no willEnterForeground / troca de rede.
  let dnsPrewarm: Bool
  /// [v6] URLSession compartilhada (retomada TLS).
  let reuseSession: Bool
  /// [v6] 1ª tentativa com prazo curto quando o último handshake foi rápido.
  let fastFirst: Bool
  let batchMs: Double
  let outboxMax: Int
  /// [2b] conta da sessão (JS) — confirmada pelo e-mail do auth_success.
  let account: String
  /// [2b] gravar mensagens/recibos direto no expo-chat-store.
  let storeIngest: Bool
  /// [quic-proto] nil = QUIC nunca é tentado (padrão; JS antigo/conta fora da lista).
  let quic: TransportQuicConfig?
  /// [cbin 2026-10-24] manda cbin_hello depois do auth_success (servidor decide: flag HUB_CBIN + allowlist).
  let cbin: Bool
}

/// [2026-10-23 quic-proto] cfg.quic do JS — só vem quando o client-lb do servidor
/// liberou a CONTA (transport.quic/noise) e o kill JS (__chatyy_quic) não está ativo.
/// { on:true, noise:true, noiseTest:bool, auto:bool, regions:{ <reg>: {kid, port, nc?} }, hsMs? }
/// [§9 produção 24/10] `auto` = liga sem a flag local; `nc` = certificado de região assinado pela
/// raiz offline (o NATIVO confere com as raízes do binário — o JS não consegue injetar chave).
struct TransportQuicConfig {
  struct Region {
    let kid: String
    let port: UInt16
    /// nil = sem certificado (só o caminho de TESTE t1). Presente = TEM de validar (falhou → sem QUIC).
    /// Valor não-texto vira "" (presente e inválido: nunca é tratado como ausente).
    let nc: String?
  }
  let noiseTest: Bool
  /// transport.auto=1: build novo liga o QUIC sem o interruptor local (kill local continua vencendo).
  let auto: Bool
  let regions: [String: Region]
  /// prazo do QUIC+Noise até a msg2 antes de cair para o WSS.
  let hsMs: Double
  /// troca de rede com QUIC autenticado: sonda (migração) em vez de reconectar.
  let migrate: Bool
  /// [chatyy/2] tentar o chatyy/2 (pinado) antes do chatyy/1. cfg "v2": false desliga.
  let v2: Bool

  static func parse(_ v: Any?) -> TransportQuicConfig? {
    guard let o = v as? [String: Any], (o["on"] as? Bool) == true, (o["noise"] as? Bool) == true,
          let rs = o["regions"] as? [String: Any] else { return nil }
    var regions: [String: Region] = [:]
    for (k, rv) in rs.prefix(24) {
      guard let r = rv as? [String: Any], let kid = r["kid"] as? String, !kid.isEmpty, kid.count <= 16 else { continue }
      let port = Int(ChatTransport.num(r["port"], 443, 1, 65535))
      var nc: String? = nil
      if let raw = r["nc"], !(raw is NSNull) { nc = (raw as? String) ?? "" }
      regions[k] = Region(kid: kid, port: UInt16(port), nc: nc)
    }
    if regions.isEmpty { return nil }
    return TransportQuicConfig(
      noiseTest: (o["noiseTest"] as? Bool) == true,
      auto: (o["auto"] as? Bool) == true,
      regions: regions,
      hsMs: ChatTransport.num(o["hsMs"], 1500, 600, 3000),
      migrate: (o["migrate"] as? Bool) != false,
      v2: (o["v2"] as? Bool) != false
    )
  }
}

/// Delegate por socket físico (geração). Callbacks na fila q (delegateQueue).
final class TransportWSDelegate: NSObject, URLSessionWebSocketDelegate {
  weak var owner: TransportSession?
  let gen: Int
  init(owner: TransportSession, gen: Int) {
    self.owner = owner
    self.gen = gen
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol proto: String?) {
    owner?.onOpen(gen)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                  didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    let r = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    owner?.onDrop(gen, code: closeCode.rawValue, reason: r)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    var code = 0
    if let ws = task as? URLSessionWebSocketTask { code = ws.closeCode.rawValue }
    // Handshake respondido com HTTP não-101 (400/401/403/5xx) → status aqui.
    let http = (task.response as? HTTPURLResponse)?.statusCode ?? 0
    owner?.onDrop(gen, code: code, reason: "complete: " + (error?.localizedDescription ?? "nil"), http: http == 101 ? 0 : http)
  }
}

/// [v6] Delegate ÚNICO da URLSession compartilhada: encaminha cada callback ao
/// delegate da geração dona da task. Só tocado na fila q (delegateQueue roda em q).
/// Chave = identidade do objeto task (taskIdentifier só é único POR sessão).
final class TransportWSRouter: NSObject, URLSessionWebSocketDelegate {
  private var routes: [ObjectIdentifier: TransportWSDelegate] = [:]

  func add(_ t: URLSessionTask, _ d: TransportWSDelegate) {
    routes[ObjectIdentifier(t)] = d
  }

  func remove(_ t: URLSessionTask) {
    routes.removeValue(forKey: ObjectIdentifier(t))
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol proto: String?) {
    routes[ObjectIdentifier(webSocketTask)]?.urlSession(session, webSocketTask: webSocketTask, didOpenWithProtocol: proto)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                  didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    routes[ObjectIdentifier(webSocketTask)]?.urlSession(session, webSocketTask: webSocketTask, didCloseWith: closeCode, reason: reason)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let k = ObjectIdentifier(task)
    let d: TransportWSDelegate? = routes[k]
    routes.removeValue(forKey: k)
    d?.urlSession(session, task: task, didCompleteWithError: error)
  }
}

/// Uma sessão LÓGICA (= um `new WebSocket()` do JS). Só tocada na fila q.
final class TransportSession {
  private enum Phys: String { case idle, connecting, open, authed }

  private struct Out {
    let text: String
    let type: String
    let key: String?
    let at: Double
    let ttl: Double
  }

  let sid: String
  private let cfg: TransportConfig
  private unowned let owner: ChatTransport

  private var phys: Phys = .idle
  private var task: URLSessionWebSocketTask?
  // [2026-10-23 quic-proto] fio QUIC+Noise (protótipo escuro). No máximo UM fio
  // físico por vez: `task` (WSS) OU `quic`. Sem cfg.quic nada disto é usado.
  private var quic: ChatyyQuicWire?
  // [cbin 2026-10-24] geração em que o cbin_hello foi mandado (aceita binário cbin) / em que veio o cbin_ok
  // (manda binário). Troca de geração = volta a JSON. cbinOff = frame inválido nesta sessão → nunca mais.
  private var cbinHelloGen = -1
  private var cbinOkGen = -1
  private var cbinOff = false
  private var hasWire: Bool { return task != nil || quic != nil }
  /// "wss" | "quic" — fio da geração atual.
  private var wire = "wss"
  private var quicRegion = ""
  private var quicBound = ""
  private var quicReplayRetried = false
  /// versão do fio QUIC atual (2 = chatyy/2, 1 = chatyy/1) e host (ticket p/ retomada).
  private var quicProto = 0
  private var quicHost = ""
  private var quicResume = false
  /// troca de rede com QUIC autenticado: hora da sonda de migração (0 = nenhuma).
  private var migrateProbeAt: Double = 0

  func wireName() -> String { return wire }
  private var urlSession: URLSession?
  private var gen = 0
  private var curUrl: URL?
  private var closed = false
  private var everOpened = false
  private var everAuthed = false
  private var authFrame: String?
  private var authSentGen = -1
  private var authRejected = false
  private var attempt = 0

  private var pingIntervalMs: Double
  private var pongDeadlineMs: Double

  private var reconnectWork: DispatchWorkItem?
  private var connectTimeoutWork: DispatchWorkItem?
  private var authWatchdogWork: DispatchWorkItem?
  private var pingTimer: DispatchSourceTimer?
  private var deadlineWorks: [DispatchWorkItem] = []
  private var flushWork: DispatchWorkItem?

  private var lastInboundAt: Double = 0
  private var lastPingSentAt: Double = 0
  // [ka-adapt 2026-10-24] último frame ENVIADO (qualquer) e ociosidade do enlace quando o ping
  // saiu (= quanto tempo o NAT ficou sem pacote nosso nem do servidor). Vai no pong p/ o JS
  // (campo "idle") e no evento 'ka' {ev:"dead"} quando o ping morre.
  private var lastOutboundAt: Double = 0
  private var kaIdleAtPing: Double = -1
  private var lastGraceAt: Double = 0
  private var connectStartedAt: Double = 0
  private var lostAt: Double = 0
  private var lastRttMs: Double = -1
  private var lastReconnectMs: Double = -1
  private var sendsInFlight = 0
  // Anti-loop: tentativa só zera depois de o socket ficar ESTÁVEL (autenticado
  // por stableMs) — hub que aceita e derruba logo em seguida não vira laço de
  // reconexão. Rejeições HTTP (4xx) no handshake contam à parte.
  private static let stableMs: Double = 10_000
  private static let httpRejectStop = 4
  private var stableWork: DispatchWorkItem?
  private var httpRejects = 0
  // [v5] prazos adaptativos (enlace de satélite/avião: handshake de 5-9 s era
  // morto pelo prazo fixo e recomeçava do zero).
  private var connectTimeoutStreak: Int = 0
  private var authTimeoutStreak: Int = 0
  private var lastConnectMs: Double = -1
  private var openedAt: Double = 0
  // [v6] volta do 2º plano: sonda única + telemetria 'resume'.
  private var lastInboundWall: Double = 0
  private var lastDropWhy: String = "-"
  private var resumePending = false
  private var resumeSentAt: Double = 0
  private var resumeGen: Int = -1
  private var resumeWhy: String = ""
  private var resumeBgMs: Double = 0
  private var resumeGrace = false
  private var connectFast = false

  private static func wallMs() -> Double { return Date().timeIntervalSince1970 * 1000.0 }

  /// [v6] Prazo CURTO da 1ª tentativa: último handshake do processo na MESMA rede
  /// foi rápido (< 1,5 s, RTT < 400 ms) e nenhum timeout seguido → max(4 s, 3×hs+1,5 s).
  /// Errou → connectTimeoutStreak=1 → próxima tentativa já usa o prazo cheio ×1,5.
  private func fastFirstTimeoutMs(_ base: Double) -> Double? {
    if !cfg.fastFirst || connectTimeoutStreak > 0 || base > 10000 { return nil }
    let hs: Double = owner.lastGoodConnectMs
    let rtt: Double = owner.lastGoodRttMs
    if hs <= 0 || hs >= 1500 || owner.lastGoodNetEpoch != owner.netEpoch { return nil }
    if rtt >= 400 { return nil }
    var v: Double = max(4000.0, hs * 3.0 + 1500.0)
    if rtt > 0 { v = max(v, rtt * 6.0 + 1500.0) }
    return min(base, v)
  }

  private func effConnectTimeoutMs() -> Double {
    let base: Double = cfg.connectTimeoutMs
    connectFast = false
    if let f = fastFirstTimeoutMs(base), f < base {
      connectFast = true
      return f
    }
    if !cfg.adaptiveTimeouts { return base }
    var v: Double = base
    if lastRttMs > 0 { v = max(v, lastRttMs * 6.0 + 2000.0) }
    if lastConnectMs > 0 { v = max(v, lastConnectMs * 2.0 + 2000.0) }
    let k: Double = Double(min(connectTimeoutStreak, 3))
    v = v * (1.0 + 0.5 * k)
    return min(30000.0, v)
  }

  private func effAuthWatchdogMs() -> Double {
    let base: Double = cfg.authWatchdogMs
    if !cfg.adaptiveTimeouts { return base }
    var v: Double = base
    if lastRttMs > 0 { v = max(v, lastRttMs * 4.0 + 2000.0) }
    if lastConnectMs > 0 { v = max(v, lastConnectMs + 2000.0) }
    let k: Double = Double(min(authTimeoutStreak, 3))
    v = v * (1.0 + 0.5 * k)
    return min(30000.0, v)
  }

  private var outbox: [Out] = []
  private var buf: [String] = []
  private var bufBytes = 0

  // [2b/4] conta confirmada pelo auth_success + capability native_send do hub
  private var authedAccount: String?
  private var nativeSendCap = false
  /// [e2ee5 WP-08a] cap `e2ee5_ns` do auth_success (envelope pelo WS).
  private var e2eeNsCap = false
  private var ingestBuf: [String] = []

  func isAuthed() -> Bool { return !closed && phys == .authed && hasWire }

  /// [v6] hosts p/ pré-resolver (regional + US).
  func dnsHosts() -> [String] {
    var out: [String] = []
    for u in cfg.urls {
      if let h = u.host, !out.contains(h) { out.append(h) }
    }
    return out
  }

  func nativeSendReady(_ account: String) -> Bool {
    guard !closed, phys == .authed, hasWire, nativeSendCap, let a = authedAccount else { return false }
    return a == account.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  func e2eeNsReady(_ account: String) -> Bool { return e2eeNsCap && nativeSendReady(account) }

  func sendNativeFrame(_ account: String, _ text: String) -> Bool {
    if !nativeSendReady(account) { return false }
    rawSend(text)
    owner.bump("outboxWsFrames")
    return true
  }

  /// e-mail + caps do auth_success sem parsear o `data` inteiro (pode ter centenas de KB).
  private func noteAuthIdentity(_ text: String) {
    nativeSendCap = false
    e2eeNsCap = false
    if let ci = text.range(of: "\"caps\":["), let end = text.range(of: "]", range: ci.upperBound..<text.endIndex) {
      let caps = text[ci.lowerBound..<end.lowerBound]
      nativeSendCap = caps.contains("\"native_send\"")
      e2eeNsCap = caps.contains("\"e2ee5_ns\"")
    }
    // e-mail de TOPO: chaves do Go em ordem alfabética → vem depois de "data";
    // o último "email" é o do topo. Sem ele, vale a conta que o JS informou.
    var email: String?
    if let ei = text.range(of: "\"email\":\"", options: .backwards),
       let en = text.range(of: "\"", range: ei.upperBound..<text.endIndex) {
      email = String(text[ei.upperBound..<en.lowerBound]).trimmingCharacters(in: .whitespaces).lowercased()
    }
    let js = cfg.account
    if js.isEmpty { authedAccount = email }
    else if email == nil || email == js { authedAccount = js }
    else { owner.bump("authAccountMismatch"); authedAccount = nil } // nunca grava na conta errada
  }

  private func flushIngest() {
    if ingestBuf.isEmpty { return }
    let list = ingestBuf
    ingestBuf.removeAll()
    guard let acct = authedAccount else { return }
    ChatyyStoreDB.shared.ingestFrames(account: acct, frames: list)
    owner.bump("ingestBatches"); owner.bump("ingestFrames", Int64(list.count))
    // [e2ee5 WP-08a] envelopes → decifra em 2º plano → e2e_plain (flag desligada = nada)
    ChatyyE2EEIngest.shared.process(account: acct, frames: list)
  }

  init(sid: String, cfg: TransportConfig, owner: ChatTransport) {
    self.sid = sid
    self.cfg = cfg
    self.owner = owner
    self.authFrame = cfg.authFrame
    self.pingIntervalMs = cfg.pingIntervalMs
    self.pongDeadlineMs = cfg.pongDeadlineMs
  }

  private func now() -> Double { return ChatTransport.now() }

  @discardableResult
  private func after(_ ms: Double, _ fn: @escaping () -> Void) -> DispatchWorkItem {
    let w = DispatchWorkItem(block: fn)
    owner.q.asyncAfter(deadline: .now() + max(0, ms) / 1000.0, execute: w)
    return w
  }

  // MARK: conexão física

  func connect(reason: String) {
    if closed || hasWire { return }
    reconnectWork?.cancel(); reconnectWork = nil
    if !owner.netUp { emitState("offline", ["reason": reason]); return }
    if !owner.foreground { emitState("paused", ["reason": reason]); return }
    let url = pickUrl()
    gen += 1
    let g = gen
    phys = .connecting
    curUrl = url
    connectStartedAt = now()
    owner.bump("connects")
    // [quic-proto] conta liberada pelo servidor + flag local + sem kill/bloqueio → QUIC.
    if let qt = quicTarget(url) {
      startQuic(qt, url: url, g: g, reason: reason)
      return
    }
    wire = "wss"
    emitState("connecting", ["url": url.absoluteString, "attempt": attempt, "reason": reason])
    let d = TransportWSDelegate(owner: self, gen: g)
    let made: (URLSessionWebSocketTask, URLSession?) = owner.makeSocketTask(url: url, delegate: d)
    let t: URLSessionWebSocketTask = made.0
    t.maximumMessageSize = 16 * 1024 * 1024 // initial_data/resume podem passar de 1 MB (padrão)
    urlSession = made.1
    task = t
    t.resume()
    receiveLoop(t, g)
    connectTimeoutWork = after(effConnectTimeoutMs()) { [weak self] in
      guard let self = self, g == self.gen, self.phys == .connecting else { return }
      self.owner.bump("connectTimeouts")
      if self.connectFast { self.owner.bump("connectTimeoutsFast") }
      self.connectTimeoutStreak += 1
      self.onDrop(g, code: 0, reason: "connect_timeout")
    }
  }

  private func receiveLoop(_ t: URLSessionWebSocketTask, _ g: Int) {
    t.receive { [weak self] result in
      guard let self = self else { return }
      self.owner.q.async {
        guard g == self.gen, !self.closed else { return }
        switch result {
        case .success(let msg):
          switch msg {
          case .string(let s):
            self.onText(g, s)
          case .data(let d):
            // [cbin 2026-10-24] sessão cbin: binário → JSON texto (o JS continua só vendo texto)
            if g == self.cbinHelloGen, !self.cbinOff {
              if let s = ChatyyCbin.decode(d) {
                self.owner.bump("cbinFramesIn"); self.owner.bump("cbinBytesIn", Int64(d.count))
                self.onText(g, s)
              } else {
                self.cbinOff = true
                self.owner.bump("cbinDecodeErr")
                self.forceReconnect("cbin_decode")
              }
            } else {
              self.lastInboundAt = self.now()
              self.owner.bump("binaryDropped")
            }
          @unknown default:
            break
          }
          if g == self.gen, let cur = self.task, cur === t { self.receiveLoop(t, g) }
        case .failure(let err):
          let http = (t.response as? HTTPURLResponse)?.statusCode ?? 0
          self.onDrop(g, code: t.closeCode.rawValue, reason: "receive: " + err.localizedDescription, http: http == 101 ? 0 : http)
        }
      }
    }
  }

  func onOpen(_ g: Int) {
    guard g == gen, !closed else { return }
    connectTimeoutWork?.cancel(); connectTimeoutWork = nil
    phys = .open
    lastInboundAt = now()
    openedAt = now()
    lastConnectMs = openedAt - connectStartedAt
    connectTimeoutStreak = 0
    owner.lastGoodConnectMs = lastConnectMs
    owner.lastGoodNetEpoch = owner.netEpoch
    owner.bump("opens")
    let first = !everOpened
    everOpened = true
    sendAuthIfPossible()
    emitState("open", ["first": first, "url": curUrl?.absoluteString, "connectMs": now() - connectStartedAt])
  }

  private func rawSend(_ text: String) {
    lastOutboundAt = now()
    if let w = quic {
      let g = gen
      sendsInFlight += 1
      w.sendText(text) { [weak self] err in
        // completion já na fila q (NWConnection.start(queue: q))
        guard let self = self else { return }
        if g == self.gen { self.sendsInFlight = max(0, self.sendsInFlight - 1) }
        if let err = err, g == self.gen, !self.closed {
          self.onQuicEnd(g, .failed("send: \(err)"), beforeReady: false)
        }
      }
      return
    }
    guard let t = task else { return }
    let g = gen
    sendsInFlight += 1
    // [cbin 2026-10-24] depois do cbin_ok desta geração: frame vai em cbin (auth*/cbin_* e o que não codifica → texto)
    var msg = URLSessionWebSocketTask.Message.string(text)
    if g == cbinOkGen, !cbinOff, !ChatyyCbin.jsonOnly(text), let b = ChatyyCbin.encode(text) {
      msg = .data(b)
      owner.bump("cbinFramesOut"); owner.bump("cbinBytesOut", Int64(b.count)); owner.bump("cbinJsonBytesOut", Int64(text.utf8.count))
    }
    t.send(msg) { [weak self] err in
      guard let self = self else { return }
      self.owner.q.async {
        if g == self.gen { self.sendsInFlight = max(0, self.sendsInFlight - 1) }
        if let err = err, g == self.gen, !self.closed {
          self.onDrop(g, code: 0, reason: "send: " + err.localizedDescription)
        }
      }
    }
  }

  private func sendAuthIfPossible() {
    guard let a = authFrame, hasWire, phys == .open, authSentGen != gen else { return }
    rawSend(a)
    authSentGen = gen
    armAuthWatchdog()
  }

  private func armAuthWatchdog() {
    authWatchdogWork?.cancel()
    let g = gen
    authWatchdogWork = after(effAuthWatchdogMs()) { [weak self] in
      guard let self = self, g == self.gen, self.phys == .open, !self.authRejected else { return }
      if self.quic != nil {
        // [quic-proto] Noise ok mas sem auth_success (portão do leaf) → WSS já.
        self.quicFallback(why: "auth_watchdog", ms: 600_000, networkScoped: false)
        return
      }
      self.owner.bump("authTimeouts")
      self.authTimeoutStreak += 1
      self.forceReconnect("auth_watchdog")
    }
  }

  private func onText(_ g: Int, _ text: String) {
    guard g == gen, !closed else { return }
    lastInboundAt = now()
    lastInboundWall = TransportSession.wallMs()
    if migrateProbeAt > 0 { noteQuicAlive() }
    // [v6] qualquer frame depois do ping da volta prova o socket vivo → reusado.
    if resumePending && g == resumeGen && resumeSentAt > 0 {
      finishResume(kept: true, probeMs: now() - resumeSentAt, reason: "probe_ok")
    }
    owner.bump("framesIn")
    owner.bump("bytesIn", Int64(text.utf8.count))
    var type: String? = nil
    if text.utf8.count < 8192 && (text.contains("\"pong\"") || text.contains("\"auth_success\"") || text.contains("\"auth_error\"") || text.contains("\"cbin_")) {
      type = ChatTransport.topType(text)
    }
    switch type {
    case "pong"?:
      let rtt = lastPingSentAt > 0 ? Int(now() - lastPingSentAt) : -1
      lastRttMs = Double(rtt)
      if rtt > 0 { owner.lastGoodRttMs = Double(rtt) }
      owner.bump("pongs")
      enqueueFrame("{\"type\":\"pong\",\"native\":1,\"rtt\":\(rtt),\"idle\":\(Int(kaIdleAtPing)),\"iv\":\(Int(pingIntervalMs))}")
    case "auth_success"?:
      noteAuthIdentity(text)
      enqueueFrame(text)
      onAuthSuccess()
    case "cbin_ok"?:
      // [cbin 2026-10-24] servidor aceitou: daqui em diante esta geração manda binário
      if g == cbinHelloGen && !cbinOff { cbinOkGen = g; owner.bump("cbinOk") }
    case "cbin_no"?:
      owner.bump("cbinNo")
    case "auth_error"?:
      authRejected = true
      authWatchdogWork?.cancel(); authWatchdogWork = nil
      owner.bump("authErrors")
      enqueueFrame(text)
      flushFrames()
    default:
      // [fase 4] ack do envio nativo (chat_send_ack / chat_send_fallback)
      if text.utf8.count < 65536 && text.contains("\"chat_send_"), let acct = authedAccount,
         let data = text.data(using: .utf8),
         let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
        ChatOutbox.shared.onWsFrame(account: acct, obj: obj)
      }
      // [e2ee5 WP-08a] estado E2EE da conversa mudou (§5.2) → cache nativo (só metadado)
      if text.utf8.count < 4096 && text.contains("\"conv_e2ee\""), let acct = authedAccount {
        ChatyyE2EEIngest.shared.noteConvE2EE(account: acct, text: text)
      }
      // [2b] mensagens/recibos → store nativo (o JS continua recebendo igual)
      if cfg.storeIngest && authedAccount != nil && ChatyyStoreIngest.wants(text) { ingestBuf.append(text) }
      enqueueFrame(text)
    }
  }

  private func onAuthSuccess() {
    authWatchdogWork?.cancel(); authWatchdogWork = nil
    // [cbin 2026-10-24] pede o fio binário (sem esperar: segue em JSON até o cbin_ok; só WSS)
    if cfg.cbin && !cbinOff && quic == nil && task != nil && cbinHelloGen != gen {
      cbinHelloGen = gen
      rawSend(ChatyyCbin.helloFrame())
      owner.bump("cbinHello")
    }
    phys = .authed
    httpRejects = 0
    authRejected = false
    stableWork?.cancel()
    let sg = gen
    stableWork = after(TransportSession.stableMs) { [weak self] in
      guard let self = self, sg == self.gen, self.phys == .authed else { return }
      self.attempt = 0
    }
    let regionalBlocked = noteAuthed(curUrl)
    let t = now()
    authTimeoutStreak = 0
    let hsMs: Double = t - connectStartedAt
    let authMs: Double = openedAt > 0 ? t - openedAt : -1
    let since = lostAt > 0 ? t - lostAt : t - connectStartedAt
    if everAuthed {
      lastReconnectMs = since
      owner.bump("reconnects")
      owner.bump("reconnectMsTotal", Int64(since))
    }
    everAuthed = true
    lostAt = 0
    flushOutbox()
    startHeartbeat()
    emitState("authed", [
      "url": curUrl?.absoluteString, "reconnectMs": since, "regionalBlocked": regionalBlocked,
      "hsMs": hsMs, "connectMs": lastConnectMs, "authMs": authMs, "attempt": attempt, "wire": wire,
    ])
    if quic != nil {
      owner.bump("quicAuthed")
      owner.bump("quicAuthedV" + String(quicProto))
      if quicProto == 2 { owner.quicV2OkHosts.insert(quicHost) }
      owner.bump("quicHsMsTotal", Int64(hsMs))
      quicReplayRetried = false
    }
    // [fase 4] socket novo autenticado → fila nativa tenta já (WS)
    if authedAccount != nil { ChatOutbox.shared.kick("ws_authed") }
  }

  /// Socket físico acabou (close/falha/timeout).
  func onDrop(_ g: Int, code: Int, reason: String, http: Int = 0) {
    guard g == gen, !closed else { return }
    let was = phys
    let url = curUrl
    let cls: String = ChatTransport.dropClass(reason)
    lastDropWhy = cls
    if resumePending { finishResume(kept: false, probeMs: -1, reason: "probe_drop_" + cls) }
    teardownSocket(closeCode: nil)
    if was == .connecting || was == .open { noteFailedBeforeAuth(url) }
    // [v6] falhou antes do open: não reusa a sessão TLS/conexões (podem estar ruins).
    if was == .connecting { owner.retireSharedSession("connect_fail") }
    owner.bump("drops")
    if http >= 400 && http <= 499 {
      owner.bump("httpRejects")
      if http == 400 || http == 401 || http == 403 {
        // [v4 2026-10-18 ws-400] 400/401/403 no upgrade = TERMINAL já na 1ª
        // recusa (antes 400 ia pro backoff → laço). Para o backoff, avisa o JS
        // (evento handshake_rejected) e fecha o socket LÓGICO: 4401 = 401/403
        // (token), 4400 = 400 (cabeçalho). O JS faz 1 refresh do bearer e,
        // persistindo, para até o login.
        owner.bump("handshakeRejected")
        emitState("handshake_rejected", ["http": http, "url": url?.absoluteString, "attempt": attempt])
        endLogical(http == 400 ? 4400 : 4401, "handshake_rejected http=\(http)")
        return
      }
      httpRejects += 1
      if httpRejects >= TransportSession.httpRejectStop {
        // 4xx repetido no handshake: devolve ao JS, que desliga o fio nativo
        // neste processo e usa o WebSocket JS.
        endLogical(4400, "handshake_rejected http=\(http) x\(httpRejects)")
        return
      }
      attempt = max(attempt, 6) // degrau longo do backoff
      scheduleReconnect(reason: "http_\(http)", code: 1006, wasAuthed: false, http: http)
      return
    }
    if code >= 4000 && code <= 4999 {
      endLogical(code, reason)
      return
    }
    if was == .authed && lostAt == 0 { lostAt = now() }
    scheduleReconnect(reason: reason, code: code, wasAuthed: was == .authed)
  }

  /// Fecha o socket LÓGICO (decisão do JS a partir daqui).
  private func endLogical(_ code: Int, _ reason: String) {
    closed = true
    flushFrames()
    emitState("closed", ["code": code, "reason": reason])
    cancelAll()
    owner.sessionEnded(self)
  }

  private func teardownSocket(closeCode: Int?) {
    gen += 1 // callbacks atrasados do socket velho viram no-op
    stableWork?.cancel(); stableWork = nil
    let t = task
    let s = urlSession
    task = nil
    urlSession = nil
    let qw = quic
    quic = nil
    migrateProbeAt = 0
    qw?.cancel(code: closeCode)
    phys = .idle
    sendsInFlight = 0
    stopHeartbeat()
    connectTimeoutWork?.cancel(); connectTimeoutWork = nil
    authWatchdogWork?.cancel(); authWatchdogWork = nil
    if let t = t {
      owner.releaseSocketTask(t)
      if let c = closeCode {
        t.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: c) ?? .normalClosure, reason: nil)
      } else {
        t.cancel()
      }
    }
    // URLSession DEDICADA segura o delegate (forte) até ser invalidada → sem isso
    // vaza. A compartilhada (v6) fica viva (rota já solta acima).
    s?.invalidateAndCancel()
  }

  /// resetAttempt só p/ gatilhos EXTERNOS (troca de rede, pedido urgente do JS);
  /// auth_watchdog / pong / sonda mantêm a escada do backoff (sem laço).
  private func forceReconnect(_ reason: String, resetAttempt: Bool = false) {
    if closed { return }
    let wasAuthed = phys == .authed
    if wasAuthed && lostAt == 0 { lostAt = now() }
    teardownSocket(closeCode: nil)
    if resetAttempt { attempt = 0 }
    scheduleReconnect(reason: reason, code: 0, wasAuthed: wasAuthed)
  }

  private func scheduleReconnect(reason: String, code: Int, wasAuthed: Bool, delayOverride: Double = -1, http: Int = 0) {
    reconnectWork?.cancel(); reconnectWork = nil
    if closed || hasWire { return }
    let base: [String: Any?] = ["reason": reason, "code": code, "wasAuthed": wasAuthed, "http": http]
    if !owner.netUp { emitState("offline", base); return }
    if !owner.foreground { emitState("paused", base); return }
    if authRejected { emitState("auth_wait", base); return }
    let delay = delayOverride >= 0 ? delayOverride : backoff(attempt)
    attempt += 1
    var ex = base
    ex["attempt"] = attempt
    ex["nextRetryMs"] = delay
    emitState("reconnecting", ex)
    reconnectWork = after(delay) { [weak self] in
      guard let self = self else { return }
      self.reconnectWork = nil
      self.connect(reason: "retry")
    }
  }

  private func backoff(_ a: Int) -> Double {
    let early: [Double] = [0, 300, 1000, 2000]
    if a < early.count { return early[a] + Double.random(in: 0..<200) }
    // teto 10 s; depois de 10 tentativas seguidas sem estabilizar, 30 s.
    let ceiling: Double = a >= 10 ? 30000 : 10000
    let cap = min(1000.0 * pow(2.0, Double(min(a - 2, 6))), ceiling)
    return cap / 2 + Double.random(in: 0...(cap / 2))
  }

  // MARK: keepalive / zumbi

  func setHeartbeat(_ intervalMs: Double, _ deadlineMs: Double) {
    let i = min(ChatTransport.kaMaxMs, max(2000, intervalMs.isFinite ? intervalMs : 20000))
    let d = min(60000, max(1500, deadlineMs.isFinite ? deadlineMs : 10000))
    if i == pingIntervalMs && d == pongDeadlineMs { return }
    pingIntervalMs = i
    pongDeadlineMs = d
    if phys == .authed { startHeartbeat() }
  }

  private func startHeartbeat() {
    stopHeartbeat()
    if phys != .authed || !owner.foreground { return }
    let t = DispatchSource.makeTimerSource(queue: owner.q)
    let iv = DispatchTimeInterval.milliseconds(Int(pingIntervalMs))
    t.schedule(deadline: .now() + iv, repeating: iv, leeway: .milliseconds(250))
    t.setEventHandler { [weak self] in self?.tick() }
    t.resume()
    pingTimer = t
  }

  private func stopHeartbeat() {
    pingTimer?.cancel(); pingTimer = nil
    for w in deadlineWorks { w.cancel() }
    deadlineWorks.removeAll()
  }

  @discardableResult
  private func sendPing() -> Double {
    guard hasWire else { return 0 }
    let t = now()
    let act = max(lastInboundAt, lastOutboundAt)
    kaIdleAtPing = act > 0 ? t - act : -1
    lastPingSentAt = t
    owner.bump("pings")
    rawSend("{\"type\":\"ping\",\"ts\":\(Int64(Date().timeIntervalSince1970 * 1000))}")
    return t
  }

  private func tick() {
    guard phys == .authed, hasWire else { return }
    let g = gen
    let sent = sendPing()
    let deadline = pongDeadlineMs
    var item: DispatchWorkItem?
    item = after(deadline) { [weak self] in
      guard let self = self else { return }
      if let it = item { self.deadlineWorks.removeAll { $0 === it } }
      guard g == self.gen, self.phys == .authed, self.owner.foreground else { return }
      if self.now() - sent > deadline * 2 + 2000 { return } // processo suspenso: veredito inválido
      if self.lastInboundAt >= sent { return }
      // Uplink saturado (nossos envios ainda pendentes): 1 ciclo de tolerância/min.
      if self.sendsInFlight > 1 && self.now() - self.lastGraceAt > 60000 {
        self.lastGraceAt = self.now()
        self.owner.bump("pongGrace")
        return
      }
      self.owner.bump("zombies")
      // [ka-adapt] ping que saiu após `idle` ms de enlace mudo e não voltou = candidato a NAT vencido.
      self.emitState("ka", ["ev": "dead", "idleMs": Int(self.kaIdleAtPing), "ivMs": Int(self.pingIntervalMs), "quic": self.quic != nil])
      self.forceReconnect("pong_deadline")
    }
    if let it = item { deadlineWorks.append(it) }
  }

  @discardableResult
  func probe(_ ms: Double, reason: String) -> Double {
    if closed { return 0 }
    if phys != .authed { kick(reason: reason, force: false); return 0 }
    // [v6] sonda da volta já em voo (nativo dispara no willEnterForeground, antes
    // do AppState do JS): a do JS não manda outro ping.
    if reason == "js_probe" && resumePending && gen == resumeGen && resumeSentAt > 0 && now() - resumeSentAt < 10000 {
      owner.bump("probesCoalesced")
      return resumeSentAt
    }
    let g = gen
    let sent = sendPing()
    let dl = min(20000, max(1000, ms.isFinite ? ms : 2500))
    owner.bump("probes")
    after(dl) { [weak self] in
      guard let self = self, g == self.gen, self.phys == .authed, self.owner.foreground else { return }
      if self.now() - sent > dl * 3 + 2000 { return }
      if self.lastInboundAt >= sent { return }
      self.owner.bump("zombies")
      self.owner.bump("probeDead")
      if self.resumePending && g == self.resumeGen { self.finishResume(kept: false, probeMs: -1, reason: "probe_dead") }
      self.forceReconnect("probe_dead_" + reason)
    }
    return sent
  }

  // MARK: [v6] volta do 2º plano

  private func beginResume(bgMs: Double, why: String, grace: Bool) {
    resumePending = true
    resumeGen = gen
    resumeSentAt = 0
    resumeBgMs = bgMs
    resumeWhy = why
    resumeGrace = grace
  }

  private func finishResume(kept: Bool, probeMs: Double, reason: String) {
    guard resumePending else { return }
    resumePending = false
    resumeSentAt = 0
    owner.bump(kept ? "resumeKept" : "resumeLost")
    emitState("resume", [
      "kept": kept, "probeMs": probeMs, "reason": reason, "why": resumeWhy,
      "bgMs": resumeBgMs, "grace": resumeGrace,
    ])
  }

  private func resumeProbe(bgMs: Double, why: String, grace: Bool) {
    startHeartbeat()
    var dl: Double = cfg.fgProbeMs
    if cfg.adaptiveTimeouts && lastRttMs > 0 { dl = max(cfg.fgProbeMs, lastRttMs * 3.0 + 1000.0) }
    owner.bump("fgProbes")
    beginResume(bgMs: bgMs, why: why, grace: grace)
    let sent: Double = probe(dl, reason: "foreground")
    if sent <= 0 {
      finishResume(kept: false, probeMs: -1, reason: "probe_unsent")
    } else {
      resumeSentAt = sent
    }
  }

  func kick(reason: String, force: Bool) {
    if closed { return }
    if force {
      if phys != .idle { forceReconnect(reason, resetAttempt: true); return }
      attempt = 0
      scheduleReconnect(reason: reason, code: 0, wasAuthed: false)
      return
    }
    if phys == .idle {
      attempt = 0
      scheduleReconnect(reason: reason, code: 0, wasAuthed: false)
    }
  }

  // MARK: rede / primeiro plano

  func onNetwork(_ kind: String) {
    if closed { return }
    if kind == "net_up" {
      if phys == .authed { probe(2000, reason: kind); return }
      if phys == .idle {
        attempt = 0
        scheduleReconnect(reason: kind, code: 0, wasAuthed: false, delayOverride: Double.random(in: 0..<400))
      }
      return
    }
    // [quic-proto] QUIC autenticado: a conexão pode MIGRAR (o SO troca o caminho e o
    // leaf aceita o endereço novo) → 1 ping com prazo curto; só reconecta se não voltar.
    if quic != nil && phys == .authed && (cfg.quic?.migrate ?? false) {
      owner.bump("quicNetChangeProbes")
      migrateProbeAt = now()
      probe(1500, reason: "quic_migrate")
      return
    }
    // Troca da interface principal (Wi-Fi↔celular): o socket está preso à
    // interface velha → reconecta JÁ na nova (em vez de esperar o prazo do pong).
    if phys != .idle {
      forceReconnect(kind, resetAttempt: true)
    } else {
      attempt = 0
      scheduleReconnect(reason: kind, code: 0, wasAuthed: false, delayOverride: Double.random(in: 0..<250))
    }
  }

  func onNetDown() {
    if closed { return }
    let wasAuthed = phys == .authed
    if wasAuthed && lostAt == 0 { lostAt = now() }
    if phys != .idle { teardownSocket(closeCode: nil) }
    reconnectWork?.cancel(); reconnectWork = nil
    emitState("offline", ["reason": "net_down", "wasAuthed": wasAuthed])
  }

  func onForeground(_ fg: Bool, bgMs: Double = 0, inGrace: Bool = false) {
    if closed { return }
    if !fg {
      resumePending = false
      resumeSentAt = 0
      stopHeartbeat()
      if phys == .idle {
        reconnectWork?.cancel(); reconnectWork = nil
        emitState("paused", ["reason": "background"])
      }
      return
    }
    if cfg.bgGrace {
      onForegroundV6(bgMs: bgMs, inGrace: inGrace)
      return
    }
    switch phys {
    case .authed:
      if bgMs >= cfg.bgStaleMs {
        // Ficou fora mais que o ciclo de ping do hub (25 s): o socket quase
        // sempre morreu (iOS suspende o app). Reconecta JÁ em vez de gastar a sonda.
        owner.bump("fgReconnects")
        forceReconnect("foreground_stale", resetAttempt: true)
      } else {
        // [v5] < bgStaleMs: o hub só fecha após 90 s sem pong → o socket costuma
        // estar vivo; 1 ping (prazo pelo RTT) poupa um handshake inteiro.
        startHeartbeat()
        var dl: Double = cfg.fgProbeMs
        if cfg.adaptiveTimeouts && lastRttMs > 0 { dl = max(cfg.fgProbeMs, lastRttMs * 3.0 + 1000.0) }
        owner.bump("fgProbes")
        probe(dl, reason: "foreground")
      }
    case .idle:
      attempt = 0
      scheduleReconnect(reason: "foreground", code: 0, wasAuthed: false)
    default:
      break
    }
  }

  /// [v6] Volta do 2º plano. Socket autenticado: graça ainda ativa (processo
  /// nunca suspenso), fora < bgStaleMs (JS: 75 s, dentro dos 90 s de PongWait do
  /// hub) ou frame recebido há < 30 s → 1 ping e REUSA; só reconecta se a sonda
  /// falhar (ou o socket cair — defunct chega como erro na hora). Fora mais que
  /// isso → stale (reconecta já). Emite 'resume' com o desfecho.
  private func onForegroundV6(bgMs: Double, inGrace: Bool) {
    switch phys {
    case .authed:
      let inboundRecent: Bool = lastInboundWall > 0 && TransportSession.wallMs() - lastInboundWall < 30000
      if inGrace || bgMs < cfg.bgStaleMs || inboundRecent {
        let why: String = inGrace ? "grace" : (bgMs < cfg.bgStaleMs ? "short" : "inbound")
        resumeProbe(bgMs: bgMs, why: why, grace: inGrace)
      } else {
        owner.bump("fgReconnects")
        beginResume(bgMs: bgMs, why: "long", grace: inGrace)
        finishResume(kept: false, probeMs: -1, reason: "stale")
        forceReconnect("foreground_stale", resetAttempt: true)
      }
    case .idle:
      // Caiu em 2º plano (paused): reconecta já (DNS pré-resolvido, TLS retomado).
      beginResume(bgMs: bgMs, why: inGrace ? "grace" : "bg", grace: inGrace)
      finishResume(kept: false, probeMs: -1, reason: "dropped_bg_" + lastDropWhy)
      attempt = 0
      scheduleReconnect(reason: "foreground", code: 0, wasAuthed: false)
    default:
      beginResume(bgMs: bgMs, why: "bg", grace: inGrace)
      finishResume(kept: false, probeMs: -1, reason: "in_flight")
    }
  }

  /// Bearer deslizou (mesma conta): vale na PRÓXIMA reconexão física.
  func setAuthToken(_ token: String) {
    if closed || token.isEmpty { return }
    guard let a = authFrame,
          let data = a.data(using: .utf8),
          var obj = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] else { return }
    obj["token"] = token
    if let out = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let s = String(data: out, encoding: .utf8) {
      authFrame = s
    }
    if authRejected {
      authRejected = false
      if phys == .idle && reconnectWork == nil {
        attempt = 0
        scheduleReconnect(reason: "auth_update", code: 0, wasAuthed: false)
      }
    }
  }

  // MARK: saída

  func hasPendingOutbound() -> Bool {
    return !outbox.isEmpty || sendsInFlight > 0
  }

  func sendFromJs(_ text: String) {
    if closed { return }
    var obj: [String: Any]? = nil
    if let data = text.data(using: .utf8) {
      obj = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any]
    }
    let type = (obj?["type"] as? String) ?? ""
    switch type {
    case "auth":
      authFrame = text
      authRejected = false
      if phys == .open && authSentGen != gen {
        sendAuthIfPossible()
      } else {
        owner.bump("authDedup")
        if phys == .idle && reconnectWork == nil { scheduleReconnect(reason: "auth_update", code: 0, wasAuthed: false) }
      }
      return
    case "ping":
      if phys == .authed || phys == .open {
        let act = max(lastInboundAt, lastOutboundAt)
        kaIdleAtPing = act > 0 ? now() - act : -1 // [ka-adapt]
        lastPingSentAt = now()
        rawSend(text)
      }
      return
    default:
      break
    }
    if phys == .authed && hasWire {
      rawSend(text)
      owner.bump("framesOut")
      return
    }
    enqueueOut(text, type, obj)
  }

  private func enqueueOut(_ text: String, _ type: String, _ obj: [String: Any]?) {
    if type == "typing" || type == "stopped_typing" || type == "pong" || type.isEmpty {
      owner.bump("outboxSkipped")
      return
    }
    var key: String? = nil
    for k in ["client_message_id", "msg_id", "req_id"] {
      if let v = obj?[k] {
        let s = (v as? String) ?? "\(v)"
        if !s.isEmpty { key = s; break }
      }
    }
    if type == "presence" {
      outbox.removeAll { $0.type == "presence" }
    } else if let k = key {
      outbox.removeAll { $0.key == k && $0.type == type }
    }
    let ttl: Double = (type.hasPrefix("call_") || type.hasPrefix("ice") || type == "webrtc_signal") ? 45_000 : 600_000
    outbox.append(Out(text: text, type: type, key: key, at: now(), ttl: ttl))
    while outbox.count > cfg.outboxMax {
      outbox.removeFirst()
      owner.bump("outboxDropped")
    }
    owner.bump("outboxQueued")
  }

  private func flushOutbox() {
    guard hasWire, phys == .authed else { return }
    let t = now()
    var n: Int64 = 0
    let items = outbox
    outbox.removeAll()
    for o in items {
      if t - o.at > o.ttl { owner.bump("outboxExpired"); continue }
      rawSend(o.text)
      n += 1
    }
    if n > 0 { owner.bump("outboxFlushed", n) }
  }

  // MARK: entrega ao JS (lote)

  private func enqueueFrame(_ text: String) {
    buf.append(text)
    bufBytes += text.utf8.count
    if buf.count >= 64 || bufBytes >= 256 * 1024 || cfg.batchMs <= 0 {
      flushFrames()
    } else if flushWork == nil {
      flushWork = after(cfg.batchMs) { [weak self] in
        guard let self = self else { return }
        self.flushWork = nil
        self.flushFrames()
      }
    }
  }

  private func flushFrames() {
    flushWork?.cancel(); flushWork = nil
    flushIngest()
    if buf.isEmpty { return }
    let list = buf
    buf.removeAll(keepingCapacity: true)
    bufBytes = 0
    owner.bump("batches")
    owner.emit("onTransportFrames", ["sid": sid, "frames": list, "n": list.count])
  }

  private func emitState(_ state: String, _ extra: [String: Any?] = [:]) {
    flushFrames() // ordem: frames anteriores chegam ANTES da mudança de estado
    var m = extra
    m["sid"] = sid
    m["state"] = state
    if lastRttMs >= 0 { m["rttMs"] = lastRttMs }
    m["outbox"] = outbox.count
    owner.emit("onTransportState", m)
  }

  // MARK: fim

  func close(code: Int, reason: String, emitClosed: Bool) {
    if closed { return }
    closed = true
    let c = (code == 1000 || (code >= 3000 && code <= 4999)) ? code : 1000
    teardownSocket(closeCode: c)
    cancelAll()
    outbox.removeAll()
    buf.removeAll()
    if emitClosed { owner.emit("onTransportState", ["sid": sid, "state": "closed", "code": c, "reason": reason]) }
  }

  private func cancelAll() {
    reconnectWork?.cancel(); reconnectWork = nil
    stableWork?.cancel(); stableWork = nil
    flushWork?.cancel(); flushWork = nil
    stopHeartbeat()
    connectTimeoutWork?.cancel(); connectTimeoutWork = nil
    authWatchdogWork?.cancel(); authWatchdogWork = nil
  }

  func snapshot() -> [String: Any] {
    return [
      "sid": sid,
      "phys": phys.rawValue,
      "url": curUrl?.absoluteString ?? "",
      "attempt": attempt,
      "outbox": outbox.count,
      "rttMs": lastRttMs,
      "lastReconnectMs": lastReconnectMs,
      "pingIntervalMs": pingIntervalMs,
      "pongDeadlineMs": pongDeadlineMs,
      "authRejected": authRejected,
      "lastDropWhy": lastDropWhy,
      "wire": wire,
      "quicBound": quicBound,
    ]
  }

  // MARK: [2026-10-23 quic-proto] fio QUIC + Noise (protótipo escuro)

  private struct QuicTarget {
    let host: String
    let port: UInt16
    let region: String
    let kid: String
    let pub: Data
    /// chatyy/2: pins SPKI (base64 do SHA-256) — do certificado de região (produção) ou os de TESTE.
    let pins: [String]
    /// true = chave/pins vieram de um `nc` válido (produção).
    let prod: Bool
    let key: Curve25519.KeyAgreement.PrivateKey
    /// 2 = chatyy/2 (pinado), 1 = chatyy/1. Ordem de queda: 2 → 1 → WSS.
    let proto: Int
    let resume: Bool
  }

  /// [§9.3] transport.auto do cfg atual (só leitura, p/ quicStatus — sem segredo).
  var quicAutoOn: Bool { return cfg.quic?.auto == true }

  /// Chave de bloqueio: "<reg>" vale p/ as 2 versões; "<reg>/2" ou "<reg>/1" só p/ uma.
  private func quicBlockedAny(_ region: String, _ proto: Int) -> Bool {
    return owner.quicBlocked(region) != nil || owner.quicBlocked(region + "/" + String(proto)) != nil
  }

  /// nil = WSS de sempre. Só devolve alvo com TODAS as condições: cfg.quic do JS
  /// (servidor liberou a conta), entrada regional api-<reg> com QUIC anunciado,
  /// flag local ligada, sem kill, região sem bloqueio, chave fixada e par do aparelho.
  private func quicTarget(_ url: URL) -> QuicTarget? {
    guard let qc = cfg.quic, !cfg.account.isEmpty else { return nil }
    guard url == cfg.urls[0], let host = url.host?.lowercased(),
          host.hasPrefix("api-"), host.hasSuffix(".chatyy.com.br") else { return nil }
    let region = String(host.dropFirst(4).dropLast(".chatyy.com.br".count))
    guard !region.isEmpty, region.count <= 8, region != "us",
          region.unicodeScalars.allSatisfy({ CharacterSet.lowercaseLetters.contains($0) || CharacterSet.decimalDigits.contains($0) }),
          let r = qc.regions[region] else { return nil }
    // Kill local vence tudo; depois: transport.auto (§9.3) OU a flag local do build de teste.
    if ChatyyQuicGate.killOn() { return nil }
    guard qc.auto || ChatyyQuicGate.localOn() else { return nil }
    // Chave Noise + pins da região (§9.2): `nc` presente TEM de validar (falhou → sem QUIC aqui,
    // NUNCA cai para a chave de TESTE); sem `nc` → só TESTE t1 com noise_test (§1).
    let pub: Data
    let pins: [String]
    let prod: Bool
    if let nc = r.nc {
      do {
        let c = try ChatyyRegionCert.verify(nc: nc, region: region, kid: r.kid, now: Date().timeIntervalSince1970)
        pub = c.noisePub
        pins = c.pinsB64
        prod = true
        owner.quicProdRegions.insert(region)
      } catch {
        owner.bump("quicCertBad")
        if !owner.quicCertBadSeen.contains(region) {
          owner.quicCertBadSeen.insert(region)
          emitState("quic", ["ev": "cert_bad", "region": region, "why": String(describing: error)])
        }
        return nil
      }
    } else {
      // Região que já mostrou certificado válido neste processo não volta para a chave de TESTE
      // só porque o `nc` sumiu do cfg (anti-downgrade pelo JS/client-lb).
      if owner.quicProdRegions.contains(region) { owner.bump("quicTestRefused"); return nil }
      guard let tp = ChatyyQuicProto.pinnedKey(kid: r.kid, testAllowed: qc.noiseTest) else { owner.bump("quicNoPin"); return nil }
      pub = tp
      pins = ChatyyQuicProto.testPins
      prod = false
    }
    // chatyy/2 primeiro (cfg.v2 != false e sem kill local), depois chatyy/1.
    var proto = 0
    if qc.v2 && !ChatyyQuicGate.v2Off() && !quicBlockedAny(region, 2) { proto = 2 }
    else if !quicBlockedAny(region, 1) { proto = 1 }
    if proto == 0 { owner.bump("quicSkippedBlocked"); return nil }
    guard let key = ChatyyNoiseDeviceKey.loadOrCreate() else { owner.bump("quicNoDeviceKey"); return nil }
    // Retomada 'E' (0-RTT): só chatyy/2, com flag local, depois de um chatyy/2 bom neste host.
    let resume = proto == 2 && ChatyyQuicGate.zeroRttOn() && owner.quicV2OkHosts.contains(host)
    return QuicTarget(host: host, port: r.port, region: region, kid: r.kid, pub: pub, pins: pins, prod: prod, key: key,
                      proto: proto, resume: resume)
  }

  /// e2ee5_device do frame de auth (vai no "dev" da msg1; vazio se não houver).
  private func authDev() -> String {
    guard let a = authFrame, let d = a.data(using: .utf8),
          let o = (try? JSONSerialization.jsonObject(with: d, options: [])) as? [String: Any] else { return "" }
    if let s = o["e2ee5_device"] as? String { return String(s.prefix(128)) }
    if let n = o["e2ee5_device"] as? NSNumber { return n.stringValue }
    return ""
  }

  /// Prazo QUIC+TLS+Noise até a msg2: cfg (1,5 s) ou 4×RTT+0,5 s; teto 3 s. Passou → WSS.
  private func quicHsTimeoutMs(_ qc: TransportQuicConfig) -> Double {
    var v: Double = qc.hsMs
    if owner.lastGoodRttMs > 0 { v = max(v, owner.lastGoodRttMs * 4.0 + 500.0) }
    return min(3000.0, v)
  }

  private func startQuic(_ t: QuicTarget, url: URL, g: Int, reason: String) {
    wire = "quic"
    quicRegion = t.region
    quicBound = ""
    owner.bump("quicAttempts")
    emitState("connecting", ["url": url.absoluteString, "attempt": attempt, "reason": reason, "wire": "quic"])
    quicProto = t.proto
    quicHost = t.host
    quicResume = t.resume
    owner.bump("quicAttemptsV" + String(t.proto))
    if t.prod { owner.bump("quicAttemptsProd") }
    // chatyy/2: o auth vai DENTRO da msg1 (modo I: frames; retomada E: early) → auth_success já
    // chega atrás da msg2. Sem auth (JS ainda não mandou) = vazio; vai pelo canal depois.
    let first: [String] = (t.proto == 2 && authFrame != nil) ? [authFrame!] : []
    let w = ChatyyQuicWire(params: ChatyyQuicWire.Params(
      host: t.host, port: t.port, region: t.region, kid: t.kid, regionPub: t.pub, deviceKey: t.key,
      dev: authDev(), ua: ChatyyQuicWire.userAgent(), handover: ChatyyQuicGate.handoverOn(),
      proto: t.proto, pins: t.proto == 2 ? t.pins : [],
      frames: t.resume ? [] : first, resume: t.resume, early: t.resume ? first : [],
      fastOpen: t.resume), queue: owner.q)
    w.onReady = { [weak self, weak w] bound, earlyN in
      guard let self = self, g == self.gen, !self.closed else { return }
      self.quicBound = bound
      self.owner.bump("quicReady")
      if bound == "dev" { self.owner.bump("quicBoundDev") }
      if w?.mode == ChatyyQuicProto.modeE && !t.resume { self.owner.bump("quicNoExporter") }
      // auth já foi na msg1 e o servidor recebeu (early_n ≥ 1): não reenviar; só o prazo do auth.
      let authInHello = !first.isEmpty && earlyN >= 1
      if authInHello { self.authSentGen = g; self.owner.bump("quicAuthInHello") }
      self.onOpen(g)
      if authInHello && self.phys == .open && g == self.gen { self.armAuthWatchdog() }
    }
    w.onText = { [weak self] s in self?.onText(g, s) }
    w.onBytes = { [weak self] in
      guard let self = self, g == self.gen else { return }
      self.lastInboundAt = self.now()
      if self.migrateProbeAt > 0 && self.phys == .authed { self.noteQuicAlive() }
    }
    w.onEnd = { [weak self] end, before in self?.onQuicEnd(g, end, beforeReady: before) }
    w.onPathEvent = { [weak self] ev in
      guard let self = self, g == self.gen else { return }
      self.owner.bump("quicPath_" + ev)
    }
    quic = w
    // Prazo armado ANTES do start: falha síncrona no start cai p/ WSS e o prazo
    // do WSS não é sobrescrito.
    connectTimeoutWork = after(quicHsTimeoutMs(cfg.quic!)) { [weak self] in
      guard let self = self, g == self.gen, self.phys == .connecting, self.quic != nil else { return }
      self.owner.bump("quicHsTimeouts")
      // "UDP bloqueado nesta rede": 24 h ou até trocar de rede.
      self.quicFallback(why: "hs_timeout", ms: 86_400_000, networkScoped: true)
    }
    w.start()
  }

  /// Fim do fio QUIC (sempre na fila q). Decide: cair p/ WSS já (com bloqueio) ou
  /// reconectar como o WS faria hoje.
  func onQuicEnd(_ g: Int, _ end: ChatyyQuicWire.End, beforeReady: Bool) {
    guard g == gen, !closed, quic != nil else { return }
    let region = quicRegion
    switch end {
    case .appClose(let code, let reason):
      switch code {
      case 4001: // go_ws: conta fora da lista / QUIC desligado no edge / US fora
        owner.bump("quicGoWs")
        quicFallback(why: "go_ws", ms: 3_600_000, networkScoped: false)
      case 4003: // noise_mismatch: par do aparelho é de outra conta
        owner.bump("quicNoiseMismatch")
        ChatyyNoiseDeviceKey.forget()
        quicFallback(why: "noise_mismatch", ms: 3_600_000, networkScoped: false)
      case 4004: // auth_timeout do portão
        owner.bump("quicGateTimeout")
        quicFallback(why: "auth_timeout", ms: 3_600_000, networkScoped: false)
      default:
        let business = code >= 4000 && code <= 4999
        if phys != .authed && !business {
          quicFallback(why: "close_\(code)", ms: 600_000, networkScoped: true, thisVersion: quicProto == 2)
        } else {
          if !business { owner.quicNoteAuthedDrop(region) }
          owner.bump("quicDrops")
          // 1012/1011/1013/4xxx do hub: exatamente como o WS de hoje.
          onDrop(g, code: code, reason: "quic_close: " + reason)
        }
      }
    case .quicClose(let code, let text):
      owner.bump("quicClose_" + String(code, radix: 16))
      switch code {
      case 0x101:
        owner.bump("quicGoWs")
        quicFallback(why: "go_ws", ms: 3_600_000, networkScoped: false)
      case 0x102: // noise_fail: chave/região/prólogo — evento, sem laço; nunca cai p/ modo P
        emitState("quic", ["ev": "noise_fail", "region": region, "text": String(text.prefix(40))])
        // [seg Q-S4] a mesma chave/região vale p/ o chatyy/1: tentar de novo só repetiria a falha → WSS.
        quicFallback(why: "noise_fail", ms: 86_400_000, networkScoped: false, thisVersion: false)
      case 0x103: // replay: 1 nova tentativa (msg1 nova), depois WSS
        if !quicReplayRetried && phys != .authed {
          quicReplayRetried = true
          teardownSocket(closeCode: nil)
          connect(reason: "quic_replay_retry")
        } else {
          quicFallback(why: "replay", ms: 600_000, networkScoped: false)
        }
      case 0x104:
        quicFallback(why: "rate_limited", ms: 300_000, networkScoped: false)
      case 0x106:
        quicFallback(why: "draining", ms: 120_000, networkScoped: false)
      case 0x107:
        quicFallback(why: "hs_timeout_srv", ms: 600_000, networkScoped: true)
      case 0x10A:
        ChatyyNoiseDeviceKey.forget()
        quicFallback(why: "noise_mismatch", ms: 3_600_000, networkScoped: false)
      case 0x0 where phys == .authed:
        owner.bump("quicDrops")
        onDrop(g, code: 1001, reason: "quic_bye: " + text)
      default: // 0x105 bad_preamble, 0x108 noise_required, 0x109 unknown_key, desconhecido
        quicFallback(why: "srv_" + String(code, radix: 16), ms: 86_400_000, networkScoped: false, thisVersion: true)
      }
    case .failed(let why):
      if phys == .authed {
        owner.quicNoteAuthedDrop(region)
        owner.bump("quicDrops")
        onDrop(g, code: 0, reason: "quic: " + why)
      } else {
        // UDP/TLS/QUIC sem sucesso nesta rede → WSS já; lembra até trocar de rede (≤ 24 h).
        // chatyy/2 que falhou no TLS (pin/ALPN) ou sem exporter → só o chatyy/2 sai; tenta o chatyy/1.
        owner.bump("quicFailBeforeAuth")
        let pinBad = quic?.pinRejected == true
        if pinBad {
          // [seg Q-S1] §0.4: pin SPKI não conferiu = "chatyy/2 indisponível nesta região" → WSS
          // (não desce para o chatyy/1/WebPKI, que um proxy com CA instalada aceitaria) + evento.
          owner.bump("quicPinRejected")
          emitState("quic", ["ev": "pin_rejected", "region": region, "proto": quicProto])
          quicFallback(why: "pin", ms: 86_400_000, networkScoped: true, thisVersion: false)
        } else {
          quicFallback(why: "fail", ms: 86_400_000, networkScoped: true, thisVersion: quicProto == 2)
        }
      }
    }
  }

  /// Cai para o WSS AGORA (sem backoff, sem marcar falha regional) e bloqueia o QUIC
  /// nesta região por `ms` (networkScoped = só enquanto a rede for a mesma).
  /// `thisVersion` = bloqueia só a versão atual (chatyy/2 → tenta chatyy/1 já; chatyy/1 → WSS).
  private func quicFallback(why: String, ms: Double, networkScoped: Bool, thisVersion: Bool = false) {
    guard quic != nil else { return }
    let wasAuthed = phys == .authed
    if quicResume && !wasAuthed {
      // retomada 'E' falhou: esquece o ticket e tenta o chatyy/2 a frio (sem bloquear).
      owner.quicV2OkHosts.remove(quicHost)
      owner.bump("quicResumeFail")
    } else {
      let key = thisVersion ? quicRegion + "/" + String(quicProto) : quicRegion
      owner.quicBlock(key, ms: ms, networkScoped: networkScoped, why: why)
    }
    owner.bump("quicFallbacks")
    emitState("quic", ["ev": "fallback", "why": why, "blockMs": ms, "net": networkScoped,
                       "wasAuthed": wasAuthed, "region": quicRegion, "proto": quicProto,
                       "only": thisVersion])
    if wasAuthed && lostAt == 0 { lostAt = now() }
    teardownSocket(closeCode: nil)
    if wasAuthed || authRejected {
      // Já autenticado: o JS precisa ver a queda ('reconnecting') antes do novo auth_success.
      scheduleReconnect(reason: "quic_fallback", code: 0, wasAuthed: wasAuthed, delayOverride: 0)
    } else {
      connect(reason: "quic_fallback")
    }
  }

  /// Bytes chegaram depois da troca de rede: a conexão QUIC migrou (sem auth novo).
  private func noteQuicAlive() {
    guard migrateProbeAt > 0 else { return }
    let ms: Double = now() - migrateProbeAt
    migrateProbeAt = 0
    owner.bump("quicMigrationsKept")
    emitState("quic", ["ev": "migrated", "ms": ms, "region": quicRegion])
  }

  // MARK: endpoint regional

  private func pickUrl() -> URL {
    let pref = cfg.urls[0]
    guard cfg.urls.count > 1 else { return pref }
    if owner.regionalFailPending || now() < owner.regionalBlockedUntil { return cfg.urls[1] }
    return pref
  }

  private func noteFailedBeforeAuth(_ url: URL?) {
    guard cfg.urls.count > 1, let u = url else { return }
    if u == cfg.urls[0] {
      owner.regionalFailPending = true
    } else if owner.regionalFailPending {
      owner.regionalFailPending = false // US também falhou → rede
    }
  }

  private func noteAuthed(_ url: URL?) -> Bool {
    var blocked = false
    if cfg.urls.count > 1, let u = url, u != cfg.urls[0], owner.regionalFailPending {
      owner.regionalBlockedUntil = now() + 15 * 60 * 1000
      blocked = true
    }
    owner.regionalFailPending = false
    return blocked
  }
}
