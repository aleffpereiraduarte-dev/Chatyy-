import Foundation
import UIKit
import Security
import ExpoChatStore

/// [2026-10-15 fase 4] FILA DE ENVIO NATIVA (outbox) — gêmeo de OutboxCore.kt
/// (lá o motor roda também na JVM, contra o hub/chat.php reais: rajada, queda de
/// rede, processo morto, duplicata e mídia — ver docs/native-store-DESIGN.md §12).
///
/// Cada item (texto ou mídia) é gravado no SQLite da conta (tabela `outbox` do
/// expo-chat-store) com o client_message_id ANTES de qualquer tentativa. Envio:
/// socket nativo autenticado com `native_send` → frame `chat_send` (ack no mesmo
/// socket); sem ack em 4 s / sem socket → HTTP `email.php?action=chat_send`. O
/// servidor deduplica por (remetente, cmi). FIFO por conversa; mídia sobe em
/// paralelo por uma URLSession de SEGUNDO PLANO (continua com o app suspenso/
/// fechado; o iOS relança o app quando termina) e depois entra na ordem.
/// Texto pendente com o app no fundo: beginBackgroundTask + BGAppRefreshTask.
///
/// Todo o estado vive na fila serial do transporte (`ChatTransport.shared.q`):
/// ver se o socket está autenticado e mandar o frame é seguro sem locks.
final class ChatOutbox: NSObject, URLSessionDataDelegate {
  static let shared = ChatOutbox()
  static let bgSessionId = "com.onemundo.mail.nativeOutbox"
  static let bgTaskId = "com.onemundo.mail.outbox"

  static let backoffMs: [Int64] = [1000, 2000, 4000, 8000, 15000, 30000, 60000, 120000, 300000]
  static let wsAckMs: Double = 4000
  static let maxUploads = 2
  static let sentKeepMs: Int64 = 7 * 24 * 3600 * 1000
  /// [2026-10-18 outbox-progress] US origin: upload fallback when the regional base keeps failing.
  static let usOrigin = "https://chatyy.com.br"
  /// Consecutive upload failures on the regional `up.base` before switching to `usOrigin`.
  static let regionalUploadMaxFails: Int64 = 2
  /// Progress events: at most one per this many ms (plus the 100% one).
  static let progressMinMs: Int64 = 150
  /// [2026-10-18 upload-4xx] 4xx definitivo no upload (≠ 401/408/429/413/415):
  /// depois de tantas tentativas o item vira 'failed' ("!") em vez de relógio eterno.
  static let upload4xxMaxTries: Int64 = 3
  private static let hardRe = try! NSRegularExpression(pattern: "\\b403\\b|forbidden|not.?a.?member|no_permission|permission_denied|conversation.?deleted|admin.?only", options: [.caseInsensitive])

  private var q: DispatchQueue { return ChatTransport.shared.q }

  /// Corpo do evento → JS (onOutboxState). nil com o JS morto.
  var emitter: (([String: Any?]) -> Void)?

  private final class Attempt {
    let account: String, cmi: String, conv: String
    var phase: String
    var timer: DispatchWorkItem?
    var task: URLSessionTask?
    init(_ a: String, _ c: String, _ v: String, _ p: String) { account = a; cmi = c; conv = v; phase = p }
  }

  private struct Creds { let token: String; let base: String }

  private var creds: [String: Creds] = [:]
  private var accounts = Set<String>()
  private var recovered = Set<String>()
  private var inflight: [String: Attempt] = [:]
  private var uploads: [String: Attempt] = [:]
  private var uploadData: [Int: Data] = [:]
  /// [2026-10-18 outbox-progress] taskIdentifier → last progress event (throttle).
  private var progressLast: [Int: (ms: Int64, pct: Int)] = [:]
  private var authWaitUntil: [String: Int64] = [:]
  private var wake: DispatchWorkItem?
  private var wakeAt: Int64 = 0
  private var pumpQueued = false
  private(set) var stats: [String: Int64] = [:]
  private var bgSession: URLSession?
  private var bgEventsDone: (() -> Void)?
  private var started = false
  /// [e2ee5 WP-08a] cmi → quem espera o estado final (ponte notificação/Siri). Só na fila q.
  private var finalWaiters: [String: [(String, String) -> Void]] = [:]
  /// [e2ee5 WP-08a] linhas sendo recifradas (texto puro numa conversa que virou E2EE). Só na fila q.
  private var reencrypting = Set<String>()

  private lazy var http: URLSession = {
    let c = URLSessionConfiguration.default
    c.timeoutIntervalForRequest = 30
    c.timeoutIntervalForResource = 40
    c.waitsForConnectivity = false
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    c.urlCache = nil
    return URLSession(configuration: c)
  }()

