import UIKit
import QuartzCore

// [2026-10-15 native-effects] Motor dos efeitos de tela cheia (iOS).
//
// Cada play() cria um container (UIView sem toques) por cima de tudo na key
// window; as partículas são CALayers com CAAnimation (rodam no render server,
// 120 Hz no ProMotion via preferredFrameRateRange — Info.plist já tem
// CADisableMinimumFrameDurationOnPhone) e CAEmitterLayer para faíscas /
// rastros. O container some sozinho no fim (ttl). "Reduzir Movimento" → no-op.
// Coreografia/tempos espelham components/MessageScreenEffect.js e o antigo
// MessageEffectOverlay (hearts/fire/party) de app/chat-conversation.js.

// MARK: - utilidades

@inline(__always) func ceRand(_ a: CGFloat, _ b: CGFloat) -> CGFloat {
  if b <= a { return a }
  return CGFloat.random(in: a...b)
}

@inline(__always) func ceRandD(_ a: Double, _ b: Double) -> Double {
  if b <= a { return a }
  return Double.random(in: a...b)
}

func ceColor(_ hex: UInt32, _ alpha: CGFloat = 1) -> UIColor {
  return UIColor(
    red: CGFloat((hex >> 16) & 0xFF) / 255,
    green: CGFloat((hex >> 8) & 0xFF) / 255,
    blue: CGFloat(hex & 0xFF) / 255,
    alpha: alpha
  )
}

enum CEEase {
  static let linear = CAMediaTimingFunction(name: .linear)
  static let inOut = CAMediaTimingFunction(name: .easeInEaseOut)
  static let outCubic = CAMediaTimingFunction(controlPoints: 0.33, 1, 0.68, 1)
  static func bz(_ a: Float, _ b: Float, _ c: Float, _ d: Float) -> CAMediaTimingFunction {
    return CAMediaTimingFunction(controlPoints: a, b, c, d)
  }
}

// MARK: - contexto de uma execução

final class CECtx {
  let root: CALayer
  let W: CGFloat
  let H: CGFloat
  let dark: Bool
  let intensity: CGFloat
  let origin: CGRect?
  let emoji: String?
  let screenScale: CGFloat
  let t0: CFTimeInterval

  init(root: CALayer, size: CGSize, dark: Bool, intensity: CGFloat, origin: CGRect?, emoji: String?, scale: CGFloat) {
    self.root = root
    self.W = size.width
    self.H = size.height
    self.dark = dark
    self.intensity = intensity
    self.origin = origin
    self.emoji = emoji
    self.screenScale = scale
    self.t0 = CACurrentMediaTime()
  }

  /// Tinta "P&B" do app: grafite no claro, quase-branco no escuro.
  var ink: UIColor { return dark ? UIColor(white: 0.94, alpha: 1) : ceColor(0x111111) }

  func n(_ base: Int) -> Int { return max(1, Int((CGFloat(base) * intensity).rounded())) }

  func add(_ l: CALayer, to parent: CALayer? = nil) {
    l.contentsScale = screenScale
    (parent ?? root).addSublayer(l)
  }

  /// Agenda `a` em t0 + delay no tempo local de `l` (a camada precisa já estar na árvore).
  func run(_ l: CALayer, _ a: CAAnimation, delay: CFTimeInterval, key: String) {
    a.beginTime = l.convertTime(t0, from: nil) + delay
    a.fillMode = .both
    a.isRemovedOnCompletion = false
    if #available(iOS 15.0, *) {
      a.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
    }
    l.add(a, forKey: key)
  }

  func basic(_ path: String, _ from: CGFloat, _ to: CGFloat, _ dur: CFTimeInterval, _ tf: CAMediaTimingFunction? = nil, additive: Bool = false) -> CABasicAnimation {
    let a = CABasicAnimation(keyPath: path)
    a.fromValue = NSNumber(value: Double(from))
    a.toValue = NSNumber(value: Double(to))
    a.duration = dur
    a.timingFunction = tf
    a.isAdditive = additive
    return a
  }

  func keys(_ path: String, _ values: [CGFloat], _ times: [Double]?, _ dur: CFTimeInterval, _ tf: CAMediaTimingFunction? = nil, additive: Bool = false) -> CAKeyframeAnimation {
    let a = CAKeyframeAnimation(keyPath: path)
    a.values = values.map { NSNumber(value: Double($0)) }
    if let t = times { a.keyTimes = t.map { NSNumber(value: $0) } }
    a.duration = dur
    a.timingFunction = tf
    a.isAdditive = additive
    return a
  }

  func points(_ pts: [CGPoint], _ times: [Double]?, _ dur: CFTimeInterval, _ tf: CAMediaTimingFunction? = nil) -> CAKeyframeAnimation {
    let a = CAKeyframeAnimation(keyPath: "position")
    a.values = pts.map { NSValue(cgPoint: $0) }
    if let t = times { a.keyTimes = t.map { NSNumber(value: $0) } }
    a.duration = dur
    a.timingFunction = tf
    a.calculationMode = .cubic
    return a
  }

  func sway(_ l: CALayer, amp: CGFloat, period: CFTimeInterval, delay: CFTimeInterval, path: String = "position.x") {
    let a = basic(path, -amp, amp, period, CEEase.inOut, additive: true)
    a.autoreverses = true
    a.repeatCount = .greatestFiniteMagnitude
    run(l, a, delay: delay, key: "sway." + path)
  }

  /// Camada-imagem centrada em `p`.
  func imageLayer(_ img: CGImage?, size: CGSize, at p: CGPoint) -> CALayer {
    let l = CALayer()
    l.contents = img
    l.contentsGravity = .resize
    l.bounds = CGRect(origin: .zero, size: size)
    l.position = p
    return l
  }
}

// MARK: - imagens (cacheadas)

