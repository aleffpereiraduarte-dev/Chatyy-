// [e2ee5 WP-08a 2026-10-21] E2EE v5 nos caminhos NATIVOS do app iOS que enviam/recebem sem JS
// (CONTRATO e2ee5-contrato/1.2 §2, §4.2.19, §5.3–5.4, §6.4–6.5, §8.4, §9).
//
//   ChatyyE2EEGate      — núcleo no binário + `e2ee5_native` gravado pelo status() + conta ATIVA.
//                         Fora disso: nil → todo caminho abaixo devolve "passa" = comportamento de hoje.
//   ChatyyE2EEConvCache — e2ee_mode + membros (uids) por conversa (e2ee5_conversation_state,
//                         WS conv_e2ee, recusas do servidor). Modo espelhado no App Group.
//   ChatyyE2EEOutbox    — ChatOutbox cifra ANTES de persistir: a tabela `outbox` só vê o envelope.
//   ChatyyE2EEIngest    — frames do hub com envelope → decifra → tabela `e2e_plain` do store
//                         (messages.raw continua só com o envelope); UTD retentável = "wait" e
//                         nova tentativa quando o núcleo avisa chave nova (onNewKeys).
//   ChatyyE2EEBridge    — envio cifrado para quem não pode importar este pod (ações da
//                         notificação no expo-native-toolkit, Siri no alvo do app) via
//                         NotificationCenter (sem dependência de compilação entre pods).
//
// NUNCA loga conteúdo, payload, envelope, bearer ou chave (CONTRATO §0.4).
import Foundation
import ExpoChatStore
#if CHATYY_CRYPTO_CORE && canImport(ExpoChatyyCrypto)
import ExpoChatyyCrypto
#endif

// MARK: - Portão

enum ChatyyE2EEGate {
  static var coreLinked: Bool {
    #if CHATYY_CRYPTO_CORE
    return true
    #else
    return false
    #endif
  }

  /// uid da conta se o caminho nativo E2EE vale agora para ela (senão nil = caminho de hoje).
  static func uid(account: String) -> String? {
    #if CHATYY_CRYPTO_CORE
    return ChatyyE2EEConvModes.activeUid(account: account)
    #else
    return nil
    #endif
  }

  static func nowMs() -> Int64 { return Int64(Date().timeIntervalSince1970 * 1000) }
}

/// Caixa para resultado vindo de outra Task (Swift 5: não dá para mutar `var` capturada).
final class ChatyyE2EEBox<T>: @unchecked Sendable {
  private let lock = NSLock()
  private var v: T?
  func set(_ x: T) { lock.lock(); v = x; lock.unlock() }
  func get() -> T? { lock.lock(); defer { lock.unlock() }; return v }
}

// MARK: - Estado das conversas

final class ChatyyE2EEConvCache {
  static let shared = ChatyyE2EEConvCache()

  struct Entry {
    var mode: Int
    var members: [String]
    var sincePts: Int64
    var at: Int64
    var membersAt: Int64
  }

  /// Membros "frescos" para cifrar (quem saiu não pode receber a chave seguinte).
  static let membersFreshMs: Int64 = 60_000
  /// Sem rede: membros até este limite ainda servem (a imposição/rotação do núcleo cobre o resto).
  static let membersMaxMs: Int64 = 10 * 60_000
  /// Conversa normal: revalida a cada minuto (a ativação automática pode acontecer a qualquer hora).
  static let mode0FreshMs: Int64 = 60_000

  private let lock = NSLock()
  private var map: [String: Entry] = [:]

  private func k(_ uid: String, _ conv: String) -> String { return uid + "|" + conv }

  func get(uid: String, conv: String) -> Entry? {
    lock.lock(); defer { lock.unlock() }
    return map[k(uid, conv)]
  }

  /// Modo conhecido SEM rede (memória → App Group). nil = não sabido.
  func knownMode(uid: String, conv: String) -> Int? {
    if let e = get(uid: uid, conv: conv) { return e.mode }
    return ChatyyE2EEConvModes.mode(uid: uid, conv: conv)
  }

