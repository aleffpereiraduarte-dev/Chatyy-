import Foundation
import SQLite3

// [2026-10-15 photos-native] Fila DURÁVEL do backup de fotos, um banco por conta
// (Application Support/chatyy-photos-backup/pb_<acct>.sqlite). Tudo passa por
// uma fila serial própria (q.sync) → seguro de qualquer thread, nunca chame de
// dentro de um callback que já esteja nessa fila.
//
// Estados (iguais no Android):
//   0 pending · 1 exported (temp+hash) · 2 signed (upload_url) · 3 uploading
//   4 uploaded (falta confirm) · 5 done · 6 failed_perm · 7 skipped
enum PBState: Int {
  case pending = 0, exported = 1, signed = 2, uploading = 3, uploaded = 4, done = 5, failedPerm = 6, skipped = 7
}

struct PBRow {
  var localId: String
  var created: Double
  var media: Int          // 1 foto, 2 vídeo
  var state: Int
  var attempts: Int
  var nextAt: Double
  var fileId: Int
  var objectKey: String
  var uploadUrl: String
  var signedAt: Double
  var hash: String
  var size: Int64
  var tempPath: String
  var taskId: Int
  var err: String
  var mime: String
  var filename: String
}

private let SQLITE_TRANSIENT_PB = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

final class PBStore {
  let account: String
  private var db: OpaquePointer?
  private let q: DispatchQueue