enum CEImages {
  private static var cache: [String: CGImage] = [:]

  static func render(_ key: String, _ size: CGSize, _ draw: (CGContext, CGSize) -> Void) -> CGImage? {
    if let c = cache[key] { return c }
    let f = UIGraphicsImageRendererFormat.preferred()
    f.opaque = false
    let img = UIGraphicsImageRenderer(size: size, format: f).image { ctx in draw(ctx.cgContext, size) }.cgImage
    if let i = img {
      if cache.count > 160 { cache.removeAll() }
      cache[key] = i
    }
    return img
  }

  static func hexKey(_ c: UIColor) -> String {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    c.getRed(&r, green: &g, blue: &b, alpha: &a)
    return "\(Int(r * 255))-\(Int(g * 255))-\(Int(b * 255))-\(Int(a * 255))"
  }

  static func heartPath(_ s: CGFloat, inset: CGFloat = 0) -> CGPath {
    let k = (s - inset * 2) / 24
    func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint { return CGPoint(x: inset + x * k, y: inset + y * k) }
    let p = UIBezierPath()
    p.move(to: P(12, 21))
    p.addCurve(to: P(2.5, 11.5), controlPoint1: P(12, 21), controlPoint2: P(4.5, 16.5))
    p.addCurve(to: P(7, 5), controlPoint1: P(1.5, 8), controlPoint2: P(4, 5))
    p.addCurve(to: P(12, 8), controlPoint1: P(9, 5), controlPoint2: P(10.5, 6))
    p.addCurve(to: P(17, 5), controlPoint1: P(13.5, 6), controlPoint2: P(15, 5))
    p.addCurve(to: P(21.5, 11.5), controlPoint1: P(20, 5), controlPoint2: P(22.5, 8))
    p.addCurve(to: P(12, 21), controlPoint1: P(19.5, 16.5), controlPoint2: P(12, 21))
    p.close()
    return p.cgPath
  }

  static func starPath(_ s: CGFloat, inset: CGFloat = 0) -> CGPath {
    let k = (s - inset * 2) / 24
    let pts: [(CGFloat, CGFloat)] = [(12, 2), (14.6, 9), (22, 9), (16, 13.5), (18.3, 20.5), (12, 16), (5.7, 20.5), (8, 13.5), (2, 9), (9.4, 9)]
    let p = UIBezierPath()
    for (i, q) in pts.enumerated() {
      let pt = CGPoint(x: inset + q.0 * k, y: inset + q.1 * k)
      if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
    }
    p.close()
    return p.cgPath
  }

  /// Ponto luminoso: núcleo branco → cor → transparente.
  static func glowDot(_ c: UIColor, _ d: CGFloat) -> CGImage? {
    return render("dot-\(hexKey(c))-\(Int(d))", CGSize(width: d, height: d)) { ctx, sz in
      let cs = CGColorSpaceCreateDeviceRGB()
      let colors = [UIColor.white.cgColor, c.cgColor, c.withAlphaComponent(0).cgColor] as CFArray
      guard let g = CGGradient(colorsSpace: cs, colors: colors, locations: [0, 0.32, 1]) else { return }
      let ctr = CGPoint(x: sz.width / 2, y: sz.height / 2)
      ctx.drawRadialGradient(g, startCenter: ctr, startRadius: 0, endCenter: ctr, endRadius: sz.width / 2, options: [])
    }
  }

  static func softDot(_ c: UIColor, _ d: CGFloat) -> CGImage? {
    return render("soft-\(hexKey(c))-\(Int(d))", CGSize(width: d, height: d)) { ctx, sz in
      let cs = CGColorSpaceCreateDeviceRGB()
      let colors = [c.cgColor, c.withAlphaComponent(0.6).cgColor, c.withAlphaComponent(0).cgColor] as CFArray
      guard let g = CGGradient(colorsSpace: cs, colors: colors, locations: [0, 0.45, 1]) else { return }
      let ctr = CGPoint(x: sz.width / 2, y: sz.height / 2)
      ctx.drawRadialGradient(g, startCenter: ctr, startRadius: 0, endCenter: ctr, endRadius: sz.width / 2, options: [])
    }
  }

  static func heart(_ c: UIColor, _ s: CGFloat, glow: Bool = false) -> CGImage? {
    return render("heart-\(hexKey(c))-\(Int(s))-\(glow)", CGSize(width: s, height: s)) { ctx, sz in
      if glow {
        let cs = CGColorSpaceCreateDeviceRGB()
        let colors = [c.withAlphaComponent(0.55).cgColor, c.withAlphaComponent(0).cgColor] as CFArray
        if let g = CGGradient(colorsSpace: cs, colors: colors, locations: [0, 1]) {
          let ctr = CGPoint(x: sz.width / 2, y: sz.height / 2)
          ctx.drawRadialGradient(g, startCenter: ctr, startRadius: 0, endCenter: ctr, endRadius: sz.width / 2, options: [])
        }
      }
      let path = heartPath(sz.width, inset: glow ? sz.width * 0.12 : 0)
      ctx.addPath(path)
      ctx.setFillColor(c.cgColor)
      ctx.fillPath()
      // brilho especular discreto (volume)
      ctx.saveGState()
      ctx.addPath(path)
      ctx.clip()
      let hl = CGRect(x: sz.width * 0.22, y: sz.height * 0.2, width: sz.width * 0.26, height: sz.height * 0.16)
      ctx.setFillColor(UIColor(white: 1, alpha: 0.22).cgColor)
      ctx.fillEllipse(in: hl)
      ctx.restoreGState()
    }
  }

