// [e2ee5 WP-03] Suporte do host nativo iOS do núcleo chatyy-crypto (CONTRATO §1.3, §4.1, §6.2, §6.10).
//
// Este arquivo NÃO depende do núcleo nem do ExpoModulesCore: compila sempre (também no modo
// "stub", sem o xcframework) e pode ser compilado dentro da NSE / extensão de compartilhar
// (WP-10 / WP-08a) junto com ChatyyCryptoHost.swift.
//
// Guarda:
//   - senha do store (32 B aleatórios, base64) e device_id por uid → Keychain
//     (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, sem iCloud, access group compartilhado
//     XN9XN27QCE.com.onemundo.mail.e2ee5 quando o binário tem o entitlement; senão o grupo padrão);
//   - bearer + base por conta/uid (o mesmo bearer do ChatTransport; o JS chama setAuth) → Keychain;
//   - flag `e2ee5_native` vinda do `e2ee5_status` → UserDefaults do App Group (não é segredo).
// Store: App Group group.com.onemundo.mail/e2ee5/<uid>, excluído do backup do iCloud.
//
// NUNCA loga bearer, senha, conteúdo ou corpo de resposta (CONTRATO §0.4).
import Foundation
import Security

public enum ChatyyCryptoConst {
  /// Versão da API do módulo (JS confere `info().apiVersion >= REQUIRED_API`).
  public static let apiVersion = 1
  public static let appGroup = "group.com.onemundo.mail"
  public static let teamPrefix = "XN9XN27QCE"
  public static let keychainService = "br.com.chatyy.e2ee5"
  /// Item do ChatTransport/ChatOutbox (só leitura, plano B do bearer no processo do app).
  public static let outboxService = "br.com.chatyy.outbox"
  public static let defaultBase = "https://chatyy.com.br"
  /// Grupo de keychain compartilhado app + NSE + extensões (plugins/with-chatyy-crypto.js).
  public static var sharedKeychainGroup: String {
    if let s = Bundle.main.object(forInfoDictionaryKey: "ChatyyE2EE5KeychainGroup") as? String,
       !s.isEmpty, !s.hasPrefix("$(") {
      return s
    }
    return teamPrefix + ".com.onemundo.mail.e2ee5"
  }
}

/// Erro do host com `.code` do §6.11 (`disabled`, `not_open`, `store`, …) e detalhes sem conteúdo.
public struct ChatyyCryptoHostError: Error, CustomStringConvertible {
  public let code: String
  public let details: [String: Any]
  public init(_ code: String, _ details: [String: Any] = [:]) {
    self.code = code
    self.details = details
  }
  public var description: String { return "e2ee5:\(code)" }
}

/// Papel do processo (vira o holder da trava entre processos do núcleo).
public enum ChatyyProcessKind: String {
  case app, push, ext

  public static var current: ChatyyProcessKind {
    let b = Bundle.main
    guard b.bundleURL.pathExtension == "appex" else { return .app }
    let ext = b.object(forInfoDictionaryKey: "NSExtension") as? [String: Any]
    let point = ext?["NSExtensionPointIdentifier"] as? String ?? ""
    return point == "com.apple.usernotifications.service" ? .push : .ext
  }
}

// MARK: - Keychain

public enum ChatyyCryptoKeychain {
  private static let errSecMissingEntitlementCode: OSStatus = -34018

  private static func base(_ account: String, service: String) -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  /// Grava (substitui) o item. Tenta o access group compartilhado; sem o entitlement
  /// (errSecMissingEntitlement) grava no grupo padrão do binário.
  @discardableResult
  public static func save(_ account: String, _ data: Data, service: String = ChatyyCryptoConst.keychainService) -> Bool {
    SecItemDelete(base(account, service: service) as CFDictionary)
    var add = base(account, service: service)
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    add[kSecAttrSynchronizable as String] = kCFBooleanFalse
    var withGroup = add
    withGroup[kSecAttrAccessGroup as String] = ChatyyCryptoConst.sharedKeychainGroup
    var st = SecItemAdd(withGroup as CFDictionary, nil)
    if st == errSecMissingEntitlementCode || st == errSecParam {
      st = SecItemAdd(add as CFDictionary, nil)
    }
    return st == errSecSuccess
  }