  private func bump(_ k: String, _ n: Int64 = 1) { stats[k] = (stats[k] ?? 0) + n }
  private func now() -> Int64 { return Int64(Date().timeIntervalSince1970 * 1000) }
  private static func norm(_ a: String) -> String { return a.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
  private func emit(_ m: [String: Any?]) { emitter?(m) }

  static func isUsableBase(_ b: String) -> Bool {
    guard let u = URL(string: b), u.scheme == "https", let h = u.host?.lowercased() else { return false }
    return h == "chatyy.com.br" || h.hasSuffix(".chatyy.com.br")
  }

  private var store: ChatyyStoreDB { return ChatyyStoreDB.shared }

  // MARK: - ciclo de vida

  /// Idempotente: sessão de upload em 2º plano (re)criada e tarefas em voo remapeadas.
  func start() {
    q.async { [self] in
      if started { return }
      started = true
      ensureBgSessionLocked()
      bgSession?.getAllTasks { tasks in
        self.q.async {
          for t in tasks {
            guard let d = t.taskDescription, d.hasPrefix("u|") else { continue }
            let parts = d.split(separator: "|", maxSplits: 3).map(String.init)
            if parts.count < 4 { continue }
            let at = Attempt(parts[1], parts[2], parts[3], "upload")
            at.task = t
            self.uploads[parts[2]] = at
          }
          for a in self.loadAccounts() { self.accounts.insert(a) }
          self.pumpNow()
        }
      }
    }
  }

  private func ensureBgSessionLocked() {
    if bgSession != nil { return }
    let c = URLSessionConfiguration.background(withIdentifier: ChatOutbox.bgSessionId)
    c.isDiscretionary = false
    c.sessionSendsLaunchEvents = true
    c.allowsCellularAccess = true
    let oq = OperationQueue()
    oq.maxConcurrentOperationCount = 1
    oq.underlyingQueue = q
    bgSession = URLSession(configuration: c, delegate: self, delegateQueue: oq)
  }

  /// AppDelegate: o iOS relançou o app por eventos da nossa sessão de 2º plano.
  func handleBackgroundEvents(_ done: @escaping () -> Void) {
    q.async { [self] in
      bgEventsDone = done
      started = false
      start()
    }
  }

  // MARK: - API (qualquer thread)

  func configure(account: String, token: String, base: String) {
    let a = Self.norm(account)
    if a.isEmpty || token.isEmpty { return }
    let b = Self.isUsableBase(base) ? String(base.reversed().drop(while: { $0 == "/" }).reversed()) : "https://chatyy.com.br"
    OutboxKeychain.save(account: a, token: token, base: b)
    q.async { [self] in
      creds[a] = Creds(token: token, base: b)
      accounts.insert(a)
      authWaitUntil.removeValue(forKey: a)
      schedulePump()
    }
  }

  /// Enfileira (idempotente por cmi). Grava no SQLite ANTES de voltar. "new" | estado | "".
  /// [e2ee5 WP-08a] Conversa E2EE (flag e2ee5_native + e2ee_mode=1): cifra ANTES de gravar —
  /// a tabela `outbox` e o HTTP/WS só veem o envelope. "" = não entrou (o JS segue o caminho dele).
  func submit(account: String, item: [String: Any]) -> String {
    let a = Self.norm(account)
    if a.isEmpty { return "" }
    var it = item
    if ChatyyE2EEOutbox.mayNeedWork(account: a, item: item) {
      switch ChatyyE2EEOutbox.prepareBlocking(account: a, item: item, timeout: 8) {
      case .pass: break
      case .replace(let x): it = x
      case .reject(let why): q.async { [self] in bump("e2eeRejected"); bump("e2eeRejected_" + why) }; return ""
      }
    }
    return submitPrepared(a, it)
  }

  /// [e2ee5 WP-08a] Versão sem bloquear (outboxSubmit do JS, ponte): `done` com o estado do
  /// submit; `onFinal` (opcional) com "sent"/"failed" + erro quando a linha termina.
  func submitAsync(account: String, item: [String: Any], onFinal: ((String, String) -> Void)? = nil, done: @escaping (String) -> Void) {
    let a = Self.norm(account)
    if a.isEmpty { done(""); return }
    let finish = { [self] (it: [String: Any]?) in
      guard let it = it else { done(""); return }
      if let cb = onFinal {
        let cmi = ChatyyOutboxUtil.str(it["cmi"])
        q.async { [self] in finalWaiters[cmi, default: []].append(cb) }
      }
      let st = submitPrepared(a, it)
      if st.isEmpty || st == "sent" || st == "failed", let cb = onFinal {
        let cmi = ChatyyOutboxUtil.str(it["cmi"])
        q.async { [self] in
          finalWaiters.removeValue(forKey: cmi)
          if !st.isEmpty { cb(st, st == "failed" ? "already_failed" : "") }
        }
      }
      done(st)
    }
    if !ChatyyE2EEOutbox.mayNeedWork(account: a, item: item) { finish(item); return }
    #if CHATYY_CRYPTO_CORE
    Task.detached { [self] in
      switch await ChatyyE2EEOutbox.prepare(account: a, item: item) {
      case .pass: finish(item)
      case .replace(let x): finish(x)
      case .reject(let why):
        q.async { [self] in bump("e2eeRejected"); bump("e2eeRejected_" + why) }
        finish(nil)
      }
    }
    #else
    finish(item)
    #endif
  }

  private func submitPrepared(_ a: String, _ item: [String: Any]) -> String {
    let st = store.outboxPut(account: a, item: item)
    q.async { [self] in
      accounts.insert(a)
      if st == "new" {
        bump("submitted")
        emit(["account": a, "cmi": ChatyyOutboxUtil.str(item["cmi"]), "conv": ChatyyOutboxUtil.str(item["conv"]), "state": "queued", "tries": 0])
      }
      schedulePump()
    }
    return st
  }

  func kick(_ reason: String) {
    q.async { [self] in
      for a in accounts {
        for it in store.outboxAll(account: a) {
          let st = ChatyyOutboxUtil.str(it["state"])
          if (st == "queued" || st == "uploading") && ChatyyOutboxUtil.i64(it["next_at"]) > now() && !ChatyyOutboxUtil.str(it["err"]).hasPrefix("rl429") {
            store.outboxPatch(account: a, cmi: ChatyyOutboxUtil.str(it["cmi"]), patch: ["next_at": 0])
          }
        }
      }
      bump("kicks")
      pumpNow()
    }
  }

  func retry(account: String, cmi: String) {
    let a = Self.norm(account)
    q.async { [self] in
      store.outboxPatch(account: a, cmi: cmi, patch: ["state": "queued", "next_at": 0, "tries": 0, "err": NSNull()])
      accounts.insert(a); pumpNow()
    }
  }

  func ack(account: String, cmi: String) {
    let a = Self.norm(account)
    q.async { [self] in
      if inflight[cmi] == nil && uploads[cmi] == nil { store.outboxRemove(account: a, cmi: cmi) }
    }
  }

  func cancel(account: String, cmi: String) {
    let a = Self.norm(account)
    q.async { [self] in
      if let at = inflight.removeValue(forKey: cmi) { at.timer?.cancel(); at.task?.cancel() }
      if let at = uploads.removeValue(forKey: cmi) { at.task?.cancel() }
      store.outboxRemove(account: a, cmi: cmi)
      pumpNow()
    }
  }

  func list(account: String) -> String {
    let rows = store.outboxAll(account: Self.norm(account))
    return ChatyyOutboxUtil.jsonString(rows) ?? "[]"
  }

  /// Logout: credenciais fora; a tabela some com o wipe do store.
  func forgetAll() {
    OutboxKeychain.clear()
    q.async { [self] in
      creds.removeAll(); accounts.removeAll()
      for (_, at) in inflight { at.timer?.cancel(); at.task?.cancel() }
      inflight.removeAll()
      for (_, at) in uploads { at.task?.cancel() }
      uploads.removeAll()
    }
  }

  /// Frame do hub no socket nativo (chat_send_ack / chat_send_fallback). Já na fila q.
  func onWsFrame(account: String, obj: [String: Any]) {
    let type = ChatyyOutboxUtil.str(obj["type"])
    let cmi = ChatyyOutboxUtil.str(obj["client_message_id"])
    guard !cmi.isEmpty, let at = inflight[cmi], at.phase == "ws", at.account == Self.norm(account) else { return }
    at.timer?.cancel(); at.timer = nil
    if type == "chat_send_ack", let row = obj["message"] as? [String: Any], ChatyyOutboxUtil.i64(row["id"]) > 0 {
      bump("wsAcks")
      done(at, row, via: "ws")
    } else if type == "chat_send_error" {
      // [e2ee5 WP-08a] §5.4: recusa definitiva para AQUELE conteúdo — não reenvia por HTTP.
      bump("wsSendErrors")
      e2eeRefused(at, ChatyyOutboxUtil.str(obj["code"]))
    } else {
      bump("wsFallbacks")
      httpSend(at)
    }
  }

  func onNetworkUp() { kick("net_up") }

  /// [2026-10-18 net-change] Troca de interface (wifi↔4G): o chat_send HTTP em
  /// voo ficou preso na interface velha até o timeout (30/40 s). Cancela, devolve
  /// à fila SEM contar tentativa (o servidor deduplica por client_message_id) e
  /// bombeia já. Envios aguardando ack do WS voltam também (o socket velho caiu).
  /// Uploads NÃO: rodam na URLSession de 2º plano, que o próprio iOS migra/retoma.
  func onNetChange(_ reason: String) {
    q.async { [self] in
      for at in Array(inflight.values) where at.phase == "http" || at.phase == "ws" {
        inflight.removeValue(forKey: at.cmi)
        at.timer?.cancel(); at.timer = nil
        at.task?.cancel()
        store.outboxPatch(account: at.account, cmi: at.cmi, patch: ["state": "queued", "next_at": 0, "err": reason])
        bump("netChangeRequeued")
        emit(["account": at.account, "cmi": at.cmi, "conv": at.conv, "state": "queued", "err": reason, "retryInMs": 0])
      }
    }
    kick(reason)
  }

  /// Itens pendentes (todas as contas). Só na fila q.
  func pendingCountLocked() -> Int {
    var n = 0
    for a in accounts {
      for it in store.outboxAll(account: a) {
        let st = ChatyyOutboxUtil.str(it["state"])
        if st == "queued" || st == "sending" || st == "uploading" { n += 1 }
      }
    }
    return n
  }

  func snapshot() -> [String: Any] {
    var out: [String: Any] = [:]
    let sem = DispatchSemaphore(value: 0)
    q.async { [self] in
      for (k, v) in stats { out[k] = Double(v) }
      out["inflight"] = inflight.count; out["uploads"] = uploads.count; out["accounts"] = accounts.count
      sem.signal()
    }
    if sem.wait(timeout: .now() + 0.3) == .timedOut { return ["busy": true] }
    return out
  }

  /// Dreno em 2º plano (BGTask / beginBackgroundTask): bombeia e chama `done(pendente)`
  /// quando não há nada devido em voo, ou no prazo.
  func drain(maxMs: Double, done: @escaping (Bool) -> Void) {
    q.async { [self] in
      start()
      for a in loadAccounts() { accounts.insert(a) }
      pumpNow()
      let deadline = now() + Int64(maxMs)
      func check() {
        let busy = !self.inflight.isEmpty || self.hasDueLocked()
        if busy && self.now() < deadline {
          self.q.asyncAfter(deadline: .now() + 0.25) { check() }
          return
        }
        done(self.pendingCountLocked() > 0)
      }
      q.asyncAfter(deadline: .now() + 0.25) { check() }
    }
  }

  // MARK: - bomba (só na fila q)

  private func loadAccounts() -> [String] { return OutboxKeychain.accounts() }

  private func credsFor(_ a: String) -> Creds? {
    if let c = creds[a] { return c }
    guard let c = OutboxKeychain.load(account: a) else { return nil }
    let cc = Creds(token: c.token, base: c.base)
    creds[a] = cc
    return cc
  }

  private func schedulePump() {
    if pumpQueued { return }
    pumpQueued = true
    q.async { [self] in pumpQueued = false; pumpNow() }
  }

  private func online() -> Bool { return ChatTransport.shared.netUp }

  private func hasDueLocked() -> Bool {
    let t = now()
    for a in accounts {
      for it in store.outboxAll(account: a) {
        let st = ChatyyOutboxUtil.str(it["state"])
        if (st == "queued" || st == "uploading") && ChatyyOutboxUtil.i64(it["next_at"]) <= t && online() { return true }
      }
    }
    return false
  }

  private func pumpNow() {
    let t = now()
    var nextWake = Int64.max
    for a in accounts {
      if !recovered.contains(a) {
        recovered.insert(a)
        let n = store.outboxRecover(account: a)
        if n > 0 { bump("recovered", Int64(n)) }
      }
      var blocked = Set<String>()
      for it in store.outboxAll(account: a) {
        let cmi = ChatyyOutboxUtil.str(it["cmi"]), conv = ChatyyOutboxUtil.str(it["conv"])
        let st = ChatyyOutboxUtil.str(it["state"]), due = ChatyyOutboxUtil.i64(it["next_at"])
        switch st {
        case "sent", "failed":
          if t - ChatyyOutboxUtil.i64(it["updated_at"]) > Self.sentKeepMs { store.outboxRemove(account: a, cmi: cmi) }
        case "uploading":
          if uploads[cmi] != nil { continue }
          if due > t { nextWake = min(nextWake, due); continue }
          if uploads.count < Self.maxUploads && online() { startUpload(a, it) }
        case "sending":
          blocked.insert(conv)
          if inflight[cmi] == nil {
            store.outboxPatch(account: a, cmi: cmi, patch: ["state": "queued", "next_at": 0])
            nextWake = min(nextWake, t + 200)
          }
        case "queued":
          // [e2ee5 WP-08a] texto puro numa conversa que agora sabemos ser E2EE → recifra antes
          if ChatyyE2EEOutbox.needsReencrypt(account: a, row: it) {
            blocked.insert(conv)
            if due > t { nextWake = min(nextWake, due) }
            else if inflight[cmi] == nil && uploads[cmi] == nil && online() { e2eeReencrypt(a, it) }
            continue
          }
          if ChatyyOutboxUtil.str(it["kind"]) == "media" && !hasFileUrl(it) {
            // bytes ainda não estão no CDN → sobe em paralelo (não segura a conversa)
            store.outboxPatch(account: a, cmi: cmi, patch: ["state": "uploading", "next_at": 0])
            if uploads[cmi] == nil && uploads.count < Self.maxUploads && online() { startUpload(a, it) }
            continue
          }
          if blocked.contains(conv) || inflight[cmi] != nil { blocked.insert(conv); continue }
          blocked.insert(conv) // FIFO: só a cabeça da conversa sai
          if due > t { nextWake = min(nextWake, due); continue }
          if inflight.values.contains(where: { $0.account == a && $0.conv == conv }) { continue }
          if !online() { continue }
          let wait = authWaitUntil[a] ?? 0
          if wait > t { nextWake = min(nextWake, wait); continue }
          startSend(a, it)
        default:
          continue
        }
      }
    }
    armWake(nextWake)
  }

  private func armWake(_ at: Int64) {
    if at == Int64.max { return }
    let t = now()
    let due = max(at, t + 200)
    if wake != nil && wakeAt > 0 && wakeAt <= due { return }
    wake?.cancel()
    wakeAt = due
    let w = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      self.wake = nil; self.wakeAt = 0
      self.pumpNow()
    }
    wake = w
    q.asyncAfter(deadline: .now() + Double(due - t) / 1000.0, execute: w)
  }

