// [e2ee5 WP-08a 2026-10-21] Peças E2EE v5 COMPARTILHADAS pelos caminhos nativos iOS
// (CONTRATO e2ee5-contrato/1.2 §2, §6.4, §6.5, §7, §9).
//
// Este arquivo é só Foundation (+ o núcleo quando CHATYY_CRYPTO_CORE): compila no pod
// ExpoChatTransport (app) E pode ser compilado na NSE (WP-10) junto com
// modules/expo-chatyy-crypto/ios/ChatyyCryptoSupport.swift + ChatyyCryptoHost.swift +
// Generated/ChatyyCryptoCore.swift. Na NSE o núcleo está no MESMO módulo (sem import);
// no pod ele vem de `import ExpoChatyyCrypto` (podspec do transporte liga o define).
//
// O que oferece:
//   ChatyyE2EEMsg       — teste de envelope, payload v1 de texto/edição, prévia por tipo,
//                         rótulos genéricos ("Mensagem", "Aguardando esta mensagem…").
//   ChatyyE2EEConvModes — e2ee_mode por conversa no App Group (só ids e 0/1, sem segredo),
//                         lido pela extensão de compartilhar, ações da notificação, Siri e NSE
//                         SEM o núcleo. Gravado pelo app (ChatyyE2EENative.swift).
//   ChatyyE2EECrypto    — (só com o núcleo) decrypt com 1 sync de reforço (regra da NSE §7)
//                         e encrypt; erros viram códigos do §6.11 (sem conteúdo).
//
// NUNCA loga conteúdo, payload, envelope, chave ou bearer (CONTRATO §0.4).
import Foundation
#if CHATYY_CRYPTO_CORE && canImport(ExpoChatyyCrypto)
import ExpoChatyyCrypto
#endif

public enum ChatyyE2EEMsg {
  /// Envelope v5 exatamente como o servidor testa (`strncmp($c, '{"e2e":5', 8)`).
  public static func isEnvelope(_ c: String) -> Bool { return c.hasPrefix("{\"e2e\":5") }

  /// Qualquer `{"e2e":N}` (N≠5 = "Atualize o Chatyy para ler").
  public static func looksEncrypted(_ c: String) -> Bool { return c.hasPrefix("{\"e2e\"") }

  /// `has_link` em claro (§2.5): o cliente calcula.
  public static func hasLink(_ s: String) -> Bool {
    let l = s.lowercased()
    return l.contains("http://") || l.contains("https://") || l.contains("www.")
  }

  static func nowMs() -> Int64 { return Int64(Date().timeIntervalSince1970 * 1000) }

  /// Payload v1 `t:"text"` (ou `t:"edit"` com `editOf`). nil = entrada inválida
  /// (corpo vazio/grande demais, conv/cmid fora do formato do contrato).
  /// - reply: `{mid, cmid?, sender_uid?, quote?, qt?}` (quote ≤ 300 chars).
  public static func textPayload(conv: String, cmid: String, body: String, tsMs: Int64 = 0,
                                 reply: [String: Any]? = nil, editOf: String? = nil, editOfCmid: String? = nil,
                                 effect: String? = nil, mentionAll: Bool = false, fwd: Int = 0) -> String? {
    guard isDecimalId(conv), cmid.count >= 8, cmid.count <= 64 else { return nil }
    if body.isEmpty || body.utf8.count > 16 * 1024 { return nil }
    var p: [String: Any] = ["v": 1, "conv": conv, "cmid": cmid, "ts": NSNumber(value: tsMs > 0 ? tsMs : nowMs()), "body": body]
    if let e = editOf, isDecimalId(e) {
      p["t"] = "edit"
      p["edit_of"] = e
      p["edit_of_cmid"] = editOfCmid ?? ""
    } else {
      p["t"] = "text"
    }
    if let r = reply, isDecimalId(str(r["mid"])) {
      var rr: [String: Any] = ["mid": str(r["mid"])]
      let rc = str(r["cmid"]); if !rc.isEmpty { rr["cmid"] = rc }
      let su = str(r["sender_uid"]); if isDecimalId(su) { rr["sender_uid"] = su }
      let q = str(r["quote"]); if !q.isEmpty { rr["quote"] = String(q.prefix(300)) }
      let qt = str(r["qt"]); rr["qt"] = qt.isEmpty ? "text" : String(qt.prefix(32))
      p["reply"] = rr
    }
    if let e = effect, !e.isEmpty { p["effect"] = String(e.prefix(32)) }
    if mentionAll { p["mention_all"] = true }
    if fwd > 0 { p["fwd"] = ["n": fwd] }
    guard JSONSerialization.isValidJSONObject(p), let d = try? JSONSerialization.data(withJSONObject: p),
          d.count <= 64 * 1024, let s = String(data: d, encoding: .utf8) else { return nil }
    return s
  }

