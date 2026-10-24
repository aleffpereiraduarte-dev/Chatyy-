import Foundation
import Network
import Security
import CryptoKit

// [2026-10-23 quic-proto] Fio QUIC (Network.framework) do contrato chatyy/1 —
// PROTÓTIPO ESCURO. 1 NWConnection com parâmetros QUIC = 1 stream bidirecional
// (o stream 0 aberto pelo cliente, PROTOCOLO §2). Por cima: preâmbulo "CY" 0x01
// + Noise IK (ChatyyQuicChannel) e os MESMOS frames de texto do WS.
//
// Quem usa: TransportSession (ChatTransport.swift), só quando ChatyyQuicGate deixa
// (servidor mandou transport.quic para a conta + (transport.auto OU flag local) + sem kill;
// chave/pins da região = certificado `nc` assinado pela raiz do binário, ou TESTE t1, §9).
// Tudo roda na fila serial do transporte (`queue` = ChatTransport.q): estado,
// callbacks do NWConnection (start(queue:)) e o canal Noise. Sem locks.
//
// Ligar p/ teste (as 3 coisas; falta qualquer uma = WSS de sempre):
//   1. servidor: client-lb com transport{quic:1,noise:1,noise_test:1[,acc:[fnv1a(email)]]}
//      + região com q:1, nk:"t1"; leaf com LEAF_QUIC=1 LEAF_NOISE=1 e a conta na allowlist;
//   2. aparelho: ChatyyTransport.quicSetLocal(true) (App Group chatyy_quic_local);
//   3. JS sem __chatyy_quic=false. Conferir: quicSelfTest() == "ok", quicStatus(),
//      getStats().wire == "quic", evento onTransportState {state:"quic", ev:...}.
// Desligar: quicSetKill(true) | quicSetLocal(false) | __chatyy_quic=false | servidor.

/// Liga/desliga local (App Group) — padrão DESLIGADO.
enum ChatyyQuicGate {
  static let appGroup = "group.com.onemundo.mail"
  /// true = este aparelho aceita tentar QUIC quando o servidor liberar a conta.
  static let localKey = "chatyy_quic_local"
  /// true = mata o QUIC neste aparelho (vence tudo).
  static let killKey = "chatyy_quic_kill"
  /// true = NWParameters.multipathServiceType = .handover (teste de migração do SO).
  static let handoverKey = "chatyy_quic_handover"

  private static func ud() -> UserDefaults? { return UserDefaults(suiteName: appGroup) }

  static func localOn() -> Bool { return ud()?.bool(forKey: localKey) == true }
  static func killOn() -> Bool { return ud()?.bool(forKey: killKey) == true }
  static func handoverOn() -> Bool { return ud()?.bool(forKey: handoverKey) == true }
  /// true = não tenta o chatyy/2 (vai direto ao chatyy/1).
  static let v2OffKey = "chatyy_quic_v2_off"
  /// true = retomada 'E' com QUIC 0-RTT (allowFastOpen) depois de um chatyy/2 bom. Padrão desligado.
  static let zeroRttKey = "chatyy_quic_0rtt"
  static func v2Off() -> Bool { return ud()?.bool(forKey: v2OffKey) == true }
  static func zeroRttOn() -> Bool { return ud()?.bool(forKey: zeroRttKey) == true }

  static func set(_ key: String, _ on: Bool) {
    guard let u = ud() else { return }
    if on { u.set(true, forKey: key) } else { u.removeObject(forKey: key) }
  }
}

/// Par X25519 do APARELHO para o Noise (PROTOCOLO §4.1): gerado aqui, guardado no
/// Keychain (só este aparelho, depois do 1º desbloqueio — reconexão em 2º plano).
/// NÃO é a chave de identidade do E2EE (separação de chaves). Só na fila q.
enum ChatyyNoiseDeviceKey {
  private static let service = "chatyy.noise.device"
  private static let account = "x25519.v1"
  private static var cached: Curve25519.KeyAgreement.PrivateKey?

