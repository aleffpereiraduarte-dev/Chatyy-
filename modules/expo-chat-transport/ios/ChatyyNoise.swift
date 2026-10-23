import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto // swift-crypto (mesma API) — só p/ rodar os vetores fora do iOS
#endif

// [2026-10-23 quic-proto] Noise Protocol Framework rev 34 — SÓ o necessário para
// o padrão IK com X25519 + ChaChaPoly e hash SHA-256 ou BLAKE2s. O contrato
// (/root/quic-noise-2026-10-23/PROTOCOLO.md §4.1) fixa
//     Noise_IK_25519_ChaChaPoly_BLAKE2s
// (servidor flynn/noise, Android snow). SHA-256 fica só no autoteste.
//
// Nada de cripto própria: X25519, ChaCha20-Poly1305, SHA-256 = CryptoKit.
// BLAKE2s = transcrição direta do RFC 7693 (§2.7 compressão F, §3.2 G, IV/SIGMA
// §2.6–2.7), conferida pelo vetor "abc" do RFC (Apêndice B) + vetores Noise.
// HMAC = RFC 2104 com BLOCKLEN 64 (o Noise §4.3 usa HMAC-HASH com a hash crua, não
// o modo com chave do BLAKE2). Cada função cita a seção da spec Noise
// (https://noiseprotocol.org/noise.html, revision 34, 2018-07-11).
//
// IK (§7.5):   <- s
//              ...
//              -> e, es, s, ss
//              <- e, ee, se
//
// Sem PSK, sem REKEY, sem fallback XX (F-N2). Autoteste: ChatyyNoiseSelfTest.

enum ChatyyNoiseError: Error, Equatable {
  case nonceExhausted
  case decryptFailed
  case badMessage(String)
  case badKey
  case wrongState(String)
}

// MARK: - BLAKE2s (RFC 7693), saída de 32 bytes, sem chave

enum ChatyyBlake2s {
  // RFC 7693 §2.6 (IV = o mesmo do SHA-256)
  private static let iv: [UInt32] = [
    0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
    0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
  ]
  // RFC 7693 §2.7 (SIGMA; BLAKE2s usa as 10 primeiras linhas)
  private static let sigma: [[Int]] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  ]

  @inline(__always) private static func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 {
    return (x >> n) | (x << (32 - n))
  }

  /// RFC 7693 §3.1 G (BLAKE2s: R1..R4 = 16, 12, 8, 7).
  @inline(__always) private static func g(_ v: inout [UInt32], _ a: Int, _ b: Int, _ c: Int, _ d: Int, _ x: UInt32, _ y: UInt32) {
    v[a] = v[a] &+ v[b] &+ x
    v[d] = rotr(v[d] ^ v[a], 16)
    v[c] = v[c] &+ v[d]
    v[b] = rotr(v[b] ^ v[c], 12)
    v[a] = v[a] &+ v[b] &+ y
    v[d] = rotr(v[d] ^ v[a], 8)
    v[c] = v[c] &+ v[d]
    v[b] = rotr(v[b] ^ v[c], 7)
  }

  /// RFC 7693 §3.2 F(h, m, t, f).
  private static func compress(_ h: inout [UInt32], _ block: [UInt8], _ t: UInt64, _ last: Bool) {
    var m = [UInt32](repeating: 0, count: 16)
    for i in 0..<16 {
      let o = i * 4
      m[i] = UInt32(block[o]) | (UInt32(block[o + 1]) << 8) | (UInt32(block[o + 2]) << 16) | (UInt32(block[o + 3]) << 24)
    }
    var v = [UInt32](repeating: 0, count: 16)
    for i in 0..<8 {
      v[i] = h[i]
      v[i + 8] = iv[i]
    }
    v[12] ^= UInt32(truncatingIfNeeded: t)
    v[13] ^= UInt32(truncatingIfNeeded: t >> 32)
    if last { v[14] = ~v[14] }
    for r in 0..<10 {
      let s = sigma[r]
      g(&v, 0, 4, 8, 12, m[s[0]], m[s[1]])
      g(&v, 1, 5, 9, 13, m[s[2]], m[s[3]])
      g(&v, 2, 6, 10, 14, m[s[4]], m[s[5]])
      g(&v, 3, 7, 11, 15, m[s[6]], m[s[7]])
      g(&v, 0, 5, 10, 15, m[s[8]], m[s[9]])
      g(&v, 1, 6, 11, 12, m[s[10]], m[s[11]])
      g(&v, 2, 7, 8, 13, m[s[12]], m[s[13]])
      g(&v, 3, 4, 9, 14, m[s[14]], m[s[15]])
    }
    for i in 0..<8 { h[i] ^= v[i] ^ v[i + 8] }
  }

  /// RFC 7693 §3.3 BLAKE2s(d, ll, kk=0, nn=32).
  static func hash(_ data: Data) -> Data {
    var h = iv
    h[0] ^= 0x0101_0000 ^ 32 // parâmetro: fanout 1, depth 1, kk 0, nn 32
    let bytes = [UInt8](data)
    let n = bytes.count
    var off = 0
    // Todos os blocos menos o último (o último pode estar cheio: vai com f=1).
    while n - off > 64 {
      compress(&h, Array(bytes[off..<(off + 64)]), UInt64(off + 64), false)
      off += 64
    }
    var last = [UInt8](repeating: 0, count: 64)
    if n > off {
      for i in 0..<(n - off) { last[i] = bytes[off + i] }
    }
    compress(&h, last, UInt64(n), true)
    var out = Data(capacity: 32)
    for w in h {
      out.append(UInt8(truncatingIfNeeded: w))
      out.append(UInt8(truncatingIfNeeded: w >> 8))
      out.append(UInt8(truncatingIfNeeded: w >> 16))
      out.append(UInt8(truncatingIfNeeded: w >> 24))
    }
    return out
  }
}

