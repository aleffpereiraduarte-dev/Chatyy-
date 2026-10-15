import Foundation
import Network
import UIKit
import CryptoKit

// [2026-10-15 native-media-dl] Download NATIVO de mídia recebida (apiVersion 5).
//
// Founder: "quando receber vídeo, áudio, foto, mostrar BAIXANDO igual WhatsApp".
//   • URLSession downloadTask com delegate → progresso REAL (bytes) por chave;
//   • chave estável vinda do JS (`dl.k` = mediaCache.mediaUrlKey: hash da URL
//     SEM exp/sig/token) = nome do arquivo no MESMO diretório de cache do
//     mediaCache (JS manda via configureTransfers) → o JS adota o arquivo
//     (finishExternalDownload: syncIndex + store da conversa + galeria);
//   • cancelar guarda o resumeData (retomada do ponto onde parou);
//   • até 3 downloads simultâneos; toque do usuário fura a fila;
//   • auto-download respeita a matriz do usuário (fotos/áudio/vídeos/docs ×
//     Wi-Fi/dados) + economia de dados / Modo Dados Reduzidos do iOS;
//   • progresso EXTERNO (download do próprio JS: WS/abertura da conversa, ou
//     upload) entra por setTransfers e pinta o MESMO anel.
// Todo o estado vive na main; o delegate do URLSession só despacha p/ a main.

struct CMLMediaDL: Equatable {
  var url: String = ""
  var key: String = ""
  var bucket: String = "photos"   // photos | videos | audio | documents
  var size: Int64 = 0
  var alt: [String] = []
  var js: Bool = false             // o JS já está baixando esta chave

  static func parse(_ v: Any?) -> CMLMediaDL? {
    guard let d = v as? [String: Any] else { return nil }
    var o = CMLMediaDL()
    o.url = CMLRow.str(d["u"])
    o.key = CMLTransfers.safeKey(CMLRow.str(d["k"]))
    if o.url.isEmpty || o.key.isEmpty { return nil }
    let b = CMLRow.str(d["a"])
    if !b.isEmpty { o.bucket = b }
    o.size = Int64(max(0, CMLRow.num(d["sz"]) ?? 0))
    o.alt = ((d["alt"] as? [Any]) ?? []).map { CMLRow.str($0) }.filter { !$0.isEmpty }
    o.js = CMLRow.bool(d["js"])
    return o
  }
}

enum CMLXferState { case none, queued, running, paused, done, failed }

final class CMLXfer {
  let key: String
  var state: CMLXferState = .none
  var loaded: Int64 = 0
  var total: Int64 = 0
  var local: String?
  /// progresso vindo do JS (setTransfers) — o nativo não inicia por cima
  var external = false
  var user = false
  var autoTried = false
  var retries = 0
  /// total desconhecido (JS só mandou %) → não mostra "x de y"
  var approx = false
  init(key: String) { self.key = key }
  var fraction: Double { return total > 0 ? min(1, max(0, Double(loaded) / Double(total))) : 0 }
}

/// Lista (ou outra view) que mostra anéis de transferência.
protocol CMLTransferObserver: AnyObject {
  func transferChanged(_ key: String)
  /// evento p/ o JS (start/done/failed/cancelled)
  func transferEvent(_ body: [String: Any])
}

final class CMLTransfers: NSObject, URLSessionDownloadDelegate {
  static let shared = CMLTransfers()
  static let maxConcurrent = 3

  private var items: [String: CMLXfer] = [:]
  private var specs: [String: CMLMediaDL] = [:]
  private var queue: [String] = []
  private var tasks: [String: URLSessionDownloadTask] = [:]
  private var taskKeys: [Int: String] = [:]
  private var altIndex: [String: Int] = [:]
  private var resumeData: [String: Data] = [:]
  private var lastNotify: [String: CFTimeInterval] = [:]
  private var owners: [String: WeakObserver] = [:]
  private var observers: [WeakObserver] = []
  private var session: URLSession!