  private static func query() -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  static func loadOrCreate() -> Curve25519.KeyAgreement.PrivateKey? {
    if let k = cached { return k }
    var q = query()
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let st = SecItemCopyMatching(q as CFDictionary, &out)
    if st == errSecSuccess, let d = out as? Data, d.count == 32,
       let k = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: d) {
      cached = k
      return k
    }
    if st != errSecItemNotFound && st != errSecSuccess { return nil } // Keychain travado (antes do 1º desbloqueio)
    let k = Curve25519.KeyAgreement.PrivateKey()
    var add = query()
    add[kSecValueData as String] = k.rawRepresentation
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let a = SecItemAdd(add as CFDictionary, nil)
    if a == errSecDuplicateItem {
      cached = nil
      return nil // corrida improvável: próxima tentativa relê
    }
    guard a == errSecSuccess else { return nil }
    cached = k
    return k
  }

  /// Pública (base64) — para cadastrar o aparelho de teste no servidor (devices-TESTE.json).
  static func publicB64() -> String? {
    return loadOrCreate()?.publicKey.rawRepresentation.base64EncodedString()
  }

  /// close 4003 noise_mismatch / 0x10A: apaga e gera outro na próxima vez.
  static func forget() {
    cached = nil
    SecItemDelete(query() as CFDictionary)
  }
}

final class ChatyyQuicWire {
  struct Params {
    let host: String
    let port: UInt16
    let region: String
    let kid: String
    let regionPub: Data
    let deviceKey: Curve25519.KeyAgreement.PrivateKey
    let dev: String
    let ua: String
    let handover: Bool
    /// 2 = chatyy/2 (TLS pinado por SPKI, msg1 com `frames` no flight do Finished); 1 = chatyy/1.
    let proto: Int
    /// chatyy/2: base64(SHA-256(SPKI)) aceitos (atual + próximo). Vazio no chatyy/1.
    let pins: [String]
    /// chatyy/2 modo I: frames de texto dentro da msg1 (o auth primeiro).
    let frames: [String]
    /// Retomada (modo E): early (só idempotentes) na msg1 sem exporter; `fastOpen` = QUIC 0-RTT.
    let resume: Bool
    let early: [String]
    let fastOpen: Bool
  }

  enum End {
    /// frame close 0x08 do servidor (código de WS: 1012, 4001 go_ws, 4003, 4004, 4xxx do hub…)
    case appClose(Int, String)
    /// CONNECTION_CLOSE de aplicação do QUIC (0x101 go_ws, 0x102 noise_fail…)
    case quicClose(UInt64, String)
    /// rede/TLS/protocolo/timeout
    case failed(String)
  }

  private let p: Params
  private let queue: DispatchQueue
  private var conn: NWConnection?
  private var ch: ChatyyQuicChannel?
  private var ended = false
  private(set) var ready = false
  /// Modo usado no preâmbulo ('I' com exporter; 'E' se o iOS não deu o exporter).
  private(set) var mode: UInt8 = 0
  private var lastIface: String?

  /// Noise pronto (msg2 ok) → (`bound` "dev" | "bearer", early_n = frames da msg1 aceitos).
  var onReady: ((String, Int) -> Void)?
  var onText: ((String) -> Void)?
  /// Qualquer byte recebido (prova de vida — inclusive ping de transporte).
  var onBytes: (() -> Void)?
  /// Exatamente 1 vez. (motivo, antes do Noise pronto)
  var onEnd: ((End, Bool) -> Void)?
  /// Telemetria: "viable", "not_viable", "better_path", "iface_change".
  var onPathEvent: ((String) -> Void)?

  init(params: Params, queue: DispatchQueue) {
    self.p = params
    self.queue = queue
  }

  /// Pin do chatyy/2 recusou o certificado (o fallback vai p/ o chatyy/1, não p/ o WebPKI).
  private(set) var pinRejected = false