  static func star(_ s: CGFloat) -> CGImage? {
    return render("star-\(Int(s))", CGSize(width: s, height: s)) { ctx, sz in
      let cs = CGColorSpaceCreateDeviceRGB()
      let gold = ceColor(0xFFD700)
      let colors = [gold.withAlphaComponent(0.9).cgColor, gold.withAlphaComponent(0).cgColor] as CFArray
      if let g = CGGradient(colorsSpace: cs, colors: colors, locations: [0, 1]) {
        let ctr = CGPoint(x: sz.width / 2, y: sz.height / 2)
        ctx.drawRadialGradient(g, startCenter: ctr, startRadius: 0, endCenter: ctr, endRadius: sz.width / 2, options: [])
      }
      ctx.addPath(starPath(sz.width, inset: sz.width * 0.12))
      ctx.setFillColor(gold.cgColor)
      ctx.setStrokeColor(ceColor(0xFFA500).cgColor)
      ctx.setLineWidth(sz.width / 48)
      ctx.drawPath(using: .fillStroke)
    }
  }

  /// Balão 100×190 unidades (corpo 100×102 + barbante).
  static func balloon(_ c: UIColor, _ w: CGFloat) -> CGImage? {
    return render("balloon-\(hexKey(c))-\(Int(w))", CGSize(width: w, height: w * 1.9)) { ctx, _ in
      let k = w / 100
      func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint { return CGPoint(x: x * k, y: y * k) }
      let body = UIBezierPath()
      body.move(to: P(50, 4))
      body.addCurve(to: P(12, 48), controlPoint1: P(24, 4), controlPoint2: P(12, 26))
      body.addCurve(to: P(50, 96), controlPoint1: P(12, 72), controlPoint2: P(28, 92))
      body.addCurve(to: P(88, 48), controlPoint1: P(72, 92), controlPoint2: P(88, 72))
      body.addCurve(to: P(50, 4), controlPoint1: P(88, 26), controlPoint2: P(76, 4))
      body.close()
      // barbante
      let s = UIBezierPath()
      s.move(to: P(50, 102))
      s.addQuadCurve(to: P(51, 140), controlPoint: P(46, 120))
      s.addQuadCurve(to: P(50, 186), controlPoint: P(56, 165))
      ctx.addPath(s.cgPath)
      ctx.setStrokeColor(UIColor(white: 0.5, alpha: 0.6).cgColor)
      ctx.setLineWidth(max(1, k * 1.2))
      ctx.strokePath()
      // nó
      let knot = UIBezierPath()
      knot.move(to: P(44, 96)); knot.addLine(to: P(56, 96)); knot.addLine(to: P(52, 103)); knot.addLine(to: P(48, 103)); knot.close()
      ctx.addPath(knot.cgPath)
      ctx.setFillColor(c.cgColor)
      ctx.fillPath()
      // corpo + brilho radial
      ctx.saveGState()
      ctx.addPath(body.cgPath)
      ctx.clip()
      ctx.setFillColor(c.cgColor)
      ctx.fill(CGRect(x: 0, y: 0, width: w, height: w))
      let cs = CGColorSpaceCreateDeviceRGB()
      let colors = [UIColor(white: 1, alpha: 0.55).cgColor, UIColor(white: 1, alpha: 0).cgColor] as CFArray
      if let g = CGGradient(colorsSpace: cs, colors: colors, locations: [0, 1]) {
        ctx.drawRadialGradient(g, startCenter: P(36, 30), startRadius: 0, endCenter: P(36, 30), endRadius: 42 * k, options: [])
      }
      let shade = [UIColor(white: 0, alpha: 0).cgColor, UIColor(white: 0, alpha: 0.18).cgColor] as CFArray
      if let g2 = CGGradient(colorsSpace: cs, colors: shade, locations: [0, 1]) {
        ctx.drawRadialGradient(g2, startCenter: P(42, 40), startRadius: 30 * k, endCenter: P(50, 50), endRadius: 60 * k, options: [])
      }
      ctx.restoreGState()
    }
  }

  static func emoji(_ s: String, _ pt: CGFloat) -> CGImage? {
    let font = UIFont.systemFont(ofSize: pt)
    let str = NSAttributedString(string: s, attributes: [.font: font])
    let b = str.size()
    let sz = CGSize(width: ceil(max(b.width, pt)) + 4, height: ceil(max(b.height, pt)) + 4)
    return render("emoji-\(s)-\(Int(pt))", sz) { _, size in
      str.draw(at: CGPoint(x: (size.width - b.width) / 2, y: (size.height - b.height) / 2))
    }
  }
}

// MARK: - efeitos

enum CEEffects {
  static let names: Set<String> = [
    "echo", "spotlight", "balloons", "confetti", "love", "lasers", "fireworks",
    "shooting-star", "celebration", "hearts", "fire", "party",
  ]

  /// Roda o efeito e devolve o tempo total (s) até poder remover o container.
  static func run(_ name: String, _ c: CECtx) -> CFTimeInterval {
    switch name {
    case "balloons": return balloons(c)
    case "confetti": return confetti(c, golden: false)
    case "celebration": return celebration(c)
    case "love": return love(c)
    case "fireworks": return fireworks(c)
    case "lasers": return lasers(c)
    case "spotlight": return spotlight(c)
    case "echo": return echo(c)
    case "shooting-star": return shootingStar(c)
    case "hearts":
      let set = c.emoji.map { [$0] } ?? ["\u{2764}\u{FE0F}", "\u{1F496}", "\u{1F497}", "\u{1F495}", "\u{1F49E}", "\u{1F493}"]
      return emojiRise(c, chars: set, base: 18, gentle: true)
    case "fire":
      let set = c.emoji.map { [$0] } ?? ["\u{1F525}", "\u{1F31F}", "\u{2728}", "\u{1F4A5}", "\u{1F31E}"]
      return emojiRise(c, chars: set, base: 14, gentle: false)
    case "party":
      let set = c.emoji.map { [$0] } ?? ["\u{1F389}", "\u{1F38A}", "\u{2728}", "\u{1F386}", "\u{1F387}", "\u{1F973}", "\u{1F388}"]
      return emojiRise(c, chars: set, base: 30, gentle: false)
    default: return 0
    }
  }

