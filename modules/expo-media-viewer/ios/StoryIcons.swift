import UIKit

// [2026-10-15 native-story] Ícones das reações do status desenhados em vetor
// (mesmos paths do components/Icons.js — regra do app: NUNCA emoji na UI).
// Mini-parser de path SVG: M/L/H/V/C/S/Q/T/Z (absolutos e relativos) + A
// (arco convertido em curvas). Viewbox 24×24.
enum SVIcons {
  private static var cache: [String: UIImage] = [:]

  /// kind: heart | flame | laugh | wow | sad | clap | thumbs
  static func reaction(_ kind: String, size: CGFloat) -> UIImage? {
    let k = "\(kind)|\(Int(size))"
    if let img = cache[k] { return img }
    let img = render(kind, size: size)
    if let img = img { cache[k] = img }
    return img
  }

  // [2026-10-15] reações com o emoji real (como Instagram) — vetor ficava feio.
  static func emoji(_ glyph: String, size: CGFloat) -> UIImage? {
    let k = "e|\(glyph)|\(Int(size))"
    if let img = cache[k] { return img }
    let fmt = UIGraphicsImageRendererFormat.default()
    fmt.opaque = false
    let r = UIGraphicsImageRenderer(size: CGSize(width: size, height: size), format: fmt)
    let img = r.image { _ in
      let font = UIFont.systemFont(ofSize: size * 0.82)
      let s = NSAttributedString(string: glyph, attributes: [.font: font])
      let b = s.boundingRect(with: CGSize(width: size * 2, height: size * 2), options: [.usesLineFragmentOrigin], context: nil)
      s.draw(at: CGPoint(x: (size - b.width) / 2, y: (size - b.height) / 2))
    }
    cache[k] = img
    return img
  }

  static func reactionColor(_ kind: String) -> UIColor {
    return kind == "heart" ? UIColor(red: 1, green: 0.19, blue: 0.25, alpha: 1) : .white
  }

  private static func render(_ kind: String, size: CGFloat) -> UIImage? {
    let color = reactionColor(kind)
    let fmt = UIGraphicsImageRendererFormat.default()
    fmt.opaque = false
    let r = UIGraphicsImageRenderer(size: CGSize(width: size, height: size), format: fmt)
    return r.image { ctx in
      let cg = ctx.cgContext
      cg.scaleBy(x: size / 24, y: size / 24)
      cg.setLineCap(.round)
      cg.setLineJoin(.round)
      color.setFill()
      color.setStroke()
      func fill(_ d: String, alpha: CGFloat = 1) {
        let p = SVGPath.parse(d)
        cg.saveGState()
        cg.setAlpha(alpha)
        cg.addPath(p)
        cg.fillPath(using: .evenOdd)
        cg.restoreGState()
      }
      func stroke(_ d: String, width: CGFloat = 2) {
        let p = SVGPath.parse(d)
        cg.setLineWidth(width)
        cg.addPath(p)
        cg.strokePath()
      }
      func circle(_ cx: CGFloat, _ cy: CGFloat, _ rr: CGFloat, width: CGFloat = 2) {
        cg.setLineWidth(width)
        cg.addEllipse(in: CGRect(x: cx - rr, y: cy - rr, width: rr * 2, height: rr * 2))
        cg.strokePath()
      }
      func dot(_ cx: CGFloat, _ cy: CGFloat) {
        cg.addEllipse(in: CGRect(x: cx - 1.5, y: cy - 1.5, width: 3, height: 3))
        cg.fillPath()
      }
      switch kind {
      case "heart":
        fill("M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z")
      case "flame":
        fill("M12 22c-4.97 0-8-3.58-8-7.5C4 10 8 6 9.5 4.5c0 0 1 3 3.5 4.5 1-.5 2-3 2-3C17 8 20 10.5 20 14.5c0 3.92-3.03 7.5-8 7.5zm0-3c1.66 0 3-1.12 3-2.5S13.5 14 12 13c-1.5 1-3 1.62-3 3S10.34 19 12 19z")
      case "laugh":
        circle(12, 12, 10)
        stroke("M8 14s1.5 2 4 2 4-2 4-2")
        dot(9, 9)
        dot(15, 9)
        stroke("M6.5 11.5c.3.2.6.2.8 0M17.5 11.5c-.3.2-.6.2-.8 0", width: 1)
      case "wow":
        circle(12, 12, 10)
        circle(12, 16, 2)
        dot(9, 9)
        dot(15, 9)
      case "sad":
        circle(12, 12, 10)
        stroke("M16 16s-1.5-2-4-2-4 2-4 2")
        dot(9, 9)
        dot(15, 9)
      case "clap":
        fill("M12 2.5l.6 1.8.6-1.8h1.9l-1.5 1.2.6 1.8L12 4.3l-1.2.9.6-1.8L10 2.5h1.9z", alpha: 0.5)
        fill("M18 4l.4 1.2.4-1.2h1.3l-1 .8.4 1.2-.8-.6-.8.6.4-1.2-1-.8H18z", alpha: 0.5)
        fill("M6 5l.4 1.2.4-1.2h1.3l-1 .8.4 1.2-.8-.6-.8.6.4-1.2-1-.8H6z", alpha: 0.5)
        fill("M8.5 8.5l3-3a1.5 1.5 0 0 1 2.1 2.1l-1 1 3-3a1.5 1.5 0 0 1 2.1 2.1l-3 3 .5-.5a1.5 1.5 0 0 1 2.1 2.1l-.5.5a1.5 1.5 0 0 1 2.1 2.1l-4.5 4.5c-2.5 2.5-6.5 2.5-9 0l-.5-.5a4 4 0 0 1 0-5.7L8.5 8.5z")
      default: // thumbs
        fill("M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3m7-2V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z")
      }
    }
  }
}

