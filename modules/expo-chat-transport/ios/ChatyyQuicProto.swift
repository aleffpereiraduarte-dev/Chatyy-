import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

// [2026-10-23 quic-proto] Contrato `chatyy/1` (PROTOCOLO.md, versão 1-proto) — parte
// SEM rede: preâmbulo, prólogo, msg1/msg2 do Noise IK, registros cifrados e frames.
// Nada aqui toca Network.framework (o fio fica em ChatyyQuicWire.swift), então este
// arquivo + ChatyyNoise.swift compilam e rodam fora do iOS (swift-crypto) para os
// testes de ida e volta (ChatyyQuicSelfTest).
//
// Fluxo no stream bidirecional (§2–§4):
//   cliente: "CY" 0x01 'I' | u16 BE len | msg1        (msg1 = -> e, es, s, ss + payload JSON)
//   servidor:               u16 BE len | msg2         (msg2 = <- e, ee, se + payload JSON)
//   depois, nos 2 sentidos: u16 BE len | ciphertext   (registros; plaintext ≤ 65519)
//   plaintext dos registros = fluxo contínuo de frames: varint(len) | tipo | corpo

enum ChatyyQuicProto {
  static let alpn = "chatyy/1"
  /// [chatyy/2 — PROTOCOLO §0] TLS pinado por SPKI + msg1 do IK no flight do Finished.
  static let alpn2 = "chatyy/2"
  static let port: UInt16 = 443
  static let exporterLabel = "EXPORTER-chatyy-noise-v1"
  static let exporterLen = 32
  /// §3: corpo máximo 1 MiB (= ReadLimit do WS) no que o CLIENTE manda.
  static let maxOutBody = 1 << 20
  /// O que chega: o WS nativo aceita até 16 MiB (initial_data/resume) — mesmo teto.
  static let maxInBody = 16 << 20
  /// §4.3: payload da msg1 ≤ 60 KiB.
  static let maxHelloPayload = 60 * 1024

  static let modeI: UInt8 = 0x49 // Noise amarrado ao QUIC-TLS (exporter no prólogo)
  static let modeE: UInt8 = 0x45 // Noise sem amarração
  static let wireQuic: UInt8 = 0x71 // 'q'

  enum FrameType: UInt8 {
    case text = 0x01
    case binary = 0x02
    case close = 0x08
    case ping = 0x09
    case pong = 0x0A
  }

  /// Chave de região de TESTE (§1). Só vale com transport.noise_test=1 do servidor.
  static let testKid = "t1"
  static let testRegionPubB64 = "inKsxZ/WSbIq8+QcY/3DDTrbxDdiRQ3t6lHsyYinlh8="

  /// Caminho de TESTE (§1): kid t1 → chave de 32 bytes, só com noise_test. Produção NÃO passa
  /// por aqui: vem do certificado de região `nc` (ChatyyRegionCert.verify, §9.2).
  static func pinnedKey(kid: String, testAllowed: Bool) -> Data? {
    if kid == testKid && testAllowed {
      guard let d = Data(base64Encoded: testRegionPubB64), d.count == 32 else { return nil }
      return d
    }
    return nil
  }

  /// §2 preâmbulo: "CY" | versão (0x01 | 0x02) | modo.
  static func preamble(mode: UInt8, version: UInt8 = 1) -> Data {
    return Data([0x43, 0x59, version, mode])
  }

  /// §4.2 / §0.3: proto ("chatyy/1" | "chatyy/2") 0x00 | região 0x00 | kid 0x00 | fio | modo | binding.
  static func prologue(region: String, kid: String, wire: UInt8, mode: UInt8, binding: Data, proto: String = "chatyy/1") -> Data {
    var d = Data(proto.utf8)
    d.append(0)
    d.append(Data(region.utf8))
    d.append(0)
    d.append(Data(kid.utf8))
    d.append(0)
    d.append(wire)
    d.append(mode)
    d.append(binding)
    return d
  }

  // MARK: varint (RFC 9000 §16)

  static func varint(_ v: UInt64) -> Data {
    if v < 64 { return Data([UInt8(v)]) }
    if v < 16384 { return Data([0x40 | UInt8(v >> 8), UInt8(v & 0xff)]) }
    if v < (1 << 30) {
      return Data([0x80 | UInt8(v >> 24), UInt8((v >> 16) & 0xff), UInt8((v >> 8) & 0xff), UInt8(v & 0xff)])
    }
    let x = min(v, (1 << 62) - 1)
    var out = Data([0xC0 | UInt8(x >> 56)])
    for s in stride(from: 48, through: 0, by: -8) { out.append(UInt8((x >> UInt64(s)) & 0xff)) }
    return out
  }

  /// (valor, bytes usados) ou nil se ainda faltam bytes. `b` com startIndex qualquer.
  static func parseVarint(_ b: Data, at off: Int) -> (UInt64, Int)? {
    let base = b.startIndex + off
    guard off < b.count else { return nil }
    let first = b[base]
    let len = 1 << Int(first >> 6)
    guard b.count - off >= len else { return nil }
    var v = UInt64(first & 0x3f)
    if len > 1 {
      for i in 1..<len { v = (v << 8) | UInt64(b[base + i]) }
    }
    return (v, len)
  }

  static func encodeFrame(_ type: FrameType, _ body: Data) -> Data {
    var out = varint(UInt64(body.count))
    out.append(type.rawValue)
    out.append(body)
    return out
  }

