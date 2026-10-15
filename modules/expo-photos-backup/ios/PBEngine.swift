import Foundation
import UIKit
import Photos
import BackgroundTasks
import CryptoKit
import ImageIO
import Network
import UniformTypeIdentifiers
import UserNotifications

// [2026-10-15 photos-native] Motor de backup de fotos NATIVO (iOS).
//
//   • fila durável por conta (PBStore/SQLite) — sobrevive a kill/reboot;
//   • varredura incremental via PHPhotoLibrary.fetchPersistentChanges (iOS 16+)
//     + PHPhotoLibraryChangeObserver com o app vivo;
//   • exporta o ORIGINAL (PHAssetResourceManager, HEIC/MOV sem re-encode; baixa
//     do iCloud se preciso) ou JPEG 2048 no modo economia (só fotos);
//   • dedupe: semente com drive_precheck_asset_ids + SHA-256 no drive_init_upload;
//   • PUT direto no R2 (URL pré-assinada, objeto PRIVADO no prefixo md5(email)/)
//     por URLSession BACKGROUND → continua com o app fechado;
//   • BGProcessingTask/BGAppRefreshTask para varrer/preparar lotes;
//   • NUNCA apaga nada do aparelho (não há código para isso).
//
// Toda a mutação de estado roda na fila serial `q`.

struct PBConfig: Codable {
  var account: String = ""
  var apiBase: String = ""
  var fallbackBase: String = "https://chatyy.com.br"
  var enabled: Bool = false
  var paused: Bool = false
  var wifiOnly: Bool = true
  var chargingOnly: Bool = false
  var quality: String = "original"
  var includeVideos: Bool = true
  var notify: Bool = true
  var labels: [String: String] = [:]
}

enum PBError: Error { case gone, noResource, io }

final class PBEngine: NSObject, URLSessionDataDelegate {
  static let shared = PBEngine()

  static let bgWifiId = "com.onemundo.mail.photos.bg"
  static let bgCellId = "com.onemundo.mail.photos.bgcell"
  static let processingId = "com.onemundo.mail.photos.backup"
  static let refreshId = "com.onemundo.mail.photos.refresh"

  private static let configKey = "chatyy.photosbackup.config.v1"
  private static let maxJobs = 2
  private static let maxUploading = 4
  private static let maxTempFiles = 8
  private static let maxTempBytes: Int64 = 1_500 * 1024 * 1024
  private static let maxAttempts = 12

  let q = DispatchQueue(label: "br.com.chatyy.photosbackup.engine", qos: .utility)

  /// Eventos p/ o JS (o módulo instala; nil quando o JS não está vivo).
  var emit: ((String, [String: Any]) -> Void)?

  private(set) var config = PBConfig()
  private var acct = ""
  private var store: PBStore?
  private var token: String?

