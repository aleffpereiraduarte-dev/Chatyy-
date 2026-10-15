import Foundation
import SQLite3
import CryptoKit

// [2026-10-15 native-store] Motor do store local nativo (fase 1).
//
// • SQLite do SISTEMA (libsqlite3) — zero dependência nova.
// • UM ARQUIVO POR CONTA: Application Support/chatyy-store/<sha256(email)[0..24]>.db
//   → isolamento físico entre contas (nada de coluna account_email esquecida
//   num WHERE). Logout/troca = apagar o arquivo.
// • Em repouso: NSFileProtectionCompleteUntilFirstUserAuthentication (mesma
//   classe que o resto do app usa na prática; permite gravar com a tela
//   bloqueada depois do 1º desbloqueio — push/sync em 2º plano) + fora do
//   backup do iCloud (é derivado do servidor). O app NÃO usa SQLCipher hoje
//   (chatyy.db do expo-sqlite e MMKV são em claro) — ver DESIGN §6.
// • Uma fila serial é dona das conexões: escrita e leitura nunca disputam
//   handle (a lição do sqliteWriteLane do JS).
// • É CACHE: qualquer corrupção → apaga o arquivo e recomeça (o JS repinta).
//
// Fase 1 guarda só "fotos" (snapshots) por conversa: as linhas JÁ MONTADAS
// (o mesmo dicionário que o JS manda em applyRows) da janela mais nova, mais a
// ordem. A lista nativa lê e grava direto — o JS só manda o id da conversa.
// As tabelas canônicas (conversations/messages/receipts) entram na fase 2
// (DESIGN §4) no MESMO arquivo, com migração por user_version.
public final class ChatyyStoreDB {
  public static let shared = ChatyyStoreDB()
  public static let schemaVersion: Int32 = 3
  /// Teto de conversas com foto por conta (as menos recentes saem).
  static let maxThreads = 400

  public struct Snapshot {
    public let keys: [String]          // mais antiga → mais nova (formato do applyRows)
    public let rows: [[String: Any]]   // mesmo dicionário que o JS manda
    public let newest: String
    public let readMs: Double
  }

  private let q = DispatchQueue(label: "br.com.chatyy.store", qos: .userInitiated)
  private var dbs: [String: OpaquePointer] = [:]
  private var saves = 0
  private var batches = 0
  /// Linhas por conversa na foto (igual ao storeWindow da lista).
  public static let threadWindow = 60
  /// Mensagens canônicas guardadas por conversa (as mais novas).
  static let maxMessagesPerConv = 400

  // [fase 1.5] pré-carga no toque (pressIn da home): foto já decodificada em
  // memória → a lista da conversa pinta SÍNCRONO no setStore (sem hop de fila).
  // Chave = hash(conta)|conversa. LRU de 4. Protegida por lock (lida na main,
  // escrita na fila do store).
  private let cacheLock = NSLock()
  private var memCache: [String: (rev: String, snap: Snapshot)] = [:]
  private var memOrder: [String] = []

  // [fase 2] observadores por conversa (a lista que só mostra a foto relê).
  private let obsLock = NSLock()
  private var observers: [Int: (key: String, cb: () -> Void)] = [:]
  private var obsSeq = 0
  private static let TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  private init() {}

  // MARK: caminho / conta

