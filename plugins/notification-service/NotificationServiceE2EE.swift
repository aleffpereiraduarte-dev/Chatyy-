// [e2ee5 WP-10 2026-10-21] Prévia decifrada na NSE (CONTRATO §7). Fonte da verdade: este arquivo;
// o plugins/with-notification-service.js o ANEXA ao NotificationService.swift da extensão (não é
// um alvo/arquivo separado no Xcode → nada a mudar no pbxproj para o gancho existir).
//
// Regras (falha FECHADO em tudo — qualquer dúvida = "Nova mensagem" do servidor):
//   - só com o núcleo no binário (CHATYY_CRYPTO_CORE, mesmo gate do podspec do WP-03);
//   - flag `e2ee5_push_decrypt` da conta gravada no App Group pelo app
//     (`chatyy.e2ee5.push_decrypt.u.<uid>`; ausente = desligado) e `e2ee5_native` (WP-03);
//   - conversa trancada (`locked=1`, o servidor nem manda o envelope) → nunca;
//   - prévia oculta (por conversa ou "nunca"): o servidor marca `e2e_np` — só "0" explícito
//     libera; ausente (servidor antigo) = oculta;
//   - sem App Group / sem store / Keychain indisponível (antes do 1º desbloqueio) → não abre
//     e NUNCA cria store/aparelho novo a partir da NSE;
//   - o texto decifrado só vive em memória e no conteúdo da notificação entregue ao iOS:
//     nada de journal, cache, UserDefaults, log ou doação do Intent com o texto.
//   - teto de tempo: `deadline` (a NSE entrega o genérico se estourar).
// Métricas só com códigos e milissegundos (App Group `chatyy.e2ee5.nse.*`), nunca conteúdo.
import Foundation

/// [e2ee5 WP-10b 2026-10-22] Genérico de push cifrado que não decifrou (vale com e sem o núcleo).
enum ChatyyNSEGeneric {
  static func newMessage(_ lang: String?) -> String {
    let l = (lang ?? Locale.preferredLanguages.first ?? "pt").lowercased()
    if l.hasPrefix("en") { return "New message" }
    if l.hasPrefix("es") { return "Nuevo mensaje" }
    return "Nova mensagem"
  }

  /// Corpo que não pode ir para a tela: vazio, reticências, ou só pontuação/espaços.
  static func isPlaceholder(_ s: String) -> Bool {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty { return true }
    return t.unicodeScalars.allSatisfy { CharacterSet.punctuationCharacters.contains($0) || CharacterSet.whitespaces.contains($0) }
  }
}

#if CHATYY_CRYPTO_CORE
import Security

enum ChatyyNSEE2EE {
  /// Teto total (abrir store + buscar envelope + decifrar + 1 sync). A NSE espera até aqui.
  static let deadline: TimeInterval = 4.5
  private static let fetchTimeout: TimeInterval = 2.5
  private static let pushTypes: Set<String> = ["chat_message", "chat_mention", "chat_reaction"]
  private static let flagPrefix = "chatyy.e2ee5.push_decrypt.u."
  private static let killKey = "chatyy.e2ee5.push_decrypt.kill"

  private static func s(_ p: [String: Any], _ k: String) -> String {
    if let v = p[k] as? String { return v }
    if let n = p[k] as? NSNumber { return n.stringValue }
    return ""
  }

  private static func isDec(_ v: String) -> Bool {
    guard !v.isEmpty, v.count <= 19, v.first != "0" else { return false }
    return v.allSatisfy { $0 >= "0" && $0 <= "9" }
  }

  private static var ud: UserDefaults? { return UserDefaults(suiteName: ChatyyCryptoConst.appGroup) }

