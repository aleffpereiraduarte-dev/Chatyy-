// [cbin 2026-10-24] "cbin v1" — fio binário compacto do Chatyy (estilo FunXMPP do WhatsApp), lado iOS.
// Porta 1:1 do Go chatyy-ws/cbin (/root/cbin-2026-10-24/go/cbin) e do ChatyyCbin.kt: transcodifica SEM PERDA
// texto JSON ↔ bytes. encode(json) → Data? (nil = mande o JSON); decode(Data) → String? (JSON canônico; nil = inválido).
// Dicionário: ChatyyCbinDict (gerado, versionado + hash). Contrato: /root/cbin-2026-10-24/CBIN.md.
// Só é usado depois do cbin_hello → cbin_ok (ChatTransport), com a flag do JS ligada.
import Foundation

enum ChatyyCbin {
  static let version = ChatyyCbinDict.version
  static let dictHash = ChatyyCbinDict.hash

  private static let tNull: UInt8 = 0x00, tFalse: UInt8 = 0x01, tTrue: UInt8 = 0x02, tUint: UInt8 = 0x03
  private static let tNeg: UInt8 = 0x04, tNumLit: UInt8 = 0x05, tStr: UInt8 = 0x06, tVal: UInt8 = 0x07
  private static let tDec: UInt8 = 0x08, tB64: UInt8 = 0x09, tB64URL: UInt8 = 0x0A, tHex: UInt8 = 0x0B
  private static let tUUID: UInt8 = 0x0C, tArr: UInt8 = 0x0D, tObj: UInt8 = 0x0E, tEmail: UInt8 = 0x0F
  private static let tJSONStr: UInt8 = 0x10, tTime: UInt8 = 0x11, tPfx: UInt8 = 0x12, tB64Raw: UInt8 = 0x13
  private static let tShort: UInt8 = 0x20, tSmall: UInt8 = 0x40, tValInl: UInt8 = 0x80
  private static let maxFrame = 1 << 20
  private static let maxDepth = 64

  private static func index(_ a: [String]) -> [String: Int] { var m = [String: Int](); for (i, s) in a.enumerated() where m[s] == nil { m[s] = i }; return m }
  private static let typeIdx = index(ChatyyCbinDict.types)
  private static let keyIdx = index(ChatyyCbinDict.keys)
  private static let valIdx = index(ChatyyCbinDict.vals)
  private static let domIdx = index(ChatyyCbinDict.doms)
  private static let pfxBytes: [[UInt8]] = ChatyyCbinDict.pfx.map { Array($0.utf8) }
  private static let u64MaxStr: [UInt8] = Array("18446744073709551615".utf8)

  struct Bad: Error {}

  // ── JSON → árvore plana (preordem) ──
  private static let kNull = 0, kFalse = 1, kTrue = 2, kNum = 3, kStr = 4, kArr = 5, kObj = 6
  private struct Node { var k: Int; var a: Int; var b: Int; var n: Int; var size: Int; var esc: Bool }