  static func normAccount(_ s: String) -> String {
    return s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  static func accountHash(_ email: String) -> String {
    let n = normAccount(email)
    if n.isEmpty { return "" }
    let d = SHA256.hash(data: Data(n.utf8))
    return d.prefix(12).map { String(format: "%02x", $0) }.joined()
  }

  static var dirURL: URL? {
    guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
    return base.appendingPathComponent("chatyy-store", isDirectory: true)
  }

  private static func ensureDir() -> URL? {
    guard var dir = dirURL else { return nil }
    let fm = FileManager.default
    if !fm.fileExists(atPath: dir.path) {
      do {
        try fm.createDirectory(at: dir, withIntermediateDirectories: true,
                               attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
      } catch { return nil }
      var rv = URLResourceValues()
      rv.isExcludedFromBackup = true
      try? dir.setResourceValues(rv)
    }
    return dir
  }

  private static func removeFiles(_ path: String) {
    let fm = FileManager.default
    for suf in ["", "-wal", "-shm", "-journal"] { try? fm.removeItem(atPath: path + suf) }
  }

  // MARK: conexão (só na fila q)

  private func exec(_ db: OpaquePointer, _ sql: String) -> Int32 {
    return sqlite3_exec(db, sql, nil, nil, nil)
  }

  private func open(_ account: String) -> OpaquePointer? {
    let h = Self.accountHash(account)
    if h.isEmpty { return nil }
    if let db = dbs[h] { return db }
    guard let dir = Self.ensureDir() else { return nil }
    let path = dir.appendingPathComponent(h + ".db").path
    for attempt in 0..<2 {
      var db: OpaquePointer?
      let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
      if sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK, let db = db {
        _ = exec(db, "PRAGMA journal_mode=WAL;")
        _ = exec(db, "PRAGMA synchronous=NORMAL;")
        _ = exec(db, "PRAGMA busy_timeout=2000;")
        if migrate(db) {
          try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path)
          dbs[h] = db
          return db
        }
        sqlite3_close_v2(db)
      } else if let db = db {
        sqlite3_close_v2(db)
      }
      if attempt == 0 { Self.removeFiles(path) } // corrompido/ilegível → recomeça (é cache)
    }
    return nil
  }

  private func migrate(_ db: OpaquePointer) -> Bool {
    var v: Int32 = 0
    var st: OpaquePointer?
    if sqlite3_prepare_v2(db, "PRAGMA user_version;", -1, &st, nil) == SQLITE_OK, sqlite3_step(st) == SQLITE_ROW {
      v = sqlite3_column_int(st, 0)
    }
    sqlite3_finalize(st)
    if v > Self.schemaVersion { return false } // arquivo de um binário mais novo (downgrade) → recomeça
    if v == Self.schemaVersion { return true }
    let v1 = """
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS thread_snap (
        conv TEXT PRIMARY KEY,
        rev TEXT NOT NULL,
        keys TEXT NOT NULL,
        newest TEXT NOT NULL,
        n INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_rows (
        conv TEXT NOT NULL,
        k TEXT NOT NULL,
        row TEXT NOT NULL,
        PRIMARY KEY (conv, k)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_thread_snap_upd ON thread_snap(updated_at);
      """
    // [2026-10-15 native-store fase 1.5/2] home + tabelas canônicas (mesmo arquivo).
    let v2 = """
      CREATE TABLE IF NOT EXISTS home_snap (
        scope TEXT PRIMARY KEY, rev TEXT NOT NULL, ids TEXT NOT NULL, top TEXT NOT NULL,
        n INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS home_rows (
        scope TEXT NOT NULL, id TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (scope, id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, type TEXT, name TEXT, avatar TEXT, last_msg_id INTEGER, last_ts INTEGER,
        unread INTEGER, pinned INTEGER, muted INTEGER, archived INTEGER, pts INTEGER,
        read_watermark INTEGER, raw TEXT, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        conv TEXT NOT NULL, id INTEGER NOT NULL, ckey TEXT, client_id TEXT, sender TEXT, type TEXT,
        created_at INTEGER, edited_at INTEGER, deleted INTEGER, reply_to INTEGER, raw TEXT,
        PRIMARY KEY (conv, id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conv, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id);
      CREATE TABLE IF NOT EXISTS receipts (
        conv TEXT NOT NULL, msg_id INTEGER NOT NULL, delivered_at INTEGER, read_at INTEGER,
        PRIMARY KEY (conv, msg_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS reactions (
        conv TEXT NOT NULL, msg_id INTEGER NOT NULL, emoji TEXT NOT NULL, users TEXT,
        PRIMARY KEY (conv, msg_id, emoji)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS cursors (
        scope TEXT PRIMARY KEY, pts INTEGER, last_id INTEGER, v TEXT, updated_at INTEGER
      );
      """
    // [2026-10-15 fase 2b/4] fila de envio NATIVA (mesmo DDL do Kotlin OUTBOX_DDL)
    let v3 = """
      CREATE TABLE IF NOT EXISTS outbox (cmi TEXT PRIMARY KEY, conv TEXT NOT NULL, seq INTEGER NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, frame TEXT, file TEXT, up TEXT, state TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, err TEXT, server TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_outbox_conv ON outbox(conv, seq);
      """
    let ddl = "BEGIN;" + (v < 1 ? v1 : "") + v2 + v3 + "PRAGMA user_version = \(Self.schemaVersion);COMMIT;"
    if exec(db, ddl) != SQLITE_OK { _ = exec(db, "ROLLBACK;"); return false }
    return true
  }

  private func isCorrupt(_ rc: Int32) -> Bool {
    let p = rc & 0xFF
    return p == SQLITE_CORRUPT || p == SQLITE_NOTADB
  }

  private func drop(_ account: String) {
    let h = Self.accountHash(account)
    if let db = dbs.removeValue(forKey: h) { sqlite3_close_v2(db) }
    if let dir = Self.dirURL, !h.isEmpty { Self.removeFiles(dir.appendingPathComponent(h + ".db").path) }
  }

  private func bind(_ st: OpaquePointer?, _ i: Int32, _ s: String) {
    sqlite3_bind_text(st, i, s, -1, Self.TRANSIENT)
  }

  private func colText(_ st: OpaquePointer?, _ i: Int32) -> String {
    guard let c = sqlite3_column_text(st, i) else { return "" }
    return String(cString: c)
  }

  // MARK: fotos por conversa

  /// Grava a janela mais nova da conversa. `keys` mais antiga → mais nova;
  /// `rows` = dicionários na MESMA ordem (linhas sem chave em keys são ignoradas).
  /// keys vazio apaga a foto. Assíncrono (fila do store).
  public func saveThread(account: String, conv: String, rev: String, keys: [String], rows: [[String: Any]]) {
    if account.isEmpty || conv.isEmpty { return }
    q.async { [self] in
      guard let db = open(account) else { return }
      dropCached(account, conv)
      var pairs: [(String, String)] = []
      pairs.reserveCapacity(rows.count)
      let keySet = Set(keys)
      for d in rows {
        guard let k = d["k"] as? String, keySet.contains(k), JSONSerialization.isValidJSONObject(d),
              let data = try? JSONSerialization.data(withJSONObject: d),
              let s = String(data: data, encoding: .utf8) else { continue }
        pairs.append((k, s))
      }
      let have = Set(pairs.map { $0.0 })
      let ordered = keys.filter { have.contains($0) }
      var rc = exec(db, "BEGIN IMMEDIATE;")
      if rc != SQLITE_OK { if isCorrupt(rc) { drop(account) }; return }
      var ok = true
      var st: OpaquePointer?
      if sqlite3_prepare_v2(db, "DELETE FROM thread_rows WHERE conv = ?;", -1, &st, nil) == SQLITE_OK {
        bind(st, 1, conv); rc = sqlite3_step(st); if rc != SQLITE_DONE { ok = false }
      } else { ok = false }
      sqlite3_finalize(st); st = nil
      if ordered.isEmpty {
        if sqlite3_prepare_v2(db, "DELETE FROM thread_snap WHERE conv = ?;", -1, &st, nil) == SQLITE_OK {
          bind(st, 1, conv); if sqlite3_step(st) != SQLITE_DONE { ok = false }
        } else { ok = false }
        sqlite3_finalize(st); st = nil
      } else {
        if ok, sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO thread_rows (conv, k, row) VALUES (?, ?, ?);", -1, &st, nil) == SQLITE_OK {
          for (k, s) in pairs {
            sqlite3_reset(st)
            bind(st, 1, conv); bind(st, 2, k); bind(st, 3, s)
            rc = sqlite3_step(st)
            if rc != SQLITE_DONE { ok = false; break }
          }
        } else { ok = false }
        sqlite3_finalize(st); st = nil
        let keysJSON = (try? JSONSerialization.data(withJSONObject: ordered)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        if ok, sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO thread_snap (conv, rev, keys, newest, n, updated_at) VALUES (?, ?, ?, ?, ?, ?);", -1, &st, nil) == SQLITE_OK {
          bind(st, 1, conv); bind(st, 2, rev); bind(st, 3, keysJSON); bind(st, 4, ordered.last ?? "")
          sqlite3_bind_int(st, 5, Int32(ordered.count))
          sqlite3_bind_int64(st, 6, Int64(Date().timeIntervalSince1970 * 1000))
          rc = sqlite3_step(st)
          if rc != SQLITE_DONE { ok = false }
        } else { ok = false }
        sqlite3_finalize(st); st = nil
      }
      // [2b] a lista gravou a foto com o que a tela tem → deixa de estar desatualizada
      if ok { run(db, "DELETE FROM meta WHERE k = ?;", ["stale:" + conv]) }
      rc = exec(db, ok ? "COMMIT;" : "ROLLBACK;")
      if isCorrupt(rc) { drop(account); return }
      saves += 1
      if saves % 50 == 0 { prune(db) }
    }
  }

  private func prune(_ db: OpaquePointer) {
    let lim = Self.maxThreads
    _ = exec(db, """
      BEGIN;
      DELETE FROM thread_rows WHERE conv IN (SELECT conv FROM thread_snap ORDER BY updated_at DESC LIMIT -1 OFFSET \(lim));
      DELETE FROM thread_snap WHERE conv IN (SELECT conv FROM thread_snap ORDER BY updated_at DESC LIMIT -1 OFFSET \(lim));
      COMMIT;
      """)
  }

  /// Lê a foto (só se `rev` bater). Decodifica na fila do store; `done` na main.
  public func loadThread(account: String, conv: String, rev: String, done: @escaping (Snapshot?, String) -> Void) {
    if account.isEmpty || conv.isEmpty { DispatchQueue.main.async { done(nil, "noacct") }; return }
    q.async { [self] in
      let t0 = CFAbsoluteTimeGetCurrent()
      var out: Snapshot?
      var why = "miss"
      if let db = open(account) {
        var st: OpaquePointer?
        var srev = "", skeys = "", newest = ""
        var found = false
        if sqlite3_prepare_v2(db, "SELECT rev, keys, newest FROM thread_snap WHERE conv = ?;", -1, &st, nil) == SQLITE_OK {
          bind(st, 1, conv)
          let rc = sqlite3_step(st)
          if rc == SQLITE_ROW { found = true; srev = colText(st, 0); skeys = colText(st, 1); newest = colText(st, 2) }
          else if isCorrupt(rc) { why = "corrupt" }
        }
        sqlite3_finalize(st); st = nil
        if found && srev != rev { why = "rev" }
        if found && srev == rev {
          let keys = (skeys.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String]) ?? []
          var map: [String: [String: Any]] = [:]
          if sqlite3_prepare_v2(db, "SELECT k, row FROM thread_rows WHERE conv = ?;", -1, &st, nil) == SQLITE_OK {
            bind(st, 1, conv)
            while sqlite3_step(st) == SQLITE_ROW {
              let k = colText(st, 0)
              if let d = colText(st, 1).data(using: .utf8).flatMap({ try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any] {
                map[k] = d
              }
            }
          }
          sqlite3_finalize(st); st = nil
          var ks: [String] = []
          var rows: [[String: Any]] = []
          for k in keys { if let d = map[k] { ks.append(k); rows.append(d) } }
          if !ks.isEmpty {
            out = Snapshot(keys: ks, rows: rows, newest: newest, readMs: (CFAbsoluteTimeGetCurrent() - t0) * 1000)
            why = "hit"
          }
        }
        if why == "corrupt" { drop(account) }
      } else {
        why = "open"
      }
      DispatchQueue.main.async { done(out, why) }
    }
  }