  /// Lê em qualquer grupo acessível ao binário.
  public static func load(_ account: String, service: String = ChatyyCryptoConst.keychainService) -> Data? {
    return lookup(account, service: service).data
  }

  /// Leitura com o status: `errSecItemNotFound` ≠ Keychain indisponível (ex.: NSE antes do
  /// 1º desbloqueio após reiniciar → errSecInteractionNotAllowed). Só "não encontrado" pode
  /// virar "aparelho novo"; o resto é erro transitório e NUNCA apaga o store.
  public static func lookup(_ account: String, service: String = ChatyyCryptoConst.keychainService) -> (data: Data?, status: OSStatus) {
    var q = base(account, service: service)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let st = SecItemCopyMatching(q as CFDictionary, &out)
    return (st == errSecSuccess ? out as? Data : nil, st)
  }

  public static func delete(_ account: String, service: String = ChatyyCryptoConst.keychainService) {
    SecItemDelete(base(account, service: service) as CFDictionary)
  }

  public static func loadJSON(_ account: String, service: String = ChatyyCryptoConst.keychainService) -> [String: Any]? {
    guard let d = load(account, service: service) else { return nil }
    return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
  }

  @discardableResult
  public static func saveJSON(_ account: String, _ obj: [String: Any]) -> Bool {
    guard JSONSerialization.isValidJSONObject(obj), let d = try? JSONSerialization.data(withJSONObject: obj) else { return false }
    return save(account, d)
  }

  /// 32 bytes de SecRandomCopyBytes em base64 (CONTRATO §0.6: única "cripto" permitida ao host).
  public static func randomPassphrase() -> String? {
    var b = [UInt8](repeating: 0, count: 32)
    let st = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
    defer { for i in 0..<b.count { b[i] = 0 } }
    guard st == errSecSuccess else { return nil }
    return Data(b).base64EncodedString()
  }
}

// MARK: - Credenciais do transporte

public struct ChatyyCryptoAuth {
  public let bearer: String
  public let base: String
  public let account: String

  public static func isUsableBase(_ b: String) -> Bool {
    guard let u = URL(string: b), u.scheme == "https", let h = u.host?.lowercased() else { return false }
    return h == "chatyy.com.br" || h.hasSuffix(".chatyy.com.br")
  }

  public static func normBase(_ b: String) -> String {
    var s = b.trimmingCharacters(in: .whitespacesAndNewlines)
    while s.hasSuffix("/") { s.removeLast() }
    return isUsableBase(s) ? s : ChatyyCryptoConst.defaultBase
  }