  /// Só o modo (WS `conv_e2ee`, recusa do servidor, JS): força buscar os membros de novo.
  func noteMode(uid: String, conv: String, mode: Int) {
    guard ChatyyE2EEMsg.isDecimalId(conv) else { return }
    let m = mode == 1 ? 1 : 0
    lock.lock()
    var e = map[k(uid, conv)] ?? Entry(mode: m, members: [], sincePts: 0, at: 0, membersAt: 0)
    e.mode = m
    e.at = ChatyyE2EEGate.nowMs()
    e.membersAt = 0
    map[k(uid, conv)] = e
    lock.unlock()
    ChatyyE2EEConvModes.set(uid: uid, conv: conv, mode: m)
  }

  private func put(uid: String, conv: String, _ e: Entry) {
    lock.lock()
    if map.count > 4000 { map.removeAll() }
    map[k(uid, conv)] = e
    lock.unlock()
    ChatyyE2EEConvModes.set(uid: uid, conv: conv, mode: e.mode)
  }

  #if CHATYY_CRYPTO_CORE
  private static let http: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 6
    c.timeoutIntervalForResource = 10
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    c.urlCache = nil
    c.httpCookieStorage = nil
    c.httpShouldSetCookies = false
    return URLSession(configuration: c)
  }()

  /// `e2ee5_conversation_state` (§4.2.19). nil = sem rede/sem credencial/erro do servidor.
  func fetch(uid: String, conv: String, timeout: TimeInterval = 4) async -> Entry? {
    guard ChatyyE2EEMsg.isDecimalId(conv), let auth = ChatyyCryptoAuth.resolve(uid: uid),
          let url = URL(string: auth.base + "/api/email.php?action=e2ee5_conversation_state") else { return nil }
    var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.setValue("Bearer " + auth.bearer, forHTTPHeaderField: "Authorization")
    req.httpBody = Data("{\"conv_id\":\"\(conv)\"}".utf8)
    guard let res = try? await Self.http.data(for: req) else { return nil }
    let data = res.0
    let code = (res.1 as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(code), let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          (j["success"] as? Bool) == true, let d = j["data"] as? [String: Any] else { return nil }
    let mode = (d["e2ee_mode"] as? NSNumber)?.intValue == 1 ? 1 : 0
    var members: [String] = []
    for x in (d["members"] as? [[String: Any]]) ?? [] {
      let u = ChatyyE2EEMsg.str(x["uid"])
      if ChatyyE2EEMsg.isDecimalId(u) && !members.contains(u) { members.append(u) }
    }
    let now = ChatyyE2EEGate.nowMs()
    let e = Entry(mode: mode, members: members, sincePts: (d["since_pts"] as? NSNumber)?.int64Value ?? 0, at: now, membersAt: now)
    put(uid: uid, conv: conv, e)
    return e
  }

  /// Estado bom o bastante para decidir (`needMembers` = para cifrar). nil = não dá para saber.
  func state(uid: String, conv: String, needMembers: Bool) async -> Entry? {
    let now = ChatyyE2EEGate.nowMs()
    if let e = get(uid: uid, conv: conv) {
      if e.mode == 0 && now - e.at < Self.mode0FreshMs { return e }
      if e.mode == 1 && (!needMembers || (!e.members.isEmpty && now - e.membersAt < Self.membersFreshMs)) { return e }
    }
    if let f = await fetch(uid: uid, conv: conv) { return f }
    // sem rede: o que já sabíamos
    if let e = get(uid: uid, conv: conv) {
      if e.mode == 0 || !needMembers { return e }
      if !e.members.isEmpty && now - e.membersAt < Self.membersMaxMs { return e }
      return nil
    }
    if let m = ChatyyE2EEConvModes.mode(uid: uid, conv: conv), m == 0 || !needMembers {
      return Entry(mode: m, members: [], sincePts: 0, at: 0, membersAt: 0)
    }
    return nil
  }
  #endif
}

// MARK: - Fila de envio nativa (ChatOutbox)