  func start() {
    let v2 = p.proto == 2
    let qo = NWProtocolQUIC.Options(alpn: [v2 ? ChatyyQuicProto.alpn2 : ChatyyQuicProto.alpn])
    qo.direction = .bidirectional
    qo.idleTimeout = 60_000 // ms (= MaxIdleTimeout do leaf); quem pinga é o app
    if v2 {
      // chatyy/2 (§0.2): SÓ o pin SPKI do folha (sem cadeia/WebPKI/validade). Pin fora da lista
      // = aborta o TLS. A identidade forte continua sendo o Noise com a chave de região.
      let pins = Set(p.pins)
      let sec = qo.securityProtocolOptions
      sec_protocol_options_set_verify_block(sec, { [weak self] _, trust, complete in
        let ok = ChatyyQuicWire.leafPinMatches(trust, pins)
        if !ok { self?.pinRejected = true }
        complete(ok)
      }, queue)
      // Ticket só nasce/é usado em conexão chatyy/2 (pinada): a retomada não passa pelo verify block.
      sec_protocol_options_set_tls_resumption_enabled(sec, true)
    } else {
      // [seg Q-S2] chatyy/1 (WebPKI) NÃO guarda/usa ticket: um ticket de conexão sem pin poderia
      // ser retomado depois por um chatyy/2 ao mesmo host e pular o pin SPKI (o verify block
      // não roda na retomada PSK).
      sec_protocol_options_set_tls_resumption_enabled(qo.securityProtocolOptions, false)
    }
    // chatyy/1: validação PADRÃO do sistema (WebPKI) com SNI = host.
    let params = NWParameters(quic: qo)
    if p.handover { params.multipathServiceType = .handover }
    let early0 = v2 && p.resume && p.fastOpen
    if early0 { params.allowFastOpen = true }
    guard let port = NWEndpoint.Port(rawValue: p.port) else {
      finish(.failed("port"), beforeReady: true)
      return
    }
    let c = NWConnection(host: NWEndpoint.Host(p.host), port: port, using: params)
    conn = c
    if early0 {
      // Retomada 0-RTT (§0.6): msg1 modo E (sem exporter) sai ANTES do start, marcada idempotente.
      if let hello = makeHello(binding: nil) {
        c.send(content: hello, completion: .idempotent)
      } else {
        finish(.failed("noise_init"), beforeReady: true)
        return
      }
    }
    c.stateUpdateHandler = { [weak self] st in self?.onState(st) }
    c.viabilityUpdateHandler = { [weak self] v in self?.onPathEvent?(v ? "viable" : "not_viable") }
    c.betterPathUpdateHandler = { [weak self] b in if b { self?.onPathEvent?("better_path") } }
    c.pathUpdateHandler = { [weak self] path in self?.onPath(path) }
    c.start(queue: queue)
  }

  private func onPath(_ path: NWPath) {
    let iface = path.availableInterfaces.first?.name
    if ready, let old = lastIface, let cur = iface, old != cur { onPathEvent?("iface_change") }
    if iface != nil { lastIface = iface }
  }

  private func onState(_ st: NWConnection.State) {
    if ended { return }
    switch st {
    case .ready:
      if ch == nil { beginNoise() } else if !receiving { receiveLoop() }
    case .waiting(let e):
      // Sem rota / UDP sem resposta antes do handshake → WSS já (não esperar o SO).
      if !ready { finish(.failed("waiting: \(e)"), beforeReady: true) }
    case .failed(let e):
      if let ae = quicAppError() {
        finish(.quicClose(ae.0, ae.1), beforeReady: !ready)
      } else {
        finish(.failed("failed: \(e)"), beforeReady: !ready)
      }
    case .cancelled:
      finish(.failed("cancelled"), beforeReady: !ready)
    default:
      break
    }
  }

  /// CONNECTION_CLOSE de aplicação recebido (código + texto), se o SO expuser.
  private func quicAppError() -> (UInt64, String)? {
    guard let c = conn, let m = c.metadata(definition: NWProtocolQUIC.definition) as? NWProtocolQUIC.Metadata else { return nil }
    // O tipo de `applicationError` muda entre SDKs (tupla opcional antiga;
    // NWProtocolQUIC.ApplicationError não-opcional nos novos). Lido por reflexão
    // para compilar em qualquer um: 1º inteiro = código, 1ª String = motivo.
    let v: Any = m.applicationError
    guard let r = ChatyyQuicWire.reflectCodeReason(v) else { return nil }
    if r.0 == 0 && r.1.isEmpty { return nil } // "nenhum erro"
    return r
  }

  /// Procura (código, motivo) em tupla/struct/enum/Optional, até 4 níveis.
  static func reflectCodeReason(_ v: Any) -> (UInt64, String)? {
    var code: UInt64?
    var reason: String?
    func walk(_ x: Any, _ depth: Int) {
      if depth > 4 { return }
      switch x {
      case let n as UInt64: if code == nil { code = n }; return
      case let n as Int: if code == nil, n >= 0 { code = UInt64(n) }; return
      case let n as Int64: if code == nil, n >= 0 { code = UInt64(n) }; return
      case let n as UInt32: if code == nil { code = UInt64(n) }; return
      case let n as UInt16: if code == nil { code = UInt64(n) }; return
      case let s as String: if reason == nil { reason = s }; return
      default: break
      }
      let mir = Mirror(reflecting: x)
      if mir.displayStyle == .optional && mir.children.isEmpty { return } // nil
      for c in mir.children { walk(c.value, depth + 1) }
    }
    walk(v, 0)
    if code == nil, reason == nil {
      // enum sem payload / tipo opaco: tenta os dígitos do texto (ex.: "ApplicationError(257)")
      let txt = String(describing: v)
      let digits = txt.split(whereSeparator: { !$0.isNumber }).first.map(String.init)
      if let d = digits, let n = UInt64(d) { code = n }
    }
    guard let c = code else { return nil }
    return (c, reason ?? "")
  }

