import UIKit

// [2026-10-15 native-wallet] Cartão-herói da carteira (iOS): fundo grafite em
// degradê (+ brilho azul opcional), diamante com halo, saldo com CONTAGEM
// ROLANDO (CADisplayLink, ease-out cúbico 650 ms; Reduzir Movimento = direto),
// linha de referência, estatísticas, barra até o saque mínimo, aviso e botões.
// Layout manual: `layout(width:)` devolve a altura (a lista posiciona o herói
// acima do filho RN). Mesmo desenho do HeroCard/HeroButton do WalletKit.

/// Diamante do app (Icons.IconDiamond) desenhado em CoreGraphics, com halo.
final class WLDiamondView: UIView {
  var halo = true { didSet { setNeedsDisplay() } }
  /// Lado do diamante (o halo ocupa a caixa inteira).
  var glyphSize: CGFloat = 28 { didSet { setNeedsDisplay() } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
    isUserInteractionEnabled = false
    isAccessibilityElement = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func draw(_ rect: CGRect) {
    guard let ctx = UIGraphicsGetCurrentContext() else { return }
    let b = bounds
    if halo {
      let cs = CGColorSpaceCreateDeviceRGB()
      let c0 = UIColor(clHex: 0x60A5FA, alpha: 0.38).cgColor
      let c1 = UIColor(clHex: 0x60A5FA, alpha: 0).cgColor
      if let g = CGGradient(colorsSpace: cs, colors: [c0, c1] as CFArray, locations: [0, 1]) {
        let c = CGPoint(x: b.midX, y: b.midY)
        ctx.drawRadialGradient(g, startCenter: c, startRadius: 0, endCenter: c, endRadius: min(b.width, b.height) / 2, options: [])
      }
    }
    let s = glyphSize / 24
    let ox = b.midX - glyphSize / 2
    let oy = b.midY - glyphSize / 2
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }

    let body = UIBezierPath()
    body.move(to: p(6, 3)); body.addLine(to: p(18, 3)); body.addLine(to: p(22, 9))
    body.addLine(to: p(12, 21)); body.addLine(to: p(2, 9)); body.close()
    body.lineJoinStyle = .round
    body.lineWidth = 0.9 * s
    UIColor(clHex: 0x60A5FA).setFill()
    body.fill()
    UIColor(clHex: 0x1D4ED8).setStroke()
    body.stroke()

    let facets = UIBezierPath()
    facets.move(to: p(6, 3)); facets.addLine(to: p(9, 9)); facets.addLine(to: p(15, 9)); facets.addLine(to: p(18, 3))
    facets.move(to: p(9, 9)); facets.addLine(to: p(12, 21)); facets.addLine(to: p(15, 9))
    facets.lineWidth = 0.9 * s
    facets.lineCapStyle = .round
    UIColor(clHex: 0xBFDBFE).setStroke()
    facets.stroke()

    let shine = UIBezierPath()
    shine.move(to: p(8, 5.5)); shine.addLine(to: p(9.2, 7.5))
    shine.lineWidth = 0.8 * s
    shine.lineCapStyle = .round
    UIColor(white: 1, alpha: 0.7).setStroke()
    shine.stroke()
  }
}