// MARK: - primitivas (§4)

enum ChatyyNoiseHash {
  case sha256
  case blake2s

  var name: String {
    switch self {
    case .sha256: return "SHA256"
    case .blake2s: return "BLAKE2s"
    }
  }

  var protocolName: String { return "Noise_IK_25519_ChaChaPoly_" + name }

  /// §4.3 HASH (HASHLEN 32, BLOCKLEN 64 nas duas).
  func hash(_ d: Data) -> Data {
    switch self {
    case .sha256: return Data(SHA256.hash(data: d))
    case .blake2s: return ChatyyBlake2s.hash(d)
    }
  }

  /// §4.3 HMAC-HASH(key, data) — RFC 2104 com BLOCKLEN 64.
  func hmac(_ key: Data, _ data: Data) -> Data {
    let block = 64
    var k = [UInt8](key.count > block ? hash(key) : key)
    if k.count < block { k.append(contentsOf: [UInt8](repeating: 0, count: block - k.count)) }
    var inner = Data(k.map { $0 ^ 0x36 })
    inner.append(data)
    var outer = Data(k.map { $0 ^ 0x5c })
    outer.append(hash(inner))
    return hash(outer)
  }

  /// §4.3 HKDF(chaining_key, input_key_material, 2):
  ///   temp_key = HMAC(ck, ikm); out1 = HMAC(temp_key, 0x01); out2 = HMAC(temp_key, out1 || 0x02)
  func hkdf2(_ chainingKey: Data, _ ikm: Data) -> (Data, Data) {
    let tempKey = hmac(chainingKey, ikm)
    let out1 = hmac(tempKey, Data([0x01]))
    var b = out1
    b.append(0x02)
    let out2 = hmac(tempKey, b)
    return (out1, out2)
  }
}

enum ChatyyNoiseCrypto {
  static let dhLen = 32
  static let hashLen = 32
  static let tagLen = 16
  /// §3: mensagem Noise ≤ 65535 bytes.
  static let maxMessageLen = 65535