  public static func normAccount(_ a: String) -> String {
    return a.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  private static func from(_ o: [String: Any]?) -> ChatyyCryptoAuth? {
    guard let o = o, let t = o["t"] as? String, !t.isEmpty else { return nil }
    return ChatyyCryptoAuth(bearer: t, base: normBase(o["b"] as? String ?? ""), account: o["a"] as? String ?? "")
  }

  /// setAuth do JS: vira a credencial "atual" (e a do uid, se já sabido).
  public static func saveCurrent(bearer: String, base: String, account: String) {
    let a = normAccount(account)
    let obj: [String: Any] = ["t": bearer, "b": normBase(base), "a": a]
    ChatyyCryptoKeychain.saveJSON("auth.cur", obj)
    if !a.isEmpty, let uid = ChatyyCryptoFlags.uid(forAccount: a) {
      ChatyyCryptoKeychain.saveJSON("auth.u." + uid, obj)
    }
  }

  /// Depois do `e2ee5_status`: amarra uid ↔ conta/bearer atuais (a NSE resolve pelo uid).
  public static func bind(uid: String) {
    guard let cur = current() else { return }
    ChatyyCryptoKeychain.saveJSON("auth.u." + uid, ["t": cur.bearer, "b": cur.base, "a": cur.account])
  }

  public static func current() -> ChatyyCryptoAuth? {
    return from(ChatyyCryptoKeychain.loadJSON("auth.cur"))
  }

  /// Credencial para um uid: a atual (se for da mesma conta), a gravada para o uid, ou a do
  /// ChatOutbox (mesmo bearer/base que o envio nativo usa) — nessa ordem.
  public static func resolve(uid: String) -> ChatyyCryptoAuth? {
    let mapped = from(ChatyyCryptoKeychain.loadJSON("auth.u." + uid))
    if let c = current() {
      let cuid = ChatyyCryptoFlags.uid(forAccount: c.account)
      let sameAccount = mapped == nil || mapped?.account == c.account
      if sameAccount && (cuid == nil || cuid == uid) { return c }
    }
    guard let m = mapped else { return nil }
    // Conta em 2º plano (multi-conta): o ChatOutbox recebe o bearer novo a cada refresh do JS.
    if !m.account.isEmpty, let ob = outbox(account: m.account) { return ob }
    return m
  }

  /// Item do ChatOutbox (`br.com.chatyy.outbox`, JSON {"t","b"}). Só existe no processo do app.
  public static func outbox(account: String) -> ChatyyCryptoAuth? {
    let a = normAccount(account)
    guard !a.isEmpty, let o = ChatyyCryptoKeychain.loadJSON(a, service: ChatyyCryptoConst.outboxService) else { return nil }
    guard let t = o["t"] as? String, !t.isEmpty else { return nil }
    return ChatyyCryptoAuth(bearer: t, base: normBase(o["b"] as? String ?? ""), account: a)
  }

  public static func forget(uid: String) {
    ChatyyCryptoKeychain.delete("auth.u." + uid)
  }
}

// MARK: - Flags (e2ee5_status.flags.e2ee5_native)

public enum ChatyyCryptoFlags {
  private static var ud: UserDefaults { return UserDefaults(suiteName: ChatyyCryptoConst.appGroup) ?? .standard }

  public static func setNative(uid: String, account: String, enabled: Bool) {
    let d = ud
    d.set(enabled, forKey: "chatyy.e2ee5.native.u." + uid)
    let a = ChatyyCryptoAuth.normAccount(account)
    if !a.isEmpty {
      d.set(enabled, forKey: "chatyy.e2ee5.native.a." + a)
      d.set(uid, forKey: "chatyy.e2ee5.uid.a." + a)
    }
    d.set(uid, forKey: "chatyy.e2ee5.lastUid")
  }

  /// Último valor gravado; ausente = false (nunca liga sozinho — CONTRATO §9).
  public static func native(uid: String) -> Bool {
    return ud.bool(forKey: "chatyy.e2ee5.native.u." + uid)
  }

  public static func nativeForLast() -> Bool {
    guard let u = ud.string(forKey: "chatyy.e2ee5.lastUid"), !u.isEmpty else { return false }
    return native(uid: u)
  }

  public static func uid(forAccount a: String) -> String? {
    let n = ChatyyCryptoAuth.normAccount(a)
    if n.isEmpty { return nil }
    let u = ud.string(forKey: "chatyy.e2ee5.uid.a." + n)
    return (u?.isEmpty ?? true) ? nil : u
  }
}

// MARK: - Store em disco + segredos por uid

public enum ChatyyCryptoStore {
  public static func isValidUid(_ uid: String) -> Bool {
    guard !uid.isEmpty, uid.count <= 18, let f = uid.first, f != "0" else { return false }
    return uid.allSatisfy { $0 >= "0" && $0 <= "9" }
  }

  /// group.com.onemundo.mail/e2ee5 (nil = binário sem App Group: falha fechado, sem store paralelo).
  public static func root() -> URL? {
    guard let c = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ChatyyCryptoConst.appGroup) else { return nil }
    return c.appendingPathComponent("e2ee5", isDirectory: true)
  }

  public static func dir(uid: String) -> URL? {
    return root()?.appendingPathComponent(uid, isDirectory: true)
  }