  // ── flash branco (lasers / fireworks / celebration)
  static func flash(_ c: CECtx) {
    let l = CALayer()
    l.frame = CGRect(x: 0, y: 0, width: c.W, height: c.H)
    l.backgroundColor = UIColor.white.cgColor
    l.opacity = 0
    c.add(l)
    c.run(l, c.keys("opacity", [0, 0.2, 0], [0, 0.25, 1], 0.32), delay: 0, key: "o")
  }

  // ── Balloons
  static func balloons(_ c: CECtx) -> CFTimeInterval {
    let ink = c.ink
    let colors: [UIColor] = [ceColor(0xEF4444), ceColor(0xF59E0B), ceColor(0xFACC15), ceColor(0x10B981), ceColor(0x3B82F6), ink, ceColor(0xFB7185), ceColor(0x06B6D4)]
    let count = c.n(28)
    var end: CFTimeInterval = 0
    for i in 0..<count {
      let size = ceRand(34, 64)
      let h = size * 1.9
      let x = ceRand(4, max(5, c.W - 60)) + size / 2
      let delay = Double(i) * 0.06 + ceRandD(0, 0.22)
      let dur = ceRandD(3.8, 4.8)
      let swayAmp = ceRand(6, 18)
      let period = ceRandD(0.8, 1.5)
      let l = c.imageLayer(CEImages.balloon(colors[i % colors.count], 64), size: CGSize(width: size, height: h), at: CGPoint(x: x, y: c.H + 80 + h / 2))
      l.opacity = 0
      c.add(l)
      let startY = c.H + 80 + h / 2
      let endY = -h / 2 - 20
      c.run(l, c.basic("position.y", startY, endY, dur, CEEase.bz(0.1, 0.5, 0.4, 1)), delay: delay, key: "y")
      c.run(l, c.keys("opacity", [0, 1, 1, 0], [0, 0.24 / dur, 1 - 0.22 / dur, 1], dur), delay: delay, key: "o")
      c.sway(l, amp: swayAmp, period: period, delay: delay)
      c.sway(l, amp: swayAmp * 0.006, period: period, delay: delay, path: "transform.rotation.z")
      end = max(end, delay + dur)
    }
    return end + 0.1
  }

  // ── Confetti (golden = celebration)
  static func confetti(_ c: CECtx, golden: Bool) -> CFTimeInterval {
    let colors: [UIColor] = golden
      ? [ceColor(0xFACC15), ceColor(0xF59E0B), ceColor(0xFCD34D), c.dark ? ceColor(0xFFFFFF) : ceColor(0xD4A017), ceColor(0xEAB308)]
      : [ceColor(0xEF4444), ceColor(0xF59E0B), ceColor(0xFACC15), ceColor(0x10B981), ceColor(0x3B82F6), c.ink, ceColor(0xFB7185), ceColor(0x06B6D4)]
    let count = c.n(180)
    let xs: [CGFloat] = [0, 0.4, 0.2, 0.8, 1]
    let tf = CEEase.bz(0.2, 0.4, 0.4, 1)
    var end: CFTimeInterval = 0
    for i in 0..<count {
      let fromX = ceRand(0, c.W)
      let drift = ceRand(-160, 160)
      let dur = ceRandD(2.0, 3.8)
      let delay = ceRandD(0, 1.0)
      let size = ceRand(5, 16)
      let ratio = ceRand(0.35, 1)
      let color = colors[i % colors.count]
      let l: CALayer
      switch i % 4 {
      case 0:
        l = CALayer()
        l.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        l.cornerRadius = size / 2
        l.backgroundColor = color.cgColor
      case 1:
        l = CALayer()
        l.bounds = CGRect(x: 0, y: 0, width: size, height: max(2, size * ratio))
        l.cornerRadius = 1.5
        l.backgroundColor = color.cgColor
      case 2:
        l = CALayer()
        l.bounds = CGRect(x: 0, y: 0, width: size, height: max(1.5, size * 0.25))
        l.cornerRadius = 1
        l.backgroundColor = color.cgColor
      default:
        let s = CAShapeLayer()
        let side = size + 2
        s.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        let p = UIBezierPath()
        p.move(to: CGPoint(x: side / 2, y: 0))
        p.addLine(to: CGPoint(x: side, y: side * 0.9))
        p.addLine(to: CGPoint(x: 0, y: side * 0.9))
        p.close()
        s.path = p.cgPath
        s.fillColor = color.cgColor
        l = s
      }
      l.position = CGPoint(x: fromX, y: -30)
      l.opacity = 0
      c.add(l)
      var pts: [CGPoint] = []
      for k in 0..<5 {
        let t = CGFloat(k) / 4
        pts.append(CGPoint(x: fromX + drift * xs[k], y: -30 + (c.H + 60) * t))
      }
      c.run(l, c.points(pts, [0, 0.25, 0.5, 0.75, 1], dur, tf), delay: delay, key: "p")
      c.run(l, c.keys("opacity", [0, 1, 1, 0], [0, 0.05, 0.75, 1], dur, tf), delay: delay, key: "o")
      let turns = ceRand(2, 8) * (Bool.random() ? 1 : -1)
      c.run(l, c.basic("transform.rotation.z", 0, turns * 2 * .pi, dur, CEEase.linear, additive: true), delay: delay, key: "rz")
      // "flutter" 3D: sem perspectiva o giro em X achata/vira o papel.
      c.run(l, c.basic("transform.rotation.x", 0, ceRand(1, 3) * 2 * .pi, dur, CEEase.linear, additive: true), delay: delay, key: "rx")
      end = max(end, delay + dur)
    }
    return end + 0.1
  }