enum SVGPath {
  static func parse(_ d: String) -> CGPath {
    let path = CGMutablePath()
    var tokens: [String] = []
    var cur = ""
    func flush() {
      if !cur.isEmpty { tokens.append(cur); cur = "" }
    }
    var prev: Character = " "
    for ch in d {
      if ch.isLetter && ch != "e" && ch != "E" {
        flush()
        tokens.append(String(ch))
      } else if ch == "," || ch == " " || ch == "\n" || ch == "\t" {
        flush()
      } else if ch == "-" && !(prev == "e" || prev == "E") {
        flush()
        cur.append(ch)
      } else if ch == "." && cur.contains(".") {
        flush()
        cur.append(ch)
      } else {
        cur.append(ch)
      }
      prev = ch
    }
    flush()

    var i = 0
    var cmd: Character = "M"
    var pt = CGPoint.zero
    var start = CGPoint.zero
    var lastCtrl: CGPoint? = nil
    var lastCmd: Character = " "

    func num() -> CGFloat? {
      guard i < tokens.count, let v = Double(tokens[i]) else { return nil }
      i += 1
      return CGFloat(v)
    }
    // Flags do arco podem vir colados ("0 0 1" ou "001").
    func flag() -> Bool? {
      guard i < tokens.count else { return nil }
      let t = tokens[i]
      if t.count > 1, let f = t.first, f == "0" || f == "1" {
        tokens[i] = String(t.dropFirst())
        return f == "1"
      }
      i += 1
      return t == "1"
    }

    while i < tokens.count {
      let t = tokens[i]
      if let c = t.first, t.count == 1, c.isLetter {
        cmd = c
        i += 1
        if c == "z" || c == "Z" {
          path.closeSubpath()
          pt = start
          lastCtrl = nil
          lastCmd = c
          continue
        }
      }
      let rel = cmd.isLowercase
      let ox = rel ? pt.x : 0
      let oy = rel ? pt.y : 0
      switch cmd {
      case "M", "m":
        guard let x = num(), let y = num() else { i = tokens.count; break }
        pt = CGPoint(x: ox + x, y: oy + y)
        start = pt
        path.move(to: pt)
        cmd = rel ? "l" : "L"
        lastCtrl = nil
      case "L", "l":
        guard let x = num(), let y = num() else { i = tokens.count; break }
        pt = CGPoint(x: ox + x, y: oy + y)
        path.addLine(to: pt)
        lastCtrl = nil
      case "H", "h":
        guard let x = num() else { i = tokens.count; break }
        pt = CGPoint(x: ox + x, y: pt.y)
        path.addLine(to: pt)
        lastCtrl = nil
      case "V", "v":
        guard let y = num() else { i = tokens.count; break }
        pt = CGPoint(x: pt.x, y: oy + y)
        path.addLine(to: pt)
        lastCtrl = nil
      case "C", "c":
        guard let x1 = num(), let y1 = num(), let x2 = num(), let y2 = num(), let x = num(), let y = num() else { i = tokens.count; break }
        let c2 = CGPoint(x: ox + x2, y: oy + y2)
        pt = CGPoint(x: ox + x, y: oy + y)
        path.addCurve(to: pt, control1: CGPoint(x: ox + x1, y: oy + y1), control2: c2)
        lastCtrl = c2
      case "S", "s":
        guard let x2 = num(), let y2 = num(), let x = num(), let y = num() else { i = tokens.count; break }
        var c1 = pt
        if let lc = lastCtrl, "CcSs".contains(lastCmd) {
          c1 = CGPoint(x: 2 * pt.x - lc.x, y: 2 * pt.y - lc.y)
        }
        let c2 = CGPoint(x: ox + x2, y: oy + y2)
        pt = CGPoint(x: ox + x, y: oy + y)
        path.addCurve(to: pt, control1: c1, control2: c2)
        lastCtrl = c2
      case "Q", "q":
        guard let x1 = num(), let y1 = num(), let x = num(), let y = num() else { i = tokens.count; break }
        let c = CGPoint(x: ox + x1, y: oy + y1)
        pt = CGPoint(x: ox + x, y: oy + y)
        path.addQuadCurve(to: pt, control: c)
        lastCtrl = c
      case "T", "t":
        guard let x = num(), let y = num() else { i = tokens.count; break }
        var c = pt
        if let lc = lastCtrl, "QqTt".contains(lastCmd) {
          c = CGPoint(x: 2 * pt.x - lc.x, y: 2 * pt.y - lc.y)
        }
        pt = CGPoint(x: ox + x, y: oy + y)
        path.addQuadCurve(to: pt, control: c)
        lastCtrl = c
      case "A", "a":
        guard let rx = num(), let ry = num(), let rot = num(), let large = flag(), let sweep = flag(), let x = num(), let y = num() else { i = tokens.count; break }
        let end = CGPoint(x: ox + x, y: oy + y)
        addArc(path, from: pt, to: end, rx: rx, ry: ry, rotDeg: rot, large: large, sweep: sweep)
        pt = end
        lastCtrl = nil
      default:
        i += 1
      }
      lastCmd = cmd
    }
    return path
  }

