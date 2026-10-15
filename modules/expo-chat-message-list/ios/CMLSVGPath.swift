import UIKit

// [2026-10-15 native-list fase 2] Parser de path SVG ("d") → CGPath.
// Suporta M L H V C S Q T A Z (absolutos e relativos), números colados
// ("1.5.5", "-1-2", "1e-3") e flags de arco compactas ("a1 1 0 011 1").
// Arcos convertidos em béziers cúbicas (≤ 90° por segmento).
// Resultado cacheado por string (paths de ícones repetem muito). Thread-safe.

enum CMLSVGPath {
  private static let cache = NSCache<NSString, CGPath>()
  private static let lock = NSLock()

  static func path(_ d: String) -> CGPath {
    let k = d as NSString
    lock.lock()
    if let p = cache.object(forKey: k) { lock.unlock(); return p }
    lock.unlock()
    let p = parse(d)
    lock.lock()
    cache.setObject(p, forKey: k)
    lock.unlock()
    return p
  }

  private struct Scanner {
    let c: [UInt8]
    var i = 0
    init(_ s: String) { c = Array(s.utf8) }

    mutating func skipSep() {
      while i < c.count {
        let ch = c[i]
        if ch == 0x20 || ch == 0x2C || ch == 0x09 || ch == 0x0A || ch == 0x0D { i += 1 } else { break }
      }
    }

    var atEnd: Bool { return i >= c.count }

    /// Próximo é número (sem consumir)?
    mutating func peekNumber() -> Bool {
      skipSep()
      guard i < c.count else { return false }
      let ch = c[i]
      return (ch >= 0x30 && ch <= 0x39) || ch == 0x2D || ch == 0x2B || ch == 0x2E
    }

    mutating func command() -> UInt8? {
      skipSep()
      guard i < c.count else { return nil }
      let ch = c[i]
      if (ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A) {
        if ch == 0x65 || ch == 0x45 { return nil } // 'e' não é comando
        i += 1
        return ch
      }
      return nil
    }

    mutating func number() -> CGFloat? {
      skipSep()
      guard i < c.count else { return nil }
      let start = i
      if c[i] == 0x2D || c[i] == 0x2B { i += 1 }
      var sawDigit = false
      var sawDot = false
      while i < c.count {
        let ch = c[i]
        if ch >= 0x30 && ch <= 0x39 { sawDigit = true; i += 1 }
        else if ch == 0x2E && !sawDot { sawDot = true; i += 1 }
        else { break }
      }
      if sawDigit && i < c.count && (c[i] == 0x65 || c[i] == 0x45) {
        var j = i + 1
        if j < c.count && (c[j] == 0x2D || c[j] == 0x2B) { j += 1 }
        if j < c.count && c[j] >= 0x30 && c[j] <= 0x39 {
          i = j
          while i < c.count && c[i] >= 0x30 && c[i] <= 0x39 { i += 1 }
        }
      }
      if !sawDigit { i = start; return nil }
      let s = String(decoding: c[start..<i], as: UTF8.self)
      guard let v = Double(s) else { return nil }
      return CGFloat(v)
    }

    /// Flag de arco: um único '0' ou '1' (pode vir colado).
    mutating func flag() -> Bool? {
      skipSep()
      guard i < c.count else { return nil }
      let ch = c[i]
      if ch == 0x30 { i += 1; return false }
      if ch == 0x31 { i += 1; return true }
      return nil
    }
  }