  public static func isDecimalId(_ s: String) -> Bool {
    guard !s.isEmpty, s.count <= 19, let f = s.first, f != "0" else { return false }
    return s.allSatisfy { $0 >= "0" && $0 <= "9" }
  }

  public static func str(_ v: Any?) -> String {
    if v == nil || v is NSNull { return "" }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
  }

  public static func parse(_ s: String) -> [String: Any]? {
    guard let d = s.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
  }

  // MARK: rótulos (sem i18n do JS: a extensão/NSE não têm o bundle de idiomas)

  /// Idioma do app (App Group "chatyy_app_lang", como a ShareExtension) → "pt" | "en" | "es".
  public static func appLang() -> String {
    let a = (UserDefaults(suiteName: ChatyyE2EEConvModes.appGroup)?.string(forKey: "chatyy_app_lang") ?? "").lowercased()
    let l = a.isEmpty ? (Locale.preferredLanguages.first ?? "pt").lowercased() : a
    if l.hasPrefix("en") { return "en" }
    if l.hasPrefix("es") { return "es" }
    return "pt"
  }

  private static func pick(_ lang: String, _ pt: String, _ en: String, _ es: String) -> String {
    let l = lang.lowercased()
    if l.hasPrefix("en") { return en }
    if l.hasPrefix("es") { return es }
    return pt
  }

  /// Prévia genérica (e2ee5.push.new_message) — enquanto não decifrou.
  public static func genericLabel(_ lang: String = appLang()) -> String {
    return pick(lang, "Nova mensagem", "New message", "Nuevo mensaje")
  }

  /// UTD retentável (e2ee5.msg.waiting).
  public static func waitingLabel(_ lang: String = appLang()) -> String {
    return pick(lang, "Aguardando esta mensagem…", "Waiting for this message…", "Esperando este mensaje…")
  }

  /// UTD definitivo (e2ee5.msg.cannot_decrypt).
  public static func cannotDecryptLabel(_ lang: String = appLang()) -> String {
    return pick(lang, "Não foi possível decifrar esta mensagem", "This message couldn't be decrypted", "No se pudo descifrar este mensaje")
  }

  /// {"e2e":N≠5} (e2ee5.msg.update_to_read).
  public static func updateToReadLabel(_ lang: String = appLang()) -> String {
    return pick(lang, "Mensagem protegida. Atualize o Chatyy para ler.", "Protected message. Update Chatyy to read it.",
                "Mensaje protegido. Actualiza Chatyy para leerlo.")
  }

  /// Texto curto de prévia de um payload v1 decifrado (lista, banner da NSE, Siri).
  /// nil = tipo que não deve aparecer (poll_vote, reação F2 no fluxo de mensagem…).
  public static func preview(payloadJson: String, lang: String = appLang()) -> String? {
    guard let p = parse(payloadJson) else { return nil }
    let t = str(p["t"])
    let body = str(p["body"])
    let caption = str(p["caption"])
    switch t {
    case "text", "edit": return body.isEmpty ? nil : body
    case "image": return caption.isEmpty ? pick(lang, "Foto", "Photo", "Foto") : caption
    case "video": return caption.isEmpty ? pick(lang, "Vídeo", "Video", "Video") : caption
    case "gif": return "GIF"
    case "sticker": return pick(lang, "Figurinha", "Sticker", "Sticker")
    case "voice": return pick(lang, "Mensagem de voz", "Voice message", "Mensaje de voz")
    case "audio": return pick(lang, "Áudio", "Audio", "Audio")
    case "file":
      if let m = (p["media"] as? [[String: Any]])?.first, !str(m["name"]).isEmpty { return str(m["name"]) }
      return pick(lang, "Arquivo", "File", "Archivo")
    case "location": return pick(lang, "Localização", "Location", "Ubicación")
    case "contact": return pick(lang, "Contato", "Contact", "Contacto")
    case "poll": let q = str(p["question"]); return q.isEmpty ? pick(lang, "Enquete", "Poll", "Encuesta") : q
    case "meetup": let q = str(p["title"]); return q.isEmpty ? pick(lang, "Encontro", "Meetup", "Encuentro") : q
    case "poll_vote", "reaction": return nil
    default: return genericLabel(lang)
    }
  }
}