  private struct Parser {
    let s: [UInt8]
    var i = 0
    var nd: [Node] = []
    init(_ s: [UInt8]) { self.s = s; nd.reserveCapacity(64) }
    mutating func ws() { while i < s.count, s[i] == 0x20 || s[i] == 0x09 || s[i] == 0x0A || s[i] == 0x0D { i += 1 } }
    mutating func all() throws { ws(); try value(0); ws(); if i != s.count { throw Bad() } }
    func ch() throws -> UInt8 { if i < s.count { return s[i] }; throw Bad() }
    mutating func add(_ k: Int, _ a: Int, _ b: Int, _ esc: Bool) -> Int { nd.append(Node(k: k, a: a, b: b, n: 0, size: 1, esc: esc)); return nd.count - 1 }
    mutating func value(_ depth: Int) throws {
      if depth > ChatyyCbin.maxDepth { throw Bad() }
      let c = try ch()
      switch c {
      case UInt8(ascii: "{"):
        let idx = add(ChatyyCbin.kObj, 0, 0, false); i += 1; ws(); var cnt = 0
        if try ch() == UInt8(ascii: "}") { i += 1 } else {
          while true {
            ws(); if try ch() != UInt8(ascii: "\"") { throw Bad() }
            try str(); ws(); if try ch() != UInt8(ascii: ":") { throw Bad() }
            i += 1; ws(); try value(depth + 1); cnt += 1; ws()
            let d = try ch(); i += 1
            if d == UInt8(ascii: ",") { continue }
            if d == UInt8(ascii: "}") { break }
            throw Bad()
          }
        }
        nd[idx].n = cnt; nd[idx].size = nd.count - idx
      case UInt8(ascii: "["):
        let idx = add(ChatyyCbin.kArr, 0, 0, false); i += 1; ws(); var cnt = 0
        if try ch() == UInt8(ascii: "]") { i += 1 } else {
          while true {
            ws(); try value(depth + 1); cnt += 1; ws()
            let d = try ch(); i += 1
            if d == UInt8(ascii: ",") { continue }
            if d == UInt8(ascii: "]") { break }
            throw Bad()
          }
        }
        nd[idx].n = cnt; nd[idx].size = nd.count - idx
      case UInt8(ascii: "\""): try str()
      case UInt8(ascii: "t"): try lit("true", ChatyyCbin.kTrue)
      case UInt8(ascii: "f"): try lit("false", ChatyyCbin.kFalse)
      case UInt8(ascii: "n"): try lit("null", ChatyyCbin.kNull)
      default:
        if c == UInt8(ascii: "-") || (c >= 0x30 && c <= 0x39) { try num() } else { throw Bad() }
      }
    }
    mutating func lit(_ w: String, _ k: Int) throws {
      let wb = Array(w.utf8)
      if s.count - i < wb.count { throw Bad() }
      for j in 0..<wb.count where s[i + j] != wb[j] { throw Bad() }
      _ = add(k, 0, 0, false); i += wb.count
    }
    mutating func digits() -> Int { let st = i; while i < s.count, s[i] >= 0x30, s[i] <= 0x39 { i += 1 }; return i - st }
    mutating func num() throws {
      let a = i
      if s[i] == UInt8(ascii: "-") { i += 1 }
      if i >= s.count { throw Bad() }
      if s[i] == 0x30 { i += 1 } else if s[i] >= 0x31 && s[i] <= 0x39 { _ = digits() } else { throw Bad() }
      if i < s.count, s[i] == UInt8(ascii: ".") { i += 1; if digits() == 0 { throw Bad() } }
      if i < s.count, s[i] == UInt8(ascii: "e") || s[i] == UInt8(ascii: "E") {
        i += 1
        if i < s.count, s[i] == UInt8(ascii: "+") || s[i] == UInt8(ascii: "-") { i += 1 }
        if digits() == 0 { throw Bad() }
      }
      _ = add(ChatyyCbin.kNum, a, i, false)
    }
    mutating func str() throws {
      i += 1; let a = i; var esc = false
      while true {
        if i >= s.count { throw Bad() }
        let c = s[i]
        if c == UInt8(ascii: "\"") { break }
        if c < 0x20 { throw Bad() }
        if c == UInt8(ascii: "\\") {
          esc = true; i += 1; if i >= s.count { throw Bad() }
          switch s[i] {
          case UInt8(ascii: "\""), UInt8(ascii: "\\"), UInt8(ascii: "/"), UInt8(ascii: "b"), UInt8(ascii: "f"), UInt8(ascii: "n"), UInt8(ascii: "r"), UInt8(ascii: "t"): i += 1
          case UInt8(ascii: "u"):
            if s.count - i < 5 { throw Bad() }
            for j in 1...4 where ChatyyCbin.hexv(s[i + j]) < 0 { throw Bad() }
            i += 5
          default: throw Bad()
          }
          continue
        }
        i += 1
      }
      _ = add(ChatyyCbin.kStr, a, i, esc); i += 1
    }
  }

  fileprivate static func hexv(_ c: UInt8) -> Int {
    switch c { case 0x30...0x39: return Int(c) - 0x30; case 0x61...0x66: return Int(c) - 0x57; case 0x41...0x46: return Int(c) - 0x37; default: return -1 }
  }