  /// §3 close: u16 BE código + motivo UTF-8 (≤ 123 B).
  static func closeBody(code: Int, reason: String) -> Data {
    let c = UInt16(clamping: code)
    var d = Data([UInt8(c >> 8), UInt8(c & 0xff)])
    var r = Data(reason.utf8)
    if r.count > 123 { r = r.subdata(in: 0..<123) }
    d.append(r)
    return d
  }

  static func parseClose(_ body: Data) -> (Int, String) {
    let b = Data(body)
    if b.count < 2 { return (1005, "") } // WS: "sem código"
    let code = (Int(b[0]) << 8) | Int(b[1])
    let reason = String(data: b.subdata(in: 2..<b.count), encoding: .utf8) ?? ""
    return (code, reason)
  }

  // MARK: chatyy/2 — pin SPKI (§0.2)

  /// Pins de TESTE (todas as regiões): atual + próximo (rotação).
  static let testPins: [String] = [
    "7T92loM6w7GMhwkyu25bQOwbGoVMJdk7u6nm48Jp51g=",
    "QhTxrbi7wfzD+EEgmN7jpO2JOGa09wxQYBGullgQQP4=",
  ]

  // MARK: produção — raízes Ed25519 offline (PROTOCOLO §9.1)

  /// Chaves PÚBLICAS das raízes (rootId → base64 padrão de 32 bytes). O `raiz.sh app-pub`
  /// grava UMA entrada por linha entre as marcas, no formato `    "r1": "BASE64",`.
  /// Vazio = produção desligada (só o caminho de TESTE `t1`). A entrada "_" é só para o
  /// literal nunca ficar vazio (Swift não aceita `[]` como dicionário) e é descartada.
  static let rootPubs: [String: String] = ([
    "_": "",
    // QN-ROOTS-BEGIN
    // QN-ROOTS-END
  ] as [String: String]).filter { $0.key != "_" }

  /// Raízes decodificadas (entradas inválidas são ignoradas: nunca valem como raiz).
  static func decodeRoots(_ src: [String: String]) -> [String: Curve25519.Signing.PublicKey] {
    var out: [String: Curve25519.Signing.PublicKey] = [:]
    for (id, b64) in src {
      guard ChatyyRegionCert.isId(Array(id.utf8)), let raw = Data(base64Encoded: b64), raw.count == 32,
            let k = try? Curve25519.Signing.PublicKey(rawRepresentation: raw) else { continue }
      out[id] = k
    }
    return out
  }

  /// Raízes de PRODUÇÃO (só as do binário; o JS/servidor não consegue acrescentar).
  static let productionRoots: [String: Curve25519.Signing.PublicKey] = decodeRoots(rootPubs)

  /// Cabeçalho DER do SubjectPublicKeyInfo de uma chave EC P-256 (id-ecPublicKey + prime256v1,
  /// BIT STRING de 66 bytes). SecKeyCopyExternalRepresentation dá só o ponto 04||X||Y (65 B).
  static let spkiP256Header: [UInt8] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ]

  /// base64(SHA-256(SPKI DER)) a partir do ponto P-256 não comprimido; nil se não for P-256.
  static func spkiPinP256(point: Data) -> String? {
    let pt = Data(point)
    guard pt.count == 65, pt[0] == 0x04 else { return nil }
    var der = Data(spkiP256Header)
    der.append(pt)
    return Data(SHA256.hash(data: der)).base64EncodedString()
  }

  /// §5: prefixo de frames que pode ir em 0-RTT / `early` (modo E). Para no 1º não permitido
  /// (o servidor faz o mesmo, `early_why:"op"`): auth (só como 1º), subscribe/unsubscribe, ping JSON,
  /// chat_send COM client_message_id. Frame que não é JSON objeto = para. Máx. 64.
  static func earlySafePrefix(_ frames: [String]) -> [String] {
    var out: [String] = []
    for (i, f) in frames.prefix(64).enumerated() {
      guard let d = f.data(using: .utf8),
            let o = (try? JSONSerialization.jsonObject(with: d, options: [])) as? [String: Any],
            let t = o["type"] as? String else { break }
      var ok = false
      switch t {
      case "auth": ok = i == 0
      case "subscribe", "unsubscribe", "ping": ok = true
      case "chat_send":
        if let c = o["client_message_id"] as? String { ok = !c.isEmpty }
        else if let n = o["client_message_id"] as? NSNumber { ok = n.stringValue != "0" }
      default: ok = false
      }
      if !ok { break }
      out.append(f)
    }
    return out
  }

  static func u16(_ n: Int) -> Data {
    return Data([UInt8((n >> 8) & 0xff), UInt8(n & 0xff)])
  }

  static func randomBytes(_ n: Int) -> Data {
    var g = SystemRandomNumberGenerator() // CSPRNG (arc4random no iOS)
    var d = Data(count: n)
    for i in 0..<n { d[i] = UInt8.random(in: 0...255, using: &g) }
    return d
  }
}

/// Payload da msg2 (§4.3).
struct ChatyyQuicServerHello {
  let ok: Bool
  let region: String
  let kid: String
  let bound: String
  let earlyN: Int
  let srvTs: Double

  static func parse(_ d: Data) -> ChatyyQuicServerHello? {
    guard let obj = (try? JSONSerialization.jsonObject(with: d, options: [])) as? [String: Any] else { return nil }
    let ok: Bool = (obj["ok"] as? Bool) ?? ((obj["ok"] as? NSNumber)?.boolValue ?? false)
    return ChatyyQuicServerHello(
      ok: ok,
      region: (obj["region"] as? String) ?? "",
      kid: (obj["kid"] as? String) ?? "",
      bound: (obj["bound"] as? String) ?? "",
      earlyN: (obj["early_n"] as? NSNumber)?.intValue ?? 0,
      srvTs: (obj["srv_ts"] as? NSNumber)?.doubleValue ?? 0
    )
  }
}