  private func hasFileUrl(_ it: [String: Any]) -> Bool {
    let b = ChatyyOutboxUtil.obj(it["body"])
    let f = ChatyyOutboxUtil.str(b["file_url"])
    return !f.isEmpty && f != "null"
  }

  private func findItem(_ a: String, _ cmi: String) -> [String: Any]? {
    return store.outboxAll(account: a).first { ChatyyOutboxUtil.str($0["cmi"]) == cmi }
  }

  // MARK: - envio

  private func startSend(_ a: String, _ it: [String: Any]) {
    let cmi = ChatyyOutboxUtil.str(it["cmi"]), conv = ChatyyOutboxUtil.str(it["conv"])
    let at = Attempt(a, cmi, conv, "ws")
    inflight[cmi] = at
    store.outboxPatch(account: a, cmi: cmi, patch: ["state": "sending"])
    emit(["account": a, "cmi": cmi, "conv": conv, "state": "sending", "tries": ChatyyOutboxUtil.i64(it["tries"])])
    bump("attempts")
    let frame = ChatyyOutboxUtil.str(it["frame"])
    // [e2ee5 WP-08a] envelope pelo WS só se o hub declarou `e2ee5_ns` (§5.3); senão HTTP.
    let wsEnvelopeOk = !ChatyyE2EEMsg.looksEncrypted(ChatyyE2EEOutbox.content(it)) || ChatTransport.shared.e2eeNsReady(account: a)
    if wsEnvelopeOk && !frame.isEmpty && frame != "null" && ChatTransport.shared.nativeSendReady(account: a) && ChatTransport.shared.nativeSendRaw(account: a, text: frame) {
      bump("wsSends")
      let w = DispatchWorkItem { [weak self] in
        guard let self = self, self.inflight[cmi] === at, at.phase == "ws" else { return }
        self.bump("wsTimeouts")
        self.httpSend(at)
      }
      at.timer = w
      q.asyncAfter(deadline: .now() + Self.wsAckMs / 1000.0, execute: w)
      return
    }
    httpSend(at)
  }

