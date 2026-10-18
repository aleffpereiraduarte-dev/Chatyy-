import Foundation
import UIKit

/// [2026-10-18 native-share] Lado do APP do compartilhar nativo do iOS.
///
/// A ShareExtension (native-ios/share-extension/ChatyyNativeShare.swift) grava
/// um "job" por envio em <App Group>/ChatyyShare/jobs/<cmi>.json e dispara um
/// POST que sozinho cria a mensagem (chat_upload / chat_send) numa URLSession de
/// SEGUNDO PLANO com identificador "com.onemundo.mail.shareext.<uuid>". Se a
/// extensão já fechou quando o upload termina, o iOS acorda ESTE app
/// (handleEventsForBackgroundURLSession) e aqui:
///   • reatamos a sessão pelo identificador → recebemos o resultado → job "sent"
///     (apaga) / "failed" (4xx definitivo, fica 7 dias p/ diagnóstico);
///   • erro transitório (rede, 5xx, 401, 429) → entrega à fila nativa
///     (ChatOutbox: /api/rust/upload + chat_send, backoff, auth, BGTask) com o
///     MESMO client_message_id → o servidor deduplica, nunca vira 2 mensagens.
/// No boot e ao voltar ao primeiro plano, `drainSoon` varre jobs pendentes
/// órfãos (extensão morta antes do fim, eventos perdidos) e faz o mesmo.
final class ChatyyShareOutbox: NSObject, URLSessionDataDelegate {
  static let shared = ChatyyShareOutbox()
  static let appGroup = "group.com.onemundo.mail"
  static let sessionPrefix = "com.onemundo.mail.shareext."
  static let origin = "https://chatyy.com.br"
  /// Job mais novo que isso pode ainda estar com a extensão viva → não mexe.
  static let extensionGraceMs: Double = 90_000
  static let keepMs: Double = 7 * 24 * 3600 * 1000

  private let q = DispatchQueue(label: "chatyy.shareOutbox", qos: .utility)
  private var sessions: [String: URLSession] = [:]
  private var completions: [String: () -> Void] = [:]
  private var received: [String: Data] = [:]
  private var draining = false

  static func isShareSession(_ id: String) -> Bool { return id.hasPrefix(sessionPrefix) }

  private static func dir(_ name: String) -> URL? {
    guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
    let d = root.appendingPathComponent("ChatyyShare", isDirectory: true).appendingPathComponent(name, isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
  }

  private func nowMs() -> Double { return Date().timeIntervalSince1970 * 1000 }
  private func str(_ v: Any?) -> String { return ChatyyOutboxUtil.str(v) }

  // MARK: - API (AppDelegate)

  /// O iOS relançou o app por eventos de uma sessão da extensão.
  func handleBackgroundEvents(identifier: String, completion: @escaping () -> Void) {
    q.async { [self] in
      completions[identifier] = completion
      _ = attach(identifier)
      // rede de segurança: o iOS exige o "terminei"; se o evento final não vier, libera.
      q.asyncAfter(deadline: .now() + 25) { [self] in
        if let c = completions.removeValue(forKey: identifier) { DispatchQueue.main.async { c() } }
      }
    }
  }

  func drainSoon(_ reason: String, delay: Double = 3) {
    q.asyncAfter(deadline: .now() + delay) { [self] in drain(reason) }
  }

  // MARK: - sessão

  private func attach(_ sid: String) -> URLSession {
    if let s = sessions[sid] { return s }
    let cfg = URLSessionConfiguration.background(withIdentifier: sid)
    cfg.sharedContainerIdentifier = Self.appGroup
    cfg.sessionSendsLaunchEvents = true
    cfg.isDiscretionary = false
    let oq = OperationQueue()
    oq.maxConcurrentOperationCount = 1
    oq.underlyingQueue = q
    let s = URLSession(configuration: cfg, delegate: self, delegateQueue: oq)
    sessions[sid] = s
    return s
  }

  // MARK: - jobs

  private func jobFiles() -> [URL] {
    guard let d = Self.dir("jobs"),
          let files = try? FileManager.default.contentsOfDirectory(at: d, includingPropertiesForKeys: nil) else { return [] }
    return files.filter { $0.pathExtension == "json" }
  }

  private func read(_ f: URL) -> [String: Any]? {
    guard let d = try? Data(contentsOf: f) else { return nil }
    return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
  }

  private func jobURL(_ cmi: String) -> URL? {
    if cmi.isEmpty || cmi.contains("/") { return nil }
    return Self.dir("jobs")?.appendingPathComponent(cmi + ".json")
  }

  private func save(_ f: URL, _ j: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: j) { try? d.write(to: f, options: .atomic) }
  }