enum ChatyyQuicChannelError: Error, Equatable {
  case notReady
  case badRecord
  case badFrame(String)
  case tooBig
  case serverHello(String)
}

/// Canal Noise + frames (sem rede): o fio entrega os bytes que chegam em `receive` e
/// manda pela rede o que `clientHello` / `seal*` / `receive().reply` devolvem.
/// NÃO é thread-safe: o dono (ChatyyQuicWire) usa sempre a mesma fila serial.
final class ChatyyQuicChannel {
  enum Event: Equatable {
    case ready(bound: String)
    case text(String)
    case binary(Int)
    case close(Int, String)
  }

  let region: String
  let kid: String
  private let ik: ChatyyNoiseIK
  private var transport: ChatyyNoiseTransport?
  private var helloSent = false
  private var inBuf = Data()    // bytes crus do stream (registros u16|...)
  private var plainBuf = Data() // plaintext decifrado (frames)
  private(set) var serverHello: ChatyyQuicServerHello?
  private(set) var bytesIn: Int64 = 0
  private(set) var recordsIn: Int64 = 0

  var isReady: Bool { return transport != nil }

  init(hash: ChatyyNoiseHash = .blake2s, region: String, kid: String, regionPub: Data,
       deviceKey: Curve25519.KeyAgreement.PrivateKey, prologue: Data,
       fixedEphemeral: Curve25519.KeyAgreement.PrivateKey? = nil) throws {
    self.region = region
    self.kid = kid
    ik = try ChatyyNoiseIK(hash: hash, role: .initiator, prologue: prologue, localStatic: deviceKey,
                           remoteStatic: regionPub, fixedEphemeral: fixedEphemeral)
  }

  /// Preâmbulo + msg1 (§2, §4.3). `payload` = JSON da msg1 (ver helloPayload).
  func clientHello(mode: UInt8, payload: Data, version: UInt8 = 1) throws -> Data {
    if helloSent { throw ChatyyNoiseError.wrongState("hello twice") }
    if payload.count > ChatyyQuicProto.maxHelloPayload { throw ChatyyQuicChannelError.tooBig }
    let m1 = try ik.writeMessageA(payload: payload)
    helloSent = true
    var out = ChatyyQuicProto.preamble(mode: mode, version: version)
    out.append(ChatyyQuicProto.u16(m1.count))
    out.append(m1)
    return out
  }