  // §4.1 DH(key_pair, public_key) — X25519. CryptoKit lança em ponto de ordem baixa
  // (saída toda zero): tratamos como falha do handshake (a spec permite rejeitar).
  static func dh(_ priv: Curve25519.KeyAgreement.PrivateKey, _ pub: Data) throws -> Data {
    guard pub.count == dhLen else { throw ChatyyNoiseError.badKey }
    let pk: Curve25519.KeyAgreement.PublicKey
    do { pk = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: pub) } catch { throw ChatyyNoiseError.badKey }
    let ss: SharedSecret
    do { ss = try priv.sharedSecretFromKeyAgreement(with: pk) } catch { throw ChatyyNoiseError.badKey }
    let out: Data = ss.withUnsafeBytes { Data($0) }
    guard out.count == dhLen else { throw ChatyyNoiseError.badKey }
    return out
  }

  /// §4.2: nonce de 96 bits = 32 bits zero || n (64 bits little-endian).
  static func nonce(_ n: UInt64) -> ChaChaPoly.Nonce {
    var b = Data(count: 4)
    var le = n.littleEndian
    withUnsafeBytes(of: &le) { b.append(contentsOf: $0) }
    // 12 bytes exatos → nunca lança.
    return try! ChaChaPoly.Nonce(data: b)
  }

  /// §4.2 ENCRYPT(k, n, ad, plaintext) → ciphertext || tag(16).
  static func encrypt(_ k: Data, _ n: UInt64, _ ad: Data, _ pt: Data) throws -> Data {
    let box = try ChaChaPoly.seal(pt, using: SymmetricKey(data: k), nonce: nonce(n), authenticating: ad)
    var out = Data(box.ciphertext)
    out.append(Data(box.tag))
    return out
  }

  /// §4.2 DECRYPT(k, n, ad, ciphertext) — falha de autenticação → decryptFailed.
  static func decrypt(_ k: Data, _ n: UInt64, _ ad: Data, _ ct: Data) throws -> Data {
    guard ct.count >= tagLen else { throw ChatyyNoiseError.decryptFailed }
    let c = Data(ct) // índices a partir de 0 (ct pode ser fatia)
    let body = c.subdata(in: 0..<(c.count - tagLen))
    let tag = c.subdata(in: (c.count - tagLen)..<c.count)
    do {
      let box = try ChaChaPoly.SealedBox(nonce: nonce(n), ciphertext: body, tag: tag)
      return Data(try ChaChaPoly.open(box, using: SymmetricKey(data: k), authenticating: ad))
    } catch {
      throw ChatyyNoiseError.decryptFailed
    }
  }
}

// MARK: - §5.1 CipherState

struct ChatyyNoiseCipherState {
  private(set) var k: Data? = nil
  private(set) var n: UInt64 = 0

  mutating func initializeKey(_ key: Data?) {
    k = key
    n = 0
  }

  var hasKey: Bool { return k != nil }

  /// §5.1 EncryptWithAd: sem chave devolve o texto puro. n = 2^64-1 é reservado.
  mutating func encryptWithAd(_ ad: Data, _ pt: Data) throws -> Data {
    guard let key = k else { return pt }
    if n == UInt64.max { throw ChatyyNoiseError.nonceExhausted }
    let c = try ChatyyNoiseCrypto.encrypt(key, n, ad, pt)
    n += 1
    return c
  }

  /// §5.1 DecryptWithAd: falha de autenticação NÃO incrementa n.
  mutating func decryptWithAd(_ ad: Data, _ ct: Data) throws -> Data {
    guard let key = k else { return ct }
    if n == UInt64.max { throw ChatyyNoiseError.nonceExhausted }
    let p = try ChatyyNoiseCrypto.decrypt(key, n, ad, ct)
    n += 1
    return p
  }
}

// MARK: - §5.2 SymmetricState

struct ChatyyNoiseSymmetricState {
  let hashFn: ChatyyNoiseHash
  private(set) var cs = ChatyyNoiseCipherState()
  private(set) var ck: Data
  private(set) var h: Data