enum ChatyyE2EEOutbox {
  enum Prep {
    case pass
    case replace([String: Any])
    /// Não entra na fila nativa (o JS segue o caminho dele) — motivo sem conteúdo.
    case reject(String)
  }

  enum Reenc {
    case ok([String: Any])     // patch do store (body/frame)
    case retry(String)
    case fail(String)
  }

  /// Campos que podem ir EM CLARO junto do envelope (§2.5). O resto (citação, efeito, prévia
  /// de link, tradução…) vai dentro do payload ou some.
  static let bodyKeys: Set<String> = ["conversation_id", "client_message_id", "type", "content", "reply_to_id", "mentions",
                                      "mention_all", "silent", "is_silent", "sealed", "topic_id", "temp_id", "edit_of", "has_link"]
  static let frameKeys: Set<String> = ["type", "conversation_id", "client_message_id", "msg_type", "content", "reply_to_id",
                                       "mentions", "mention_all", "silent", "sealed", "topic_id", "edit_of", "has_link", "req_id"]
  /// Códigos que se curam sozinhos (rede, trava entre processos, estado ainda desconhecido).
  static let retryCodes: Set<String> = ["transport", "lock_busy", "server", "store", "not_open", "e2ee5_state_unknown",
                                        "e2ee5_members_unknown", "e2ee5_timeout", "internal"]

  private static let lock = NSLock()
  /// cmi → payload que acabou de ser cifrado (vira e2e_plain da própria mensagem no ✓ do servidor).
  private static var plain: [String: (conv: String, payload: String, at: Int64)] = [:]

  static func obj(_ v: Any?) -> [String: Any] { return ChatyyOutboxUtil.obj(v) }
  static func str(_ v: Any?) -> String { return ChatyyOutboxUtil.str(v) }

  static func content(_ item: [String: Any]) -> String { return str(obj(item["body"])["content"]) }

  /// Barato e síncrono: este item precisa passar pelo núcleo? (flag desligada = false = hoje).
  static func mayNeedWork(account: String, item: [String: Any]) -> Bool {
    guard ChatyyE2EEGate.uid(account: account) != nil, ChatyyE2EEMsg.isDecimalId(str(item["conv"])) else { return false }
    return !ChatyyE2EEMsg.looksEncrypted(content(item))
  }

  /// Linha já na fila com texto puro numa conversa que AGORA sabemos ser E2EE (ativou depois do
  /// submit, ou recusa do servidor) → recifrar antes de qualquer envio.
  static func needsReencrypt(account: String, row: [String: Any]) -> Bool {
    guard let uid = ChatyyE2EEGate.uid(account: account) else { return false }
    let conv = str(row["conv"])
    guard ChatyyE2EEConvCache.shared.knownMode(uid: uid, conv: conv) == 1 else { return false }
    return !ChatyyE2EEMsg.looksEncrypted(content(row))
  }

  static func takePlain(_ cmi: String) -> (conv: String, payload: String)? {
    lock.lock(); defer { lock.unlock() }
    guard let p = plain.removeValue(forKey: cmi) else { return nil }
    return (p.conv, p.payload)
  }

  static func dropPlain(_ cmi: String) {
    lock.lock(); plain.removeValue(forKey: cmi); lock.unlock()
  }

  private static func remember(_ cmi: String, _ conv: String, _ payload: String) {
    lock.lock()
    let now = ChatyyE2EEGate.nowMs()
    if plain.count > 200 { plain = plain.filter { now - $0.value.at < 3_600_000 } }
    plain[cmi] = (conv, payload, now)
    lock.unlock()
  }

  /// Bloqueante (fora da main) para o `submit` síncrono (ShareOutbox / ponte).
  static func prepareBlocking(account: String, item: [String: Any], timeout: Double) -> Prep {
    #if CHATYY_CRYPTO_CORE
    if Thread.isMainThread { return .reject("e2ee5_main_thread") }
    let box = ChatyyE2EEBox<Prep>()
    let sem = DispatchSemaphore(value: 0)
    Task.detached {
      box.set(await prepare(account: account, item: item))
      sem.signal()
    }
    if sem.wait(timeout: .now() + timeout) == .timedOut { return .reject("e2ee5_timeout") }
    return box.get() ?? .reject("e2ee5_timeout")
    #else
    return .pass
    #endif
  }