  private func httpSend(_ at: Attempt) {
    at.phase = "http"
    guard let c = credsFor(at.account) else {
      authWaitUntil[at.account] = now() + 15000
      transient(at, "no_creds", offline: false, auth: true); return
    }
    guard let row = findItem(at.account, at.cmi) else { inflight.removeValue(forKey: at.cmi); return }
    let body = ChatyyOutboxUtil.obj(row["body"])
    guard let url = URL(string: c.base + "/api/email.php?action=chat_send"),
          let data = try? JSONSerialization.data(withJSONObject: body) else { hard(at, "bad_body"); return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.httpBody = data
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer " + c.token, forHTTPHeaderField: "Authorization")
    req.setValue("native", forHTTPHeaderField: "X-Chatyy-Outbox")
    bump("httpSends")
    let task = http.dataTask(with: req) { [weak self] d, resp, err in
      guard let self = self else { return }
      let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
      self.q.async {
        guard self.inflight[at.cmi] === at else { return }
        if err != nil && code == 0 { self.transient(at, "net: " + (err?.localizedDescription ?? "io"), offline: !self.online()); return }
        self.onHttp(at, code, d ?? Data())
      }
    }
    at.task = task
    task.resume()
  }

  private func onHttp(_ at: Attempt, _ code: Int, _ d: Data) {
    let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    let ok = (j?["success"] as? Bool) == true || (j?["success"] as? NSNumber)?.boolValue == true
    let data = j?["data"] as? [String: Any]
    if (200...299).contains(code), ok, let row = data, ChatyyOutboxUtil.i64(row["id"]) > 0 { done(at, row, via: "http"); return }
    var msg = ChatyyOutboxUtil.str(j?["message"]); if msg.isEmpty { msg = ChatyyOutboxUtil.str(j?["error"]) }
    let msgShort = String(msg.prefix(120))
    let e5 = ChatyyOutboxUtil.str(data?["code"])
    if (400...499).contains(code) && e5.hasPrefix("e2ee5_") { e2eeRefused(at, e5); return } // [e2ee5 WP-08a]
    if code == 401 {
      authWaitUntil[at.account] = now() + 10000
      transient(at, "http_401", offline: false, auth: true)
    } else if code == 429 {
      var ra = ChatyyOutboxUtil.dbl(data?["retry_after"]); if ra <= 0 { ra = ChatyyOutboxUtil.dbl(j?["retry_after"]) }
      let ms = Int64(min(65000, max(1000, ra > 0 ? ra * 1000 : 5000)))
      transient(at, "rl429: " + String(msg.prefix(80)), offline: false, fixedMs: ms)
    } else if code >= 500 || code == 408 || code == 425 || code == 0 {
      transient(at, "http_\(code)", offline: false)
    } else if (400...499).contains(code) {
      hard(at, "http_\(code) " + msgShort)
    } else if (200...299).contains(code), j != nil,
              Self.hardRe.firstMatch(in: msg, range: NSRange(location: 0, length: (msg as NSString).length)) != nil {
      hard(at, msgShort)
    } else {
      transient(at, "http_\(code) " + String(msg.prefix(80)), offline: false)
    }
  }

  private func done(_ at: Attempt, _ server: [String: Any], via: String) {
    inflight.removeValue(forKey: at.cmi)
    at.timer?.cancel()
    store.outboxSent(account: at.account, cmi: at.cmi, conv: at.conv, server: server)
    // [e2ee5 WP-08a] a própria mensagem cifrada: o payload que acabamos de cifrar vira o texto local
    if let pl = ChatyyE2EEOutbox.takePlain(at.cmi), ChatyyOutboxUtil.i64(server["id"]) > 0 {
      store.e2ePut(account: at.account, rows: [["conv": pl.conv, "id": NSNumber(value: ChatyyOutboxUtil.i64(server["id"])), "cmid": at.cmi,
                                                "state": "ok", "payload": pl.payload, "trust": "self"]])
      bump("e2eeSent")
    }
    fireFinal(at.cmi, "sent", "")
    bump("sent")
    emit(["account": at.account, "cmi": at.cmi, "conv": at.conv, "state": "sent", "via": via, "server": ChatyyOutboxUtil.jsonString(server) ?? "{}"])
    pumpNow()
  }

  private func hard(_ at: Attempt, _ err: String) {
    inflight.removeValue(forKey: at.cmi)
    ChatyyE2EEOutbox.dropPlain(at.cmi)
    fireFinal(at.cmi, "failed", err)
    store.outboxPatch(account: at.account, cmi: at.cmi, patch: ["state": "failed", "err": err])
    store.outboxFailedMark(account: at.account, cmi: at.cmi, conv: at.conv)
    bump("hardFails")
    emit(["account": at.account, "cmi": at.cmi, "conv": at.conv, "state": "failed", "kind": "hard", "err": err])
    pumpNow()
  }

  private func transient(_ at: Attempt, _ err: String, offline: Bool, auth: Bool = false, fixedMs: Int64 = -1) {
    inflight.removeValue(forKey: at.cmi)
    let row = findItem(at.account, at.cmi)
    let tries = ChatyyOutboxUtil.i64(row?["tries"]) + (offline ? 0 : 1)
    let delay: Int64
    if fixedMs >= 0 { delay = fixedMs }
    else if offline { delay = 30000 }
    else {
      let b = Self.backoffMs[min(max(Int(tries) - 1, 0), Self.backoffMs.count - 1)]
      delay = Int64(Double(b) * (0.8 + Double.random(in: 0..<0.4)))
    }
    store.outboxPatch(account: at.account, cmi: at.cmi, patch: ["state": "queued", "tries": tries, "next_at": now() + delay, "err": err])
    bump(offline ? "offlineRetries" : "transient")
    emit(["account": at.account, "cmi": at.cmi, "conv": at.conv, "state": "queued", "tries": tries, "err": err, "retryInMs": delay])
    if auth { emit(["account": at.account, "state": "auth_needed"]) }
    pumpNow()
  }

  // MARK: - [e2ee5 WP-08a] E2EE na fila nativa (só na fila q)

  private func fireFinal(_ cmi: String, _ state: String, _ err: String) {
    guard let cbs = finalWaiters.removeValue(forKey: cmi) else { return }
    for cb in cbs { cb(state, err) }
  }

  /// Recusa E2EE do servidor/hub (§5.4 / §8.4).
  private func e2eeRefused(_ at: Attempt, _ code: String) {
    let row = findItem(at.account, at.cmi)
    let plainText = row.map { !ChatyyE2EEMsg.looksEncrypted(ChatyyE2EEOutbox.content($0)) } ?? false
    let uid = ChatyyE2EEConvModes.uid(account: at.account)
    switch code {
    case "e2ee5_plaintext_refused":
      if let u = uid { ChatyyE2EEConvCache.shared.noteMode(uid: u, conv: at.conv, mode: 1) }
      if plainText && ChatyyE2EEGate.uid(account: at.account) != nil {
        // conversa virou E2EE depois do submit → volta à fila; o pump recifra antes de mandar
        inflight.removeValue(forKey: at.cmi)
        at.timer?.cancel(); at.timer = nil
        store.outboxPatch(account: at.account, cmi: at.cmi, patch: ["state": "queued", "next_at": 0, "err": code])
        bump("e2eeRequeued")
        emit(["account": at.account, "cmi": at.cmi, "conv": at.conv, "state": "queued", "err": code, "retryInMs": 0])
        pumpNow()
        return
      }
      e2eeScrub(at.account, at.cmi, row)
      hard(at, code)
    case "e2ee5_not_e2ee":
      // envelope numa conversa normal (rebaixada): o envelope não volta a ser texto → o JS reenvia
      if let u = uid { ChatyyE2EEConvCache.shared.noteMode(uid: u, conv: at.conv, mode: 0) }
      hard(at, code)
    default:
      if plainText { e2eeScrub(at.account, at.cmi, row) }
      hard(at, code.isEmpty ? "e2ee5_refused" : code)
    }
  }

  /// Linha que falhou numa conversa E2EE não guarda o texto puro no disco (o JS tem a bolha).
  private func e2eeScrub(_ a: String, _ cmi: String, _ row: [String: Any]?) {
    guard let r = row else { return }
    var b = ChatyyOutboxUtil.obj(r["body"])
    if b["content"] == nil { return }
    b["content"] = ""
    b.removeValue(forKey: "reply_quote_text")
    store.outboxPatch(account: a, cmi: cmi, patch: ["body": ChatyyOutboxUtil.jsonString(b) ?? "{}", "frame": NSNull()])
    bump("e2eeScrubbed")
  }

  /// Texto puro na fila de uma conversa que agora é E2EE → cifra e troca body/frame.
  private func e2eeReencrypt(_ a: String, _ it: [String: Any]) {
    let cmi = ChatyyOutboxUtil.str(it["cmi"]), conv = ChatyyOutboxUtil.str(it["conv"])
    if reencrypting.contains(cmi) { return }
    reencrypting.insert(cmi)
    bump("e2eeReencrypt")
    #if CHATYY_CRYPTO_CORE
    Task.detached { [self] in
      let r = await ChatyyE2EEOutbox.reencrypt(account: a, row: it)
      q.async { [self] in
        reencrypting.remove(cmi)
        switch r {
        case .ok(var patch):
          patch["state"] = "queued"; patch["next_at"] = 0; patch["err"] = NSNull()
          store.outboxPatch(account: a, cmi: cmi, patch: patch)
          pumpNow()
        case .retry(let why):
          store.outboxPatch(account: a, cmi: cmi, patch: ["next_at": now() + 15000, "err": "e2ee5_wait: " + why])
          armWake(now() + 15000)
        case .fail(let why):
          let at = Attempt(a, cmi, conv, "e2ee"); inflight[cmi] = at
          e2eeScrub(a, cmi, it)
          hard(at, "e2ee5_needs_app: " + why)
        }
      }
    }
    #else
    reencrypting.remove(cmi)
    #endif
  }

  // MARK: - mídia: upload único (Rust /api/rust/upload) em SEGUNDO PLANO, depois chat_send

  private lazy var bodiesDir: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let dir = base.appendingPathComponent("chatyy-outbox-bodies", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var u = dir
    var rv = URLResourceValues(); rv.isExcludedFromBackup = true
    try? u.setResourceValues(rv)
    return dir
  }()

  private func bodyFile(_ cmi: String) -> URL {
    let safe = cmi.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
    return bodiesDir.appendingPathComponent(safe + ".body")
  }

  private func startUpload(_ a: String, _ it: [String: Any]) {
    let cmi = ChatyyOutboxUtil.str(it["cmi"]), conv = ChatyyOutboxUtil.str(it["conv"])
    // [e2ee5 WP-08a] mídia em claro NUNCA sobe para conversa E2EE (mídia cifrada = F3/WP-11)
    if let u = ChatyyE2EEGate.uid(account: a), ChatyyE2EEConvCache.shared.knownMode(uid: u, conv: conv) == 1 {
      let at = Attempt(a, cmi, conv, "upload"); inflight[cmi] = at
      e2eeScrub(a, cmi, it)
      hard(at, "e2ee5_media_needs_app"); return
    }
    let up = ChatyyOutboxUtil.obj(it["up"])
    var path = ChatyyOutboxUtil.str(it["file"])
    if path.hasPrefix("file://") { path = URL(string: path)?.path ?? String(path.dropFirst(7)) }
    if path.isEmpty || !FileManager.default.fileExists(atPath: path) {
      let at = Attempt(a, cmi, conv, "upload"); inflight[cmi] = at
      hard(at, "no_local_file"); return
    }
    guard let c = credsFor(a) else {
      authWaitUntil[a] = now() + 15000
      store.outboxPatch(account: a, cmi: cmi, patch: ["next_at": now() + 15000])
      emit(["account": a, "state": "auth_needed"]); return
    }
    ensureBgSessionLocked()
    guard let session = bgSession else { return }
    // [2026-10-18 outbox-progress] Regional media edge (`up.base`, set by JS)
    // first; after regionalUploadMaxFails consecutive failed uploads (every
    // earlier try of this item went to the regional base) → US origin. `tries`
    // is persisted in the store, so this survives the app being killed.
    let ub = ChatyyOutboxUtil.str(up["base"])
    let regional = Self.isUsableBase(ub) ? String(ub.reversed().drop(while: { $0 == "/" }).reversed()) : ""
    let tries = ChatyyOutboxUtil.i64(it["tries"])
    var base = c.base
    if !regional.isEmpty {
      if tries >= Self.regionalUploadMaxFails && regional != Self.usOrigin {
        base = Self.usOrigin
        bump("uploadUsFallback")
      } else {
        base = regional
      }
    }
    var name = ChatyyOutboxUtil.str(up["filename"]); if name.isEmpty { name = (path as NSString).lastPathComponent }
    var mime = ChatyyOutboxUtil.str(up["mime"]); if mime.isEmpty { mime = "application/octet-stream" }
    var ctxName = ChatyyOutboxUtil.str(up["context"]); if ctxName.isEmpty { ctxName = "chat" }
    var email = ChatyyOutboxUtil.str(up["user_email"]); if email.isEmpty { email = a }
    // corpo multipart num arquivo (upload de 2º plano exige arquivo)
    let boundary = "chatyy-" + UUID().uuidString
    let bf = bodyFile(cmi)
    FileManager.default.createFile(atPath: bf.path, contents: nil)
    guard let fh = try? FileHandle(forWritingTo: bf) else { return }
    func w(_ s: String) { if let d = s.data(using: .utf8) { fh.write(d) } }
    func field(_ n: String, _ v: String) { w("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(n)\"\r\n\r\n\(v)\r\n") }
    field("user_email", email); field("context", ctxName); field("filename", name)
    w("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name.replacingOccurrences(of: "\"", with: ""))\"\r\nContent-Type: \(mime)\r\n\r\n")
    if let src = FileHandle(forReadingAtPath: path) {
      while true {
        let chunk = src.readData(ofLength: 1 << 20)
        if chunk.isEmpty { break }
        fh.write(chunk)
      }
      src.closeFile()
    }
    w("\r\n--\(boundary)--\r\n")
    fh.closeFile()
    guard let url = URL(string: base + "/api/rust/upload") else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer " + c.token, forHTTPHeaderField: "Authorization")
    let task = session.uploadTask(with: req, fromFile: bf)
    task.taskDescription = "u|\(a)|\(cmi)|\(conv)"
    let at = Attempt(a, cmi, conv, "upload")
    at.task = task
    uploads[cmi] = at
    emit(["account": a, "cmi": cmi, "conv": conv, "state": "uploading"])
    bump("uploads")
    task.resume()
  }

  private func uploadDone(_ at: Attempt, _ code: Int, _ d: Data) {
    uploads.removeValue(forKey: at.cmi)
    try? FileManager.default.removeItem(at: bodyFile(at.cmi))
    let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    let cdn = ChatyyOutboxUtil.str(j?["cdn_url"])
    let ok = (j?["success"] as? Bool) == true || (j?["success"] as? NSNumber)?.boolValue == true
    if (200...299).contains(code), ok, !cdn.isEmpty, let row = findItem(at.account, at.cmi) {
      var body = ChatyyOutboxUtil.obj(row["body"])
      let up = ChatyyOutboxUtil.obj(row["up"])
      body["file_url"] = cdn
      var fname = ChatyyOutboxUtil.str(j?["filename"]); if fname.isEmpty { fname = ChatyyOutboxUtil.str(up["filename"]) }
      body["file_name"] = fname
      if let sz = j?["size"] { body["file_size"] = NSNumber(value: ChatyyOutboxUtil.i64(sz)) }
      store.outboxPatch(account: at.account, cmi: at.cmi, patch: ["body": ChatyyOutboxUtil.jsonString(body) ?? "{}", "state": "queued", "next_at": 0, "err": NSNull()])
      bump("uploaded")
      emit(["account": at.account, "cmi": at.cmi, "conv": at.conv, "state": "uploaded", "cdn_url": cdn])
      pumpNow(); return
    }
    if code == 413 || code == 415 {
      inflight[at.cmi] = at
      hard(at, "upload_http_\(code)"); return
    }
    let row = findItem(at.account, at.cmi)
    let tries = ChatyyOutboxUtil.i64(row?["tries"]) + (online() ? 1 : 0)
    // [2026-10-18 upload-4xx] 400/403/404/422… não se curam sozinhos: limite de
    // tentativas e depois 'failed' (o usuário vê "!" e pode reenviar). 401
    // (auth), 408 e 429 seguem transitórios.
    if code >= 400 && code <= 499 && code != 401 && code != 408 && code != 429 && tries >= Self.upload4xxMaxTries {
      inflight[at.cmi] = at
      hard(at, "upload_http_\(code)"); return
    }
    let delay: Int64 = !online() ? 30000 : Self.backoffMs[min(max(Int(tries) - 1, 0), Self.backoffMs.count - 1)]
    store.outboxPatch(account: at.account, cmi: at.cmi, patch: ["state": "uploading", "tries": tries, "next_at": now() + delay, "err": "upload_http_\(code)"])
    if code == 401 { emit(["account": at.account, "state": "auth_needed"]) }
    bump("uploadRetries")
    pumpNow()
  }

  // MARK: URLSessionDataDelegate (fila q)

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    uploadData[dataTask.taskIdentifier, default: Data()].append(data)
  }

  /// [2026-10-18 outbox-progress] REAL bytes-sent progress for the bubble ring
  /// (was a fake 10% → 50% → 100%). Throttled to ~7/s. Old JS ignores
  /// state "progress". Only delivered while the app runs (background session).
  func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
    guard let d = task.taskDescription, d.hasPrefix("u|") else { return }
    let parts = d.split(separator: "|", maxSplits: 3).map(String.init)
    if parts.count < 4 { return }
    let total: Int64 = totalBytesExpectedToSend > 0 ? totalBytesExpectedToSend : 0
    let pct: Int = total > 0 ? Int(min(Int64(100), max(Int64(0), (totalBytesSent * 100) / total))) : 0
    let t = now()
    if let last = progressLast[task.taskIdentifier] {
      if pct == last.pct { return }
      if pct < 100 && t - last.ms < Self.progressMinMs { return }
    }
    progressLast[task.taskIdentifier] = (ms: t, pct: pct)
    emit(["account": parts[1], "cmi": parts[2], "conv": parts[3], "state": "progress",
          "sent": NSNumber(value: totalBytesSent), "total": NSNumber(value: total), "pct": NSNumber(value: pct)])
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let data = uploadData.removeValue(forKey: task.taskIdentifier) ?? Data()
    progressLast.removeValue(forKey: task.taskIdentifier)
    guard let d = task.taskDescription, d.hasPrefix("u|") else { return }
    let parts = d.split(separator: "|", maxSplits: 3).map(String.init)
    if parts.count < 4 { return }
    let at = uploads[parts[2]] ?? Attempt(parts[1], parts[2], parts[3], "upload")
    accounts.insert(parts[1])
    let code = error == nil ? ((task.response as? HTTPURLResponse)?.statusCode ?? 0) : 0
    uploadDone(at, code, data)
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    // Sessão de 2º plano drenou: dá alguns segundos p/ o chat_send do que subiu.
    let cb = bgEventsDone
    bgEventsDone = nil
    guard let done = cb else { return }
    drain(maxMs: 20000) { _ in DispatchQueue.main.async { done() } }
  }
}