  // ── Love: coração central (pop + batida + expande) + corações subindo
  static func love(_ c: CECtx) -> CFTimeInterval {
    let ink = c.ink
    let center = c.origin.map { CGPoint(x: $0.midX, y: $0.midY) } ?? CGPoint(x: c.W / 2, y: c.H * 0.4 + 60)
    let bloom = c.imageLayer(CEImages.heart(ink, 240, glow: true), size: CGSize(width: 120, height: 120), at: center)
    bloom.opacity = 0
    c.add(bloom)
    c.run(bloom, c.keys("transform.scale", [0.2, 1.25, 1.0, 1.12, 1.0, 2.4], [0, 0.24, 0.36, 0.5, 0.62, 1], 1.45, CEEase.inOut), delay: 0, key: "s")
    c.run(bloom, c.keys("opacity", [0, 0.95, 0.95, 0.9, 0], [0, 0.15, 0.6, 0.7, 1], 1.45), delay: 0, key: "o")

    let colors: [UIColor] = [ceColor(0xFB7185), ink, ceColor(0xF43F5E)]
    let count = c.n(32)
    var end: CFTimeInterval = 1.5
    for i in 0..<count {
      let x = ceRand(20, max(21, c.W - 40)) + 10
      let delay = ceRandD(0, 1.1)
      let dur = ceRandD(2.4, 3.6)
      let size = ceRand(18, 42)
      let l = c.imageLayer(CEImages.heart(colors[i % 3], 84), size: CGSize(width: size, height: size), at: CGPoint(x: x, y: c.H - 60))
      l.opacity = 0
      c.add(l)
      c.run(l, c.basic("position.y", c.H - 60 + size / 2, -60, dur, CEEase.outCubic), delay: delay, key: "y")
      c.run(l, c.keys("opacity", [0, 0.95, 0.95, 0], [0, 0.05, 0.85, 1], dur, CEEase.outCubic), delay: delay, key: "o")
      c.run(l, c.keys("transform.scale", [0.4, 1.1, 1], [0, 0.6, 1], 0.35), delay: delay, key: "s")
      c.sway(l, amp: ceRand(20, 50), period: 1.1, delay: delay)
      c.sway(l, amp: 0.18, period: 1.1, delay: delay, path: "transform.rotation.z")
      end = max(end, delay + dur)
    }
    return end + 0.1
  }

  // ── Lasers: 8 feixes neon atravessando em strobe
  static func lasers(_ c: CECtx) -> CFTimeInterval {
    flash(c)
    let ink = c.dark ? ceColor(0xA78BFA) : ceColor(0x111111)
    let beams: [(UIColor, CGFloat, CGFloat, Double, CGFloat)] = [
      (ink, 0.2, 14, 0, 1), (ceColor(0x06B6D4), 0.32, -22, 0.08, -1), (ceColor(0xF59E0B), 0.45, 30, 0.16, 1),
      (ceColor(0xEC4899), 0.55, -18, 0.24, -1), (ceColor(0x10B981), 0.68, 24, 0.32, 1), (ceColor(0xFACC15), 0.78, -28, 0.40, -1),
      (ceColor(0x3B82F6), 0.88, 16, 0.48, 1), (ceColor(0xEF4444), 0.15, -10, 0.56, -1),
    ]
    let bw = c.W * 1.4
    for (color, fy, angle, delay, dir) in beams {
      let beam = CALayer()
      beam.bounds = CGRect(x: 0, y: 0, width: bw, height: 28)
      beam.position = CGPoint(x: bw / 2, y: c.H * fy + 1.5)
      beam.transform = CATransform3DMakeRotation(angle * .pi / 180, 0, 0, 1)
      beam.opacity = 0
      c.add(beam)
      let strobe = CALayer()
      strobe.frame = beam.bounds
      beam.addSublayer(strobe)
      let halo = CAGradientLayer()
      halo.frame = strobe.bounds
      halo.colors = [color.withAlphaComponent(0).cgColor, color.withAlphaComponent(0.55).cgColor, color.withAlphaComponent(0).cgColor]
      halo.locations = [0, 0.5, 1]
      halo.startPoint = CGPoint(x: 0.5, y: 0)
      halo.endPoint = CGPoint(x: 0.5, y: 1)
      strobe.addSublayer(halo)
      let core = CALayer()
      core.frame = CGRect(x: 0, y: 12.5, width: bw, height: 3)
      core.cornerRadius = 1.5
      core.backgroundColor = UIColor.white.cgColor
      core.shadowColor = color.cgColor
      core.shadowOpacity = 1
      core.shadowRadius = 6
      core.shadowOffset = .zero
      core.shadowPath = UIBezierPath(rect: core.bounds).cgPath
      strobe.addSublayer(core)
      let fromX: CGFloat = dir > 0 ? -c.W : c.W * 1.5
      let toX: CGFloat = dir > 0 ? c.W * 1.5 : -c.W
      let tf = CEEase.bz(0.3, 0, 0.6, 1)
      c.run(beam, c.basic("position.x", fromX, toX, 1.5, tf, additive: true), delay: delay, key: "x")
      c.run(beam, c.keys("opacity", [0, 1, 1, 0], [0, 0.1, 0.85, 1], 1.5, tf), delay: delay, key: "o")
      let st = c.basic("opacity", 1, 0.6, 0.09)
      st.autoreverses = true
      st.repeatCount = .greatestFiniteMagnitude
      c.run(strobe, st, delay: delay, key: "strobe")
    }
    return 2.2
  }

