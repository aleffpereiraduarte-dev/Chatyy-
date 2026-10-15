import UIKit

// [2026-10-15 native-media-dl] Anel de transferência ÚNICO p/ enviar e receber
// (foto/vídeo/álbum: anel branco sobre disco escurecido; áudio/arquivo: anel na
// cor do texto sobre o botão). Modos:
//   • download(texto) — pílula "↓ 12,4 MB" (ou só a seta num círculo);
//   • progress(f)     — disco + trilho + arco (strokeEnd animado) + X no centro;
//   • spin            — arco girando (na fila / tamanho desconhecido);
//   • finish()        — arco completa, anel encolhe e some (cross-fade da foto
//                       fica com a célula).
final class CMLTransferRing: UIView {
  enum Mode: Equatable {
    case hidden
    case download(String)
    case progress(Double)
    case spin
  }

  enum Look { case overlay, inline }

  private let disc = CAShapeLayer()
  private let track = CAShapeLayer()
  private let bar = CAShapeLayer()
  private let icon = CAShapeLayer()
  private let label = CATextLayer()
  private(set) var mode: Mode = .hidden
  private var spinning = false
  private var finishing = false
  var look: Look = .overlay { didSet { if look != oldValue { applyColors() } } }
  /// cor do anel no estilo inline (texto do balão)
  var tint: UIColor = .white { didSet { applyColors() } }

  static let ringSize: CGFloat = 48
  static let inlineSize: CGFloat = 38
  private static let font = UIFont.systemFont(ofSize: 13, weight: .semibold)

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isHidden = true
    for l in [disc, track, bar, icon] {
      l.contentsScale = UIScreen.main.scale
      layer.addSublayer(l)
    }
    track.fillColor = UIColor.clear.cgColor
    bar.fillColor = UIColor.clear.cgColor
    bar.lineCap = .round
    bar.strokeEnd = 0
    icon.fillColor = UIColor.clear.cgColor
    icon.lineCap = .round
    icon.lineJoin = .round
    label.contentsScale = UIScreen.main.scale
    label.font = CMLTransferRing.font
    label.fontSize = CMLTransferRing.font.pointSize
    label.alignmentMode = .left
    label.truncationMode = .end
    layer.addSublayer(label)
    applyColors()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func applyColors() {
    switch look {
    case .overlay:
      disc.fillColor = UIColor(white: 0, alpha: 0.5).cgColor
      track.strokeColor = UIColor(white: 1, alpha: 0.28).cgColor
      bar.strokeColor = UIColor.white.cgColor
      icon.strokeColor = UIColor.white.cgColor
      label.foregroundColor = UIColor.white.cgColor
    case .inline:
      disc.fillColor = tint.withAlphaComponent(0.14).cgColor
      track.strokeColor = tint.withAlphaComponent(0.22).cgColor
      bar.strokeColor = tint.cgColor
      icon.strokeColor = tint.cgColor
      label.foregroundColor = tint.cgColor
    }
  }

  /// Tamanho que o modo pede (a célula centraliza).
  func preferredSize(_ m: Mode) -> CGSize {
    let d = look == .overlay ? CMLTransferRing.ringSize : CMLTransferRing.inlineSize
    if case .download(let t) = m, !t.isEmpty, look == .overlay {
      let w = ceil((t as NSString).size(withAttributes: [.font: CMLTransferRing.font]).width)
      return CGSize(width: 14 + 16 + 6 + w + 14, height: 34)
    }
    return CGSize(width: d, height: d)
  }

