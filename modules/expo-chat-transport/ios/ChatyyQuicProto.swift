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

  /// Pinning: kid → chave pública de 32 bytes. Hoje SÓ a de teste existe; produção
  /// (certificado assinado pela raiz Ed25519, F-N1) entra aqui com outro kid.
  static func pinnedKey(kid: String, testAllowed: Bool) -> Data? {
    if kid == testKid && testAllowed {
      guard let d = Data(base64Encoded: testRegionPubB64), d.count == 32 else { return nil }
      return d
    }
    return nil
  }

  /// §2 preâmbulo: "CY" | versão 0x01 | modo.
  static func preamble(mode: UInt8) -> Data {
    return Data([0x43, 0x59, 0x01, mode])
  }

  /// §4.2: "chatyy/1" 0x00 | região 0x00 | kid 0x00 | fio | modo | binding.
  static func prologue(region: String, kid: String, wire: UInt8, mode: UInt8, binding: Data) -> Data {
    var d = Data("chatyy/1".utf8)
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
  func clientHello(mode: UInt8, payload: Data) throws -> Data {
    if helloSent { throw ChatyyNoiseError.wrongState("hello twice") }
    if payload.count > ChatyyQuicProto.maxHelloPayload { throw ChatyyQuicChannelError.tooBig }
    let m1 = try ik.writeMessageA(payload: payload)
    helloSent = true
    var out = ChatyyQuicProto.preamble(mode: mode)
    out.append(ChatyyQuicProto.u16(m1.count))
    out.append(m1)
    return out
  }

  /// JSON da msg1: {"v":1,"dev","ts","n","ua"} — `n` novo a cada tentativa (anti-replay §5).
  static func helloPayload(dev: String, ua: String, nowMs: Double) -> Data {
    let obj: [String: Any] = [
      "v": 1,
      "dev": dev,
      "ts": Int64(nowMs),
      "n": ChatyyQuicProto.randomBytes(16).base64EncodedString(),
      "ua": ua,
    ]
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

// MARK: - autoteste de ida e volta (servidor simulado com o respondedor IK)

enum ChatyyQuicSelfTest {
  /// nil = passou. Usa o respondedor do ChatyyNoiseIK como "leaf" de mentira.
  static func run() -> String? {
    if let e = ChatyyNoiseSelfTest.run() { return "noise: " + e }
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
      return nil
    } catch {
      return "throw \(error)"
    }
  }
}