  /// JSON da msg1: {"v":1,"dev","ts","n","ua"} — `n` novo a cada tentativa (anti-replay §5).
  /// chatyy/2 modo I: v=2 + `frames` (auth primeiro; qualquer frame, vai amarrado ao exporter).
  /// Modo E (retomada) e chatyy/1: v=1 + `early` opcional (só idempotentes, §5).
  static func helloPayload(dev: String, ua: String, nowMs: Double, version: Int = 1,
                           frames: [String] = [], early: [String] = []) -> Data {
    var obj: [String: Any] = [
      "v": version,
      "dev": dev,
      "ts": Int64(nowMs),
      "n": ChatyyQuicProto.randomBytes(16).base64EncodedString(),
      "ua": ua,
    ]
    if !frames.isEmpty { obj["frames"] = Array(frames.prefix(64)) }
    if !early.isEmpty { obj["early"] = Array(early.prefix(64)) }
    return (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{\"v\":1}".utf8)
  }

  /// Bytes do stream → eventos + o que responder (pong do ping de transporte).
  /// Lança = protocolo quebrado (o fio fecha e cai para o WSS).
  func receive(_ data: Data) throws -> (events: [Event], reply: Data) {
    bytesIn += Int64(data.count)
    inBuf.append(data)
    var events: [Event] = []
    var reply = Data()
    var off = 0
    while inBuf.count - off >= 2 {
      let b0 = Int(inBuf[inBuf.startIndex + off])
      let b1 = Int(inBuf[inBuf.startIndex + off + 1])
      let len = (b0 << 8) | b1
      if len == 0 { throw ChatyyQuicChannelError.badRecord }
      if inBuf.count - off - 2 < len { break }
      let s = inBuf.startIndex + off + 2
      let rec = inBuf.subdata(in: s..<(s + len))
      off += 2 + len
      recordsIn += 1
      if transport == nil {
        // 1º registro = msg2 do handshake.
        guard helloSent else { throw ChatyyNoiseError.wrongState("msg2 before hello") }
        let p = try ik.readMessageB(rec)
        guard let sh = ChatyyQuicServerHello.parse(p) else { throw ChatyyQuicChannelError.serverHello("json") }
        guard sh.ok else { throw ChatyyQuicChannelError.serverHello("not_ok") }
        // Defesa extra: a região/kid ditos pelo servidor têm de ser os do prólogo
        // (o prólogo já amarra; isto só dá um motivo legível).
        if !sh.region.isEmpty && sh.region != region { throw ChatyyQuicChannelError.serverHello("region") }
        if !sh.kid.isEmpty && sh.kid != kid { throw ChatyyQuicChannelError.serverHello("kid") }
        serverHello = sh
        transport = try ik.split()
        events.append(.ready(bound: sh.bound))
        continue
      }
      let pt = try transport!.decrypt(rec)
      plainBuf.append(pt)
      try drainFrames(&events, &reply)
    }
    if off > 0 { inBuf = inBuf.subdata(in: (inBuf.startIndex + off)..<inBuf.endIndex) }
    // Registro maior que 65535 é impossível pelo u16; o teto aqui é de frame.
    return (events, reply)
  }

  private func drainFrames(_ events: inout [Event], _ reply: inout Data) throws {
    var off = 0
    while true {
      guard let (lenV, vl) = ChatyyQuicProto.parseVarint(plainBuf, at: off) else { break }
      if lenV > UInt64(ChatyyQuicProto.maxInBody) { throw ChatyyQuicChannelError.tooBig }
      let len = Int(lenV)
      guard plainBuf.count - off >= vl + 1 + len else { break }
      let tByte = plainBuf[plainBuf.startIndex + off + vl]
      let s = plainBuf.startIndex + off + vl + 1
      let body = plainBuf.subdata(in: s..<(s + len))
      off += vl + 1 + len
      guard let t = ChatyyQuicProto.FrameType(rawValue: tByte) else { throw ChatyyQuicChannelError.badFrame("type") }
      switch t {
      case .text:
        guard let str = String(data: body, encoding: .utf8) else { throw ChatyyQuicChannelError.badFrame("utf8") }
        events.append(.text(str))
      case .binary:
        events.append(.binary(body.count))
      case .close:
        let (c, r) = ChatyyQuicProto.parseClose(body)
        events.append(.close(c, r))
      case .ping:
        if body.count > 125 { throw ChatyyQuicChannelError.badFrame("ping") }
        reply.append(try seal(.pong, body))
      case .pong:
        break
      }
    }
    if off > 0 { plainBuf = plainBuf.subdata(in: (plainBuf.startIndex + off)..<plainBuf.endIndex) }
  }

  /// Frame → registros cifrados prontos para o fio (fatia em plaintexts ≤ 65519).
  func seal(_ type: ChatyyQuicProto.FrameType, _ body: Data) throws -> Data {
    guard transport != nil else { throw ChatyyQuicChannelError.notReady }
    if body.count > ChatyyQuicProto.maxOutBody { throw ChatyyQuicChannelError.tooBig }
    let frame = ChatyyQuicProto.encodeFrame(type, body)
    var out = Data()
    var off = 0
    let maxPt = ChatyyNoiseTransport.maxPlaintext
    while off < frame.count {
      let end = min(frame.count, off + maxPt)
      let ct = try transport!.encrypt(frame.subdata(in: off..<end))
      out.append(ChatyyQuicProto.u16(ct.count))
      out.append(ct)
      off = end
    }
    return out
  }

  func sealText(_ s: String) throws -> Data {
    return try seal(.text, Data(s.utf8))
  }
}

// MARK: - certificado de região (PROTOCOLO §9.2) — espelho de qnwire.VerifyNC (Go)

/// certBytes = "CYRC" | 0x01 | u8+rootId | u8+region | u8+kid | noisePub(32) | u8 nPins (1..4) | pins(32×n) |
///             u64 notBefore | u64 notAfter   (big endian, ids [a-z0-9]{1,16}, nada sobrando)
/// sig = Ed25519(raiz, "chatyy-region-cert/1" 0x00 || certBytes)
/// nc  = base64url-sem-padding(certBytes) "." base64url-sem-padding(sig)   (≤ 1024 chars)
struct ChatyyRegionCert: Equatable {
  enum Failure: Error, Equatable {
    case format, base64, signatureLen, unknownRoot, signature, region, kid, notYet, expired
  }

  static let magic: [UInt8] = [0x43, 0x59, 0x52, 0x43] // "CYRC"
  static let version: UInt8 = 1
  static let context = "chatyy-region-cert/1"
  static let maxPins = 4
  static let skewSeconds: Double = 86_400 // notBefore − 24 h
  static let maxNcLen = 1024

  let rootId: String
  let region: String
  let kid: String
  let noisePub: Data
  let pins: [Data]
  let notBefore: Int64
  let notAfter: Int64

  /// Pins no formato do verify block do chatyy/2: base64 padrão do SHA-256 do SPKI (1º = atual).
  var pinsB64: [String] { return pins.map { $0.base64EncodedString() } }

  /// [a-z0-9]{1,16} (o regexp do Go; byte não-ASCII nunca casa).
  static func isId(_ b: [UInt8]) -> Bool {
    if b.isEmpty || b.count > 16 { return false }
    for c in b where !((c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39)) { return false }
    return true
  }

  /// base64url SEM padding, estrito no alfabeto: '=', '+', '/', espaço e quebra de linha → nil.
  /// Resto de 1 caractere (len % 4 == 1) → nil. Bits de sobra ≠ 0 são aceitos (= Go RawURLEncoding).
  static func b64urlRaw<S: Sequence>(_ s: S) -> Data? where S.Element == UInt8 {
    var out = Data()
    var acc: UInt32 = 0
    var bits = 0
    for c in s {
      let v: UInt32
      switch c {
      case 0x41...0x5A: v = UInt32(c - 0x41)
      case 0x61...0x7A: v = UInt32(c - 0x61) + 26
      case 0x30...0x39: v = UInt32(c - 0x30) + 52
      case 0x2D: v = 62 // '-'
      case 0x5F: v = 63 // '_'
      default: return nil
      }
      acc = ((acc << 6) | v) & 0xFFF
      bits += 6
      if bits >= 8 {
        bits -= 8
        out.append(UInt8((acc >> UInt32(bits)) & 0xFF))
      }
    }
    if bits >= 6 { return nil }
    return out
  }

