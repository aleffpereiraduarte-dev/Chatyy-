import UIKit

// [2026-10-14 native-home] Peças pequenas da linha: recibo ✓/✓✓ (CoreGraphics,
// mesmo traço do IconCheck), pontinhos de "digitando", pílula de contador e
// bolinha de seleção.

/// [2026-10-16 wave8-list] Reduzir movimento (Acessibilidade) — toda animação
/// "de enfeite" da lista (dígitos rolando, mola, ✓ se dividindo) respeita isto.
enum CLMotion {
  static var reduced: Bool { UIAccessibility.isReduceMotionEnabled }
}

/// [2026-10-16 motion-nav] Molas da lista (Telegram). Kill switch: prop
/// `springMotion=false` (JS globalThis.__chatyy_motion_list_spring = false).
enum CLSpring {
  static var enabled = true
  static let bumpDuration: CFTimeInterval = 0.56
  /// Impulso amortecido ζ 0,5 · ω 14 rad/s normalizado no pico, 1 + 0,18·g(t).
  static let bumpScales: [NSNumber] = {
    let zeta = 0.5, omega = 14.0
    let wd = omega * (1 - zeta * zeta).squareRoot()
    let tPeak = atan(wd / (zeta * omega)) / wd
    let gPeak = exp(-zeta * omega * tPeak) * sin(wd * tPeak)
    let n = 48
    var out: [NSNumber] = []
    out.reserveCapacity(n + 1)
    for i in 0...n {
      let t = Double(i) / Double(n) * 0.56
      let g = i == n ? 0 : exp(-zeta * omega * t) * sin(wd * t) / gPeak
      out.append(NSNumber(value: 1 + 0.18 * g))
    }
    return out
  }()
}

/// ✓ (enviado), ✓✓ cinza (entregue), ✓✓ azul (lido). Entregue→lido faz
/// crossfade + pulso, como o ListReceiptIcon do JS.
final class CLReceiptView: UIView {
  private(set) var state: Int = 0 // 1 enviado · 2 entregue · 3 lido
  private let grayLayer = CAShapeLayer()
  private let blueLayer = CAShapeLayer()
  var sentColor: UIColor = .gray
  var grayColor: UIColor = .gray
  var readColor: UIColor = UIColor(clHex: 0x53BDEB)