// MARK: - e2ee_mode por conversa no App Group (sem o núcleo)

/// Estado conhecido de cada conversa (0/1) por uid. NÃO é segredo (o servidor sabe; só ids).
/// Chaves do WP-03 lidas aqui SEM importar o núcleo (mesmos nomes do ChatyyCryptoFlags):
///   chatyy.e2ee5.native.u.<uid>  (Bool — e2ee5_native gravado pelo status())
///   chatyy.e2ee5.uid.a.<conta>   (uid da conta)
///   chatyy.e2ee5.lastUid         (conta ativa do último status())
public enum ChatyyE2EEConvModes {
  public static let appGroup = "group.com.onemundo.mail"
  static let maxEntries = 3000
  private static let lock = NSLock()

  private static var ud: UserDefaults? { return UserDefaults(suiteName: appGroup) }

  static func normAccount(_ a: String) -> String { return a.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

  /// A conta e o alias (onemundo ≡ chatyy, CONTRATO §1.1).
  public static func accountVariants(_ a: String) -> [String] {
    let n = normAccount(a)
    if n.isEmpty { return [] }
    if n.hasSuffix("@onemundo.com.br") { return [n, String(n.dropLast(16)) + "@chatyy.com.br"] }
    if n.hasSuffix("@chatyy.com.br") { return [n, String(n.dropLast(14)) + "@onemundo.com.br"] }
    return [n]
  }

  public static func uid(account: String) -> String? {
    guard let d = ud else { return nil }
    for v in accountVariants(account) {
      if let u = d.string(forKey: "chatyy.e2ee5.uid.a." + v), ChatyyE2EEMsg.isDecimalId(u) { return u }
    }
    return nil
  }

  public static func lastUid() -> String? {
    let u = ud?.string(forKey: "chatyy.e2ee5.lastUid") ?? ""
    return ChatyyE2EEMsg.isDecimalId(u) ? u : nil
  }

  /// `e2ee5_native` do último status() (ausente = false: nunca liga sozinho, §9).
  public static func nativeOn(uid: String) -> Bool {
    return ud?.bool(forKey: "chatyy.e2ee5.native.u." + uid) ?? false
  }

  /// uid da conta SE o caminho nativo E2EE vale para ela: `e2ee5_native` ligado PARA ESTA conta.
  /// Vale para qualquer conta logada (multi-conta): desde o WP-03 8606f73a `core(uid:)` não troca
  /// a conta "atual" do JS (makeCurrent=false).
  public static func nativeUid(account: String) -> String? {
    guard let u = uid(account: account), nativeOn(uid: u) else { return nil }
    return u
  }

  /// Variante restrita à conta ativa do último status() (mantida para quem já a usa).
  public static func activeUid(account: String) -> String? {
    guard let u = uid(account: account), nativeOn(uid: u), lastUid() == u else { return nil }
    return u
  }

  private static func key(_ uid: String) -> String { return "chatyy.e2ee5.convmode.u." + uid }

  /// 1 = E2EE, 0 = normal, nil = não sabido.
  public static func mode(uid: String, conv: String) -> Int? {
    guard let m = ud?.dictionary(forKey: key(uid)), let v = m[conv] as? NSNumber else { return nil }
    return v.intValue == 1 ? 1 : 0
  }

  public static func mode(account: String, conv: String) -> Int? {
    guard let u = uid(account: account) else { return nil }
    return mode(uid: u, conv: conv)
  }

  public static func set(uid: String, conv: String, mode: Int) {
    guard ChatyyE2EEMsg.isDecimalId(uid), ChatyyE2EEMsg.isDecimalId(conv), let d = ud else { return }
    lock.lock(); defer { lock.unlock() }
    var m = d.dictionary(forKey: key(uid)) ?? [:]
    let nv = mode == 1 ? 1 : 0
    if (m[conv] as? NSNumber)?.intValue == nv { return }
    if m.count >= maxEntries && m[conv] == nil {
      // poda: mantém as conversas E2EE e descarta "0" (o servidor recusa texto puro de qualquer jeito)
      m = m.filter { ($0.value as? NSNumber)?.intValue == 1 }
      if m.count >= maxEntries { m.removeAll() }
    }
    m[conv] = NSNumber(value: nv)
    d.set(m, forKey: key(uid))
  }

  public static func forget(uid: String) {
    ud?.removeObject(forKey: key(uid))
  }
}

// MARK: - Núcleo (só com o xcframework)

#if CHATYY_CRYPTO_CORE

/// Resultado de decifragem sem conteúdo nos casos de erro.
public enum ChatyyE2EEDecryptOutcome {
  case ok(payloadJson: String, senderDeviceId: String, trust: String, sessionId: String)
  /// UTD (§6.5): `retryable` = vale tentar de novo após `sync()`/chave nova.
  case utd(reason: String, retryable: Bool, sessionId: String)
  /// Núcleo indisponível (flag, store, Keychain, LockBusy…): código do §6.11.
  case unavailable(code: String)
}

public enum ChatyyE2EECrypto {
  /// (ChatyyCrypto.trustStr é interno ao módulo do WP-03.)
  static func trustStr(_ t: Trust) -> String {
    switch t {
    case .verified: return "verified"
    case .tofu: return "tofu"
    case .changed: return "changed"
    }
  }