  /// §5.2 InitializeSymmetric(protocol_name): ≤ HASHLEN → completa com zeros; senão HASH.
  init(hash: ChatyyNoiseHash) {
    hashFn = hash
    let name = Data(hash.protocolName.utf8)
    if name.count <= ChatyyNoiseCrypto.hashLen {
      var p = name
      p.append(Data(count: ChatyyNoiseCrypto.hashLen - name.count))
      h = p
    } else {
      h = hash.hash(name)
    }
    ck = h
    cs.initializeKey(nil)
  }

  /// §5.2 MixKey: ck, temp_k = HKDF(ck, ikm, 2); HASHLEN 32 → sem truncar.
  mutating func mixKey(_ ikm: Data) {
    let (a, b) = hashFn.hkdf2(ck, ikm)
    ck = a
    cs.initializeKey(b)
  }

  /// §5.2 MixHash: h = HASH(h || data).
  mutating func mixHash(_ data: Data) {
    var x = h
    x.append(data)
    h = hashFn.hash(x)
  }

  /// §5.2 EncryptAndHash: ciphertext = EncryptWithAd(h, pt); MixHash(ciphertext).
  mutating func encryptAndHash(_ pt: Data) throws -> Data {
    let c = try cs.encryptWithAd(h, pt)
    mixHash(c)
    return c
  }

  /// §5.2 DecryptAndHash: pt = DecryptWithAd(h, ct); MixHash(ct).
  mutating func decryptAndHash(_ ct: Data) throws -> Data {
    let p = try cs.decryptWithAd(h, ct)
    mixHash(ct)
    return p
  }

  /// §5.2 Split: temp_k1, temp_k2 = HKDF(ck, zerolen, 2).
  func split() -> (ChatyyNoiseCipherState, ChatyyNoiseCipherState) {
    let (a, b) = hashFn.hkdf2(ck, Data())
    var c1 = ChatyyNoiseCipherState()
    var c2 = ChatyyNoiseCipherState()
    c1.initializeKey(a)
    c2.initializeKey(b)
    return (c1, c2)
  }
}

/// Par de CipherStates depois do handshake, já orientado pelo papel.
struct ChatyyNoiseTransport {
  var send: ChatyyNoiseCipherState
  var recv: ChatyyNoiseCipherState
  /// §11.2 channel binding (h final).
  let handshakeHash: Data

  /// Plaintext máximo por mensagem de transporte (65535 − 16).
  static let maxPlaintext = ChatyyNoiseCrypto.maxMessageLen - ChatyyNoiseCrypto.tagLen

  /// Mensagem de transporte (§5.3: ad vazio).
  mutating func encrypt(_ pt: Data) throws -> Data {
    if pt.count > ChatyyNoiseTransport.maxPlaintext { throw ChatyyNoiseError.badMessage("too_long") }
    return try send.encryptWithAd(Data(), pt)
  }

  mutating func decrypt(_ ct: Data) throws -> Data {
    if ct.count > ChatyyNoiseCrypto.maxMessageLen { throw ChatyyNoiseError.badMessage("too_long") }
    return try recv.decryptWithAd(Data(), ct)
  }
}

// MARK: - §5.3 HandshakeState especializado no padrão IK (2 mensagens)

final class ChatyyNoiseIK {
  enum Role { case initiator, responder }

  let role: Role
  private var ss: ChatyyNoiseSymmetricState
  private let s: Curve25519.KeyAgreement.PrivateKey
  private var e: Curve25519.KeyAgreement.PrivateKey?
  private var rs: Data?
  private var re: Data?
  /// 0 = msg A pendente (-> e, es, s, ss); 1 = msg B pendente (<- e, ee, se); 2 = pronto.
  private var step = 0
  /// Só autoteste: efêmera fixa dos vetores.
  private let fixedEphemeral: Curve25519.KeyAgreement.PrivateKey?

  var handshakeHash: Data { return ss.h }
  var isComplete: Bool { return step == 2 }
  /// Chave estática remota (no respondedor: a do iniciador, conhecida após a msg A).
  var remoteStatic: Data? { return rs }