  /// Arco SVG (endpoint) → curvas cúbicas (≤ 90° cada).
  private static func addArc(_ path: CGMutablePath, from p0: CGPoint, to p1: CGPoint, rx rxIn: CGFloat, ry ryIn: CGFloat, rotDeg: CGFloat, large: Bool, sweep: Bool) {
    var rx = abs(rxIn)
    var ry = abs(ryIn)
    if rx == 0 || ry == 0 || (p0.x == p1.x && p0.y == p1.y) {
      path.addLine(to: p1)
      return
    }
    let phi = rotDeg * .pi / 180
    let cosP = cos(phi)
    let sinP = sin(phi)
    let dx = (p0.x - p1.x) / 2
    let dy = (p0.y - p1.y) / 2
    let x1p = cosP * dx + sinP * dy
    let y1p = -sinP * dx + cosP * dy
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lambda > 1 {
      let s = sqrt(lambda)
      rx *= s
      ry *= s
    }
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    var coef = den == 0 ? 0 : sqrt(max(0, num / den))
    if large == sweep { coef = -coef }
    let cxp = coef * (rx * y1p / ry)
    let cyp = coef * -(ry * x1p / rx)
    let cx = cosP * cxp - sinP * cyp + (p0.x + p1.x) / 2
    let cy = sinP * cxp + cosP * cyp + (p0.y + p1.y) / 2
    func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
      let dot = ux * vx + uy * vy
      let len = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
      var a = acos(max(-1, min(1, dot / len)))
      if ux * vy - uy * vx < 0 { a = -a }
      return a
    }
    let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    var dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if !sweep && dTheta > 0 { dTheta -= 2 * .pi }
    if sweep && dTheta < 0 { dTheta += 2 * .pi }
    let segs = max(1, Int(ceil(abs(dTheta) / (.pi / 2))))
    let delta = dTheta / CGFloat(segs)
    let t = 4.0 / 3.0 * tan(delta / 4)
    var th = theta1
    for _ in 0..<segs {
      let c1 = cos(th), s1 = sin(th)
      let c2 = cos(th + delta), s2 = sin(th + delta)
      let e1 = CGPoint(x: c1 - t * s1, y: s1 + t * c1)
      let e2 = CGPoint(x: c2 + t * s2, y: s2 - t * c2)
      let e = CGPoint(x: c2, y: s2)
      func map(_ p: CGPoint) -> CGPoint {
        let x = p.x * rx
        let y = p.y * ry
        return CGPoint(x: cosP * x - sinP * y + cx, y: sinP * x + cosP * y + cy)
      }
      path.addCurve(to: map(e), control1: map(e1), control2: map(e2))
      th += delta
    }
  }
}