/// Helpers de JSON (a fila nativa troca dicionários com o store).
enum ChatyyOutboxUtil {
  static func str(_ v: Any?) -> String {
    if v == nil || v is NSNull { return "" }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return "\(v!)"
  }
  static func i64(_ v: Any?) -> Int64 {
    if let n = v as? NSNumber { return n.int64Value }
    if let s = v as? String { return Int64(s) ?? Int64(Double(s) ?? 0) }
    return 0
  }
  static func dbl(_ v: Any?) -> Double {
    if let n = v as? NSNumber { return n.doubleValue }
    if let s = v as? String { return Double(s) ?? 0 }
    return 0
  }
  static func obj(_ v: Any?) -> [String: Any] {
    if let d = v as? [String: Any] { return d }
    if let s = v as? String, let data = s.data(using: .utf8), let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { return d }
    return [:]
  }
  static func jsonString(_ o: Any) -> String? {
    guard JSONSerialization.isValidJSONObject(o), let d = try? JSONSerialization.data(withJSONObject: o) else { return nil }
    return String(data: d, encoding: .utf8)
  }
}

/// Bearer + base por conta no Keychain (só neste aparelho, após o 1º desbloqueio:
/// o reenvio em 2º plano funciona com a tela bloqueada). Logout apaga.
enum OutboxKeychain {
  private static let service = "br.com.chatyy.outbox"

  static func save(account: String, token: String, base: String) {
    guard let data = ChatyyOutboxUtil.jsonString(["t": token, "b": base])?.data(using: .utf8) else { return }
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    let upd: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    if SecItemUpdate(q as CFDictionary, upd as CFDictionary) == errSecItemNotFound {
      var add = q; for (k, v) in upd { add[k] = v }
      SecItemAdd(add as CFDictionary, nil)
    }
  }

  static func load(account: String) -> (token: String, base: String)? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data,
          let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
    let t = ChatyyOutboxUtil.str(o["t"]); if t.isEmpty { return nil }
    let b = ChatyyOutboxUtil.str(o["b"])
    return (t, b.isEmpty ? "https://chatyy.com.br" : b)
  }

  static func accounts() -> [String] {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                            kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let arr = out as? [[String: Any]] else { return [] }
    return arr.compactMap { $0[kSecAttrAccount as String] as? String }
  }

  static func clear() {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
    SecItemDelete(q as CFDictionary)
  }
}