  // política (JS → configureTransfers)
  private(set) var dir: URL?
  /// cópia p/ a fila do delegate (sem main.sync)
  private let lock = NSLock()
  private var dirLocked: URL?
  private var policy: [String: [String: Int]] = [
    "photos": ["wifi": 1, "mobile": 1],
    "audio": ["wifi": 1, "mobile": 1],
    "videos": ["wifi": 1, "mobile": 1],
    "documents": ["wifi": 1, "mobile": 0],
  ]
  private var saver = false
  private(set) var ofTemplate = "{a} / {b}"
  private let monitor = NWPathMonitor()
  private var net: String = "unknown"     // wifi | mobile | none | unknown
  private var constrained = false

  final class WeakObserver { weak var o: CMLTransferObserver?; init(_ o: CMLTransferObserver) { self.o = o } }

  private override init() {
    super.init()
    let cfg = URLSessionConfiguration.default
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    cfg.urlCache = nil
    cfg.timeoutIntervalForRequest = 45
    cfg.httpMaximumConnectionsPerHost = 4
    let q = OperationQueue()
    q.maxConcurrentOperationCount = 1
    q.name = "br.com.chatyy.messagelist.xfer"
    session = URLSession(configuration: cfg, delegate: self, delegateQueue: q)
    monitor.pathUpdateHandler = { [weak self] path in
      var n = "none"
      if path.status == .satisfied {
        if path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet) { n = "wifi" }
        else if path.usesInterfaceType(.cellular) || path.isExpensive { n = "mobile" }
        else { n = "wifi" }
      }
      let c: Bool
      if #available(iOS 13.0, *) { c = path.isConstrained } else { c = false }
      DispatchQueue.main.async {
        guard let self = self else { return }
        let was = self.net
        self.net = n
        self.constrained = c
        if (was == "none" || was == "unknown") && n != "none" { self.pump() }
      }
    }
    monitor.start(queue: DispatchQueue(label: "br.com.chatyy.messagelist.net"))
  }

  // MARK: observadores

  func addObserver(_ o: CMLTransferObserver) {
    observers.removeAll { $0.o == nil || $0.o === o }
    observers.append(WeakObserver(o))
  }

  func removeObserver(_ o: CMLTransferObserver) {
    observers.removeAll { $0.o == nil || $0.o === o }
  }

  private func notify(_ key: String, force: Bool) {
    let now = CACurrentMediaTime()
    if !force, let t = lastNotify[key], now - t < 0.05 { return }
    lastNotify[key] = now
    for w in observers { w.o?.transferChanged(key) }
  }

  private func emit(_ key: String, _ st: String) {
    var body: [String: Any] = ["k": key, "st": st]
    if let s = specs[key] { body["url"] = s.url; body["b"] = s.bucket }
    if let it = items[key], let l = it.local { body["local"] = URL(fileURLWithPath: l).absoluteString }
    if let it = items[key] { body["user"] = it.user ? 1 : 0 }
    let target = owners[key]?.o ?? observers.first(where: { $0.o != nil })?.o
    target?.transferEvent(body)
  }

  // MARK: configuração / política

  func configure(_ d: [String: Any]) {
    if let s = d["dir"] as? String, !s.isEmpty {
      var u: URL?
      if s.hasPrefix("file://") { u = URL(string: s) } else if s.hasPrefix("/") { u = URL(fileURLWithPath: s, isDirectory: true) }
      if let u = u {
        dir = u
        lock.lock(); dirLocked = u; lock.unlock()
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
      }
    }
    if let p = d["policy"] as? [String: Any] {
      for (b, v) in p {
        guard let cell = v as? [String: Any] else { continue }
        var m: [String: Int] = [:]
        for (col, x) in cell { m[col] = CMLRow.bool(x) ? 1 : 0 }
        policy[b] = m
      }
    }
    if d["saver"] != nil { saver = CMLRow.bool(d["saver"]) }
    if let t = d["of"] as? String, t.contains("{a}"), t.contains("{b}") { ofTemplate = t }
  }

  func allowsAuto(_ bucket: String) -> Bool {
    if dir == nil { return false }
    let col: String
    switch net {
    case "wifi": col = "wifi"
    case "none": return false
    default: col = "mobile"
    }
    if col != "wifi" && (saver || constrained) { return false }
    return (policy[bucket]?[col] ?? 0) == 1
  }

  // MARK: estado

  func item(_ key: String) -> CMLXfer? { return key.isEmpty ? nil : items[key] }

  private func ensure(_ key: String) -> CMLXfer {
    if let x = items[key] { return x }
    let x = CMLXfer(key: key)
    items[key] = x
    return x
  }

  /// Arquivo já no cache (baixado antes pelo JS ou por esta lista)? Marca done.
  @discardableResult
  func probe(_ dl: CMLMediaDL) -> CMLXfer {
    let x = ensure(dl.key)
    if specs[dl.key] == nil { specs[dl.key] = dl }
    if x.state == .done, let l = x.local, FileManager.default.fileExists(atPath: l) { return x }
    if x.state == .done { x.state = .none; x.local = nil }
    if x.state == .none, let d = dir {
      let dest = d.appendingPathComponent(dl.key)
      if CMLTransfers.fileSize(dest.path) > 0 {
        x.state = .done; x.local = dest.path; x.loaded = CMLTransfers.fileSize(dest.path); x.total = x.loaded
      } else if !dl.js && adoptLegacyImage(dl) {
        // já estava no cache antigo da lista → nada a baixar
      }
      // achou pronto no disco → o JS adota (syncIndex/store) e a linha deixa de mandar `dl`
      if x.state == .done { DispatchQueue.main.async { self.emit(dl.key, "done") } }
    }
    if x.total <= 0 && dl.size > 0 { x.total = dl.size }
    return x
  }

  /// Toque / auto: começa (ou retoma) o download.
  func start(_ dl: CMLMediaDL, user: Bool, owner: CMLTransferObserver?) {
    guard dir != nil, !dl.key.isEmpty else { return }
    let x = probe(dl)
    specs[dl.key] = dl
    if let o = owner { owners[dl.key] = WeakObserver(o) }
    if x.state == .done {
      emit(dl.key, "done")
      notify(dl.key, force: true)
      return
    }
    if x.external && x.state == .running { return }
    if x.state == .running || x.state == .queued {
      if user, let i = queue.firstIndex(of: dl.key), i > 0 { queue.remove(at: i); queue.insert(dl.key, at: 0) }
      return
    }
    x.user = x.user || user
    if user { x.retries = 0 }
    if !user { x.autoTried = true }
    x.state = .queued
    x.external = false
    if user { queue.insert(dl.key, at: 0) } else { queue.append(dl.key) }
    emit(dl.key, "start")
    notify(dl.key, force: true)
    pump()
  }

  /// X do anel.
  func cancel(_ key: String) {
    guard let x = items[key] else { return }
    queue.removeAll { $0 == key }
    if let t = tasks[key] {
      tasks[key] = nil
      taskKeys[t.taskIdentifier] = nil
      t.cancel(byProducingResumeData: { [weak self] data in
        DispatchQueue.main.async { if let d = data { self?.resumeData[key] = d } }
      })
    }
    if x.state == .queued || x.state == .running {
      x.state = .paused
      x.user = true // cancelado pelo usuário → auto não religa
      emit(key, "cancelled")
      notify(key, force: true)
      pump()
    }
  }

  /// Progresso vindo do JS. st: q (fila) | p (andamento, p 0..100) | d (pronto, l = caminho) | f | c
  func setExternal(_ list: [[String: Any]]) {
    for e in list {
      let key = CMLTransfers.safeKey(CMLRow.str(e["k"]))
      if key.isEmpty { continue }
      let x = ensure(key)
      let st = CMLRow.str(e["st"])
      if tasks[key] != nil && st != "d" { continue } // o nativo já baixa esta chave
      switch st {
      case "q", "p":
        if x.state == .done { continue }
        x.external = true
        x.state = .running
        if let t = CMLRow.num(e["t"]), t > 0 { x.total = Int64(t); x.approx = false }
        else if x.total <= 0 {
          if let s = specs[key], s.size > 0 { x.total = s.size; x.approx = false } else { x.total = 1000; x.approx = true }
        }
        if let l = CMLRow.num(e["l"]), l > 0 { x.loaded = Int64(l) }
        else if let p = CMLRow.num(e["p"]) { x.loaded = Int64(Double(x.total) * max(0, min(100, p)) / 100) }
      case "d":
        let l = CMLRow.str(e["l"])
        let path = l.hasPrefix("file://") ? (URL(string: l)?.path ?? "") : l
        x.external = false
        x.state = .done
        if !path.isEmpty { x.local = path }
        x.loaded = max(x.loaded, x.total)
      case "f", "c":
        if x.state == .done { continue }
        x.external = false
        x.state = st == "c" ? .paused : .failed
      default: continue
      }
      notify(key, force: st != "p")
    }
  }

  // MARK: fila

  private func pump() {
    while tasks.count < CMLTransfers.maxConcurrent, !queue.isEmpty {
      let key = queue.removeFirst()
      guard let x = items[key], x.state == .queued, let dl = specs[key] else { continue }
      begin(key, dl, x)
    }
  }

  private func begin(_ key: String, _ dl: CMLMediaDL, _ x: CMLXfer) {
    let idx = altIndex[key] ?? 0
    let cands = [dl.url] + dl.alt
    let src = cands[min(idx, cands.count - 1)]
    let task: URLSessionDownloadTask
    if let rd = resumeData.removeValue(forKey: key) {
      task = session.downloadTask(withResumeData: rd)
    } else {
      guard let u = CMLImageLoader.remoteURL(src) else { fail(key, x); return }
      task = session.downloadTask(with: u)
      x.loaded = 0
    }
    task.priority = x.user ? URLSessionTask.highPriority : URLSessionTask.defaultPriority
    task.taskDescription = key
    tasks[key] = task
    taskKeys[task.taskIdentifier] = key
    x.state = .running
    notify(key, force: true)
    task.resume()
  }

  private func fail(_ key: String, _ x: CMLXfer) {
    x.state = .failed
    emit(key, "failed")
    notify(key, force: true)
    pump()
  }

  // MARK: URLSessionDownloadDelegate (fila serial do session → main)

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    let id = downloadTask.taskIdentifier
    DispatchQueue.main.async {
      guard let key = self.taskKeys[id], let x = self.items[key] else { return }
      x.loaded = totalBytesWritten
      if totalBytesExpectedToWrite > 0 { x.total = totalBytesExpectedToWrite; x.approx = false }
      else if let s = self.specs[key], s.size > 0 { x.total = s.size }
      self.notify(key, force: false)
    }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didResumeAtOffset fileOffset: Int64, expectedTotalBytes: Int64) {
    let id = downloadTask.taskIdentifier
    DispatchQueue.main.async {
      guard let key = self.taskKeys[id], let x = self.items[key] else { return }
      x.loaded = fileOffset
      if expectedTotalBytes > 0 { x.total = expectedTotalBytes }
      self.notify(key, force: true)
    }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    // O arquivo temporário some quando este método retorna → move AQUI.
    let id = downloadTask.taskIdentifier
    let http = downloadTask.response as? HTTPURLResponse
    let status = http?.statusCode ?? 200
    let mime = (http?.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
    let key = downloadTask.taskDescription
    lock.lock(); let d = dirLocked; lock.unlock()
    guard let k = key, !k.isEmpty, let dir = d else { return }
    var ok = false
    // 200 com o index.html do SPA (edge sem o arquivo) nunca vira "foto"
    if (200..<300).contains(status) && !mime.hasPrefix("text/html") && CMLTransfers.fileSize(location.path) > 0 {
      let dest = dir.appendingPathComponent(k)
      let tmp = dir.appendingPathComponent(k + ".part")
      try? FileManager.default.removeItem(at: tmp)
      if (try? FileManager.default.moveItem(at: location, to: tmp)) != nil {
        try? FileManager.default.removeItem(at: dest)
        ok = (try? FileManager.default.moveItem(at: tmp, to: dest)) != nil
      }
    }
    let path = dir.appendingPathComponent(k).path
    let notFound = status == 404 || status == 410 || status == 403 || mime.hasPrefix("text/html")
    DispatchQueue.main.async {
      guard let x = self.items[k] else { return }
      let current = self.taskKeys[id] == k
      if current { self.taskKeys[id] = nil; self.tasks[k] = nil }
      if !ok && !current { return } // cancelado no meio
      if ok {
        x.state = .done
        x.local = path
        x.loaded = max(x.loaded, CMLTransfers.fileSize(path))
        x.total = max(x.total, x.loaded)
        self.altIndex[k] = nil
        self.emit(k, "done")
        self.notify(k, force: true)
        self.pump()
      } else if notFound, let s = self.specs[k], (self.altIndex[k] ?? 0) < s.alt.count {
        // próximo host (origem / CDN) antes de desistir
        self.altIndex[k] = (self.altIndex[k] ?? 0) + 1
        x.state = .queued
        self.queue.insert(k, at: 0)
        self.pump()
      } else {
        self.fail(k, x)
      }
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let error = error else { return }
    let id = task.taskIdentifier
    let ns = error as NSError
    let rd = ns.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
    let cancelled = ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
    DispatchQueue.main.async {
      guard let k = self.taskKeys[id] else { return } // cancel() já limpou
      self.taskKeys[id] = nil
      self.tasks[k] = nil
      guard let x = self.items[k] else { return }
      if let rd = rd { self.resumeData[k] = rd }
      if cancelled { x.state = .paused; self.notify(k, force: true); self.pump(); return }
      // falha de rede: 1 nova tentativa automática (retoma do resumeData)
      if x.retries < 1 {
        x.retries += 1
        x.state = .queued
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
          guard x.state == .queued else { return }
          self.queue.append(k)
          self.pump()
        }
        self.notify(k, force: true)
        return
      }
      self.fail(k, x)
    }
  }

  // MARK: util

  static func fileSize(_ path: String) -> Int64 {
    guard let a = try? FileManager.default.attributesOfItem(atPath: path), let n = a[.size] as? NSNumber else { return 0 }
    return n.int64Value
  }

  /// Só [A-Za-z0-9._-] (é nome de arquivo); nada de ../
  static func safeKey(_ k: String) -> String {
    if k.isEmpty || k.count > 160 || k.hasPrefix(".") { return "" }
    for u in k.unicodeScalars {
      let ok = (u.value >= 48 && u.value <= 57) || (u.value >= 65 && u.value <= 90) || (u.value >= 97 && u.value <= 122) || u == "." || u == "_" || u == "-"
      if !ok { return "" }
    }
    return k
  }

  private static let sizeFmt: NumberFormatter = {
    let f = NumberFormatter()
    f.locale = Locale.current
    f.numberStyle = .decimal
    f.minimumFractionDigits = 1
    f.maximumFractionDigits = 1
    return f
  }()

  /// "12,4 MB" (separador decimal do idioma do aparelho)
  static func formatBytes(_ b: Int64) -> String {
    if b <= 0 { return "" }
    let d = Double(b)
    if d < 1024 { return "\(b) B" }
    if d < 1024 * 1024 { return "\(Int((d / 1024).rounded())) KB" }
    let mb = d / (1024 * 1024)
    if mb < 1000 { return (sizeFmt.string(from: NSNumber(value: mb)) ?? String(format: "%.1f", mb)) + " MB" }
    return (sizeFmt.string(from: NSNumber(value: mb / 1024)) ?? String(format: "%.1f", mb / 1024)) + " GB"
  }

  /// "1,2 MB de 4,5 MB" (modelo traduzido vindo do JS)
  func progressText(_ x: CMLXfer) -> String {
    if x.total <= 0 || x.approx { return "" }
    return ofTemplate.replacingOccurrences(of: "{a}", with: CMLTransfers.formatBytes(max(x.loaded, 1)))
      .replacingOccurrences(of: "{b}", with: CMLTransfers.formatBytes(x.total))
  }

  /// Arquivo que o carregador de imagens da lista já tinha em disco
  /// (Caches/chatyy-media-viewer/<sha256(url estável)>) — evita baixar de novo.
  func adoptLegacyImage(_ dl: CMLMediaDL) -> Bool {
    guard let d = dir, dl.bucket == "photos" else { return false }
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
    guard let b = base else { return false }
    let legacyDir = b.appendingPathComponent("chatyy-media-viewer", isDirectory: true)
    for u in [CMLImageLoader.stableURI(dl.url), dl.url] {
      let f = legacyDir.appendingPathComponent(CMLImageLoader.sha256(u))
      if CMLTransfers.fileSize(f.path) > 0 {
        let dest = d.appendingPathComponent(dl.key)
        try? FileManager.default.removeItem(at: dest)
        if (try? FileManager.default.copyItem(at: f, to: dest)) != nil {
          let x = ensure(dl.key)
          specs[dl.key] = dl
          x.state = .done
          x.local = dest.path
          x.loaded = CMLTransfers.fileSize(dest.path)
          x.total = x.loaded
          return true
        }
      }
    }
    return false
  }
}