  /// Decifra 1 envelope. Regra da NSE (§7): `missing_session`/`unknown_index` ⇒ 1 `sync()`
  /// (o host da NSE já tem timeout de 5 s) e tenta de novo; senão devolve o UTD.
  /// API para a NSE (WP-10): `decrypt(uid:conv:envelope:senderUid:mid:cmid:tsMs:syncOnMissing: true)`.
  public static func decrypt(uid: String, conv: String, envelope: String, senderUid: String, mid: String,
                             cmid: String, tsMs: Int64, syncOnMissing: Bool) async -> ChatyyE2EEDecryptOutcome {
    if !ChatyyE2EEMsg.isEnvelope(envelope) { return .utd(reason: "bad_envelope", retryable: false, sessionId: "") }
    if !ChatyyE2EEMsg.isDecimalId(senderUid) { return .utd(reason: "sender_mismatch", retryable: false, sessionId: "") }
    var synced = false
    while true {
      do {
        let core = try await ChatyyCrypto.shared.core(uid: uid)
        let r = try await core.decrypt(input: DecryptInput(convId: conv, envelopeJson: envelope, senderUid: senderUid,
                                                            serverMid: mid, cmid: cmid, tsMs: UInt64(max(0, tsMs))))
        return .ok(payloadJson: r.payloadJson, senderDeviceId: r.senderDeviceId, trust: trustStr(r.trust), sessionId: r.sessionId)
      } catch {
        let (code, details) = ChatyyCrypto.describe(error)
        if code == "utd" {
          let reason = details["reason"] as? String ?? "corrupted"
          let retry = details["retryable"] as? Bool ?? false
          let sid = details["session_id"] as? String ?? ""
          if syncOnMissing && !synced && (reason == "missing_session" || reason == "unknown_index") {
            synced = true
            _ = try? await ChatyyCrypto.shared.sync(uid: uid, source: "native")
            continue
          }
          return .utd(reason: reason, retryable: retry, sessionId: sid)
        }
        return .unavailable(code: code)
      }
    }
  }

  /// Cifra um payload v1 para os membros atuais (o próprio uid entra sempre — §6.4).
  /// Erros: `ChatyyCryptoHostError`/`CoreError` do núcleo (use `ChatyyCrypto.describe`).
  public static func encrypt(uid: String, conv: String, memberUids: [String], payloadJson: String) async throws -> String {
    var members = memberUids.filter { ChatyyE2EEMsg.isDecimalId($0) }
    if !members.contains(uid) { members.append(uid) }
    let core = try await ChatyyCrypto.shared.core(uid: uid)
    let r = try await core.encrypt(convId: conv, memberUids: members, payloadJson: payloadJson)
    return r.envelopeJson
  }

  /// `chatyy.decrypt_report` (§3) ao remetente: o aparelho dele recompartilha a chave.
  public static func decryptReport(uid: String, senderUid: String, conv: String, mid: String, sessionId: String, reason: String) async {
    guard ChatyyE2EEMsg.isDecimalId(senderUid), senderUid != uid else { return }
    let content: [String: Any] = ["v": 1, "conv_id": conv, "mid": mid, "session_id": sessionId, "reason": reason,
                                  "ts": NSNumber(value: ChatyyE2EEMsg.nowMs())]
    guard let d = try? JSONSerialization.data(withJSONObject: content), let s = String(data: d, encoding: .utf8) else { return }
    do {
      let core = try await ChatyyCrypto.shared.core(uid: uid)
      _ = try await core.sendToDevice(eventType: "chatyy.decrypt_report", targets: [DeviceTarget(uid: senderUid, deviceId: "")], contentJson: s)
    } catch {}
  }
}

#endif