  /// §5.3 Initialize: InitializeSymmetric(nome); MixHash(prologue); pré-mensagem
  /// "<- s" → MixHash(chave pública estática do respondedor) nos DOIS lados (§7.1).
  init(hash: ChatyyNoiseHash, role: Role, prologue: Data, localStatic: Curve25519.KeyAgreement.PrivateKey,
       remoteStatic: Data?, fixedEphemeral: Curve25519.KeyAgreement.PrivateKey? = nil) throws {
    self.role = role
    self.s = localStatic
    self.fixedEphemeral = fixedEphemeral
    ss = ChatyyNoiseSymmetricState(hash: hash)
    ss.mixHash(prologue)
    switch role {
    case .initiator:
      guard let r = remoteStatic, r.count == ChatyyNoiseCrypto.dhLen else { throw ChatyyNoiseError.badKey }
      rs = Data(r)
      ss.mixHash(Data(r))
    case .responder:
      ss.mixHash(localStatic.publicKey.rawRepresentation)
    }
  }

  private func newEphemeral() -> Curve25519.KeyAgreement.PrivateKey {
    return fixedEphemeral ?? Curve25519.KeyAgreement.PrivateKey()
  }

  // MARK: msg A  -> e, es, s, ss  (+ payload)

  func writeMessageA(payload: Data) throws -> Data {
    guard role == .initiator, step == 0, let rsk = rs else { throw ChatyyNoiseError.wrongState("writeA") }
    var out = Data()
    // e
    let eph = newEphemeral()
    e = eph
    let ePub = eph.publicKey.rawRepresentation
    out.append(ePub)
    ss.mixHash(ePub)
    // es (iniciador: DH(e, rs))
    ss.mixKey(try ChatyyNoiseCrypto.dh(eph, rsk))
    // s
    out.append(try ss.encryptAndHash(s.publicKey.rawRepresentation))
    // ss (DH(s, rs))
    ss.mixKey(try ChatyyNoiseCrypto.dh(s, rsk))
    out.append(try ss.encryptAndHash(payload))
    if out.count > ChatyyNoiseCrypto.maxMessageLen { throw ChatyyNoiseError.badMessage("too_long") }
    step = 1
    return out
  }

  func readMessageA(_ msgIn: Data) throws -> Data {
    guard role == .responder, step == 0 else { throw ChatyyNoiseError.wrongState("readA") }
    let msg = Data(msgIn)
    let dl = ChatyyNoiseCrypto.dhLen
    let tl = ChatyyNoiseCrypto.tagLen
    guard msg.count >= dl + dl + tl + tl, msg.count <= ChatyyNoiseCrypto.maxMessageLen else { throw ChatyyNoiseError.badMessage("len") }
    // e
    let rePub = msg.subdata(in: 0..<dl)
    re = rePub
    ss.mixHash(rePub)
    // es (respondedor: DH(s, re))
    ss.mixKey(try ChatyyNoiseCrypto.dh(s, rePub))
    // s (cifrada: DHLEN + 16, pois já há chave)
    let rsPub = try ss.decryptAndHash(msg.subdata(in: dl..<(dl + dl + tl)))
    rs = rsPub
    // ss
    ss.mixKey(try ChatyyNoiseCrypto.dh(s, rsPub))
    let p = try ss.decryptAndHash(msg.subdata(in: (dl + dl + tl)..<msg.count))
    step = 1
    return p
  }

  // MARK: msg B  <- e, ee, se  (+ payload)

  func writeMessageB(payload: Data) throws -> Data {
    guard role == .responder, step == 1, let reK = re, let rsK = rs else { throw ChatyyNoiseError.wrongState("writeB") }
    var out = Data()
    let eph = newEphemeral()
    e = eph
    let ePub = eph.publicKey.rawRepresentation
    out.append(ePub)
    ss.mixHash(ePub)
    // ee
    ss.mixKey(try ChatyyNoiseCrypto.dh(eph, reK))
    // se (respondedor: DH(e, rs))
    ss.mixKey(try ChatyyNoiseCrypto.dh(eph, rsK))
    out.append(try ss.encryptAndHash(payload))
    if out.count > ChatyyNoiseCrypto.maxMessageLen { throw ChatyyNoiseError.badMessage("too_long") }
    step = 2
    return out
  }