  /// Cria o diretório, exclui do backup (iCloud/iTunes) e mantém legível com a tela bloqueada
  /// após o 1º desbloqueio (a NSE decifra com o aparelho bloqueado).
  public static func prepare(_ url: URL) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: url, withIntermediateDirectories: true,
                           attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var u = url
    var rv = URLResourceValues()
    rv.isExcludedFromBackup = true
    try? u.setResourceValues(rv)
    if let r = root() {
      var rr = r
      try? rr.setResourceValues(rv)
    }
  }

  public static func exists(uid: String) -> Bool {
    guard let d = dir(uid: uid) else { return false }
    return FileManager.default.fileExists(atPath: d.path)
  }

  /// Apaga store + segredos do uid. Devolve 1 se havia store.
  @discardableResult
  public static func wipe(uid: String) -> Int {
    var n = 0
    if let d = dir(uid: uid), FileManager.default.fileExists(atPath: d.path) {
      try? FileManager.default.removeItem(at: d)
      n = 1
    }
    ChatyyCryptoKeychain.delete("pass." + uid)
    ChatyyCryptoKeychain.delete("dev." + uid)
    return n
  }

  public struct Secrets {
    public let deviceId: String
    public let passphrase: String
    public let created: Bool
  }

  /// device_id + senha do store do uid. Regras (CONTRATO §1.3): reinstalar = aparelho novo.
  /// - store sem senha no Keychain (backup restaurado em outro aparelho) → apaga o store órfão;
  /// - senha no Keychain sem store (o Keychain sobrevive à desinstalação) → aparelho novo.
  /// `makeDeviceId` vem do núcleo (`new_device_id`) — o host não inventa ids.
  public static func secrets(uid: String, makeDeviceId: () throws -> String) throws -> Secrets {
    guard let d = dir(uid: uid) else { throw ChatyyCryptoHostError("store", ["msg": "app_group_unavailable"]) }
    let fm = FileManager.default
    let lp = ChatyyCryptoKeychain.lookup("pass." + uid)
    let ld = ChatyyCryptoKeychain.lookup("dev." + uid)
    for st in [lp.status, ld.status] where st != errSecSuccess && st != errSecItemNotFound {
      throw ChatyyCryptoHostError("store", ["msg": "keychain_unavailable", "status": Int(st)])
    }
    let pass = lp.data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    let dev = ld.data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    let hasStore = fm.fileExists(atPath: d.path)
    if hasStore, !pass.isEmpty, !dev.isEmpty {
      return Secrets(deviceId: dev, passphrase: pass, created: false)
    }
    if hasStore { try? fm.removeItem(at: d) }
    guard let np = ChatyyCryptoKeychain.randomPassphrase() else { throw ChatyyCryptoHostError("store", ["msg": "random_failed"]) }
    let nd = try makeDeviceId()
    guard ChatyyCryptoKeychain.save("dev." + uid, Data(nd.utf8)),
          ChatyyCryptoKeychain.save("pass." + uid, Data(np.utf8)) else {
      throw ChatyyCryptoHostError("store", ["msg": "keychain_write_failed"])
    }
    try prepare(d)
    return Secrets(deviceId: nd, passphrase: np, created: true)
  }
}

// MARK: - JSON

public enum ChatyyCryptoJSON {
  public static func parse(_ s: String) -> [String: Any] {
    guard let d = s.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return [:] }
    return o
  }

  public static func string(_ o: Any) -> String {
    let wrapped: Any = (o is [String: Any] || o is [Any]) ? o : ["v": o]
    guard JSONSerialization.isValidJSONObject(wrapped),
          let d = try? JSONSerialization.data(withJSONObject: wrapped),
          let s = String(data: d, encoding: .utf8) else { return "{}" }
    return s
  }

  public static func str(_ v: Any?) -> String {
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
  }

  public static func u64(_ v: Any?) -> UInt64 {
    if let n = v as? NSNumber { return n.doubleValue <= 0 ? 0 : n.uint64Value }
    if let s = v as? String, let n = UInt64(s) { return n }
    return 0
  }

  public static func strs(_ v: Any?) -> [String] {
    guard let a = v as? [Any] else { return [] }
    return a.map { str($0) }.filter { !$0.isEmpty }
  }

  /// Payload/conteúdo do JS: string JSON (preservada) ou objeto (serializado).
  public static func jsonArg(_ v: Any?) -> String {
    if let s = v as? String { return s }
    if let v = v, JSONSerialization.isValidJSONObject(v), let d = try? JSONSerialization.data(withJSONObject: v),
       let s = String(data: d, encoding: .utf8) { return s }
    return "{}"
  }
}