  /// uid do destinatário se ESTE push pode ser decifrado aqui (sem rede); nil = genérico.
  static func candidateUid(_ p: [String: Any], type: String) -> String? {
    guard s(p, "e2e") == "5", pushTypes.contains(type) else { return nil }
    guard s(p, "locked") != "1", s(p, "e2e_np") == "0" else { return nil }
    guard isDec(conv(p)), isDec(s(p, "e2e_mid")), ChatyyCryptoStore.isValidUid(s(p, "e2e_sender_uid")) else { return nil }
    let env = s(p, "e2e_c")
    guard env.hasPrefix("{\"e2e\":5") || s(p, "e2e_fetch") == "1" else { return nil }
    guard ChatyyCryptoStore.root() != nil, let d = ud else { return nil }
    let acct = ChatyyCryptoAuth.normAccount(s(p, "recipient_email"))
    let uid: String
    if !acct.isEmpty {
      guard let u = ChatyyCryptoFlags.uid(forAccount: acct) else { return nil }
      uid = u
    } else {
      guard let u = d.string(forKey: "chatyy.e2ee5.lastUid"), !u.isEmpty else { return nil }
      uid = u
    }
    guard ChatyyCryptoStore.isValidUid(uid), !d.bool(forKey: killKey), d.bool(forKey: flagPrefix + uid),
          ChatyyCryptoFlags.native(uid: uid), ChatyyCryptoStore.exists(uid: uid) else { return nil }
    // Só abre um store que já existe com os DOIS segredos legíveis agora: `secrets()` do host criaria
    // aparelho novo (ou apagaria o store órfão) — isso é coisa do app, nunca da NSE.
    guard ChatyyCryptoKeychain.lookup("pass." + uid).status == errSecSuccess,
          ChatyyCryptoKeychain.lookup("dev." + uid).status == errSecSuccess else { return nil }
    return uid
  }

  private static func conv(_ p: [String: Any]) -> String {
    let c = s(p, "e2e_conv")
    return c.isEmpty ? s(p, "conversation_id") : c
  }

  /// Decifra e devolve o texto da prévia (ou nil). `completion` roda 1 vez, em thread qualquer.
  static func preview(_ p: [String: Any], uid: String, completion: @escaping (String?) -> Void) {
    let cid = conv(p), mid = s(p, "e2e_mid"), sender = s(p, "e2e_sender_uid"), cmid = s(p, "e2e_cmid")
    let inline = s(p, "e2e_c")
    let t0 = Date()
    Task.detached(priority: .userInitiated) {
      var text: String? = nil
      var outcome = "ok"
      do {
        let env: String
        if inline.hasPrefix("{\"e2e\":5") {
          env = inline
        } else {
          env = try await fetchEnvelope(uid: uid, conv: cid, mid: mid)
        }
        let input = DecryptInput(convId: cid, envelopeJson: env, senderUid: sender, serverMid: mid, cmid: cmid, tsMs: 0)
        let core = try await ChatyyCrypto.shared.core(uid: uid)
        let dec: Decrypted
        do {
          dec = try await core.decrypt(input: input)
        } catch let CoreError.Utd(reason, _) where retryable(reason) {
          // §7: chave ainda não chegou → 1 sync curto (timeout 5 s do papel Push) e tenta de novo.
          outcome = "ok_after_sync"
          _ = try await ChatyyCrypto.shared.sync(uid: uid, source: "native")
          dec = try await core.decrypt(input: input)
        }
        text = render(dec.payloadJson)
        if text == nil { outcome = "no_preview_type" }
      } catch {
        let d = ChatyyCrypto.describe(error)
        let r = d.details["reason"] as? String
        outcome = r.map { d.code + ":" + $0 } ?? d.code
        text = nil
      }
      record(outcome, ms: Int(Date().timeIntervalSince(t0) * 1000))
      completion(text)
    }
  }

  private static func retryable(_ r: UtdReason) -> Bool {
    switch r {
    case .missingSession, .unknownIndex, .untrustedDevice: return true
    default: return false
    }
  }

  // MARK: e2e_fetch → busca a mensagem pelo mid (HTTP curto, Bearer do app)