  func readMessageB(_ msgIn: Data) throws -> Data {
    guard role == .initiator, step == 1, let eph = e else { throw ChatyyNoiseError.wrongState("readB") }
    let msg = Data(msgIn)
    let dl = ChatyyNoiseCrypto.dhLen
    guard msg.count >= dl + ChatyyNoiseCrypto.tagLen, msg.count <= ChatyyNoiseCrypto.maxMessageLen else { throw ChatyyNoiseError.badMessage("len") }
    let rePub = msg.subdata(in: 0..<dl)
    re = rePub
    ss.mixHash(rePub)
    // ee
    ss.mixKey(try ChatyyNoiseCrypto.dh(eph, rePub))
    // se (iniciador: DH(s, re))
    ss.mixKey(try ChatyyNoiseCrypto.dh(s, rePub))
    let p = try ss.decryptAndHash(msg.subdata(in: dl..<msg.count))
    step = 2
    return p
  }

  /// §5.2 Split, orientado: iniciador envia com c1 e recebe com c2; respondedor o inverso.
  func split() throws -> ChatyyNoiseTransport {
    guard step == 2 else { throw ChatyyNoiseError.wrongState("split") }
    let (c1, c2) = ss.split()
    e = nil // efêmera não serve mais
    switch role {
    case .initiator: return ChatyyNoiseTransport(send: c1, recv: c2, handshakeHash: ss.h)
    case .responder: return ChatyyNoiseTransport(send: c2, recv: c1, handshakeHash: ss.h)
    }
  }
}

// MARK: - autoteste (vetores)

/// Vetores Noise_IK_25519_ChaChaPoly_{BLAKE2s,SHA256} da suíte "cacophony" (a que o
/// snow e o flynn/noise usam; snow tests/vectors/cacophony.txt). Prólogo "John Galt".
/// Roda os DOIS papéis, confere cada ciphertext, o handshake_hash e 4 mensagens de
/// transporte alternadas; e mais: BLAKE2s("abc") e BLAKE2s("") do RFC 7693, adulteração.
enum ChatyyNoiseSelfTest {
  struct Vector {
    let hash: ChatyyNoiseHash
    let handshakeHash: String
    let messages: [(payload: String, ciphertext: String)]
  }

  // Chaves comuns aos dois vetores (cacophony usa as mesmas em todos os padrões).
  static let prologue = "4a6f686e2047616c74"
  static let initStatic = "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1"
  static let initEphemeral = "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a"
  static let respStatic = "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893"
  static let respEphemeral = "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b"
  static let initRemoteStatic = "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62"
  static let payloads = [
    "4c756477696720766f6e204d69736573", "4d757272617920526f746862617264", "462e20412e20486179656b",
    "4361726c204d656e676572", "4a65616e2d426170746973746520536179", "457567656e2042f6686d20766f6e2042617765726b",
  ]

  static let blake2s = Vector(
    hash: .blake2s,
    handshakeHash: "48f3cb8bc9319da4ba1e9933991b1c4ed4034f1f126a76d3a1fbcfd7f94248d4",
    messages: [
      (payloads[0], "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79440b03ddc7aac5123d06a1b23b71670e32e76c28239a7ca4ac8f784de7e44c1adbfc6e83fef7352a58d9d56157400c0a737b1d171ce368229c7b752ac25b8faf4eca690f6d896f543be02c996ab2b86b76"),
      (payloads[1], "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843d9b5a8927f0ac9655ef76833bc7e5561f42e691ac8404efd6fbd6308b6a27c"),
      (payloads[2], "2c256ed08fcd08c2980f954ee4beaccb61c9581340f5dd2fd1cf3b"),
      (payloads[3], "d6033f70eee20945c7c9dba304e397ee3b284ff5e00fd9efb095d3"),
      (payloads[4], "a9c068ca5d8babf72560652d8e851adbfac35c8a66e810d560863173e96adf4cfe"),
      (payloads[5], "2a09d8f459e5927e40fdd2eddc99bdafb04e13a26f145cb5cfe9e6ba34c94331ebc17d5156"),
    ]
  )