  #if CHATYY_CRYPTO_CORE
  /// Decide e, se a conversa é E2EE, cifra. Texto puro só sai daqui para conversa `e2ee_mode=0`.
  static func prepare(account: String, item: [String: Any]) async -> Prep {
    guard let uid = ChatyyE2EEGate.uid(account: account) else { return .pass }
    let conv = str(item["conv"])
    if ChatyyE2EEMsg.looksEncrypted(content(item)) { return .pass }
    guard let st = await ChatyyE2EEConvCache.shared.state(uid: uid, conv: conv, needMembers: false) else {
      return .reject("e2ee5_state_unknown")
    }
    if st.mode != 1 { return .pass }
    return await encryptItem(uid: uid, item: item)
  }

  /// item {cmi, conv, kind, body, frame?} → mesmo item com o envelope no lugar do texto.
  static func encryptItem(uid: String, item: [String: Any]) async -> Prep {
    let conv = str(item["conv"]), cmi = str(item["cmi"])
    if str(item["kind"]) == "media" { return .reject("e2ee5_media_needs_app") } // mídia cifrada = F3 (WP-11)
    let body = obj(item["body"])
    let text = str(body["content"])
    // payload.cmid TEM de ser o client_message_id em claro da linha (§2.2: senão context_mismatch)
    let bcmid = str(body["client_message_id"])
    let pcmid = bcmid.isEmpty ? cmi : bcmid
    guard let st = await ChatyyE2EEConvCache.shared.state(uid: uid, conv: conv, needMembers: true), st.mode == 1,
          !st.members.isEmpty else { return .reject("e2ee5_members_unknown") }
    var reply: [String: Any]? = nil
    let rid = str(body["reply_to_id"])
    if ChatyyE2EEMsg.isDecimalId(rid) {
      reply = ["mid": rid, "quote": str(body["reply_quote_text"]), "cmid": str(body["reply_to_cmid"]),
               "sender_uid": str(body["reply_sender_uid"]), "qt": str(body["reply_qt"])]
    }
    let editOf = str(body["edit_of"])
    let mentionAll = ChatyyStoreIngestBridge.truthy(body["mention_all"])
    guard let payload = ChatyyE2EEMsg.textPayload(conv: conv, cmid: pcmid, body: text, reply: reply,
                                                   editOf: editOf.isEmpty ? nil : editOf, effect: str(body["effect"]),
                                                   mentionAll: mentionAll) else { return .reject("invalid_input") }
    let envelope: String
    do {
      envelope = try await ChatyyE2EECrypto.encrypt(uid: uid, conv: conv, memberUids: st.members, payloadJson: payload)
    } catch {
      return .reject(ChatyyCrypto.describe(error).code)
    }
    if envelope.utf8.count > 96 * 1024 { return .reject("e2ee5_too_large") }
    var nb: [String: Any] = [:]
    for (k, v) in body where bodyKeys.contains(k) { nb[k] = v }
    nb["content"] = envelope
    nb["client_message_id"] = pcmid
    nb["type"] = "text"
    nb["has_link"] = ChatyyE2EEMsg.hasLink(text)
    if editOf.isEmpty { nb.removeValue(forKey: "edit_of") }
    var it = item
    it["body"] = nb
    let fr = obj(item["frame"])
    if fr.isEmpty {
      it.removeValue(forKey: "frame")
    } else {
      var nf: [String: Any] = [:]
      for (k, v) in fr where frameKeys.contains(k) { nf[k] = v }
      nf["content"] = envelope
      nf["has_link"] = nb["has_link"]
      it["frame"] = ChatyyOutboxUtil.jsonString(nf) ?? ""
    }
    remember(cmi, conv, payload)
    return .replace(it)
  }