  /// SplitNC: (certBytes, sig de 64 bytes).
  static func split(_ nc: String) throws -> (Data, Data) {
    let u = Array(nc.utf8)
    let dots = u.indices.filter { u[$0] == 0x2E }
    guard u.count <= maxNcLen, dots.count == 1, let i = dots.first, i > 0 else { throw Failure.format }
    guard let cb = b64urlRaw(u[0..<i]) else { throw Failure.base64 }
    guard let sig = b64urlRaw(u[(i + 1)...]), sig.count == 64 else { throw Failure.signatureLen }
    return (cb, sig)
  }

  /// ParseRegCert: só o formato (sem assinatura).
  static func parse(_ data: Data) throws -> ChatyyRegionCert {
    let b = [UInt8](data)
    guard b.count >= 5, Array(b[0..<4]) == magic, b[4] == version else { throw Failure.format }
    var p = 5
    func str() throws -> String {
      guard p < b.count else { throw Failure.format }
      let n = Int(b[p])
      p += 1
      guard n > 0, p + n <= b.count else { throw Failure.format }
      let s = Array(b[p..<(p + n)])
      p += n
      guard isId(s), let out = String(bytes: s, encoding: .ascii) else { throw Failure.format }
      return out
    }
    let rootId = try str()
    let region = try str()
    let kid = try str()
    guard p + 33 <= b.count else { throw Failure.format }
    let noisePub = Data(b[p..<(p + 32)])
    p += 32
    let n = Int(b[p])
    p += 1
    guard n >= 1, n <= maxPins, p + 32 * n + 16 == b.count else { throw Failure.format }
    var pins: [Data] = []
    for _ in 0..<n {
      pins.append(Data(b[p..<(p + 32)]))
      p += 32
    }
    func u64(_ at: Int) -> UInt64 {
      var v: UInt64 = 0
      for k in 0..<8 { v = (v << 8) | UInt64(b[at + k]) }
      return v
    }
    // Go: int64(binary.BigEndian.Uint64(..)) — mesmo bit a bit.
    let nb = Int64(bitPattern: u64(p))
    let na = Int64(bitPattern: u64(p + 8))
    guard na > nb else { throw Failure.format }
    return ChatyyRegionCert(rootId: rootId, region: region, kid: kid, noisePub: noisePub, pins: pins,
                            notBefore: nb, notAfter: na)
  }

  static func signedMessage(_ certBytes: Data) -> Data {
    var m = Data(context.utf8)
    m.append(0)
    m.append(certBytes)
    return m
  }

  /// VerifyNC. `roots` = só para os testes (raiz vr1 dos vetores); produção = raízes do binário.
  /// `kid` vazio não confere o kid (igual ao Go); o gate sempre passa o `nk` da região.
  static func verify(nc: String, region: String, kid: String, now: Double,
                     roots: [String: Curve25519.Signing.PublicKey] = ChatyyQuicProto.productionRoots) throws -> ChatyyRegionCert {
    let (cb, sig) = try split(nc)
    let c = try parse(cb)
    guard let pub = roots[c.rootId] else { throw Failure.unknownRoot }
    guard pub.isValidSignature(sig, for: signedMessage(cb)) else { throw Failure.signature }
    guard c.region == region else { throw Failure.region }
    if !kid.isEmpty && c.kid != kid { throw Failure.kid }
    if now < Double(c.notBefore) - skewSeconds { throw Failure.notYet }
    if now > Double(c.notAfter) { throw Failure.expired }
    return c
  }
}

/// Os 11 vetores de leaf/vectors/regcert_vectors.json (raiz de TESTE vr1 — NÃO é de produção).
enum ChatyyRegionCertSelfTest {
  static let vr1 = "gsq4oYdlD8W4rC7IqCsHwmu7mDrVy/X0hCQty/XMYj0="
  static let okNoisePub = "WdUQDnOSggLK0V5dhr6tsQ4esL/gu3jl8PrvOzQjtH0="
  static let okPins = ["4af9qeakVNth/LDNkx/vfDqzATYRImE3SDQAfXUlJrY=", "yyQ6W6JHwELBPE40fmjzn//vPHK518LjJiRgBcitiN4="]
  static let cert = "Q1lSQwEDdnIxA3NjbAJwMVnVEA5zkoICytFeXYa-rbEOHrC_4Lt45fD67zs0I7R9AuGn_anmpFTbYfywzZMf73w6swE2ESJhN0g0AH11JSa2yyQ6W6JHwELBPE40fmjzn__vPHK518LjJiRgBcitiN4AAAAAaPa6QAAAAAB0OqOA"
  static let sig = "xhGjej0ehNvkFSEk12FPiTRgL6kbo2Qx1u0OzwKEut7GHcRjaPsip9ZoCxrO1q1eWy2vaFaLX6kJ78aJ1n8QAw"
  static let ok = cert + "." + sig

