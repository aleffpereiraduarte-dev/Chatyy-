import UIKit

// [2026-10-21 lista-viva, apiVersion 11] Peças da "lista de conversas viva"
// (mockup aprovado preview-2026/lista.html). Só entram com a prop `vivo`;
// sem ela a lista desenha exatamente como antes.
//   • CLVivoDots     — "digitando" com 3 pontinhos que sobem e acendem
//   • CLWaveBars     — "gravando áudio" com ondinha de 5 barras
//   • CLPinnedCardView   — cartão das fixadas (decoração da seção, raio 22)
//   • CLPinnedHeaderCell — cabeçalho "FIXADAS" + alfinete
// Layers criadas UMA vez por view; bind só troca cor/estado. Reduzir
// Movimento = tudo parado.

/// Três pontinhos (5 pt, vão 3) — opacidade 0,25→1 e sobe 2 pt, 1,2 s, defasados 0,15 s.
final class CLVivoDots: UIView {
  static let width: CGFloat = 21
  private var dots: [CALayer] = []
  private var running = false
  var color: UIColor = .black {
    didSet {
      CATransaction.begin(); CATransaction.setDisableActions(true)
      for d in dots { d.backgroundColor = color.cgColor }
      CATransaction.commit()
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    for _ in 0..<3 {
      let d = CALayer()
      d.cornerRadius = 2.5
      layer.addSublayer(d)
      dots.append(d)
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let y = (bounds.height - 5) / 2
    CATransaction.begin(); CATransaction.setDisableActions(true)
    for (i, d) in dots.enumerated() {
      d.frame = CGRect(x: CGFloat(i) * 8, y: y, width: 5, height: 5)
    }
    CATransaction.commit()
  }

  func start() {
    running = true
    if CLMotion.reduced || window == nil {
      let ops: [Float] = [1, 0.7, 0.4]
      for (i, d) in dots.enumerated() {
        d.removeAnimation(forKey: "vivo")
        d.opacity = CLMotion.reduced ? ops[i] : 1
      }
      return
    }
    let now = CACurrentMediaTime()
    for (i, d) in dots.enumerated() where d.animation(forKey: "vivo") == nil {
      d.opacity = 1
      let op = CAKeyframeAnimation(keyPath: "opacity")
      op.values = [0.25, 1, 0.25, 0.25]
      op.keyTimes = [0, 0.3, 0.6, 1]
      let ty = CAKeyframeAnimation(keyPath: "transform.translation.y")
      ty.values = [0, -2, 0, 0]
      ty.keyTimes = [0, 0.3, 0.6, 1]
      let g = CAAnimationGroup()
      g.animations = [op, ty]
      g.duration = 1.2
      g.repeatCount = .infinity
      g.beginTime = now + Double(i) * 0.15
      g.fillMode = .backwards
      g.isRemovedOnCompletion = false
      d.add(g, forKey: "vivo")
    }
  }

  func stop() {
    running = false
    for d in dots { d.removeAnimation(forKey: "vivo") }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil && running && !isHidden {
      for d in dots { d.removeAnimation(forKey: "vivo") }
      start()
    }
  }
}

/// Ondinha de 5 barras (2,5 pt, vão 2; alturas 6/12/8/13/5) — scaleY 1→0,4→1, 1 s.
final class CLWaveBars: UIView {
  static let width: CGFloat = 21
  private static let heights: [CGFloat] = [6, 12, 8, 13, 5]
  private var bars: [CALayer] = []
  private var running = false
  var color: UIColor = .black {
    didSet {
      CATransaction.begin(); CATransaction.setDisableActions(true)
      for b in bars { b.backgroundColor = color.cgColor }
      CATransaction.commit()
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    for _ in 0..<5 {
      let b = CALayer()
      b.cornerRadius = 1.25
      layer.addSublayer(b)
      bars.append(b)
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let mid = bounds.height / 2
    CATransaction.begin(); CATransaction.setDisableActions(true)
    for (i, b) in bars.enumerated() {
      let h = CLWaveBars.heights[i]
      b.bounds = CGRect(x: 0, y: 0, width: 2.5, height: h)
      b.position = CGPoint(x: CGFloat(i) * 4.5 + 1.25, y: mid)
    }
    CATransaction.commit()
  }

  func start() {
    running = true
    if CLMotion.reduced || window == nil {
      for b in bars { b.removeAnimation(forKey: "vivo") }
      return
    }
    let now = CACurrentMediaTime()
    for (i, b) in bars.enumerated() where b.animation(forKey: "vivo") == nil {
      let a = CAKeyframeAnimation(keyPath: "transform.scale.y")
      a.values = [1, 0.4, 1]
      a.keyTimes = [0, 0.5, 1]
      a.timingFunctions = [CAMediaTimingFunction(name: .easeInEaseOut), CAMediaTimingFunction(name: .easeInEaseOut)]
      a.duration = 1.0
      a.repeatCount = .infinity
      a.beginTime = now + Double(i) * 0.1
      a.fillMode = .backwards
      a.isRemovedOnCompletion = false
      b.add(a, forKey: "vivo")
    }
  }

  func stop() {
    running = false
    for b in bars { b.removeAnimation(forKey: "vivo") }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil && running && !isHidden {
      for b in bars { b.removeAnimation(forKey: "vivo") }
      start()
    }
  }
}

/// Fundo da seção das fixadas: cartão raio 22 + sombra dupla suave (só no
/// claro; escuro = sem sombra, a separação vem do cinza). As cores vêm da
/// CLCollectionView (a decoração é criada pelo layout, sem bind).
final class CLPinnedCardView: UICollectionReusableView {
  static let kind = "chatyy-pinned-card"
  private let card = UIView()
  private let farShadow = CALayer()

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    backgroundColor = .clear
    layer.addSublayer(farShadow)
    addSubview(card)
    card.layer.cornerRadius = 22
    if #available(iOS 13.0, *) { card.layer.cornerCurve = .continuous }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func apply(_ layoutAttributes: UICollectionViewLayoutAttributes) {
    super.apply(layoutAttributes)
    refreshColors()
  }

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    refreshColors()
  }

  private func refreshColors() {
    guard let cv = superview as? CLCollectionView else { return }
    CATransaction.begin(); CATransaction.setDisableActions(true)
    card.backgroundColor = cv.pinnedCardColor
    let shadow = cv.pinnedCardShadow
    // 0 1 2 /3,5% (perto) + 0 8 24 /4,5% (longe) — mesma sombra do cartão do JS.
    card.layer.shadowColor = UIColor.black.cgColor
    card.layer.shadowOpacity = shadow ? 0.035 : 0
    card.layer.shadowRadius = 1
    card.layer.shadowOffset = CGSize(width: 0, height: 1)
    farShadow.shadowColor = UIColor.black.cgColor
    farShadow.shadowOpacity = shadow ? 0.045 : 0
    farShadow.shadowRadius = 12
    farShadow.shadowOffset = CGSize(width: 0, height: 8)
    farShadow.isHidden = !shadow
    CATransaction.commit()
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin(); CATransaction.setDisableActions(true)
    card.frame = bounds
    farShadow.frame = bounds
    let path = UIBezierPath(roundedRect: bounds, cornerRadius: 22).cgPath
    card.layer.shadowPath = path
    farShadow.shadowPath = path
    CATransaction.commit()
  }
}

/// Cabeçalho "FIXADAS" com alfinete (12 pt, 700, caixa alta, espaçamento 0,6).
final class CLPinnedHeaderCell: UICollectionViewListCell {
  static let itemId = "\u{1}chatyy-pinned-header"
  private let pin = UIImageView()
  private let label = UILabel()
  private var font = UIFont.systemFont(ofSize: 12, weight: .bold)
  private var bg: UIColor = .white

  override init(frame: CGRect) {
    super.init(frame: frame)
    pin.contentMode = .center
    contentView.addSubview(pin)
    label.numberOfLines = 1
    contentView.addSubview(label)
    isAccessibilityElement = true
    accessibilityTraits = .header
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func height(for traits: UITraitCollection) -> CGFloat {
    let f = CLFonts.scaled(12, .bold, cap: 1.3, traits: traits)
    return ceil(f.lineHeight) + 16
  }

  func configure(title: String, theme: CLTheme) {
    font = CLFonts.scaled(12, .bold, cap: 1.3, traits: traitCollection)
    let t = title.uppercased()
    label.attributedText = NSAttributedString(string: t, attributes: [.font: font, .foregroundColor: theme.sub, .kern: 0.6])
    pin.image = CLSymbols.image("pin.fill", pointSize: 10, weight: .regular, color: theme.sub)
    accessibilityLabel = title
    bg = theme.bg
    setNeedsUpdateConfiguration()
    setNeedsLayout()
  }

  override func updateConfiguration(using state: UICellConfigurationState) {
    var b = UIBackgroundConfiguration.listPlainCell()
    b.backgroundColor = bg
    backgroundConfiguration = b
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    attrs.frame.size.height = CLPinnedHeaderCell.height(for: traitCollection)
    return attrs
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    let lh = ceil(font.lineHeight)
    let y = b.height - 6 - lh
    pin.frame = CGRect(x: 18, y: y + (lh - 13) / 2, width: 13, height: 13)
    label.frame = CGRect(x: 18 + 13 + 6, y: y, width: max(0, b.width - 18 - 19 - 18), height: lh)
  }
}
