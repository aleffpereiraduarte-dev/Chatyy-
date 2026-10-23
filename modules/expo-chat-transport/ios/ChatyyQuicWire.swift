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
// (servidor mandou transport.quic para a conta + flag local ligada + sem kill).
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

  /// Noise pronto (msg2 ok) → `bound` ("dev" | "bearer").
  var onReady: ((String) -> Void)?
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

  func start() {
    let qo = NWProtocolQUIC.Options(alpn: [ChatyyQuicProto.alpn])
    qo.direction = .bidirectional
    qo.idleTimeout = 60_000 // ms (= MaxIdleTimeout do leaf); quem pinga é o app
    // TLS do QUIC: validação PADRÃO do sistema (WebPKI) com SNI = host. A identidade
    // forte vem do Noise com a chave de região fixada (PROTOCOLO §1).
    let params = NWParameters(quic: qo)
    if p.handover { params.multipathServiceType = .handover }
    guard let port = NWEndpoint.Port(rawValue: p.port) else {
      finish(.failed("port"), beforeReady: true)
      return
    }
    let c = NWConnection(host: NWEndpoint.Host(p.host), port: port, using: params)
    conn = c
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
      if ch == nil { beginNoise() }
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
    if let ae = m.applicationError { return (ae.error, ae.reason ?? "") }
    return nil
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

  private func beginNoise() {
    guard let c = conn else { return }
    var binding = Data()
    var md = ChatyyQuicProto.modeE
    if let b = exporter(c) {
      binding = b
      md = ChatyyQuicProto.modeI
    }
    mode = md
    lastIface = c.currentPath?.availableInterfaces.first?.name
    let pro = ChatyyQuicProto.prologue(region: p.region, kid: p.kid, wire: ChatyyQuicProto.wireQuic, mode: md, binding: binding)
    do {
      let channel = try ChatyyQuicChannel(hash: .blake2s, region: p.region, kid: p.kid, regionPub: p.regionPub,
                                          deviceKey: p.deviceKey, prologue: pro)
      ch = channel
      let hello = try channel.clientHello(mode: md, payload: ChatyyQuicChannel.helloPayload(
        dev: p.dev, ua: p.ua, nowMs: Date().timeIntervalSince1970 * 1000.0))
      rawWrite(hello)
      receiveLoop()
    } catch {
      finish(.failed("noise_init: \(error)"), beforeReady: true)
    }
  }

  private func receiveLoop() {
    guard let c = conn, !ended else { return }
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
              self.onReady?(bound)
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