/// Botão do herói (pílula 48 pt): primário branco, secundário contornado.
final class WLHeroButtonView: UIControl {
  let label = UILabel()
  var buttonId = ""
  var primary = false
  var disabledLook = false
  var onTap: ((String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    layer.cornerRadius = 24
    if #available(iOS 13.0, *) { layer.cornerCurve = .continuous }
    label.font = UIFont.systemFont(ofSize: 15, weight: .bold)
    label.textAlignment = .center
    label.adjustsFontSizeToFitWidth = true
    label.minimumScaleFactor = 0.8
    label.isUserInteractionEnabled = false
    addSubview(label)
    addTarget(self, action: #selector(tapped), for: .touchUpInside)
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ b: WLHeroButton) {
    buttonId = b.id
    primary = b.primary
    disabledLook = b.disabled
    label.text = b.label
    accessibilityLabel = b.a11y.isEmpty ? b.label : b.a11y
    accessibilityTraits = b.disabled ? [.button, .notEnabled] : .button
    if b.disabled {
      backgroundColor = UIColor(white: 1, alpha: 0.04)
      layer.borderWidth = 1
      layer.borderColor = WLHeroColors.line.cgColor
      label.textColor = WLHeroColors.faint
    } else if b.primary {
      backgroundColor = .white
      layer.borderWidth = 0
      label.textColor = .black
    } else {
      backgroundColor = .clear
      layer.borderWidth = 1
      layer.borderColor = WLHeroColors.outline.cgColor
      label.textColor = WLHeroColors.text
    }
  }

  override var isHighlighted: Bool {
    didSet {
      if disabledLook { return }
      UIView.animate(withDuration: isHighlighted ? 0.08 : 0.18, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
        self.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.97, y: 0.97) : .identity
        self.alpha = self.isHighlighted ? 0.88 : 1
      }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    label.frame = bounds.insetBy(dx: 8, dy: 0)
  }

  @objc private func tapped() {
    if disabledLook { return }
    let gen = UIImpactFeedbackGenerator(style: primary ? .medium : .light)
    gen.impactOccurred()
    onTap?(buttonId)
  }
}

final class WLHeroView: UIView {
  var onAction: ((String) -> Void)?

  private let card = UIView()
  private let gradient = CAGradientLayer()
  private let glowLayer = CAGradientLayer()
  private let capsLabel = UILabel()
  private let brandLabel = UILabel()
  private let diamond = WLDiamondView()
  private let numLabel = UILabel()
  private let subLabel = UILabel()
  private let noteLabel = UILabel()
  private let statsLine = UIView()
  private let statsDivider = UIView()
  private var statViews: [(UILabel, UILabel, UILabel)] = []
  private let track = UIView()
  private let bar = UIView()
  private let progLabel = UILabel()
  private let noticeLine = UIView()
  private let noticeLabel = UILabel()
  private var buttonViews: [WLHeroButtonView] = []
  private let footLabel = UILabel()

  private(set) var hero = WLHero()
  private var dark = false

  // Contagem
  private var shown: Double? = nil
  private var animFrom: Double = 0
  private var animTo: Double = 0
  private var animStart: CFTimeInterval = 0
  private var link: CADisplayLink?
  private let duration: CFTimeInterval = 0.65

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    card.layer.cornerRadius = 22
    if #available(iOS 13.0, *) { card.layer.cornerCurve = .continuous }
    card.clipsToBounds = true
    addSubview(card)
    gradient.startPoint = CGPoint(x: 0, y: 0)
    gradient.endPoint = CGPoint(x: 1, y: 1)
    card.layer.addSublayer(gradient)
    glowLayer.type = .radial
    glowLayer.colors = [UIColor(clHex: 0x60A5FA, alpha: 0.22).cgColor, UIColor(clHex: 0x3B82F6, alpha: 0.06).cgColor, UIColor(clHex: 0x3B82F6, alpha: 0).cgColor]
    glowLayer.locations = [0, 0.55, 1]
    glowLayer.startPoint = CGPoint(x: 0.12, y: 0)
    glowLayer.endPoint = CGPoint(x: 0.82, y: 0.8)
    card.layer.addSublayer(glowLayer)

    capsLabel.font = UIFont.systemFont(ofSize: 12, weight: .bold)
    capsLabel.textColor = WLHeroColors.sub
    brandLabel.font = UIFont.systemFont(ofSize: 11, weight: .heavy)
    brandLabel.textColor = WLHeroColors.faint
    numLabel.textColor = WLHeroColors.text
    numLabel.adjustsFontSizeToFitWidth = true
    numLabel.minimumScaleFactor = 0.55
    numLabel.baselineAdjustment = .alignCenters
    for l in [subLabel, noteLabel, progLabel, noticeLabel, footLabel] {
      l.font = UIFont.systemFont(ofSize: 13)
      l.textColor = WLHeroColors.sub
      l.numberOfLines = 0
    }
    subLabel.numberOfLines = 1
    subLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)
    footLabel.textAlignment = .center
    statsLine.backgroundColor = WLHeroColors.line
    statsDivider.backgroundColor = WLHeroColors.line
    noticeLine.backgroundColor = WLHeroColors.line
    track.backgroundColor = WLHeroColors.fill
    track.layer.cornerRadius = 3
    track.clipsToBounds = true
    bar.backgroundColor = .white
    bar.layer.cornerRadius = 3
    track.addSubview(bar)
    for v in [capsLabel, brandLabel, diamond, numLabel, subLabel, noteLabel, statsLine, statsDivider, track, progLabel, noticeLine, noticeLabel, footLabel] as [UIView] {
      card.addSubview(v)
    }
    capsLabel.isAccessibilityElement = false
    brandLabel.isAccessibilityElement = false
    numLabel.isAccessibilityElement = true
    numLabel.accessibilityTraits = .summaryElement
    track.isAccessibilityElement = true
    track.accessibilityTraits = .updatesFrequently
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit { link?.invalidate() }

  func configure(_ h: WLHero, dark: Bool) {
    let prevValue = hero.value
    hero = h
    self.dark = dark
    let end = dark ? UIColor(clHex: 0x0E0E10) : UIColor(clHex: 0x09090A)
    let start = dark ? UIColor(clHex: 0x1E1E21) : UIColor(clHex: 0x232326)
    gradient.colors = [start.cgColor, end.cgColor]
    card.backgroundColor = end
    glowLayer.isHidden = !h.glow
    if dark {
      card.layer.borderWidth = 1 / max(1, UIScreen.main.scale)
      card.layer.borderColor = UIColor(white: 1, alpha: 0.14).cgColor
      layer.shadowOpacity = 0
    } else {
      card.layer.borderWidth = 0
      layer.shadowColor = UIColor.black.cgColor
      layer.shadowOpacity = 0.18
      layer.shadowRadius = 14
      layer.shadowOffset = CGSize(width: 0, height: 8)
    }

    capsLabel.attributedText = NSAttributedString(string: h.caps.uppercased(), attributes: [.kern: 0.9, .font: UIFont.systemFont(ofSize: 12, weight: .bold), .foregroundColor: WLHeroColors.sub])
    brandLabel.attributedText = NSAttributedString(string: h.brand, attributes: [.kern: 2.2, .font: UIFont.systemFont(ofSize: 11, weight: .heavy), .foregroundColor: WLHeroColors.faint])
    brandLabel.isHidden = h.brand.isEmpty
    diamond.isHidden = !h.diamond
    diamond.glyphSize = 30
    numLabel.font = UIFont.monospacedDigitSystemFont(ofSize: h.numSize, weight: .bold)
    numLabel.textColor = h.danger ? WLHeroColors.danger : WLHeroColors.text
    numLabel.accessibilityLabel = h.a11y.isEmpty ? "\(h.caps): \(h.text)" : h.a11y
    subLabel.text = h.sub
    subLabel.isHidden = h.sub.isEmpty
    noteLabel.text = h.note
    noteLabel.isHidden = h.note.isEmpty

    // Estatísticas (até 2 colunas).
    while statViews.count < h.stats.count {
      let a = UILabel(), b = UILabel(), c = UILabel()
      a.font = UIFont.systemFont(ofSize: 12); a.textColor = WLHeroColors.sub
      b.font = UIFont.monospacedDigitSystemFont(ofSize: 16, weight: .bold); b.textColor = WLHeroColors.text
      b.adjustsFontSizeToFitWidth = true; b.minimumScaleFactor = 0.7
      c.font = UIFont.systemFont(ofSize: 11); c.textColor = WLHeroColors.faint
      for l in [a, b, c] { card.addSubview(l) }
      statViews.append((a, b, c))
    }
    for (i, v) in statViews.enumerated() {
      let on = i < h.stats.count && i < 2
      v.0.isHidden = !on; v.1.isHidden = !on; v.2.isHidden = !on
      if on {
        v.0.text = h.stats[i].label
        v.1.text = h.stats[i].value
        v.2.text = h.stats[i].sub
      }
    }
    let hasStats = !h.stats.isEmpty
    statsLine.isHidden = !hasStats
    statsDivider.isHidden = h.stats.count < 2

    let hasProg = h.progress >= 0
    track.isHidden = !hasProg
    progLabel.isHidden = !hasProg || h.progressText.isEmpty
    progLabel.text = h.progressText
    track.accessibilityLabel = h.progressText
    track.accessibilityValue = "\(Int((max(0, min(1, h.progress)) * 100).rounded()))%"

    noticeLabel.text = h.notice
    noticeLabel.isHidden = h.notice.isEmpty
    noticeLine.isHidden = h.notice.isEmpty

    // Botões (aviso substitui os botões, como no JS).
    let btns = h.notice.isEmpty ? h.buttons : []
    while buttonViews.count < btns.count {
      let b = WLHeroButtonView()
      b.onTap = { [weak self] id in self?.onAction?(id) }
      card.addSubview(b)
      buttonViews.append(b)
    }
    for (i, b) in buttonViews.enumerated() {
      b.isHidden = i >= btns.count
      if i < btns.count { b.configure(btns[i]) }
    }
    footLabel.text = h.foot
    footLabel.isHidden = h.foot.isEmpty

    // Número: anima do valor mostrado até o novo.
    if let to = h.value {
      if prevValue == nil && shown == nil {
        startCount(from: 0, to: to)
      } else if let cur = shown, cur != to {
        startCount(from: cur, to: to)
      } else if link == nil {
        numLabel.text = h.text.isEmpty ? WLNumber.format(to, format: h.format, locale: h.locale) : h.text
        shown = to
      }
    } else {
      link?.invalidate(); link = nil
      shown = nil
      numLabel.text = h.text.isEmpty ? "—" : h.text
    }
    setNeedsLayout()
  }

  private func startCount(from: Double, to: Double) {
    link?.invalidate(); link = nil
    if UIAccessibility.isReduceMotionEnabled || from == to {
      finishCount(to)
      return
    }
    animFrom = from
    animTo = to
    animStart = CACurrentMediaTime()
    numLabel.text = WLNumber.format(from, format: hero.format, locale: hero.locale)
    shown = from
    let l = CADisplayLink(target: WLWeakTarget(self), selector: #selector(WLWeakTarget.tick))
    l.add(to: .main, forMode: .common)
    link = l
  }

  fileprivate func tick() {
    let p = min(1, (CACurrentMediaTime() - animStart) / duration)
    let e = 1 - pow(1 - p, 3)
    let v = animFrom + (animTo - animFrom) * e
    shown = v
    if p >= 1 {
      finishCount(animTo)
    } else {
      numLabel.text = WLNumber.format(v, format: hero.format, locale: hero.locale)
    }
  }

  private func finishCount(_ to: Double) {
    link?.invalidate(); link = nil
    shown = to
    numLabel.text = hero.text.isEmpty ? WLNumber.format(to, format: hero.format, locale: hero.locale) : hero.text
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil, link != nil { finishCount(animTo) }
  }

  // MARK: - Layout

  @discardableResult
  func layout(width w: CGFloat) -> CGFloat {
    let h = hero
    let padX: CGFloat = 20
    let inner = max(0, w - padX * 2)
    var y: CGFloat = 16

    let capsH: CGFloat = 16
    let brandW = h.brand.isEmpty ? 0 : ceil(brandLabel.intrinsicContentSize.width)
    brandLabel.frame = CGRect(x: w - padX - brandW, y: y, width: brandW, height: capsH)
    capsLabel.frame = CGRect(x: padX, y: y, width: max(0, inner - brandW - 8), height: capsH)
    y += capsH + 8

    let lineH = ceil(h.numSize * 1.17)
    if h.diamond {
      let box = ceil(30 * 1.7)
      let rowH = max(box, lineH)
      diamond.frame = CGRect(x: padX - 10, y: y + (rowH - box) / 2, width: box, height: box)
      let nx = diamond.frame.maxX + 2
      numLabel.frame = CGRect(x: nx, y: y + (rowH - lineH) / 2, width: max(0, w - padX - nx), height: lineH)
      y += rowH
    } else {
      numLabel.frame = CGRect(x: padX, y: y, width: inner, height: lineH)
      y += lineH
    }

    if !subLabel.isHidden {
      y += 2
      subLabel.frame = CGRect(x: padX, y: y, width: inner, height: 18)
      y += 18
    }
    if !noteLabel.isHidden {
      y += 8
      let nh = ceil(noteLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height)
      noteLabel.frame = CGRect(x: padX, y: y, width: inner, height: nh)
      y += nh
    }
    let px = 1 / max(1, UIScreen.main.scale)
    if !h.stats.isEmpty {
      y += 16
      statsLine.frame = CGRect(x: padX, y: y, width: inner, height: px)
      y += 12
      let two = h.stats.count >= 2
      let colW = two ? floor(inner / 2) : inner
      var colH: CGFloat = 0
      for (i, v) in statViews.enumerated() where i < min(2, h.stats.count) {
        let x = padX + (i == 0 ? 0 : colW + 16)
        let cw = i == 0 ? colW - (two ? 8 : 0) : colW - 16
        v.0.frame = CGRect(x: x, y: y, width: cw, height: 16)
        v.1.frame = CGRect(x: x, y: y + 18, width: cw, height: 21)
        let subOn = !h.stats[i].sub.isEmpty
        v.2.frame = CGRect(x: x, y: y + 40, width: cw, height: subOn ? 14 : 0)
        colH = max(colH, subOn ? 54 : 40)
      }
      if two { statsDivider.frame = CGRect(x: padX + colW, y: y, width: px, height: colH) }
      y += colH
    }
    if h.progress >= 0 {
      y += 16
      track.frame = CGRect(x: padX, y: y, width: inner, height: 6)
      let p = max(0, min(1, h.progress))
      let bw = p > 0 ? max(inner * p, inner * 0.03) : 0
      bar.frame = CGRect(x: 0, y: 0, width: bw, height: 6)
      y += 6
      if !progLabel.isHidden {
        y += 8
        let ph = ceil(progLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height)
        progLabel.frame = CGRect(x: padX, y: y, width: inner, height: ph)
        y += ph
      }
    }
    if !noticeLabel.isHidden {
      y += 16
      noticeLine.frame = CGRect(x: padX, y: y, width: inner, height: px)
      y += 12
      let nh = ceil(noticeLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height)
      noticeLabel.frame = CGRect(x: padX, y: y, width: inner, height: nh)
      y += nh
    }
    let visibleButtons = buttonViews.filter { !$0.isHidden }
    if !visibleButtons.isEmpty {
      y += (h.stats.isEmpty && h.progress < 0) ? 20 : 16
      let gap: CGFloat = 8
      let weights = visibleButtons.map { $0.primary && visibleButtons.count > 1 ? 1.45 : 1.0 }
      let total = weights.reduce(0, +)
      let avail = inner - gap * CGFloat(visibleButtons.count - 1)
      var x = padX
      for (i, b) in visibleButtons.enumerated() {
        let bw = floor(avail * CGFloat(weights[i] / total))
        b.frame = CGRect(x: x, y: y, width: bw, height: 48)
        x += bw + gap
      }
      y += 48
    }
    if !footLabel.isHidden {
      y += 8
      let fh = ceil(footLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height)
      footLabel.frame = CGRect(x: padX, y: y, width: inner, height: fh)
      y += fh
    }
    y += 20
    let total = ceil(y)
    card.frame = CGRect(x: 0, y: 0, width: w, height: total)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    gradient.frame = card.bounds
    glowLayer.frame = card.bounds
    CATransaction.commit()
    if !dark {
      layer.shadowPath = UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: w, height: total), cornerRadius: 22).cgPath
    }
    return total
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if bounds.width > 0 { layout(width: bounds.width) }
  }
}

/// Alvo fraco do CADisplayLink (o link retém o alvo).
final class WLWeakTarget: NSObject {
  weak var view: WLHeroView?
  init(_ v: WLHeroView) { view = v }
  @objc func tick() {
    view?.tick()
  }
}