  /// PROTOCOLO §4.2: exporter TLS 1.3, label "EXPORTER-chatyy-noise-v1", contexto vazio, 32 B.
  private func exporter(_ c: NWConnection) -> Data? {
    guard let m = c.metadata(definition: NWProtocolQUIC.definition) as? NWProtocolQUIC.Metadata else { return nil }
    let sec: sec_protocol_metadata_t = m.securityProtocolMetadata
    let label = ChatyyQuicProto.exporterLabel
    let raw: __DispatchData? = label.withCString { cs in
      sec_protocol_metadata_create_secret(sec, label.utf8.count, cs, ChatyyQuicProto.exporterLen)
    }
    guard let r = raw else { return nil }
    let dd = r as DispatchData
    let d = Data(dd)
    return d.count == ChatyyQuicProto.exporterLen ? d : nil
  }

  private var receiving = false

  /// Preâmbulo + msg1 (e cria o canal). binding nil = modo E (sem exporter).
  ///   chatyy/2 'I': v=2 + frames · chatyy/2 'E' e chatyy/1 'E': v=1 + early · chatyy/1 'I': v=1.
  private func makeHello(binding: Data?) -> Data? {
    let v2 = p.proto == 2
    let md: UInt8 = binding == nil ? ChatyyQuicProto.modeE : ChatyyQuicProto.modeI
    mode = md
    let pro = ChatyyQuicProto.prologue(region: p.region, kid: p.kid, wire: ChatyyQuicProto.wireQuic, mode: md,
                                       binding: binding ?? Data(), proto: v2 ? ChatyyQuicProto.alpn2 : ChatyyQuicProto.alpn)
    let now = Date().timeIntervalSince1970 * 1000.0
    let payload: Data
    if v2 && md == ChatyyQuicProto.modeI {
      payload = ChatyyQuicChannel.helloPayload(dev: p.dev, ua: p.ua, nowMs: now, version: 2, frames: p.frames)
    } else {
      // [seg Q-S3] early (0-RTT) só com o prefixo idempotente do §5, filtrado aqui também.
      payload = ChatyyQuicChannel.helloPayload(dev: p.dev, ua: p.ua, nowMs: now, version: 1,
                                               early: p.resume ? ChatyyQuicProto.earlySafePrefix(p.early) : [])
    }
    do {
      let channel = try ChatyyQuicChannel(hash: .blake2s, region: p.region, kid: p.kid, regionPub: p.regionPub,
                                          deviceKey: p.deviceKey, prologue: pro)
      let hello = try channel.clientHello(mode: md, payload: payload, version: v2 ? 2 : 1)
      ch = channel
      return hello
    } catch {
      return nil
    }
  }

  private func beginNoise() {
    guard let c = conn else { return }
    lastIface = c.currentPath?.availableInterfaces.first?.name
    // chatyy/2 'I' e chatyy/1 'I' precisam do exporter; retomada (resume) vai em 'E'.
    var binding: Data? = nil
    if !p.resume {
      binding = exporter(c)
      if binding == nil && p.proto == 2 {
        // sem exporter não há chatyy/2 'I' → o chamador cai p/ o chatyy/1 (que tenta 'E')
        finish(.failed("no_exporter"), beforeReady: true)
        return
      }
    }
    guard let hello = makeHello(binding: binding) else {
      finish(.failed("noise_init"), beforeReady: true)
      return
    }
    // chatyy/2: num write só, logo depois do TLS (= flight do Finished).
    rawWrite(hello)
    receiveLoop()
  }

