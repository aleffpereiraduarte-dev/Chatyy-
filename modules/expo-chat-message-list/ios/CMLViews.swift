import UIKit
import CoreText

// [2026-10-14 native-list] Views folha desenhadas à mão (sem Auto Layout,
// sem UILabel): recebem o layout pronto do CMLLayoutBuilder e só desenham.

/// [fase 2] Estilo do spoiler (fundo = cor do balão; revelado = sem véu).
struct CMLSpoilerStyle: Equatable {
  var bg: UIColor
  var revealed: Bool
}

/// Desenha um CMLTextLayout (linhas CoreText) + tachado.
final class CMLTextView: UIView {
  var layout: CMLTextLayout? {
    didSet { if layout !== oldValue { setNeedsDisplay() } }
  }
  /// [fase 2] spoiler/emoji customizado
  var spoiler: CMLSpoilerStyle? {
    didSet { if spoiler != oldValue { setNeedsDisplay() } }
  }
  private var pendingEmoji = Set<String>()

  func requestEmoji(_ url: String, _ px: CGFloat) {
    let k = url + "#\(Int(px))"
    if pendingEmoji.contains(k) { return }
    pendingEmoji.insert(k)
    CMLImageLoader.shared.load(url, maxPixel: px, animated: false) { [weak self] img in
      guard let self = self else { return }
      self.pendingEmoji.remove(k)
      if img != nil { self.setNeedsDisplay() }
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
    isUserInteractionEnabled = false
    layer.drawsAsynchronously = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func draw(_ rect: CGRect) {
    guard let l = layout, let ctx = UIGraphicsGetCurrentContext() else { return }
    CMLTextView.drawText(l, in: ctx, origin: .zero, height: bounds.height, spoiler: spoiler, onMissingEmoji: { [weak self] u, px in
      self?.requestEmoji(u, px)
    })
  }

  /// Desenha no contexto (coordenadas UIKit, y p/ baixo) a partir de `origin`.
  static func drawText(_ l: CMLTextLayout, in ctx: CGContext, origin: CGPoint, height: CGFloat,
                       spoiler: CMLSpoilerStyle? = nil, onMissingEmoji: ((String, CGFloat) -> Void)? = nil) {
    if l.hasExtras { drawExtras(l, in: ctx, origin: origin, pass: 0, spoiler: spoiler, onMissingEmoji: onMissingEmoji) }
    ctx.saveGState()
    ctx.textMatrix = .identity
    ctx.translateBy(x: 0, y: height)
    ctx.scaleBy(x: 1, y: -1)
    for (i, line) in l.lines.enumerated() {
      let baselineFromTop = origin.y + CGFloat(i) * l.lineHeight + l.baseline
      let y = height - baselineFromTop
      let x = origin.x + l.lineOffset(i)
      ctx.textPosition = CGPoint(x: x, y: y)
      CTLineDraw(line, ctx)
      drawStrikes(line, ctx: ctx, x: x, baselineY: y)
    }
    ctx.restoreGState()
    if l.hasExtras { drawExtras(l, in: ctx, origin: origin, pass: 1, spoiler: spoiler, onMissingEmoji: onMissingEmoji) }
  }

  /// [fase 2] pass 0 = fundo do code inline (atrás do texto); pass 1 = emoji
  /// customizado + véu do spoiler (por cima). Coordenadas UIKit.
  private static func drawExtras(_ l: CMLTextLayout, in ctx: CGContext, origin: CGPoint, pass: Int,
                                 spoiler: CMLSpoilerStyle?, onMissingEmoji: ((String, CGFloat) -> Void)?) {
    let screenScale = UIScreen.main.scale
    for (i, line) in l.lines.enumerated() {
      guard let runs = CTLineGetGlyphRuns(line) as? [CTRun] else { continue }
      let lineTop = origin.y + CGFloat(i) * l.lineHeight
      let baselineY = lineTop + l.baseline
      for run in runs {
        let attrs = CTRunGetAttributes(run) as NSDictionary
        let range = CTRunGetStringRange(run)
        var asc: CGFloat = 0, desc: CGFloat = 0, lead: CGFloat = 0
        let w = CGFloat(CTRunGetTypographicBounds(run, CFRange(location: 0, length: 0), &asc, &desc, &lead))
        let x0 = origin.x + l.lineOffset(i) + CTLineGetOffsetForStringIndex(line, range.location, nil)
        if pass == 0 {
          if let bg = attrs[CMLCodeBgKey.rawValue] as? UIColor {
            let r = CGRect(x: x0 - 2, y: baselineY - asc - 1, width: w + 4, height: asc + desc + 2)
            ctx.saveGState()
            ctx.setFillColor(bg.cgColor)
            ctx.addPath(UIBezierPath(roundedRect: r, cornerRadius: 4).cgPath)
            ctx.fillPath()
            ctx.restoreGState()
          }
          continue
        }
        if let u = attrs[CMLEmojiKey.rawValue] as? String {
          let side = CGFloat((attrs[CMLEmojiSizeKey.rawValue] as? NSNumber)?.doubleValue ?? Double(l.lineHeight))
          let r = CGRect(x: x0, y: baselineY - asc, width: side, height: side)
          let px = side * screenScale
          if let img = CMLImageLoader.shared.cached(u, maxPixel: px) {
            UIGraphicsPushContext(ctx)
            img.draw(in: r)
            UIGraphicsPopContext()
          } else {
            onMissingEmoji?(u, px)
          }
        }
        if attrs[CMLSpoilerKey.rawValue] != nil, let sp = spoiler, !sp.revealed {
          let r = CGRect(x: x0 - 1, y: lineTop + 1, width: w + 2, height: max(4, l.lineHeight - 2))
          ctx.saveGState()
          ctx.setFillColor(sp.bg.cgColor)
          ctx.addPath(UIBezierPath(roundedRect: r, cornerRadius: 4).cgPath)
          ctx.fillPath()
          var dot = UIColor.gray.cgColor
          if let c = attrs[CMLCTColorKey.rawValue] { dot = c as! CGColor }
          drawParticles(ctx, rect: r, color: dot, seed: UInt32(truncatingIfNeeded: range.location &* 2654435761))
          ctx.restoreGState()
        }
      }
    }
  }

  /// Partículas determinísticas (mesmo padrão a cada desenho).
  static func drawParticles(_ ctx: CGContext, rect r: CGRect, color: CGColor, seed: UInt32) {
    var st: UInt32 = seed | 1
    func rnd() -> CGFloat {
      st = st &* 1664525 &+ 1013904223
      return CGFloat(st >> 8) / CGFloat(1 << 24)
    }
    let step: CGFloat = 2.6
    var y = r.minY + 1
    while y < r.maxY - 0.5 {
      var x = r.minX + 1
      while x < r.maxX - 0.5 {
        let a = 0.25 + rnd() * 0.6
        let jx = (rnd() - 0.5) * step
        let jy = (rnd() - 0.5) * step
        let d = 0.7 + rnd() * 0.6
        ctx.setFillColor(color.copy(alpha: a * color.alpha) ?? color)
        ctx.fillEllipse(in: CGRect(x: x + jx, y: y + jy, width: d, height: d))
        x += step
      }
      y += step
    }
  }

  private static func drawStrikes(_ line: CTLine, ctx: CGContext, x: CGFloat, baselineY: CGFloat) {
    guard let runs = CTLineGetGlyphRuns(line) as? [CTRun] else { return }
    for run in runs {
      let attrs = CTRunGetAttributes(run) as NSDictionary
      guard attrs[CMLStrikeKey.rawValue] != nil else { continue }
      let range = CTRunGetStringRange(run)
      var asc: CGFloat = 0, desc: CGFloat = 0, lead: CGFloat = 0
      let w = CGFloat(CTRunGetTypographicBounds(run, CFRange(location: 0, length: 0), &asc, &desc, &lead))
      let off = CTLineGetOffsetForStringIndex(line, range.location, nil)
      var color = UIColor.gray.cgColor
      if let c = attrs[CMLCTColorKey.rawValue] {
        color = c as! CGColor
      }
      ctx.setFillColor(color)
      let midY = baselineY + asc * 0.32
      ctx.fill(CGRect(x: x + off, y: midY, width: w, height: 1.2))
    }
  }
}

/// Hora + editado + estrela + ✓✓.
final class CMLMetaView: UIView {
  var meta = CMLMeta() { didSet { setNeedsDisplay() } }
  var readColor: UIColor = .systemBlue { didSet { setNeedsDisplay() } }
  var failedColor: UIColor = .systemRed
  var pill = false { didSet { setNeedsDisplay() } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
    isUserInteractionEnabled = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  // MARK: [motion-conv] ⏱ → ✓ → ✓✓ → lida (coreografia do AnimatedCheckStatus JS):
  // ⏱→✓ relógio some e o ✓ dá um pop (.5 → 1, mola); ✓→✓✓ 2º ✓ desliza da
  // esquerda; →lida cinza→azul em fade + pulso 1 → 1.15 → 1. ~120 Hz.
  private var animFrom: Double?
  private var animT: CGFloat = 1
  private var animStart: CFTimeInterval = 0
  private var link: CADisplayLink?
  private static let statusAnimDur: CFTimeInterval = 0.42

  /// Chamado DEPOIS de `meta` ter o status novo. Só anima avanço (nunca volta).
  func animateStatus(from old: Double) {
    guard let ns = meta.status, ns > old, old >= 0, ns >= 1 else { cancelStatusAnim(); return }
    animFrom = old
    animT = 0
    animStart = CACurrentMediaTime()
    if link == nil {
      let l = CADisplayLink(target: CMLWeakLink(self) { obj in
        if let v = obj as? CMLMetaView { v.stepStatusAnim() }
      }, selector: #selector(CMLWeakLink.tick(_:)))
      if #available(iOS 15.0, *) {
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
      }
      l.add(to: .main, forMode: .common)
      link = l
    }
    setNeedsDisplay()
  }

  func cancelStatusAnim() {
    link?.invalidate()
    link = nil
    if animFrom != nil {
      animFrom = nil
      animT = 1
      setNeedsDisplay()
    }
  }

  private func stepStatusAnim() {
    let t = CGFloat((CACurrentMediaTime() - animStart) / CMLMetaView.statusAnimDur)
    if t >= 1 || window == nil { cancelStatusAnim(); return }
    animT = max(0, t)
    setNeedsDisplay()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { cancelStatusAnim() }
  }

  private static func backOut(_ t: CGFloat) -> CGFloat {
    let c1: CGFloat = 1.70158
    let c3 = c1 + 1
    let u = t - 1
    return 1 + c3 * u * u * u + c1 * u * u
  }

  private static func cubicOut(_ t: CGFloat) -> CGFloat {
    let u = 1 - t
    return 1 - u * u * u
  }

  private static func mix(_ a: UIColor, _ b: UIColor, _ t: CGFloat) -> UIColor {
    var ar: CGFloat = 0, ag: CGFloat = 0, ab: CGFloat = 0, aa: CGFloat = 0
    var br: CGFloat = 0, bg: CGFloat = 0, bb: CGFloat = 0, ba: CGFloat = 0
    guard a.getRed(&ar, green: &ag, blue: &ab, alpha: &aa), b.getRed(&br, green: &bg, blue: &bb, alpha: &ba) else { return t < 0.5 ? a : b }
    return UIColor(red: ar + (br - ar) * t, green: ag + (bg - ag) * t, blue: ab + (bb - ab) * t, alpha: aa + (ba - aa) * t)
  }

  override func draw(_ rect: CGRect) {
    guard let ctx = UIGraphicsGetCurrentContext() else { return }
    var x: CGFloat = 0
    let h = bounds.height
    if pill {
      let p = UIBezierPath(roundedRect: bounds, cornerRadius: h / 2)
      ctx.setFillColor(UIColor(white: 0, alpha: 0.42).cgColor)
      ctx.addPath(p.cgPath)
      ctx.fillPath()
      x = 6
    }
    let cy0 = h / 2
    if meta.pin {
      CMLIcons.svg(ctx, CMLIcons.pinPaths, rect: CGRect(x: x, y: cy0 - 5.5, width: 11, height: 11), color: meta.color, lineWidth: 2.2)
      x += 13
    }
    if meta.timer {
      CMLIcons.svg(ctx, CMLIcons.timerPaths, rect: CGRect(x: x, y: cy0 - 5.5, width: 11, height: 11), color: meta.color, lineWidth: 2.2)
      x += 13
    }
    if let t = meta.text {
      let ty = floor((h - t.size.height) / 2)
      CMLTextView.drawText(t, in: ctx, origin: CGPoint(x: x, y: ty), height: h)
      x += t.size.width
    }
    let cy = h / 2
    if meta.star {
      x += 3
      CMLIcons.star(ctx, center: CGPoint(x: x + 5, y: cy), r: 4.6, color: meta.color)
      x += 10
    }
    if let s = meta.status {
      x += 3
      var tickColor = s >= 2 ? readColor : meta.color
      // [motion-conv] transição em curso (só ✓ em diante; falhou/pendente = estático)
      let from: Double? = (animFrom != nil && animT < 1 && s >= 1) ? animFrom : nil
      let t = animT
      if s < 0 {
        CMLIcons.alert(ctx, center: CGPoint(x: x + 6, y: cy), color: failedColor)
      } else if s == 0 {
        CMLIcons.clock(ctx, center: CGPoint(x: x + 6, y: cy), color: meta.color)
      } else if let f = from {
        let toRead = s >= 2 && f < 2
        if toRead { tickColor = CMLMetaView.mix(meta.color, readColor, CMLMetaView.cubicOut(min(1, t * 1.6))) }
        ctx.saveGState()
        if toRead {
          // pulso do grupo ao ficar lida
          let p = 1 + 0.15 * sin(CGFloat.pi * min(1, t * 1.3))
          let gx = x + (s >= 1.5 ? 8.5 : 6.5)
          ctx.translateBy(x: gx, y: cy)
          ctx.scaleBy(x: p, y: p)
          ctx.translateBy(x: -gx, y: -cy)
        }
        if f == 0 {
          // ⏱ some rápido; os ✓ "estalam" (.5 → 1 com overshoot)
          let ca = max(0, 1 - t * 3)
          if ca > 0 {
            ctx.saveGState()
            ctx.setAlpha(ca)
            CMLIcons.clock(ctx, center: CGPoint(x: x + 6, y: cy), color: meta.color)
            ctx.restoreGState()
          }
          let ps = 0.5 + 0.5 * CMLMetaView.backOut(t)
          let gx = x + (s >= 1.5 ? 8.5 : 6.5)
          ctx.translateBy(x: gx, y: cy)
          ctx.scaleBy(x: ps, y: ps)
          ctx.translateBy(x: -gx, y: -cy)
          ctx.setAlpha(min(1, t * 4))
        }
        if s >= 1.5 {
          var x1 = x
          var dx2: CGFloat = 0
          var a2: CGFloat = 1
          if f >= 1 && f < 1.5 {
            // 2º ✓ desliza da esquerda (sai de trás do 1º)
            let e = CMLMetaView.cubicOut(t)
            x1 = x + (1 - e)
            dx2 = -4.5 * (1 - e)
            a2 = e
          }
          CMLIcons.check(ctx, origin: CGPoint(x: x1, y: cy - 5), color: tickColor)
          ctx.saveGState()
          ctx.setAlpha(a2)
          CMLIcons.check(ctx, origin: CGPoint(x: x + 4.5 + dx2, y: cy - 5), color: tickColor)
          ctx.restoreGState()
        } else {
          CMLIcons.check(ctx, origin: CGPoint(x: x + 1, y: cy - 5), color: tickColor)
        }
        ctx.restoreGState()
      } else if s >= 1.5 {
        CMLIcons.check(ctx, origin: CGPoint(x: x, y: cy - 5), color: tickColor)
        CMLIcons.check(ctx, origin: CGPoint(x: x + 4.5, y: cy - 5), color: tickColor)
      } else {
        CMLIcons.check(ctx, origin: CGPoint(x: x + 1, y: cy - 5), color: tickColor)
      }
    }
  }
}

enum CMLIcons {
  // lucide pin / timer (viewBox 24)
  static let pinPaths = [
    "M12 17v5",
    "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
  ]
  static let timerPaths = [
    "M10 2h4",
    "M12 14l3-3",
    "M4 14a8 8 0 1 0 16 0a8 8 0 1 0 -16 0",
  ]

  /// Paths SVG (viewBox `vb`) desenhados em `rect` (contorno, cantos redondos).
  static func svg(_ ctx: CGContext, _ paths: [String], rect: CGRect, color: UIColor, lineWidth: CGFloat, vb: CGFloat = 24) {
    ctx.saveGState()
    ctx.translateBy(x: rect.minX, y: rect.minY)
    let sc = min(rect.width, rect.height) / vb
    ctx.scaleBy(x: sc, y: sc)
    ctx.setStrokeColor(color.cgColor)
    ctx.setLineWidth(lineWidth)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    for d in paths {
      ctx.addPath(CMLSVGPath.path(d))
      ctx.strokePath()
    }
    ctx.restoreGState()
  }

  /// Ícone de nó (`ic`): fill/stroke por path, escala do viewBox.
  static func node(_ ctx: CGContext, _ n: CMLNode, rect: CGRect) {
    guard !n.paths.isEmpty else { return }
    ctx.saveGState()
    ctx.translateBy(x: rect.minX, y: rect.minY)
    let sc = min(rect.width, rect.height) / max(1, n.vb)
    ctx.scaleBy(x: sc, y: sc)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.setMiterLimit(10)
    for p in n.paths {
      ctx.saveGState()
      if p.alpha < 1 { ctx.setAlpha(p.alpha) }
      if let f = p.fill {
        ctx.addPath(p.path)
        ctx.setFillColor(f.cgColor)
        ctx.fillPath()
      }
      if let k = p.stroke, p.width > 0 {
        ctx.addPath(p.path)
        ctx.setStrokeColor(k.cgColor)
        ctx.setLineWidth(p.width)
        ctx.strokePath()
      }
      ctx.restoreGState()
    }
    ctx.restoreGState()
  }

  static func check(_ ctx: CGContext, origin o: CGPoint, color: UIColor) {
    ctx.saveGState()
    ctx.setStrokeColor(color.cgColor)
    ctx.setLineWidth(1.5)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.move(to: CGPoint(x: o.x + 0.5, y: o.y + 5.5))
    ctx.addLine(to: CGPoint(x: o.x + 3.8, y: o.y + 8.6))
    ctx.addLine(to: CGPoint(x: o.x + 10.5, y: o.y + 1.4))
    ctx.strokePath()
    ctx.restoreGState()
  }

  static func clock(_ ctx: CGContext, center c: CGPoint, color: UIColor) {
    ctx.saveGState()
    ctx.setStrokeColor(color.cgColor)
    ctx.setLineWidth(1.2)
    ctx.setLineCap(.round)
    ctx.addEllipse(in: CGRect(x: c.x - 5, y: c.y - 5, width: 10, height: 10))
    ctx.strokePath()
    ctx.move(to: c)
    ctx.addLine(to: CGPoint(x: c.x, y: c.y - 3.2))
    ctx.move(to: c)
    ctx.addLine(to: CGPoint(x: c.x + 2.4, y: c.y + 1))
    ctx.strokePath()
    ctx.restoreGState()
  }

  static func alert(_ ctx: CGContext, center c: CGPoint, color: UIColor) {
    ctx.saveGState()
    ctx.setFillColor(color.cgColor)
    ctx.fillEllipse(in: CGRect(x: c.x - 6, y: c.y - 6, width: 12, height: 12))
    ctx.setFillColor(UIColor.white.cgColor)
    ctx.fill(CGRect(x: c.x - 0.8, y: c.y - 3.6, width: 1.6, height: 4.4))
    ctx.fillEllipse(in: CGRect(x: c.x - 0.9, y: c.y + 1.8, width: 1.8, height: 1.8))
    ctx.restoreGState()
  }

  static func star(_ ctx: CGContext, center c: CGPoint, r: CGFloat, color: UIColor) {
    ctx.saveGState()
    ctx.setFillColor(color.cgColor)
    let p = CGMutablePath()
    for i in 0..<10 {
      let rr = i % 2 == 0 ? r : r * 0.45
      let a = -CGFloat.pi / 2 + CGFloat(i) * CGFloat.pi / 5
      let pt = CGPoint(x: c.x + cos(a) * rr, y: c.y + sin(a) * rr)
      if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
    }
    p.closeSubpath()
    ctx.addPath(p)
    ctx.fillPath()
    ctx.restoreGState()
  }

  static func play(_ ctx: CGContext, rect r: CGRect, color: UIColor) {
    ctx.saveGState()
    ctx.setFillColor(color.cgColor)
    let p = CGMutablePath()
    p.move(to: CGPoint(x: r.minX + r.width * 0.30, y: r.minY + r.height * 0.22))
    p.addLine(to: CGPoint(x: r.minX + r.width * 0.80, y: r.midY))
    p.addLine(to: CGPoint(x: r.minX + r.width * 0.30, y: r.minY + r.height * 0.78))
    p.closeSubpath()
    ctx.addPath(p)
    ctx.fillPath()
    ctx.restoreGState()
  }

  static func pause(_ ctx: CGContext, rect r: CGRect, color: UIColor) {
    ctx.saveGState()
    ctx.setFillColor(color.cgColor)
    let w = r.width * 0.16
    let h = r.height * 0.5
    let y = r.midY - h / 2
    ctx.fill(CGRect(x: r.midX - w - 2, y: y, width: w, height: h))
    ctx.fill(CGRect(x: r.midX + 2, y: y, width: w, height: h))
    ctx.restoreGState()
  }

  /// Seta de responder (curva p/ esquerda).
  static func reply(_ ctx: CGContext, rect r: CGRect, color: UIColor) {
    ctx.saveGState()
    ctx.setStrokeColor(color.cgColor)
    ctx.setLineWidth(2)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    let s = min(r.width, r.height)
    let ox = r.midX - s / 2, oy = r.midY - s / 2
    ctx.move(to: CGPoint(x: ox + s * 0.42, y: oy + s * 0.22))
    ctx.addLine(to: CGPoint(x: ox + s * 0.14, y: oy + s * 0.48))
    ctx.addLine(to: CGPoint(x: ox + s * 0.42, y: oy + s * 0.74))
    ctx.move(to: CGPoint(x: ox + s * 0.16, y: oy + s * 0.48))
    ctx.addQuadCurve(to: CGPoint(x: ox + s * 0.86, y: oy + s * 0.82), control: CGPoint(x: ox + s * 0.80, y: oy + s * 0.44))
    ctx.strokePath()
    ctx.restoreGState()
  }

  /// Círculo cortado (mensagem apagada).
  static func deleted(_ ctx: CGContext, rect r: CGRect, color: UIColor) {
    ctx.saveGState()
    ctx.setStrokeColor(color.cgColor)
    ctx.setLineWidth(1.4)
    let s = min(r.width, r.height) - 2
    let c = CGRect(x: r.midX - s / 2, y: r.midY - s / 2, width: s, height: s)
    ctx.addEllipse(in: c)
    ctx.move(to: CGPoint(x: c.minX + s * 0.18, y: c.maxY - s * 0.18))
    ctx.addLine(to: CGPoint(x: c.maxX - s * 0.18, y: c.minY + s * 0.18))
    ctx.strokePath()
    ctx.restoreGState()
  }

  static func checkCircle(_ ctx: CGContext, rect r: CGRect, on: Bool, color: UIColor, ring: UIColor) {
    ctx.saveGState()
    if on {
      ctx.setFillColor(color.cgColor)
      ctx.fillEllipse(in: r)
      ctx.setStrokeColor(UIColor.white.cgColor)
      ctx.setLineWidth(2)
      ctx.setLineCap(.round)
      ctx.setLineJoin(.round)
      ctx.move(to: CGPoint(x: r.minX + r.width * 0.28, y: r.midY))
      ctx.addLine(to: CGPoint(x: r.minX + r.width * 0.44, y: r.minY + r.height * 0.66))
      ctx.addLine(to: CGPoint(x: r.minX + r.width * 0.74, y: r.minY + r.height * 0.34))
      ctx.strokePath()
    } else {
      ctx.setStrokeColor(ring.cgColor)
      ctx.setLineWidth(1.6)
      ctx.strokeEllipse(in: r.insetBy(dx: 0.8, dy: 0.8))
    }
    ctx.restoreGState()
  }
}

/// Ícone genérico desenhado (seta de responder, círculo de seleção, play).
final class CMLIconView: UIView {
  enum Kind { case reply, select, selectOn, play, deleted, failed }
  var kind: Kind = .reply { didSet { setNeedsDisplay() } }
  var color: UIColor = .gray { didSet { setNeedsDisplay() } }
  var ring: UIColor = .gray
  var disc: UIColor? = nil { didSet { setNeedsDisplay() } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
    isUserInteractionEnabled = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func draw(_ rect: CGRect) {
    guard let ctx = UIGraphicsGetCurrentContext() else { return }
    if let d = disc {
      ctx.setFillColor(d.cgColor)
      ctx.fillEllipse(in: bounds)
    }
    switch kind {
    case .reply: CMLIcons.reply(ctx, rect: bounds.insetBy(dx: bounds.width * 0.22, dy: bounds.height * 0.22), color: color)
    case .select: CMLIcons.checkCircle(ctx, rect: bounds, on: false, color: color, ring: ring)
    case .selectOn: CMLIcons.checkCircle(ctx, rect: bounds, on: true, color: color, ring: ring)
    case .play: CMLIcons.play(ctx, rect: bounds.insetBy(dx: bounds.width * 0.18, dy: bounds.height * 0.18), color: color)
    case .deleted: CMLIcons.deleted(ctx, rect: bounds, color: color)
    case .failed:
      // círculo cheio (cor de falha) com "!" branco — toque = reenviar
      ctx.setFillColor(color.cgColor)
      ctx.fillEllipse(in: bounds.insetBy(dx: 1, dy: 1))
      let c = CGPoint(x: bounds.midX, y: bounds.midY)
      let u = bounds.width / 22
      ctx.setFillColor(UIColor.white.cgColor)
      ctx.addPath(UIBezierPath(roundedRect: CGRect(x: c.x - 1.1 * u, y: c.y - 6 * u, width: 2.2 * u, height: 7.4 * u), cornerRadius: 1.1 * u).cgPath)
      ctx.fillPath()
      ctx.fillEllipse(in: CGRect(x: c.x - 1.3 * u, y: c.y + 3 * u, width: 2.6 * u, height: 2.6 * u))
    }
  }
}

/// Anel de progresso de envio (ou indeterminado girando).
final class CMLProgressView: UIView {
  private let track = CAShapeLayer()
  private let bar = CAShapeLayer()
  private var spinning = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    backgroundColor = UIColor(white: 0, alpha: 0.45)
    track.fillColor = UIColor.clear.cgColor
    track.strokeColor = UIColor(white: 1, alpha: 0.3).cgColor
    track.lineWidth = 2.5
    bar.fillColor = UIColor.clear.cgColor
    bar.strokeColor = UIColor.white.cgColor
    bar.lineWidth = 2.5
    bar.lineCap = .round
    layer.addSublayer(track)
    layer.addSublayer(bar)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    layer.cornerRadius = bounds.width / 2
    let inset: CGFloat = 7
    let r = bounds.insetBy(dx: inset, dy: inset)
    let p = UIBezierPath(arcCenter: CGPoint(x: r.midX, y: r.midY), radius: r.width / 2, startAngle: -.pi / 2, endAngle: .pi * 1.5, clockwise: true).cgPath
    track.frame = bounds
    bar.frame = bounds
    track.path = p
    bar.path = p
  }

  func set(progress: Int) {
    if progress < 0 {
      bar.strokeEnd = 0.25
      if !spinning {
        spinning = true
        let a = CABasicAnimation(keyPath: "transform.rotation.z")
        a.fromValue = 0
        a.toValue = CGFloat.pi * 2
        a.duration = 0.9
        a.repeatCount = .infinity
        bar.add(a, forKey: "spin")
      }
    } else {
      if spinning { spinning = false; bar.removeAnimation(forKey: "spin") }
      bar.strokeEnd = CGFloat(max(2, min(100, progress))) / 100
    }
  }

  func stop() {
    if spinning { spinning = false; bar.removeAnimation(forKey: "spin") }
  }
}

/// Citação (resposta) dentro do balão.
final class CMLReplyView: UIView {
  let nameView = CMLTextView()
  let textView = CMLTextView()
  let thumb = UIImageView()
  private let bar = UIView()
  var thumbToken = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    layer.cornerRadius = 8
    clipsToBounds = true
    addSubview(bar)
    addSubview(nameView)
    addSubview(textView)
    thumb.contentMode = .scaleAspectFill
    thumb.clipsToBounds = true
    thumb.layer.cornerRadius = 4
    addSubview(thumb)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func apply(name: CMLTextLayout?, text: CMLTextLayout?, barColor: UIColor, bg: UIColor, hasThumb: Bool) {
    backgroundColor = bg
    bar.backgroundColor = barColor
    nameView.layout = name
    textView.layout = text
    thumb.isHidden = !hasThumb
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let h = bounds.height
    bar.frame = CGRect(x: 0, y: 0, width: 3, height: h)
    let tx: CGFloat = 11
    let right: CGFloat = thumb.isHidden ? 8 : 48
    let nw = min(nameView.layout?.size.width ?? 0, bounds.width - tx - right) + 1
    let tw = min(textView.layout?.size.width ?? 0, bounds.width - tx - right) + 1
    nameView.frame = CGRect(x: tx, y: 6, width: max(0, nw), height: nameView.layout?.size.height ?? 0)
    textView.frame = CGRect(x: tx, y: 6 + (nameView.layout?.size.height ?? 17) + 1, width: max(0, tw), height: textView.layout?.size.height ?? 0)
    thumb.frame = CGRect(x: bounds.width - 44, y: 4, width: 40, height: h - 8)
  }
}

/// Áudio: botão play/pause + ondas + duração. Estado vindo do player global JS.
final class CMLAudioView: UIView {
  var wave: [CGFloat] = [] { didSet { setNeedsDisplay() } }
  var progress: CGFloat = 0 { didSet { if abs(progress - oldValue) > 0.002 { setNeedsDisplay() } } }
  var playing = false { didSet { if playing != oldValue { setNeedsDisplay() } } }
  var loading = false {
    didSet {
      if loading { spinner.startAnimating() } else { spinner.stopAnimating() }
      setNeedsDisplay()
    }
  }
  var durText: CMLTextLayout? { didSet { setNeedsDisplay() } }
  var tint: UIColor = .white { didSet { setNeedsDisplay() } }
  var dim: UIColor = .gray
  var unplayedDot: UIColor? = nil
  /// [native-media-dl] o anel de download ocupa o botão (play some)
  var glyphHidden = false { didSet { if glyphHidden != oldValue { setNeedsDisplay() } } }
  private let spinner = UIActivityIndicatorView(style: .medium)

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
    isUserInteractionEnabled = false
    spinner.hidesWhenStopped = true
    addSubview(spinner)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static let buttonSize: CGFloat = 38

  // MARK: [motion-conv] progresso suave: entre os pulsos de posição do player
  // (JS) extrapola até 0,5 s a 60–120 Hz e não volta p/ trás por jitter (< 4%);
  // barra da cabeça preenchida em parte. `smooth` = CMLMotion.audio.
  var smooth = false
  private var pbPos: Double = 0
  private var pbDur: Double = 0
  private var pbAt: CFTimeInterval = 0
  private var pbLink: CADisplayLink?

  func setPlayback(posMs: Double, durMs: Double, playing: Bool) {
    let p = durMs > 0 ? CGFloat(min(1, max(0, posMs / durMs))) : 0
    pbPos = posMs
    pbDur = durMs
    pbAt = CACurrentMediaTime()
    if smooth && playing && durMs > 0 && window != nil {
      if !(p < progress && progress - p < 0.04) { progress = p }
      if pbLink == nil {
        let l = CADisplayLink(target: CMLWeakLink(self) { obj in
          if let v = obj as? CMLAudioView { v.stepPlayback() }
        }, selector: #selector(CMLWeakLink.tick(_:)))
        if #available(iOS 15.0, *) {
          l.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 60)
        }
        l.add(to: .main, forMode: .common)
        pbLink = l
      }
    } else {
      stopPlaybackLink()
      progress = p
    }
  }

  func resetPlayback() {
    stopPlaybackLink()
    progress = 0
  }

  private func stopPlaybackLink() {
    pbLink?.invalidate()
    pbLink = nil
  }

  private func stepPlayback() {
    let dt = CACurrentMediaTime() - pbAt
    if window == nil || !playing || pbDur <= 0 { stopPlaybackLink(); return }
    let est = CGFloat(min(1, (pbPos + min(0.5, dt) * 1000) / pbDur))
    // didSet só redesenha com salto > 0,002 → aqui redesenha sempre que avança
    if est > progress { progress = est; setNeedsDisplay() }
    if dt >= 0.5 { stopPlaybackLink() } // pulso atrasado (buffer/pausa): espera o próximo
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { stopPlaybackLink() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    spinner.center = CGPoint(x: CMLAudioView.buttonSize / 2, y: CMLAudioView.buttonSize / 2 + 1)
    spinner.color = tint
  }

  override func draw(_ rect: CGRect) {
    guard let ctx = UIGraphicsGetCurrentContext() else { return }
    let b = CMLAudioView.buttonSize
    let btn = CGRect(x: 0, y: 1, width: b, height: b)
    if !glyphHidden {
      ctx.setFillColor(tint.withAlphaComponent(0.14).cgColor)
      ctx.fillEllipse(in: btn)
    }
    if !loading && !glyphHidden {
      if playing { CMLIcons.pause(ctx, rect: btn, color: tint) } else { CMLIcons.play(ctx, rect: btn.insetBy(dx: 4, dy: 4), color: tint) }
    }
    // ondas
    let x0 = b + 10
    let avail = bounds.width - x0 - 4
    let bars = wave.isEmpty ? CMLAudioView.fallbackWave : wave
    let n = bars.count
    if n > 0 && avail > 20 {
      let step = avail / CGFloat(n)
      let bw = max(1.5, step * 0.58)
      let midY: CGFloat = 15
      let playedUpTo = CGFloat(n) * progress
      for i in 0..<n {
        let v = max(0.08, min(1, bars[i]))
        let h = max(3, v * 22)
        let x = x0 + CGFloat(i) * step
        let r = CGRect(x: x, y: midY - h / 2, width: bw, height: h)
        let frac = playedUpTo - CGFloat(i)
        let p = UIBezierPath(roundedRect: r, cornerRadius: bw / 2)
        if smooth && frac > 0 && frac < 1 {
          // [motion-conv] barra da "cabeça" preenchida em parte (avanço contínuo)
          ctx.setFillColor(dim.cgColor)
          ctx.addPath(p.cgPath)
          ctx.fillPath()
          ctx.saveGState()
          ctx.clip(to: CGRect(x: x, y: r.minY, width: bw * frac, height: h))
          ctx.setFillColor(tint.cgColor)
          ctx.addPath(p.cgPath)
          ctx.fillPath()
          ctx.restoreGState()
        } else {
          ctx.setFillColor((CGFloat(i) < playedUpTo ? tint : dim).cgColor)
          ctx.addPath(p.cgPath)
          ctx.fillPath()
        }
      }
    }
    if let t = durText {
      CMLTextView.drawText(t, in: ctx, origin: CGPoint(x: x0, y: bounds.height - t.size.height - 1), height: bounds.height)
    }
    if let dot = unplayedDot {
      ctx.setFillColor(dot.cgColor)
      ctx.fillEllipse(in: CGRect(x: b - 9, y: b - 8, width: 8, height: 8))
    }
  }

  static let fallbackWave: [CGFloat] = (0..<40).map { (i: Int) -> CGFloat in
    let v = abs(sin(Double(i) * 0.9) * 0.6 + sin(Double(i) * 0.37) * 0.4)
    return CGFloat(0.15 + v * 0.75)
  }
}

/// Arquivo: ícone com extensão + nome + tamanho.
final class CMLFileView: UIView {
  var nameL: CMLTextLayout? { didSet { setNeedsDisplay() } }
  var sizeL: CMLTextLayout? { didSet { setNeedsDisplay() } }
  var extL: CMLTextLayout? { didSet { setNeedsDisplay() } }
  var iconColor: UIColor = .gray { didSet { setNeedsDisplay() } }
  /// [native-media-dl] anel de download por cima do ícone → some a extensão
  var extHidden = false { didSet { if extHidden != oldValue { setNeedsDisplay() } } }
  /// [native-media-dl] "1,2 MB de 4,5 MB" no lugar do tamanho enquanto baixa
  var sizeOverride: NSAttributedString? { didSet { if sizeOverride != oldValue { setNeedsDisplay() } } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
    isUserInteractionEnabled = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func draw(_ rect: CGRect) {
    guard let ctx = UIGraphicsGetCurrentContext() else { return }
    let icon = CGRect(x: 0, y: max(0, (bounds.height - 44) / 2), width: 38, height: 44)
    ctx.setFillColor(iconColor.cgColor)
    ctx.addPath(UIBezierPath(roundedRect: icon, cornerRadius: 7).cgPath)
    ctx.fillPath()
    if let e = extL, !extHidden {
      CMLTextView.drawText(e, in: ctx, origin: CGPoint(x: icon.midX - e.size.width / 2, y: icon.midY - e.size.height / 2), height: bounds.height)
    }
    var y: CGFloat = max(0, (bounds.height - (nameL?.size.height ?? 0) - (sizeL?.size.height ?? 0) - 2) / 2)
    if let n = nameL {
      CMLTextView.drawText(n, in: ctx, origin: CGPoint(x: 48, y: y), height: bounds.height)
      y += n.size.height + 2
    }
    if let o = sizeOverride {
      UIGraphicsPushContext(ctx)
      o.draw(at: CGPoint(x: 48, y: y))
      UIGraphicsPopContext()
    } else if let s = sizeL {
      CMLTextView.drawText(s, in: ctx, origin: CGPoint(x: 48, y: y), height: bounds.height)
    }
  }
}

/// Fileira de reações (chips).
final class CMLReactsView: UIView {
  var chips: [(CGRect, CTLine)] = [] { didSet { setNeedsDisplay() } }
  var bg: UIColor = .white { didSet { setNeedsDisplay() } }
  var border: UIColor = .white
  var mineBg: UIColor = .lightGray
  var mine: [Bool] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
    isUserInteractionEnabled = false
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.08
    layer.shadowRadius = 2
    layer.shadowOffset = CGSize(width: 0, height: 1)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func draw(_ rect: CGRect) {
    guard let ctx = UIGraphicsGetCurrentContext() else { return }
    for (i, chip) in chips.enumerated() {
      let r = chip.0.insetBy(dx: 0.75, dy: 0.75)
      let p = UIBezierPath(roundedRect: r, cornerRadius: r.height / 2)
      ctx.setFillColor((i < mine.count && mine[i] ? mineBg : bg).cgColor)
      ctx.addPath(p.cgPath)
      ctx.fillPath()
      ctx.setStrokeColor(border.cgColor)
      ctx.setLineWidth(1.5)
      ctx.addPath(p.cgPath)
      ctx.strokePath()
      // linha centralizada
      ctx.saveGState()
      ctx.textMatrix = .identity
      ctx.translateBy(x: 0, y: bounds.height)
      ctx.scaleBy(x: 1, y: -1)
      var a: CGFloat = 0, d: CGFloat = 0, l: CGFloat = 0
      let w = CGFloat(CTLineGetTypographicBounds(chip.1, &a, &d, &l))
      let baseline = chip.0.minY + (chip.0.height - (a + d)) / 2 + a
      ctx.textPosition = CGPoint(x: chip.0.midX - w / 2, y: bounds.height - baseline)
      CTLineDraw(chip.1, ctx)
      ctx.restoreGState()
    }
  }
}