  // ── Fogos: explosão (emissor) + clarão
  static func burst(_ c: CECtx, at p: CGPoint, color: UIColor, sparks: Int, delay: Double, power: CGFloat = 1) {
    // clarão (determinístico, por animação)
    let flare = CALayer()
    flare.bounds = CGRect(x: 0, y: 0, width: 32, height: 32)
    flare.cornerRadius = 16
    flare.position = p
    flare.backgroundColor = UIColor.white.cgColor
    flare.opacity = 0
    c.add(flare)
    c.run(flare, c.basic("transform.scale", 0.4, 1.6, 0.2), delay: delay, key: "s")
    c.run(flare, c.keys("opacity", [0, 0.9, 0], [0, 0.5, 1], 0.2), delay: delay, key: "o")

    let n = max(6, Int(CGFloat(sparks) * c.intensity))
    let dark = c.dark
    let screenScale = c.screenScale
    let root = c.root
    let W = c.W, H = c.H
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak root] in
      guard let root = root, root.superlayer != nil else { return }
      let e = CAEmitterLayer()
      e.frame = CGRect(x: 0, y: 0, width: W, height: H)
      e.contentsScale = screenScale
      e.emitterPosition = p
      e.emitterShape = .point
      e.renderMode = dark ? .additive : .unordered
      e.seed = UInt32.random(in: 0...UInt32.max)
      let cell = CAEmitterCell()
      cell.name = "spark"
      cell.contents = CEImages.glowDot(color, 24)
      cell.birthRate = Float(n) / 0.05
      cell.lifetime = 1.25
      cell.lifetimeRange = 0.25
      cell.velocity = 92 * power
      cell.velocityRange = 26 * power
      cell.emissionRange = .pi * 2
      cell.yAcceleration = 55
      cell.scale = 0.42
      cell.scaleRange = 0.12
      cell.scaleSpeed = -0.16
      cell.alphaSpeed = -0.65
      let trail = CAEmitterCell()
      trail.contents = CEImages.glowDot(color, 12)
      trail.birthRate = 26
      trail.lifetime = 0.42
      trail.velocity = 0
      trail.scale = 0.38
      trail.scaleSpeed = -0.7
      trail.alphaSpeed = -2.3
      trail.yAcceleration = 18
      cell.emitterCells = [trail]
      e.emitterCells = [cell]
      e.beginTime = root.convertTime(CACurrentMediaTime(), from: nil)
      root.addSublayer(e)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
        e.setValue(0, forKeyPath: "emitterCells.spark.birthRate")
      }
    }
  }

  static func fireworks(_ c: CECtx) -> CFTimeInterval {
    flash(c)
    let ink = c.dark ? ceColor(0xC4B5FD) : ceColor(0x111111)
    let white = c.dark ? UIColor.white : ceColor(0x9CA3AF)
    let bursts: [(CGFloat, CGFloat, UIColor, Double, Int)] = [
      (0.25, 0.25, ceColor(0xF59E0B), 0, 28), (0.70, 0.20, ceColor(0xEF4444), 0.22, 26),
      (0.50, 0.40, ceColor(0x3B82F6), 0.46, 32), (0.18, 0.50, ceColor(0x10B981), 0.70, 24),
      (0.80, 0.42, ink, 0.94, 28), (0.40, 0.18, ceColor(0xEC4899), 1.18, 34),
      (0.60, 0.60, ceColor(0xFACC15), 1.42, 28), (0.30, 0.62, ceColor(0x06B6D4), 1.66, 24),
      (0.85, 0.55, ceColor(0xFB7185), 1.90, 26),
      (0.15, 0.32, white, 2.20, 14), (0.55, 0.30, white, 2.40, 14), (0.78, 0.68, white, 2.60, 14),
    ]
    for (fx, fy, color, delay, sparks) in bursts {
      burst(c, at: CGPoint(x: c.W * fx, y: c.H * fy), color: color, sparks: sparks, delay: delay, power: sparks < 20 ? 0.7 : 1)
    }
    return 4.2
  }

  // ── Celebration: confete dourado + 3 fogos dourados
  static func celebration(_ c: CECtx) -> CFTimeInterval {
    flash(c)
    let t = confetti(c, golden: true)
    burst(c, at: CGPoint(x: c.W / 2, y: c.H * 0.32), color: ceColor(0xFACC15), sparks: 26, delay: 0)
    burst(c, at: CGPoint(x: c.W * 0.25, y: c.H * 0.45), color: ceColor(0xF59E0B), sparks: 18, delay: 0.5, power: 0.8)
    burst(c, at: CGPoint(x: c.W * 0.75, y: c.H * 0.45), color: ceColor(0xEAB308), sparks: 18, delay: 0.5, power: 0.8)
    return max(t, 2.2)
  }

  // ── Spotlight: escurece + cone de luz + poeira no feixe
  static func spotlight(_ c: CECtx) -> CFTimeInterval {
    let dim = CALayer()
    dim.frame = CGRect(x: 0, y: 0, width: c.W, height: c.H)
    dim.backgroundColor = UIColor.black.cgColor
    dim.opacity = 0
    c.add(dim)
    c.run(dim, c.keys("opacity", [0, 0.7, 0.7, 0], [0, 0.5 / 2.2, 1.7 / 2.2, 1], 2.2), delay: 0, key: "o")

    let cy: CGFloat = c.origin.map { min(0.85, max(0.15, $0.midY / max(1, c.H))) } ?? 0.4
    let cone = CAGradientLayer()
    cone.type = .radial
    cone.frame = dim.frame
    cone.colors = [UIColor(white: 1, alpha: 0.55).cgColor, UIColor(white: 1, alpha: 0.18).cgColor, UIColor(white: 1, alpha: 0).cgColor]
    cone.locations = [0, 0.4, 1]
    cone.startPoint = CGPoint(x: 0.5, y: cy)
    cone.endPoint = CGPoint(x: 0.5 + 0.55, y: cy + 0.55)
    cone.opacity = 0
    c.add(cone)
    c.run(cone, c.keys("opacity", [0, 1, 1, 0], [0, 0.8 / 2.2, 1.7 / 2.2, 1], 2.2, CEEase.outCubic), delay: 0, key: "o")

    let motes = c.n(28)
    for i in 0..<motes {
      let s = ceRand(1.5, 4)
      let p = CGPoint(x: c.W / 2 - 120 + ceRand(0, 240), y: c.H * 0.12 + ceRand(0, c.H * 0.62))
      let m = CALayer()
      m.bounds = CGRect(x: 0, y: 0, width: s, height: s)
      m.cornerRadius = s / 2
      m.backgroundColor = UIColor.white.cgColor
      m.position = p
      m.opacity = 0
      c.add(m)
      let d = Double(i) * 0.05
      let y = c.basic("position.y", 0, -40, 2.0, CEEase.linear, additive: true)
      y.repeatCount = .greatestFiniteMagnitude
      c.run(m, y, delay: d, key: "y")
      let o = c.keys("opacity", [0, 0.7, 0], [0, 0.4, 1], 2.0)
      o.repeatCount = .greatestFiniteMagnitude
      c.run(m, o, delay: d, key: "o")
    }
    return 2.3
  }

  // ── Echo: cópias da bolha espalhando e sumindo
  static func echo(_ c: CECtx) -> CFTimeInterval {
    let color = c.dark ? UIColor(white: 0.9, alpha: 1) : ceColor(0x111111)
    let o = c.origin
    let base = o.map { CGPoint(x: $0.midX, y: $0.midY) } ?? CGPoint(x: c.W / 2, y: c.H / 2 + 21)
    let count = c.n(14)
    var end: CFTimeInterval = 0
    for i in 0..<count {
      let w: CGFloat = o.map { min(max($0.width, 60), c.W * 0.8) } ?? ceRand(110, 200)
      let h: CGFloat = o.map { min(max($0.height, 34), 120) } ?? 42
      let l = CALayer()
      l.bounds = CGRect(x: 0, y: 0, width: w, height: h)
      l.cornerRadius = min(21, h / 2)
      l.backgroundColor = color.cgColor
      let start = CGPoint(x: base.x + ceRand(-30, 30), y: base.y + ceRand(-20, 20))
      l.position = start
      l.opacity = 0
      c.add(l)
      let delay = Double(i) * 0.11 + ceRandD(0, 0.08)
      let dur = ceRandD(1.3, 1.7)
      let angle = CGFloat((i % 3) - 1) * (.pi / 6)
      let dist = ceRand(140, 220)
      c.run(l, c.basic("position.x", 0, sin(angle) * dist, dur, CEEase.outCubic, additive: true), delay: delay, key: "x")
      c.run(l, c.basic("position.y", 0, -dist * 0.85, dur, CEEase.outCubic, additive: true), delay: delay, key: "y")
      c.run(l, c.basic("transform.scale", 0.5, 1.7, dur, CEEase.outCubic), delay: delay, key: "s")
      c.run(l, c.keys("opacity", [0, 0.78, 0.45, 0], [0, 0.12, 0.85, 1], dur, CEEase.outCubic), delay: delay, key: "o")
      end = max(end, delay + dur)
    }
    return end + 0.1
  }

  // ── Shooting star: estrela com rastro cruzando a tela + explosão dourada
  static func shootingStar(_ c: CECtx) -> CFTimeInterval {
    let start = CGPoint(x: -60, y: c.H * 0.18)
    let endP = CGPoint(x: c.W * 0.8, y: c.H * 0.55)
    let mid = CGPoint(x: (start.x + endP.x) / 2, y: (start.y + endP.y) / 2 - c.H * 0.06)
    let travel: CFTimeInterval = 1.1
    let tf = CEEase.bz(0.4, 0, 0.6, 1)

    // rastro: emissor seguindo a estrela
    let trail = CAEmitterLayer()
    trail.frame = CGRect(x: 0, y: 0, width: c.W, height: c.H)
    trail.contentsScale = c.screenScale
    trail.emitterShape = .point
    trail.emitterPosition = start
    trail.renderMode = c.dark ? .additive : .unordered
    let tc = CAEmitterCell()
    tc.name = "trail"
    tc.contents = CEImages.softDot(ceColor(0xFFE58A), 16)
    tc.birthRate = 140
    tc.lifetime = 0.55
    tc.lifetimeRange = 0.15
    tc.velocity = 14
    tc.velocityRange = 10
    tc.emissionRange = .pi * 2
    tc.scale = 0.55
    tc.scaleSpeed = -0.8
    tc.alphaSpeed = -1.7
    trail.emitterCells = [tc]
    trail.beginTime = c.root.convertTime(CACurrentMediaTime(), from: nil)
    c.root.addSublayer(trail)
    let ep = CAKeyframeAnimation(keyPath: "emitterPosition")
    ep.values = [NSValue(cgPoint: start), NSValue(cgPoint: mid), NSValue(cgPoint: endP)]
    ep.keyTimes = [0, 0.5, 1]
    ep.calculationMode = .cubic
    ep.duration = travel
    ep.timingFunction = tf
    c.run(trail, ep, delay: 0, key: "ep")
    DispatchQueue.main.asyncAfter(deadline: .now() + travel) { [weak trail] in
      trail?.setValue(0, forKeyPath: "emitterCells.trail.birthRate")
    }

    let star = c.imageLayer(CEImages.star(100), size: CGSize(width: 50, height: 50), at: start)
    star.opacity = 0
    c.add(star)
    c.run(star, c.points([start, mid, endP], [0, 0.5, 1], travel, tf), delay: 0, key: "p")
    c.run(star, c.keys("opacity", [0, 1, 1, 0], [0, 0.04, 0.8, 1], travel + 0.3), delay: 0, key: "o")
    c.run(star, c.keys("transform.scale", [0.6, 1.2, 0.9, 1.6], [0, 0.4, 0.78, 1], travel + 0.3), delay: 0, key: "s")
    c.run(star, c.basic("transform.rotation.z", 0, 2 * .pi, travel + 0.3, CEEase.linear, additive: true), delay: 0, key: "r")

    burst(c, at: endP, color: ceColor(0xFFD700), sparks: 22, delay: travel, power: 0.75)
    return 2.6
  }

  // ── Emoji subindo (❤️ / 🔥 / 🎉 — antigo MessageEffectOverlay)
  static func emojiRise(_ c: CECtx, chars: [String], base: Int, gentle: Bool) -> CFTimeInterval {
    let count = c.n(base)
    var end: CFTimeInterval = 0
    for i in 0..<count {
      let ch = chars[i % chars.count]
      let size = ceRand(24, 40)
      let startX: CGFloat
      let startY: CGFloat
      if let o = c.origin {
        startX = o.midX + ceRand(-70, 70)
        startY = o.minY + ceRand(-10, 20)
      } else {
        startX = ceRand(size / 2, max(size / 2 + 1, c.W - size / 2))
        startY = c.H + 20 + size / 2
      }
      let drift = ceRand(-60, 60)
      let delay = Double(i) * 0.06
      let dur = ceRandD(1.8, 2.5)
      let targetY = -60 - ceRand(0, 200)
      let l = c.imageLayer(CEImages.emoji(ch, 64), size: CGSize(width: size, height: size), at: CGPoint(x: startX, y: startY))
      l.opacity = 0
      c.add(l)
      let midP = CGPoint(x: startX + drift * 0.35, y: startY + (targetY - startY) * 0.5)
      c.run(l, c.points([CGPoint(x: startX, y: startY), midP, CGPoint(x: startX + drift, y: targetY)], [0, 0.5, 1], dur, CEEase.inOut), delay: delay, key: "p")
      // aparece já visível, some de 0.5 s até ~2.5 s (como o JS)
      let life = max(dur, 2.5)
      c.run(l, c.keys("opacity", [1, 1, 0], [0, 0.5 / life, min(1, 2.5 / life)], life), delay: delay, key: "o")
      if gentle {
        c.run(l, c.keys("transform.scale", [0.3, 1.18, 1], [0, 0.55, 1], 0.32), delay: delay, key: "s")
        c.sway(l, amp: 0.3, period: ceRandD(0.5, 0.8), delay: delay, path: "transform.rotation.z")
      } else {
        let rot = (CGFloat.random(in: 0...1) - 0.5) * 2 * .pi
        c.run(l, c.basic("transform.rotation.z", 0, rot, 2.0, CEEase.inOut, additive: true), delay: delay, key: "r")
      }
      end = max(end, delay + life)
    }
    return end + 0.1
  }
}