  private static func fetchEnvelope(uid: String, conv: String, mid: String) async throws -> String {
    guard let auth = ChatyyCryptoAuth.resolve(uid: uid),
          let url = URL(string: auth.base + "/api/email.php?action=chat_load_around") else {
      throw ChatyyCryptoHostError("not_open", ["why": "no_auth"])
    }
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = fetchTimeout
    cfg.timeoutIntervalForResource = fetchTimeout + 0.5
    cfg.httpCookieStorage = nil
    cfg.httpShouldSetCookies = false
    cfg.urlCache = nil
    cfg.waitsForConnectivity = false
    let session = URLSession(configuration: cfg)
    defer { session.finishTasksAndInvalidate() }
    let body: [String: Any] = ["conversation_id": Int64(conv) ?? 0, "message_id": Int64(mid) ?? 0, "before": 1, "after": 0]
    var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: fetchTimeout)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.setValue("Bearer " + auth.bearer, forHTTPHeaderField: "Authorization")
    req.httpBody = try JSONSerialization.data(withJSONObject: body)
    // 2 tentativas: a réplica regional pode ainda não ter a linha (alguns 100 ms de atraso).
    for attempt in 0..<2 {
      if attempt > 0 { try await Task.sleep(nanoseconds: 450_000_000) }
      let (data, resp) = try await session.data(for: req)
      let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
      guard (200..<300).contains(code) else { throw ChatyyCryptoHostError("server", ["status": code]) }
      if let env = envelope(in: data, mid: mid) { return env }
    }
    throw ChatyyCryptoHostError("server", ["server_code": "message_not_found"])
  }

  private static func envelope(in data: Data, mid: String) -> String? {
    guard let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], (j["success"] as? Bool) == true,
          let d = j["data"] as? [String: Any], let msgs = d["messages"] as? [[String: Any]] else { return nil }
    for m in msgs where s(m, "id") == mid {
      let c = s(m, "content")
      return c.hasPrefix("{\"e2e\":5") ? c : nil
    }
    return nil
  }

  // MARK: payload v1 → texto da prévia (CONTRATO §2.3/§2.4)

  static func render(_ payloadJson: String) -> String? {
    guard let d = payloadJson.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
    let v = (o["v"] as? NSNumber)?.intValue ?? 0
    guard v == 1 else { return nil }
    let t = o["t"] as? String ?? ""
    let media = o["media"] as? [[String: Any]] ?? []
    let first = media.first ?? [:]
    let viewOnce = (o["vo"] as? Bool) == true
    func str(_ k: String, _ from: [String: Any]? = nil) -> String {
      let src = from ?? o
      return (src[k] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
    func orLabel(_ s: String, _ key: String) -> String { return s.isEmpty ? L(key) : s }
    var out: String
    switch t {
    case "text", "edit":
      out = str("body")
    case "image":
      if viewOnce { out = L("vo_photo") }
      else if media.count > 1 { out = str("caption").isEmpty ? String(format: L("photos_n"), media.count) : str("caption") }
      else { out = orLabel(str("caption"), "photo") }
    case "video":
      if viewOnce { out = L("vo_video") }
      else { out = orLabel(str("caption"), (o["round"] as? Bool) == true ? "video_note" : "video") }
    case "gif": out = L("gif")
    case "sticker": out = L("sticker")
    case "voice":
      out = L("voice")
      if let dur = (first["dur"] as? NSNumber)?.doubleValue, dur > 0 {
        let sec = Int(dur.rounded())
        out += String(format: " (%d:%02d)", sec / 60, sec % 60)
      }
    case "audio":
      let tt = str("title", first).isEmpty ? str("title") : str("title", first)
      out = orLabel(tt, "audio")
    case "file":
      let n = str("name", first).isEmpty ? str("name") : str("name", first)
      out = n.isEmpty ? L("file") : n
    case "location":
      out = o["live"] != nil ? L("live_location") : orLabel(str("name"), "location")
    case "contact":
      let c = (o["contacts"] as? [[String: Any]])?.first
      let n = c.map { str("name", $0) } ?? ""
      out = n.isEmpty ? L("contact") : L("contact") + ": " + n
    case "poll":
      out = str("question").isEmpty ? L("poll") : L("poll") + ": " + str("question")
    case "meetup":
      out = str("title").isEmpty ? L("meetup") : L("meetup") + ": " + str("title")
    case "reaction":
      let e = str("emoji")
      out = e.isEmpty ? L("reacted") : String(format: L("reacted_with"), e)
    default:
      return nil // poll_vote e tipos desconhecidos: fica o genérico
    }
    let clean = out.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
    return clean.isEmpty ? nil : String(clean.prefix(300))
  }

  private static let strings: [String: [String: String]] = [
    "pt": ["photo": "Foto", "photos_n": "%d fotos", "vo_photo": "Foto de visualização única", "video": "Vídeo",
           "vo_video": "Vídeo de visualização única", "video_note": "Vídeo-recado", "gif": "GIF", "sticker": "Figurinha",
           "voice": "Mensagem de voz", "audio": "Áudio", "file": "Arquivo", "location": "Localização",
           "live_location": "Localização em tempo real", "contact": "Contato", "poll": "Enquete", "meetup": "Encontro",
           "reacted": "Reagiu à sua mensagem", "reacted_with": "Reagiu com %@ à sua mensagem"],
    "en": ["photo": "Photo", "photos_n": "%d photos", "vo_photo": "View once photo", "video": "Video",
           "vo_video": "View once video", "video_note": "Video message", "gif": "GIF", "sticker": "Sticker",
           "voice": "Voice message", "audio": "Audio", "file": "File", "location": "Location",
           "live_location": "Live location", "contact": "Contact", "poll": "Poll", "meetup": "Event",
           "reacted": "Reacted to your message", "reacted_with": "Reacted %@ to your message"],
    "es": ["photo": "Foto", "photos_n": "%d fotos", "vo_photo": "Foto de visualización única", "video": "Video",
           "vo_video": "Video de visualización única", "video_note": "Videomensaje", "gif": "GIF", "sticker": "Sticker",
           "voice": "Mensaje de voz", "audio": "Audio", "file": "Archivo", "location": "Ubicación",
           "live_location": "Ubicación en tiempo real", "contact": "Contacto", "poll": "Encuesta", "meetup": "Evento",
           "reacted": "Reaccionó a tu mensaje", "reacted_with": "Reaccionó con %@ a tu mensaje"],
  ]

  private static let lang: String = {
    let l = (Locale.preferredLanguages.first ?? "pt").lowercased()
    if l.hasPrefix("en") { return "en" }
    if l.hasPrefix("es") { return "es" }
    return "pt"
  }()

  private static func L(_ k: String) -> String {
    return strings[lang]?[k] ?? strings["pt"]?[k] ?? k
  }

  // MARK: métricas (só código + ms; o app lê/zera — WP-18)

  private static let metricsLock = NSLock()

  private static func record(_ outcome: String, ms: Int) {
    guard let d = ud else { return }
    metricsLock.lock(); defer { metricsLock.unlock() }
    var counts = d.dictionary(forKey: "chatyy.e2ee5.nse.counts") as? [String: Int] ?? [:]
    let key = String(outcome.prefix(40))
    counts[key] = (counts[key] ?? 0) + 1
    if counts.count <= 40 { d.set(counts, forKey: "chatyy.e2ee5.nse.counts") }
    var lat = d.array(forKey: "chatyy.e2ee5.nse.ms") as? [Int] ?? []
    lat.append(ms)
    if lat.count > 100 { lat.removeFirst(lat.count - 100) }
    d.set(lat, forKey: "chatyy.e2ee5.nse.ms")
  }
}

#else

/// Binário sem o núcleo (build normal): a NSE se comporta exatamente como antes.
enum ChatyyNSEE2EE {
  static let deadline: TimeInterval = 0
  static func candidateUid(_ p: [String: Any], type: String) -> String? { return nil }
  static func preview(_ p: [String: Any], uid: String, completion: @escaping (String?) -> Void) { completion(nil) }
}

#endif