  /// (nome, nc, região, kid, agora, ok)
  static let vectors: [(String, String, String, String, Double, Bool)] = [
    ("ok", ok, "scl", "p1", 1761350400, true),
    ("regiao_errada", ok, "mex", "p1", 1761350400, false),
    ("kid_errado", ok, "scl", "p2", 1761350400, false),
    ("vencido", ok, "scl", "p1", 1950000001, false),
    ("antes_do_nb_mais_de_1d", ok, "scl", "p1", 1760913599, false),
    ("antes_do_nb_dentro_de_1d", ok, "scl", "p1", 1760996400, true),
    ("assinatura_trocada", cert + ".xxGjej0ehNvkFSEk12FPiTRgL6kbo2Qx1u0OzwKEut7GHcRjaPsip9ZoCxrO1q1eWy2vaFaLX6kJ78aJ1n8QAw",
     "scl", "p1", 1761350400, false),
    ("outra_raiz_mesmo_id", cert + ".BjIvZJDPVyA1NsXVXO6yM0gRKAYLYkwhAyRo6TGWno6c2M1ReSsjtH3NqF0Ul6pcBTNKWIiX9PGWsuS36pZzCQ",
     "scl", "p1", 1761350400, false),
    ("byte_sobrando", cert + "AA.iMt9YGyl4ohnXq6f5lqoThF7M3S_MqeOAFasXCQ4AQE9SF3sXeIutw7FEdXip6s_EvpMZLu6eA1X43hHLlBLCw",
     "scl", "p1", 1761350400, false),
    ("raiz_desconhecida", "Q1lSQwEDeno5A3NjbAJwMVnVEA5zkoICytFeXYa-rbEOHrC_4Lt45fD67zs0I7R9AuGn_anmpFTbYfywzZMf73w6swE2ESJhN0g0AH11JSa2yyQ6W6JHwELBPE40fmjzn__vPHK518LjJiRgBcitiN4AAAAAaPa6QAAAAAB0OqOA.-yck78kuDmcYHHyfRs_BNQjMcBsi_giPO5T8Y8QQQhxw-Ojz-ikHdLQP-KiJI0XaLABRwnf08ksOUi4L2j05BQ",
     "scl", "p1", 1761350400, false),
    ("padding_base64", cert + "=." + sig, "scl", "p1", 1761350400, false),
  ]

