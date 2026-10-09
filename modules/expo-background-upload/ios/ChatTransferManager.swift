import Foundation
import UIKit

/// [2026-10-09 media-native] Chat media transfers that survive the app being
/// suspended or killed (WhatsApp parity) — iOS background URLSession.
///
/// UPLOAD (large chat media): JS (services/bgTransfer.js) opens / resumes the
/// Rust chunked session (`/api/rust/upload/init|status`) and hands us the
/// upload id + the chunk indexes the server still lacks. We write one
/// multipart body file per chunk (same wire format as
/// services/api.js rustChunkedUploadNative: fields upload_id, chunk_index,
/// chunk) and enqueue ALL of them as background upload tasks — nsurlsessiond
/// keeps sending while the app is suspended and relaunches it in background
/// when they finish. Last step: POST `/upload/complete` (also a background
/// upload task, JSON body file) whose response (cdn_url …) is stored in the
/// transfer record. JS reconciles on resume/launch and commits chat_send.
///
/// DOWNLOAD (large videos / documents): background download task, the file is
/// moved to the caller's destination path; network errors resume with the
/// system's resumeData.
///
/// State: one JSON record per transfer in Application Support/chatyy-transfers
/// (survives relaunch); tasks are mapped back by `taskDescription`
/// ("u|<id>|<chunk>", "c|<id>", "d|<id>"). Every mutation runs on `queue`.
final class ChatTransferManager: NSObject, URLSessionDataDelegate, URLSessionDownloadDelegate {
  static let shared = ChatTransferManager()
  static let sessionIdentifier = "com.onemundo.mail.chatTransfer"

  /// Set by ChatTransferModule while JS is alive: (eventName, body).
  var emitter: ((String, [String: Any]) -> Void)?

  private let queue = DispatchQueue(label: "chatyy.chatTransfer")
  private var session: URLSession?
  private var records: [String: [String: Any]] = [:]
  private var loaded = false
  private var responseData: [Int: Data] = [:]
  private var lastProgressEmit: [String: TimeInterval] = [:]
  private var inflightBytes: [String: [Int: Int64]] = [:]
  private var reconciled = false

  private static let maxChunkAttempts = 8
  private static let maxDownloadAttempts = 6

  // MARK: - Paths

  private lazy var recordsDir: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let dir = base.appendingPathComponent("chatyy-transfers", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }()