// MARK: - overlay na janela

final class CEOverlay {
  static let shared = CEOverlay()
  private var live: [String: UIView] = [:]

  private func keyWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let ordered = scenes.filter { $0.activationState == .foregroundActive } + scenes.filter { $0.activationState != .foregroundActive }
    for s in ordered {
      if let w = s.windows.first(where: { $0.isKeyWindow }) { return w }
    }
    return ordered.first?.windows.first(where: { !$0.isHidden })
  }

  func play(_ name: String, _ d: [String: Any]) -> Bool {
    guard CEEffects.names.contains(name) else { return false }
    // Reduzir Movimento: assumimos (true) e não animamos nada.
    if UIAccessibility.isReduceMotionEnabled { return true }
    guard let win = keyWindow() else { return false }

    live[name]?.removeFromSuperview()
    live[name] = nil

    let v = UIView(frame: win.bounds)
    v.isUserInteractionEnabled = false
    v.backgroundColor = .clear
    v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    v.accessibilityElementsHidden = true
    v.layer.zPosition = 9_999
    win.addSubview(v)

    let dark = (d["dark"] as? Bool) ?? (win.traitCollection.userInterfaceStyle == .dark)
    var intensity = CGFloat((d["intensity"] as? NSNumber)?.doubleValue ?? 1)
    if !intensity.isFinite { intensity = 1 }
    intensity = min(1.6, max(0.3, intensity))
    if ProcessInfo.processInfo.isLowPowerModeEnabled { intensity *= 0.6 }
    var origin: CGRect? = nil
    if let x = (d["x"] as? NSNumber)?.doubleValue, let y = (d["y"] as? NSNumber)?.doubleValue,
       let w = (d["w"] as? NSNumber)?.doubleValue, let h = (d["h"] as? NSNumber)?.doubleValue,
       w > 0, h > 0 {
      origin = CGRect(x: x, y: y, width: w, height: h)
    }
    let emoji = (d["emoji"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(8)) }
    let ctx = CECtx(root: v.layer, size: win.bounds.size, dark: dark, intensity: intensity, origin: origin, emoji: emoji, scale: win.screen.scale)

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let ttl = CEEffects.run(name, ctx)
    CATransaction.commit()

    live[name] = v
    DispatchQueue.main.asyncAfter(deadline: .now() + max(0.5, ttl) + 0.2) { [weak self, weak v] in
      guard let v = v else { return }
      UIView.animate(withDuration: 0.18, animations: { v.alpha = 0 }, completion: { _ in
        v.layer.removeAllAnimations()
        v.removeFromSuperview()
      })
      if self?.live[name] === v { self?.live[name] = nil }
    }
    return true
  }

  func stopAll() {
    for (_, v) in live { v.removeFromSuperview() }
    live.removeAll()
  }
}
