// [e2ee5 WP-03] Host nativo iOS do núcleo chatyy-crypto: transporte HTTP, abertura do store e
// a API Swift PÚBLICA `ChatyyCrypto.shared` que os pacotes nativos (08a fila/ingestão, 10 NSE,
// 11 mídia, 13 ligações) chamam SEM JS. O módulo Expo (ChatyyCryptoModule.swift) é só uma
// casca fina sobre `ChatyyCrypto.shared.invoke(op:args:)`.
//
// Sem dependência do ExpoModulesCore: pode ser compilado na NSE/extensão com o MESMO
// xcframework (ver ChatyyCryptoSupport.swift).
//
// Só compila com o núcleo (SWIFT_ACTIVE_COMPILATION_CONDITIONS CHATYY_CRYPTO_CORE, ligado pelo
// podspec quando o xcframework e as bindings existem — ci/fetch-prebuilt.sh do WP-02).
import Foundation

#if CHATYY_CRYPTO_CORE

/// Transporte do §6.2: POST {base}/api/email.php?action=e2ee5_<action> com Bearer do app,
/// X-E2EE-Device e JSON. Devolve status e corpo CRUS (o núcleo interpreta {success,data}).
final class ChatyyE2EETransport: HttpTransport, @unchecked Sendable {
  private let uid: String
  private let deviceId: String
  private let session: URLSession

  init(uid: String, deviceId: String, timeout: TimeInterval) {
    self.uid = uid
    self.deviceId = deviceId
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = timeout
    cfg.timeoutIntervalForResource = timeout + 5
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    cfg.urlCache = nil
    cfg.httpCookieStorage = nil
    cfg.httpShouldSetCookies = false
    self.session = URLSession(configuration: cfg)
  }

  static func isValidAction(_ a: String) -> Bool {
    return !a.isEmpty && a.count <= 48 && a.allSatisfy { ($0 >= "a" && $0 <= "z") || ($0 >= "0" && $0 <= "9") || $0 == "_" }
  }

  /// Monta o pedido (compartilhado com `status()`, que roda antes de existir um núcleo aberto).
  static func request(action: String, body: String, auth: ChatyyCryptoAuth?, deviceId: String, timeout: TimeInterval) -> URLRequest? {
    let base = auth?.base ?? ChatyyCryptoConst.defaultBase
    guard isValidAction(action), let url = URL(string: base + "/api/email.php?action=e2ee5_" + action) else { return nil }
    var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    if let t = auth?.bearer, !t.isEmpty { req.setValue("Bearer " + t, forHTTPHeaderField: "Authorization") }
    if !deviceId.isEmpty { req.setValue(deviceId, forHTTPHeaderField: "X-E2EE-Device") }
    req.httpBody = Data(body.utf8)
    return req
  }

  func call(action: String, bodyJson: String) async throws -> HttpResponse {
    let auth = ChatyyCryptoAuth.resolve(uid: uid)
    guard let req = Self.request(action: action, body: bodyJson, auth: auth, deviceId: deviceId,
                                 timeout: session.configuration.timeoutIntervalForRequest) else {
      throw TransportError.Network(msg: "bad_action")
    }
    do {
      let (data, resp) = try await session.data(for: req)
      let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
      return HttpResponse(status: UInt16(clamping: max(0, code)), body: String(data: data, encoding: .utf8) ?? "")
    } catch {
      let ns = error as NSError
      // Só domínio/código: nada de URL, corpo ou bearer na mensagem.
      throw TransportError.Network(msg: "\(ns.domain)#\(ns.code)")
    }
  }
}