  /// Chave mais nova da foto ('' = sem foto). Síncrono (gate do JS); PK lookup.
  public func newestSync(account: String, conv: String) -> String {
    if account.isEmpty || conv.isEmpty { return "" }
    return q.sync { [self] in
      guard let db = open(account) else { return "" }
      var st: OpaquePointer?
      var s = ""
      if sqlite3_prepare_v2(db, "SELECT newest FROM thread_snap WHERE conv = ? AND n > 0;", -1, &st, nil) == SQLITE_OK {
        bind(st, 1, conv)
        if sqlite3_step(st) == SQLITE_ROW { s = colText(st, 0) }
      }
      sqlite3_finalize(st)
      return s
    }
  }

  public func statsSync(account: String) -> [String: Any] {
    return q.sync { [self] in
      var out: [String: Any] = ["threads": 0, "rows": 0, "bytes": 0, "messages": 0, "convs": 0, "homeRows": 0]
      guard let db = open(account) else { return out }
      var st: OpaquePointer?
      if sqlite3_prepare_v2(db, "SELECT (SELECT COUNT(*) FROM thread_snap), (SELECT COUNT(*) FROM thread_rows), (SELECT COALESCE(SUM(LENGTH(row)),0) FROM thread_rows), (SELECT COUNT(*) FROM messages), (SELECT COUNT(*) FROM conversations), (SELECT COUNT(*) FROM home_rows);", -1, &st, nil) == SQLITE_OK,
         sqlite3_step(st) == SQLITE_ROW {
        out["threads"] = Int(sqlite3_column_int64(st, 0))
        out["rows"] = Int(sqlite3_column_int64(st, 1))
        out["bytes"] = Int(sqlite3_column_int64(st, 2))
        out["messages"] = Int(sqlite3_column_int64(st, 3))
        out["convs"] = Int(sqlite3_column_int64(st, 4))
        out["homeRows"] = Int(sqlite3_column_int64(st, 5))
      }
      sqlite3_finalize(st)
      return out
    }
  }


  // MARK: helpers JSON / SQL (só na fila q)

  static func jsonString(_ o: Any) -> String? {
    guard JSONSerialization.isValidJSONObject(o), let d = try? JSONSerialization.data(withJSONObject: o) else { return nil }
    return String(data: d, encoding: .utf8)
  }