  /// nil = passou.
  static func run() -> String? {
    let roots = ChatyyQuicProto.decodeRoots(["vr1": vr1])
    if roots.count != 1 { return "regcert raiz vr1" }
    // A raiz de TESTE nunca pode estar entre as de produção.
    if ChatyyQuicProto.productionRoots["vr1"] != nil || ChatyyQuicProto.rootPubs["_"] != nil { return "regcert raiz de teste em produção" }
    for (name, nc, region, kid, now, want) in vectors {
      let got = try? ChatyyRegionCert.verify(nc: nc, region: region, kid: kid, now: now, roots: roots)
      if (got != nil) != want { return "regcert " + name }
      if let c = got {
        if c.noisePub.base64EncodedString() != okNoisePub || c.pinsB64 != okPins { return "regcert " + name + " campos" }
        if c.notBefore != 1761000000 || c.notAfter != 1950000000 || c.rootId != "vr1" || c.region != "scl" || c.kid != "p1" {
          return "regcert " + name + " validade"
        }
      }
    }
    // Sem a raiz (lista de produção vazia/sem vr1) o mesmo nc não vale.
    if (try? ChatyyRegionCert.verify(nc: ok, region: "scl", kid: "p1", now: 1761350400, roots: [:])) != nil { return "regcert sem raiz" }
    // Formato do nc: 2 pontos, ponto no início, tamanho > 1024, '+'/'/' (base64 padrão).
    if (try? ChatyyRegionCert.split(ok + ".")) != nil { return "regcert 2 pontos" }
    if (try? ChatyyRegionCert.split("." + sig)) != nil { return "regcert ponto inicial" }
    if (try? ChatyyRegionCert.split(String(repeating: "A", count: 1100) + "." + sig)) != nil { return "regcert > 1024" }
    if (try? ChatyyRegionCert.split(cert.replacingOccurrences(of: "-", with: "+") + "." + sig)) != nil { return "regcert alfabeto" }
    if ChatyyRegionCert.b64urlRaw(Array("QUJD".utf8)) != Data("ABC".utf8) || ChatyyRegionCert.b64urlRaw(Array("QUI".utf8)) != Data("AB".utf8)
      || ChatyyRegionCert.b64urlRaw(Array("QQ".utf8)) != Data("A".utf8) || ChatyyRegionCert.b64urlRaw(Array("Q".utf8)) != nil {
      return "regcert b64url"
    }
    return nil
  }
}

// MARK: - autoteste de ida e volta (servidor simulado com o respondedor IK)

enum ChatyyQuicSelfTest {
  /// nil = passou. Usa o respondedor do ChatyyNoiseIK como "leaf" de mentira.
  static func run() -> String? {
    if let e = ChatyyNoiseSelfTest.run() { return "noise: " + e }
    if let e = ChatyyRegionCertSelfTest.run() { return e }
    // §5: só o prefixo idempotente vai no early (para no 1º proibido).
    let ef = ChatyyQuicProto.earlySafePrefix(["{\"type\":\"auth\",\"token\":\"x\"}", "{\"type\":\"subscribe\"}",
                                              "{\"type\":\"chat_send\",\"client_message_id\":\"c1\"}",
                                              "{\"type\":\"message_read\"}", "{\"type\":\"ping\"}"])
    if ef.count != 3 { return "early prefix \(ef.count)" }
    if !ChatyyQuicProto.earlySafePrefix(["{\"type\":\"chat_send\"}"]).isEmpty { return "early chat_send sem cmi" }
    if !ChatyyQuicProto.earlySafePrefix(["{\"type\":\"ping\"}", "{\"type\":\"auth\"}"]).elementsEqual(["{\"type\":\"ping\"}"]) { return "early auth fora do 1º" }
    // varint: fronteiras do RFC 9000 §16 (+ exemplos do Apêndice A.1).
    let cases: [(UInt64, String)] = [(0, "00"), (37, "25"), (63, "3f"), (64, "4040"), (15293, "7bbd"), (16383, "7fff"),
                                     (16384, "80004000"), (494878333, "9d7f3e7d"), (1073741823, "bfffffff"),
                                     (1073741824, "c000000040000000"), (151288809941952652, "c2197c5eff14e88c")]
    for (v, h) in cases {
      let enc = ChatyyQuicProto.varint(v)
      if ChatyyNoiseSelfTest.toHex(enc) != h { return "varint enc \(v)" }
      guard let (dv, dl) = ChatyyQuicProto.parseVarint(enc, at: 0), dv == v, dl == enc.count else { return "varint dec \(v)" }
      if enc.count > 1, ChatyyQuicProto.parseVarint(enc.subdata(in: 0..<(enc.count - 1)), at: 0) != nil { return "varint short \(v)" }
    }
    do {
      let dev = Curve25519.KeyAgreement.PrivateKey()
      let srv = Curve25519.KeyAgreement.PrivateKey()
      let binding = ChatyyQuicProto.randomBytes(32)
      let pro = ChatyyQuicProto.prologue(region: "mex", kid: "t1", wire: ChatyyQuicProto.wireQuic,
                                         mode: ChatyyQuicProto.modeI, binding: binding)
      let ch = try ChatyyQuicChannel(region: "mex", kid: "t1", regionPub: srv.publicKey.rawRepresentation,
                                     deviceKey: dev, prologue: pro)
      let hello = try ch.clientHello(mode: ChatyyQuicProto.modeI,
                                     payload: ChatyyQuicChannel.helloPayload(dev: "d1", ua: "t", nowMs: 1))
      // lado servidor
      if hello.prefix(4) != Data([0x43, 0x59, 0x01, 0x49]) { return "preamble" }
      let l1 = (Int(hello[4]) << 8) | Int(hello[5])
      if l1 != hello.count - 6 { return "msg1 len" }
      let rsp = try ChatyyNoiseIK(hash: .blake2s, role: .responder, prologue: pro, localStatic: srv, remoteStatic: nil)
      let p1 = try rsp.readMessageA(hello.subdata(in: 6..<hello.count))
      guard let j1 = (try? JSONSerialization.jsonObject(with: p1)) as? [String: Any], j1["dev"] as? String == "d1",
            (j1["n"] as? String).flatMap({ Data(base64Encoded: $0) })?.count == 16 else { return "msg1 payload" }
      if rsp.remoteStatic != dev.publicKey.rawRepresentation { return "dev static" }
      let m2 = try rsp.writeMessageB(payload: Data("{\"v\":1,\"ok\":true,\"region\":\"mex\",\"kid\":\"t1\",\"bound\":\"bearer\",\"early_n\":0}".utf8))
      var st = try rsp.split()
      // servidor manda msg2 + 1 frame texto grande (vários registros) + ping, picotado em 7 bytes
      var wire = ChatyyQuicProto.u16(m2.count)
      wire.append(m2)
      let big = String(repeating: "x", count: 200_000)
      let bigFrame = ChatyyQuicProto.encodeFrame(.text, Data(("{\"type\":\"auth_success\",\"p\":\"" + big + "\"}").utf8))
      var off = 0
      while off < bigFrame.count {
        let end = min(bigFrame.count, off + 65519)
        let ct = try st.encrypt(bigFrame.subdata(in: off..<end))
        wire.append(ChatyyQuicProto.u16(ct.count)); wire.append(ct)
        off = end
      }
      let pingCt = try st.encrypt(ChatyyQuicProto.encodeFrame(.ping, Data("hb".utf8)))
      wire.append(ChatyyQuicProto.u16(pingCt.count)); wire.append(pingCt)
      let closeCt = try st.encrypt(ChatyyQuicProto.encodeFrame(.close, ChatyyQuicProto.closeBody(code: 4001, reason: "go_ws")))
      wire.append(ChatyyQuicProto.u16(closeCt.count)); wire.append(closeCt)
      var evs: [ChatyyQuicChannel.Event] = []
      var reply = Data()
      var i = 0
      while i < wire.count {
        let e = min(wire.count, i + 7)
        let r = try ch.receive(wire.subdata(in: i..<e))
        evs.append(contentsOf: r.events)
        reply.append(r.reply)
        i = e
      }
      guard evs.count == 3 else { return "events \(evs.count)" }
      if evs[0] != .ready(bound: "bearer") { return "ready" }
      guard case .text(let t) = evs[1], t.utf8.count == big.count + 30, t.hasSuffix("x\"}") else { return "big text" }
      if evs[2] != .close(4001, "go_ws") { return "close" }
      // pong de volta: servidor decifra
      let rl = (Int(reply[0]) << 8) | Int(reply[1])
      let pong = try st.decrypt(reply.subdata(in: 2..<(2 + rl)))
      if pong != ChatyyQuicProto.encodeFrame(.pong, Data("hb".utf8)) { return "pong" }
      // cliente → servidor: texto
      let out = try ch.sealText("{\"type\":\"auth\"}")
      let ol = (Int(out[0]) << 8) | Int(out[1])
      if try st.decrypt(out.subdata(in: 2..<(2 + ol))) != ChatyyQuicProto.encodeFrame(.text, Data("{\"type\":\"auth\"}".utf8)) { return "c2s" }
      // servidor com chave errada → msg2 não abre
      let ch2 = try ChatyyQuicChannel(region: "mex", kid: "t1", regionPub: Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation,
                                      deviceKey: dev, prologue: pro)
      let h2 = try ch2.clientHello(mode: ChatyyQuicProto.modeI, payload: Data("{}".utf8))
      let rsp2 = try ChatyyNoiseIK(hash: .blake2s, role: .responder, prologue: pro, localStatic: srv, remoteStatic: nil)
      if (try? rsp2.readMessageA(h2.subdata(in: 6..<h2.count))) != nil { return "wrong pin accepted" }
      // região diferente no msg2 → recusa
      let ch3 = try ChatyyQuicChannel(region: "mex", kid: "t1", regionPub: srv.publicKey.rawRepresentation, deviceKey: dev, prologue: pro)
      let h3 = try ch3.clientHello(mode: ChatyyQuicProto.modeI, payload: Data("{}".utf8))
      let rsp3 = try ChatyyNoiseIK(hash: .blake2s, role: .responder, prologue: pro, localStatic: srv, remoteStatic: nil)
      _ = try rsp3.readMessageA(h3.subdata(in: 6..<h3.count))
      let m3 = try rsp3.writeMessageB(payload: Data("{\"ok\":true,\"region\":\"br\"}".utf8))
      var w3 = ChatyyQuicProto.u16(m3.count); w3.append(m3)
      if (try? ch3.receive(w3)) != nil { return "region mismatch accepted" }
      // pinning: só t1 com noise_test
      if ChatyyQuicProto.pinnedKey(kid: "t1", testAllowed: false) != nil { return "pin without test" }
      if ChatyyQuicProto.pinnedKey(kid: "t2", testAllowed: true) != nil { return "pin unknown kid" }
      if ChatyyQuicProto.pinnedKey(kid: "t1", testAllowed: true)?.count != 32 { return "pin t1" }
      // chatyy/2: pin SPKI dos 2 certificados de TESTE (ponto P-256 extraído com openssl)
      let pt1 = ChatyyNoiseSelfTest.hex("0410128f33b8c73fbffffed322cb0df50fa9d6eadbf6a48971bdbb123691373bffa241335d4f6f9054fe9fad19b43ca4e5a22ff70e1f3b2c50831dfdd8ca3128b0")
      let pt2 = ChatyyNoiseSelfTest.hex("040cb2a209f9d0a2ebb6754d462fe9ce9a8588b29e4e2cf6259dc879e05f1ba606ce8a9d56c319f7812b3825b401c4f0c8757a028f55e14a22081b749005f3447a")
      if ChatyyQuicProto.spkiPinP256(point: pt1) != ChatyyQuicProto.testPins[0] { return "spki pin atual" }
      if ChatyyQuicProto.spkiPinP256(point: pt2) != ChatyyQuicProto.testPins[1] { return "spki pin próximo" }
      if ChatyyQuicProto.spkiPinP256(point: pt1.subdata(in: 0..<64)) != nil { return "spki pin tamanho" }
      // chatyy/2 modo I: preâmbulo 0x02, prólogo "chatyy/2", frames dentro da msg1
      let pro2 = ChatyyQuicProto.prologue(region: "mex", kid: "t1", wire: ChatyyQuicProto.wireQuic,
                                          mode: ChatyyQuicProto.modeI, binding: binding, proto: "chatyy/2")
      if pro2.prefix(9) != Data("chatyy/2\u{0}".utf8) { return "prologue v2" }
      let ch4 = try ChatyyQuicChannel(region: "mex", kid: "t1", regionPub: srv.publicKey.rawRepresentation, deviceKey: dev, prologue: pro2)
      let h4 = try ch4.clientHello(mode: ChatyyQuicProto.modeI, payload: ChatyyQuicChannel.helloPayload(
        dev: "d1", ua: "t", nowMs: 1, version: 2, frames: ["{\"type\":\"auth\"}"]), version: 2)
      if h4.prefix(4) != Data([0x43, 0x59, 0x02, 0x49]) { return "preamble v2" }
      let rsp4 = try ChatyyNoiseIK(hash: .blake2s, role: .responder, prologue: pro2, localStatic: srv, remoteStatic: nil)
      let p4 = try rsp4.readMessageA(h4.subdata(in: 6..<h4.count))
      guard let j4 = (try? JSONSerialization.jsonObject(with: p4)) as? [String: Any], (j4["v"] as? Int) == 2,
            (j4["frames"] as? [String])?.first == "{\"type\":\"auth\"}" else { return "msg1 v2 payload" }
      let m4 = try rsp4.writeMessageB(payload: Data("{\"v\":2,\"ok\":true,\"region\":\"mex\",\"kid\":\"t1\",\"bound\":\"bearer\",\"early_n\":1}".utf8))
      var st4 = try rsp4.split()
      var w4 = ChatyyQuicProto.u16(m4.count); w4.append(m4)
      let as4 = try st4.encrypt(ChatyyQuicProto.encodeFrame(.text, Data("{\"type\":\"auth_success\"}".utf8)))
      w4.append(ChatyyQuicProto.u16(as4.count)); w4.append(as4)
      let r4 = try ch4.receive(w4)
      if r4.events != [.ready(bound: "bearer"), .text("{\"type\":\"auth_success\"}")] || ch4.serverHello?.earlyN != 1 { return "msg2 v2 + auth_success" }
      return nil
    } catch {
      return "throw \(error)"
    }
  }
}