  static let sha256 = Vector(
    hash: .sha256,
    handshakeHash: "0b0f68fb0c27e03ce9b97565995ed4838cc0581b762ef72b062f6a546419fad7",
    messages: [
      (payloads[0], "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944718da798efbcd91528520204f904b9bd6c7413dccdc214d951e15253e39987f18146e8cd0873654207148333479d4d16c289f0294b29960a72f48e0b7bba2e89083169825e59642148d492020664ccf7"),
      (payloads[1], "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088435361e70b2ed446e6c9ec387d1d6b3b840f194e373979d241b203c4acafccf5"),
      (payloads[2], "050e9f3c8fac16b68dbce8f8c4bfbf6617c897f9ada4aa29aa19c8"),
      (payloads[3], "344233a6cabb7141d80f3da2fedc311d9646bbb0f505afe403a667"),
      (payloads[4], "62cdeeb172ad7ade7aa7d9e069da5790f12331bfa00177787a1d0810c67dc3b2b4"),
      (payloads[5], "029bead1b40992327044d409d9a1f3ad8f36c3c452775d557e18bbeb2e8dfcead32d514024"),
    ]
  )

  static func hex(_ s: String) -> Data {
    var out = Data()
    var it = s.unicodeScalars.makeIterator()
    func nib(_ c: Unicode.Scalar) -> UInt8? {
      switch c.value {
      case 48...57: return UInt8(c.value - 48)
      case 97...102: return UInt8(c.value - 87)
      case 65...70: return UInt8(c.value - 55)
      default: return nil
      }
    }
    while let a = it.next() {
      guard let b = it.next(), let hi = nib(a), let lo = nib(b) else { return Data() }
      out.append(hi << 4 | lo)
    }
    return out
  }

  static func toHex(_ d: Data) -> String {
    return d.map { String(format: "%02x", $0) }.joined()
  }

  /// nil = passou; senão a 1ª divergência.
  static func run() -> String? {
    // RFC 7693 Apêndice B + vetor do conjunto oficial (mensagem vazia).
    if toHex(ChatyyBlake2s.hash(Data("abc".utf8))) != "508c5e8c327c14e2e1a72ba34eeb452f37458b209ed63a294d999b4c86675982" { return "blake2s abc" }
    if toHex(ChatyyBlake2s.hash(Data())) != "69217a3079908094e11121d042354a7c1f55b6482ca1a51e1b250dfd1ed0eef9" { return "blake2s empty" }
    // HMAC manual × CryptoKit (SHA-256) com chave curta e longa.
    for klen in [20, 64, 131] {
      let key = Data((0..<klen).map { UInt8($0 & 0xff) })
      let msg = Data("chatyy hmac".utf8)
      let ref = Data(HMAC<SHA256>.authenticationCode(for: msg, using: SymmetricKey(data: key)))
      if ChatyyNoiseHash.sha256.hmac(key, msg) != ref { return "hmac sha256 k\(klen)" }
    }
    // Blocos: 64 e 65 bytes (fronteira do último bloco) — só não pode lançar/travar.
    _ = ChatyyBlake2s.hash(Data(repeating: 0x61, count: 64))
    _ = ChatyyBlake2s.hash(Data(repeating: 0x61, count: 65))
    for v in [blake2s, sha256] {
      if let err = runVector(v) { return v.hash.name + " " + err }
    }
    return nil
  }