  func set(_ m: Mode, animated: Bool) {
    if finishing {
      if m == .hidden { return }
      finishing = false
      layer.removeAllAnimations()
      alpha = 1
      transform = .identity
    }
    let prev = mode
    mode = m
    if m == .hidden {
      isHidden = true
      stopSpin()
      return
    }
    let appearing = isHidden
    isHidden = false
    let shapeChanged: Bool = {
      switch (prev, m) {
      case (.download(let a), .download(let b)): return a != b
      case (.progress, .progress), (.spin, .spin), (.progress, .spin), (.spin, .progress): return false
      default: return true
      }
    }()
    if shapeChanged || appearing { rebuild() }
    switch m {
    case .progress(let f):
      stopSpin()
      setStroke(CGFloat(max(0.02, min(1, f))), animated: animated && !appearing)
    case .spin:
      setStroke(0.25, animated: false)
      startSpin()
    default:
      stopSpin()
    }
    if appearing && animated && !UIAccessibility.isReduceMotionEnabled {
      alpha = 0
      transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
      UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseOut, .allowUserInteraction], animations: {
        self.alpha = 1
        self.transform = .identity
      })
    }
  }

  /// Concluído: arco fecha, anel encolhe e some.
  func finish() {
    guard !isHidden, !finishing else { return }
    if case .download = mode { set(.hidden, animated: false); return }
    finishing = true
    stopSpin()
    setStroke(1, animated: true)
    UIView.animate(withDuration: 0.22, delay: 0.16, options: [.curveEaseIn, .allowUserInteraction], animations: {
      self.alpha = 0
      self.transform = CGAffineTransform(scaleX: 0.55, y: 0.55)
    }, completion: { _ in
      guard self.finishing else { return }
      self.finishing = false
      self.isHidden = true
      self.alpha = 1
      self.transform = .identity
      self.mode = .hidden
    })
  }

  func reset() {
    finishing = false
    layer.removeAllAnimations()
    alpha = 1
    transform = .identity
    stopSpin()
    bar.removeAllAnimations()
    mode = .hidden
    isHidden = true
  }

  private func setStroke(_ v: CGFloat, animated: Bool) {
    let from = bar.presentation()?.strokeEnd ?? bar.strokeEnd
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    bar.strokeEnd = v
    CATransaction.commit()
    if animated && abs(from - v) > 0.001 {
      let a = CABasicAnimation(keyPath: "strokeEnd")
      a.fromValue = from
      a.toValue = v
      a.duration = 0.22
      a.timingFunction = CAMediaTimingFunction(name: .linear)
      bar.add(a, forKey: "se")
    } else {
      bar.removeAnimation(forKey: "se")
    }
  }

  private func startSpin() {
    if spinning { return }
    spinning = true
    let a = CABasicAnimation(keyPath: "transform.rotation.z")
    a.fromValue = 0
    a.toValue = CGFloat.pi * 2
    a.duration = 0.9
    a.repeatCount = .infinity
    bar.add(a, forKey: "spin")
  }

  private func stopSpin() {
    if !spinning { return }
    spinning = false
    bar.removeAnimation(forKey: "spin")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    rebuild()
  }

  private func rebuild() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    let b = bounds
    for l in [disc, track, bar, icon] { l.frame = b }
    let lw: CGFloat = look == .overlay ? 2.5 : 2
    track.lineWidth = lw
    bar.lineWidth = lw
    icon.lineWidth = look == .overlay ? 2.2 : 2
    if case .download(let t) = mode, !t.isEmpty, look == .overlay {
      // pílula: seta + tamanho
      disc.path = UIBezierPath(roundedRect: b, cornerRadius: b.height / 2).cgPath
      track.path = nil
      bar.path = nil
      let ir = CGRect(x: 14, y: (b.height - 16) / 2, width: 16, height: 16)
      icon.path = CMLTransferRing.arrowDown(ir)
      label.isHidden = false
      label.string = t
      let lh = ceil(CMLTransferRing.font.lineHeight)
      label.frame = CGRect(x: ir.maxX + 6, y: (b.height - lh) / 2, width: max(0, b.width - ir.maxX - 6 - 12), height: lh)
      return
    }
    label.isHidden = true
    label.string = nil
    let c = CGPoint(x: b.midX, y: b.midY)
    let r = min(b.width, b.height) / 2
    disc.path = UIBezierPath(ovalIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)).cgPath
    let inset: CGFloat = look == .overlay ? 7 : 3
    let ringR = max(4, r - inset)
    let ring = UIBezierPath(arcCenter: .zero, radius: ringR, startAngle: -.pi / 2, endAngle: .pi * 1.5, clockwise: true).cgPath
    // arco desenhado em torno da origem + position no centro → a rotação
    // (spin) gira em torno do centro do anel
    bar.bounds = CGRect(x: -r, y: -r, width: r * 2, height: r * 2)
    bar.position = c
    track.bounds = bar.bounds
    track.position = c
    switch mode {
    case .download:
      track.path = nil
      bar.path = nil
      let s = r * 0.8
      icon.path = CMLTransferRing.arrowDown(CGRect(x: c.x - s / 2, y: c.y - s / 2, width: s, height: s))
    default:
      track.path = ring
      bar.path = ring
      let s = look == .overlay ? r * 0.55 : r * 0.62
      icon.path = CMLTransferRing.cross(CGRect(x: c.x - s / 2, y: c.y - s / 2, width: s, height: s))
    }
  }

  static func arrowDown(_ r: CGRect) -> CGPath {
    let p = UIBezierPath()
    p.move(to: CGPoint(x: r.midX, y: r.minY + r.height * 0.1))
    p.addLine(to: CGPoint(x: r.midX, y: r.maxY - r.height * 0.12))
    p.move(to: CGPoint(x: r.minX + r.width * 0.2, y: r.midY + r.height * 0.06))
    p.addLine(to: CGPoint(x: r.midX, y: r.maxY - r.height * 0.1))
    p.addLine(to: CGPoint(x: r.maxX - r.width * 0.2, y: r.midY + r.height * 0.06))
    return p.cgPath
  }

  static func cross(_ r: CGRect) -> CGPath {
    let p = UIBezierPath()
    p.move(to: CGPoint(x: r.minX, y: r.minY))
    p.addLine(to: CGPoint(x: r.maxX, y: r.maxY))
    p.move(to: CGPoint(x: r.maxX, y: r.minY))
    p.addLine(to: CGPoint(x: r.minX, y: r.maxY))
    return p.cgPath
  }
}