  static func jsonObject(_ s: String) -> Any? {
    guard let d = s.data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: d)
  }

  static func str(_ v: Any?) -> String {
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
  }

  static func i64(_ v: Any?) -> Int64 {
    if let n = v as? NSNumber { return n.int64Value }
    if let s = v as? String { return Int64(s) ?? Int64(Double(s) ?? 0) }
    return 0
  }

  private func bindAny(_ st: OpaquePointer?, _ i: Int32, _ v: Any?) {
    if v == nil || v is NSNull { sqlite3_bind_null(st, i); return }
    if let s = v as? String { bind(st, i, s); return }
    if let n = v as? NSNumber {
      if CFNumberIsFloatType(n) { sqlite3_bind_double(st, i, n.doubleValue) } else { sqlite3_bind_int64(st, i, n.int64Value) }
      return
    }
    if let s = Self.jsonString(v as Any) { bind(st, i, s) } else { sqlite3_bind_null(st, i) }
  }

  /// prepare + bind + step (DONE/ROW) + finalize. Devolve rc do step.
  @discardableResult
  private func run(_ db: OpaquePointer, _ sql: String, _ args: [Any?]) -> Int32 {
    var st: OpaquePointer?
    var rc = sqlite3_prepare_v2(db, sql, -1, &st, nil)
    if rc == SQLITE_OK {
      for (i, a) in args.enumerated() { bindAny(st, Int32(i + 1), a) }
      rc = sqlite3_step(st)
    }
    sqlite3_finalize(st)
    return rc
  }

  private func nowMs() -> Int64 { return Int64(Date().timeIntervalSince1970 * 1000) }

  // MARK: [fase 1.5] pré-carga da foto em memória

  private func cacheKey(_ account: String, _ conv: String) -> String { return Self.accountHash(account) + "|" + conv }

  private func putCached(_ account: String, _ conv: String, _ rev: String, _ snap: Snapshot) {
    let k = cacheKey(account, conv)
    cacheLock.lock()
    memCache[k] = (rev, snap)
    memOrder.removeAll { $0 == k }
    memOrder.append(k)
    while memOrder.count > 4 { let old = memOrder.removeFirst(); memCache.removeValue(forKey: old) }
    cacheLock.unlock()
  }

  private func dropCached(_ account: String, _ conv: String) {
    let k = cacheKey(account, conv)
    cacheLock.lock()
    memCache.removeValue(forKey: k)
    memOrder.removeAll { $0 == k }
    cacheLock.unlock()
  }

  private func clearCache() {
    cacheLock.lock(); memCache.removeAll(); memOrder.removeAll(); cacheLock.unlock()
  }

  /// Foto já pré-carregada (pressIn) — SÍNCRONO, qualquer thread; nil se não
  /// houver ou se o rev não bater.
  public func cachedThread(account: String, conv: String, rev: String) -> Snapshot? {
    if account.isEmpty || conv.isEmpty { return nil }
    let k = cacheKey(account, conv)
    cacheLock.lock(); defer { cacheLock.unlock() }
    guard let e = memCache[k], e.rev == rev else { return nil }
    return e.snap
  }

  /// Lê + decodifica a foto (qualquer rev) para a memória. Chamado no pressIn
  /// da linha da home: quando a tela abre, a lista pinta sem esperar a fila.
  public func prewarmThread(account: String, conv: String) {
    if account.isEmpty || conv.isEmpty { return }
    q.async { [self] in
      let t0 = CFAbsoluteTimeGetCurrent()
      guard let db = open(account) else { return }
      guard let res = readSnapshot(db, conv, t0: t0) else { return }
      putCached(account, conv, res.0, res.1)
    }
  }

  /// SELECT da foto (qualquer rev). Só na fila q.
  private func readSnapshot(_ db: OpaquePointer, _ conv: String, t0: CFAbsoluteTime) -> (String, Snapshot)? {
    var st: OpaquePointer?
    var rev = "", skeys = "", newest = ""
    var found = false
    if sqlite3_prepare_v2(db, "SELECT rev, keys, newest FROM thread_snap WHERE conv = ?;", -1, &st, nil) == SQLITE_OK {
      bind(st, 1, conv)
      if sqlite3_step(st) == SQLITE_ROW { found = true; rev = colText(st, 0); skeys = colText(st, 1); newest = colText(st, 2) }
    }
    sqlite3_finalize(st); st = nil
    if !found { return nil }
    let keys = (Self.jsonObject(skeys) as? [String]) ?? []
    let map = readRows(db, conv)
    var ks: [String] = []
    var rows: [[String: Any]] = []
    for k in keys { if let d = map[k] { ks.append(k); rows.append(d) } }
    if ks.isEmpty { return nil }
    return (rev, Snapshot(keys: ks, rows: rows, newest: newest, readMs: (CFAbsoluteTimeGetCurrent() - t0) * 1000))
  }

  private func readRows(_ db: OpaquePointer, _ conv: String) -> [String: [String: Any]] {
    var map: [String: [String: Any]] = [:]
    var st: OpaquePointer?
    if sqlite3_prepare_v2(db, "SELECT k, row FROM thread_rows WHERE conv = ?;", -1, &st, nil) == SQLITE_OK {
      bind(st, 1, conv)
      while sqlite3_step(st) == SQLITE_ROW {
        if let d = Self.jsonObject(colText(st, 1)) as? [String: Any] { map[colText(st, 0)] = d }
      }
    }
    sqlite3_finalize(st)
    return map
  }

  // MARK: [fase 2] observadores por conversa

  /// cb roda na MAIN quando um lote (applyBatch) mexe na foto/mensagens da conversa.
  public func addObserver(account: String, conv: String, _ cb: @escaping () -> Void) -> Int {
    obsLock.lock(); defer { obsLock.unlock() }
    obsSeq += 1
    observers[obsSeq] = (cacheKey(account, conv), cb)
    return obsSeq
  }

  public func removeObserver(_ token: Int) {
    obsLock.lock(); observers.removeValue(forKey: token); obsLock.unlock()
  }

  private func notify(_ account: String, _ convs: Set<String>) {
    if convs.isEmpty { return }
    let keys = Set(convs.map { cacheKey(account, $0) })
    obsLock.lock()
    let cbs = observers.values.filter { keys.contains($0.key) }.map { $0.cb }
    obsLock.unlock()
    if cbs.isEmpty { return }
    DispatchQueue.main.async { for cb in cbs { cb() } }
  }

  // MARK: [fase 2] lote canônico (JS sync hoje; transporte WS nativo amanhã — fase 2b)

  /// Aplica um lote numa transação. `json` = 1 string (formato em
  /// docs/native-store-DESIGN.md §3.3): conversations, conv_deletes, messages,
  /// msg_deletes, receipts, reactions, cursors, threads (operações na foto).
  /// API pública p/ o expo-chat-transport gravar direto (sem JS).
  /// `done` (opcional) roda na fila do store com o resumo.
  public func applyBatch(account: String, json: String, done: (([String: Any]) -> Void)? = nil) {
    if account.isEmpty { done?(["ok": 0, "why": "noacct"]); return }
    q.async { [self] in
      let out = applyBatchNow(account, json)
      done?(out)
    }
  }

  private func applyBatchNow(_ account: String, _ json: String) -> [String: Any] {
    guard let b = Self.jsonObject(json) as? [String: Any] else { return ["ok": 0, "why": "json"] }
    return applyBatchObj(account, b)
  }

  private func applyBatchObj(_ account: String, _ b: [String: Any]) -> [String: Any] {
    guard let db = open(account) else { return ["ok": 0, "why": "open"] }
    var rc = exec(db, "BEGIN IMMEDIATE;")
    if rc != SQLITE_OK { if isCorrupt(rc) { drop(account) }; return ["ok": 0, "why": "begin"] }
    var touched = Set<String>()
    var nMsg = 0, nThreadOps = 0, nNative = 0, nStale = 0
    let now = nowMs()
    for c in (b["conversations"] as? [[String: Any]]) ?? [] {
      let id = Self.str(c["id"]); if id.isEmpty { continue }
      run(db, "INSERT OR REPLACE INTO conversations (id, type, name, avatar, last_msg_id, last_ts, unread, pinned, muted, archived, pts, read_watermark, raw, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?);",
          [id, Self.str(c["type"]), Self.str(c["name"]), Self.str(c["avatar"]), Self.i64(c["last_msg_id"]), Self.i64(c["last_ts"]),
           Self.i64(c["unread"]), Self.i64(c["pinned"]), Self.i64(c["muted"]), Self.i64(c["archived"]), Self.i64(c["pts"]),
           Self.i64(c["read_watermark"]), c["raw"] as? String, now])
    }
    for x in (b["conv_deletes"] as? [Any]) ?? [] {
      let id = Self.str(x); if id.isEmpty { continue }
      for sql in ["DELETE FROM conversations WHERE id = ?;", "DELETE FROM messages WHERE conv = ?;", "DELETE FROM receipts WHERE conv = ?;",
                  "DELETE FROM reactions WHERE conv = ?;", "DELETE FROM thread_rows WHERE conv = ?;", "DELETE FROM thread_snap WHERE conv = ?;"] {
        run(db, sql, [id])
      }
      touched.insert(id)
    }
    for m in (b["messages"] as? [[String: Any]]) ?? [] {
      let conv = Self.str(m["conv"]); let id = Self.i64(m["id"])
      if conv.isEmpty || id <= 0 { continue }
      run(db, "INSERT OR REPLACE INTO messages (conv, id, ckey, client_id, sender, type, created_at, edited_at, deleted, reply_to, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?);",
          [conv, id, Self.str(m["ckey"]), Self.str(m["client_id"]), Self.str(m["sender"]).lowercased(), Self.str(m["type"]),
           Self.i64(m["created_at"]), Self.i64(m["edited_at"]), Self.i64(m["deleted"]), Self.i64(m["reply_to"]), m["raw"] as? String])
      touched.insert(conv); nMsg += 1
    }
    for d in (b["msg_deletes"] as? [[String: Any]]) ?? [] {
      let conv = Self.str(d["conv"]); let id = Self.i64(d["id"]); if conv.isEmpty { continue }
      run(db, "DELETE FROM messages WHERE conv = ? AND id = ?;", [conv, id])
      run(db, "DELETE FROM receipts WHERE conv = ? AND msg_id = ?;", [conv, id])
      run(db, "DELETE FROM reactions WHERE conv = ? AND msg_id = ?;", [conv, id])
      touched.insert(conv)
    }
    for r in (b["receipts"] as? [[String: Any]]) ?? [] {
      let conv = Self.str(r["conv"]); let id = Self.i64(r["msg_id"]); if conv.isEmpty || id <= 0 { continue }
      let dl = Self.i64(r["delivered_at"]), rd = Self.i64(r["read_at"])
      // sem UPSERT (Android API 24 = SQLite 3.9): INSERT OR IGNORE + UPDATE monotônico
      run(db, "INSERT OR IGNORE INTO receipts (conv, msg_id, delivered_at, read_at) VALUES (?,?,0,0);", [conv, id])
      run(db, "UPDATE receipts SET delivered_at = MAX(COALESCE(delivered_at,0), ?), read_at = MAX(COALESCE(read_at,0), ?) WHERE conv = ? AND msg_id = ?;", [dl, rd, conv, id])
      touched.insert(conv)
    }
    for r in (b["reactions"] as? [[String: Any]]) ?? [] {
      let conv = Self.str(r["conv"]); let id = Self.i64(r["msg_id"]); if conv.isEmpty || id <= 0 { continue }
      run(db, "DELETE FROM reactions WHERE conv = ? AND msg_id = ?;", [conv, id])
      for e in (r["set"] as? [[String: Any]]) ?? [] {
        let emoji = Self.str(e["emoji"]); if emoji.isEmpty { continue }
        run(db, "INSERT OR REPLACE INTO reactions (conv, msg_id, emoji, users) VALUES (?,?,?,?);", [conv, id, emoji, Self.jsonString(e["users"] ?? [String]()) ?? "[]"])
      }
      touched.insert(conv)
    }
    for c in (b["cursors"] as? [[String: Any]]) ?? [] {
      let scope = Self.str(c["scope"]); if scope.isEmpty { continue }
      run(db, "INSERT OR IGNORE INTO cursors (scope, pts, last_id, v, updated_at) VALUES (?,0,0,'',0);", [scope])
      run(db, "UPDATE cursors SET pts = MAX(COALESCE(pts,0), ?), last_id = MAX(COALESCE(last_id,0), ?), v = COALESCE(?, v), updated_at = ? WHERE scope = ?;",
          [Self.i64(c["pts"]), Self.i64(c["last_id"]), c["v"] as? String, now, scope])
    }
    for t in (b["threads"] as? [[String: Any]]) ?? [] {
      let conv = Self.str(t["conv"]); if conv.isEmpty { continue }
      if applyThreadOps(db, conv, Self.str(t["rev"]), (t["ops"] as? [[String: Any]]) ?? []) {
        nThreadOps += 1; touched.insert(conv); dropCached(account, conv)
      }
    }
    // ─── [2b] chaves do transporte nativo (ChatyyStoreIngest.translate) ───
    if b["conv_types"] != nil || b["self_reads"] != nil || b["peer_reads"] != nil || b["delivs"] != nil || b["touch"] != nil {
      let r = applyIngestKeys(account, db, b, &touched)
      nNative += r.0; nStale += r.1
    }
    // poda: só as N mensagens mais novas por conversa tocada
    for conv in touched {
      run(db, "DELETE FROM messages WHERE conv = ? AND id < COALESCE((SELECT id FROM messages WHERE conv = ? ORDER BY id DESC LIMIT 1 OFFSET \(Self.maxMessagesPerConv - 1)), 0);", [conv, conv])
    }
    rc = exec(db, "COMMIT;")
    if rc != SQLITE_OK {
      _ = exec(db, "ROLLBACK;")
      if isCorrupt(rc) { drop(account) }
      return ["ok": 0, "why": "commit"]
    }
    batches += 1
    if batches % 200 == 0 {
      run(db, "DELETE FROM receipts WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conv = receipts.conv AND m.id = receipts.msg_id);", [])
      run(db, "DELETE FROM reactions WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conv = reactions.conv AND m.id = reactions.msg_id);", [])
    }
    notify(account, touched)
    return ["ok": 1, "messages": nMsg, "threads": nThreadOps, "convs": touched.count, "nativeRows": nNative, "stale": nStale]
  }

  /// Operações na foto de uma conversa (dentro da transação do lote). Só mexe se
  /// a foto existir e (rev vazio ou igual). true = gravou algo.
  ///   append {after, rows}  — anexa no fim (só se a mais nova == after)
  ///   set    {k, set}       — funde campos numa linha
  ///   put    {k, nk?, row, keep?} — troca a linha (mantém campos de keep; renomeia p/ nk)
  ///   stUpTo {id, st}       — recibo: linhas próprias com id ≤ id e 1 ≤ st < novo
  ///   drop   {}             — apaga a foto
  private func applyThreadOps(_ db: OpaquePointer, _ conv: String, _ rev: String, _ ops: [[String: Any]]) -> Bool {
    if ops.isEmpty { return false }
    var st: OpaquePointer?
    var srev = "", skeys = ""
    var found = false
    if sqlite3_prepare_v2(db, "SELECT rev, keys FROM thread_snap WHERE conv = ?;", -1, &st, nil) == SQLITE_OK {
      bind(st, 1, conv)
      if sqlite3_step(st) == SQLITE_ROW { found = true; srev = colText(st, 0); skeys = colText(st, 1) }
    }
    sqlite3_finalize(st)
    if !found { return false }
    if !rev.isEmpty && rev != srev { return false }
    if ops.contains(where: { Self.str($0["op"]) == "drop" }) {
      run(db, "DELETE FROM thread_rows WHERE conv = ?;", [conv])
      run(db, "DELETE FROM thread_snap WHERE conv = ?;", [conv])
      return true
    }
    var keys = (Self.jsonObject(skeys) as? [String]) ?? []
    var rows = readRows(db, conv)
    var dirty = Set<String>()
    var removed = Set<String>()
    var changed = false
    opsLoop: for op in ops {
      switch Self.str(op["op"]) {
      case "append":
        let after = Self.str(op["after"])
        let ra = (op["rows"] as? [[String: Any]]) ?? []
        if !after.isEmpty && keys.last != after {
          // [2b] o transporte nativo já anexou estas linhas (texto simples) → o JS
          // chega depois com a linha "oficial": troca no lugar. Lacuna → apaga a
          // foto (o JS repinta ao abrir). Outro caso → para.
          let all = !ra.isEmpty && keys.contains(after) && ra.allSatisfy { r in let k = Self.str(r["k"]); return !k.isEmpty && keys.contains(k) }
          if !all {
            if keys.contains(after) {
              run(db, "DELETE FROM thread_rows WHERE conv = ?;", [conv])
              run(db, "DELETE FROM thread_snap WHERE conv = ?;", [conv])
              run(db, "DELETE FROM meta WHERE k = ?;", ["stale:" + conv])
              return true
            }
            break opsLoop
          }
          for var r in ra {
            let k = Self.str(r["k"])
            // mantém o recibo que a foto já subiu (✓✓/azul) se o JS montou com menos
            if let old = rows[k], old["st"] != nil, r["st"] != nil, Self.i64(old["st"]) > Self.i64(r["st"]) { r["st"] = old["st"] }
            rows[k] = r; dirty.insert(k); changed = true
          }
          continue
        }
        for r in ra {
          let k = Self.str(r["k"]); if k.isEmpty { continue }
          if !keys.contains(k) { keys.append(k) }
          rows[k] = r; dirty.insert(k); removed.remove(k); changed = true
        }
      case "set":
        let k = Self.str(op["k"])
        guard var r = rows[k], let set = op["set"] as? [String: Any] else { continue }
        for (f, v) in set { if v is NSNull { r.removeValue(forKey: f) } else { r[f] = v } }
        rows[k] = r; dirty.insert(k); changed = true
      case "put":
        let k = Self.str(op["k"])
        guard let old = rows[k], var r = op["row"] as? [String: Any] else { continue }
        for f in (op["keep"] as? [String]) ?? [] { if let v = old[f] { r[f] = v } else { r.removeValue(forKey: f) } }
        let nk = Self.str(op["nk"]).isEmpty ? k : Self.str(op["nk"])
        r["k"] = nk
        if nk != k {
          if let i = keys.firstIndex(of: k) { keys[i] = nk }
          rows.removeValue(forKey: k); removed.insert(k); dirty.remove(k)
        }
        rows[nk] = r; dirty.insert(nk); changed = true
      // [fase 4] fila nativa: ✓ (só sobe de relógio/falha) / "!" (só de relógio)
      case "ack", "fail":
        let k = Self.str(op["k"])
        guard var r = rows[k] else { continue }
        let cur = r["st"] != nil ? Self.i64(r["st"]) : 0
        if Self.str(op["op"]) == "ack" {
          if cur >= 1 { continue }
          r["st"] = NSNumber(value: 1)
          let id = Self.str(op["id"]); if !id.isEmpty { r["id"] = id }
        } else {
          if cur != 0 { continue }
          r["st"] = NSNumber(value: -1)
        }
        rows[k] = r; dirty.insert(k); changed = true
      case "stUpTo":
        let upTo = Self.i64(op["id"]); let nst = Self.i64(op["st"])
        if upTo <= 0 || nst <= 0 { continue }
        for k in keys {
          guard var r = rows[k], Self.str(r["kind"]) == "msg", Self.i64(r["own"]) == 1 else { continue }
          let id = Int64(Self.str(r["id"])) ?? 0
          let cur = Self.i64(r["st"])
          if id > 0 && id <= upTo && cur >= 1 && cur < nst { r["st"] = NSNumber(value: nst); rows[k] = r; dirty.insert(k); changed = true }
        }
      default:
        continue
      }
    }
    if !changed { return false }
    if keys.count > Self.threadWindow {
      for k in keys.prefix(keys.count - Self.threadWindow) { removed.insert(k); dirty.remove(k) }
      keys = Array(keys.suffix(Self.threadWindow))
    }
    for k in removed where !keys.contains(k) { run(db, "DELETE FROM thread_rows WHERE conv = ? AND k = ?;", [conv, k]) }
    for k in dirty {
      guard let r = rows[k], let s = Self.jsonString(r) else { continue }
      run(db, "INSERT OR REPLACE INTO thread_rows (conv, k, row) VALUES (?,?,?);", [conv, k, s])
    }
    run(db, "UPDATE thread_snap SET keys = ?, newest = ?, n = ?, updated_at = ? WHERE conv = ?;",
        [Self.jsonString(keys) ?? "[]", keys.last ?? "", Int64(keys.count), nowMs(), conv])
    // [2b] foto alcançou a mensagem que a deixou desatualizada → limpa a marca
    if let stale = Int64(metaGet(db, "stale:" + conv) ?? "") {
      let newestId = keys.last.flatMap { rows[$0] }.map { Int64(Self.str($0["id"])) ?? 0 } ?? 0
      if newestId >= stale { run(db, "DELETE FROM meta WHERE k = ?;", ["stale:" + conv]) }
    }
    return true
  }

  /// Mensagens canônicas (raw do servidor), mais antiga → mais nova, como
  /// string JSON "[raw, …]". Síncrono (PK + índice). beforeId 0 = mais novas.
  public func messagesJSONSync(account: String, conv: String, beforeId: Int64, limit: Int) -> String {
    if account.isEmpty || conv.isEmpty { return "[]" }
    return q.sync { [self] in
      guard let db = open(account) else { return "[]" }
      var st: OpaquePointer?
      var raws: [String] = []
      let sql = beforeId > 0
        ? "SELECT raw FROM messages WHERE conv = ? AND id < ? ORDER BY id DESC LIMIT ?;"
        : "SELECT raw FROM messages WHERE conv = ? ORDER BY id DESC LIMIT ?;"
      if sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK {
        bind(st, 1, conv)
        if beforeId > 0 { sqlite3_bind_int64(st, 2, beforeId); sqlite3_bind_int(st, 3, Int32(max(1, limit))) }
        else { sqlite3_bind_int(st, 2, Int32(max(1, limit))) }
        while sqlite3_step(st) == SQLITE_ROW { let r = colText(st, 0); if !r.isEmpty { raws.append(r) } }
      }
      sqlite3_finalize(st)
      return "[" + raws.reversed().joined(separator: ",") + "]"
    }
  }

  // MARK: [fase 1.5] foto da HOME

  public struct HomeSnapshot {
    public let ids: [String]
    public let rows: [[String: Any]]
    public let top: String
    public let readMs: Double
  }

  /// Grava as linhas (como o JS mandou) da lista principal. ids em ordem de exibição.
  public func saveHome(account: String, scope: String, rev: String, top: String, ids: [String], rows: [[String: Any]]) {
    if account.isEmpty || scope.isEmpty { return }
    q.async { [self] in
      guard let db = open(account) else { return }
      var pairs: [(String, String)] = []
      let idSet = Set(ids)
      for d in rows {
        let id = Self.str(d["id"]); if id.isEmpty || !idSet.contains(id) { continue }
        if let s = Self.jsonString(d) { pairs.append((id, s)) }
      }
      let have = Set(pairs.map { $0.0 })
      let ordered = ids.filter { have.contains($0) }
      if exec(db, "BEGIN IMMEDIATE;") != SQLITE_OK { return }
      run(db, "DELETE FROM home_rows WHERE scope = ?;", [scope])
      if ordered.isEmpty {
        run(db, "DELETE FROM home_snap WHERE scope = ?;", [scope])
      } else {
        for (id, s) in pairs { run(db, "INSERT OR REPLACE INTO home_rows (scope, id, row) VALUES (?,?,?);", [scope, id, s]) }
        run(db, "INSERT OR REPLACE INTO home_snap (scope, rev, ids, top, n, updated_at) VALUES (?,?,?,?,?,?);",
            [scope, rev, Self.jsonString(ordered) ?? "[]", top, Int64(ordered.count), nowMs()])
      }
      let rc = exec(db, "COMMIT;")
      if rc != SQLITE_OK { _ = exec(db, "ROLLBACK;"); if isCorrupt(rc) { drop(account) } }
    }
  }

  /// Lê a foto da home (só se rev bater). `done` na main.
  public func loadHome(account: String, scope: String, rev: String, done: @escaping (HomeSnapshot?, String) -> Void) {
    if account.isEmpty || scope.isEmpty { DispatchQueue.main.async { done(nil, "noacct") }; return }
    q.async { [self] in
      let t0 = CFAbsoluteTimeGetCurrent()
      var out: HomeSnapshot?
      var why = "miss"
      if let db = open(account) {
        var st: OpaquePointer?
        var srev = "", sids = "", top = ""
        var found = false
        if sqlite3_prepare_v2(db, "SELECT rev, ids, top FROM home_snap WHERE scope = ?;", -1, &st, nil) == SQLITE_OK {
          bind(st, 1, scope)
          if sqlite3_step(st) == SQLITE_ROW { found = true; srev = colText(st, 0); sids = colText(st, 1); top = colText(st, 2) }
        }
        sqlite3_finalize(st); st = nil
        if found && srev != rev { why = "rev" }
        if found && srev == rev {
          var map: [String: [String: Any]] = [:]
          if sqlite3_prepare_v2(db, "SELECT id, row FROM home_rows WHERE scope = ?;", -1, &st, nil) == SQLITE_OK {
            bind(st, 1, scope)
            while sqlite3_step(st) == SQLITE_ROW {
              if let d = Self.jsonObject(colText(st, 1)) as? [String: Any] { map[colText(st, 0)] = d }
            }
          }
          sqlite3_finalize(st)
          var ids: [String] = []; var rows: [[String: Any]] = []
          for id in (Self.jsonObject(sids) as? [String]) ?? [] { if let d = map[id] { ids.append(id); rows.append(d) } }
          if !ids.isEmpty {
            out = HomeSnapshot(ids: ids, rows: rows, top: top, readMs: (CFAbsoluteTimeGetCurrent() - t0) * 1000)
            why = "hit"
          }
        }
      } else { why = "open" }
      DispatchQueue.main.async { done(out, why) }
    }
  }

  /// "rev\ntop" da foto da home ('' = sem foto). Síncrono (gate do JS).
  public func homeTopSync(account: String, scope: String) -> String {
    if account.isEmpty || scope.isEmpty { return "" }
    return q.sync { [self] in
      guard let db = open(account) else { return "" }
      var st: OpaquePointer?
      var s = ""
      if sqlite3_prepare_v2(db, "SELECT rev, top FROM home_snap WHERE scope = ? AND n > 0;", -1, &st, nil) == SQLITE_OK {
        bind(st, 1, scope)
        if sqlite3_step(st) == SQLITE_ROW { s = colText(st, 0) + "\n" + colText(st, 1) }
      }
      sqlite3_finalize(st)
      return s
    }
  }

  // MARK: [2026-10-15 fase 2b] transporte WS nativo grava direto (sem JS)

  private func metaGet(_ db: OpaquePointer, _ k: String) -> String? {
    var st: OpaquePointer?
    var out: String?
    if sqlite3_prepare_v2(db, "SELECT v FROM meta WHERE k = ?;", -1, &st, nil) == SQLITE_OK {
      bind(st, 1, k)
      if sqlite3_step(st) == SQLITE_ROW { out = colText(st, 0) }
    }
    sqlite3_finalize(st)
    return out
  }

  private func metaSet(_ db: OpaquePointer, _ k: String, _ v: String?) {
    if let v = v { run(db, "INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?);", [k, v]) }
    else { run(db, "DELETE FROM meta WHERE k = ?;", [k]) }
  }

  /// Frames crus do hub (pré-filtrados por ChatyyStoreIngest.wants) → lote numa
  /// transação, na fila do store. Chamado pelo expo-chat-transport.
  public func ingestFrames(account: String, frames: [String], done: (([String: Any]) -> Void)? = nil) {
    if account.isEmpty || frames.isEmpty { return }
    q.async { [self] in
      var out: [String: Any] = ["ok": 1, "messages": 0]
      if let b = ChatyyStoreIngest.translate(me: Self.normAccount(account), frames: frames) { out = applyBatchObj(account, b) }
      done?(out)
    }
  }

  /// Perfil de formato p/ o RowBuilder nativo de texto ("" = remove).
  public func setThreadProfile(account: String, conv: String, json: String) {
    if account.isEmpty || conv.isEmpty { return }
    q.async { [self] in
      guard let db = open(account) else { return }
      metaSet(db, "tp:" + conv, json.isEmpty ? nil : json)
    }
  }

  public func clearThreadProfiles(account: String) {
    if account.isEmpty { return }
    q.async { [self] in
      guard let db = open(account) else { return }
      run(db, "DELETE FROM meta WHERE k LIKE 'tp:%';", [])
    }
  }

  /// id da mensagem que deixou a foto desatualizada (0 = em dia). Síncrono.
  public func threadStaleSync(account: String, conv: String) -> Int64 {
    if account.isEmpty || conv.isEmpty { return 0 }
    return q.sync { [self] in
      guard let db = open(account) else { return 0 }
      return Int64(metaGet(db, "stale:" + conv) ?? "") ?? 0
    }
  }

  private func snapKeys(_ db: OpaquePointer, _ conv: String) -> (String, [String])? {
    var st: OpaquePointer?
    var rev: String?, sk = ""
    if sqlite3_prepare_v2(db, "SELECT rev, keys FROM thread_snap WHERE conv = ?;", -1, &st, nil) == SQLITE_OK {
      bind(st, 1, conv)
      if sqlite3_step(st) == SQLITE_ROW { rev = colText(st, 0); sk = colText(st, 1) }
    }
    sqlite3_finalize(st)
    guard let r = rev else { return nil }
    return (r, (Self.jsonObject(sk) as? [String]) ?? [])
  }

  private func tailOf(_ db: OpaquePointer, _ conv: String, _ keys: [String]) -> ChatyyStoreIngest.Tail? {
    guard let k = keys.last else { return nil }
    var st: OpaquePointer?
    var rowS = ""
    if sqlite3_prepare_v2(db, "SELECT row FROM thread_rows WHERE conv = ? AND k = ?;", -1, &st, nil) == SQLITE_OK {
      bind(st, 1, conv); bind(st, 2, k)
      if sqlite3_step(st) == SQLITE_ROW { rowS = colText(st, 0) }
    }
    sqlite3_finalize(st); st = nil
    guard let row = Self.jsonObject(rowS) as? [String: Any], Self.str(row["kind"]) == "msg", let id = Int64(Self.str(row["id"])) else { return nil }
    var out: ChatyyStoreIngest.Tail?
    if sqlite3_prepare_v2(db, "SELECT created_at, sender, type FROM messages WHERE conv = ? AND id = ?;", -1, &st, nil) == SQLITE_OK {
      bind(st, 1, conv); sqlite3_bind_int64(st, 2, id)
      if sqlite3_step(st) == SQLITE_ROW {
        let ts = sqlite3_column_int64(st, 0)
        let ty = colText(st, 2)
        out = ChatyyStoreIngest.Tail(k: k, id: id, sender: colText(st, 1).lowercased(), ts: ts, type: ty.isEmpty ? "text" : ty, day: ChatyyStoreIngest.dayKey(ts))
      }
    }
    sqlite3_finalize(st)
    return out
  }

  private func convType(_ db: OpaquePointer, _ conv: String, _ b: [String: Any]) -> String {
    if let t = (b["conv_types"] as? [String: Any])?[conv] as? String, !t.isEmpty { return t }
    var st: OpaquePointer?
    var t = ""
    if sqlite3_prepare_v2(db, "SELECT type FROM conversations WHERE id = ?;", -1, &st, nil) == SQLITE_OK {
      bind(st, 1, conv)
      if sqlite3_step(st) == SQLITE_ROW { t = colText(st, 0) }
    }
    sqlite3_finalize(st)
    return t
  }

  private func hasGap(_ db: OpaquePointer, _ conv: String, _ from: Int64, _ to: Int64) -> Bool {
    var st: OpaquePointer?
    var found = false
    if sqlite3_prepare_v2(db, "SELECT 1 FROM messages WHERE conv = ? AND id > ? AND id < ? LIMIT 1;", -1, &st, nil) == SQLITE_OK {
      bind(st, 1, conv); sqlite3_bind_int64(st, 2, from); sqlite3_bind_int64(st, 3, to)
      found = sqlite3_step(st) == SQLITE_ROW
    }
    sqlite3_finalize(st)
    return found
  }

  /// Recibos/leituras + linhas nativas de texto + marca "foto desatualizada". (nativas, stale)
  private func applyIngestKeys(_ account: String, _ db: OpaquePointer, _ b: [String: Any], _ touched: inout Set<String>) -> (Int, Int) {
    let me = Self.normAccount(account)
    var nNative = 0, nStale = 0
    let now = nowMs()
    for r in (b["self_reads"] as? [[String: Any]]) ?? [] {
      let conv = Self.str(r["conv"]); let upTo = Self.i64(r["upTo"]); if conv.isEmpty || upTo <= 0 { continue }
      run(db, "UPDATE conversations SET unread = 0, read_watermark = MAX(COALESCE(read_watermark,0), ?) WHERE id = ?;", [upTo, conv])
      run(db, "INSERT OR IGNORE INTO cursors (scope, pts, last_id, v, updated_at) VALUES (?,0,0,'',0);", ["read:" + conv])
      run(db, "UPDATE cursors SET last_id = MAX(COALESCE(last_id,0), ?), updated_at = ? WHERE scope = ?;", [upTo, now, "read:" + conv])
      touched.insert(conv)
    }
    for r in (b["peer_reads"] as? [[String: Any]]) ?? [] {
      let conv = Self.str(r["conv"]); let upTo = Self.i64(r["upTo"]); if conv.isEmpty || upTo <= 0 { continue }
      let scope = "peer_read:\(conv):" + Self.str(r["email"])
      run(db, "INSERT OR IGNORE INTO cursors (scope, pts, last_id, v, updated_at) VALUES (?,0,0,'',0);", [scope])
      run(db, "UPDATE cursors SET last_id = MAX(COALESCE(last_id,0), ?), updated_at = ? WHERE scope = ?;", [upTo, now, scope])
      // grupo: leitura de UM membro não é "lido" → só cursor
      if convType(db, conv, b) != "direct" { continue }
      run(db, "INSERT OR IGNORE INTO receipts (conv, msg_id, delivered_at, read_at) SELECT conv, id, 0, 0 FROM messages WHERE conv = ? AND sender = ? AND id <= ?;", [conv, me, upTo])
      run(db, "UPDATE receipts SET read_at = MAX(COALESCE(read_at,0), ?), delivered_at = MAX(COALESCE(delivered_at,0), ?) WHERE conv = ? AND msg_id <= ? AND msg_id IN (SELECT id FROM messages WHERE conv = ? AND sender = ?);",
          [now, now, conv, upTo, conv, me])
      if applyThreadOps(db, conv, "", [["op": "stUpTo", "id": NSNumber(value: upTo), "st": 3]]) { dropCached(account, conv) }
      touched.insert(conv)
    }
    for r in (b["delivs"] as? [[String: Any]]) ?? [] {
      let conv = Self.str(r["conv"]); if conv.isEmpty { continue }
      let at = Self.i64(r["at"])
      var mx: Int64 = 0
      for x in (r["ids"] as? [Any]) ?? [] {
        let id = Self.i64(x); if id <= 0 { continue }
        mx = max(mx, id)
        run(db, "INSERT OR IGNORE INTO receipts (conv, msg_id, delivered_at, read_at) VALUES (?,?,0,0);", [conv, id])
        run(db, "UPDATE receipts SET delivered_at = MAX(COALESCE(delivered_at,0), ?) WHERE conv = ? AND msg_id = ?;", [at, conv, id])
      }
      if mx > 0 && convType(db, conv, b) == "direct",
         applyThreadOps(db, conv, "", [["op": "stUpTo", "id": NSNumber(value: mx), "st": 2]]) { dropCached(account, conv) }
      touched.insert(conv)
    }
    guard let touch = b["touch"] as? [[String: Any]] else { return (0, 0) }
    let nowDay = ChatyyStoreIngest.dayKey(now)
    var profiles: [String: ChatyyStoreIngest.TextProfile?] = [:]
    for t in touch {
      let conv = Self.str(t["conv"]); let id = Self.i64(t["id"])
      guard let m = t["msg"] as? [String: Any], !conv.isEmpty, id > 0 else { continue }
      guard let sk = snapKeys(db, conv) else { continue } // sem foto: nada a desatualizar
      let srev = sk.0, keys = sk.1
      let key = ChatyyStoreIngest.keyOf(m)
      let isNew = Self.str(t["kind"]) == "new"
      if isNew && keys.contains(key) { continue } // a foto já tem (JS anexou antes)
      if !isNew {
        // editada/apagada/reação: só importa se a mensagem está na foto
        let cl = Self.str(m["client_message_id"])
        let base = cl.isEmpty ? String(id) : "c:" + cl
        if !keys.contains(base) && !keys.contains(base + "_d") { continue }
      }
      let already = Int64(metaGet(db, "stale:" + conv) ?? "")
      if isNew && already == nil {
        if profiles[conv] == nil {
          let p = metaGet(db, "tp:" + conv).flatMap { Self.jsonObject($0) as? [String: Any] }.map { ChatyyStoreIngest.TextProfile($0) }
          profiles[conv] = .some(p)
        }
        if let prof = profiles[conv] ?? nil, prof.rev == srev, let tail = tailOf(db, conv, keys), !hasGap(db, conv, tail.id, id),
           let ops = ChatyyStoreIngest.textOps(prof, m, tail, nowDay), applyThreadOps(db, conv, srev, ops) {
          dropCached(account, conv); touched.insert(conv); nNative += 1
          continue
        }
      }
      if already == nil || already! < id { metaSet(db, "stale:" + conv, String(id)) }
      touched.insert(conv); nStale += 1
    }
    return (nNative, nStale)
  }

  // MARK: [2026-10-15 fase 4] fila de envio NATIVA (persistência)
  // O motor (envio WS/HTTP, backoff, ordem, 2º plano) mora no expo-chat-transport
  // (ChatOutbox.swift); aqui só a tabela `outbox`. Tudo síncrono na fila do store.

  private static let outboxCols = ["cmi", "conv", "seq", "kind", "body", "frame", "file", "up", "state", "tries", "next_at", "err", "server", "created_at", "updated_at"]
  private static let outboxIntCols: Set<String> = ["seq", "tries", "next_at", "created_at", "updated_at"]

  /// Insere (idempotente por cmi). "new" ou o estado atual da linha existente ("" = falhou).
  public func outboxPut(account: String, item: [String: Any]) -> String {
    let cmi = Self.str(item["cmi"]), conv = Self.str(item["conv"])
    if account.isEmpty || cmi.isEmpty || conv.isEmpty { return "" }
    return q.sync { [self] in
      guard let db = open(account) else { return "" }
      var st: OpaquePointer?
      var cur: String?
      if sqlite3_prepare_v2(db, "SELECT state FROM outbox WHERE cmi = ?;", -1, &st, nil) == SQLITE_OK {
        bind(st, 1, cmi)
        if sqlite3_step(st) == SQLITE_ROW { cur = colText(st, 0) }
      }
      sqlite3_finalize(st)
      if let c = cur { return c }
      let now = nowMs()
      let body: String = (item["body"] as? String) ?? Self.jsonString(item["body"] ?? [String: Any]()) ?? "{}"
      let up: String? = (item["up"] as? String) ?? (item["up"].flatMap { Self.jsonString($0) })
      var kind = Self.str(item["kind"]); if kind.isEmpty { kind = "text" }
      var state = Self.str(item["state"]); if state.isEmpty { state = "queued" }
      let created = Self.i64(item["created_at"])
      let rc = run(db, "INSERT OR IGNORE INTO outbox (cmi, conv, seq, kind, body, frame, file, up, state, tries, next_at, err, server, created_at, updated_at) VALUES (?, ?, (SELECT COALESCE(MAX(seq),0)+1 FROM outbox), ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?);",
                   [cmi, conv, kind, body, item["frame"] as? String, item["file"] as? String, up, state, created > 0 ? created : now, now])
      return rc == SQLITE_DONE ? "new" : ""
    }
  }

  /// Todas as linhas, ordem seq.
  public func outboxAll(account: String) -> [[String: Any]] {
    if account.isEmpty { return [] }
    return q.sync { [self] in
      guard let db = open(account) else { return [] }
      var st: OpaquePointer?
      var out: [[String: Any]] = []
      if sqlite3_prepare_v2(db, "SELECT \(Self.outboxCols.joined(separator: ",")) FROM outbox ORDER BY seq ASC;", -1, &st, nil) == SQLITE_OK {
        while sqlite3_step(st) == SQLITE_ROW {
          var o: [String: Any] = [:]
          for (i, col) in Self.outboxCols.enumerated() {
            let ci = Int32(i)
            if sqlite3_column_type(st, ci) == SQLITE_NULL { continue }
            o[col] = Self.outboxIntCols.contains(col) ? NSNumber(value: sqlite3_column_int64(st, ci)) : colText(st, ci)
          }
          out.append(o)
        }
      }
      sqlite3_finalize(st)
      return out
    }
  }

  /// Atualiza colunas (state/tries/next_at/err/server/body/file/up). NSNull = NULL.
  public func outboxPatch(account: String, cmi: String, patch: [String: Any]) {
    if account.isEmpty || cmi.isEmpty { return }
    q.sync { [self] in
      guard let db = open(account) else { return }
      var sets: [String] = [], args: [Any?] = []
      for (k, v) in patch where ["state", "tries", "next_at", "err", "server", "body", "file", "up"].contains(k) {
        sets.append("\(k) = ?")
        if v is NSNull { args.append(nil) }
        else if k == "tries" || k == "next_at" { args.append(NSNumber(value: Self.i64(v))) }
        else if let s = v as? String { args.append(s) }
        else { args.append(Self.jsonString(v) ?? Self.str(v)) }
      }
      if sets.isEmpty { return }
      sets.append("updated_at = ?"); args.append(NSNumber(value: nowMs())); args.append(cmi)
      run(db, "UPDATE outbox SET \(sets.joined(separator: ", ")) WHERE cmi = ?;", args)
    }
  }

  public func outboxRemove(account: String, cmi: String) {
    if account.isEmpty { return }
    q.sync { [self] in if let db = open(account) { run(db, "DELETE FROM outbox WHERE cmi = ?;", [cmi]) } }
  }

  /// Volta 'sending' órfão (processo morreu no meio) p/ 'queued'.
  @discardableResult
  public func outboxRecover(account: String) -> Int {
    if account.isEmpty { return 0 }
    return q.sync { [self] in
      guard let db = open(account) else { return 0 }
      run(db, "UPDATE outbox SET state = 'queued', next_at = 0 WHERE state = 'sending';", [])
      return Int(sqlite3_changes(db))
    }
  }

  /// Servidor confirmou: linha 'sent' + mensagem canônica + bolha da foto (✓, id).
  public func outboxSent(account: String, cmi: String, conv: String, server: [String: Any]) {
    if account.isEmpty { return }
    q.sync { [self] in
      guard let db = open(account) else { return }
      if exec(db, "BEGIN IMMEDIATE;") != SQLITE_OK { return }
      let raw = Self.jsonString(server) ?? "{}"
      run(db, "UPDATE outbox SET state = 'sent', server = ?, err = NULL, updated_at = ? WHERE cmi = ?;", [raw, nowMs(), cmi])
      let id = Self.i64(server["id"])
      if id > 0 {
        var sender = Self.str(server["sender_email"]); if sender.isEmpty { sender = account }
        var type = Self.str(server["type"]); if type.isEmpty { type = "text" }
        run(db, "INSERT OR REPLACE INTO messages (conv, id, ckey, client_id, sender, type, created_at, edited_at, deleted, reply_to, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?);",
            [conv, id, "c:" + cmi, cmi, sender.lowercased(), type, ChatyyStoreIngest.ms(server["created_at"]), Int64(0), Int64(0), Self.i64(server["reply_to_id"]), raw])
        if applyThreadOps(db, conv, "", [["op": "ack", "k": "c:" + cmi, "id": String(id)]]) { dropCached(account, conv) }
      }
      if exec(db, "COMMIT;") != SQLITE_OK { _ = exec(db, "ROLLBACK;"); return }
      notify(account, [conv])
    }
  }

  /// Falha definitiva: bolha da foto com "!" (st -1).
  public func outboxFailedMark(account: String, cmi: String, conv: String) {
    if account.isEmpty { return }
    q.sync { [self] in
      guard let db = open(account) else { return }
      if applyThreadOps(db, conv, "", [["op": "fail", "k": "c:" + cmi]]) { dropCached(account, conv); notify(account, [conv]) }
    }
  }

  // MARK: limpeza (logout / troca de conta)

  public func wipeAccount(_ account: String) {
    q.sync { [self] in drop(account) }
    clearCache()
  }

  public func wipeAll() {
    q.sync { [self] in
      for (_, db) in dbs { sqlite3_close_v2(db) }
      dbs.removeAll()
      if let dir = Self.dirURL { try? FileManager.default.removeItem(at: dir) }
    }
    clearCache()
  }
}