  /// A mídia NÃO é apagada aqui: o mesmo arquivo serve a várias conversas
  /// (um job por destinatário). `sweep` apaga o lote quando nenhum job o usa.
  private func removeJob(_ f: URL, _ j: [String: Any]) {
    let body = str(j["body"]); if !body.isEmpty { try? FileManager.default.removeItem(atPath: body) }
    try? FileManager.default.removeItem(at: f)
  }

  private func drain(_ reason: String) {
    if draining { return }
    draining = true
    let t = nowMs()
    var bySession: [String: [URL]] = [:]
    for f in jobFiles() {
      guard let j = read(f) else { try? FileManager.default.removeItem(at: f); continue }
      let state = str(j["state"])
      let created = ChatyyOutboxUtil.dbl(j["created_at"])
      var updated = ChatyyOutboxUtil.dbl(j["updated_at"]); if updated <= 0 { updated = created }
      switch state {
      case "sent":
        removeJob(f, j)
      case "failed", "handed":
        if t - updated > Self.keepMs { removeJob(f, j) }
      default:
        if t - created < Self.extensionGraceMs { continue }
        bySession[str(j["session"]), default: []].append(f)
      }
    }
    if bySession.isEmpty { draining = false; sweep(); return }
    let group = DispatchGroup()
    for (sid, files) in bySession {
      if !Self.isShareSession(sid) {
        for f in files { if let j = read(f) { handOff(f, j, reason: "orphan") } }
        continue
      }
      group.enter()
      let session = attach(sid)
      // reatar entrega os eventos já concluídos ao delegate; espera um pouco antes
      // de decidir quem ficou órfão (senão reenviaríamos o que acabou de dar certo)
      q.asyncAfter(deadline: .now() + 3) { [self] in
        session.getAllTasks { tasks in
          self.q.async {
            let live = Set(tasks.filter { $0.state == .running || $0.state == .suspended }.compactMap { $0.taskDescription })
            for f in files {
              guard let j = self.read(f) else { continue }
              let st = self.str(j["state"])
              if (st == "pending" || st == "retry") && !live.contains(self.str(j["cmi"])) {
                self.handOff(f, j, reason: "orphan")
              }
            }
            group.leave()
          }
        }
      }
    }
    group.notify(queue: q) { [self] in
      draining = false
      sweep()
    }
  }

  /// Entrega o job à fila nativa do app (mesmo cmi → dedupe no servidor).
  private func handOff(_ f: URL, _ j: [String: Any], reason: String) {
    var job = j
    let account = str(j["account"]).lowercased()
    let cmi = str(j["cmi"]), conv = str(j["conv"])
    if account.isEmpty || cmi.isEmpty || conv.isEmpty { removeJob(f, j); return }
    if OutboxKeychain.load(account: account) == nil {
      let ud = UserDefaults(suiteName: Self.appGroup)
      let token = ud?.string(forKey: "chatyy.auth_token") ?? ""
      let email = (ud?.string(forKey: "chatyy.auth_email") ?? "").lowercased()
      if token.isEmpty || email != account { return } // sem credencial desta conta: tenta no próximo dreno
      ChatOutbox.shared.configure(account: account, token: token, base: Self.origin)
    }
    var convValue: Any = conv
    if let n = Int(conv) { convValue = NSNumber(value: n) }
    let media = str(j["kind"]) == "media"
    var body: [String: Any] = [
      "conversation_id": convValue,
      "content": str(j["caption"]),
      "type": media ? str(j["msg_type"]) : "text",
      "client_message_id": cmi,
    ]
    var item: [String: Any] = ["cmi": cmi, "conv": conv, "kind": media ? "media" : "text"]
    if media {
      let file = str(j["file"])
      if file.isEmpty || !FileManager.default.fileExists(atPath: file) {
        job["state"] = "failed"; job["err"] = "no_local_file"; job["updated_at"] = nowMs()
        save(f, job); return
      }
      body["view_once"] = 0
      item["file"] = file
      item["up"] = [
        "filename": str(j["file_name"]).isEmpty ? (file as NSString).lastPathComponent : str(j["file_name"]),
        "mime": str(j["mime"]).isEmpty ? "application/octet-stream" : str(j["mime"]),
        "context": "chat",
        "user_email": account,
      ]
    } else if str(j["caption"]).isEmpty {
      removeJob(f, j); return
    }
    item["body"] = body
    let st = ChatOutbox.shared.submit(account: account, item: item)
    if st.isEmpty { return } // store indisponível: próximo dreno
    if st == "failed" { ChatOutbox.shared.retry(account: account, cmi: cmi) }
    job["state"] = "handed"
    job["handed_reason"] = reason
    job["updated_at"] = nowMs()
    let b = str(j["body"]); if !b.isEmpty { try? FileManager.default.removeItem(atPath: b) }
    save(f, job)
    NSLog("[ChatyyShareOutbox] handed to native outbox cmi=%@ (%@)", cmi, reason)
  }