  /// Linha da tabela `outbox` (body/frame em string) com texto puro → patch com o envelope.
  static func reencrypt(account: String, row: [String: Any]) async -> Reenc {
    guard let uid = ChatyyE2EEGate.uid(account: account) else { return .fail("disabled") }
    var item: [String: Any] = ["cmi": str(row["cmi"]), "conv": str(row["conv"]), "kind": str(row["kind"]), "body": obj(row["body"])]
    let fr = str(row["frame"])
    if !fr.isEmpty && fr != "null" { item["frame"] = fr }
    switch await encryptItem(uid: uid, item: item) {
    case .pass: return .fail("e2ee5_pass")
    case .reject(let why): return retryCodes.contains(why) ? .retry(why) : .fail(why)
    case .replace(let it):
      var patch: [String: Any] = ["body": ChatyyOutboxUtil.jsonString(obj(it["body"])) ?? "{}"]
      if let f = it["frame"] as? String, !f.isEmpty { patch["frame"] = f } else { patch["frame"] = NSNull() }
      return .ok(patch)
    }
  }
  #endif
}

/// Mesmo `truthy` do ingest do store (público lá só via ChatyyStoreIngest interno).
enum ChatyyStoreIngestBridge {
  static func truthy(_ v: Any?) -> Bool {
    if v == nil || v is NSNull { return false }
    if let n = v as? NSNumber { return n.doubleValue != 0 }
    if let s = v as? String { return !(s.isEmpty || s == "0" || s == "false") }
    return true
  }
}

// MARK: - Recepção: frames → e2e_plain

final class ChatyyE2EEIngest {
  static let shared = ChatyyE2EEIngest()
  /// `{"e2e":` dentro de uma string JSON (o frame cru escapa as aspas).
  static let needle = "{\\\"e2e\\\":"
  private static let msgTypes: Set<String> = ["chat_message", "chat_summary", "edit"]

  private let q = DispatchQueue(label: "chatyy.e2ee.ingest", qos: .utility)
  private let lock = NSLock()
  private var accountByUid: [String: String] = [:]
  private var listening = false
  private(set) var stats: [String: Int64] = [:]

  private func bump(_ k: String, _ n: Int64 = 1) { locked { stats[k] = (stats[k] ?? 0) + n } }

  /// Trava síncrona (pode ser chamada de código async sem segurar a trava num `await`).
  private func locked<T>(_ f: () -> T) -> T {
    lock.lock(); defer { lock.unlock() }
    return f()
  }

  struct Cand {
    let conv: String, id: Int64, cmid: String, senderEmail: String, senderUid: String, envelope: String, ts: Int64
  }

  /// WS `conv_e2ee` (§5.2): só metadado → atualiza o modo da conversa (núcleo no binário).
  func noteConvE2EE(account: String, text: String) {
    guard ChatyyE2EEGate.coreLinked, let uid = ChatyyE2EEConvModes.uid(account: account),
          let d = text.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
          ChatyyE2EEMsg.str(o["type"]) == "conv_e2ee", let data = o["data"] as? [String: Any] else { return }
    let conv = ChatyyE2EEMsg.str(data["conv_id"])
    let mode = (data["e2ee_mode"] as? NSNumber)?.intValue ?? Int(ChatyyE2EEMsg.str(data["e2ee_mode"])) ?? 0
    ChatyyE2EEConvCache.shared.noteMode(uid: uid, conv: conv, mode: mode)
    bump("convE2ee")
  }

  /// Lote de frames que o store acabou de ingerir. Decifra em 2º plano (não segura o ingest:
  /// `messages.raw` fica com o envelope e o RowBuilder nativo não monta linha de envelope).
  func process(account: String, frames: [String]) {
    #if CHATYY_CRYPTO_CORE
    guard ChatyyE2EEGate.uid(account: account) != nil, frames.contains(where: { $0.contains(Self.needle) }) else { return }
    q.async { [self] in
      var cands: [Cand] = []
      for f in frames where f.contains(Self.needle) {
        guard let d = f.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              Self.msgTypes.contains(ChatyyE2EEMsg.str(o["type"])), let data = o["data"] as? [String: Any] else { continue }
        let m = (data["message"] as? [String: Any]) ?? data
        if let c = Self.cand(m, fallbackConv: ChatyyE2EEMsg.str(data["conversation_id"])) { cands.append(c) }
      }
      if cands.isEmpty { return }
      Task.detached { await self.run(account: account, cands: cands) }
    }
    #endif
  }