/// Instância por processo (CONTRATO §6.1: um CryptoCore por processo e por conta).
public actor ChatyyCrypto {
  public static let shared = ChatyyCrypto()
  public static let apiVersion = ChatyyCryptoConst.apiVersion
  public static let coreLinked = true

  /// (evento, corpo) → ouvintes (o módulo Expo repassa ao JS). Corpo sem segredos.
  public typealias Listener = @Sendable (String, [String: Any]) -> Void

  private var listeners: [UUID: Listener] = [:]
  private var cores: [String: CryptoCore] = [:]
  private var opening: [String: Task<(CryptoCore, Bool), Error>] = [:]
  private var currentUid: String?
  private var linkPhone: LinkPhone?
  private let kind = ChatyyProcessKind.current

  private var timeout: TimeInterval { return kind == .push ? 5 : 15 }
  private var role: ProcessRole {
    switch kind {
    case .app: return .app
    case .push: return .push
    case .ext: return .extension
    }
  }

  // MARK: ouvintes

  @discardableResult
  public func addListener(_ l: @escaping Listener) -> UUID {
    let id = UUID()
    listeners[id] = l
    return id
  }

  /// Igual a `addListener`, com o id escolhido por quem chama (o módulo Expo).
  public func addListenerWithId(_ id: UUID, _ l: @escaping Listener) { listeners[id] = l }

  public func removeListener(_ id: UUID) { listeners.removeValue(forKey: id) }

  private func emit(_ name: String, _ body: [String: Any]) {
    for l in listeners.values { l(name, body) }
  }

  // MARK: credenciais, status, flags

  /// Bearer + base da conta logada (o JS chama no login e a cada refresh do bearer).
  public func setAuth(bearer: String, base: String, account: String) {
    ChatyyCryptoAuth.saveCurrent(bearer: bearer, base: base, account: account)
  }

  /// `e2ee5_status` (§4.2.1). Grava `flags.e2ee5_native` para a conta/uid (o núcleo só abre com true).
  public func status() async throws -> [String: Any] {
    let auth = ChatyyCryptoAuth.current()
    let dev: String = {
      if let u = currentUid, let c = cores[u] { return c.deviceId() }
      return ""
    }()
    guard let req = ChatyyE2EETransport.request(action: "status", body: "{}", auth: auth, deviceId: dev, timeout: timeout) else {
      throw ChatyyCryptoHostError("internal", ["msg": "bad_request"])
    }
    let data: Data
    let code: Int
    do {
      let cfg = URLSessionConfiguration.ephemeral
      cfg.timeoutIntervalForRequest = timeout
      cfg.httpCookieStorage = nil
      let s = URLSession(configuration: cfg)
      defer { s.finishTasksAndInvalidate() }
      let (d, r) = try await s.data(for: req)
      data = d
      code = (r as? HTTPURLResponse)?.statusCode ?? 0
    } catch {
      let ns = error as NSError
      throw ChatyyCryptoHostError("transport", ["msg": "\(ns.domain)#\(ns.code)"])
    }
    guard let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      throw ChatyyCryptoHostError("server", ["status": code, "server_code": "bad_response"])
    }
    guard (j["success"] as? Bool) == true, (200..<300).contains(code), let d = j["data"] as? [String: Any] else {
      let sc = ((j["data"] as? [String: Any])?["code"] as? String) ?? (code == 401 ? "unauthorized" : "error")
      throw ChatyyCryptoHostError("server", ["status": code, "server_code": sc])
    }
    let uid = ChatyyCryptoJSON.str(d["uid"])
    if ChatyyCryptoStore.isValidUid(uid) {
      let flags = d["flags"] as? [String: Any] ?? [:]
      let on = (flags["e2ee5_native"] as? Bool) == true && (d["enabled"] as? Bool) == true && (d["kill"] as? Bool) != true
      ChatyyCryptoFlags.setNative(uid: uid, account: auth?.account ?? "", enabled: on)
      // [WP-10] a NSE só decifra com esta chave = true (lida do App Group, sem rede).
      let pd = on && (flags["e2ee5_push_decrypt"] as? Bool) == true
      UserDefaults(suiteName: ChatyyCryptoConst.appGroup)?.set(pd, forKey: "chatyy.e2ee5.push_decrypt.u." + uid)
      ChatyyCryptoAuth.bind(uid: uid)
      emit("onNativeFlag", ["uid": uid, "enabled": on])
    }
    return d
  }

  public nonisolated func nativeEnabled(uid: String) -> Bool { return ChatyyCryptoFlags.native(uid: uid) }

  // MARK: ciclo de vida

  /// Abre (ou cria) o store do uid. Sem rede. Exige `e2ee5_native` = true gravado pelo `status()`.
  /// `makeCurrent` = vira a conta "atual" das chamadas do JS (só o `open` do JS usa true).
  public func open(uid: String, prefix: String = "P", makeCurrent: Bool = true) async throws -> (deviceId: String, created: Bool) {
    guard ChatyyCryptoStore.isValidUid(uid) else { throw ChatyyCryptoHostError("invalid_input", ["field": "uid"]) }
    guard ChatyyCryptoFlags.native(uid: uid) else { throw ChatyyCryptoHostError("disabled", ["why": "e2ee5_native"]) }
    if let c = cores[uid] {
      if makeCurrent { currentUid = uid }
      return (c.deviceId(), false)
    }
    if let t = opening[uid] {
      let (c, created) = try await t.value
      if makeCurrent { currentUid = uid }
      return (c.deviceId(), created)
    }
    let role = self.role
    let timeout = self.timeout
    let holder = "\(ProcessInfo.processInfo.processIdentifier)"
    let pfx = prefix == "X" ? "X" : (prefix == "T" ? "T" : "P")
    let t = Task<(CryptoCore, Bool), Error> {
      let sec = try ChatyyCryptoStore.secrets(uid: uid) { try newDeviceId(platformPrefix: pfx) }
      guard let dir = ChatyyCryptoStore.dir(uid: uid) else { throw ChatyyCryptoHostError("store", ["msg": "app_group_unavailable"]) }
      try ChatyyCryptoStore.prepare(dir)
      let opts = OpenOptions(storeDir: dir.path, storePassphrase: sec.passphrase, uid: uid, deviceId: sec.deviceId,
                             role: role, holderSuffix: holder)
      let tr = ChatyyE2EETransport(uid: uid, deviceId: sec.deviceId, timeout: timeout)
      let core = try await CryptoCore.open(opts: opts, transport: tr)
      return (core, sec.created)
    }
    opening[uid] = t
    defer { opening.removeValue(forKey: uid) }
    let (core, created) = try await t.value
    cores[uid] = core
    if makeCurrent { currentUid = uid }
    return (core.deviceId(), created)
  }

  /// Núcleo do uid (nil = o atual / último) para os chamadores NATIVOS: reusa ou abre, e por
  /// padrão NÃO troca a conta atual do JS (`makeCurrent: false`), então serve a qualquer conta
  /// logada (multi-conta). Um CryptoCore por uid no processo; a trava entre processos
  /// (app × NSE × extensão) é do próprio núcleo (CrossProcessLock no SQLite).
  public func core(uid: String? = nil, makeCurrent: Bool = false) async throws -> CryptoCore {
    guard let u = uid ?? currentUid ?? lastUid() else { throw ChatyyCryptoHostError("not_open") }
    if let c = cores[u] {
      if makeCurrent { currentUid = u }
      return c
    }
    _ = try await open(uid: u, makeCurrent: makeCurrent)
    guard let c = cores[u] else { throw ChatyyCryptoHostError("not_open") }
    return c
  }

  /// Núcleo já aberto neste processo, sem abrir nem trocar a conta atual (nil = não aberto).
  public func peekCore(uid: String) -> CryptoCore? { return cores[uid] }

  private nonisolated func lastUid() -> String? {
    let u = UserDefaults(suiteName: ChatyyCryptoConst.appGroup)?.string(forKey: "chatyy.e2ee5.lastUid") ?? ""
    return u.isEmpty ? nil : u
  }

  /// Núcleo já aberto, sem abrir (as chamadas do JS exigem `open` antes).
  private func opened() throws -> CryptoCore {
    guard let u = currentUid, let c = cores[u] else { throw ChatyyCryptoHostError("not_open") }
    return c
  }

  public func close() {
    if let u = currentUid { cores.removeValue(forKey: u) }
    currentUid = nil
    linkPhone = nil
  }

  /// Logout / desvincular: apaga store + aparelho do uid (próximo open = aparelho novo).
  public func wipe(uid: String) -> Int {
    let u = uid.isEmpty ? (currentUid ?? "") : uid
    guard ChatyyCryptoStore.isValidUid(u) else { return 0 }
    cores.removeValue(forKey: u)
    if currentUid == u { currentUid = nil; linkPhone = nil }
    ChatyyCryptoAuth.forget(uid: u)
    return ChatyyCryptoStore.wipe(uid: u)
  }

  // MARK: sync (+ eventos)

  /// `sync()` com eventos: `onSyncResult` (sempre), `onNewKeys`, `onIdentityChanged`.
  /// `source` = "js" (o chamador JS recebe os chatyy_events no retorno) ou "native"
  /// (fila/WS/NSE nativos: os eventos chatyy.* também vão aos ouvintes).
  public func sync(uid: String? = nil, source: String = "native") async throws -> SyncResult {
    let c = try await core(uid: uid)
    let r = try await c.sync()
    report(c.uid(), r, source: source)
    return r
  }

  public func syncWith(_ json: String, uid: String? = nil, source: String = "native") async throws -> SyncResult {
    let c = try await core(uid: uid)
    let r = try await c.syncWith(syncDataJson: json)
    report(c.uid(), r, source: source)
    return r
  }

  private func report(_ uid: String, _ r: SyncResult, source: String) {
    var body = Self.syncDict(r, includeEvents: source != "js")
    body["uid"] = uid
    body["source"] = source
    emit("onSyncResult", body)
    if !r.convsWithNewKeys.isEmpty { emit("onNewKeys", ["uid": uid, "convIds": r.convsWithNewKeys]) }
    if !r.identityChangedUids.isEmpty { emit("onIdentityChanged", ["uid": uid, "uids": r.identityChangedUids]) }
  }

  // MARK: conversões (structs → JSON do §6.11, camelCase)

  static func syncDict(_ r: SyncResult, includeEvents: Bool = true) -> [String: Any] {
    var d: [String: Any] = [
      "toDeviceProcessed": r.toDeviceProcessed, "toDeviceUtd": r.toDeviceUtd,
      "convsWithNewKeys": r.convsWithNewKeys, "identityChangedUids": r.identityChangedUids, "more": r.more,
      "chatyyEventsCount": r.chatyyEvents.count,
    ]
    if includeEvents {
      d["chatyyEvents"] = r.chatyyEvents.map {
        ["eventType": $0.eventType, "senderUid": $0.senderUid, "senderDeviceId": $0.senderDeviceId, "contentJson": $0.contentJson]
      }
    }
    return d
  }

  static func deviceDict(_ d: DeviceSummary) -> [String: Any] {
    return ["uid": d.uid, "deviceId": d.deviceId, "ed25519": d.ed25519, "curve25519": d.curve25519,
            "signedByOwner": d.signedByOwner, "isThisDevice": d.isThisDevice]
  }

  static func identityDict(_ s: IdentityStatus) -> [String: Any] {
    return ["uid": s.uid, "hasIdentity": s.hasIdentity, "masterKey": s.masterKey, "verified": s.verified,
            "needsApproval": s.needsApproval, "isPrimary": s.isPrimary]
  }

  static func importDict(_ r: ImportResult) -> [String: Any] {
    return ["imported": r.imported, "total": r.total, "convs": r.convs]
  }

  static func trustStr(_ t: Trust) -> String {
    switch t {
    case .verified: return "verified"
    case .tofu: return "tofu"
    case .changed: return "changed"
    case .deviceRemoved: return "device_removed"
    }
  }

  static func utdStr(_ r: UtdReason) -> (String, Bool) {
    switch r {
    case .missingSession: return ("missing_session", true)
    case .unknownIndex: return ("unknown_index", true)
    case .withheld: return ("withheld", false)
    case .untrustedDevice: return ("untrusted_device", true)
    case .senderMismatch: return ("sender_mismatch", false)
    case .contextMismatch: return ("context_mismatch", false)
    case .badEnvelope: return ("bad_envelope", false)
    case .corrupted: return ("corrupted", false)
    case .store: return ("store", true)
    case .unverifiedSender: return ("unverified_sender", false)
    }
  }

  /// Erro → (`.code` do §6.11, detalhes sem conteúdo).
  public static func describe(_ e: Error) -> (code: String, details: [String: Any]) {
    if let h = e as? ChatyyCryptoHostError { return (h.code, h.details) }
    if let c = e as? CoreError {
      switch c {
      case let .Utd(reason, sessionId):
        let (r, retry) = utdStr(reason)
        return ("utd", ["reason": r, "retryable": retry, "session_id": sessionId])
      case let .InvalidInput(field, msg): return ("invalid_input", ["field": field, "msg": msg])
      case let .Transport(msg): return ("transport", ["msg": msg])
      case let .Server(status, code): return ("server", ["status": Int(status), "server_code": code])
      case let .Store(msg): return ("store", ["msg": msg])
      case .LockBusy: return ("lock_busy", [:])
      case let .Identity(msg): return ("identity", ["msg": msg])
      case let .IdentityViolation(uids): return ("identity_violation", ["uids": uids])
      case let .Media(msg): return ("media", ["msg": msg])
      case let .Link(msg): return ("link", ["msg": msg])
      case let .Backup(msg): return ("backup", ["msg": msg])
      case let .Internal(msg): return ("internal", ["msg": msg])
      }
    }
    if let t = e as? TransportError {
      switch t {
      case let .Network(msg): return ("transport", ["msg": msg])
      }
    }
    return ("internal", ["msg": String(describing: type(of: e))])
  }

  private static func b64(_ v: Any?, _ field: String) throws -> Data {
    guard let s = v as? String, let d = Data(base64Encoded: s) else { throw ChatyyCryptoHostError("invalid_input", ["field": field, "msg": "base64"]) }
    return d
  }

  // MARK: despacho (§6.11) — usado pelo módulo Expo; args/resultado = JSON

  /// Executa a operação `op` com `args` (JSON) e devolve `{"v": resultado}` em JSON.
  /// Bytes vão e voltam em base64.
  public func invoke(op: String, args: String) async throws -> String {
    let a = ChatyyCryptoJSON.parse(args)
    let S = ChatyyCryptoJSON.str
    let out: Any
    switch op {
    case "setAuth":
      setAuth(bearer: S(a["bearer"]), base: S(a["base"]), account: S(a["account"]))
      out = [String: Any]()
    case "status":
      out = try await status()
    case "nativeEnabled":
      let u = S(a["uid"])
      out = u.isEmpty ? ChatyyCryptoFlags.nativeForLast() : ChatyyCryptoFlags.native(uid: u)
    case "open":
      let u = S(a["uid"])
      let r = try await open(uid: u, prefix: S(a["prefix"]).isEmpty ? "P" : S(a["prefix"]))
      out = ["uid": u, "deviceId": r.deviceId, "created": r.created]
    case "close":
      close()
      out = [String: Any]()
    case "wipe":
      out = ["deleted": wipe(uid: S(a["uid"]))]

    // funções livres (§6.3)
    case "coreVersion": out = coreVersion()
    case "newDeviceId": out = try newDeviceId(platformPrefix: S(a["prefix"]))
    case "envelopeVersion":
      if let v = envelopeVersion(content: S(a["content"])) { out = v } else { out = NSNull() }
    case "encryptBytes":
      let r = try encryptBytes(plain: try Self.b64(a["data"], "data"))
      out = ["data": r.data.base64EncodedString(), "infoJson": r.infoJson]
    case "decryptBytes":
      out = try decryptBytes(data: try Self.b64(a["data"], "data"), infoJson: S(a["infoJson"])).base64EncodedString()
    case "encryptFile":
      let r = try encryptFile(inPath: S(a["inPath"]), outPath: S(a["outPath"]))
      out = ["infoJson": r.infoJson, "size": r.size]
    case "decryptFile":
      out = try decryptFile(inPath: S(a["inPath"]), outPath: S(a["outPath"]), infoJson: S(a["infoJson"]))

    // CryptoCore (§6.4)
    case "thisDevice": out = Self.deviceDict(try await opened().thisDevice())
    case "sync":
      _ = try opened()
      out = Self.syncDict(try await sync(uid: currentUid, source: "js"))
    case "syncWith":
      _ = try opened()
      out = Self.syncDict(try await syncWith(ChatyyCryptoJSON.jsonArg(a["syncData"]), uid: currentUid, source: "js"))
    case "trackUsers":
      try await opened().trackUsers(uids: ChatyyCryptoJSON.strs(a["uids"]))
      out = [String: Any]()
    case "encrypt":
      do {
        let r = try await opened().encrypt(convId: S(a["convId"]), memberUids: ChatyyCryptoJSON.strs(a["memberUids"]),
                                           payloadJson: ChatyyCryptoJSON.jsonArg(a["payload"]))
        out = ["envelopeJson": r.envelopeJson, "sessionId": r.sessionId, "keyShareRequests": r.keyShareRequests,
               "keyShareBytes": r.keyShareBytes]
      } catch let CoreError.IdentityViolation(uids) {
        emit("onIdentityViolation", ["uid": currentUid ?? "", "uids": uids])
        throw CoreError.IdentityViolation(uids: uids)
      }
    case "decrypt":
      let inp = DecryptInput(convId: S(a["convId"]), envelopeJson: S(a["envelopeJson"]), senderUid: S(a["senderUid"]),
                             serverMid: S(a["serverMid"]), cmid: S(a["cmid"]), tsMs: ChatyyCryptoJSON.u64(a["tsMs"]))
      let r = try await opened().decrypt(input: inp)
      out = ["payloadJson": r.payloadJson, "senderUid": r.senderUid, "senderDeviceId": r.senderDeviceId,
             "trust": Self.trustStr(r.trust), "sessionId": r.sessionId]
    case "sendToDevice":
      let targets = (a["targets"] as? [[String: Any]] ?? []).map { DeviceTarget(uid: S($0["uid"]), deviceId: S($0["deviceId"])) }
      let r = try await opened().sendToDevice(eventType: S(a["eventType"]), targets: targets,
                                              contentJson: ChatyyCryptoJSON.jsonArg(a["content"]))
      out = ["sentDevices": r.sentDevices, "withheld": r.withheld]
    case "rotateConversation": out = try await opened().rotateConversation(convId: S(a["convId"]))
    // [e2ee5 1.7 keyreq] pedido de chave de sala (destinatário) / reenvio pelo dono da sessão (remetente)
    case "requestRoomKey":
      let r = try await opened().requestRoomKey(convId: S(a["convId"]), sessionId: S(a["sessionId"]),
                                                senderUid: S(a["senderUid"]), serverMid: S(a["serverMid"]))
      out = ["sent": r.sent, "dedup": r.dedup, "reqId": r.reqId, "sentDevices": r.sentDevices, "reason": r.reason]
    case "shareRoomKey":
      let r = try await opened().shareRoomKey(convId: S(a["convId"]), sessionId: S(a["sessionId"]),
                                              targetUid: S(a["targetUid"]), targetDevices: ChatyyCryptoJSON.strs(a["targetDevices"]))
      out = ["sharedDevices": r.sharedDevices, "refused": r.refused, "reason": r.reason]
    // [e2ee5 utd-wa 2026-10-23] chave antes da 1ª mensagem + busca de UMA sessão no backup
    case "prewarmConversation":
      let r = try await opened().prewarmConversation(convId: S(a["convId"]), memberUids: ChatyyCryptoJSON.strs(a["memberUids"]))
      out = ["keyShareRequests": r.keyShareRequests, "keyShareBytes": r.keyShareBytes, "sessionId": r.sessionId]
    case "backupFetchSession":
      let r = try await opened().backupFetchSession(convId: S(a["convId"]), sessionId: S(a["sessionId"]))
      out = ["imported": r.imported, "reason": r.reason, "convs": r.convs]
    case "onMembersChanged":
      try await opened().onMembersChanged(convId: S(a["convId"]), memberUids: ChatyyCryptoJSON.strs(a["memberUids"]),
                                          removedUids: ChatyyCryptoJSON.strs(a["removedUids"]))
      out = [String: Any]()
    case "forgetDevice": out = try await opened().forgetDevice(deviceId: S(a["deviceId"]))
    case "listDevices": out = try await opened().listDevices(uid: S(a["uid"])).map(Self.deviceDict)
    case "bootstrapIdentity": out = Self.identityDict(try await opened().bootstrapIdentity())
    case "signDevice":
      try await opened().signDevice(deviceId: S(a["deviceId"]), expectedEd25519: S(a["expectedEd25519"]))
      out = [String: Any]()
    case "identityStatus": out = Self.identityDict(try await opened().identityStatus(uid: S(a["uid"])))
    case "pinIdentity":
      try await opened().pinIdentity(uid: S(a["uid"]))
      out = [String: Any]()
    case "safetyNumber":
      let s = try await opened().safetyNumber(uid: S(a["uid"]))
      out = ["digits": s.digits, "qrPayload": s.qrPayload]
    case "verifySafetyQr": out = try await opened().verifySafetyQr(uid: S(a["uid"]), scanned: S(a["scanned"]))
    case "markVerified":
      try await opened().markVerified(uid: S(a["uid"]))
      out = [String: Any]()
    case "exportRoomKeys":
      let f = a["filter"] as? [String: Any] ?? [:]
      let d = try await opened().exportRoomKeys(filter: ExportFilter(convIds: ChatyyCryptoJSON.strs(f["convIds"]),
                                                                     sinceMs: ChatyyCryptoJSON.u64(f["sinceMs"])))
      out = d.base64EncodedString()
    case "importRoomKeys":
      out = Self.importDict(try await opened().importRoomKeys(blob: try Self.b64(a["data"], "data")))
    case "exportRoomKeysWithPassphrase":
      out = try await opened().exportRoomKeysWithPassphrase(passphrase: S(a["passphrase"]))
    case "importRoomKeysWithPassphrase":
      out = Self.importDict(try await opened().importRoomKeysWithPassphrase(data: S(a["data"]), passphrase: S(a["passphrase"])))
    case "backupEnable":
      let r = try await opened().backupEnable(passphrase: S(a["passphrase"]))
      out = ["recoveryKey": r.recoveryKey, "version": r.version]
    case "backupStep": out = try await opened().backupStep(maxBatches: UInt32(clamping: ChatyyCryptoJSON.u64(a["maxBatches"])))
    case "backupStatus":
      let s = try await opened().backupStatus()
      out = ["enabled": s.enabled, "version": s.version, "totalKeys": s.totalKeys, "backedUpKeys": s.backedUpKeys]
    case "backupDisable":
      try await opened().backupDisable()
      out = [String: Any]()
    case "backupRestore":
      let r = try await opened().backupRestore(recoveryKeyOrPassphrase: S(a["keyOrPassphrase"]))
      out = ["imported": r.imported, "total": r.total, "identityRestored": r.identityRestored, "convs": r.convs]
    case "metricsSnapshot":
      let m = try opened().metricsSnapshot()
      out = ["encrypt": m.encrypt, "decryptOk": m.decryptOk, "utdJson": m.utdJson, "utdTotal": m.utdTotal,
             "toDeviceIn": m.toDeviceIn, "toDeviceUtd": m.toDeviceUtd, "droppedUntrusted": m.droppedUntrusted,
             "storeReloads": m.storeReloads, "keyReqSent": m.keyReqSent, "keyReqServed": m.keyReqServed,
             "keyReqOk": m.keyReqOk, "keyReqRefused": m.keyReqRefused]
    case "flushMetrics":
      try await opened().flushMetrics()
      out = [String: Any]()

    // vínculo, lado celular (§6.7 / §6.11.5)
    case "linkAccept":
      let f = a["filter"] as? [String: Any] ?? [:]
      let lp = try await LinkPhone.accept(core: try opened(), qrPayload: S(a["qrPayload"]),
                                          filter: ExportFilter(convIds: ChatyyCryptoJSON.strs(f["convIds"]),
                                                               sinceMs: ChatyyCryptoJSON.u64(f["sinceMs"])))
      linkPhone = lp
      out = ["checkCode": Int(lp.checkCode())]
    case "linkPhonePoll":
      guard let lp = linkPhone else { throw ChatyyCryptoHostError("link", ["msg": "no_link"]) }
      switch try await lp.poll() {
      case .waitingDevice: out = ["state": "waiting_device"]
      case let .waitingUpload(deviceId): out = ["state": "waiting_upload", "deviceId": deviceId]
      case let .sent(deviceId, chunks): out = ["state": "sent", "deviceId": deviceId, "chunks": chunks]
      case let .done(deviceId):
        linkPhone = nil
        out = ["state": "done", "deviceId": deviceId]
      }
    case "linkCancel":
      linkPhone = nil
      out = [String: Any]()

    default:
      throw ChatyyCryptoHostError("unsupported", ["op": op])
    }
    return ChatyyCryptoJSON.string(["v": out])
  }
}

#endif