  static func parse(_ d: String) -> CGPath {
    let p = CGMutablePath()
    var s = Scanner(d)
    var cur = CGPoint.zero
    var start = CGPoint.zero
    var lastCtrl: CGPoint? = nil   // p/ S/T
    var lastCmd: UInt8 = 0
    var cmd: UInt8 = 0
    var hasCurrent = false
    var guardN = 0

    func ensureMove() {
      if !hasCurrent { p.move(to: cur); hasCurrent = true; start = cur }
    }

    while !s.atEnd && guardN < 20000 {
      guardN += 1
      if let c = s.command() {
        cmd = c
      } else if s.peekNumber() {
        // repetição implícita; M vira L
        if cmd == 0x4D { cmd = 0x4C } else if cmd == 0x6D { cmd = 0x6C }
        if cmd == 0 { break }
      } else {
        // caractere inválido: pula
        s.i += 1
        continue
      }
      let rel = cmd >= 0x61
      let upper = rel ? cmd - 0x20 : cmd
      switch upper {
      case 0x4D: // M
        guard let x = s.number(), let y = s.number() else { s.i = s.c.count; break }
        cur = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
        p.move(to: cur); hasCurrent = true
        start = cur
        lastCtrl = nil
      case 0x4C: // L
        guard let x = s.number(), let y = s.number() else { s.i = s.c.count; break }
        ensureMove()
        cur = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
        p.addLine(to: cur)
        lastCtrl = nil
      case 0x48: // H
        guard let x = s.number() else { s.i = s.c.count; break }
        ensureMove()
        cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y)
        p.addLine(to: cur)
        lastCtrl = nil
      case 0x56: // V
        guard let y = s.number() else { s.i = s.c.count; break }
        ensureMove()
        cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y)
        p.addLine(to: cur)
        lastCtrl = nil
      case 0x43: // C
        guard let x1 = s.number(), let y1 = s.number(), let x2 = s.number(), let y2 = s.number(), let x = s.number(), let y = s.number() else { s.i = s.c.count; break }
        ensureMove()
        let c1 = rel ? CGPoint(x: cur.x + x1, y: cur.y + y1) : CGPoint(x: x1, y: y1)
        let c2 = rel ? CGPoint(x: cur.x + x2, y: cur.y + y2) : CGPoint(x: x2, y: y2)
        let e = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
        p.addCurve(to: e, control1: c1, control2: c2)
        lastCtrl = c2
        cur = e
      case 0x53: // S
        guard let x2 = s.number(), let y2 = s.number(), let x = s.number(), let y = s.number() else { s.i = s.c.count; break }
        ensureMove()
        let prevUpper = lastCmd >= 0x61 ? lastCmd - 0x20 : lastCmd
        var c1 = cur
        if let lc = lastCtrl, prevUpper == 0x43 || prevUpper == 0x53 { c1 = CGPoint(x: 2 * cur.x - lc.x, y: 2 * cur.y - lc.y) }
        let c2 = rel ? CGPoint(x: cur.x + x2, y: cur.y + y2) : CGPoint(x: x2, y: y2)
        let e = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
        p.addCurve(to: e, control1: c1, control2: c2)
        lastCtrl = c2
        cur = e
      case 0x51: // Q
        guard let x1 = s.number(), let y1 = s.number(), let x = s.number(), let y = s.number() else { s.i = s.c.count; break }
        ensureMove()
        let c1 = rel ? CGPoint(x: cur.x + x1, y: cur.y + y1) : CGPoint(x: x1, y: y1)
        let e = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
        p.addQuadCurve(to: e, control: c1)
        lastCtrl = c1
        cur = e
      case 0x54: // T
        guard let x = s.number(), let y = s.number() else { s.i = s.c.count; break }
        ensureMove()
        let prevUpper = lastCmd >= 0x61 ? lastCmd - 0x20 : lastCmd
        var c1 = cur
        if let lc = lastCtrl, prevUpper == 0x51 || prevUpper == 0x54 { c1 = CGPoint(x: 2 * cur.x - lc.x, y: 2 * cur.y - lc.y) }
        let e = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
        p.addQuadCurve(to: e, control: c1)
        lastCtrl = c1
        cur = e
      case 0x41: // A
        guard let rx = s.number(), let ry = s.number(), let rot = s.number(),
              let large = s.flag(), let sweep = s.flag(),
              let x = s.number(), let y = s.number() else { s.i = s.c.count; break }
        ensureMove()
        let e = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
        addArc(p, from: cur, to: e, rx: abs(rx), ry: abs(ry), angle: rot, large: large, sweep: sweep)
        cur = e
        lastCtrl = nil
      case 0x5A: // Z
        if hasCurrent { p.closeSubpath() }
        cur = start
        hasCurrent = false
        lastCtrl = nil
        cmd = 0 // número solto depois de Z = path inválido → encerra
      default:
        // comando desconhecido: abandona o resto
        s.i = s.c.count
      }
      lastCmd = cmd
      // Z sem números: depois dele um número implícito seria inválido; ok.
    }
    return p.copy() ?? p
  }

  /// Arco elíptico SVG (endpoint parametrization) → cúbicas.
  private static func addArc(_ p: CGMutablePath, from p0: CGPoint, to p1: CGPoint, rx rxIn: CGFloat, ry ryIn: CGFloat, angle: CGFloat, large: Bool, sweep: Bool) {
    if p0 == p1 { return }
    var rx = rxIn, ry = ryIn
    if rx < 1e-6 || ry < 1e-6 { p.addLine(to: p1); return }
    let phi = angle * .pi / 180
    let cosP = cos(phi), sinP = sin(phi)
    let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
    let x1p = cosP * dx + sinP * dy
    let y1p = -sinP * dx + cosP * dy
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lambda > 1 { let sq = sqrt(lambda); rx *= sq; ry *= sq }
    let rx2 = rx * rx, ry2 = ry * ry
    var num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p
    if num < 0 { num = 0 }
    let den = rx2 * y1p * y1p + ry2 * x1p * x1p
    var coef = den > 0 ? sqrt(num / den) : 0
    if large == sweep { coef = -coef }
    let cxp = coef * (rx * y1p / ry)
    let cyp = coef * -(ry * x1p / rx)
    let cx = cosP * cxp - sinP * cyp + (p0.x + p1.x) / 2
    let cy = sinP * cxp + cosP * cyp + (p0.y + p1.y) / 2

    func ang(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
      let dot = ux * vx + uy * vy
      let len = sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
      var a = acos(max(-1, min(1, len > 0 ? dot / len : 1)))
      if ux * vy - uy * vx < 0 { a = -a }
      return a
    }
    let ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry
    let vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry
    let theta1 = ang(1, 0, ux, uy)
    var dTheta = ang(ux, uy, vx, vy)
    if !sweep && dTheta > 0 { dTheta -= 2 * .pi }
    if sweep && dTheta < 0 { dTheta += 2 * .pi }

    let segs = max(1, Int(ceil(abs(dTheta) / (.pi / 2))))
    let delta = dTheta / CGFloat(segs)
    let t = 4.0 / 3.0 * tan(delta / 4)
    var a1 = theta1
    for _ in 0..<segs {
      let a2 = a1 + delta
      let cos1 = cos(a1), sin1 = sin(a1), cos2 = cos(a2), sin2 = sin(a2)
      // pontos no círculo unitário → elipse rotacionada
      func map(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        let ex = rx * x, ey = ry * y
        return CGPoint(x: cosP * ex - sinP * ey + cx, y: sinP * ex + cosP * ey + cy)
      }
      let c1 = map(cos1 - t * sin1, sin1 + t * cos1)
      let c2 = map(cos2 + t * sin2, sin2 - t * cos2)
      let e = map(cos2, sin2)
      p.addCurve(to: e, control1: c1, control2: c2)
      a1 = a2
    }
  }
}