  static func cand(_ m: [String: Any], fallbackConv: String) -> Cand? {
    let content = ChatyyE2EEMsg.str(m["content"])
    guard ChatyyE2EEMsg.isEnvelope(content) else { return nil }
    if ChatyyStoreIngestBridge.truthy(m["deleted_at"]) { return nil }
    var conv = ChatyyE2EEMsg.str(m["conversation_id"]); if conv.isEmpty { conv = fallbackConv }
    let id = (m["id"] as? NSNumber)?.int64Value ?? Int64(ChatyyE2EEMsg.str(m["id"])) ?? 0
    guard ChatyyE2EEMsg.isDecimalId(conv), id > 0 else { return nil }
    var su = ChatyyE2EEMsg.str(m["sender_uid"]); if su.isEmpty { su = ChatyyE2EEMsg.str(m["e2e_sender_uid"]) }
    return Cand(conv: conv, id: id, cmid: ChatyyE2EEMsg.str(m["client_message_id"]),
                senderEmail: ChatyyE2EEMsg.str(m["sender_email"]).trimmingCharacters(in: .whitespaces).lowercased(),
                senderUid: ChatyyE2EEMsg.isDecimalId(su) ? su : "", envelope: content, ts: ChatyyStoreIngest.ms(m["created_at"]))
  }

  #if CHATYY_CRYPTO_CORE
  /// uid do remetente: coluna do servidor (se vier) → eu → 1:1 (o outro membro).
  /// Grupo sem `sender_uid` na linha = nil (o JS resolve; ver riscos no relatório do WP-08a).
  private func senderUid(_ uid: String, _ account: String, _ c: Cand) async -> String? {
    if !c.senderUid.isEmpty { return c.senderUid }
    if ChatyyE2EEConvModes.accountVariants(account).contains(c.senderEmail) ||
        ChatyyE2EEConvModes.accountVariants(c.senderEmail).contains(ChatyyE2EEConvModes.normAccount(account)) { return uid }
    guard let st = await ChatyyE2EEConvCache.shared.state(uid: uid, conv: c.conv, needMembers: true) else { return nil }
    if st.members.count == 2 && st.members.contains(uid) { return st.members.first { $0 != uid } }
    return nil
  }

  private func ensureListener() async {
    let need: Bool = locked {
      let n = !listening
      listening = true
      return n
    }
    if !need { return }
    await ChatyyCrypto.shared.addListener { [weak self] name, body in
      guard name == "onNewKeys", let self = self else { return }
      let uid = ChatyyE2EEMsg.str(body["uid"])
      let convs = (body["convIds"] as? [String]) ?? []
      if convs.isEmpty { return }
      Task.detached { await self.retry(uid: uid, convs: convs) }
    }
  }

  private func decryptOne(_ uid: String, _ account: String, _ c: Cand, sync: Bool) async -> [String: Any] {
    guard let su = await senderUid(uid, account, c) else {
      return ["conv": c.conv, "id": NSNumber(value: c.id), "cmid": c.cmid, "state": "wait", "reason": "sender_unknown"]
    }
    let r = await ChatyyE2EECrypto.decrypt(uid: uid, conv: c.conv, envelope: c.envelope, senderUid: su, mid: String(c.id),
                                          cmid: c.cmid, tsMs: c.ts, syncOnMissing: sync)
    switch r {
    case let .ok(payload, dev, trust, sid):
      return ["conv": c.conv, "id": NSNumber(value: c.id), "cmid": c.cmid, "state": "ok", "payload": payload,
              "sender_device": dev, "trust": trust, "session": sid]
    case let .utd(reason, retryable, sid):
      return ["conv": c.conv, "id": NSNumber(value: c.id), "cmid": c.cmid, "state": retryable ? "wait" : "fail",
              "reason": reason, "session": sid, "_sender": su]
    case let .unavailable(code):
      return ["conv": c.conv, "id": NSNumber(value: c.id), "_skip": code]
    }
  }