  static func runVector(_ v: Vector) -> String? {
    do {
      let iS = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(initStatic))
      let iE = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(initEphemeral))
      let rS = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(respStatic))
      let rE = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(respEphemeral))
      if toHex(rS.publicKey.rawRepresentation) != initRemoteStatic { return "resp static pub" }
      let pro = hex(prologue)
      let ini = try ChatyyNoiseIK(hash: v.hash, role: .initiator, prologue: pro, localStatic: iS,
                                  remoteStatic: rS.publicKey.rawRepresentation, fixedEphemeral: iE)
      let rsp = try ChatyyNoiseIK(hash: v.hash, role: .responder, prologue: pro, localStatic: rS,
                                  remoteStatic: nil, fixedEphemeral: rE)
      // msg 0: iniciador → respondedor
      let m0 = try ini.writeMessageA(payload: hex(v.messages[0].payload))
      if toHex(m0) != v.messages[0].ciphertext { return "msg0 ct" }
      let p0 = try rsp.readMessageA(m0)
      if toHex(p0) != v.messages[0].payload { return "msg0 pt" }
      if rsp.remoteStatic != iS.publicKey.rawRepresentation { return "msg0 rs" }
      // msg 1: respondedor → iniciador
      let m1 = try rsp.writeMessageB(payload: hex(v.messages[1].payload))
      if toHex(m1) != v.messages[1].ciphertext { return "msg1 ct" }
      let p1 = try ini.readMessageB(m1)
      if toHex(p1) != v.messages[1].payload { return "msg1 pt" }
      if toHex(ini.handshakeHash) != v.handshakeHash { return "hash ini" }
      if toHex(rsp.handshakeHash) != v.handshakeHash { return "hash rsp" }
      var ti = try ini.split()
      var tr = try rsp.split()
      // transporte: alterna a partir do iniciador (msg 2 = ini→rsp, 3 = rsp→ini …)
      for i in 2..<v.messages.count {
        let m = v.messages[i]
        let fromInit = i % 2 == 0
        let ct = fromInit ? try ti.encrypt(hex(m.payload)) : try tr.encrypt(hex(m.payload))
        if toHex(ct) != m.ciphertext { return "msg\(i) ct" }
        let pt = fromInit ? try tr.decrypt(ct) : try ti.decrypt(ct)
        if toHex(pt) != m.payload { return "msg\(i) pt" }
      }
      // negativo: 1 bit trocado não abre e NÃO consome o nonce (§5.1)
      var bad = try ti.encrypt(Data("x".utf8))
      bad[bad.startIndex] ^= 0x01
      if (try? tr.decrypt(bad)) != nil { return "tamper accepted" }
      bad[bad.startIndex] ^= 0x01
      if (try? tr.decrypt(bad)) != Data("x".utf8) { return "nonce after tamper" }
      // negativo: msg A com 1 bit trocado na estática cifrada não abre
      let ini2 = try ChatyyNoiseIK(hash: v.hash, role: .initiator, prologue: pro, localStatic: iS,
                                   remoteStatic: rS.publicKey.rawRepresentation)
      var a2 = try ini2.writeMessageA(payload: Data())
      a2[a2.startIndex + 40] ^= 0x80
      let rsp2 = try ChatyyNoiseIK(hash: v.hash, role: .responder, prologue: pro, localStatic: rS, remoteStatic: nil)
      if (try? rsp2.readMessageA(a2)) != nil { return "tampered msgA accepted" }
      // negativo: prólogo diferente → respondedor não abre
      let ini3 = try ChatyyNoiseIK(hash: v.hash, role: .initiator, prologue: pro, localStatic: iS,
                                   remoteStatic: rS.publicKey.rawRepresentation)
      let a3 = try ini3.writeMessageA(payload: Data())
      let rsp3 = try ChatyyNoiseIK(hash: v.hash, role: .responder, prologue: Data("outro".utf8), localStatic: rS, remoteStatic: nil)
      if (try? rsp3.readMessageA(a3)) != nil { return "prologue mismatch accepted" }
      return nil
    } catch {
      return "throw \(error)"
    }
  }
}