  private func receiveLoop() {
    guard let c = conn, !ended else { return }
    receiving = true
    c.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
      guard let self = self, !self.ended else { return }
      if let d = data, !d.isEmpty {
        self.onBytes?()
        if self.ended { return }
        guard let channel = self.ch else { return }
        do {
          let r = try channel.receive(d)
          if !r.reply.isEmpty { self.rawWrite(r.reply) }
          for ev in r.events {
            if self.ended { return }
            switch ev {
            case .ready(let bound):
              self.ready = true
              self.onReady?(bound, channel.serverHello?.earlyN ?? 0)
            case .text(let s):
              self.onText?(s)
            case .binary:
              break // o modo nativo só fala JSON texto (msgpack desligado)
            case .close(let code, let reason):
              self.finish(.appClose(code, reason), beforeReady: !self.ready)
              return
            }
          }
        } catch {
          self.finish(.failed("proto: \(error)"), beforeReady: !self.ready)
          return
        }
      }
      if self.ended { return }
      if let e = error {
        if let ae = self.quicAppError() {
          self.finish(.quicClose(ae.0, ae.1), beforeReady: !self.ready)
        } else {
          self.finish(.failed("receive: \(e)"), beforeReady: !self.ready)
        }
        return
      }
      if isComplete {
        if let ae = self.quicAppError() {
          self.finish(.quicClose(ae.0, ae.1), beforeReady: !self.ready)
        } else {
          self.finish(.failed("eof"), beforeReady: !self.ready)
        }
        return
      }
      self.receiveLoop()
    }
  }

  private func rawWrite(_ d: Data) {
    guard let c = conn, !ended else { return }
    c.send(content: d, completion: .contentProcessed { [weak self] err in
      guard let self = self, !self.ended, let e = err else { return }
      self.finish(.failed("send: \(e)"), beforeReady: !self.ready)
    })
  }

  /// Frame de texto (≤ 1 MiB). `done` na fila q: nil = entregue à pilha.
  func sendText(_ s: String, done: @escaping (Error?) -> Void) {
    // Erro síncrono vai num async: o chamador (rawSend) nunca é reentrado no meio
    // do sendAuthIfPossible (senão o authSentGen marcaria a geração seguinte).
    guard let c = conn, let channel = ch, ready, !ended else {
      queue.async { done(ChatyyQuicChannelError.notReady) }
      return
    }
    let rec: Data
    do { rec = try channel.sealText(s) } catch {
      queue.async { done(error) }
      return
    }
    c.send(content: rec, completion: .contentProcessed { err in done(err) })
  }

  /// Encerra por iniciativa nossa (sem chamar onEnd). `code` != nil → frame close antes (best effort).
  func cancel(code: Int?) {
    if ended { return }
    ended = true
    clearHandlers()
    guard let c = conn else { return }
    conn = nil
    if let k = code, ready, let channel = ch,
       let rec = try? channel.seal(.close, ChatyyQuicProto.closeBody(code: k, reason: "")) {
      c.send(content: rec, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in c.cancel() })
      queue.asyncAfter(deadline: .now() + 1.0) { c.cancel() } // não segura a conexão se o envio travar
    } else {
      c.cancel()
    }
  }

  private func finish(_ e: End, beforeReady: Bool) {
    if ended { return }
    ended = true
    let cb = onEnd
    clearHandlers()
    if let c = conn {
      conn = nil
      c.cancel()
    }
    cb?(e, beforeReady)
  }

  private func clearHandlers() {
    onReady = nil
    onText = nil
    onBytes = nil
    onEnd = nil
    onPathEvent = nil
    if let c = conn {
      c.stateUpdateHandler = nil
      c.viabilityUpdateHandler = nil
      c.betterPathUpdateHandler = nil
      c.pathUpdateHandler = nil
    }
  }

  /// chatyy/2 §0.2: base64(SHA-256(SPKI DER)) do certificado FOLHA ∈ pins (só EC P-256).
  static func leafPinMatches(_ trust: sec_trust_t, _ pins: Set<String>) -> Bool {
    if pins.isEmpty { return false }
    let t: SecTrust = sec_trust_copy_ref(trust).takeRetainedValue()
    guard let chain = SecTrustCopyCertificateChain(t) as? [SecCertificate], let leaf = chain.first,
          let key = SecCertificateCopyKey(leaf),
          let ext = SecKeyCopyExternalRepresentation(key, nil) as Data?,
          let pin = ChatyyQuicProto.spkiPinP256(point: ext) else { return false }
    return pins.contains(pin)
  }

  /// User-Agent no formato do URLSession (o leaf repassa ao hub) + marca do fio.
  static func userAgent() -> String {
    let b = Bundle.main
    let rawName = (b.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? "Chatyy"
    let name = rawName.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "Chatyy"
    let ver = (b.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "0"
    let cfn = (Bundle(identifier: "com.apple.CFNetwork")?.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "0"
    var u = utsname()
    uname(&u)
    let darwin: String = withUnsafeBytes(of: &u.release) { raw in
      String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
    }
    return "\(name)/\(ver) CFNetwork/\(cfn) Darwin/\(darwin) chatyy-quic/1"
  }
}