  private func run(account: String, cands: [Cand]) async {
    guard let uid = ChatyyE2EEGate.uid(account: account) else { return }
    locked { accountByUid[uid] = account }
    await ensureListener()
    let store = ChatyyStoreDB.shared
    var rows: [[String: Any]] = []
    var missing: [Cand] = []
    for c in cands {
      if store.e2eStateSync(account: account, conv: c.conv, id: c.id) == "ok" { continue } // reentrega / edição do mesmo id
      let r = await decryptOne(uid, account, c, sync: false)
      let reason = ChatyyE2EEMsg.str(r["reason"])
      if reason == "missing_session" || reason == "unknown_index" { missing.append(c); continue }
      if r["_skip"] != nil { bump("skip"); continue }
      rows.append(r)
    }
    if !missing.isEmpty {
      // 1 sync por lote (chave pode ter chegado por to-device depois da mensagem)
      _ = try? await ChatyyCrypto.shared.sync(uid: uid, source: "native")
      for c in missing {
        let r = await decryptOne(uid, account, c, sync: false)
        if r["_skip"] == nil { rows.append(r) }
      }
    }
    deliver(account: account, rows)
  }

  /// Chave nova chegou (`onNewKeys`): tenta de novo as "aguardando" dessas conversas.
  private func retry(uid: String, convs: [String]) async {
    let account: String? = locked { accountByUid[uid] }
    guard let account = account, ChatyyE2EEGate.uid(account: account) == uid else { return }
    let store = ChatyyStoreDB.shared
    var rows: [[String: Any]] = []
    let now = ChatyyE2EEGate.nowMs()
    for conv in convs.prefix(20) {
      for w in store.e2eWaiting(account: account, conv: conv, limit: 50) {
        guard let m = ChatyyE2EEMsg.parse(ChatyyE2EEMsg.str(w["raw"])), let c = Self.cand(m, fallbackConv: conv) else { continue }
        var r = await decryptOne(uid, account, c, sync: false)
        if r["_skip"] != nil { continue }
        // 60 s aguardando ⇒ chatyy.decrypt_report ao remetente (§6.5), uma vez por mensagem
        let first = (w["first_at"] as? NSNumber)?.int64Value ?? now
        if ChatyyE2EEMsg.str(r["state"]) == "wait", ((w["reported"] as? NSNumber)?.intValue ?? 0) == 0, now - first > 60_000 {
          await ChatyyE2EECrypto.decryptReport(uid: uid, senderUid: ChatyyE2EEMsg.str(r["_sender"]), conv: conv, mid: String(c.id),
                                               sessionId: ChatyyE2EEMsg.str(r["session"]), reason: ChatyyE2EEMsg.str(r["reason"]))
          r["reported"] = NSNumber(value: 1)
          bump("decryptReports")
        }
        rows.append(r)
      }
    }
    deliver(account: account, rows)
  }
  #endif

  private func deliver(account: String, _ rows: [[String: Any]]) {
    let clean = rows.map { r -> [String: Any] in
      var x = r
      x.removeValue(forKey: "_sender")
      x.removeValue(forKey: "_skip")
      return x
    }
    if clean.isEmpty { return }
    var ok = 0, wait = 0, fail = 0
    for r in clean {
      switch ChatyyE2EEMsg.str(r["state"]) { case "ok": ok += 1; case "wait": wait += 1; default: fail += 1 }
    }
    bump("ok", Int64(ok)); bump("wait", Int64(wait)); bump("fail", Int64(fail))
    // evento ao JS só com ids/estado (o texto o JS lê com ChatyyChatStore.e2ePlainSync)
    let items: [[String: Any]] = clean.map {
      var o: [String: Any] = ["conv": $0["conv"] ?? "", "id": $0["id"] ?? 0, "cmid": $0["cmid"] ?? "", "state": $0["state"] ?? ""]
      if let r = $0["reason"] { o["reason"] = r }
      return o
    }
    ChatyyStoreDB.shared.e2ePut(account: account, rows: clean) {
      let t = ChatTransport.shared
      t.q.async { t.emit("onE2EEPlain", ["account": account, "items": items]) }
    }
  }