  private lazy var bodiesDir: URL = {
    // Not Caches: iOS may purge Caches while we are suspended mid-upload.
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let dir = base.appendingPathComponent("chatyy-transfer-bodies", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var u = dir
    var rv = URLResourceValues()
    rv.isExcludedFromBackup = true
    try? u.setResourceValues(rv)
    return dir
  }()

  // MARK: - Session

  /// Idempotent. Called from module OnCreate and from the AppDelegate's
  /// handleEventsForBackgroundURLSession (relaunch in background).
  func ensureSession() {
    queue.sync { self.ensureSessionLocked() }
  }

  private func ensureSessionLocked() {
    loadRecordsLocked()
    if session != nil { return }
    let config = URLSessionConfiguration.background(withIdentifier: ChatTransferManager.sessionIdentifier)
    config.isDiscretionary = false
    config.sessionSendsLaunchEvents = true
    config.allowsCellularAccess = true
    config.httpMaximumConnectionsPerHost = 3
    config.timeoutIntervalForResource = 60 * 60 * 24 * 3
    let opq = OperationQueue()
    opq.maxConcurrentOperationCount = 1
    opq.underlyingQueue = queue
    session = URLSession(configuration: config, delegate: self, delegateQueue: opq)
    reconcileLocked()
  }

  /// After a relaunch: anything a record still needs but has no live task
  /// gets re-enqueued (e.g. the process died while we were writing bodies).
  private func reconcileLocked() {
    guard !reconciled, let s = session else { return }
    reconciled = true
    s.getAllTasks { [weak self] tasks in
      guard let self = self else { return }
      self.queue.async {
        var live = Set<String>()
        for t in tasks { if let d = t.taskDescription { live.insert(d) } }
        for (id, rec) in self.records {
          let state = rec["state"] as? String ?? ""
          guard state == "running" || state == "queued" else { continue }
          let kind = rec["kind"] as? String ?? ""
          if kind == "upload" {
            if (rec["completing"] as? Bool) == true {
              if !live.contains("c|\(id)") { self.startCompleteLocked(id) }
              continue
            }
            let pending = (rec["pending"] as? [Int]) ?? []
            if pending.isEmpty {
              self.startCompleteLocked(id)
              continue
            }
            for i in pending where !live.contains("u|\(id)|\(i)") {
              self.startChunkLocked(id, chunk: i)
            }
          } else if kind == "download" {
            if !live.contains("d|\(id)") { self.startDownloadLocked(id, resumeData: nil) }
          }
        }
      }
    }
  }

  // MARK: - Records

  private func loadRecordsLocked() {
    if loaded { return }
    loaded = true
    let fm = FileManager.default
    guard let files = try? fm.contentsOfDirectory(at: recordsDir, includingPropertiesForKeys: nil) else { return }
    let now = Date().timeIntervalSince1970
    for f in files where f.pathExtension == "json" {
      guard let data = try? Data(contentsOf: f),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let id = obj["id"] as? String else { continue }
      // Finished records nobody collected in 7 days → drop.
      let updated = obj["updatedAt"] as? Double ?? 0
      let state = obj["state"] as? String ?? ""
      if state != "running" && state != "queued" && now - updated > 7 * 86400 {
        try? fm.removeItem(at: f)
        continue
      }
      records[id] = obj
    }
  }

  private func recordURL(_ id: String) -> URL {
    let safe = id.replacingOccurrences(of: "/", with: "_")
    return recordsDir.appendingPathComponent("\(safe).json")
  }

  private func saveLocked(_ id: String) {
    guard var rec = records[id] else { return }
    rec["updatedAt"] = Date().timeIntervalSince1970
    records[id] = rec
    if let data = try? JSONSerialization.data(withJSONObject: rec) {
      try? data.write(to: recordURL(id), options: .atomic)
    }
  }

  private func publicView(_ rec: [String: Any]) -> [String: Any] {
    var out: [String: Any] = [
      "id": rec["id"] ?? "",
      "kind": rec["kind"] ?? "",
      "state": rec["state"] ?? "",
      "progress": rec["progress"] ?? 0.0,
    ]
    if let r = rec["result"] { out["result"] = r }
    if let e = rec["error"] { out["error"] = e }
    if let h = rec["httpStatus"] { out["httpStatus"] = h }
    if let d = rec["dest"] { out["dest"] = d }
    return out
  }

  private func emit(_ name: String, _ body: [String: Any]) {
    guard let e = emitter else { return }
    DispatchQueue.main.async { e(name, body) }
  }

  private func finishLocked(_ id: String, state: String, error: String? = nil, httpStatus: Int? = nil) {
    guard var rec = records[id] else { return }
    rec["state"] = state
    rec.removeValue(forKey: "bearer")
    if state == "done" { rec["progress"] = 1.0 }
    if let e = error { rec["error"] = e }
    if let h = httpStatus { rec["httpStatus"] = h }
    records[id] = rec
    saveLocked(id)
    inflightBytes.removeValue(forKey: id)
    lastProgressEmit.removeValue(forKey: id)
    // Leftover bodies are useless once finished (success or hard failure).
    try? FileManager.default.removeItem(at: bodiesDir.appendingPathComponent(id, isDirectory: true))
    if state != "done", let s = session {
      // Cancel sibling chunk tasks of a failed/cancelled upload.
      s.getAllTasks { tasks in
        for t in tasks {
          guard let d = t.taskDescription else { continue }
          if d == "c|\(id)" || d == "d|\(id)" || d.hasPrefix("u|\(id)|") { t.cancel() }
        }
      }
    }
    emit("onTransferDone", publicView(records[id] ?? rec))
  }

  // MARK: - Public API (any thread)

  func enqueueUpload(_ spec: [String: Any]) -> Bool {
    guard let id = spec["id"] as? String, !id.isEmpty,
          let fileUri = spec["fileUri"] as? String,
          let base = spec["base"] as? String, base.hasPrefix("https://"),
          let uploadId = spec["uploadId"] as? String, !uploadId.isEmpty,
          let chunkSize = (spec["chunkSize"] as? NSNumber)?.int64Value, chunkSize > 0,
          let totalSize = (spec["totalSize"] as? NSNumber)?.int64Value, totalSize > 0 else {
      return false
    }
    let totalChunks = Int((totalSize + chunkSize - 1) / chunkSize)
    let skip = Set(((spec["skipChunks"] as? [Any]) ?? []).compactMap { ($0 as? NSNumber)?.intValue })
    let pending = (0..<totalChunks).filter { !skip.contains($0) }
    return queue.sync { () -> Bool in
      ensureSessionLocked()
      if let existing = records[id], let st = existing["state"] as? String, st == "running" || st == "queued" {
        // Same transfer handed off twice (JS retry) → keep the running one,
        // just refresh the bearer.
        if let b = spec["bearer"] as? String, !b.isEmpty {
          var r = existing
          r["bearer"] = b
          records[id] = r
          saveLocked(id)
        }
        return true
      }
      let rec: [String: Any] = [
        "id": id,
        "kind": "upload",
        "state": "running",
        "progress": totalChunks > 0 ? Double(totalChunks - pending.count) / Double(totalChunks) : 0.0,
        "fileUri": fileUri,
        "base": base.hasSuffix("/") ? String(base.dropLast()) : base,
        "bearer": spec["bearer"] as? String ?? "",
        "uploadId": uploadId,
        "chunkSize": NSNumber(value: chunkSize),
        "totalSize": NSNumber(value: totalSize),
        "totalChunks": totalChunks,
        "pending": pending,
        "attempts": [String: Int](),
        "filename": spec["filename"] as? String ?? "upload",
        "contentType": spec["contentType"] as? String ?? "application/octet-stream",
        "userEmail": spec["userEmail"] as? String ?? "",
        "context": spec["context"] as? String ?? "chat",
        "completing": false,
        "createdAt": Date().timeIntervalSince1970,
      ]
      records[id] = rec
      saveLocked(id)
      if pending.isEmpty {
        startCompleteLocked(id)
      } else {
        for i in pending { startChunkLocked(id, chunk: i) }
      }
      return true
    }
  }

  func enqueueDownload(_ spec: [String: Any]) -> Bool {
    guard let id = spec["id"] as? String, !id.isEmpty,
          let url = spec["url"] as? String, url.hasPrefix("https://") || url.hasPrefix("http://"),
          let dest = spec["dest"] as? String, !dest.isEmpty else {
      return false
    }
    return queue.sync { () -> Bool in
      ensureSessionLocked()
      if let existing = records[id], let st = existing["state"] as? String {
        if st == "running" || st == "queued" { return true }
        if st == "done", let d = existing["dest"] as? String, d == dest,
           FileManager.default.fileExists(atPath: ChatTransferManager.path(of: d)) {
          emit("onTransferDone", publicView(existing))
          return true
        }
      }
      var rec: [String: Any] = [
        "id": id,
        "kind": "download",
        "state": "running",
        "progress": 0.0,
        "url": url,
        "dest": dest,
        "attempts": 0,
        "createdAt": Date().timeIntervalSince1970,
      ]
      if let h = spec["headers"] as? [String: Any] { rec["headers"] = h }
      records[id] = rec
      saveLocked(id)
      startDownloadLocked(id, resumeData: nil)
      return true
    }
  }

  func get(_ id: String) -> [String: Any]? {
    return queue.sync { () -> [String: Any]? in
      loadRecordsLocked()
      guard let r = records[id] else { return nil }
      return publicView(r)
    }
  }

  func list() -> [[String: Any]] {
    return queue.sync { () -> [[String: Any]] in
      loadRecordsLocked()
      return records.values.map { publicView($0) }
    }
  }

  func cancel(_ id: String) {
    queue.sync {
      guard let rec = records[id], let st = rec["state"] as? String, st == "running" || st == "queued" else { return }
      finishLocked(id, state: "cancelled")
    }
  }

  func forget(_ id: String) {
    queue.sync {
      if let rec = records[id], let st = rec["state"] as? String, st == "running" || st == "queued" {
        finishLocked(id, state: "cancelled")
      }
      records.removeValue(forKey: id)
      try? FileManager.default.removeItem(at: recordURL(id))
    }
  }

  /// Foreground resume: re-check that every running transfer has live tasks.
  func kick() {
    queue.sync {
      ensureSessionLocked()
      reconciled = false
      reconcileLocked()
    }
  }

  func updateBearer(_ bearer: String) {
    guard !bearer.isEmpty else { return }
    queue.sync {
      for (id, rec) in records where (rec["kind"] as? String) == "upload" {
        let st = rec["state"] as? String ?? ""
        guard st == "running" || st == "queued" else { continue }
        var r = rec
        r["bearer"] = bearer
        records[id] = r
        saveLocked(id)
      }
    }
  }

  // MARK: - Upload internals (on queue)

  static func path(of uri: String) -> String {
    if uri.hasPrefix("file://") {
      if let u = URL(string: uri), u.isFileURL { return u.path }
      return String(uri.dropFirst("file://".count))
    }
    return uri
  }

  private func startChunkLocked(_ id: String, chunk: Int, delay: TimeInterval = 0) {
    guard let s = session, let rec = records[id] else { return }
    let fileUri = rec["fileUri"] as? String ?? ""
    let chunkSize = (rec["chunkSize"] as? NSNumber)?.int64Value ?? 0
    let totalSize = (rec["totalSize"] as? NSNumber)?.int64Value ?? 0
    let uploadId = rec["uploadId"] as? String ?? ""
    let base = rec["base"] as? String ?? ""
    let bearer = rec["bearer"] as? String ?? ""
    guard chunkSize > 0, let url = URL(string: "\(base)/api/rust/upload/chunk") else {
      finishLocked(id, state: "failed", error: "bad_record")
      return
    }
    let dir = bodiesDir.appendingPathComponent(id, isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let boundary = "chatyy-\(uploadId)-\(chunk)"
    let bodyURL = dir.appendingPathComponent("c\(chunk).body")
    if !FileManager.default.fileExists(atPath: bodyURL.path) {
      let start = Int64(chunk) * chunkSize
      let len = min(chunkSize, totalSize - start)
      guard len > 0, let fh = FileHandle(forReadingAtPath: ChatTransferManager.path(of: fileUri)) else {
        finishLocked(id, state: "failed", error: "file_missing")
        return
      }
      fh.seek(toFileOffset: UInt64(start))
      let bytes = fh.readData(ofLength: Int(len))
      fh.closeFile()
      if Int64(bytes.count) != len {
        finishLocked(id, state: "failed", error: "short_read")
        return
      }
      var body = Data()
      func field(_ name: String, _ value: String) {
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
      }
      field("upload_id", uploadId)
      field("chunk_index", String(chunk))
      body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"chunk\"; filename=\"chunk_\(chunk).bin\"\r\nContent-Type: application/octet-stream\r\n\r\n".data(using: .utf8)!)
      body.append(bytes)
      body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
      do {
        try body.write(to: bodyURL, options: .atomic)
      } catch {
        finishLocked(id, state: "failed", error: "body_write_failed")
        return
      }
    }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    if !bearer.isEmpty { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
    let task = s.uploadTask(with: req, fromFile: bodyURL)
    task.taskDescription = "u|\(id)|\(chunk)"
    // Retry backoff the system honours even while we are suspended (an
    // asyncAfter would never fire then).
    if delay > 0 { task.earliestBeginDate = Date().addingTimeInterval(delay) }
    task.resume()
  }

  private func startCompleteLocked(_ id: String, delay: TimeInterval = 0) {
    guard let s = session, var rec = records[id] else { return }
    let base = rec["base"] as? String ?? ""
    let bearer = rec["bearer"] as? String ?? ""
    guard let url = URL(string: "\(base)/api/rust/upload/complete") else {
      finishLocked(id, state: "failed", error: "bad_record")
      return
    }
    rec["completing"] = true
    records[id] = rec
    saveLocked(id)
    let payload: [String: Any] = [
      "upload_id": rec["uploadId"] as? String ?? "",
      "filename": rec["filename"] as? String ?? "upload",
      "content_type": rec["contentType"] as? String ?? "application/octet-stream",
      "user_email": rec["userEmail"] as? String ?? "",
      "context": rec["context"] as? String ?? "chat",
    ]
    let dir = bodiesDir.appendingPathComponent(id, isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let bodyURL = dir.appendingPathComponent("complete.json")
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          (try? data.write(to: bodyURL, options: .atomic)) != nil else {
      finishLocked(id, state: "failed", error: "body_write_failed")
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if !bearer.isEmpty { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
    let task = s.uploadTask(with: req, fromFile: bodyURL)
    task.taskDescription = "c|\(id)"
    if delay > 0 { task.earliestBeginDate = Date().addingTimeInterval(delay) }
    task.resume()
  }

  private func startDownloadLocked(_ id: String, resumeData: Data?, delay: TimeInterval = 0) {
    guard let s = session, let rec = records[id] else { return }
    let task: URLSessionDownloadTask
    if let rd = resumeData {
      task = s.downloadTask(withResumeData: rd)
    } else {
      guard let u = URL(string: rec["url"] as? String ?? "") else {
        finishLocked(id, state: "failed", error: "bad_url")
        return
      }
      var req = URLRequest(url: u)
      if let h = rec["headers"] as? [String: Any] {
        for (k, v) in h { if let sv = v as? String { req.setValue(sv, forHTTPHeaderField: k) } }
      }
      task = s.downloadTask(with: req)
    }
    task.taskDescription = "d|\(id)"
    if delay > 0 { task.earliestBeginDate = Date().addingTimeInterval(delay) }
    task.resume()
  }

  private func emitProgressLocked(_ id: String, force: Bool = false) {
    guard let rec = records[id] else { return }
    let now = Date().timeIntervalSince1970
    if !force, let last = lastProgressEmit[id], now - last < 0.25 { return }
    lastProgressEmit[id] = now
    emit("onTransferProgress", ["id": id, "progress": rec["progress"] ?? 0.0])
  }

  private func uploadProgressLocked(_ id: String) {
    guard var rec = records[id] else { return }
    let totalSize = Double((rec["totalSize"] as? NSNumber)?.int64Value ?? 0)
    let chunkSize = Double((rec["chunkSize"] as? NSNumber)?.int64Value ?? 0)
    let totalChunks = rec["totalChunks"] as? Int ?? 0
    let pending = (rec["pending"] as? [Int]) ?? []
    guard totalSize > 0, totalChunks > 0 else { return }
    let doneChunks = Double(totalChunks - pending.count)
    let inflight = Double((inflightBytes[id] ?? [:]).values.reduce(0, +))
    let p = min(0.99, (doneChunks * chunkSize + inflight) / totalSize)
    rec["progress"] = max(0, p)
    records[id] = rec
    emitProgressLocked(id)
  }

  private static func parse(_ desc: String?) -> (kind: String, id: String, chunk: Int)? {
    guard let d = desc else { return nil }
    let parts = d.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
    guard parts.count >= 2 else { return nil }
    if parts[0] == "u", parts.count == 3, let c = Int(parts[2]) { return ("u", parts[1], c) }
    if parts[0] == "c" || parts[0] == "d" { return (parts[0], parts[1], -1) }
    return nil
  }

  private static func retryable(_ status: Int) -> Bool {
    return status == 0 || status == 408 || status == 425 || status == 429 || status >= 500
  }

  // MARK: - URLSession delegate (on queue)

  func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                  totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
    guard let t = ChatTransferManager.parse(task.taskDescription), t.kind == "u" else { return }
    var m = inflightBytes[t.id] ?? [:]
    m[t.chunk] = totalBytesSent
    inflightBytes[t.id] = m
    uploadProgressLocked(t.id)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    var d = responseData[dataTask.taskIdentifier] ?? Data()
    d.append(data)
    if d.count < 256 * 1024 { responseData[dataTask.taskIdentifier] = d }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                  totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    guard let t = ChatTransferManager.parse(downloadTask.taskDescription), t.kind == "d",
          var rec = records[t.id], totalBytesExpectedToWrite > 0 else { return }
    rec["progress"] = min(0.99, Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
    records[t.id] = rec
    emitProgressLocked(t.id)
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    // Must move the file before returning (the temp file is deleted after).
    guard let t = ChatTransferManager.parse(downloadTask.taskDescription), t.kind == "d",
          var rec = records[t.id] else { return }
    let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      rec["lastStatus"] = status
      records[t.id] = rec
      return
    }
    let destPath = ChatTransferManager.path(of: rec["dest"] as? String ?? "")
    let dest = URL(fileURLWithPath: destPath)
    let fm = FileManager.default
    do {
      try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
      if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
      try fm.moveItem(at: location, to: dest)
      rec["moved"] = true
      if let size = (try? fm.attributesOfItem(atPath: dest.path))?[.size] as? NSNumber {
        var res: [String: Any] = ["size": size, "status": status]
        if let mt = downloadTask.response?.mimeType { res["contentType"] = mt }
        rec["result"] = res
      }
    } catch {
      rec["moveError"] = error.localizedDescription
    }
    records[t.id] = rec
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let body = responseData.removeValue(forKey: task.taskIdentifier)
    guard let t = ChatTransferManager.parse(task.taskDescription), var rec = records[t.id] else { return }
    let st = rec["state"] as? String ?? ""
    guard st == "running" || st == "queued" else { return }
    let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
    let cancelled = (error as NSError?)?.code == NSURLErrorCancelled

    switch t.kind {
    case "u":
      var m = inflightBytes[t.id] ?? [:]
      m.removeValue(forKey: t.chunk)
      inflightBytes[t.id] = m
      if error == nil && (200..<300).contains(status) {
        var pending = (rec["pending"] as? [Int]) ?? []
        pending.removeAll { $0 == t.chunk }
        rec["pending"] = pending
        records[t.id] = rec
        saveLocked(t.id)
        try? FileManager.default.removeItem(at: bodiesDir.appendingPathComponent(t.id, isDirectory: true)
          .appendingPathComponent("c\(t.chunk).body"))
        uploadProgressLocked(t.id)
        if pending.isEmpty && (rec["completing"] as? Bool) != true { startCompleteLocked(t.id) }
        return
      }
      if cancelled { return }
      if error == nil && !ChatTransferManager.retryable(status) {
        finishLocked(t.id, state: "failed", error: status == 413 ? "file_too_large" : "chunk_http_\(status)", httpStatus: status)
        return
      }
      var attempts = (rec["attempts"] as? [String: Int]) ?? [:]
      let n = (attempts[String(t.chunk)] ?? 0) + 1
      attempts[String(t.chunk)] = n
      rec["attempts"] = attempts
      records[t.id] = rec
      saveLocked(t.id)
      if n >= ChatTransferManager.maxChunkAttempts {
        finishLocked(t.id, state: "failed", error: "chunk_\(t.chunk)_failed_after_retries", httpStatus: status)
        return
      }
      startChunkLocked(t.id, chunk: t.chunk, delay: min(30.0, pow(2.0, Double(n))))

    case "c":
      if error == nil && (200..<300).contains(status) {
        var result: [String: Any] = [:]
        if let b = body, let obj = try? JSONSerialization.jsonObject(with: b) as? [String: Any] { result = obj }
        if (result["success"] as? Bool) == false || (result["cdn_url"] as? String ?? "").isEmpty {
          rec["result"] = result
          records[t.id] = rec
          finishLocked(t.id, state: "failed", error: (result["error"] as? String) ?? "complete_no_url", httpStatus: status)
          return
        }
        rec["result"] = result
        records[t.id] = rec
        finishLocked(t.id, state: "done", httpStatus: status)
        return
      }
      if cancelled { return }
      if error == nil && !ChatTransferManager.retryable(status) {
        finishLocked(t.id, state: "failed", error: status == 413 ? "file_too_large" : "complete_http_\(status)", httpStatus: status)
        return
      }
      let n = (rec["completeAttempts"] as? Int ?? 0) + 1
      rec["completeAttempts"] = n
      records[t.id] = rec
      saveLocked(t.id)
      if n >= ChatTransferManager.maxChunkAttempts {
        finishLocked(t.id, state: "failed", error: "complete_failed", httpStatus: status)
        return
      }
      startCompleteLocked(t.id, delay: min(30.0, pow(2.0, Double(n))))

    case "d":
      if error == nil && (rec["moved"] as? Bool) == true {
        finishLocked(t.id, state: "done", httpStatus: status)
        return
      }
      if cancelled && (error as NSError?)?.userInfo[NSURLSessionDownloadTaskResumeData] == nil { return }
      let last = rec["lastStatus"] as? Int ?? status
      if error == nil && last > 0 && !ChatTransferManager.retryable(last) {
        finishLocked(t.id, state: "failed", error: "http_\(last)", httpStatus: last)
        return
      }
      if let me = rec["moveError"] as? String {
        finishLocked(t.id, state: "failed", error: "move_failed:\(me)")
        return
      }
      let n = (rec["attempts"] as? Int ?? 0) + 1
      rec["attempts"] = n
      records[t.id] = rec
      saveLocked(t.id)
      if n >= ChatTransferManager.maxDownloadAttempts {
        finishLocked(t.id, state: "failed", error: "download_failed", httpStatus: last)
        return
      }
      let resume = (error as NSError?)?.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
      startDownloadLocked(t.id, resumeData: resume, delay: min(30.0, pow(2.0, Double(n))))

    default:
      break
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    DispatchQueue.main.async {
      if let handler = BackgroundUploadAppDelegateSubscriber.completionHandlers.removeValue(
        forKey: ChatTransferManager.sessionIdentifier) {
        handler()
      }
    }
  }
}