  static let singleWidth: CGFloat = 15
  static let doubleWidth: CGFloat = 22

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    for l in [grayLayer, blueLayer] {
      l.fillColor = UIColor.clear.cgColor
      l.lineCap = .round
      l.lineJoin = .round
      layer.addSublayer(l)
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  var intrinsicWidth: CGFloat {
    switch state {
    case 1: return CLReceiptView.singleWidth
    case 2, 3: return CLReceiptView.doubleWidth
    default: return 0
    }
  }

  /// Polyline "20 6 9 17 4 12" do IconCheck (viewBox 24) escalada para 15 pt.
  private static func check(dx: CGFloat) -> UIBezierPath {
    let s: CGFloat = 15.0 / 24.0
    let p = UIBezierPath()
    p.move(to: CGPoint(x: dx + 20 * s, y: 6 * s))
    p.addLine(to: CGPoint(x: dx + 9 * s, y: 17 * s))
    p.addLine(to: CGPoint(x: dx + 4 * s, y: 12 * s))
    return p
  }

  /// ✓/✓✓ como imagem (anexo de texto na prévia do toque longo).
  static func image(state: Int, gray: UIColor, read: UIColor, height: CGFloat = 12) -> UIImage? {
    if state <= 0 { return nil }
    let scale = height / 15.0
    let w = (state == 1 ? singleWidth : doubleWidth) * scale
    let r = UIGraphicsImageRenderer(size: CGSize(width: ceil(w), height: ceil(height)))
    return r.image { ctx in
      let c = ctx.cgContext
      c.scaleBy(x: scale, y: scale)
      let p = check(dx: 0)
      if state >= 2 { p.append(check(dx: 7)) }
      c.addPath(p.cgPath)
      c.setLineCap(.round)
      c.setLineJoin(.round)
      c.setLineWidth(state == 3 ? 2.6 : 2)
      c.setStrokeColor((state == 3 ? read : gray).cgColor)
      c.strokePath()
    }
  }

  func setState(_ newState: Int, animated: Bool) {
    let old = state
    state = newState
    isHidden = newState <= 0
    if newState <= 0 { return }
    let path: UIBezierPath
    if newState == 1 {
      path = CLReceiptView.check(dx: 0)
    } else {
      path = CLReceiptView.check(dx: 0)
      path.append(CLReceiptView.check(dx: 7))
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    grayLayer.path = path.cgPath
    blueLayer.path = path.cgPath
    grayLayer.lineWidth = 2
    blueLayer.lineWidth = 2.6
    grayLayer.strokeColor = (newState == 1 ? sentColor : grayColor).cgColor
    blueLayer.strokeColor = readColor.cgColor
    CATransaction.commit()
    let toRead = newState == 3
    let motion = animated && !CLMotion.reduced
    // [2026-10-16 wave8-list] ✓ → ✓✓: o 2º traço nasce em cima do 1º e
    // desliza 7 pt para a direita (Telegram); ✓ novo é "desenhado".
    if motion && old == 1 && newState >= 2 {
      let from = CLReceiptView.check(dx: 0)
      from.append(CLReceiptView.check(dx: 0))
      for l in [grayLayer, blueLayer] {
        let a = CABasicAnimation(keyPath: "path")
        a.fromValue = from.cgPath
        a.toValue = path.cgPath
        a.duration = 0.26
        a.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1.0)
        l.add(a, forKey: "split")
      }
      let pulse = CAKeyframeAnimation(keyPath: "transform.scale")
      pulse.values = [1, 1.12, 1]
      pulse.keyTimes = [0, 0.5, 1]
      pulse.duration = 0.26
      layer.add(pulse, forKey: "pulse")
      if toRead {
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = 0.3
        fade.beginTime = CACurrentMediaTime() + 0.12
        fade.fillMode = .backwards
        blueLayer.add(fade, forKey: "fade")
        let fadeOut = CABasicAnimation(keyPath: "opacity")
        fadeOut.fromValue = 1
        fadeOut.toValue = 0
        fadeOut.duration = 0.3
        fadeOut.beginTime = CACurrentMediaTime() + 0.12
        fadeOut.fillMode = .backwards
        grayLayer.add(fadeOut, forKey: "fade")
      }
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      blueLayer.opacity = toRead ? 1 : 0
      grayLayer.opacity = toRead ? 0 : 1
      CATransaction.commit()
      return
    }
    if motion && old == 0 && newState == 1 {
      let draw = CABasicAnimation(keyPath: "strokeEnd")
      draw.fromValue = 0
      draw.toValue = 1
      draw.duration = 0.22
      draw.timingFunction = CAMediaTimingFunction(name: .easeOut)
      grayLayer.add(draw, forKey: "draw")
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      blueLayer.opacity = 0
      grayLayer.opacity = 1
      CATransaction.commit()
      return
    }
    if motion && old == 2 && toRead {
      // entregue → lido: crossfade cinza→azul + um pulso suave.
      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = 0
      fade.toValue = 1
      fade.duration = 0.28
      blueLayer.opacity = 1
      blueLayer.add(fade, forKey: "fade")
      let fadeOut = CABasicAnimation(keyPath: "opacity")
      fadeOut.fromValue = 1
      fadeOut.toValue = 0
      fadeOut.duration = 0.28
      grayLayer.opacity = 0
      grayLayer.add(fadeOut, forKey: "fade")
      let pulse = CAKeyframeAnimation(keyPath: "transform.scale")
      pulse.values = [1, 1.18, 1]
      pulse.keyTimes = [0, 0.5, 1]
      pulse.duration = 0.28
      layer.add(pulse, forKey: "pulse")
    } else {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      blueLayer.opacity = toRead ? 1 : 0
      grayLayer.opacity = toRead ? 0 : 1
      CATransaction.commit()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let y = (bounds.height - 15) / 2
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    grayLayer.frame = CGRect(x: 0, y: y, width: CLReceiptView.doubleWidth, height: 15)
    blueLayer.frame = grayLayer.frame
    CATransaction.commit()
  }
}

/// Três pontinhos pulsando (digitando…).
final class CLTypingDots: UIView {
  private var dots: [CALayer] = []
  var color: UIColor = .black {
    didSet { for d in dots { d.backgroundColor = color.cgColor } }
  }

  static let width: CGFloat = 18

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    for _ in 0..<3 {
      let d = CALayer()
      d.cornerRadius = 2
      layer.addSublayer(d)
      dots.append(d)
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let y = (bounds.height - 4) / 2
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for (i, d) in dots.enumerated() {
      d.frame = CGRect(x: CGFloat(i) * 6 + 1, y: y, width: 4, height: 4)
    }
    CATransaction.commit()
  }

  func start() {
    if CLMotion.reduced {
      // Reduzir movimento: três pontos parados em degradê (sem piscar).
      let ops: [Float] = [1, 0.7, 0.4]
      for (i, d) in dots.enumerated() {
        d.removeAnimation(forKey: "blink")
        d.opacity = ops[min(i, ops.count - 1)]
      }
      return
    }
    for d in dots { d.opacity = 1 }
    for (i, d) in dots.enumerated() where d.animation(forKey: "blink") == nil {
      let a = CAKeyframeAnimation(keyPath: "opacity")
      a.values = [0.25, 1, 0.25]
      a.keyTimes = [0, 0.5, 1]
      a.duration = 1.0
      a.repeatCount = .infinity
      a.beginTime = CACurrentMediaTime() + Double(i) * 0.16
      a.isRemovedOnCompletion = false
      d.add(a, forKey: "blink")
    }
  }

  func stop() {
    for d in dots { d.removeAnimation(forKey: "blink") }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // Animações caem quando a célula sai da janela; religa ao voltar.
    if window != nil && !isHidden { stop(); start() }
  }
}

/// Pílula arredondada com texto (contador de não lidas / "@").
final class CLPillView: UIView {
  let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    label.textAlignment = .center
    addSubview(label)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func size(height: CGFloat, padding: CGFloat = 14) -> CGSize {
    let w = ceil(label.intrinsicContentSize.width) + padding
    return CGSize(width: max(height, w), height: height)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    layer.cornerRadius = bounds.height / 2
    label.frame = bounds
    if let p = pendingRoll {
      pendingRoll = nil
      startRoll(from: p.old, up: p.up)
    }
  }

  // MARK: [2026-10-16 wave8-list] dígitos rolando (Telegram)
  // Só os dígitos que mudaram rolam: 12→13 mantém o "1" parado e o "2" sobe
  // enquanto o "3" entra por baixo (desce quando o número diminui). A fonte é
  // monoespaçada (tabular), então o prefixo comum tem a mesma largura antes e
  // depois. Tudo em UIView/CA na UI thread; Reduzir movimento = troca seca.

  private var rollViews: [UILabel] = []
  private var pendingRoll: (old: String, up: Bool)?
  private var rollToken = 0

  /// Troca o texto da pílula; `animated` = rola os dígitos alterados.
  func setRollingText(_ text: String, animated: Bool) {
    let old = label.text ?? ""
    label.text = text
    if !animated || old == text || old.isEmpty || text.isEmpty || CLMotion.reduced || window == nil {
      if old != text { cancelRoll() }
      return
    }
    cancelRoll()
    let num: (String) -> Int = { Int($0.filter { $0.isNumber }) ?? 0 }
    let up = num(text) >= num(old)
    pendingRoll = (old, up)
    setNeedsLayout()
  }

  func cancelRoll() {
    rollToken += 1
    pendingRoll = nil
    for v in rollViews { v.layer.removeAllAnimations(); v.removeFromSuperview() }
    rollViews.removeAll()
    label.isHidden = false
  }

  private func makeRollLabel(_ text: String, x: CGFloat) -> UILabel {
    let l = UILabel()
    l.text = text
    l.font = label.font
    l.textColor = label.textColor
    l.textAlignment = .left
    let w = ceil((text as NSString).size(withAttributes: [.font: label.font as Any]).width)
    l.frame = CGRect(x: x, y: 0, width: w + 1, height: bounds.height)
    addSubview(l)
    rollViews.append(l)
    return l
  }

  private func startRoll(from old: String, up: Bool) {
    let new = label.text ?? ""
    guard let font = label.font, bounds.width > 0, bounds.height > 0 else { return }
    var keep = 0
    if old.count == new.count {
      for (a, b) in zip(old, new) { if a == b { keep += 1 } else { break } }
    }
    let attrs: [NSAttributedString.Key: Any] = [.font: font]
    let width: (String) -> CGFloat = { ($0 as NSString).size(withAttributes: attrs).width }
    let newW = width(new)
    let oldW = width(old)
    let prefix = String(new.prefix(keep))
    let prefW = width(prefix)
    let xNew = (bounds.width - newW) / 2
    let xOld = (bounds.width - oldW) / 2
    let d = round(bounds.height * 0.7) * (up ? 1 : -1)
    var incoming = UILabel()
    var outgoing = UILabel()
    // Estado inicial sem herdar animação de fora (layout pode rodar dentro
    // do bloco da reordenação).
    UIView.performWithoutAnimation {
      clipsToBounds = true
      label.isHidden = true
      if !prefix.isEmpty { _ = makeRollLabel(prefix, x: xNew) }
      incoming = makeRollLabel(String(new.dropFirst(keep)), x: xNew + prefW)
      outgoing = makeRollLabel(String(old.dropFirst(keep)), x: xOld + (keep > 0 ? prefW : 0))
      incoming.transform = CGAffineTransform(translationX: 0, y: d)
      incoming.alpha = 0
    }
    rollToken += 1
    let token = rollToken
    UIView.animate(withDuration: 0.36, delay: 0, usingSpringWithDamping: 0.78, initialSpringVelocity: 0,
                   options: [.allowUserInteraction, .beginFromCurrentState, .overrideInheritedDuration, .overrideInheritedCurve, .overrideInheritedOptions], animations: {
      incoming.transform = .identity
      incoming.alpha = 1
      outgoing.transform = CGAffineTransform(translationX: 0, y: -d)
      outgoing.alpha = 0
    }, completion: { [weak self] _ in
      guard let self = self, self.rollToken == token else { return }
      for v in self.rollViews { v.removeFromSuperview() }
      self.rollViews.removeAll()
      self.label.isHidden = false
    })
  }

  func pop() {
    // [2026-10-16 motion-nav] Pulo com FÍSICA (impulso de mola amortecida:
    // 1 → 1,18 → 0,97 → 1, pico em ~86 ms) amostrado em keyframes lineares —
    // mesma curva do Android (CLSpring.bump). Reduzir movimento = sem pulo.
    if CLMotion.reduced { return }
    if CLSpring.enabled {
      let a = CAKeyframeAnimation(keyPath: "transform.scale")
      a.values = CLSpring.bumpScales
      a.duration = CLSpring.bumpDuration
      a.calculationMode = .linear
      layer.add(a, forKey: "pop")
      return
    }
    let a = CAKeyframeAnimation(keyPath: "transform.scale")
    a.values = [0.8, 1.2, 1]
    a.keyTimes = [0, 0.45, 1]
    a.duration = 0.32
    a.timingFunctions = [CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeInEaseOut)]
    layer.add(a, forKey: "pop")
  }
}

/// Bolinha de seleção (modo seleção múltipla).
final class CLCheckView: UIView {
  private let tick = CAShapeLayer()
  var checked = false { didSet { refresh() } }
  var onColor: UIColor = .black { didSet { refresh() } }
  var tickColor: UIColor = .white { didSet { refresh() } }
  var borderTint: UIColor = .gray { didSet { refresh() } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    layer.borderWidth = 2
    tick.fillColor = UIColor.clear.cgColor
    tick.lineWidth = 2
    tick.lineCap = .round
    tick.lineJoin = .round
    layer.addSublayer(tick)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func refresh() {
    layer.borderColor = (checked ? onColor : borderTint).cgColor
    backgroundColor = checked ? onColor : .clear
    tick.strokeColor = tickColor.cgColor
    tick.isHidden = !checked
  }

  /// [2026-10-15 native-group-create] Marcar com animação (mola na bolinha +
  /// traço do check desenhando), estilo WhatsApp. animated=false = `checked`.
  func setChecked(_ on: Bool, animated: Bool) {
    if !animated || on == checked {
      layer.removeAllAnimations()
      tick.removeAllAnimations()
      transform = .identity
      checked = on
      return
    }
    checked = on
    if on {
      let draw = CABasicAnimation(keyPath: "strokeEnd")
      draw.fromValue = 0
      draw.toValue = 1
      draw.duration = 0.22
      draw.beginTime = CACurrentMediaTime() + 0.05
      draw.fillMode = .backwards
      draw.timingFunction = CAMediaTimingFunction(name: .easeOut)
      tick.add(draw, forKey: "draw")
      transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
      UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.5, initialSpringVelocity: 0.8,
                     options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        self.transform = .identity
      }, completion: nil)
    } else {
      transform = CGAffineTransform(scaleX: 0.85, y: 0.85)
      UIView.animate(withDuration: 0.22, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState, .curveEaseOut], animations: {
        self.transform = .identity
      }, completion: nil)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    layer.cornerRadius = bounds.width / 2
    let s = bounds.width / 26.0
    let p = UIBezierPath()
    // IconCheck 16 pt centralizado na bolinha de 26.
    let k: CGFloat = 16.0 / 24.0
    let ox = (bounds.width - 16 * s) / 2
    let oy = (bounds.height - 16 * s) / 2
    p.move(to: CGPoint(x: ox + 20 * k * s, y: oy + 6 * k * s))
    p.addLine(to: CGPoint(x: ox + 9 * k * s, y: oy + 17 * k * s))
    p.addLine(to: CGPoint(x: ox + 4 * k * s, y: oy + 12 * k * s))
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    tick.frame = bounds
    tick.path = p.cgPath
    CATransaction.commit()
  }
}