  private static func validUtf8(_ b: [UInt8], _ a: Int, _ e: Int) -> Bool {
    var i = a
    while i < e {
      let c = Int(b[i])
      if c < 0x80 { i += 1; continue }
      var n = 0, cp = 0
      if c >= 0xC2 && c <= 0xDF { n = 1; cp = c & 0x1f } else if c >= 0xE0 && c <= 0xEF { n = 2; cp = c & 0x0f } else if c >= 0xF0 && c <= 0xF4 { n = 3; cp = c & 0x07 } else { return false }
      if i + n >= e { return false }
      for k in 1...n { let cc = Int(b[i + k]); if cc & 0xC0 != 0x80 { return false }; cp = (cp << 6) | (cc & 0x3f) }
      if (n == 2 && (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF))) || (n == 3 && (cp < 0x10000 || cp > 0x10FFFF)) { return false }
      i += n + 1
    }
    return true
  }

  private static func appendRune(_ o: inout [UInt8], _ r: Int) {
    if r < 0x80 { o.append(UInt8(r)) }
    else if r < 0x800 { o.append(UInt8(0xC0 | (r >> 6))); o.append(UInt8(0x80 | (r & 63))) }
    else if r < 0x10000 { o.append(UInt8(0xE0 | (r >> 12))); o.append(UInt8(0x80 | ((r >> 6) & 63))); o.append(UInt8(0x80 | (r & 63))) }
    else { o.append(UInt8(0xF0 | (r >> 18))); o.append(UInt8(0x80 | ((r >> 12) & 63))); o.append(UInt8(0x80 | ((r >> 6) & 63))); o.append(UInt8(0x80 | (r & 63))) }
  }

  private static func strBytes(_ src: [UInt8], _ n: Node) throws -> [UInt8] {
    if !n.esc { if !validUtf8(src, n.a, n.b) { throw Bad() }; return Array(src[n.a..<n.b]) }
    var o = [UInt8](); o.reserveCapacity(n.b - n.a)
    var i = n.a; let e = n.b
    func h4(_ p: Int) -> Int { (hexv(src[p]) << 12) | (hexv(src[p + 1]) << 8) | (hexv(src[p + 2]) << 4) | hexv(src[p + 3]) }
    while i < e {
      let c = src[i]
      if c != UInt8(ascii: "\\") { o.append(c); i += 1; continue }
      i += 1
      switch src[i] {
      case UInt8(ascii: "\""): o.append(0x22)
      case UInt8(ascii: "\\"): o.append(0x5C)
      case UInt8(ascii: "/"): o.append(0x2F)
      case UInt8(ascii: "b"): o.append(8)
      case UInt8(ascii: "f"): o.append(12)
      case UInt8(ascii: "n"): o.append(10)
      case UInt8(ascii: "r"): o.append(13)
      case UInt8(ascii: "t"): o.append(9)
      case UInt8(ascii: "u"):
        var r = h4(i + 1); i += 4
        if r >= 0xD800 && r <= 0xDBFF {
          if i + 6 < e, src[i + 1] == UInt8(ascii: "\\"), src[i + 2] == UInt8(ascii: "u") {
            let lo = h4(i + 3)
            if lo >= 0xDC00 && lo <= 0xDFFF { r = 0x10000 + ((r - 0xD800) << 10) + (lo - 0xDC00); i += 6; appendRune(&o, r); i += 1; continue }
          }
          throw Bad()
        }
        if r >= 0xDC00 && r <= 0xDFFF { throw Bad() }
        appendRune(&o, r)
      default: throw Bad()
      }
      i += 1
    }
    if !validUtf8(o, 0, o.count) { throw Bad() }
    return o
  }

  private static let hexd: [UInt8] = Array("0123456789abcdef".utf8)
  private static func appendJSONString(_ o: inout [UInt8], _ s: [UInt8]) {
    o.append(0x22)
    for c in s {
      if c >= 0x20 && c != 0x22 && c != 0x5C { o.append(c); continue }
      switch c {
      case 0x22: o.append(0x5C); o.append(0x22)
      case 0x5C: o.append(0x5C); o.append(0x5C)
      case 8: o.append(0x5C); o.append(UInt8(ascii: "b"))
      case 12: o.append(0x5C); o.append(UInt8(ascii: "f"))
      case 10: o.append(0x5C); o.append(UInt8(ascii: "n"))
      case 13: o.append(0x5C); o.append(UInt8(ascii: "r"))
      case 9: o.append(0x5C); o.append(UInt8(ascii: "t"))
      default: o.append(0x5C); o.append(UInt8(ascii: "u")); o.append(0x30); o.append(0x30); o.append(hexd[Int(c >> 4)]); o.append(hexd[Int(c & 15)])
      }
    }
    o.append(0x22)
  }

  private static func leU64(_ s: [UInt8], _ a: Int, _ e: Int) -> Bool { // dígitos (sem sinal) ≤ 2^64-1
    let n = e - a
    if n < 20 { return true }
    if n > 20 { return false }
    for k in 0..<20 { if s[a + k] != u64MaxStr[k] { return s[a + k] < u64MaxStr[k] } }
    return true
  }
  private static func parseU64(_ s: [UInt8], _ a: Int, _ e: Int) -> UInt64 { var u: UInt64 = 0; for k in a..<e { u = u &* 10 &+ UInt64(s[k] - 0x30) }; return u }

  private static func canonInt(_ s: [UInt8], _ a0: Int, _ e: Int) -> Bool {
    var a = a0
    if a < e, s[a] == UInt8(ascii: "-") { a += 1; if e - a == 1, s[a] == 0x30 { return false } }
    let n = e - a
    if n == 0 || n > 20 { return false }
    if s[a] == 0x30 && n > 1 { return false }
    for k in a..<e where s[k] < 0x30 || s[k] > 0x39 { return false }
    return leU64(s, a, e)
  }

  private static func canonical(_ o: inout [UInt8], _ src: [UInt8], _ nd: [Node], _ i0: Int) throws -> Int {
    let n = nd[i0]
    switch n.k {
    case kNull: o.append(contentsOf: Array("null".utf8)); return i0 + 1
    case kFalse: o.append(contentsOf: Array("false".utf8)); return i0 + 1
    case kTrue: o.append(contentsOf: Array("true".utf8)); return i0 + 1
    case kNum: o.append(contentsOf: src[n.a..<n.b]); return i0 + 1
    case kStr: appendJSONString(&o, try strBytes(src, n)); return i0 + 1
    case kArr:
      o.append(UInt8(ascii: "[")); var j = i0 + 1
      for c in 0..<n.n { if c > 0 { o.append(UInt8(ascii: ",")) }; j = try canonical(&o, src, nd, j) }
      o.append(UInt8(ascii: "]")); return j
    default:
      o.append(UInt8(ascii: "{")); var j = i0 + 1
      for c in 0..<n.n { if c > 0 { o.append(UInt8(ascii: ",")) }; appendJSONString(&o, try strBytes(src, nd[j])); o.append(UInt8(ascii: ":")); j = try canonical(&o, src, nd, j + 1) }
      o.append(UInt8(ascii: "}")); return j
    }
  }

  // ── saída ──
  private static func uvar(_ o: inout [UInt8], _ v: UInt64) { var u = v; while u >= 0x80 { o.append(UInt8(u & 0x7f) | 0x80); u >>= 7 }; o.append(UInt8(u)) }
  private static func putStr(_ o: inout [UInt8], _ b: [UInt8]) { uvar(&o, UInt64(b.count)); o.append(contentsOf: b) }
  private static func putStr(_ o: inout [UInt8], _ b: ArraySlice<UInt8>) { uvar(&o, UInt64(b.count)); o.append(contentsOf: b) }

  private static func encKey(_ o: inout [UInt8], _ src: [UInt8], _ n: Node) throws {
    let kb = try strBytes(src, n)
    if let ki = keyIdx[String(decoding: kb, as: UTF8.self)] { uvar(&o, UInt64(ki + 1)) } else { o.append(0); putStr(&o, kb) }
  }

  private static func encValue(_ o: inout [UInt8], _ src: [UInt8], _ nd: [Node], _ i0: Int, _ depth: Int) throws -> Int {
    if depth > maxDepth { throw Bad() }
    let n = nd[i0]
    switch n.k {
    case kNull: o.append(tNull)
    case kFalse: o.append(tFalse)
    case kTrue: o.append(tTrue)
    case kNum: encNum(&o, src, n.a, n.b)
    case kStr: try encStr(&o, try strBytes(src, n), depth)
    case kArr:
      o.append(tArr); uvar(&o, UInt64(n.n)); var j = i0 + 1
      for _ in 0..<n.n { j = try encValue(&o, src, nd, j, depth + 1) }
      return j
    default:
      o.append(tObj); uvar(&o, UInt64(n.n)); var j = i0 + 1
      for _ in 0..<n.n { try encKey(&o, src, nd[j]); j = try encValue(&o, src, nd, j + 1, depth + 1) }
      return j
    }
    return i0 + 1
  }

  private static func encNum(_ o: inout [UInt8], _ s: [UInt8], _ a: Int, _ e: Int) {
    if canonInt(s, a, e) {
      if s[a] == UInt8(ascii: "-") { let u = parseU64(s, a + 1, e); o.append(tNeg); uvar(&o, u - 1); return }
      let u = parseU64(s, a, e)
      if u < 64 { o.append(tSmall + UInt8(u)) } else { o.append(tUint); uvar(&o, u) }
      return
    }
    o.append(tNumLit); putStr(&o, s[a..<e])
  }

  private static func isDecCanon(_ s: [UInt8]) -> Bool { if s[0] == 0x30 { return false }; for c in s where c < 0x30 || c > 0x39 { return false }; return leU64(s, 0, s.count) }
  private static func isLowerHex(_ s: [UInt8]) -> Bool { for c in s where !((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66)) { return false }; return true }
  private static func isUUID(_ s: [UInt8]) -> Bool {
    for (i, c) in s.enumerated() {
      if i == 8 || i == 13 || i == 18 || i == 23 { if c != UInt8(ascii: "-") { return false } } else if !((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66)) { return false }
    }
    return true
  }
  private static func hexBytes(_ s: [UInt8], _ a: Int, _ e: Int) -> [UInt8] { var r = [UInt8](); r.reserveCapacity((e - a) / 2); var k = a; while k < e { r.append(UInt8((hexv(s[k]) << 4) | hexv(s[k + 1]))); k += 2 }; return r }

  private static let b64: [UInt8] = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".utf8)
  private static let b64u: [UInt8] = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)
  private static func b64enc(_ b: [UInt8], _ alpha: [UInt8], _ pad: Bool, into o: inout [UInt8]) {
    var i = 0; let e = b.count
    while i + 2 < e { let v = (Int(b[i]) << 16) | (Int(b[i + 1]) << 8) | Int(b[i + 2]); o.append(alpha[v >> 18]); o.append(alpha[(v >> 12) & 63]); o.append(alpha[(v >> 6) & 63]); o.append(alpha[v & 63]); i += 3 }
    let r = e - i
    if r == 1 { let v = Int(b[i]) << 16; o.append(alpha[v >> 18]); o.append(alpha[(v >> 12) & 63]); if pad { o.append(0x3D); o.append(0x3D) } }
    else if r == 2 { let v = (Int(b[i]) << 16) | (Int(b[i + 1]) << 8); o.append(alpha[v >> 18]); o.append(alpha[(v >> 12) & 63]); o.append(alpha[(v >> 6) & 63]); if pad { o.append(0x3D) } }
  }
  private static func b64dec(_ s: [UInt8], _ n: Int, _ alpha: [UInt8]) -> [UInt8]? {
    var o = [UInt8](); o.reserveCapacity(n * 3 / 4); var acc = 0, bits = 0
    for k in 0..<n {
      guard let v = alpha.firstIndex(of: s[k]) else { return nil }
      acc = (acc << 6) | v; bits += 6
      if bits >= 8 { bits -= 8; o.append(UInt8((acc >> bits) & 0xff)) }
      acc &= (1 << bits) - 1
    }
    return o
  }
  private static func b64roundTrips(_ raw: [UInt8], _ s: [UInt8], _ alpha: [UInt8], _ pad: Bool) -> Bool { var o = [UInt8](); b64enc(raw, alpha, pad, into: &o); return o == s }

  private static func encStr(_ o: inout [UInt8], _ s: [UInt8], _ depth: Int) throws {
    let str = String(decoding: s, as: UTF8.self)
    if let vi = valIdx[str] { if vi < 128 { o.append(tValInl + UInt8(vi)) } else { o.append(tVal); uvar(&o, UInt64(vi)) }; return }
    let n = s.count
    if n >= 2 && n <= 20 && isDecCanon(s) { o.append(tDec); uvar(&o, parseU64(s, 0, n)); return }
    if n >= 19 && n <= 35 && s[4] == UInt8(ascii: "-"), let t = encTime(s) { o.append(contentsOf: t); return }
    if n >= 3, let at = s.lastIndex(of: UInt8(ascii: "@")), at > 0, let di = domIdx[String(decoding: s[(at + 1)...], as: UTF8.self)] {
      o.append(tEmail); putStr(&o, s[0..<at]); uvar(&o, UInt64(di)); return
    }
    if n >= 8 && (s[0] == UInt8(ascii: "h") || s[0] == UInt8(ascii: "/")) {
      var best = -1, bl = 0
      for (i, p) in pfxBytes.enumerated() where p.count > bl && p.count <= n && Array(s[0..<p.count]) == p { best = i; bl = p.count }
      if best >= 0 { o.append(tPfx); uvar(&o, UInt64(best)); putStr(&o, s[bl...]); return }
    }
    if n == 36 && isUUID(s) {
      o.append(tUUID)
      for (a, e) in [(0, 8), (9, 13), (14, 18), (19, 23), (24, 36)] { o.append(contentsOf: hexBytes(s, a, e)) }
      return
    }
    if n >= 8 && n % 2 == 0 && isLowerHex(s) { o.append(tHex); uvar(&o, UInt64(n / 2)); o.append(contentsOf: hexBytes(s, 0, n)); return }
    if n >= 8 && (s[0] == UInt8(ascii: "{") || s[0] == UInt8(ascii: "[")) && depth < 8 {
      var p = Parser(s)
      if (try? p.all()) != nil, p.nd[0].k == kObj || p.nd[0].k == kArr {
        var c = [UInt8](); c.reserveCapacity(n)
        if (try? canonical(&c, s, p.nd, 0)) != nil, c == s {
          var sub: [UInt8] = [tJSONStr]
          if (try? encValue(&sub, s, p.nd, 0, depth + 1)) != nil { o.append(contentsOf: sub); return }
        }
      }
    }
    if n >= 12 && !s.contains(where: { $0 >= 0x80 }) {
      if n % 4 == 0 {
        var m = n; while m > 0 && s[m - 1] == 0x3D && n - m < 2 { m -= 1 }
        if let raw = b64dec(s, m, b64), b64roundTrips(raw, s, b64, true) { o.append(tB64); putStr(&o, raw); return }
      }
      if n % 4 != 0 && n % 4 != 1 && n >= 16 && s[n - 1] != 0x3D, let raw = b64dec(s, n, b64), b64roundTrips(raw, s, b64, false) { o.append(tB64Raw); putStr(&o, raw); return }
      if n % 4 != 1 && n >= 16, let raw = b64dec(s, n, b64u), b64roundTrips(raw, s, b64u, false) { o.append(tB64URL); putStr(&o, raw); return }
    }
    if n < 32 { o.append(tShort + UInt8(n)); o.append(contentsOf: s) } else { o.append(tStr); putStr(&o, s) }
  }

  // ── datas ──
  private static func fdiv(_ a: Int, _ b: Int) -> Int { a >= 0 ? a / b : -((-a + b - 1) / b) }
  private static func daysFromCivil(_ y0: Int, _ m: Int, _ d: Int) -> Int { let y = m <= 2 ? y0 - 1 : y0; let era = fdiv(y, 400); let yoe = y - era * 400; let mp = (m + 9) % 12; let doy = (153 * mp + 2) / 5 + d - 1; let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; return era * 146097 + doe - 719468 }
  private static func civilFromDays(_ z0: Int) -> (Int, Int, Int) { let z = z0 + 719468; let era = fdiv(z, 146097); let doe = z - era * 146097; let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; var y = yoe + era * 400; let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); let mp = (5 * doy + 2) / 153; let d = doy - (153 * mp + 2) / 5 + 1; var m = mp + 3; if m > 12 { m -= 12 }; if m <= 2 { y += 1 }; return (y, m, d) }
  private static func d2(_ s: [UInt8], _ i: Int) -> Int { let a = Int(s[i]) - 0x30, b = Int(s[i + 1]) - 0x30; return (a >= 0 && a <= 9 && b >= 0 && b <= 9) ? a * 10 + b : -1 }
  private static func zz(_ v: Int64) -> UInt64 { UInt64(bitPattern: (v << 1) ^ (v >> 63)) }
  private static func unzz(_ u: UInt64) -> Int64 { Int64(bitPattern: u >> 1) ^ -Int64(bitPattern: u & 1) }

  private static func encTime(_ s: [UInt8]) -> [UInt8]? {
    if s[4] != 0x2D || s[7] != 0x2D || (s[10] != UInt8(ascii: "T") && s[10] != 0x20) || s[13] != 0x3A || s[16] != 0x3A { return nil }
    let y1 = d2(s, 0), y2 = d2(s, 2), mo = d2(s, 5), dd = d2(s, 8), hh = d2(s, 11), mi = d2(s, 14), ss = d2(s, 17)
    if y1 < 0 || y2 < 0 || mo < 0 || dd < 0 || hh < 0 || mi < 0 || ss < 0 { return nil }
    let y = y1 * 100 + y2
    if y < 1970 || mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59 { return nil }
    var i = 19, fd = 0; var frac: UInt64 = 0
    if i < s.count, s[i] == UInt8(ascii: ".") {
      i += 1
      while i < s.count, s[i] >= 0x30, s[i] <= 0x39, fd < 10 { frac = frac * 10 + UInt64(s[i] - 0x30); fd += 1; i += 1 }
      if fd == 0 || fd > 9 { return nil }
    }
    var zk = 0, zmin = 0
    if i < s.count {
      if s[i] == UInt8(ascii: "Z") { zk = 1; i += 1 }
      else if s[i] == UInt8(ascii: "+") || s[i] == UInt8(ascii: "-") {
        if s.count - i < 3 { return nil }
        let zh = d2(s, i + 1); if zh < 0 { return nil }
        let sign = s[i] == UInt8(ascii: "-") ? -1 : 1
        if s.count - i == 3 { zk = 2; zmin = sign * zh * 60; i += 3 }
        else if s.count - i == 6 && s[i + 3] == 0x3A { let zm = d2(s, i + 4); if zm < 0 || zm > 59 { return nil }; zk = 3; zmin = sign * (zh * 60 + zm); i += 6 }
        else { return nil }
      } else { return nil }
    }
    if i != s.count { return nil }
    let days = daysFromCivil(y, mo, dd); let c = civilFromDays(days)
    if c.0 != y || c.1 != mo || c.2 != dd { return nil }
    let secs = UInt64(days * 86400 + hh * 3600 + mi * 60 + ss)
    var desc = UInt8((fd << 1) | (zk << 5)); if s[10] == UInt8(ascii: "T") { desc |= 1 }
    var o: [UInt8] = [tTime]; uvar(&o, secs); o.append(desc); if fd > 0 { uvar(&o, frac) }; if zk >= 2 { uvar(&o, zz(Int64(zmin))) }
    var r = Rd(o, 1)
    guard let back = try? decTime(&r), back == s else { return nil }
    return o
  }

  private static func p2(_ o: inout [UInt8], _ v: Int) { o.append(UInt8(0x30 + v / 10)); o.append(UInt8(0x30 + v % 10)) }

  private static func decTime(_ r: inout Rd) throws -> [UInt8] {
    let secs = try r.uvar(); if secs > 253402300799 { throw Bad() }
    let desc = Int(try r.u8()); let fd = (desc >> 1) & 15, zk = (desc >> 5) & 3
    if fd > 9 || desc & 0x80 != 0 { throw Bad() }
    let frac: UInt64 = fd > 0 ? try r.uvar() : 0
    var zmin: Int64 = 0
    if zk >= 2 { zmin = unzz(try r.uvar()); if zmin <= -6000 || zmin >= 6000 || (zk == 2 && zmin % 60 != 0) { throw Bad() } }
    let days = Int(secs / 86400), rem = Int(secs % 86400); let c = civilFromDays(days)
    var o = [UInt8](); o.reserveCapacity(40)
    let y = c.0
    o.append(UInt8(0x30 + y / 1000)); o.append(UInt8(0x30 + y / 100 % 10)); o.append(UInt8(0x30 + y / 10 % 10)); o.append(UInt8(0x30 + y % 10)); o.append(0x2D)
    p2(&o, c.1); o.append(0x2D); p2(&o, c.2); o.append(desc & 1 != 0 ? UInt8(ascii: "T") : 0x20)
    p2(&o, rem / 3600); o.append(0x3A); p2(&o, rem / 60 % 60); o.append(0x3A); p2(&o, rem % 60)
    if fd > 0 {
      let f = Array(String(frac).utf8); if f.count > fd { throw Bad() }
      o.append(UInt8(ascii: ".")); for _ in 0..<(fd - f.count) { o.append(0x30) }; o.append(contentsOf: f)
    }
    if zk == 1 { o.append(UInt8(ascii: "Z")) } else if zk >= 2 {
      var z = zmin; if z < 0 { o.append(0x2D); z = -z } else { o.append(UInt8(ascii: "+")) }
      p2(&o, Int(z / 60)); if zk == 3 { o.append(0x3A); p2(&o, Int(z % 60)) }
    }
    return o
  }

  /** JSON (texto) → cbin. nil = mande o JSON. */
  static func encode(_ json: String) -> Data? {
    let src = Array(json.utf8)
    if src.count > maxFrame { return nil }
    do {
      var p = Parser(src); try p.all()
      let nd = p.nd
      var o = [UInt8](); o.reserveCapacity(src.count / 2)
      if nd[0].k == kObj {
        var j = 1, typeAt = -1, ti = 0
        for _ in 0..<nd[0].n {
          let kb = try strBytes(src, nd[j])
          if typeAt < 0 && kb == Array("type".utf8) && nd[j + 1].k == kStr, let it = typeIdx[String(decoding: try strBytes(src, nd[j + 1]), as: UTF8.self)] { typeAt = j; ti = it }
          j += 1 + nd[j + 1].size
        }
        if typeAt >= 0 {
          uvar(&o, UInt64(ti + 1)); j = 1
          for _ in 0..<nd[0].n {
            let next = j + 1 + nd[j + 1].size
            if j != typeAt { try encKey(&o, src, nd[j]); _ = try encValue(&o, src, nd, j + 1, 0) }
            j = next
          }
          return Data(o)
        }
      }
      o.append(0); _ = try encValue(&o, src, nd, 0, 0)
      return Data(o)
    } catch { return nil }
  }

  private struct Rd {
    let b: [UInt8]; var p: Int
    init(_ b: [UInt8], _ p: Int = 0) { self.b = b; self.p = p }
    mutating func u8() throws -> UInt8 { if p >= b.count { throw Bad() }; let c = b[p]; p += 1; return c }
    mutating func uvar() throws -> UInt64 {
      var x: UInt64 = 0, s: UInt64 = 0, i = 0
      while true {
        if p >= b.count || i >= 10 { throw Bad() }
        let c = b[p]; p += 1
        if i == 9 && c > 1 { throw Bad() }
        x |= UInt64(c & 0x7f) << s; s += 7; i += 1
        if c & 0x80 == 0 { return x }
      }
    }
    mutating func len() throws -> Int { let n = try uvar(); if n > UInt64(b.count - p) { throw Bad() }; return Int(n) }
    mutating func raw() throws -> [UInt8] { let n = try len(); let r = Array(b[p..<(p + n)]); p += n; return r }
    mutating func str() throws -> [UInt8] { let r = try raw(); if !ChatyyCbin.validUtf8(r, 0, r.count) { throw Bad() }; return r }
  }

  private static func decKey(_ r: inout Rd, _ o: inout [UInt8]) throws {
    let k = try r.uvar()
    if k == 0 { appendJSONString(&o, try r.str()); return }
    if k > UInt64(ChatyyCbinDict.keys.count) { throw Bad() }
    appendJSONString(&o, Array(ChatyyCbinDict.keys[Int(k - 1)].utf8))
  }

  private static func decValue(_ r: inout Rd, _ o: inout [UInt8], _ depth: Int) throws {
    if depth > maxDepth + 8 { throw Bad() }
    let t = try r.u8()
    if t >= tValInl { let i = Int(t - tValInl); if i >= ChatyyCbinDict.vals.count { throw Bad() }; appendJSONString(&o, Array(ChatyyCbinDict.vals[i].utf8)); return }
    if t >= tSmall { o.append(contentsOf: Array(String(t - tSmall).utf8)); return }
    if t >= tShort {
      let n = Int(t - tShort); if n > r.b.count - r.p { throw Bad() }
      let s = Array(r.b[r.p..<(r.p + n)]); r.p += n
      if !validUtf8(s, 0, n) { throw Bad() }
      appendJSONString(&o, s); return
    }
    switch t {
    case tNull: o.append(contentsOf: Array("null".utf8))
    case tFalse: o.append(contentsOf: Array("false".utf8))
    case tTrue: o.append(contentsOf: Array("true".utf8))
    case tUint: let u = try r.uvar(); if u < 64 { throw Bad() }; o.append(contentsOf: Array(String(u).utf8))
    case tNeg:
      let u = try r.uvar(); if u == UInt64.max { throw Bad() }
      o.append(0x2D); o.append(contentsOf: Array(String(u + 1).utf8))
    case tNumLit:
      let s = try r.raw()
      var p = Parser(s)
      if s.isEmpty { throw Bad() }
      try p.num(); if p.i != s.count { throw Bad() }
      o.append(contentsOf: s)
    case tStr: appendJSONString(&o, try r.str())
    case tVal: let i = try r.uvar(); if i >= UInt64(ChatyyCbinDict.vals.count) { throw Bad() }; appendJSONString(&o, Array(ChatyyCbinDict.vals[Int(i)].utf8))
    case tDec: o.append(0x22); o.append(contentsOf: Array(String(try r.uvar()).utf8)); o.append(0x22)
    case tB64, tB64URL, tB64Raw, tHex:
      let s = try r.raw(); o.append(0x22)
      switch t {
      case tB64: b64enc(s, b64, true, into: &o)
      case tB64URL: b64enc(s, b64u, false, into: &o)
      case tB64Raw: b64enc(s, b64, false, into: &o)
      default: for c in s { o.append(hexd[Int(c >> 4)]); o.append(hexd[Int(c & 15)]) }
      }
      o.append(0x22)
    case tUUID:
      if r.b.count - r.p < 16 { throw Bad() }
      o.append(0x22)
      for k in 0..<16 { if k == 4 || k == 6 || k == 8 || k == 10 { o.append(0x2D) }; let c = r.b[r.p + k]; o.append(hexd[Int(c >> 4)]); o.append(hexd[Int(c & 15)]) }
      r.p += 16; o.append(0x22)
    case tArr:
      let n = try r.uvar(); if n > UInt64(r.b.count - r.p) { throw Bad() }
      o.append(UInt8(ascii: "["))
      for i in 0..<Int(n) { if i > 0 { o.append(UInt8(ascii: ",")) }; try decValue(&r, &o, depth + 1) }
      o.append(UInt8(ascii: "]"))
    case tObj:
      let n = try r.uvar(); if n > UInt64((r.b.count - r.p) / 2) { throw Bad() }
      o.append(UInt8(ascii: "{"))
      for i in 0..<Int(n) { if i > 0 { o.append(UInt8(ascii: ",")) }; try decKey(&r, &o); o.append(UInt8(ascii: ":")); try decValue(&r, &o, depth + 1) }
      o.append(UInt8(ascii: "}"))
    case tEmail:
      let loc = try r.str(); let di = try r.uvar(); if di >= UInt64(ChatyyCbinDict.doms.count) { throw Bad() }
      appendJSONString(&o, loc + [0x40] + Array(ChatyyCbinDict.doms[Int(di)].utf8))
    case tPfx:
      let pi = try r.uvar(); let rest = try r.str(); if pi >= UInt64(pfxBytes.count) { throw Bad() }
      appendJSONString(&o, pfxBytes[Int(pi)] + rest)
    case tJSONStr:
      var sub = [UInt8](); try decValue(&r, &sub, depth + 1); appendJSONString(&o, sub)
    case tTime: appendJSONString(&o, try decTime(&r))
    default: throw Bad()
    }
  }

  /** cbin → JSON canônico (texto). nil = frame inválido. */
  static func decode(_ data: Data) -> String? {
    let b = [UInt8](data)
    if b.isEmpty || b.count > maxFrame { return nil }
    do {
      var r = Rd(b); var o = [UInt8](); o.reserveCapacity(b.count * 3)
      let t = try r.uvar()
      if t == 0 { try decValue(&r, &o, 0) } else {
        if t > UInt64(ChatyyCbinDict.types.count) { throw Bad() }
        o.append(contentsOf: Array("{\"type\":".utf8)); appendJSONString(&o, Array(ChatyyCbinDict.types[Int(t - 1)].utf8))
        while r.p < b.count { o.append(UInt8(ascii: ",")); try decKey(&r, &o); o.append(UInt8(ascii: ":")); try decValue(&r, &o, 1) }
        o.append(UInt8(ascii: "}"))
      }
      if r.p != b.count { return nil }
      return String(decoding: o, as: UTF8.self)
    } catch { return nil }
  }

  /** frames que NUNCA vão em cbin (auth*, cbin_*) — mesma regra do servidor (cbinJSONOnly). */
  static func jsonOnly(_ text: String) -> Bool { text.contains("\"auth_") || text.contains("\"cbin_") || text.contains("\"type\":\"auth\"") }

  static func helloFrame() -> String { "{\"type\":\"cbin_hello\",\"v\":[\(version)],\"dh\":\"\(dictHash)\"}" }
}