  static func directory() -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    let dir = base.appendingPathComponent("chatyy-photos-backup", isDirectory: true)
    if !FileManager.default.fileExists(atPath: dir.path) {
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                               attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
      var d = dir
      var rv = URLResourceValues(); rv.isExcludedFromBackup = true
      try? d.setResourceValues(rv)
    }
    return dir
  }

  init?(account: String) {
    self.account = account
    self.q = DispatchQueue(label: "br.com.chatyy.photosbackup.store.\(account)")
    let path = PBStore.directory().appendingPathComponent("pb_\(account).sqlite").path
    var handle: OpaquePointer?
    let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
    guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK, let h = handle else {
      if let h = handle { sqlite3_close(h) }
      return nil
    }
    db = h
    // Banco precisa abrir com o aparelho BLOQUEADO (BGProcessingTask) → proteção
    // "até o 1º desbloqueio", igual ao temp dos uploads.
    try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path)
    exec("PRAGMA journal_mode=WAL;")
    exec("PRAGMA synchronous=NORMAL;")
    exec("PRAGMA busy_timeout=3000;")
    exec("""
      CREATE TABLE IF NOT EXISTS assets(
        local_id TEXT PRIMARY KEY, created REAL DEFAULT 0, media INTEGER DEFAULT 1,
        state INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, next_at REAL DEFAULT 0,
        file_id INTEGER DEFAULT 0, object_key TEXT DEFAULT '', upload_url TEXT DEFAULT '',
        signed_at REAL DEFAULT 0, hash TEXT DEFAULT '', size INTEGER DEFAULT 0,
        temp_path TEXT DEFAULT '', task_id INTEGER DEFAULT 0, err TEXT DEFAULT '',
        mime TEXT DEFAULT '', filename TEXT DEFAULT '', updated REAL DEFAULT 0);
      """)
    exec("CREATE INDEX IF NOT EXISTS assets_state ON assets(state, next_at, created);")
    exec("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);")
  }

  deinit {
    if let d = db { sqlite3_close(d) }
  }

  // MARK: - low level (chamar só dentro de q)

  @discardableResult
  private func exec(_ sql: String) -> Bool {
    guard let d = db else { return false }
    return sqlite3_exec(d, sql, nil, nil, nil) == SQLITE_OK
  }

  private func prepare(_ sql: String) -> OpaquePointer? {
    guard let d = db else { return nil }
    var st: OpaquePointer?
    if sqlite3_prepare_v2(d, sql, -1, &st, nil) != SQLITE_OK { return nil }
    return st
  }

  private func bind(_ st: OpaquePointer, _ args: [Any?]) {
    for (i, a) in args.enumerated() {
      let idx = Int32(i + 1)
      switch a {
      case nil: sqlite3_bind_null(st, idx)
      case let v as Int: sqlite3_bind_int64(st, idx, Int64(v))
      case let v as Int64: sqlite3_bind_int64(st, idx, v)
      case let v as Double: sqlite3_bind_double(st, idx, v)
      case let v as Bool: sqlite3_bind_int64(st, idx, v ? 1 : 0)
      case let v as String: sqlite3_bind_text(st, idx, v, -1, SQLITE_TRANSIENT_PB)
      default: sqlite3_bind_null(st, idx)
      }
    }
  }

  private func run(_ sql: String, _ args: [Any?] = []) {
    guard let st = prepare(sql) else { return }
    defer { sqlite3_finalize(st) }
    bind(st, args)
    _ = sqlite3_step(st)
  }

  private func text(_ st: OpaquePointer, _ col: Int32) -> String {
    if let c = sqlite3_column_text(st, col) { return String(cString: c) }
    return ""
  }

  private static let rowCols = "local_id, created, media, state, attempts, next_at, file_id, object_key, upload_url, signed_at, hash, size, temp_path, task_id, err, mime, filename"

  private func readRow(_ st: OpaquePointer) -> PBRow {
    return PBRow(
      localId: text(st, 0), created: sqlite3_column_double(st, 1), media: Int(sqlite3_column_int64(st, 2)),
      state: Int(sqlite3_column_int64(st, 3)), attempts: Int(sqlite3_column_int64(st, 4)),
      nextAt: sqlite3_column_double(st, 5), fileId: Int(sqlite3_column_int64(st, 6)),
      objectKey: text(st, 7), uploadUrl: text(st, 8), signedAt: sqlite3_column_double(st, 9),
      hash: text(st, 10), size: sqlite3_column_int64(st, 11), tempPath: text(st, 12),
      taskId: Int(sqlite3_column_int64(st, 13)), err: text(st, 14), mime: text(st, 15), filename: text(st, 16))
  }

  private func query(_ sql: String, _ args: [Any?] = []) -> [PBRow] {
    guard let st = prepare(sql) else { return [] }
    defer { sqlite3_finalize(st) }
    bind(st, args)
    var out: [PBRow] = []
    while sqlite3_step(st) == SQLITE_ROW { out.append(readRow(st)) }
    return out
  }

  // MARK: - meta

  func meta(_ k: String) -> String? {
    return q.sync {
      guard let st = prepare("SELECT v FROM meta WHERE k=?") else { return nil }
      defer { sqlite3_finalize(st) }
      bind(st, [k])
      return sqlite3_step(st) == SQLITE_ROW ? text(st, 0) : nil
    }
  }

  func setMeta(_ k: String, _ v: String?) {
    q.sync {
      if let v = v { run("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", [k, v]) }
      else { run("DELETE FROM meta WHERE k=?", [k]) }
    }
  }

  // MARK: - scan

  /// Insere os que faltam (pending ou skipped) — não toca nos existentes.
  func insertMissing(_ items: [(id: String, created: Double, media: Int)], includeVideos: Bool) -> Int {
    return q.sync {
      exec("BEGIN IMMEDIATE;")
      var n = 0
      if let st = prepare("INSERT OR IGNORE INTO assets(local_id, created, media, state, updated) VALUES(?,?,?,?,?)") {
        let now = Date().timeIntervalSince1970
        for it in items {
          let state = (it.media == 2 && !includeVideos) ? PBState.skipped.rawValue : PBState.pending.rawValue
          sqlite3_reset(st); sqlite3_clear_bindings(st)
          bind(st, [it.id, it.created, it.media, state, now])
          if sqlite3_step(st) == SQLITE_DONE, let d = db, sqlite3_changes(d) > 0 { n += 1 }
        }
        sqlite3_finalize(st)
      }
      exec("COMMIT;")
      return n
    }
  }

  func allIds() -> Set<String> {
    return q.sync {
      var out = Set<String>()
      guard let st = prepare("SELECT local_id FROM assets") else { return out }
      defer { sqlite3_finalize(st) }
      while sqlite3_step(st) == SQLITE_ROW { out.insert(text(st, 0)) }
      return out
    }
  }

  /// Remove linhas (aparelho apagou). Devolve as linhas removidas (p/ cancelar task/apagar temp).
  func remove(_ ids: [String]) -> [PBRow] {
    if ids.isEmpty { return [] }
    return q.sync {
      var removed: [PBRow] = []
      exec("BEGIN IMMEDIATE;")
      for chunk in stride(from: 0, to: ids.count, by: 400).map({ Array(ids[$0..<min($0 + 400, ids.count)]) }) {
        let ph = chunk.map { _ in "?" }.joined(separator: ",")
        removed += query("SELECT \(PBStore.rowCols) FROM assets WHERE local_id IN (\(ph))", chunk)
        run("DELETE FROM assets WHERE local_id IN (\(ph))", chunk)
      }
      exec("COMMIT;")
      return removed
    }
  }

  func setVideosIncluded(_ include: Bool) {
    q.sync {
      if include {
        run("UPDATE assets SET state=0, next_at=0 WHERE state=7 AND media=2")
      } else {
        run("UPDATE assets SET state=7 WHERE media=2 AND state IN (0,1,2)")
      }
    }
  }

  func idsWithState(_ states: [Int], limit: Int = 1_000_000) -> [String] {
    return q.sync {
      var out: [String] = []
      let ph = states.map { String($0) }.joined(separator: ",")
      guard let st = prepare("SELECT local_id FROM assets WHERE state IN (\(ph)) ORDER BY created DESC LIMIT ?") else { return out }
      defer { sqlite3_finalize(st) }
      bind(st, [limit])
      while sqlite3_step(st) == SQLITE_ROW { out.append(text(st, 0)) }
      return out
    }
  }

  func markDone(_ ids: [String]) {
    if ids.isEmpty { return }
    q.sync {
      exec("BEGIN IMMEDIATE;")
      let now = Date().timeIntervalSince1970
      if let st = prepare("UPDATE assets SET state=5, updated=? WHERE local_id=? AND state IN (0,1,2,6)") {
        for id in ids {
          sqlite3_reset(st); sqlite3_clear_bindings(st)
          bind(st, [now, id]); _ = sqlite3_step(st)
        }
        sqlite3_finalize(st)
      }
      exec("COMMIT;")
    }
  }

  // MARK: - fila

  /// Próximos candidatos p/ processar (pending/exported/signed com next_at vencido), mais novos primeiro.
  func nextCandidates(limit: Int, excluding: Set<String>) -> [PBRow] {
    return q.sync {
      let now = Date().timeIntervalSince1970
      let rows = query("SELECT \(PBStore.rowCols) FROM assets WHERE state IN (0,1,2) AND next_at <= ? ORDER BY state DESC, created DESC LIMIT ?", [now, limit + excluding.count])
      return Array(rows.filter { !excluding.contains($0.localId) }.prefix(limit))
    }
  }

  func rowsInState(_ state: PBState) -> [PBRow] {
    return q.sync { query("SELECT \(PBStore.rowCols) FROM assets WHERE state=?", [state.rawValue]) }
  }

  func countState(_ state: PBState) -> Int {
    return q.sync {
      guard let st = prepare("SELECT COUNT(*) FROM assets WHERE state=?") else { return 0 }
      defer { sqlite3_finalize(st) }
      bind(st, [state.rawValue])
      return sqlite3_step(st) == SQLITE_ROW ? Int(sqlite3_column_int64(st, 0)) : 0
    }
  }

  /// Linhas com arquivo temporário vivo (estados 1..4) — p/ orçamento de disco.
  func tempBudget() -> (count: Int, bytes: Int64) {
    return q.sync {
      guard let st = prepare("SELECT COUNT(*), COALESCE(SUM(size),0) FROM assets WHERE state IN (1,2,3,4) AND temp_path<>''") else { return (0, 0) }
      defer { sqlite3_finalize(st) }
      return sqlite3_step(st) == SQLITE_ROW ? (Int(sqlite3_column_int64(st, 0)), sqlite3_column_int64(st, 1)) : (0, 0)
    }
  }

  func row(_ id: String) -> PBRow? {
    return q.sync { query("SELECT \(PBStore.rowCols) FROM assets WHERE local_id=?", [id]).first }
  }

  func update(_ r: PBRow) {
    q.sync {
      run("""
        UPDATE assets SET state=?, attempts=?, next_at=?, file_id=?, object_key=?, upload_url=?, signed_at=?,
          hash=?, size=?, temp_path=?, task_id=?, err=?, mime=?, filename=?, updated=? WHERE local_id=?
        """, [r.state, r.attempts, r.nextAt, r.fileId, r.objectKey, r.uploadUrl, r.signedAt, r.hash,
              r.size, r.tempPath, r.taskId, r.err, r.mime, r.filename, Date().timeIntervalSince1970, r.localId])
    }
  }

  /// "Tentar de novo agora": zera backoff e falhas não-permanentes.
  func resetBackoff() {
    q.sync { run("UPDATE assets SET next_at=0, attempts=CASE WHEN attempts>=12 THEN 0 ELSE attempts END WHERE state IN (0,1,2,4)") }
  }

  struct Counts { var total = 0, done = 0, pending = 0, uploading = 0, failed = 0, skipped = 0; var bytesDone: Int64 = 0 }

  func counts() -> Counts {
    return q.sync {
      var c = Counts()
      guard let st = prepare("SELECT state, attempts>=12, COUNT(*), SUM(CASE WHEN state=5 THEN size ELSE 0 END) FROM assets GROUP BY 1,2") else { return c }
      defer { sqlite3_finalize(st) }
      while sqlite3_step(st) == SQLITE_ROW {
        let s = Int(sqlite3_column_int64(st, 0))
        let stuck = sqlite3_column_int64(st, 1) != 0
        let n = Int(sqlite3_column_int64(st, 2))
        c.total += n
        switch s {
        case 5: c.done += n; c.bytesDone += sqlite3_column_int64(st, 3)
        case 3, 4: c.uploading += n
        case 6: c.failed += n
        case 7: c.skipped += n
        default: if stuck { c.failed += n } else { c.pending += n }
        }
      }
      return c
    }
  }

  /// Snapshot p/ a grade: cloud / pending / uploading / failed / local.
  func snapshot() -> [String: [String]] {
    return q.sync {
      var cloud: [String] = [], pending: [String] = [], uploading: [String] = [], failed: [String] = [], local: [String] = []
      guard let st = prepare("SELECT local_id, state, attempts FROM assets") else { return [:] }
      defer { sqlite3_finalize(st) }
      while sqlite3_step(st) == SQLITE_ROW {
        let id = text(st, 0)
        let s = Int(sqlite3_column_int64(st, 1))
        let a = Int(sqlite3_column_int64(st, 2))
        switch s {
        case 5: cloud.append(id)
        case 3, 4: uploading.append(id)
        case 6: failed.append(id)
        case 7: local.append(id)
        default: if a >= 12 { failed.append(id) } else { pending.append(id) }
        }
      }
      return ["cloud": cloud, "pending": pending, "uploading": uploading, "failed": failed, "local": local]
    }
  }
}