  /// Lixo: lote de staging que nenhum job referencia (> 10 min — a extensão pode
  /// ainda estar na tela) ou com mais de 7 dias; corpos órfãos com mais de 1 dia.
  private func sweep() {
    let fm = FileManager.default
    let now = Date()
    var referenced = Set<String>()
    for f in jobFiles() {
      if let j = read(f) {
        let file = str(j["file"])
        if !file.isEmpty { referenced.insert((file as NSString).deletingLastPathComponent) }
      }
    }
    if let d = Self.dir("staging"),
       let batches = try? fm.contentsOfDirectory(at: d, includingPropertiesForKeys: [.contentModificationDateKey]) {
      for u in batches {
        let m = (try? u.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? now
        let age = now.timeIntervalSince(m)
        if age > 7 * 24 * 3600 || (age > 600 && !referenced.contains(u.path) && !referenced.contains(u.resolvingSymlinksInPath().path)) {
          try? fm.removeItem(at: u)
        }
      }
    }
    if let d = Self.dir("bodies"),
       let bodies = try? fm.contentsOfDirectory(at: d, includingPropertiesForKeys: [.contentModificationDateKey]) {
      for u in bodies {
        let m = (try? u.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? now
        if now.timeIntervalSince(m) > 24 * 3600 { try? fm.removeItem(at: u) }
      }
    }
  }

  // MARK: - URLSessionDataDelegate (fila q)

  private func key(_ s: URLSession, _ t: URLSessionTask) -> String {
    return (s.configuration.identifier ?? "") + "|\(t.taskIdentifier)"
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    received[key(session, dataTask), default: Data()].append(data)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let data = received.removeValue(forKey: key(session, task)) ?? Data()
    guard let cmi = task.taskDescription, let f = jobURL(cmi), var j = read(f) else { return }
    let code = error == nil ? ((task.response as? HTTPURLResponse)?.statusCode ?? 0) : 0
    let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    let ok = (obj?["success"] as? Bool) == true || (obj?["success"] as? NSNumber)?.boolValue == true
    if (200...299).contains(code) && ok {
      removeJob(f, j)
      NSLog("[ChatyyShareOutbox] sent cmi=%@", cmi)
      return
    }
    var msg = str(obj?["message"]); if msg.isEmpty { msg = str(obj?["error"]) }
    if msg.isEmpty { msg = error.map { "net: " + $0.localizedDescription } ?? "HTTP \(code)" }
    let transient = error != nil || code == 0 || code == 401 || code == 408 || code == 425 || code == 429 || code >= 500
    j["err"] = String(msg.prefix(160))
    j["updated_at"] = nowMs()
    if transient {
      j["state"] = "retry"
      save(f, j)
      handOff(f, j, reason: "transient")
    } else {
      j["state"] = "failed"
      let b = str(j["body"]); if !b.isEmpty { try? FileManager.default.removeItem(atPath: b) }
      save(f, j)
      NSLog("[ChatyyShareOutbox] failed cmi=%@ code=%d", cmi, code)
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    let id = session.configuration.identifier ?? ""
    if let c = completions.removeValue(forKey: id) { DispatchQueue.main.async { c() } }
  }
}