  private var wifiSession: URLSession!
  private var cellSession: URLSession!
  private let delegateQueue: OperationQueue = {
    let o = OperationQueue()
    o.maxConcurrentOperationCount = 1
    o.name = "br.com.chatyy.photosbackup.urlsession"
    return o
  }()
  private let api: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 30
    c.timeoutIntervalForResource = 90
    c.waitsForConnectivity = false
    c.httpMaximumConnectionsPerHost = 4
    return URLSession(configuration: c)
  }()

  // estado de execução (só em q)
  private var inFlight = Set<String>()
  private var running = false
  private var stopNew = false
  private var authBlocked = false
  private var quotaUntil: Double = 0
  private var lastError = ""
  private var lastRunAt: Double = 0
  private var lastBlocked: String?
  private var freshThisRun = 0
  private var idleWaiters: [() -> Void] = []
  private var bgEventHandlers: [String: () -> Void] = [:]
  private var sentWindow: [(Double, Int64)] = []
  private var lastProgressEmit: Double = 0
  private var scanning = false
  private var uiTask: UIBackgroundTaskIdentifier = .invalid

  // sinais do aparelho
  private let pathMonitor = NWPathMonitor()
  private var pathOK = false
  private var pathCheap = false
  private var charging = false
  private var batteryLevel: Float = -1
  private var observer: PBLibraryObserver?
  private var observerTimer: DispatchWorkItem?

  private override init() {
    super.init()
    if let d = UserDefaults.standard.data(forKey: PBEngine.configKey),
       let c = try? JSONDecoder().decode(PBConfig.self, from: d) {
      config = c
    }
    wifiSession = makeSession(PBEngine.bgWifiId, cellular: false)
    cellSession = makeSession(PBEngine.bgCellId, cellular: true)
    if !config.account.isEmpty { openAccount(config.account) }

    pathMonitor.pathUpdateHandler = { [weak self] p in
      guard let self = self else { return }
      self.q.async {
        let wasOK = self.pathOK, wasCheap = self.pathCheap
        self.pathOK = p.status == .satisfied
        self.pathCheap = self.pathOK && !p.isExpensive && !p.isConstrained
        if (self.pathOK && !wasOK) || (self.pathCheap && !wasCheap) { self.pump() }
      }
    }
    pathMonitor.start(queue: q)

    DispatchQueue.main.async { [weak self] in self?.startDeviceSignals() }
  }

  // MARK: - sessões background

  private func makeSession(_ id: String, cellular: Bool) -> URLSession {
    let c = URLSessionConfiguration.background(withIdentifier: id)
    c.sessionSendsLaunchEvents = true
    c.isDiscretionary = false
    c.allowsCellularAccess = cellular
    c.allowsExpensiveNetworkAccess = cellular
    c.allowsConstrainedNetworkAccess = cellular
    // URL pré-assinada vale 1 h; se o iOS segurar o envio mais que isso o R2
    // responde 403 e a gente re-assina (estado 1).
    c.timeoutIntervalForResource = 12 * 3600
    c.httpMaximumConnectionsPerHost = 4
    return URLSession(configuration: c, delegate: self, delegateQueue: delegateQueue)
  }

  /// AppDelegate → iOS relançou o app para eventos de uma sessão nossa.
  func attachBackgroundEvents(identifier: String, completion: @escaping () -> Void) {
    q.async {
      self.bgEventHandlers[identifier] = completion
      // garante que a sessão existe (o singleton já criou ambas no init)
      _ = self.wifiSession; _ = self.cellSession
      // rede de segurança: o iOS exige a chamada do handler
      self.q.asyncAfter(deadline: .now() + 25) { self.flushBackgroundEvents(identifier, force: true) }
    }
  }

  private func flushBackgroundEvents(_ id: String, force: Bool) {
    guard let h = bgEventHandlers[id] else { return }
    if !force && !inFlight.isEmpty { return }
    bgEventHandlers.removeValue(forKey: id)
    DispatchQueue.main.async { h() }
  }

  // MARK: - sinais do aparelho (main)

  private func startDeviceSignals() {
    let dev = UIDevice.current
    dev.isBatteryMonitoringEnabled = true
    let read: () -> Void = { [weak self] in
      let st = dev.batteryState
      let lvl = dev.batteryLevel
      self?.q.async {
        guard let self = self else { return }
        let was = self.charging
        self.charging = (st == .charging || st == .full)
        self.batteryLevel = lvl
        if self.charging && !was { self.pump() }
      }
    }
    read()
    let nc = NotificationCenter.default
    nc.addObserver(forName: UIDevice.batteryStateDidChangeNotification, object: nil, queue: .main) { _ in read() }
    nc.addObserver(forName: UIDevice.batteryLevelDidChangeNotification, object: nil, queue: .main) { _ in read() }
    nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      self?.q.async { self?.scheduleBackgroundTasks() }
    }
    nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
      self?.q.async {
        guard let self = self, self.config.enabled else { return }
        self.scanThenPump(full: false)
      }
    }
    nc.addObserver(forName: Notification.Name.NSProcessInfoPowerStateDidChange, object: nil, queue: nil) { [weak self] _ in
      self?.q.async { self?.pump() }
    }
  }

  // MARK: - conta / configuração

  static func accountHash(_ email: String) -> String {
    let d = SHA256.hash(data: Data(email.lowercased().trimmingCharacters(in: .whitespacesAndNewlines).utf8))
    return String(d.map { String(format: "%02x", $0) }.joined().prefix(16))
  }

  private func openAccount(_ email: String) {
    acct = PBEngine.accountHash(email)
    store = PBStore(account: acct)
    token = PBKeychain.get(account: acct)
    authBlocked = false
    quotaUntil = 0
    if store != nil { sweepTemp() }
  }

  private func saveConfig() {
    if let d = try? JSONEncoder().encode(config) { UserDefaults.standard.set(d, forKey: PBEngine.configKey) }
  }

  private var tmpDir: URL {
    let d = PBStore.directory().appendingPathComponent("tmp-\(acct)", isDirectory: true)
    if !FileManager.default.fileExists(atPath: d.path) {
      try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true,
                                               attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    }
    return d
  }

  /// Aplica a configuração vinda do JS. Conta diferente → para e isola a anterior.
  func configure(_ o: [String: Any], done: @escaping () -> Void) {
    q.async {
      let email = ((o["account"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      if !email.isEmpty && email != self.config.account.lowercased() {
        self.detachCurrentAccount()
        self.config.account = email
        self.openAccount(email)
      }
      if let t = o["token"] as? String, !t.isEmpty, !self.acct.isEmpty {
        if t != self.token { PBKeychain.set(t, account: self.acct); self.token = t; self.authBlocked = false }
      }
      if let s = o["apiBase"] as? String, s.hasPrefix("https://") { self.config.apiBase = PBEngine.trimBase(s) }
      if let s = o["fallbackBase"] as? String, s.hasPrefix("https://") { self.config.fallbackBase = PBEngine.trimBase(s) }
      let oldWifi = self.config.wifiOnly
      let oldVideos = self.config.includeVideos
      if let b = o["enabled"] as? Bool { self.config.enabled = b }
      if let b = o["wifiOnly"] as? Bool { self.config.wifiOnly = b }
      if let b = o["chargingOnly"] as? Bool { self.config.chargingOnly = b }
      if let s = o["quality"] as? String, s == "original" || s == "economy" { self.config.quality = s }
      if let b = o["includeVideos"] as? Bool { self.config.includeVideos = b }
      if let b = o["notify"] as? Bool { self.config.notify = b }
      if let l = o["labels"] as? [String: Any] {
        var m: [String: String] = [:]
        for (k, v) in l { if let s = v as? String { m[k] = s } }
        self.config.labels = m
      }
      self.saveConfig()
      if oldVideos != self.config.includeVideos { self.store?.setVideosIncluded(self.config.includeVideos) }
      // Wi-Fi ligado agora → uploads que estavam na sessão de celular voltam p/ a fila.
      if self.config.wifiOnly && !oldWifi { self.cancelUploads(in: self.cellSession) }
      if !self.config.enabled { self.cancelAllUploads() }
      self.emitState()
      if self.config.enabled { self.scanThenPump(full: false) }
      self.scheduleBackgroundTasks()
      done()
    }
  }

  private static func trimBase(_ s: String) -> String {
    var b = s
    while b.hasSuffix("/") { b.removeLast() }
    if b.hasSuffix("/api/email.php") { b = String(b.dropLast("/api/email.php".count)) }
    if b.hasSuffix("/api") { b = String(b.dropLast(4)) }
    return b
  }

  /// Para tudo da conta atual (troca de conta / sair). Mantém o banco.
  private func detachCurrentAccount() {
    guard !acct.isEmpty else { return }
    stopNew = true
    cancelAllUploads()
    inFlight.removeAll()
    running = false
    stopNew = false
    store = nil
    token = nil
    acct = ""
  }

  func signOut(done: @escaping () -> Void) {
    q.async {
      if !self.acct.isEmpty { PBKeychain.delete(account: self.acct) }
      self.detachCurrentAccount()
      self.config.account = ""
      self.config.enabled = false
      self.saveConfig()
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: PBEngine.processingId)
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: PBEngine.refreshId)
      self.emitState()
      done()
    }
  }

  func setEnabled(_ on: Bool) {
    q.async {
      self.config.enabled = on
      if on { self.config.paused = false }
      self.saveConfig()
      if !on { self.cancelAllUploads() }
      self.emitState()
      if on { self.scanThenPump(full: false) }
      self.scheduleBackgroundTasks()
    }
  }

  func setPaused(_ p: Bool) {
    q.async {
      self.config.paused = p
      self.saveConfig()
      if p { self.cancelAllUploads() }
      self.emitState()
      if !p { self.store?.resetBackoff(); self.pump() }
      self.scheduleBackgroundTasks()
    }
  }

  func runNow() {
    q.async {
      self.store?.resetBackoff()
      self.authBlocked = false
      self.quotaUntil = 0
      self.scanThenPump(full: false)
    }
  }

  /// Cancela uploads da conta atual e devolve as linhas p/ "exported" (o temp fica).
  private func cancelAllUploads() {
    cancelUploads(in: wifiSession)
    cancelUploads(in: cellSession)
  }

  private func cancelUploads(in session: URLSession) {
    let mine = acct
    let st = store
    session.getAllTasks { tasks in
      for t in tasks {
        guard let d = t.taskDescription, d.hasPrefix(mine + "|") || mine.isEmpty else { continue }
        t.cancel()
      }
    }
    // linhas 3 → 1 já (o callback de cancelamento vê state != 3 e ignora)
    if let st = st {
      for var r in st.rowsInState(.uploading) {
        r.state = PBState.exported.rawValue
        r.uploadUrl = ""
        r.nextAt = 0
        st.update(r)
      }
    }
  }

  // MARK: - status

  func status() -> [String: Any] {
    return q.sync {
      let c = store?.counts() ?? PBStore.Counts()
      var s: [String: Any] = [
        "enabled": config.enabled, "paused": config.paused, "running": running,
        "total": c.total, "done": c.done, "pending": c.pending, "uploading": c.uploading,
        "failed": c.failed, "skipped": c.skipped, "bytesDone": c.bytesDone,
        "lastRunAt": lastRunAt * 1000, "lastError": lastError, "account": acct,
        "wifiOnly": config.wifiOnly, "chargingOnly": config.chargingOnly,
        "quality": config.quality, "includeVideos": config.includeVideos,
      ]
      // [review] String? ?? NSNull não compila (tipos diferentes)
      if let b = blockedReason() { s["blockedBy"] = b } else { s["blockedBy"] = NSNull() }
      return s
    }
  }

  func snapshot() -> [String: [String]] {
    return q.sync { store?.snapshot() ?? [:] }
  }

  private func emitState() {
    let b = blockedReason()
    lastBlocked = b
    let bv: Any = b.map { $0 as Any } ?? NSNull() // [review] tipos do ??
    emit?("onState", ["running": running, "paused": config.paused, "blockedBy": bv])
  }

  private func emitProgress(force: Bool = false) {
    let now = Date().timeIntervalSince1970
    if !force && now - lastProgressEmit < 0.5 { return }
    lastProgressEmit = now
    guard let st = store, emit != nil else { return }
    let c = st.counts()
    sentWindow.removeAll { now - $0.0 > 30 }
    let bytes = sentWindow.reduce(Int64(0)) { $0 + $1.1 }
    emit?("onProgress", ["done": c.done, "total": c.total, "pending": c.pending, "uploading": c.uploading,
                         "failed": c.failed, "bytesPerSec": Int(Double(bytes) / 30.0)])
  }

  private func emitItem(_ id: String, _ state: String, fileId: Int = 0) {
    var b: [String: Any] = ["localId": id, "state": state]
    if fileId > 0 { b["fileId"] = fileId }
    emit?("onItem", b)
  }

  // MARK: - portões

  private func photoAuthorized() -> Bool {
    let s = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    return s == .authorized || s == .limited
  }

  private func blockedReason() -> String? {
    if !config.enabled { return "disabled" }
    if store == nil || token == nil || authBlocked { return "auth" }
    if !photoAuthorized() { return "permission" }
    if quotaUntil > Date().timeIntervalSince1970 { return "quota" }
    if !pathOK { return config.wifiOnly ? "wifi" : "network" }
    if config.wifiOnly && !pathCheap { return "wifi" }
    if config.chargingOnly && !charging { return "charging" }
    if !charging {
      if ProcessInfo.processInfo.isLowPowerModeEnabled { return "battery" }
      if batteryLevel >= 0 && batteryLevel < 0.2 { return "battery" }
    }
    return nil
  }

  // MARK: - varredura

  private func scanThenPump(full: Bool) {
    stopNew = false
    guard config.enabled, let st = store, photoAuthorized(), !scanning else { pump(); return }
    scanning = true
    scan(st, full: full)
    seedIfNeeded(st) { [weak self] in
      guard let self = self else { return }
      self.scanning = false
      self.ensureObserver()
      self.pump()
    }
  }

  private func scan(_ st: PBStore, full: Bool) {
    var handled = false
    if !full, #available(iOS 16.0, *),
       let b64 = st.meta("change_token"), let data = Data(base64Encoded: b64),
       let tok = try? NSKeyedUnarchiver.unarchivedObject(ofClass: PHPersistentChangeToken.self, from: data) {
      do {
        let changes = try PHPhotoLibrary.shared().fetchPersistentChanges(since: tok)
        // caixa de referência: o bloco pode ser @Sendable no SDK novo
        final class Acc { var inserted = Set<String>(); var deleted = Set<String>(); var failed = false }
        let acc = Acc()
        // PHPersistentChangeFetchResult é Sequence no Swift (não tem enumerateChanges).
        for change in changes {
          if let det = try? change.changeDetails(for: PHObjectType.asset) {
            acc.inserted.formUnion(det.insertedLocalIdentifiers)
            acc.deleted.formUnion(det.deletedLocalIdentifiers)
          } else {
            acc.failed = true
          }
        }
        var inserted = acc.inserted
        let deleted = acc.deleted
        if !acc.failed {
          inserted.subtract(deleted)
          if !inserted.isEmpty {
            let res = PHAsset.fetchAssets(withLocalIdentifiers: Array(inserted), options: nil)
            var items: [(id: String, created: Double, media: Int)] = []
            res.enumerateObjects { a, _, _ in
              guard a.mediaType == .image || a.mediaType == .video else { return }
              items.append((a.localIdentifier, a.creationDate?.timeIntervalSince1970 ?? 0, a.mediaType == .video ? 2 : 1))
            }
            _ = st.insertMissing(items, includeVideos: config.includeVideos)
          }
          if !deleted.isEmpty { dropRows(st.remove(Array(deleted))) }
          handled = true
        }
      } catch {
        handled = false // token expirado/inválido → varredura completa
      }
    }
    if !handled { fullScan(st) }
    if #available(iOS 16.0, *) {
      let tok = PHPhotoLibrary.shared().currentChangeToken
      if let d = try? NSKeyedArchiver.archivedData(withRootObject: tok, requiringSecureCoding: true) {
        st.setMeta("change_token", d.base64EncodedString())
      }
    }
  }

  private func fullScan(_ st: PBStore) {
    let opts = PHFetchOptions()
    opts.predicate = NSPredicate(format: "mediaType == %d || mediaType == %d",
                                 PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
    opts.includeHiddenAssets = false
    let res = PHAsset.fetchAssets(with: opts)
    var items: [(id: String, created: Double, media: Int)] = []
    items.reserveCapacity(res.count)
    var seen = Set<String>()
    seen.reserveCapacity(res.count)
    res.enumerateObjects { a, _, _ in
      items.append((a.localIdentifier, a.creationDate?.timeIntervalSince1970 ?? 0, a.mediaType == .video ? 2 : 1))
      seen.insert(a.localIdentifier)
    }
    _ = st.insertMissing(items, includeVideos: config.includeVideos)
    let existing = st.allIds()
    // Biblioteca "vazia" de repente com muita coisa no banco = leitura suspeita
    // (permissão em transição) → não apaga nada.
    if res.count == 0 && existing.count > 50 { return }
    let gone = existing.subtracting(seen)
    if !gone.isEmpty { dropRows(st.remove(Array(gone))) }
  }

  /// Linhas removidas (foto apagada do aparelho): cancela upload e apaga temp. A cópia na nuvem fica.
  private func dropRows(_ rows: [PBRow]) {
    let ids = Set(rows.filter { $0.state == PBState.uploading.rawValue }.map { "\(acct)|\($0.localId)" })
    if !ids.isEmpty {
      for s in [wifiSession!, cellSession!] {
        s.getAllTasks { tasks in for t in tasks where ids.contains(t.taskDescription ?? "") { t.cancel() } }
      }
    }
    for r in rows where !r.tempPath.isEmpty { try? FileManager.default.removeItem(atPath: r.tempPath) }
  }

  /// 1ª vez por conta: pergunta ao servidor quais ids já estão salvos (backup antigo / outro motor).
  private func seedIfNeeded(_ st: PBStore, done: @escaping () -> Void) {
    if st.meta("seeded") == "1" || token == nil { done(); return }
    let ids = st.idsWithState([PBState.pending.rawValue, PBState.skipped.rawValue])
    if ids.isEmpty { st.setMeta("seeded", "1"); done(); return }
    let batches = stride(from: 0, to: ids.count, by: 5000).map { Array(ids[$0..<min($0 + 5000, ids.count)]) }
    Task {
      var ok = true
      for b in batches {
        let (code, json) = await self.post("drive_precheck_asset_ids", ["asset_ids": b], timeout: 60)
        guard code == 200, let data = json?["data"] as? [String: Any] else { ok = false; break }
        let backed = (data["backed_up"] as? [Any] ?? []).compactMap { $0 as? String }
        st.markDone(backed)
      }
      let seeded = ok // [review] sem capturar `var` em closure @Sendable
      self.q.async {
        if seeded { st.setMeta("seeded", "1") }
        self.emitProgress(force: true)
        done()
      }
    }
  }

  private func ensureObserver() {
    guard observer == nil, photoAuthorized() else { return }
    let o = PBLibraryObserver { [weak self] in
      guard let self = self else { return }
      self.q.async {
        self.observerTimer?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.scanThenPump(full: false) }
        self.observerTimer = w
        self.q.asyncAfter(deadline: .now() + 3, execute: w)
      }
    }
    observer = o
    PHPhotoLibrary.shared().register(o)
  }

  private func sweepTemp() {
    guard let st = store else { return }
    var keep = Set<String>()
    for s in [PBState.exported, .signed, .uploading, .uploaded] {
      for r in st.rowsInState(s) where !r.tempPath.isEmpty { keep.insert(r.tempPath) }
    }
    let fm = FileManager.default
    let cutoff = Date().addingTimeInterval(-600)
    if let files = try? fm.contentsOfDirectory(at: tmpDir, includingPropertiesForKeys: [.contentModificationDateKey]) {
      for f in files where !keep.contains(f.path) {
        let m = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
        if m < cutoff { try? fm.removeItem(at: f) }
      }
    }
  }

  // MARK: - bomba da fila

  private func pump() {
    if let b = blockedReason() {
      if running || lastBlocked != b { running = false; emitState() }
      endUITaskIfIdle()
      resolveIdleWaiters()
      return
    }
    guard let st = store else { return }
    if stopNew { resolveIdleWaiters(); return }

    // confirmações pendentes (upload terminou mas o confirm falhou/não rodou)
    let now = Date().timeIntervalSince1970
    for r in st.rowsInState(.uploaded) where !inFlight.contains(r.localId) && r.nextAt <= now && inFlight.count < PBEngine.maxJobs + 2 {
      inFlight.insert(r.localId)
      Task { await self.confirm(r) }
    }

    let uploading = st.countState(.uploading)
    let budget = st.tempBudget()
    let budgetFull = budget.count >= PBEngine.maxTempFiles || budget.bytes >= PBEngine.maxTempBytes
    let slots = PBEngine.maxJobs - inFlight.count
    if slots > 0 {
      let cands = st.nextCandidates(limit: slots * 3, excluding: inFlight)
      var started = 0
      for r in cands where started < slots {
        let needsTemp = r.state == PBState.pending.rawValue
        if needsTemp && budgetFull { continue }
        if !needsTemp && uploading + started >= PBEngine.maxUploading { continue }
        inFlight.insert(r.localId)
        started += 1
        Task { await self.process(r) }
      }
    }

    let active = !inFlight.isEmpty || uploading > 0
    if active != running {
      running = active
      if active { lastRunAt = now; beginUITask() }
      emitState()
    }
    emitProgress()
    if inFlight.isEmpty { resolveIdleWaiters() }
    endUITaskIfIdle()
  }

  private func jobDone(_ id: String) {
    q.async {
      self.inFlight.remove(id)
      for k in Array(self.bgEventHandlers.keys) { self.flushBackgroundEvents(k, force: false) }
      self.pump()
    }
  }

  // tempo extra (~30 s) quando o usuário sai do app no meio de uma exportação
  private func beginUITask() {
    DispatchQueue.main.async {
      guard self.uiTask == .invalid, UIApplication.shared.applicationState == .active else { return }
      self.uiTask = UIApplication.shared.beginBackgroundTask(withName: "chatyy.photos.backup") { [weak self] in
        guard let self = self else { return }
        UIApplication.shared.endBackgroundTask(self.uiTask)
        self.uiTask = .invalid
      }
    }
  }

  private func endUITaskIfIdle() {
    guard inFlight.isEmpty else { return }
    DispatchQueue.main.async {
      if self.uiTask != .invalid {
        UIApplication.shared.endBackgroundTask(self.uiTask)
        self.uiTask = .invalid
      }
    }
  }

  private func resolveIdleWaiters() {
    guard !idleWaiters.isEmpty else { return }
    let w = idleWaiters
    idleWaiters.removeAll()
    for f in w { f() }
  }

  // MARK: - um item

  private func process(_ row: PBRow) async {
    var r = row
    defer { jobDone(r.localId) }
    guard let st = q.sync(execute: { self.store }), st.account == acctSnapshot() else { return }
    do {
      if r.state == PBState.pending.rawValue || r.tempPath.isEmpty || !FileManager.default.fileExists(atPath: r.tempPath) {
        r = try await export(r)
        r.state = PBState.exported.rawValue
        r.uploadUrl = ""
        st.update(r)
      }
      if r.state == PBState.signed.rawValue && Date().timeIntervalSince1970 - r.signedAt > 50 * 60 {
        r.state = PBState.exported.rawValue
        r.uploadUrl = ""
      }
      if r.state == PBState.exported.rawValue {
        guard await sign(&r, st) else { return }
      }
      if r.state == PBState.signed.rawValue {
        q.sync { self.enqueueUpload(&r, st) }
      }
    } catch PBError.gone {
      let removed = st.remove([r.localId])
      q.async { self.dropRows(removed) }
    } catch PBError.noResource {
      r.state = PBState.failedPerm.rawValue
      r.err = "no_resource"
      st.update(r)
      let id = r.localId // [review] sem capturar `var` em closure @Sendable
      q.async { self.emitItem(id, "failed") }
    } catch {
      fail(&r, st, "export: \(error.localizedDescription)")
    }
  }

  private func acctSnapshot() -> String { return q.sync { acct } }

  private func fail(_ r: inout PBRow, _ st: PBStore, _ msg: String, keepState: Bool = true) {
    r.attempts += 1
    let delay = min(6 * 3600.0, 30.0 * pow(2.0, Double(min(r.attempts, 12))))
    r.nextAt = Date().timeIntervalSince1970 + delay
    r.err = String(msg.prefix(200))
    st.update(r)
    let id = r.localId
    let attempts = r.attempts
    q.async {
      self.lastError = String(msg.prefix(200))
      if attempts >= PBEngine.maxAttempts { self.emitItem(id, "failed") }
    }
  }

  private func export(_ row: PBRow) async throws -> PBRow {
    var r = row
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [r.localId], options: nil).firstObject else { throw PBError.gone }
    let isVideo = asset.mediaType == .video
    let res = PHAssetResource.assetResources(for: asset)
    let pick: PHAssetResource? = isVideo
      ? (res.first { $0.type == .fullSizeVideo } ?? res.first { $0.type == .video })
      : (res.first { $0.type == .fullSizePhoto } ?? res.first { $0.type == .photo })
    guard let resource = pick else { throw PBError.noResource }
    let ut = UTType(resource.uniformTypeIdentifier)
    var ext = (ut?.preferredFilenameExtension ?? (isVideo ? "mov" : "jpg")).lowercased()
    var mime = ut?.preferredMIMEType ?? (isVideo ? "video/quicktime" : "image/jpeg")
    if !r.tempPath.isEmpty { try? FileManager.default.removeItem(atPath: r.tempPath) }
    let dir = q.sync { self.tmpDir }
    let dest = dir.appendingPathComponent(UUID().uuidString + "." + ext)
    let opts = PHAssetResourceRequestOptions()
    opts.isNetworkAccessAllowed = true
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
      PHAssetResourceManager.default().writeData(for: resource, toFile: dest, options: opts) { err in
        if let e = err { c.resume(throwing: e) } else { c.resume() }
      }
    }
    var file = dest
    let economy = q.sync { self.config.quality == "economy" }
    if !isVideo && economy && ["heic", "heif", "jpg", "jpeg"].contains(ext) {
      if let small = PBEngine.downscaleJPEG(dest) {
        try? FileManager.default.removeItem(at: dest)
        file = small
        ext = "jpg"
        mime = "image/jpeg"
      }
    }
    try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file.path)
    let size = ((try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? NSNumber)?.int64Value ?? 0
    if size <= 0 { try? FileManager.default.removeItem(at: file); throw PBError.io }
    r.tempPath = file.path
    r.size = size
    r.mime = mime
    r.hash = PBEngine.sha256(file)
    r.filename = PBEngine.taggedName(resource.originalFilename, ext: ext, localId: r.localId)
    if let d = asset.creationDate { r.created = d.timeIntervalSince1970 }
    return r
  }

  /// drive_init_upload: dedupe por hash/asset_id ou URL pré-assinada. false = parar o item agora.
  private func sign(_ r: inout PBRow, _ st: PBStore) async -> Bool {
    let body: [String: Any] = [
      "filename": r.filename, "mime_type": r.mime, "asset_id": r.localId,
      "content_hash": r.hash, "size": r.size, "taken_at": Int64(r.created * 1000),
    ]
    let (code, json) = await post("drive_init_upload", body)
    let data = json?["data"] as? [String: Any]
    let success = (json?["success"] as? Bool) == true
    if code == 413 || (data?["code"] as? String) == "file_too_large" || code == 400 {
      r.state = PBState.failedPerm.rawValue
      r.err = code == 400 ? "rejected" : "file_too_large"
      removeTemp(&r)
      st.update(r)
      let id = r.localId
      q.async { self.emitItem(id, "failed") }
      return false
    }
    if code == 401 || code == 403 {
      q.async { self.authBlocked = true; self.lastError = "auth \(code)"; self.emitState() }
      return false
    }
    if code == 507 {
      q.async { self.quotaUntil = Date().timeIntervalSince1970 + 6 * 3600; self.lastError = "quota"; self.emitState() }
      return false
    }
    guard code == 200, success, let d = data else {
      fail(&r, st, "init \(code) \((json?["error"] as? String) ?? (json?["message"] as? String) ?? "")")
      return false
    }
    if (d["deduped"] as? Bool) == true {
      markDone(&r, st, fileId: PBEngine.int(d["file_id"]))
      return false
    }
    guard let url = d["upload_url"] as? String, url.hasPrefix("https://"),
          let key = d["object_key"] as? String, !key.isEmpty else {
      fail(&r, st, "init sem upload_url")
      return false
    }
    r.uploadUrl = url
    r.objectKey = key
    r.fileId = PBEngine.int(d["file_id"])
    r.signedAt = Date().timeIntervalSince1970
    r.state = PBState.signed.rawValue
    st.update(r)
    return true
  }

  /// em q
  private func enqueueUpload(_ r: inout PBRow, _ st: PBStore) {
    guard let u = URL(string: r.uploadUrl) else { r.state = PBState.exported.rawValue; st.update(r); return }
    var req = URLRequest(url: u)
    req.httpMethod = "PUT"
    req.setValue(r.mime, forHTTPHeaderField: "Content-Type") // assinado na URL
    let session: URLSession = config.wifiOnly ? wifiSession : cellSession
    let task = session.uploadTask(with: req, fromFile: URL(fileURLWithPath: r.tempPath))
    task.taskDescription = "\(acct)|\(r.localId)"
    task.countOfBytesClientExpectsToSend = r.size
    task.countOfBytesClientExpectsToReceive = 2048
    r.state = PBState.uploading.rawValue
    r.taskId = task.taskIdentifier
    st.update(r)
    task.resume()
    emitItem(r.localId, "uploading")
  }

  private func confirm(_ row: PBRow) async {
    var r = row
    defer { jobDone(r.localId) }
    guard let st = q.sync(execute: { self.store }) else { return }
    let body: [String: Any] = [
      "file_id": r.fileId, "s3_key": r.objectKey, "content_hash": r.hash,
      "asset_id": r.localId, "taken_at": Int64(r.created * 1000),
    ]
    let (code, json) = await post("drive_confirm_upload", body)
    if code == 200, (json?["success"] as? Bool) == true {
      let fid = PBEngine.int((json?["data"] as? [String: Any])?["file_id"])
      markDone(&r, st, fileId: fid > 0 ? fid : r.fileId)
      let sz = r.size // [review] sem capturar `var` em closure @Sendable
      q.async {
        self.freshThisRun += 1
        self.sentWindow.append((Date().timeIntervalSince1970, sz))
      }
      return
    }
    if code == 404 {
      // objeto/linha não existe no servidor → re-assina e reenvia (o temp ainda existe)
      r.state = FileManager.default.fileExists(atPath: r.tempPath) ? PBState.exported.rawValue : PBState.pending.rawValue
      r.uploadUrl = ""
      fail(&r, st, "confirm 404")
      return
    }
    if code == 401 || code == 403 { q.async { self.authBlocked = true; self.emitState() } }
    fail(&r, st, "confirm \(code)")
  }

  private func markDone(_ r: inout PBRow, _ st: PBStore, fileId: Int) {
    r.state = PBState.done.rawValue
    r.fileId = fileId
    r.err = ""
    r.uploadUrl = ""
    removeTemp(&r)
    st.update(r)
    let id = r.localId
    q.async {
      self.emitItem(id, "cloud", fileId: fileId)
      self.emitProgress()
    }
  }

  private func removeTemp(_ r: inout PBRow) {
    if !r.tempPath.isEmpty { try? FileManager.default.removeItem(atPath: r.tempPath) }
    r.tempPath = ""
  }

  // MARK: - URLSession (background) delegate

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let desc = task.taskDescription ?? ""
    let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
    let cancelled = (error as NSError?)?.code == NSURLErrorCancelled
    q.async { self.uploadFinished(desc: desc, status: status, error: error, cancelled: cancelled) }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    guard let id = session.configuration.identifier else { return }
    q.async { self.flushBackgroundEvents(id, force: false) }
  }

  private func uploadFinished(desc: String, status: Int, error: Error?, cancelled: Bool) {
    guard let sep = desc.firstIndex(of: "|") else { return }
    let a = String(desc[..<sep])
    let id = String(desc[desc.index(after: sep)...])
    // Upload de outra conta (trocou de conta no meio): o banco dela já voltou a linha p/ 1.
    guard a == acct, let st = store, var r = st.row(id), r.state == PBState.uploading.rawValue else { pump(); return }
    if error == nil && (200..<300).contains(status) {
      r.state = PBState.uploaded.rawValue
      r.uploadUrl = ""
      r.nextAt = 0
      st.update(r)
      inFlight.insert(id)
      let row = r
      Task { await self.confirm(row) }
      return
    }
    r.uploadUrl = ""
    r.state = FileManager.default.fileExists(atPath: r.tempPath) ? PBState.exported.rawValue : PBState.pending.rawValue
    if cancelled {
      r.nextAt = 0
      st.update(r)
    } else {
      // 403 = assinatura expirou (URL de 1 h) → re-assina; demais = backoff
      fail(&r, st, "put \(status) \(error?.localizedDescription ?? "")")
    }
    emitItem(id, "pending")
    pump()
  }

  // MARK: - HTTP

  private func post(_ action: String, _ body: [String: Any], timeout: TimeInterval = 30) async -> (Int, [String: Any]?) {
    let (bases, tok) = q.sync { () -> ([String], String) in
      var b: [String] = []
      if !self.config.apiBase.isEmpty { b.append(self.config.apiBase) }
      if !self.config.fallbackBase.isEmpty && !b.contains(self.config.fallbackBase) { b.append(self.config.fallbackBase) }
      return (b, self.token ?? "")
    }
    if tok.isEmpty { return (401, nil) }
    guard let payload = try? JSONSerialization.data(withJSONObject: body) else { return (0, nil) }
    var last: (Int, [String: Any]?) = (0, nil)
    for base in bases {
      guard let u = URL(string: base + "/api/email.php?action=" + action) else { continue }
      var req = URLRequest(url: u)
      req.httpMethod = "POST"
      req.timeoutInterval = timeout
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
      req.httpBody = payload
      do {
        let (data, resp) = try await api.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        last = (code, json)
        // só cai p/ o fallback em erro de servidor/borda
        if code >= 500 && code != 507 { continue }
        return last
      } catch {
        last = (0, nil)
        continue
      }
    }
    return last
  }

  // MARK: - BG tasks

  func scheduleBackgroundTasks() {
    guard PBEngine.permitted(PBEngine.processingId) else { return }
    guard config.enabled, !config.paused, store != nil else {
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: PBEngine.processingId)
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: PBEngine.refreshId)
      return
    }
    let c = store?.counts() ?? PBStore.Counts()
    let p = BGProcessingTaskRequest(identifier: PBEngine.processingId)
    p.requiresNetworkConnectivity = true
    p.requiresExternalPower = config.chargingOnly
    p.earliestBeginDate = Date(timeIntervalSinceNow: (c.pending + c.uploading) > 0 ? 15 * 60 : 6 * 3600)
    try? BGTaskScheduler.shared.submit(p)
    if PBEngine.permitted(PBEngine.refreshId) {
      let r = BGAppRefreshTaskRequest(identifier: PBEngine.refreshId)
      r.earliestBeginDate = Date(timeIntervalSinceNow: 2 * 3600)
      try? BGTaskScheduler.shared.submit(r)
    }
  }

  static func permitted(_ id: String) -> Bool {
    let ids = Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String] ?? []
    return ids.contains(id)
  }

  /// BGProcessingTask / BGAppRefreshTask: varre, prepara e enfileira o que der; os PUTs seguem na sessão background.
  func handleBackgroundTask(_ task: BGTask, budget: TimeInterval) {
    // [review] caixa de referência: `var` capturada e mutada em closure @Sendable não compila
    final class Flag { var done = false }
    let finished = Flag()
    let finish: (Bool) -> Void = { ok in
      self.q.async {
        if finished.done { return }
        finished.done = true
        self.scheduleBackgroundTasks()
        self.notifyIfNeeded()
        task.setTaskCompleted(success: ok)
      }
    }
    task.expirationHandler = { [weak self] in
      self?.q.async { self?.stopNew = true }
      finish(true)
    }
    q.async {
      self.freshThisRun = 0
      self.idleWaiters.append { finish(true) }
      self.scanThenPump(full: false)
      self.q.asyncAfter(deadline: .now() + budget) { finish(true) }
    }
  }

  private func notifyIfNeeded() {
    let n = freshThisRun
    freshThisRun = 0
    guard n > 0, config.notify else { return }
    let d = UserDefaults.standard
    let last = d.double(forKey: "chatyy.photosbackup.lastNotify")
    let now = Date().timeIntervalSince1970
    if now - last < 6 * 3600 { return }
    let c = store?.counts() ?? PBStore.Counts()
    let labels = config.labels
    DispatchQueue.main.async {
      guard UIApplication.shared.applicationState != .active else { return }
      d.set(now, forKey: "chatyy.photosbackup.lastNotify")
      let content = UNMutableNotificationContent()
      let left = c.pending + c.uploading
      content.title = labels["doneTitle"] ?? "Backup de fotos"
      let body = left > 0 ? (labels["progressBody"] ?? "{done} de {total}") : (labels["doneBody"] ?? "{n} itens salvos")
      content.body = body.replacingOccurrences(of: "{n}", with: "\(n)")
        .replacingOccurrences(of: "{done}", with: "\(c.done)")
        .replacingOccurrences(of: "{total}", with: "\(c.total - c.skipped)")
      content.sound = nil
      content.threadIdentifier = "chatyy.photos.backup"
      content.interruptionLevel = .passive
      let req = UNNotificationRequest(identifier: "chatyy.photos.backup", content: content, trigger: nil)
      UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
    }
  }

  // MARK: - util

  static func int(_ v: Any?) -> Int {
    if let n = v as? NSNumber { return n.intValue }
    if let s = v as? String, let i = Int(s) { return i }
    return 0
  }

  static func md5Tag(_ s: String) -> String {
    let d = Insecure.MD5.hash(data: Data(s.utf8))
    return String(d.map { String(format: "%02x", $0) }.joined().prefix(10))
  }

  /// "IMG_0001.HEIC" → "IMG_0001_<md5(localId)[0:10]>.heic" (mesma tag que o servidor usa no dedupe).
  static func taggedName(_ original: String, ext: String, localId: String) -> String {
    var base = (original as NSString).deletingPathExtension
    if base.isEmpty { base = "photo" }
    var clean = ""
    for ch in base.unicodeScalars {
      if CharacterSet.alphanumerics.contains(ch) && ch.isASCII || ch == "-" || ch == "_" || ch == "." { clean.unicodeScalars.append(ch) }
      else { clean.append("_") }
    }
    if clean.count > 80 { clean = String(clean.prefix(80)) }
    return "\(clean)_\(md5Tag(localId)).\(ext)"
  }

  static func sha256(_ url: URL) -> String {
    guard let h = try? FileHandle(forReadingFrom: url) else { return "" }
    defer { try? h.close() }
    var hasher = SHA256()
    while autoreleasepool(invoking: { () -> Bool in
      let chunk = h.readData(ofLength: 1 << 20)
      if chunk.isEmpty { return false }
      hasher.update(data: chunk)
      return true
    }) {}
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  /// Modo economia: JPEG com lado maior 2048, orientação aplicada, EXIF/GPS mantidos.
  static func downscaleJPEG(_ src: URL, maxPixel: Int = 2048, quality: Double = 0.82) -> URL? {
    return autoreleasepool { () -> URL? in
      guard let s = CGImageSourceCreateWithURL(src as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
      let opts: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        kCGImageSourceShouldCacheImmediately: true,
      ]
      guard let cg = CGImageSourceCreateThumbnailAtIndex(s, 0, opts as CFDictionary) else { return nil }
      let out = src.deletingPathExtension().appendingPathExtension("eco.jpg")
      guard let dst = CGImageDestinationCreateWithURL(out as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
      var props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
      if let p = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any] {
        if let e = p[kCGImagePropertyExifDictionary] { props[kCGImagePropertyExifDictionary] = e }
        if let g = p[kCGImagePropertyGPSDictionary] { props[kCGImagePropertyGPSDictionary] = g }
      }
      CGImageDestinationAddImage(dst, cg, props as CFDictionary)
      return CGImageDestinationFinalize(dst) ? out : nil
    }
  }
}

/// NSObject separado p/ PHPhotoLibraryChangeObserver.
final class PBLibraryObserver: NSObject, PHPhotoLibraryChangeObserver {
  private let onChange: () -> Void
  init(_ onChange: @escaping () -> Void) { self.onChange = onChange; super.init() }
  func photoLibraryDidChange(_ changeInstance: PHChange) { onChange() }
}
