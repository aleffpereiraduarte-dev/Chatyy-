import Foundation
import Network
import UIKit
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
  static let version = 2

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

  static func now() -> Double {
    return Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000.0
  }

  func bump(_ k: String, _ n: Int64 = 1) {
    stats[k] = (stats[k] ?? 0) + n
  }

  func emit(_ name: String, _ body: [String: Any?]) {
    emitter?(name, body)
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
    if bgTask == .invalid {
      bgTask = UIApplication.shared.beginBackgroundTask(withName: "chatyy.transport.flush") { [weak self] in
        self?.endBackgroundTask()
      }
    }
    q.async {
      self.setForeground(false)
      let pending = self.session?.hasPendingOutbound() ?? false
      // [fase 4] fila nativa com pendência: segura até ~25 s drenando e agenda o
      // BGAppRefreshTask p/ o que sobrar (texto); mídia segue na sessão de 2º plano.
      let outboxPending = ChatOutbox.shared.pendingCountLocked() > 0
      if outboxPending {
        ChatOutboxBackground.schedule()
        ChatOutbox.shared.drain(maxMs: 25000) { _ in DispatchQueue.main.async { self.endBackgroundTask() } }
        return
      }
      self.q.asyncAfter(deadline: .now() + (pending ? 8.0 : 2.0)) {
        DispatchQueue.main.async { self.endBackgroundTask() }
      }
    }
  }

  private func appWillEnterForeground() {
    // Dispara ANTES do AppState 'active' do JS: a sonda/reconexão começa já.
    DispatchQueue.main.async { self.endBackgroundTask() }
    q.async { self.setForeground(true) }
  }

  private func endBackgroundTask() {
    if bgTask != .invalid {
      UIApplication.shared.endBackgroundTask(bgTask)
      bgTask = .invalid
    }
  }

  private var bgAt: Double = 0

  private func setForeground(_ fg: Bool) {
    if foreground == fg { return }
    foreground = fg
    // Relógio de parede: o uptime (mach) não anda com o aparelho dormindo.
    let wall = Date().timeIntervalSince1970 * 1000
    let bgMs = (fg && bgAt > 0) ? max(0, wall - bgAt) : 0
    if !fg { bgAt = wall }
    session?.onForeground(fg, bgMs: bgMs)
    if fg { ChatOutbox.shared.kick("foreground") }
  }

  // MARK: [fase 4] porta WS da fila nativa (chamado na fila q)
  func nativeSendReady(account: String) -> Bool { return session?.nativeSendReady(account) ?? false }
  func nativeSendRaw(account: String, text: String) -> Bool { return session?.sendNativeFrame(account, text) ?? false }

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
      session?.onNetwork("net_up")
      ChatOutbox.shared.onNetworkUp()
      return
    }
    if iface != primaryIface {
      primaryIface = iface
      bump("netChanges")
      session?.onNetwork("net_change")
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
      pingIntervalMs: ChatTransport.num(config["pingIntervalMs"], 20000, 2000, 120000),
      pongDeadlineMs: ChatTransport.num(config["pongDeadlineMs"], 10000, 1500, 60000),
      authWatchdogMs: ChatTransport.num(config["authWatchdogMs"], 6000, 2000, 30000),
      connectTimeoutMs: ChatTransport.num(config["connectTimeoutMs"], 10000, 3000, 30000),
      fgProbeMs: ChatTransport.num(config["fgProbeMs"], 2500, 1000, 10000),
      batchMs: ChatTransport.num(config["batchMs"], 16, 0, 250),
      outboxMax: Int(ChatTransport.num(config["outboxMax"], 500, 10, 2000)),
      account: ((config["account"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
      storeIngest: (config["storeIngest"] as? Bool) == true
    )
    q.async {
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
  let batchMs: Double
  let outboxMax: Int
  /// [2b] conta da sessão (JS) — confirmada pelo e-mail do auth_success.
  let account: String
  /// [2b] gravar mensagens/recibos direto no expo-chat-store.
  let storeIngest: Bool
}

/// Delegate por socket físico (geração). Callbacks na fila q (delegateQueue).
final class TransportWSDelegate: NSObject, URLSessionWebSocketDelegate {
  weak var owner: TransportSession?
  let gen: Int
  init(owner: TransportSession, gen: Int) {
    self.owner = owner
    self.gen = gen
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
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
  private static let bgStaleMs: Double = 20_000
  private var stableWork: DispatchWorkItem?
  private var httpRejects = 0

  private var outbox: [Out] = []
  private var buf: [String] = []
  private var bufBytes = 0

  // [2b/4] conta confirmada pelo auth_success + capability native_send do hub
  private var authedAccount: String?
  private var nativeSendCap = false
  private var ingestBuf: [String] = []

  func nativeSendReady(_ account: String) -> Bool {
    guard !closed, phys == .authed, task != nil, nativeSendCap, let a = authedAccount else { return false }
    return a == account.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  func sendNativeFrame(_ account: String, _ text: String) -> Bool {
    if !nativeSendReady(account) { return false }
    rawSend(text)
    owner.bump("outboxWsFrames")
    return true
  }

  /// e-mail + caps do auth_success sem parsear o `data` inteiro (pode ter centenas de KB).
  private func noteAuthIdentity(_ text: String) {
    nativeSendCap = false
    if let ci = text.range(of: "\"caps\":["), let end = text.range(of: "]", range: ci.upperBound..<text.endIndex) {
      nativeSendCap = text[ci.lowerBound..<end.lowerBound].contains("\"native_send\"")
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
    if closed || task != nil { return }
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
    emitState("connecting", ["url": url.absoluteString, "attempt": attempt, "reason": reason])
    let d = TransportWSDelegate(owner: self, gen: g)
    let s = owner.makeURLSession(delegate: d)
    let t = s.webSocketTask(with: url)
    t.maximumMessageSize = 16 * 1024 * 1024 // initial_data/resume podem passar de 1 MB (padrão)
    urlSession = s
    task = t
    t.resume()
    receiveLoop(t, g)
    connectTimeoutWork = after(cfg.connectTimeoutMs) { [weak self] in
      guard let self = self, g == self.gen, self.phys == .connecting else { return }
      self.owner.bump("connectTimeouts")
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
          case .data:
            self.lastInboundAt = self.now()
            self.owner.bump("binaryDropped")
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
    owner.bump("opens")
    let first = !everOpened
    everOpened = true
    sendAuthIfPossible()
    emitState("open", ["first": first, "url": curUrl?.absoluteString, "connectMs": now() - connectStartedAt])
  }

  private func rawSend(_ text: String) {
    guard let t = task else { return }
    let g = gen
    sendsInFlight += 1
    t.send(.string(text)) { [weak self] err in
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
    guard let a = authFrame, task != nil, phys == .open, authSentGen != gen else { return }
    rawSend(a)
    authSentGen = gen
    armAuthWatchdog()
  }

  private func armAuthWatchdog() {
    authWatchdogWork?.cancel()
    let g = gen
    authWatchdogWork = after(cfg.authWatchdogMs) { [weak self] in
      guard let self = self, g == self.gen, self.phys == .open, !self.authRejected else { return }
      self.owner.bump("authTimeouts")
      self.forceReconnect("auth_watchdog")
    }
  }

  private func onText(_ g: Int, _ text: String) {
    guard g == gen, !closed else { return }
    lastInboundAt = now()
    owner.bump("framesIn")
    owner.bump("bytesIn", Int64(text.utf8.count))
    var type: String? = nil
    if text.utf8.count < 8192 && (text.contains("\"pong\"") || text.contains("\"auth_success\"") || text.contains("\"auth_error\"")) {
      type = ChatTransport.topType(text)
    }
    switch type {
    case "pong"?:
      let rtt = lastPingSentAt > 0 ? Int(now() - lastPingSentAt) : -1
      lastRttMs = Double(rtt)
      owner.bump("pongs")
      enqueueFrame("{\"type\":\"pong\",\"native\":1,\"rtt\":\(rtt)}")
    case "auth_success"?:
      noteAuthIdentity(text)
      enqueueFrame(text)
      onAuthSuccess()
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
      // [2b] mensagens/recibos → store nativo (o JS continua recebendo igual)
      if cfg.storeIngest && authedAccount != nil && ChatyyStoreIngest.wants(text) { ingestBuf.append(text) }
      enqueueFrame(text)
    }
  }

  private func onAuthSuccess() {
    authWatchdogWork?.cancel(); authWatchdogWork = nil
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
    emitState("authed", ["url": curUrl?.absoluteString, "reconnectMs": since, "regionalBlocked": regionalBlocked])
    // [fase 4] socket novo autenticado → fila nativa tenta já (WS)
    if authedAccount != nil { ChatOutbox.shared.kick("ws_authed") }
  }

  /// Socket físico acabou (close/falha/timeout).
  func onDrop(_ g: Int, code: Int, reason: String, http: Int = 0) {
    guard g == gen, !closed else { return }
    let was = phys
    let url = curUrl
    teardownSocket(closeCode: nil)
    if was == .connecting || was == .open { noteFailedBeforeAuth(url) }
    owner.bump("drops")
    if http >= 400 && http <= 499 {
      owner.bump("httpRejects")
      if http == 401 || http == 403 {
        // Token recusado no handshake: NÃO reconecta em laço. O JS trata como
        // auth_error (1 refresh do bearer; persistindo → para e pede re-login).
        endLogical(4401, "handshake http=\(http)")
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
    phys = .idle
    sendsInFlight = 0
    stopHeartbeat()
    connectTimeoutWork?.cancel(); connectTimeoutWork = nil
    authWatchdogWork?.cancel(); authWatchdogWork = nil
    if let t = t {
      if let c = closeCode {
        t.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: c) ?? .normalClosure, reason: nil)
      } else {
        t.cancel()
      }
    }
    // URLSession segura o delegate (forte) até ser invalidada → sem isso vaza.
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
    if closed || task != nil { return }
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
    let i = min(120000, max(2000, intervalMs.isFinite ? intervalMs : 20000))
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
    guard task != nil else { return 0 }
    let t = now()
    lastPingSentAt = t
    owner.bump("pings")
    rawSend("{\"type\":\"ping\",\"ts\":\(Int64(Date().timeIntervalSince1970 * 1000))}")
    return t
  }

  private func tick() {
    guard phys == .authed, task != nil else { return }
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
      self.forceReconnect("pong_deadline")
    }
    if let it = item { deadlineWorks.append(it) }
  }

  func probe(_ ms: Double, reason: String) {
    if closed { return }
    if phys != .authed { kick(reason: reason, force: false); return }
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
      self.forceReconnect("probe_dead_" + reason)
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

  func onForeground(_ fg: Bool, bgMs: Double = 0) {
    if closed { return }
    if !fg {
      stopHeartbeat()
      if phys == .idle {
        reconnectWork?.cancel(); reconnectWork = nil
        emitState("paused", ["reason": "background"])
      }
      return
    }
    switch phys {
    case .authed:
      if bgMs >= TransportSession.bgStaleMs {
        // Ficou fora mais que o ciclo de ping do hub (25 s): o socket quase
        // sempre morreu (iOS suspende o app). Reconecta JÁ em vez de gastar a sonda.
        owner.bump("fgReconnects")
        forceReconnect("foreground_stale", resetAttempt: true)
      } else {
        startHeartbeat()
        probe(cfg.fgProbeMs, reason: "foreground")
      }
    case .idle:
      attempt = 0
      scheduleReconnect(reason: "foreground", code: 0, wasAuthed: false)
    default:
      break
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
        lastPingSentAt = now()
        rawSend(text)
      }
      return
    default:
      break
    }
    if phys == .authed && task != nil {
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
    guard task != nil, phys == .authed else { return }
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
    ]
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