  func snapshot() -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    var o: [String: Any] = ["coreLinked": ChatyyE2EEGate.coreLinked]
    for (k, v) in stats { o[k] = Double(v) }
    return o
  }
}

// MARK: - Ponte para quem não importa este pod (notificação, Siri)

/// Pedido: NotificationCenter.default.post(name: "ChatyyE2EENativeSendText", userInfo:
///   ["box": NSMutableDictionary, "account": String, "conv": String, "text": String, "cmid": String,
///    "reply_to_id": String?, "bearer": String?, "base": String?])
/// Síncrono: o observador grava box["accepted"] = true (vai cifrar e enviar) ou false (não dá:
/// o chamador abre o app — NUNCA manda texto puro). Resultado depois em
/// "ChatyyE2EENativeSendResult" userInfo ["cmid", "state": "sent"|"failed", "err"?].
enum ChatyyE2EEBridge {
  static let sendName = Notification.Name("ChatyyE2EENativeSendText")
  static let resultName = Notification.Name("ChatyyE2EENativeSendResult")
  private static let lock = NSLock()
  private static var token: NSObjectProtocol?

  static func install() {
    lock.lock(); defer { lock.unlock() }
    if token != nil { return }
    token = NotificationCenter.default.addObserver(forName: sendName, object: nil, queue: nil) { n in handle(n) }
  }

  /// Conta como o ChatOutbox/JS a conhece (alias onemundo ≡ chatyy).
  static func resolveAccount(_ a: String) -> String {
    let vs = ChatyyE2EEConvModes.accountVariants(a)
    for v in vs where OutboxKeychain.load(account: v) != nil { return v }
    for v in vs where ChatyyE2EEConvModes.uid(account: v) != nil { return v }
    return vs.first ?? ""
  }

  private static func handle(_ n: Notification) {
    guard let u = n.userInfo, let box = u["box"] as? NSMutableDictionary else { return }
    let s = { (k: String) -> String in ChatyyE2EEMsg.str(u[k]) }
    let account = resolveAccount(s("account"))
    let conv = s("conv"), text = s("text").trimmingCharacters(in: .whitespacesAndNewlines), cmid = s("cmid")
    guard ChatyyE2EEGate.uid(account: account) != nil, ChatyyE2EEMsg.isDecimalId(conv), !text.isEmpty,
          cmid.count >= 8, cmid.count <= 64 else {
      box["accepted"] = false
      return
    }
    box["accepted"] = true
    let bearer = s("bearer")
    if !bearer.isEmpty { ChatOutbox.shared.configure(account: account, token: bearer, base: s("base")) }
    ChatOutbox.shared.start()
    var body: [String: Any] = ["conversation_id": conv, "type": "text", "content": text, "client_message_id": cmid]
    var frame: [String: Any] = ["type": "chat_send", "conversation_id": conv, "client_message_id": cmid, "msg_type": "text", "content": text]
    let rid = s("reply_to_id")
    if ChatyyE2EEMsg.isDecimalId(rid) { body["reply_to_id"] = rid; frame["reply_to_id"] = rid }
    let item: [String: Any] = ["cmi": cmid, "conv": conv, "kind": "text", "body": body,
                               "frame": ChatyyOutboxUtil.jsonString(frame) ?? ""]
    let post = { (state: String, err: String) in
      NotificationCenter.default.post(name: resultName, object: nil, userInfo: ["cmid": cmid, "state": state, "err": err])
    }
    ChatOutbox.shared.submitAsync(account: account, item: item, onFinal: { state, err in post(state, err) }) { st in
      if st.isEmpty { post("failed", "e2ee5_not_queued") }
    }
  }
}
